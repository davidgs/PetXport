import { PUBLIC_PATHS, STATCOUNTER } from '@petxport/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { useMe } from './api';

/**
 * Visitor counting (Statcounter) for the public pages only.
 *
 * A counter is somebody else's script, and a script on a page can read everything on it.
 * So it is loaded only for visitors who are not logged in and have said yes to being counted,
 * only on the pages listed in PUBLIC_PATHS, and only on the real site. The server's security header refuses it anywhere
 * else, and <LeaveCounterBehind> in main.tsx reloads the page when such a visitor moves on to
 * log in, so the counter is never present next to a password, a sign-in code or anyone's data.
 */

let loaded = false;
export const counterLoaded = () => loaded;
export const isPublicPath = (pathname: string) => (PUBLIC_PATHS as readonly string[]).includes(pathname.replace(/\/+$/, '') || '/');

/** Whether this is the site the counter belongs to (not a development copy or someone else's install). */
export const counterApplies = () => location.hostname === STATCOUNTER.host;

// ----- the visitor's answer to "may we count your visit?" -----

export type VisitChoice = 'yes' | 'no' | null;
const KEY = 'petxport.visits';
const listeners = new Set<() => void>();
const read = (): VisitChoice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
};
let choice = read();

export function setVisitChoice(next: VisitChoice): void {
  choice = next;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch {
    // Private browsing: the answer lasts for this visit only.
  }
  // Saying no (or asking to be asked again) also removes the counter's own cookie.
  if (next !== 'yes') {
    // The counter may have set it for this host or for the whole domain; clear both.
    for (const domain of ['', `; domain=${location.hostname}`, `; domain=.${location.hostname}`]) {
      document.cookie = `sc_is_visitor_unique=; Max-Age=0; path=/${domain}`;
    }
  }
  listeners.forEach((fn) => fn());
  // A counter that is already running cannot be switched off in place; a fresh page load removes it.
  if (next !== 'yes' && loaded) window.location.reload();
}

export const useVisitChoice = (): VisitChoice =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => choice,
  );

function load(): void {
  if (loaded || !counterApplies()) return;
  loaded = true;
  Object.assign(window, { sc_project: STATCOUNTER.project, sc_invisible: 1, sc_security: STATCOUNTER.security });
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.statcounter.com/counter/counter.js';
  document.head.appendChild(script);
}

/** True for someone who is not logged in, once that is known. */
export const useIsVisitor = (): boolean => useMe().data === null;

/** Call from a public page. Counts the visit once nobody is logged in and the visitor has agreed. */
export function useVisitorCounter(): void {
  const visitor = useIsVisitor();
  const agreed = useVisitChoice() === 'yes';
  const { pathname } = useLocation();
  useEffect(() => {
    if (!visitor || !agreed || !isPublicPath(pathname)) return;
    if (!loaded) return load();
    // Moving between public pages without a reload: tell the counter, where it supports that.
    const sc = (window as { _statcounter?: { record_pageview?: () => void } })._statcounter;
    if (typeof sc?.record_pageview === 'function') sc.record_pageview();
  }, [visitor, agreed, pathname]);
}
