import {
  ANIMAL_SIZE_LABELS,
  formatDuration,
  formatMiles,
  formatPhone,
  type Driver,
  type Leg,
  type Place,
  type Suggestion,
  type TransportDetail,
  type LegPosition,
} from '@petxport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { Chat } from '../components/Chat';
import { HandoffPicker } from '../components/HandoffPicker';
import { RouteMap } from '../components/RouteMap';
import { Badge, Button, Card, Checkbox, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, StatusBadge, Textarea } from '../components/ui';
import { api, errorMessage, useOrgPath } from '../lib/api';
import { fmtDate, fmtDateTime, fmtTime, mapsLinks, relativeTime, toLocalInput } from '../lib/format';
import { useShareLocation } from '../lib/shareLocation';

type Act = (fn: () => Promise<unknown>, confirmText?: string) => Promise<void>;

const handoffsOf = (legs: Leg[]): Place[] => legs.slice(0, -1).map((l) => l.end);

/** Point half way along a leg's drawn line (by vertex count, which is evenly spaced enough). */
function midpoint(leg: Leg): { lat: number; lng: number } {
  const [lng, lat] = leg.geometry[Math.floor(leg.geometry.length / 2)] ?? [leg.start.lng, leg.start.lat];
  return { lat, lng };
}

function RequestDialog({ t, onClose, onDone }: { t: TransportDetail; onClose: () => void; onDone: (n: number) => void }) {
  const { apiBase } = useOrgPath();
  const { data, isLoading, error } = useQuery({
    queryKey: ['suggestions', t.id],
    queryFn: () => api<Suggestion[]>(`${apiBase}/transports/${t.id}/suggestions`),
    gcTime: 0,
  });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [message, setMessage] = useState('');
  const [sendError, setSendError] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = picked ?? new Set((data ?? []).filter((s) => s.inRange && !s.alreadyRequested).map((s) => s.userId));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const send = async () => {
    setBusy(true);
    setSendError('');
    try {
      const res = await api<{ requested: number }>(`${apiBase}/transports/${t.id}/request-volunteers`, { body: { audience: [...chosen], message } });
      onDone(res.requested);
    } catch (err) {
      setSendError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="Request volunteer drivers" onClose={onClose} wide>
      {isLoading && <Spinner />}
      <ErrorNote error={error} />
      {data && data.length === 0 && <Notice>There are no active drivers on your roster yet. Add some on the Drivers page first.</Notice>}
      {data && data.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Drivers are listed by how close they live to the start of an open leg. Those within their travel range are ticked for you. Each one is told by email, text or push,
            depending on what they chose.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" small onClick={() => setPicked(new Set(data.map((s) => s.userId)))}>
              Select all
            </Button>
            <Button variant="secondary" small onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          </div>
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg ring-1 ring-slate-200">
            {data.map((s) => (
              <li key={s.userId} className="flex items-center justify-between gap-3 px-3 py-2">
                <Checkbox
                  checked={chosen.has(s.userId)}
                  onChange={(on) => toggle(s.userId, on)}
                  label={
                    <>
                      <span className="font-medium text-slate-900">{s.name}</span>
                      <span className="block text-xs text-slate-500">
                        {s.milesFromHome == null ? 'Home location not known' : `${s.milesFromHome} mi from the start of leg ${s.legSeq}`}
                      </span>
                    </>
                  }
                />
                <span className="flex shrink-0 gap-1">
                  {s.inRange && <Badge tone="green">In range</Badge>}
                  {s.alreadyRequested && <Badge>Already asked</Badge>}
                </span>
              </li>
            ))}
          </ul>
          <Field label="Add a personal note (optional)">
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} placeholder="Two sweet, crate-trained beagles. Any help is appreciated!" />
          </Field>
          <ErrorNote error={sendError} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={send} disabled={busy || chosen.size === 0}>
              {busy ? 'Sending…' : `Send to ${chosen.size} ${chosen.size === 1 ? 'driver' : 'drivers'}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The driver's own switch for showing the crew where the animal is. Off until they turn it on. */
function ShareLocation({ legId, legUrl }: { legId: string; legUrl: string }) {
  const share = useShareLocation(legId, legUrl);
  if (!share.supported) return null;
  return (
    <div className="no-print mt-3 rounded-lg bg-white p-3 text-sm ring-1 ring-slate-200">
      {share.sharing ? (
        <>
          <p>
            <span className="font-medium text-slate-900">Sharing your location</span>
            <span className="text-slate-600"> · {share.lastSentAt ? 'the coordinator and the other drivers can see where you are.' : 'finding you…'}</span>
          </p>
          <p className="mt-1 text-slate-600">Keep this page open on screen: your phone stops reporting when it is locked or you switch apps. Sharing ends by itself at the handoff.</p>
          <Button small variant="secondary" className="mt-2" onClick={share.stop}>
            Stop sharing
          </Button>
        </>
      ) : (
        <>
          <p className="text-slate-600">Let the coordinator and the other drivers on this transport see where you are until the handoff. Only your latest position is kept, and it is deleted when the leg ends.</p>
          <Button small variant="secondary" className="mt-2" onClick={share.start}>
            Share my location
          </Button>
        </>
      )}
      {share.error && <p className="mt-2 text-rose-700">{share.error}</p>}
    </div>
  );
}

function LegCard({
  t,
  leg,
  index,
  selected,
  onSelect,
  act,
  roster,
  replan,
  onEditHandoff,
  position,
}: {
  t: TransportDetail;
  leg: Leg;
  index: number;
  selected: boolean;
  onSelect: () => void;
  act: Act;
  roster: Driver[];
  replan: (handoffs: Place[], confirmText?: string) => Promise<void>;
  onEditHandoff: (index: number) => void;
  /** Where the animal was last reported on this leg, when its driver is sharing. */
  position: LegPosition | null;
}) {
  const { apiBase } = useOrgPath();
  const { viewer } = t;
  const legUrl = `${apiBase}/transports/${t.id}/legs/${leg.id}`;
  const mine = leg.driver?.userId === viewer.userId;
  const open = !leg.driver;
  const live = t.status !== 'cancelled' && t.status !== 'completed';
  const planning = live && t.status !== 'in_progress';
  const prev = t.legs[index - 1];
  const next = t.legs[index + 1];
  const links = mapsLinks(leg.start, leg.end);
  const pending = leg.offers?.filter((o) => o.status === 'offered') ?? [];
  const [note, setNote] = useState('');
  const [offering, setOffering] = useState(false);
  const hasDrivers = t.legs.some((l) => l.driver);
  const countChangeWarning = hasDrivers ? 'Changing the number of legs clears every driver already assigned to this transport. Continue?' : undefined;

  return (
    <Card className={`${selected ? 'ring-2 ring-brand-600' : ''} ${mine ? 'bg-brand-50/50' : ''}`}>
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">
            Leg {leg.seq}
            <span className="ml-2 font-normal text-slate-500">
              {formatMiles(leg.distanceM)} · {formatDuration(leg.durationS)}
            </span>
          </h3>
          {leg.status === 'done' ? (
            <Badge>Done</Badge>
          ) : leg.status === 'in_progress' ? (
            <Badge tone="blue">On the road</Badge>
          ) : open ? (
            <Badge tone="amber">{pending.length > 0 ? `${pending.length} ${pending.length === 1 ? 'offer' : 'offers'}` : 'Needs a driver'}</Badge>
          ) : (
            <Badge tone="green">{mine ? 'You are driving' : 'Covered'}</Badge>
          )}
        </div>
        <ol className="mt-3 space-y-2 text-sm">
          <li className="flex gap-3">
            <span className="w-20 shrink-0 font-medium tabular-nums text-slate-900">{fmtTime(leg.departAt)}</span>
            <span className="text-slate-700">{leg.start.name}</span>
          </li>
          <li className="flex gap-3">
            <span className="w-20 shrink-0 font-medium tabular-nums text-slate-900">{fmtTime(leg.arriveAt)}</span>
            <span className="text-slate-700">{leg.end.name}</span>
          </li>
        </ol>
      </button>

      <div className="mt-3 border-t border-slate-200 pt-3 text-sm">
        {leg.driver ? (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <Avatar name={leg.driver.name} photo={leg.driver.photo} size="sm" />
            <span className="text-slate-500">Driver: </span>
            <span className="font-medium">{mine ? 'You' : leg.driver.name}</span>
            {leg.driver.phone && !mine && (
              <a href={`tel:${leg.driver.phone}`} className="ml-2 text-brand-700 hover:underline">
                {formatPhone(leg.driver.phone)}
              </a>
            )}
          </p>
        ) : (
          <p className="text-slate-500">No driver yet.</p>
        )}

        {mine && (
          <div className="mt-3 space-y-3">
            <div className="rounded-lg bg-white p-3 text-sm ring-1 ring-slate-200">
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {prev?.driver && <Avatar name={prev.driver.name} photo={prev.driver.photo} size="md" />}
                <span className="text-slate-500">You receive from: </span>
                {prev ? (prev.driver ? `${prev.driver.name}${prev.driver.phone ? ` · ${formatPhone(prev.driver.phone)}` : ''}` : 'driver to be confirmed') : 'the sending rescue or foster at the pickup place'}
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {next?.driver && <Avatar name={next.driver.name} photo={next.driver.photo} size="md" />}
                <span className="text-slate-500">You hand off to: </span>
                {next ? (next.driver ? `${next.driver.name}${next.driver.phone ? ` · ${formatPhone(next.driver.phone)}` : ''}` : 'driver to be confirmed') : 'the receiving rescue or adopter at the destination'}
              </p>
            </div>
            <div className="no-print flex flex-wrap gap-2">
              <a href={links.google} target="_blank" rel="noreferrer">
                <Button variant="secondary" small>
                  Directions in Google Maps
                </Button>
              </a>
              <a href={links.apple} target="_blank" rel="noreferrer">
                <Button variant="secondary" small>
                  Apple Maps
                </Button>
              </a>
            </div>
          </div>
        )}

        {leg.status === 'in_progress' && viewer.isCrew && !mine && (
          <p className="mt-2 text-sm text-slate-600">
            {position ? (
              <>
                <span className="font-medium text-slate-900">Location shared</span> · updated {relativeTime(position.at)}. The paw on the map shows where they are.
              </>
            ) : (
              'The driver is not sharing their location right now.'
            )}
          </p>
        )}
        {mine && leg.status === 'in_progress' && <ShareLocation legId={leg.id} legUrl={legUrl} />}

        {/* Driver actions */}
        {live && (
          <div className="no-print mt-3 flex flex-wrap gap-2">
            {(mine || (viewer.canManage && leg.driver)) && leg.status === 'filled' && (
              <Button small onClick={() => act(() => api(`${legUrl}/status`, { body: { status: 'in_progress' } }))}>
                {mine ? 'I have the animals, starting now' : 'Mark as started'}
              </Button>
            )}
            {(mine || (viewer.canManage && leg.driver)) && leg.status === 'in_progress' && (
              <Button small onClick={() => act(() => api(`${legUrl}/status`, { body: { status: 'done' } }))}>
                {mine ? 'Handed off' : 'Mark as handed off'}
              </Button>
            )}
            {mine && leg.status === 'filled' && (
              <Button
                small
                variant="danger"
                onClick={() => act(() => api(`${legUrl}/offers/mine`, { method: 'DELETE' }), 'Step down from this leg? The coordinator will be told it needs a new driver.')}
              >
                I can no longer drive this
              </Button>
            )}
            {open && planning && leg.myOffer !== 'offered' && !offering && (
              <Button small onClick={() => setOffering(true)}>
                I can drive this
              </Button>
            )}
            {open && leg.myOffer === 'offered' && (
              <>
                <Badge tone="blue">You offered · waiting for the coordinator</Badge>
                <Button small variant="ghost" onClick={() => act(() => api(`${legUrl}/offers/mine`, { method: 'DELETE' }))}>
                  Withdraw offer
                </Button>
              </>
            )}
          </div>
        )}
        {offering && (
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
            <Field label="Anything the coordinator should know? (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="I have a large crate. Could leave 30 minutes later." />
            </Field>
            <div className="flex gap-2">
              <Button
                small
                onClick={() =>
                  act(async () => {
                    await api(`${legUrl}/offers`, { body: { note } });
                    setOffering(false);
                  })
                }
              >
                Send my offer
              </Button>
              <Button small variant="ghost" onClick={() => setOffering(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Coordinator tools */}
        {viewer.canManage && live && (
          <div className="no-print mt-3 space-y-3">
            {pending.length > 0 && (
              <ul className="space-y-2">
                {pending.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-inset ring-amber-200">
                    <div className="min-w-0">
                      <p className="font-medium">{o.name}</p>
                      <p className="text-xs text-slate-600">
                        {[o.milesFromHome != null && `${o.milesFromHome} mi from the start`, formatPhone(o.phone), o.note && `“${o.note}”`].filter(Boolean).join(' · ') || 'Offered to drive'}
                      </p>
                    </div>
                    <Button small onClick={() => act(() => api(`${apiBase}/transports/${t.id}/offers/${o.id}/accept`, { body: {} }))}>
                      Confirm
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {planning && (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label={`Assign a driver to leg ${leg.seq}`}
                  className="!w-auto max-w-full !py-1.5 text-sm"
                  value=""
                  onChange={(e) => {
                    const userId = e.target.value;
                    if (userId) void act(() => api(`${legUrl}/assign`, { body: { userId } }));
                  }}
                >
                  <option value="">{leg.driver ? 'Change driver…' : 'Assign a driver…'}</option>
                  {roster
                    .filter((d) => d.active && d.memberStatus !== 'disabled' && d.userId !== leg.driver?.userId)
                    .map((d) => (
                      <option key={d.userId} value={d.userId}>
                        {d.name}
                      </option>
                    ))}
                </Select>
                {leg.driver && (
                  <Button small variant="ghost" onClick={() => act(() => api(`${legUrl}/assign`, { body: { userId: null } }), `Take ${leg.driver!.name} off leg ${leg.seq}?`)}>
                    Unassign
                  </Button>
                )}
                {next && (
                  <Button small variant="ghost" onClick={() => onEditHandoff(index)}>
                    Choose handoff place on map
                  </Button>
                )}
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    const h = handoffsOf(t.legs);
                    h.splice(index, 0, { name: '', ...midpoint(leg) });
                    void replan(h, countChangeWarning);
                  }}
                >
                  Split in two
                </Button>
                {next && (
                  <Button
                    small
                    variant="ghost"
                    onClick={() => {
                      const h = handoffsOf(t.legs);
                      h.splice(index, 1);
                      void replan(h, countChangeWarning ?? `Join leg ${leg.seq} and leg ${next.seq} into one longer leg?`);
                    }}
                  >
                    Join with next leg
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function Transport() {
  const { id = '' } = useParams();
  const { slug, apiBase } = useOrgPath();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'chat' ? 'chat' : 'plan';
  const key = ['transport', slug, id];
  const { data: t, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api<TransportDetail>(`${apiBase}/transports/${id}`),
    refetchInterval: 30_000,
  });
  const canManage = t?.viewer.canManage ?? false;
  // While the transport is under way, the crew sees where the animal is, if its driver is sharing.
  const watching = Boolean(t?.viewer.isCrew && t.status === 'in_progress');
  const positions = useQuery({
    queryKey: ['positions', slug, id],
    queryFn: () => api<LegPosition[]>(`${apiBase}/transports/${id}/positions`),
    enabled: watching,
    refetchInterval: 15_000,
  });
  const animalNames = t?.animals.map((a) => a.name).join(' and ') || 'The animals';
  const livePins = useMemo(
    () =>
      watching
        ? (positions.data ?? []).map((p) => ({ legId: p.legId, lat: p.lat, lng: p.lng, title: `${animalNames}: here ${relativeTime(p.at)}` }))
        : [],
    [watching, positions.data, animalNames],
  );
  const roster = useQuery({ queryKey: ['drivers', slug], queryFn: () => api<Driver[]>(`${apiBase}/drivers`), enabled: canManage });

  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [editingHandoff, setEditingHandoff] = useState<number | null>(null);
  const [editingTime, setEditingTime] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key }),
      qc.invalidateQueries({ queryKey: ['transports', slug] }),
      qc.invalidateQueries({ queryKey: ['my-legs', slug] }),
      qc.invalidateQueries({ queryKey: ['my-requests', slug] }),
    ]);

  const act: Act = async (fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setActionError('');
    setNotice('');
    setWorking(true);
    try {
      await fn();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setWorking(false);
      await refresh();
    }
  };

  const replan = (handoffs: Place[], confirmText?: string) => act(() => api(`${apiBase}/transports/${id}/replan`, { body: { handoffs } }), confirmText);

  const myLeg = useMemo(() => t?.legs.find((l) => l.driver?.userId === t.viewer.userId && l.status !== 'done'), [t]);
  const highlight = selected ?? (canManage ? null : (myLeg?.id ?? null));

  if (isLoading) return <Spinner />;
  if (error || !t) return <ErrorNote error={error ?? 'Transport not found.'} />;

  const live = t.status !== 'cancelled' && t.status !== 'completed';
  const planning = live && t.status !== 'in_progress';
  const openCount = t.legs.filter((l) => !l.driver).length;
  const lastLeg = t.legs[t.legs.length - 1];

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t.title}</h1>
              <StatusBadge status={t.status} />
            </div>
            <p className="mt-1 text-sm text-slate-600">
              {t.origin.name} <span className="text-slate-400">→</span> {t.destination.name}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {fmtDate(t.departAt)} · leaves {fmtTime(t.departAt)}
              {lastLeg && ` · arrives about ${fmtDateTime(lastLeg.arriveAt)}`} · {formatMiles(t.distanceM)} · {t.legs.length} {t.legs.length === 1 ? 'leg' : 'legs'}
            </p>
          </div>
          {canManage && (
            <div className="no-print flex flex-wrap gap-2">
              {planning && openCount > 0 && <Button onClick={() => setRequesting(true)}>Request volunteers</Button>}
              {planning && (
                <Button variant="secondary" onClick={() => setEditingTime(toLocalInput(t.departAt))}>
                  Change start time
                </Button>
              )}
              <Button variant="secondary" onClick={() => window.print()}>
                Print itinerary
              </Button>
              {live && (
                <Button
                  variant="danger"
                  onClick={() => act(() => api(`${apiBase}/transports/${id}/cancel`, { body: {} }), 'Cancel this transport? Every driver on it will be told. This cannot be undone.')}
                >
                  Cancel transport
                </Button>
              )}
            </div>
          )}
        </div>
        {canManage && t.status === 'draft' && (
          <div className="mt-3">
            <Notice>This is a draft. Check the handoff points, then use “Request volunteers” to ask drivers to sign up for legs.</Notice>
          </div>
        )}
        {canManage && t.status === 'recruiting' && (
          <p className="mt-2 text-sm text-slate-600">
            {t.requestedCount} {t.requestedCount === 1 ? 'driver has' : 'drivers have'} been asked · {openCount} of {t.legs.length} legs still open
          </p>
        )}
      </div>

      {t.viewer.isCrew && (
        <div className="no-print flex gap-1 rounded-lg bg-slate-200/70 p-0.5 text-sm sm:w-fit">
          {(['plan', 'chat'] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setParams(name === 'chat' ? { tab: 'chat' } : {}, { replace: true })}
              className={`flex-1 rounded-md px-4 py-1.5 font-medium sm:flex-none ${tab === name ? 'bg-white shadow-sm' : 'text-slate-600'}`}
            >
              {name === 'plan' ? 'Route and legs' : 'Team chat'}
              {name === 'chat' && t.unreadMessages > 0 && tab !== 'chat' && (
                <span className="ml-1.5 rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900">{t.unreadMessages}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <ErrorNote error={actionError} />
      {notice && <Notice>{notice}</Notice>}
      {working && <p className="text-sm text-slate-500">Working…</p>}

      {tab === 'chat' && t.viewer.isCrew ? (
        <Chat transportId={t.id} myUserId={t.viewer.userId} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-4 lg:sticky lg:top-16 lg:self-start">
            <RouteMap
              legs={t.legs}
              highlightLegId={highlight}
              showLocate
              live={livePins}
              className="no-print h-72 w-full overflow-hidden rounded-xl ring-1 ring-slate-200 sm:h-96 lg:h-[28rem]"
              onMoveHandoff={
                canManage && planning
                  ? (index, point) => {
                      const h = handoffsOf(t.legs);
                      h[index] = { name: '', ...point };
                      void replan(h);
                    }
                  : undefined
              }
            />
            {canManage && planning && t.legs.length > 1 && <p className="no-print text-xs text-slate-500">Drag a numbered pin to move a handoff, or use “Choose handoff place on map” on a leg to pick a specific gas station, rest area, hotel or restaurant.</p>}
            {selected && (
              <Button variant="ghost" small className="no-print" onClick={() => setSelected(null)}>
                Show the whole route
              </Button>
            )}
            <Card>
              <h2 className="mb-2 font-semibold">Travelling</h2>
              {t.animals.length === 0 && <p className="text-sm text-slate-500">No animals listed yet.</p>}
              <ul className="space-y-2">
                {t.animals.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-2 text-sm">
                    <div>
                      <span className="font-medium">{a.name}</span>
                      <span className="text-slate-500">
                        {' '}
                        · {[a.species, a.breed, ANIMAL_SIZE_LABELS[a.size]].filter(Boolean).join(' · ')}
                      </span>
                      {a.notes && <p className="text-slate-600">{a.notes}</p>}
                    </div>
                    {canManage && live && (
                      <button
                        type="button"
                        className="no-print text-xs text-slate-400 hover:text-rose-600"
                        onClick={() => act(() => api(`${apiBase}/transports/${id}/animals/${a.id}`, { method: 'DELETE' }), `Remove ${a.name} from this transport?`)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {t.notes && (
                <>
                  <h2 className="mb-1 mt-4 font-semibold">Notes for drivers</h2>
                  <p className="whitespace-pre-wrap text-sm text-slate-700">{t.notes}</p>
                </>
              )}
              {t.coordinators[0] && (
                <p className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-slate-600">
                  <Avatar name={t.coordinators[0].name} photo={t.coordinators[0].photo} size="sm" />
                  Coordinator: <span className="font-medium text-slate-900">{t.coordinators[0].name}</span>
                  {t.coordinators[0].phone && (
                    <a href={`tel:${t.coordinators[0].phone}`} className="ml-2 text-brand-700 hover:underline">
                      {formatPhone(t.coordinators[0].phone)}
                    </a>
                  )}
                </p>
              )}
            </Card>
          </div>
          <div className="space-y-3">
            {t.legs.map((leg, i) => (
              <LegCard
                key={leg.id}
                t={t}
                leg={leg}
                index={i}
                selected={selected === leg.id}
                onSelect={() => setSelected(selected === leg.id ? null : leg.id)}
                act={act}
                roster={roster.data ?? []}
                replan={replan}
                onEditHandoff={setEditingHandoff}
                position={watching ? (positions.data?.find((p) => p.legId === leg.id) ?? null) : null}
              />
            ))}
          </div>
        </div>
      )}

      {requesting && (
        <RequestDialog
          t={t}
          onClose={() => setRequesting(false)}
          onDone={async (n) => {
            setRequesting(false);
            await refresh();
            setNotice(`Request sent to ${n} ${n === 1 ? 'driver' : 'drivers'}. Their offers will appear on each leg.`);
          }}
        />
      )}
      {editingHandoff !== null && t.legs[editingHandoff] && t.legs[editingHandoff + 1] && (
        <HandoffPicker
          legs={t.legs}
          index={editingHandoff}
          onClose={() => setEditingHandoff(null)}
          onSave={async (place) => {
            const h = handoffsOf(t.legs);
            h[editingHandoff] = place;
            // Unlike act(), let a failure reach the picker so it stays open and shows the message.
            await api(`${apiBase}/transports/${id}/replan`, { body: { handoffs: h } });
            setEditingHandoff(null);
            await refresh();
          }}
        />
      )}
      {editingTime !== null && (
        <Modal title="Change start time" onClose={() => setEditingTime(null)}>
          <div className="space-y-4">
            <Field label="Leaves the pickup place at" hint="Every leg moves by the same amount, and assigned drivers are told.">
              <Input type="datetime-local" value={editingTime} onChange={(e) => setEditingTime(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingTime(null)}>
                Cancel
              </Button>
              <Button
                disabled={!editingTime}
                onClick={async () => {
                  const departAt = new Date(editingTime).toISOString();
                  setEditingTime(null);
                  await act(() => api(`${apiBase}/transports/${id}`, { method: 'PATCH', body: { departAt } }));
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
