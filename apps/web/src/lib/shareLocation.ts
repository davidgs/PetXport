import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

const SEND_EVERY_MS = 15_000;
const flag = (legId: string) => `petxport.share.${legId}`;

type WakeLock = { release: () => Promise<void> };

/**
 * Reports this device's position for one leg while the driver has sharing switched on.
 *
 * A web page only gets positions while it is open on screen, so this also asks the phone to keep
 * the screen awake. The choice is remembered on this device, so reopening the page during the
 * same leg carries on without asking again.
 */
export function useShareLocation(legId: string, legUrl: string) {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const [sharing, setSharing] = useState(() => supported && localStorage.getItem(flag(legId)) === '1');
  const [error, setError] = useState('');
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const latest = useRef<{ lat: number; lng: number; accuracyM: number } | null>(null);
  const sentAt = useRef(0);

  const stop = useCallback(
    (tellServer = true) => {
      localStorage.removeItem(flag(legId));
      setSharing(false);
      setLastSentAt(null);
      if (tellServer) void api(`${legUrl}/position`, { method: 'DELETE' }).catch(() => undefined);
    },
    [legId, legUrl],
  );

  const start = useCallback(() => {
    setError('');
    localStorage.setItem(flag(legId), '1');
    setSharing(true);
  }, [legId]);

  useEffect(() => {
    if (!sharing || !supported) return;
    let wake: WakeLock | null = null;
    let over = false;

    const send = async () => {
      const fix = latest.current;
      if (!fix || over) return;
      sentAt.current = Date.now();
      try {
        await api(`${legUrl}/position`, { method: 'PUT', body: fix });
        if (!over) setLastSentAt(Date.now());
      } catch (err) {
        // The leg has ended or been reassigned: there is nothing left to share.
        if (err instanceof ApiError && (err.status === 400 || err.status === 404)) stop(false);
      }
    };

    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        latest.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy) };
        setError('');
        if (Date.now() - sentAt.current >= SEND_EVERY_MS) void send();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setError('Location is blocked for this site. Allow it in your browser or phone settings, then try again.');
          stop(false);
        } else {
          setError('Your location is not available right now. Still trying…');
        }
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    // Parked at a rest stop, the phone reports nothing new; this keeps "updated" honest.
    const tick = window.setInterval(() => {
      if (Date.now() - sentAt.current >= SEND_EVERY_MS * 2) void send();
    }, SEND_EVERY_MS);

    const keepAwake = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        wake = await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } }).wakeLock?.request('screen') ?? null;
      } catch {
        // Not supported, or refused (low battery): sharing still works while the screen is on.
      }
    };
    void keepAwake();
    document.addEventListener('visibilitychange', keepAwake);

    return () => {
      over = true;
      navigator.geolocation.clearWatch(watch);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', keepAwake);
      void wake?.release().catch(() => undefined);
    };
  }, [sharing, supported, legUrl, stop]);

  return { supported, sharing, start, stop: () => stop(true), error, lastSentAt };
}
