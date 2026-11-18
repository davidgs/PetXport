import type { AppNotification } from '@petxport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { LegalLinks } from './Legal';
import { ErrorNote, Spinner } from '../components/ui';
import { ApiError, api, logout as signOut, useMe, useOrg, useOrgPath } from '../lib/api';
import { relativeTime } from '../lib/format';
import { ThemeToggle } from '../components/ThemeToggle';

function Bell() {
  const { slug, apiBase } = useOrgPath();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data = [] } = useQuery({
    queryKey: ['notifications', slug],
    queryFn: () => api<AppNotification[]>(`${apiBase}/notifications`),
    refetchInterval: 60_000,
  });
  const unread = data.filter((n) => !n.readAt).length;
  const toggle = async () => {
    setOpen(!open);
    if (!open && unread > 0) {
      await api(`${apiBase}/notifications/read`, { body: {} });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['notifications', slug] }), 4000);
    }
  };
  return (
    <div className="relative">
      <button type="button" onClick={toggle} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative rounded-lg p-2 text-white/90 hover:bg-white/10">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-900">{unread}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 max-h-[70vh] w-80 max-w-[90vw] overflow-y-auto rounded-xl bg-white text-slate-900 shadow-xl ring-1 ring-slate-200">
            {data.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">Nothing yet.</p>}
            {data.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`block w-full border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 ${n.readAt ? '' : 'bg-brand-50/60'}`}
                onClick={() => {
                  setOpen(false);
                  if (n.url) navigate(n.url);
                }}
              >
                <p className="text-sm font-medium">{n.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">{relativeTime(n.createdAt)}</p>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function OrgLayout() {
  const me = useMe();
  const org = useOrg();
  const { base } = useOrgPath();
  const location = useLocation();
  const qc = useQueryClient();
  const navigate = useNavigate();

  if (me.isLoading) return <Spinner />;
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (org.isLoading) return <Spinner />;
  if (org.error || !org.data) {
    const missing = org.error instanceof ApiError && org.error.status === 404;
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-16 text-center">
        <ErrorNote error={missing ? 'This organization does not exist, or you are not a member of it.' : org.error} />
        <Link to="/app?choose" className="font-medium text-brand-700 hover:underline">
          See your organizations
        </Link>
      </div>
    );
  }

  const canManage = org.data.role !== 'driver';
  const items = [
    { to: base, label: 'Home', end: true },
    ...(canManage ? [{ to: `${base}/drivers`, label: 'Drivers' }] : []),
    { to: `${base}/profile`, label: 'My profile' },
    ...(canManage ? [{ to: `${base}/settings`, label: 'Settings' }] : []),
  ];
  const logout = async () => {
    await signOut();
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="no-print sticky top-0 z-30 bg-brand-800 text-white shadow">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          <Link to={base} className="flex min-w-0 items-center gap-2">
            {org.data.logoUrl ? (
              <img src={org.data.logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-white/30" />
            ) : (
              <img src="/icon.svg" alt="" className="h-8 w-8 shrink-0 rounded-lg ring-1 ring-white/30" />
            )}
            <span className="truncate font-semibold">{org.data.name}</span>
          </Link>
          <nav className="ml-4 hidden gap-1 sm:flex">
            {items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.end}
                className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-white/15' : 'text-white/85 hover:bg-white/10'}`}
              >
                {i.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            {/* The PetXport paw leads out of the rescue's own space to the public home page. */}
            <Link to="/" title="PetXport home page" aria-label="PetXport home page" className="rounded-lg p-1.5 hover:bg-white/10">
              <img src="/favicon.svg" alt="" className="h-6 w-6 rounded-md ring-1 ring-white/30" />
            </Link>
            <ThemeToggle className="text-white/90 hover:bg-white/10" />
            <Bell />
            {me.data.user.isPlatformAdmin && (
              <Link to="/admin" className="hidden rounded-lg px-2 py-1.5 text-sm text-white/85 hover:bg-white/10 sm:block">
                Platform
              </Link>
            )}
            {me.data.orgs.length > 1 && (
              <Link to="/app?choose" className="hidden rounded-lg px-2 py-1.5 text-sm text-white/85 hover:bg-white/10 sm:block">
                Switch
              </Link>
            )}
            <button type="button" onClick={logout} className="rounded-lg px-2 py-1.5 text-sm text-white/85 hover:bg-white/10">
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 pb-24 sm:pb-8">
        <Outlet />
        <LegalLinks className="no-print mt-10 text-center" />
      </main>
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] sm:hidden">
        {items.map((i) => (
          <NavLink
            key={i.to}
            to={i.to}
            end={i.end}
            className={({ isActive }) => `flex-1 px-1 py-3 text-center text-xs font-medium ${isActive ? 'text-brand-700' : 'text-slate-500'}`}
          >
            {i.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
