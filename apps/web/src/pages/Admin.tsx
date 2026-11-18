import type { AdminOrg } from '@petxport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Notice, Spinner } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { api, errorMessage, useMe } from '../lib/api';
import { fmtDate } from '../lib/format';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function InviteOrgForm({ onDone }: { onDone: (message: string) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const finalSlug = slug ?? slugify(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/orgs', {
        body: { name, slug: finalSlug, adminName, adminEmail, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
      onDone(`${name} is set up. An invitation was emailed to ${adminEmail}.`);
      setName('');
      setSlug(null);
      setAdminName('');
      setAdminEmail('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <h2 className="font-semibold">Invite a rescue organization</h2>
          <p className="mt-1 text-sm text-slate-600">
            This creates a private space for the rescue and emails its administrator a link to take it over. They then invite their own coordinators and drivers.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Organization name">
            <Input name="organization" autoComplete="organization" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Second Chance Dogs" />
          </Field>
          <Field label="Web address" hint={`${location.host}/o/${finalSlug || 'their-rescue'}`}>
            <Input name="slug" autoComplete="off" required value={finalSlug} onChange={(e) => setSlug(slugify(e.target.value))} pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
          </Field>
          <Field label="Administrator's name">
            <Input name="name" autoComplete="name" required value={adminName} onChange={(e) => setAdminName(e.target.value)} />
          </Field>
          <Field label="Administrator's email">
            <Input name="email" autoComplete="email" required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Setting up…' : 'Create and send invitation'}
        </Button>
      </form>
    </Card>
  );
}

/** Platform ("super") admin: every rescue on this server, and the way new ones are brought on. */
export function Admin() {
  const me = useMe();
  const qc = useQueryClient();
  const isAdmin = me.data?.user.isPlatformAdmin ?? false;
  const { data, isLoading, error } = useQuery({ queryKey: ['admin-orgs'], queryFn: () => api<AdminOrg[]>('/admin/orgs'), enabled: isAdmin });
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  if (me.isLoading) return <Spinner />;
  if (!me.data) return <Navigate to="/login?next=/admin" replace />;
  if (!isAdmin) return <Navigate to="/app" replace />;

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-orgs'] });
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setNotice('');
    setActionError('');
    try {
      await fn();
      await refresh();
      setNotice(done);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <img src="/icon.svg" alt="" className="h-9 w-9" />
          <div>
            <h1 className="text-xl font-semibold leading-tight">Platform admin</h1>
            <p className="text-sm text-slate-500">Rescue organizations on this server</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle className="text-slate-500 hover:bg-slate-100" />
          <Link to="/account" className="text-sm font-medium text-brand-700 hover:underline">
            Security
          </Link>
          <Link to="/app?choose" className="text-sm font-medium text-brand-700 hover:underline">
            My organizations
          </Link>
        </div>
      </div>

      <InviteOrgForm
        onDone={async (message) => {
          await refresh();
          setActionError('');
          setNotice(message);
        }}
      />
      {notice && <Notice>{notice}</Notice>}
      <ErrorNote error={actionError || error} />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Organizations{data ? ` (${data.length})` : ''}</h2>
        {isLoading && <Spinner />}
        {data?.length === 0 && <Empty>No organizations yet. Invite the first one above.</Empty>}
        {data?.map((org) => {
          const waiting = org.admins.some((a) => a.status === 'invited');
          return (
            <Card key={org.id} className={org.suspended ? 'opacity-70' : ''}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{org.name}</p>
                  <p className="text-sm text-slate-500">
                    /o/{org.slug} · since {fmtDate(org.createdAt)}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  {org.suspended && <Badge tone="rose">Suspended</Badge>}
                  {waiting && <Badge tone="amber">Invitation not accepted yet</Badge>}
                </div>
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {org.admins.length === 0
                  ? 'No administrator'
                  : org.admins.map((a) => `${a.name} (${a.email})${a.status === 'invited' ? ', invited' : a.status === 'disabled' ? ', removed' : ''}`).join(' · ')}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'} · {org.driverCount} {org.driverCount === 1 ? 'driver' : 'drivers'} · {org.transportCount}{' '}
                {org.transportCount === 1 ? 'transport' : 'transports'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {waiting && (
                  <Button small variant="secondary" onClick={() => run(() => api(`/admin/orgs/${org.id}/invite`, { body: {} }), `Invitation sent again for ${org.name}.`)}>
                    Send invitation again
                  </Button>
                )}
                {org.suspended ? (
                  <Button
                    small
                    variant="secondary"
                    onClick={() => run(() => api(`/admin/orgs/${org.id}`, { method: 'PATCH', body: { suspended: false } }), `${org.name} is active again.`)}
                  >
                    Restore
                  </Button>
                ) : (
                  <Button
                    small
                    variant="danger"
                    onClick={() => {
                      if (window.confirm(`Suspend ${org.name}? Its members will not be able to open it until you restore it. Nothing is deleted.`)) {
                        void run(() => api(`/admin/orgs/${org.id}`, { method: 'PATCH', body: { suspended: true } }), `${org.name} is suspended.`);
                      }
                    }}
                  >
                    Suspend
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </section>
      <p className="text-xs text-slate-500">
        As platform admin you can see who runs each organization and how large it is. Their drivers, transports and messages are visible only to their own members.
      </p>
    </div>
  );
}
