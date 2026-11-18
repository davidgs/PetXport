import { formatDuration, formatMiles, type MyLeg, type OpenRequest, type TransportSummary } from '@petxport/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Badge, Button, Card, Empty, Notice, PageTitle, Spinner, StatusBadge } from '../components/ui';
import { api, useOrg, useOrgPath } from '../lib/api';
import { fmtDateTime } from '../lib/format';

function MyLegs() {
  const { slug, apiBase, base } = useOrgPath();
  const { data } = useQuery({ queryKey: ['my-legs', slug], queryFn: () => api<MyLeg[]>(`${apiBase}/my/legs`) });
  if (!data || data.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Your legs</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.map((l) => (
          <Link key={l.legId} to={`${base}/transports/${l.transportId}`}>
            <Card className="h-full transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{l.transportTitle}</p>
                <Badge tone={l.status === 'done' ? 'slate' : l.status === 'in_progress' ? 'blue' : 'green'}>
                  {l.status === 'done' ? 'Done' : l.status === 'in_progress' ? 'On the road' : `Leg ${l.seq} of ${l.legCount}`}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {l.start.name} <span className="text-slate-400">→</span> {l.end.name}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {fmtDateTime(l.departAt)} · {formatMiles(l.distanceM)} · {formatDuration(l.durationS)}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

function OpenRequests({ showEmpty }: { showEmpty: boolean }) {
  const { slug, apiBase, base } = useOrgPath();
  const { data } = useQuery({ queryKey: ['my-requests', slug], queryFn: () => api<OpenRequest[]>(`${apiBase}/my/requests`) });
  if (!data) return null;
  if (data.length === 0) {
    return showEmpty ? (
      <section className="mb-8">
        <Empty>No transports need drivers right now. You will get a notification when one does.</Empty>
      </section>
    ) : null;
  }
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Drivers needed</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {data.map((r) => (
          <Link key={r.transportId} to={`${base}/transports/${r.transportId}`}>
            <Card className="h-full border-l-4 border-l-amber-400 transition-shadow hover:shadow-md">
              <p className="font-medium">{r.title}</p>
              <p className="mt-1 text-sm text-slate-700">
                {r.originName} <span className="text-slate-400">→</span> {r.destName}
              </p>
              <p className="mt-1 text-sm text-slate-500">{fmtDateTime(r.departAt)}</p>
              <p className="mt-2 text-sm font-medium text-amber-800">
                {r.openLegs} open {r.openLegs === 1 ? 'leg' : 'legs'}
                {r.myOffers > 0 && <span className="font-normal text-slate-500"> · you offered for {r.myOffers}</span>}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Transports() {
  const { slug, apiBase, base } = useOrgPath();
  const [showPast, setShowPast] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['transports', slug], queryFn: () => api<TransportSummary[]>(`${apiBase}/transports`) });
  if (isLoading) return <Spinner />;
  const isPast = (t: TransportSummary) => t.status === 'completed' || t.status === 'cancelled';
  const current = (data ?? []).filter((t) => !isPast(t)).reverse();
  const past = (data ?? []).filter(isPast);
  const list = showPast ? past : current;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Transports</h2>
        <div className="flex gap-1 rounded-lg bg-slate-200/70 p-0.5 text-sm">
          {[false, true].map((p) => (
            <button key={String(p)} type="button" onClick={() => setShowPast(p)} className={`rounded-md px-3 py-1 font-medium ${showPast === p ? 'bg-white shadow-sm' : 'text-slate-600'}`}>
              {p ? `Past (${past.length})` : `Current (${current.length})`}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <Empty>{showPast ? 'No completed or cancelled transports yet.' : 'No transports planned. Create one to split a route into legs and ask for drivers.'}</Empty>
      ) : (
        <div className="space-y-3">
          {list.map((t) => (
            <Link key={t.id} to={`${base}/transports/${t.id}`} className="block">
              <Card className="transition-shadow hover:shadow-md">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">{t.title}</p>
                  <div className="flex gap-1.5">
                    {t.pendingOffers > 0 && <Badge tone="amber">{t.pendingOffers} to review</Badge>}
                    <StatusBadge status={t.status} />
                  </div>
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {t.originName} <span className="text-slate-400">→</span> {t.destName}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                  <span>{fmtDateTime(t.departAt)}</span>
                  <span>{formatMiles(t.distanceM)}</span>
                  <span>
                    {t.animalCount} {t.animalCount === 1 ? 'animal' : 'animals'}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200">
                      <span className="block h-full bg-brand-600" style={{ width: `${t.legCount ? (t.filledCount / t.legCount) * 100 : 0}%` }} />
                    </span>
                    {t.filledCount}/{t.legCount} legs covered
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function Home() {
  const org = useOrg();
  const { base } = useOrgPath();
  const canManage = org.data?.role !== 'driver';
  const [params] = useSearchParams();
  return (
    <>
      {params.has('welcome') && canManage && (
        <div className="mb-4">
          <Notice>
            Welcome to {org.data?.name}! Start by inviting your volunteers on the <Link to={`${base}/drivers`} className="font-medium underline">Drivers</Link> page, add coordinators in{' '}
            <Link to={`${base}/settings`} className="font-medium underline">Settings</Link>, then plan your first transport.
          </Notice>
        </div>
      )}
      <PageTitle title={canManage ? 'Transports' : 'Home'}>
        {canManage && (
          <Link to={`${base}/transports/new`}>
            <Button>New transport</Button>
          </Link>
        )}
      </PageTitle>
      <MyLegs />
      <OpenRequests showEmpty={!canManage} />
      {canManage && <Transports />}
    </>
  );
}
