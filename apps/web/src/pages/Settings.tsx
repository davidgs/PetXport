import { MAX_LOGO_BYTES, ROLES, type Member, type Role } from '@petxport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Avatar } from '../components/Avatar';
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, PageTitle, Select, Spinner } from '../components/ui';
import { api, errorMessage, useMe, useOrg, useOrgPath } from '../lib/api';

function OrgSettings() {
  const org = useOrg();
  const { slug, apiBase } = useOrgPath();
  const qc = useQueryClient();
  const o = org.data!;
  const [name, setName] = useState(o.name);
  const [miles, setMiles] = useState(String(o.legTargetMiles));
  const [minutes, setMinutes] = useState(String(o.legTargetMinutes));
  const [buffer, setBuffer] = useState(String(o.handoffBufferMinutes));
  const [timezone, setTimezone] = useState(o.timezone);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [o.timezone];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(apiBase, {
        method: 'PATCH',
        body: { name, legTargetMiles: Number(miles), legTargetMinutes: Number(minutes), handoffBufferMinutes: Number(buffer), timezone },
      });
      await qc.invalidateQueries({ queryKey: ['org', slug] });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Card>
      <form onSubmit={save} className="space-y-4" onChange={() => setSaved(false)}>
        <h2 className="font-semibold">Organization</h2>
        <Field label="Name">
          <Input name="organization" autoComplete="organization" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Leg length (miles)" hint="New transports are split into legs of about this distance…">
            <Input type="number" min={20} max={400} required value={miles} onChange={(e) => setMiles(e.target.value)} />
          </Field>
          <Field label="Leg length (minutes)" hint="…or this much driving, whichever comes first.">
            <Input type="number" min={30} max={480} required value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
          <Field label="Handoff time (minutes)" hint="Allowed at each meeting point for the transfer.">
            <Input type="number" min={0} max={120} required value={buffer} onChange={(e) => setBuffer(e.target.value)} />
          </Field>
        </div>
        <Field label="Time zone" hint="Used for the times written in emails and text messages. In the app, everyone sees times in their own time zone.">
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={error} />
        <div className="flex items-center gap-2">
          <Button type="submit">Save</Button>
          {saved && <span className="text-sm text-emerald-700">Saved</span>}
        </div>
      </form>
    </Card>
  );
}

/** Scales an image down in the browser and re-encodes it as PNG, which also drops any hidden metadata. */
async function prepareLogo(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file could not be read as an image.');
  });
  const draw = (maxSide: number) => {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1]!;
  };
  // Detailed images can still be large as PNG; step down until it fits.
  for (const side of [512, 384, 256, 160]) {
    const data = draw(side);
    if ((data.length * 3) / 4 <= MAX_LOGO_BYTES) return data;
  }
  throw new Error('That image is too detailed to use as a logo. Try a simpler one.');
}

function LogoCard() {
  const org = useOrg();
  const { slug, apiBase } = useOrgPath();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', slug] });
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const logoUrl = org.data?.logoUrl;
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Logo</h2>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
          <img src={logoUrl ?? '/icon.svg'} alt={logoUrl ? `${org.data?.name} logo` : 'Default PetXport logo'} className="max-h-full max-w-full object-contain" />
        </div>
        <div className="space-y-2">
          <p className="text-sm text-slate-600">Shown at the top of every page for your team. PNG, JPEG or WebP; a square image works best.</p>
          <div className="flex flex-wrap gap-2">
            <label className={`inline-flex cursor-pointer items-center rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-800 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              {busy ? 'Working…' : logoUrl ? 'Replace logo' : 'Upload logo'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void run(async () => api(`${apiBase}/logo`, { method: 'PUT', body: { data: await prepareLogo(file) } }));
                }}
              />
            </label>
            {logoUrl && (
              <Button variant="secondary" disabled={busy} onClick={() => run(() => api(`${apiBase}/logo`, { method: 'DELETE' }))}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      <ErrorNote error={error} />
    </Card>
  );
}

function Members({ isAdmin }: { isAdmin: boolean }) {
  const { slug, apiBase } = useOrgPath();
  const me = useMe();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['members', slug], queryFn: () => api<Member[]>(`${apiBase}/members`) });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('coordinator');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['members', slug] });

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError('');
    setNotice('');
    try {
      await fn();
      await refresh();
      if (done) setNotice(done);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const invite = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api(`${apiBase}/members`, { body: { name, email, role } });
      setName('');
      setEmail('');
    }, `Invitation sent to ${email}.`);
  };

  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">Team</h2>
      <p className="text-sm text-slate-600">
        <strong>Admins</strong> manage settings and the team. <strong>Coordinators</strong> manage drivers and plan transports. <strong>Drivers</strong> see only the transports they are asked
        about. Add drivers on the Drivers page.
      </p>
      {isLoading && <Spinner />}
      <ul className="divide-y divide-slate-100">
        {data?.map((m) => {
          const self = m.userId === me.data?.user.id;
          return (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <Avatar name={m.name} photo={m.photo} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.name} {self && <span className="font-normal text-slate-500">(you)</span>}
                </p>
                <p className="truncate text-xs text-slate-500">{m.email}</p>
              </div>
              <div className="flex items-center gap-2">
                {m.status === 'invited' && <Badge tone="amber">Invited</Badge>}
                {m.status === 'disabled' && <Badge tone="rose">Removed</Badge>}
                {isAdmin ? (
                  <>
                    <Select
                      aria-label={`Role for ${m.name}`}
                      className="!w-auto !py-1.5 text-sm"
                      value={m.role}
                      onChange={(e) => run(() => api(`${apiBase}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }))}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                    {!self &&
                      (m.status === 'disabled' ? (
                        <Button small variant="secondary" onClick={() => run(() => api(`${apiBase}/members/${m.userId}`, { method: 'PATCH', body: { status: 'active' } }))}>
                          Restore
                        </Button>
                      ) : (
                        <Button
                          small
                          variant="danger"
                          onClick={() => {
                            if (window.confirm(`Remove ${m.name} from this organization? They will lose access immediately.`)) {
                              void run(() => api(`${apiBase}/members/${m.userId}`, { method: 'PATCH', body: { status: 'disabled' } }));
                            }
                          }}
                        >
                          Remove
                        </Button>
                      ))}
                  </>
                ) : (
                  <Badge>{m.role}</Badge>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorNote error={error} />
      {notice && <Notice>{notice}</Notice>}
      {isAdmin && (
        <form onSubmit={invite} className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <Field label="Invite a coordinator or admin">
            <Input name="name" autoComplete="name" required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Input name="email" autoComplete="email" required type="email" placeholder="Email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="sm:!w-auto">
            <option value="coordinator">coordinator</option>
            <option value="admin">admin</option>
          </Select>
          <Button type="submit">Invite</Button>
        </form>
      )}
    </Card>
  );
}

export function Settings() {
  const org = useOrg();
  if (!org.data) return <Spinner />;
  const isAdmin = org.data.role === 'admin';
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle title="Settings" />
      {isAdmin ? <OrgSettings /> : <Notice>Only admins can change organization settings.</Notice>}
      {isAdmin && <LogoCard />}
      <Members isAdmin={isAdmin} />
      <Card>
        <h2 className="mb-2 font-semibold">Notification channels on this server</h2>
        <ul className="space-y-1 text-sm text-slate-700">
          <li>Email: on</li>
          <li>Push notifications: {org.data.features.push ? 'on' : 'not set up by the server administrator'}</li>
          <li>Text messages: {org.data.features.sms ? 'on' : 'not set up by the server administrator'}</li>
        </ul>
      </Card>
    </div>
  );
}
