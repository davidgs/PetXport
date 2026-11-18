import { formatPhone, type Driver } from '@petxport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Avatar } from '../components/Avatar';
import { DriverForm, emptyDriver, fromDriver, toProfileBody } from '../components/DriverForm';
import { Badge, Button, Card, Checkbox, Empty, ErrorNote, Input, Modal, Notice, PageTitle, Spinner, Textarea } from '../components/ui';
import { api, errorMessage, useOrg, useOrgPath } from '../lib/api';

const SAMPLE = 'name,email,phone,address,vehicle,availability,max miles,crate capacity,notes';

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { apiBase } = useOrgPath();
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ invited: number; skipped: { email: string; reason: string }[] } | null>(null);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api(`${apiBase}/drivers/invite`, { body: { emails } }));
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Invite drivers" onClose={onClose} wide>
      {result ? (
        <div className="space-y-3">
          <Notice>
            {result.invited === 0 ? 'No invitations were sent.' : `Sent ${result.invited} ${result.invited === 1 ? 'invitation' : 'invitations'}.`} Each link works for 14 days.
          </Notice>
          {result.skipped.length > 0 && (
            <ul className="max-h-48 overflow-y-auto rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              {result.skipped.map((s) => (
                <li key={s.email}>
                  <span className="font-medium">{s.email}</span>: {s.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Enter your volunteers' email addresses. Each one gets a link to choose a password and fill in their own details: phone, home town, vehicle and how they want to be notified.
            They appear on this page straight away, marked “Not joined yet”.
          </p>
          <Textarea
            rows={6}
            autoFocus
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder={'pat@example.org\nSam Okafor <sam@example.org>\njo@example.org, lee@example.org'}
            aria-label="Email addresses"
          />
          <p className="text-xs text-slate-500">One per line, or separated by commas. Inviting someone who has not joined yet sends them a fresh link.</p>
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={send} disabled={busy || !emails.trim()}>
              {busy ? 'Sending…' : 'Send invitations'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { apiBase } = useOrgPath();
  const [csv, setCsv] = useState('');
  const [sendInvites, setSendInvites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ added: number; skipped: { row: number; reason: string }[] } | null>(null);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api(`${apiBase}/drivers/import`, { body: { csv, sendInvites } }));
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Import drivers from a spreadsheet" onClose={onClose} wide>
      {result ? (
        <div className="space-y-3">
          <Notice>
            Added {result.added} {result.added === 1 ? 'driver' : 'drivers'}.{result.skipped.length > 0 && ` Skipped ${result.skipped.length}.`}
          </Notice>
          {result.skipped.length > 0 && (
            <ul className="max-h-48 overflow-y-auto rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              {result.skipped.map((s) => (
                <li key={s.row}>
                  Row {s.row}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Save your spreadsheet as CSV, then choose the file or paste its contents. The first row must be column names. <strong>name</strong> and <strong>email</strong> are required; the
            others are optional:
          </p>
          <code className="block overflow-x-auto rounded-lg bg-slate-100 p-2 text-xs">{SAMPLE}</code>
          <input
            type="file"
            accept=".csv,text/csv"
            className="block text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setCsv(await file.text());
            }}
          />
          <Textarea rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={`${SAMPLE}\nPat Lee,pat@example.org,919-555-0123,"Cary, NC",…`} className="font-mono text-xs" />
          <Checkbox label="Email each new driver an invitation to set up their account" checked={sendInvites} onChange={setSendInvites} />
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={run} disabled={busy || !csv.trim()}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Drivers() {
  const { slug, apiBase } = useOrgPath();
  const org = useOrg();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['drivers', slug], queryFn: () => api<Driver[]>(`${apiBase}/drivers`) });
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Driver | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['drivers', slug] });
  const sms = org.data?.features.sms ?? false;

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const shown = (data ?? []).filter(
    (d) =>
      !q ||
      [d.name, d.email, d.homeAddress, d.phone].some((f) => f?.toLowerCase().includes(q)) ||
      // Typing a number in any style finds it, however it was entered.
      (qDigits.length >= 3 && (d.phone ?? '').replace(/\D/g, '').includes(qDigits)),
  );

  const resend = async (d: Driver) => {
    setNotice('');
    try {
      await api(`${apiBase}/members/${d.userId}/invite`, { body: {} });
      setNotice(`Invitation sent to ${d.email}.`);
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  return (
    <>
      <PageTitle title="Drivers">
        <Button variant="secondary" onClick={() => setImporting(true)}>
          Import
        </Button>
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Add with details
        </Button>
        <Button onClick={() => setInviting(true)}>Invite drivers</Button>
      </PageTitle>
      {notice && <div className="mb-3"><Notice>{notice}</Notice></div>}
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, town, email or phone" className="mb-4 max-w-md" aria-label="Search drivers" />
      {isLoading && <Spinner />}
      <ErrorNote error={error} />
      {data && data.length === 0 && <Empty>No drivers yet. Invite your volunteers by email and let them fill in their own details, add one yourself, or import a spreadsheet.</Empty>}
      {data && data.length > 0 && shown.length === 0 && <Empty>No drivers match “{search}”.</Empty>}
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map((d) => (
          <Card key={d.userId} className={d.active ? '' : 'opacity-60'}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={d.name} photo={d.photo} />
                <div className="min-w-0">
                  <p className="truncate font-medium">{d.name}</p>
                  <p className="truncate text-sm text-slate-500">{d.email}</p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                {!d.active && <Badge>Paused</Badge>}
                {d.memberStatus === 'invited' && <Badge tone="amber">Not joined yet</Badge>}
                {d.memberStatus === 'disabled' && <Badge tone="rose">Removed</Badge>}
                {d.role !== 'driver' && <Badge tone="green">{d.role}</Badge>}
              </div>
            </div>
            <dl className="mt-3 space-y-1 text-sm text-slate-700">
              {d.phone && (
                <div>
                  <a href={`tel:${d.phone}`} className="text-brand-700 hover:underline">
                    {formatPhone(d.phone)}
                  </a>
                </div>
              )}
              {d.homeAddress && (
                <div>
                  {d.homeAddress}
                  {d.homeLat == null && <span className="ml-1 text-xs text-amber-700">(location not found yet)</span>}
                </div>
              )}
              <div className="text-slate-500">
                {[d.maxMiles && `up to ${d.maxMiles} mi`, d.vehicle, d.crateCapacity != null && `${d.crateCapacity} crates`, d.availability].filter(Boolean).join(' · ')}
              </div>
            </dl>
            <div className="mt-3 flex gap-2">
              <Button small variant="secondary" onClick={() => setEditing(d)}>
                Edit
              </Button>
              {d.memberStatus === 'invited' && (
                <Button small variant="ghost" onClick={() => resend(d)}>
                  Send invitation
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {adding && (
        <Modal title="Add a driver" onClose={() => setAdding(false)} wide>
          <AddDriver
            sms={sms}
            onCancel={() => setAdding(false)}
            onDone={async (email, invited) => {
              setAdding(false);
              await refresh();
              setNotice(invited ? `Added. An invitation was emailed to ${email}.` : 'Added to the roster.');
            }}
          />
        </Modal>
      )}
      {editing && (
        <Modal title={editing.name} onClose={() => setEditing(null)} wide>
          <DriverForm
            mode="edit"
            initial={fromDriver(editing)}
            smsAvailable={sms}
            submitLabel="Save"
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              await api(`${apiBase}/drivers/${editing.userId}`, { method: 'PUT', body: toProfileBody(v) });
              await refresh();
              setEditing(null);
            }}
          />
        </Modal>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onDone={refresh} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={refresh} />}
    </>
  );
}

function AddDriver({ sms, onCancel, onDone }: { sms: boolean; onCancel: () => void; onDone: (email: string, invited: boolean) => void }) {
  const { apiBase } = useOrgPath();
  const [invite, setInvite] = useState(true);
  return (
    <DriverForm
      mode="new"
      initial={emptyDriver()}
      smsAvailable={sms}
      submitLabel="Add driver"
      onCancel={onCancel}
      extra={<Checkbox label="Email them an invitation so they can log in, see requests and sign up for legs" checked={invite} onChange={setInvite} />}
      onSubmit={async (v) => {
        await api(`${apiBase}/drivers`, { body: { name: v.name, email: v.email, sendInvite: invite, ...toProfileBody(v) } });
        onDone(v.email, invite);
      }}
    />
  );
}
