import { PhotoCard } from '../components/Avatar';
import type { Driver } from '@petxport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DriverForm, emptyDriver, fromDriver, toProfileBody } from '../components/DriverForm';
import { Button, Card, ErrorNote, Notice, PageTitle, Spinner } from '../components/ui';
import { ThemePicker } from '../components/ThemeToggle';
import { ApiError, api, errorMessage, useMe, useOrg, useOrgPath } from '../lib/api';

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function PushCard() {
  const org = useOrg();
  const { apiBase } = useOrgPath();
  const [state, setState] = useState<'checking' | 'unsupported' | 'off' | 'on' | 'blocked'>('checking');
  const [error, setError] = useState('');
  const key = org.data?.features.vapidPublicKey;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

  useEffect(() => {
    if (!supported) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('blocked');
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setState(sub ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, [supported]);

  if (!key) return null;

  const enable = async () => {
    setError('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setState(permission === 'denied' ? 'blocked' : 'off');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
      await api(`${apiBase}/push/subscribe`, { body: sub.toJSON() });
      setState('on');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const disable = async () => {
    setError('');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api(`${apiBase}/push/unsubscribe`, { body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setState('off');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Notifications on this device</h2>
      {state === 'checking' && <p className="text-sm text-slate-500">Checking…</p>}
      {state === 'unsupported' &&
        (isIos && !standalone ? (
          <p className="text-sm text-slate-600">
            To get notifications on an iPhone or iPad, first add PetXport to your home screen: tap the Share button in Safari, choose <strong>Add to Home Screen</strong>, then open
            PetXport from the new icon and come back to this page.
          </p>
        ) : (
          <p className="text-sm text-slate-600">This browser does not support push notifications. You will still get emails.</p>
        ))}
      {state === 'blocked' && <p className="text-sm text-slate-600">Notifications are blocked for this site in your browser settings. Allow them there, then reload this page.</p>}
      {state === 'off' && (
        <>
          <p className="text-sm text-slate-600">Get an alert here when drivers are needed, when you are confirmed for a leg, and when the team messages you.</p>
          <Button onClick={enable}>Turn on notifications</Button>
        </>
      )}
      {state === 'on' && (
        <>
          <p className="text-sm text-emerald-700">Notifications are on for this device.</p>
          <Button variant="secondary" onClick={disable}>
            Turn off
          </Button>
        </>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}

export function Profile() {
  const me = useMe();
  const org = useOrg();
  const { slug, apiBase } = useOrgPath();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const userId = me.data?.user.id;
  const profile = useQuery({
    queryKey: ['my-profile', slug],
    enabled: Boolean(userId),
    queryFn: async () => {
      try {
        return await api<Driver>(`${apiBase}/drivers/${userId}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
  if (profile.isLoading || !userId) return <Spinner />;
  const isDriverOnly = org.data?.role === 'driver';
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle title="My profile" />
      {params.has('welcome') && <Notice>Welcome to {org.data?.name}! Fill in your details so coordinators can match you with legs near you.</Notice>}
      <p className="text-sm text-slate-600">
        {me.data?.user.name} · {me.data?.user.email}
      </p>
      <ErrorNote error={profile.error} />
      <PhotoCard />
      <Card className="space-y-3">
        <h2 className="font-semibold">Appearance</h2>
        <ThemePicker />
        <p className="text-sm text-slate-500">Saved on this device. The sun or moon button at the top of every page switches too.</p>
      </Card>
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Sign-in security</h2>
          <p className="text-sm text-slate-500">Passkeys and two-step sign-in for your account.</p>
        </div>
        <Link to="/account">
          <Button variant="secondary">Manage</Button>
        </Link>
      </Card>
      <PushCard />
      <Card>
        <h2 className="mb-1 font-semibold">Driver details</h2>
        {!profile.data && !isDriverOnly && <p className="mb-3 text-sm text-slate-600">Coordinators can drive too. Save this form to add yourself to the driver list.</p>}
        <div className="mt-3">
          <DriverForm
            key={profile.data ? 'loaded' : 'new'}
            mode="self"
            showNotes={!isDriverOnly}
            initial={profile.data ? fromDriver(profile.data) : emptyDriver()}
            smsAvailable={org.data?.features.sms ?? false}
            submitLabel="Save my details"
            onSubmit={async (v) => {
              await api(`${apiBase}/drivers/${userId}`, { method: 'PUT', body: toProfileBody(v) });
              await qc.invalidateQueries({ queryKey: ['my-profile', slug] });
              await qc.invalidateQueries({ queryKey: ['drivers', slug] });
            }}
          />
        </div>
      </Card>
    </div>
  );
}
