import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Spinner } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { api, errorMessage, logout as signOut, useMe } from '../lib/api';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Home for a logged-in user: pick an organization, accept invitations, or start a new one. */
export function Orgs() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (me.isLoading) return <Spinner />;
  if (!me.data) return <Navigate to="/login" replace />;
  const { orgs, user, allowOrgSignup } = me.data;
  const active = orgs.filter((o) => o.status === 'active');
  const invited = orgs.filter((o) => o.status === 'invited');
  // A platform admin with no rescue of their own goes straight to the admin area.
  if (user.isPlatformAdmin && orgs.length === 0 && !params.has('choose')) return <Navigate to="/admin" replace />;
  if (active.length === 1 && invited.length === 0 && !user.isPlatformAdmin && !params.has('choose')) return <Navigate to={`/o/${active[0]!.slug}`} replace />;

  const finalSlug = slug ?? slugify(name);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await api<{ slug: string }>('/orgs', { body: { name, slug: finalSlug, timezone } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(`/o/${res.slug}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const accept = async (orgId: string, orgSlug: string) => {
    await api(`/orgs/${orgId}/accept`, { body: {} });
    await qc.invalidateQueries({ queryKey: ['me'] });
    navigate(`/o/${orgSlug}/profile?welcome=1`);
  };

  const logout = async () => {
    await signOut();
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <Link to="/" title="PetXport home page" className="flex items-center gap-2">
          <img src="/icon.svg" alt="" className="h-9 w-9" />
          <span className="text-xl font-semibold text-brand-900">PetXport</span>
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle className="text-slate-500 hover:bg-slate-100" />
          <Link to="/account" className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50">
            Security
          </Link>
          <Button variant="ghost" small onClick={logout}>
            Log out
          </Button>
        </div>
      </div>
      <h1 className="mb-1 text-xl font-semibold">Hi, {user.name.split(' ')[0]}</h1>
      <p className="mb-5 text-sm text-slate-600">Choose a rescue organization to work in.</p>

      <div className="space-y-3">
        {invited.map((o) => (
          <Card key={o.id} className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">{o.name}</p>
              <p className="text-sm text-slate-500">You have been invited to join.</p>
            </div>
            <Button onClick={() => accept(o.id, o.slug)}>Join</Button>
          </Card>
        ))}
        {active.map((o) => (
          <Link key={o.id} to={`/o/${o.slug}`} className="block">
            <Card className="flex items-center justify-between gap-3 transition-shadow hover:shadow-md">
              <div>
                <p className="font-medium">{o.name}</p>
                <p className="text-sm text-slate-500">/o/{o.slug}</p>
              </div>
              <Badge tone={o.role === 'driver' ? 'slate' : 'green'}>{o.role}</Badge>
            </Card>
          </Link>
        ))}
        {orgs.length === 0 && (
          <Empty>
            You are not part of a rescue organization yet. If a coordinator invited you, open the link in their email.
            {allowOrgSignup ? ' Or set up your own organization below.' : ' New rescue organizations are added by invitation; ask the person who runs this site.'}
          </Empty>
        )}
        {user.isPlatformAdmin && (
          <Link to="/admin" className="block">
            <Card className="flex items-center justify-between gap-3 border-l-4 border-l-brand-600 transition-shadow hover:shadow-md">
              <div>
                <p className="font-medium">Platform admin</p>
                <p className="text-sm text-slate-500">Invite and manage rescue organizations</p>
              </div>
              <span aria-hidden className="text-slate-400">→</span>
            </Card>
          </Link>
        )}
      </div>

      {allowOrgSignup && (
        <div className="mt-6">
          {!creating ? (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              Set up a new rescue organization
            </Button>
          ) : (
            <Card>
              <form onSubmit={create} className="space-y-4">
                <h2 className="font-semibold">New organization</h2>
                <p className="text-sm text-slate-600">Each organization gets its own private space. Drivers, transports and messages are never shared between organizations.</p>
                <Field label="Organization name">
                  <Input name="organization" autoComplete="organization" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Happy Tails Rescue" />
                </Field>
                <Field label="Web address" hint={`Your team will use ${location.host}/o/${finalSlug || 'your-rescue'}`}>
                  <Input name="slug" autoComplete="off" required value={finalSlug} onChange={(e) => setSlug(slugify(e.target.value))} pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
                </Field>
                <ErrorNote error={error} />
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy}>
                    Create organization
                  </Button>
                  <Button variant="ghost" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
