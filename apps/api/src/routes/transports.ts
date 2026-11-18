import {
  animalSchema,
  assignSchema,
  createTransportSchema,
  haversineM,
  legStatusSchema,
  miles,
  offerSchema,
  POSITION_MAX_AGE_MINUTES,
  positionSchema,
  replanSchema,
  requestVolunteersSchema,
  sizeRank,
  updateTransportSchema,
  type AnimalSize,
  type Leg,
  type LegPosition,
  type MyLeg,
  type Offer,
  type OpenRequest,
  type Place,
  type Suggestion,
  type TransportDetail,
  type TransportStatus,
  type TransportSummary,
} from '@petxport/shared';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { shownName, type Tx } from '../db/client.js';
import { env } from '../env.js';
import { evictUser } from '../lib/hub.js';
import {
  driverProfiles,
  legOffers,
  legPositions,
  legs,
  memberships,
  messageReads,
  messages,
  transportAnimals,
  transportRequests,
  transports,
  users,
} from '../db/schema.js';
import { HttpError, badRequest, notFound, orgCtx, parse, photoPath, requireManage, type OrgCtx } from '../lib/http.js';
import { formatWhen, notify, notifyMany, scheduleReminders } from '../notify/index.js';
import { getProvider, planRoute, planThrough, RoutingError, scheduleLegs, type PlannedLeg } from '../routing/index.js';

type TransportRow = typeof transports.$inferSelect;
type LegRow = typeof legs.$inferSelect;

/** Used when a driver has not said how far they will travel to start a leg. */
const DEFAULT_MAX_MILES = 50;

const transportUrl = (c: OrgCtx, id: string) => `/o/${c.org.slug}/transports/${id}`;

async function routed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RoutingError) throw badRequest(err.message);
    throw err;
  }
}

/** Whether a non-coordinator may see this transport: they were asked, offered, or are driving. */
async function canView(tx: Tx, c: OrgCtx, transportId: string): Promise<boolean> {
  if (c.canManage) return true;
  const [asked] = await tx
    .select({ id: transportRequests.id })
    .from(transportRequests)
    .where(and(eq(transportRequests.transportId, transportId), eq(transportRequests.userId, c.user.id)));
  if (asked) return true;
  const [driving] = await tx
    .select({ id: legs.id })
    .from(legs)
    .where(and(eq(legs.transportId, transportId), eq(legs.driverId, c.user.id)));
  return Boolean(driving);
}

/** Coordinators and the transport's assigned drivers share contact details and the chat. */
export async function isCrew(tx: Tx, c: OrgCtx, transportId: string): Promise<boolean> {
  if (c.canManage) {
    const [t] = await tx.select({ id: transports.id }).from(transports).where(eq(transports.id, transportId));
    return Boolean(t);
  }
  const [driving] = await tx
    .select({ id: legs.id })
    .from(legs)
    .where(and(eq(legs.transportId, transportId), eq(legs.driverId, c.user.id)));
  return Boolean(driving);
}

async function getTransport(tx: Tx, c: OrgCtx, id: string): Promise<TransportRow> {
  const [t] = await tx.select().from(transports).where(eq(transports.id, id));
  if (!t || !(await canView(tx, c, id))) throw notFound('Transport not found.');
  return t;
}

async function getLeg(tx: Tx, transportId: string, legId: string): Promise<LegRow> {
  // Locked until the transaction ends, so two people changing the same leg at once take turns.
  const [leg] = await tx
    .select()
    .from(legs)
    .where(and(eq(legs.id, legId), eq(legs.transportId, transportId)))
    .for('update');
  if (!leg) throw notFound('Leg not found.');
  return leg;
}

function assertEditable(t: TransportRow): void {
  if (t.status === 'cancelled' || t.status === 'completed') {
    throw badRequest(`This transport is ${t.status} and can no longer be changed.`);
  }
}

async function insertLegs(tx: Tx, c: OrgCtx, t: { id: string; departAt: Date }, planned: PlannedLeg[]): Promise<void> {
  const times = scheduleLegs(t.departAt, planned.map((l) => l.durationS), c.org.handoffBufferMinutes);
  await tx.insert(legs).values(
    planned.map((l, i) => ({
      orgId: c.org.id,
      transportId: t.id,
      seq: i + 1,
      startName: l.start.name,
      startLat: l.start.lat,
      startLng: l.start.lng,
      endName: l.end.name,
      endLat: l.end.lat,
      endLng: l.end.lng,
      distanceM: l.distanceM,
      durationS: l.durationS,
      departAt: times[i]!.departAt,
      arriveAt: times[i]!.arriveAt,
      geometry: l.geometry,
    })),
  );
}

const totals = (planned: PlannedLeg[]) => ({
  distanceM: planned.reduce((n, l) => n + l.distanceM, 0),
  durationS: planned.reduce((n, l) => n + l.durationS, 0),
});

async function crewIds(tx: Tx, transportId: string): Promise<string[]> {
  const rows = await tx.select({ driverId: legs.driverId }).from(legs).where(eq(legs.transportId, transportId));
  return [...new Set(rows.map((r) => r.driverId).filter((d): d is string => Boolean(d)))];
}

/**
 * Derives the transport's status from its legs and announces a change to
 * "scheduled". Call after anything that assigns, unassigns or progresses a leg.
 */
async function syncStatus(tx: Tx, c: OrgCtx, transportId: string): Promise<TransportStatus> {
  const [t] = await tx.select().from(transports).where(eq(transports.id, transportId));
  if (!t) throw notFound();
  if (t.status === 'cancelled' || t.status === 'completed') return t.status;
  const rows = await tx.select().from(legs).where(eq(legs.transportId, transportId));
  let next: TransportStatus = t.status;
  if (rows.length > 0 && rows.every((l) => l.status === 'done')) next = 'completed';
  else if (rows.some((l) => l.status === 'in_progress' || l.status === 'done')) next = 'in_progress';
  else if (rows.length > 0 && rows.every((l) => l.driverId)) next = 'scheduled';
  else if (t.status !== 'draft') next = 'recruiting';
  if (next !== t.status) {
    await tx.update(transports).set({ status: next }).where(eq(transports.id, transportId));
    if (next === 'scheduled') {
      await notifyMany(tx, await crewIds(tx, transportId), {
        orgId: c.org.id,
        kind: 'transport_scheduled',
        title: `All set: "${t.title}" has a driver for every leg`,
        body: `Every leg of "${t.title}" on ${formatWhen(t.departAt, c.org.timezone)} is now covered. Open the itinerary to see who you meet, where and when.`,
        url: transportUrl(c, transportId),
      });
    }
  }
  if (next === 'scheduled') await scheduleReminders(tx, c.org.id, transportId);
  return next;
}

/** Puts a driver on a leg (or takes them off with null) and settles the offers on it. */
async function setLegDriver(tx: Tx, c: OrgCtx, t: TransportRow, leg: LegRow, userId: string | null): Promise<void> {
  if (leg.status === 'in_progress' || leg.status === 'done') {
    throw badRequest('This leg has already started, so its driver cannot be changed.');
  }
  const previous = leg.driverId;
  if (previous === userId) return;
  const legLabel = `leg ${leg.seq} of "${t.title}" (${leg.startName} to ${leg.endName})`;
  await tx.update(legs).set({ driverId: userId, status: userId ? 'filled' : 'open' }).where(eq(legs.id, leg.id));

  if (previous) {
    await tx
      .update(legOffers)
      .set({ status: 'declined' })
      .where(and(eq(legOffers.legId, leg.id), eq(legOffers.userId, previous)));
    // They are no longer part of this transport's team unless they drive another of its legs.
    const [other] = await tx
      .select({ id: legs.id })
      .from(legs)
      .where(and(eq(legs.transportId, t.id), eq(legs.driverId, previous), ne(legs.id, leg.id)));
    if (!other) evictUser(previous, t.id);
    if (previous !== c.user.id) {
      await notify(tx, {
        orgId: c.org.id,
        userId: previous,
        kind: 'unassigned',
        title: `You are no longer driving a leg of "${t.title}"`,
        body: `A coordinator took you off ${legLabel}. Thank you for offering.`,
        url: transportUrl(c, t.id),
      });
    }
  }
  if (userId) {
    await tx
      .insert(legOffers)
      .values({ orgId: c.org.id, legId: leg.id, userId, status: 'accepted' })
      .onConflictDoUpdate({ target: [legOffers.legId, legOffers.userId], set: { status: 'accepted' } });
    const others = await tx
      .update(legOffers)
      .set({ status: 'declined' })
      .where(and(eq(legOffers.legId, leg.id), ne(legOffers.userId, userId), eq(legOffers.status, 'offered')))
      .returning({ userId: legOffers.userId });
    await notifyMany(
      tx,
      others.map((o) => o.userId),
      {
        orgId: c.org.id,
        kind: 'offer_declined',
        title: `Another driver is covering a leg of "${t.title}"`,
        body: `Thank you for offering to drive ${legLabel}. Another volunteer has it covered this time.`,
        url: transportUrl(c, t.id),
      },
    );
    // Make sure the driver can open the transport even if they were never formally asked.
    await tx.insert(transportRequests).values({ orgId: c.org.id, transportId: t.id, userId }).onConflictDoNothing();
    if (userId !== c.user.id) {
      await notify(tx, {
        orgId: c.org.id,
        userId,
        kind: 'assigned',
        title: `You are confirmed to drive a leg of "${t.title}"`,
        body: `You are driving ${legLabel}, leaving ${formatWhen(leg.departAt, c.org.timezone)}.`,
        url: transportUrl(c, t.id),
      });
    }
  }
}

interface Candidate {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  homeLat: number | null;
  homeLng: number | null;
  maxMiles: number | null;
  maxAnimalSize: AnimalSize | null;
}

async function activeDrivers(tx: Tx, c: OrgCtx): Promise<Candidate[]> {
  return tx
    .select({
      userId: users.id,
      name: shownName,
      email: users.email,
      phone: driverProfiles.phone,
      homeLat: driverProfiles.homeLat,
      homeLng: driverProfiles.homeLng,
      maxMiles: driverProfiles.maxMiles,
      maxAnimalSize: driverProfiles.maxAnimalSize,
    })
    .from(driverProfiles)
    .innerJoin(users, eq(users.id, driverProfiles.userId))
    .innerJoin(memberships, and(eq(memberships.userId, driverProfiles.userId), eq(memberships.orgId, driverProfiles.orgId)))
    .where(and(eq(driverProfiles.active, true), ne(memberships.status, 'disabled')))
    .orderBy(users.name);
}

const milesFromHome = (d: { homeLat: number | null; homeLng: number | null }, leg: LegRow): number | null =>
  d.homeLat == null || d.homeLng == null
    ? null
    : miles(haversineM({ lat: d.homeLat, lng: d.homeLng }, { lat: leg.startLat, lng: leg.startLng }));

/** Ranks active drivers by how close they live to the start of an open leg. */
async function suggest(tx: Tx, c: OrgCtx, transportId: string): Promise<Suggestion[]> {
  const openLegs = await tx
    .select()
    .from(legs)
    .where(and(eq(legs.transportId, transportId), eq(legs.status, 'open')));
  const animals = await tx.select({ size: transportAnimals.size }).from(transportAnimals).where(eq(transportAnimals.transportId, transportId));
  const largest = Math.max(-1, ...animals.map((a) => sizeRank(a.size)));
  const asked = new Set(
    (await tx.select({ userId: transportRequests.userId }).from(transportRequests).where(eq(transportRequests.transportId, transportId))).map(
      (r) => r.userId,
    ),
  );
  const out: Suggestion[] = (await activeDrivers(tx, c)).map((d) => {
    let best: { seq: number; miles: number } | null = null;
    for (const leg of openLegs) {
      const m = milesFromHome(d, leg);
      if (m != null && (!best || m < best.miles)) best = { seq: leg.seq, miles: m };
    }
    const fitsAnimals = !d.maxAnimalSize || sizeRank(d.maxAnimalSize) >= largest;
    return {
      userId: d.userId,
      name: d.name,
      email: d.email,
      phone: d.phone,
      legSeq: best?.seq ?? null,
      milesFromHome: best ? Math.round(best.miles) : null,
      inRange: Boolean(best && best.miles <= (d.maxMiles ?? DEFAULT_MAX_MILES) && fitsAnimals),
      alreadyRequested: asked.has(d.userId),
    };
  });
  return out.sort((a, b) => (a.milesFromHome ?? Infinity) - (b.milesFromHome ?? Infinity));
}

async function detail(tx: Tx, c: OrgCtx, id: string): Promise<TransportDetail> {
  const t = await getTransport(tx, c, id);
  const legRows = await tx.select().from(legs).where(eq(legs.transportId, id)).orderBy(asc(legs.seq));
  const crew = c.canManage || legRows.some((l) => l.driverId === c.user.id);
  const animals = await tx.select().from(transportAnimals).where(eq(transportAnimals.transportId, id)).orderBy(asc(transportAnimals.createdAt));
  const legIds = legRows.map((l) => l.id);
  const offerRows = legIds.length
    ? await tx
        .select({ offer: legOffers, name: users.name })
        .from(legOffers)
        .innerJoin(users, eq(users.id, legOffers.userId))
        .where(inArray(legOffers.legId, legIds))
        .orderBy(asc(legOffers.createdAt))
    : [];
  const peopleIds = [...new Set([t.createdBy, ...legRows.map((l) => l.driverId), ...offerRows.map((o) => o.offer.userId)])].filter(
    (p): p is string => Boolean(p),
  );
  const people = new Map(
    (
      await tx
        .select({
          id: users.id,
          name: shownName,
          photoAt: sql<Date | null>`case when ${memberships.status} = 'invited' then null else ${users.photoUpdatedAt} end`.mapWith(users.photoUpdatedAt),
          phone: driverProfiles.phone,
          homeLat: driverProfiles.homeLat,
          homeLng: driverProfiles.homeLng,
        })
        .from(users)
        .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, c.org.id)))
        .leftJoin(driverProfiles, eq(driverProfiles.userId, users.id))
        .where(inArray(users.id, peopleIds))
    ).map((p) => [p.id, p]),
  );

  const outLegs: Leg[] = legRows.map((l) => {
    const driver = l.driverId ? people.get(l.driverId) : null;
    const mine = offerRows.find((o) => o.offer.legId === l.id && o.offer.userId === c.user.id);
    const leg: Leg = {
      id: l.id,
      seq: l.seq,
      start: { name: l.startName, lat: l.startLat, lng: l.startLng },
      end: { name: l.endName, lat: l.endLat, lng: l.endLng },
      distanceM: l.distanceM,
      durationS: l.durationS,
      departAt: l.departAt.toISOString(),
      arriveAt: l.arriveAt.toISOString(),
      geometry: l.geometry,
      status: l.status,
      driver: driver ? { userId: driver.id, name: driver.name, phone: crew ? driver.phone : null, photo: photoPath(c.org.slug, driver.id, driver.photoAt) } : null,
      myOffer: mine?.offer.status ?? null,
    };
    if (c.canManage) {
      leg.offers = offerRows
        .filter((o) => o.offer.legId === l.id)
        .map((o): Offer => {
          const person = people.get(o.offer.userId);
          const m = person ? milesFromHome(person, l) : null;
          return {
            id: o.offer.id,
            userId: o.offer.userId,
            name: person?.name ?? o.name,
            phone: person?.phone ?? null,
            status: o.offer.status,
            note: o.offer.note,
            createdAt: o.offer.createdAt.toISOString(),
            milesFromHome: m == null ? null : Math.round(m),
          };
        });
    }
    return leg;
  });

  const [{ n: requestedCount } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transportRequests)
    .where(eq(transportRequests.transportId, id));
  let unreadMessages = 0;
  if (crew) {
    const [read] = await tx
      .select({ at: messageReads.lastReadAt })
      .from(messageReads)
      .where(and(eq(messageReads.transportId, id), eq(messageReads.userId, c.user.id)));
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.transportId, id), ne(messages.userId, c.user.id), gt(messages.createdAt, read?.at ?? new Date(0))));
    unreadMessages = n;
  }
  const creator = people.get(t.createdBy);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    origin: { name: t.originName, lat: t.originLat, lng: t.originLng },
    destination: { name: t.destName, lat: t.destLat, lng: t.destLng },
    departAt: t.departAt.toISOString(),
    distanceM: t.distanceM,
    durationS: t.durationS,
    notes: t.notes,
    animals: animals.map((a) => ({ id: a.id, name: a.name, species: a.species, breed: a.breed, size: a.size, notes: a.notes })),
    legs: outLegs,
    coordinators: creator ? [{ userId: creator.id, name: creator.name, phone: crew ? creator.phone : null, photo: photoPath(c.org.slug, creator.id, creator.photoAt) }] : [],
    viewer: { canManage: c.canManage, isCrew: crew, userId: c.user.id },
    requestedCount,
    unreadMessages,
  };
}

export async function transportRoutes(app: FastifyInstance): Promise<void> {
  // ----- lists -----

  app.get('/transports', async (req): Promise<TransportSummary[]> => {
    const c = orgCtx(req);
    requireManage(c);
    const rows = await c.db((tx) =>
      tx.execute<{
        id: string;
        title: string;
        status: TransportStatus;
        origin_name: string;
        dest_name: string;
        depart_at: Date;
        distance_m: number;
        duration_s: number;
        leg_count: number;
        filled_count: number;
        animal_count: number;
        pending_offers: number;
      }>(sql`
        select t.id, t.title, t.status, t.origin_name, t.dest_name, t.depart_at, t.distance_m, t.duration_s,
          (select count(*)::int from legs l where l.transport_id = t.id) as leg_count,
          (select count(*)::int from legs l where l.transport_id = t.id and l.driver_id is not null) as filled_count,
          (select count(*)::int from transport_animals a where a.transport_id = t.id) as animal_count,
          (select count(*)::int from leg_offers o join legs l on l.id = o.leg_id
             where l.transport_id = t.id and o.status = 'offered' and l.driver_id is null) as pending_offers
        from transports t
        order by t.depart_at desc
        limit 500`),
    );
    return rows.rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      originName: r.origin_name,
      destName: r.dest_name,
      departAt: new Date(r.depart_at).toISOString(),
      distanceM: r.distance_m,
      durationS: r.duration_s,
      legCount: r.leg_count,
      filledCount: r.filled_count,
      animalCount: r.animal_count,
      pendingOffers: r.pending_offers,
    }));
  });

  app.get('/my/legs', async (req): Promise<MyLeg[]> => {
    const c = orgCtx(req);
    const rows = await c.db((tx) =>
      tx
        .select({
          leg: legs,
          title: transports.title,
          transportStatus: transports.status,
          legCount: sql<number>`(select count(*)::int from legs l2 where l2.transport_id = ${transports.id})`,
        })
        .from(legs)
        .innerJoin(transports, eq(transports.id, legs.transportId))
        .where(
          and(
            eq(legs.driverId, c.user.id),
            ne(transports.status, 'cancelled'),
            gt(legs.arriveAt, new Date(Date.now() - 2 * 86400_000)),
          ),
        )
        .orderBy(asc(legs.departAt)),
    );
    return rows.map(({ leg: l, title, transportStatus, legCount }) => ({
      legId: l.id,
      transportId: l.transportId,
      transportTitle: title,
      transportStatus,
      seq: l.seq,
      legCount,
      start: { name: l.startName, lat: l.startLat, lng: l.startLng },
      end: { name: l.endName, lat: l.endLat, lng: l.endLng },
      departAt: l.departAt.toISOString(),
      arriveAt: l.arriveAt.toISOString(),
      distanceM: l.distanceM,
      durationS: l.durationS,
      status: l.status,
    }));
  });

  app.get('/my/requests', async (req): Promise<OpenRequest[]> => {
    const c = orgCtx(req);
    const rows = await c.db((tx) =>
      tx
        .select({
          transportId: transports.id,
          title: transports.title,
          departAt: transports.departAt,
          originName: transports.originName,
          destName: transports.destName,
          openLegs: sql<number>`(select count(*)::int from legs l where l.transport_id = ${transports.id} and l.driver_id is null)`,
          myOffers: sql<number>`(select count(*)::int from leg_offers o join legs l on l.id = o.leg_id
            where l.transport_id = ${transports.id} and o.user_id = ${c.user.id} and o.status = 'offered')`,
        })
        .from(transportRequests)
        .innerJoin(transports, eq(transports.id, transportRequests.transportId))
        .where(and(eq(transportRequests.userId, c.user.id), eq(transports.status, 'recruiting'), gt(transports.departAt, new Date())))
        .orderBy(asc(transports.departAt)),
    );
    return rows.filter((r) => r.openLegs > 0).map((r) => ({ ...r, departAt: r.departAt.toISOString() }));
  });

  // ----- create / read / update -----

  app.post('/transports', { config: { rateLimit: { max: env.isTest ? 100_000 : 15, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const input = parse(createTransportSchema, req.body);
    // Routing can take a while, so it happens before the database transaction opens.
    const planned = await routed(() =>
      planRoute(getProvider(), input.origin, input.destination, { miles: c.org.legTargetMiles, minutes: c.org.legTargetMinutes }),
    );
    return c.db(async (tx) => {
      const [t] = await tx
        .insert(transports)
        .values({
          orgId: c.org.id,
          title: input.title,
          originName: input.origin.name,
          originLat: input.origin.lat,
          originLng: input.origin.lng,
          destName: input.destination.name,
          destLat: input.destination.lat,
          destLng: input.destination.lng,
          departAt: new Date(input.departAt),
          notes: input.notes,
          createdBy: c.user.id,
          ...totals(planned),
        })
        .returning();
      await insertLegs(tx, c, t!, planned);
      if (input.animals.length > 0) {
        await tx.insert(transportAnimals).values(input.animals.map((a) => ({ ...a, orgId: c.org.id, transportId: t!.id })));
      }
      return { id: t!.id };
    });
  });

  app.get('/transports/:id', async (req): Promise<TransportDetail> => {
    const c = orgCtx(req);
    const { id } = req.params as { id: string };
    return c.db((tx) => detail(tx, c, id));
  });

  app.patch('/transports/:id', async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id } = req.params as { id: string };
    const input = parse(updateTransportSchema, req.body);
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const set: Partial<typeof transports.$inferInsert> = {};
      if (input.title) set.title = input.title;
      if (input.notes !== undefined) set.notes = input.notes;
      const newDepart = input.departAt ? new Date(input.departAt) : null;
      const timeChanged = newDepart && newDepart.getTime() !== t.departAt.getTime();
      if (timeChanged) {
        if (t.status === 'in_progress') throw badRequest('This transport is already under way.');
        set.departAt = newDepart;
        const rows = await tx.select().from(legs).where(eq(legs.transportId, id)).orderBy(asc(legs.seq));
        const times = scheduleLegs(newDepart, rows.map((l) => l.durationS), c.org.handoffBufferMinutes);
        for (const [i, l] of rows.entries()) await tx.update(legs).set(times[i]!).where(eq(legs.id, l.id));
        await notifyMany(tx, await crewIds(tx, id), {
          orgId: c.org.id,
          kind: 'time_changed',
          title: `New start time for "${t.title}"`,
          body: `"${t.title}" now starts ${formatWhen(newDepart, c.org.timezone)}. Open the itinerary to see the new time for your leg.`,
          url: transportUrl(c, id),
        });
      }
      if (Object.keys(set).length > 0) await tx.update(transports).set(set).where(eq(transports.id, id));
      if (timeChanged && t.status === 'scheduled') await scheduleReminders(tx, c.org.id, id);
      return { ok: true };
    });
  });

  app.post('/transports/:id/cancel', async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id } = req.params as { id: string };
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      await tx.update(transports).set({ status: 'cancelled' }).where(eq(transports.id, id));
      await tx.delete(legPositions).where(eq(legPositions.transportId, id));
      const offering = await tx
        .select({ userId: legOffers.userId })
        .from(legOffers)
        .innerJoin(legs, eq(legs.id, legOffers.legId))
        .where(and(eq(legs.transportId, id), eq(legOffers.status, 'offered')));
      await notifyMany(tx, [...(await crewIds(tx, id)), ...offering.map((o) => o.userId)].filter((u) => u !== c.user.id), {
        orgId: c.org.id,
        kind: 'transport_cancelled',
        title: `Cancelled: "${t.title}"`,
        body: `The transport "${t.title}" planned for ${formatWhen(t.departAt, c.org.timezone)} has been cancelled. Thank you for volunteering.`,
        url: transportUrl(c, id),
      });
      return { ok: true };
    });
  });

  /** Re-routes through a new set of handoff points. */
  app.post('/transports/:id/replan', { config: { rateLimit: { max: env.isTest ? 100_000 : 30, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id } = req.params as { id: string };
    const { handoffs } = parse(replanSchema, req.body);
    const before = await c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      if (t.status === 'in_progress') throw badRequest('This transport is already under way.');
      // A pin dropped back where it was (or a repeated save) changes nothing: no re-routing, no notices to drivers.
      const current = await tx.select().from(legs).where(eq(legs.transportId, id)).orderBy(asc(legs.seq));
      const same =
        handoffs.length === current.length - 1 &&
        handoffs.every((h, i) => {
          const end = current[i]!;
          return haversineM(h, { lat: end.endLat, lng: end.endLng }) < 30 && (h.name === '' || h.name === end.endName);
        });
      return same ? null : { ...t, legCount: current.length };
    });
    if (!before) return { ok: true, unchanged: true };
    const origin: Place = { name: before.originName, lat: before.originLat, lng: before.originLng };
    const destination: Place = { name: before.destName, lat: before.destLat, lng: before.destLng };
    const planned = await routed(async () => {
      const named: Place[] = [];
      for (const [i, h] of handoffs.entries()) {
        let name = h.name;
        if (!name) {
          const label = await getProvider().reverseGeocode(h).catch(() => null);
          name = label ? `Near ${label}` : `Handoff ${i + 1}`;
        }
        named.push({ ...h, name });
      }
      return planThrough(getProvider(), origin, destination, named);
    });
    return c.db(async (tx) => {
      // Routing took a few seconds outside any transaction. Take the transport's row lock and check again,
      // so a cancellation, a started leg or another coordinator's re-plan in the meantime is respected.
      await tx.select({ id: transports.id }).from(transports).where(eq(transports.id, id)).for('update');
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const existing = await tx.select().from(legs).where(eq(legs.transportId, id)).orderBy(asc(legs.seq));
      if (t.status === 'in_progress' || existing.some((l) => l.status === 'in_progress' || l.status === 'done')) {
        throw badRequest('This transport is already under way.');
      }
      if (existing.length !== before.legCount) throw new HttpError(409, 'Someone else just changed the legs of this transport. Reload and try again.');
      const times = scheduleLegs(t.departAt, planned.map((l) => l.durationS), c.org.handoffBufferMinutes);
      if (existing.length === planned.length) {
        // Same number of legs: keep each leg's driver and offers, just move its ends.
        for (const [i, l] of planned.entries()) {
          await tx
            .update(legs)
            .set({
              startName: l.start.name,
              startLat: l.start.lat,
              startLng: l.start.lng,
              endName: l.end.name,
              endLat: l.end.lat,
              endLng: l.end.lng,
              distanceM: l.distanceM,
              durationS: l.durationS,
              geometry: l.geometry,
              ...times[i]!,
            })
            .where(eq(legs.id, existing[i]!.id));
        }
        await notifyMany(tx, (await crewIds(tx, id)).filter((u) => u !== c.user.id), {
          orgId: c.org.id,
          kind: 'route_changed',
          title: `Handoff details changed for "${t.title}"`,
          body: `A coordinator changed the handoff points or times for "${t.title}". Please check your leg.`,
          url: transportUrl(c, id),
        });
      } else {
        // A different number of legs cannot be matched to the old ones, so drivers are released,
        // and people with an offer waiting are told theirs no longer stands.
        const offering = await tx
          .select({ userId: legOffers.userId })
          .from(legOffers)
          .innerJoin(legs, eq(legs.id, legOffers.legId))
          .where(and(eq(legs.transportId, id), eq(legOffers.status, 'offered')));
        await notifyMany(tx, [...(await crewIds(tx, id)), ...offering.map((o) => o.userId)].filter((u) => u !== c.user.id), {
          orgId: c.org.id,
          kind: 'unassigned',
          title: `The legs of "${t.title}" were re-planned`,
          body: `A coordinator changed the number of legs on "${t.title}", so existing driver assignments and offers were cleared. Please open the transport and offer again for a leg that suits you.`,
          url: transportUrl(c, id),
        });
        await tx.delete(legs).where(eq(legs.transportId, id));
        await insertLegs(tx, c, t, planned);
      }
      await tx.update(transports).set(totals(planned)).where(eq(transports.id, id));
      await syncStatus(tx, c, id);
      return { ok: true };
    });
  });

  // ----- animals -----

  app.post('/transports/:id/animals', async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id } = req.params as { id: string };
    const input = parse(animalSchema, req.body);
    return c.db(async (tx) => {
      assertEditable(await getTransport(tx, c, id));
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(transportAnimals).where(eq(transportAnimals.transportId, id));
      if (n >= 50) throw badRequest('A transport can list at most 50 animals.');
      const [a] = await tx.insert(transportAnimals).values({ ...input, orgId: c.org.id, transportId: id }).returning({ id: transportAnimals.id });
      return { id: a!.id };
    });
  });

  app.delete('/transports/:id/animals/:animalId', async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id, animalId } = req.params as { id: string; animalId: string };
    await c.db((tx) => tx.delete(transportAnimals).where(and(eq(transportAnimals.id, animalId), eq(transportAnimals.transportId, id))));
    return { ok: true };
  });

  // ----- recruiting -----

  app.get('/transports/:id/suggestions', async (req): Promise<Suggestion[]> => {
    const c = orgCtx(req);
    requireManage(c);
    const { id } = req.params as { id: string };
    return c.db(async (tx) => {
      await getTransport(tx, c, id);
      return suggest(tx, c, id);
    });
  });

  app.post('/transports/:id/request-volunteers', { config: { rateLimit: { max: env.isTest ? 100_000 : 10, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id } = req.params as { id: string };
    const input = parse(requestVolunteersSchema, req.body);
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const candidates = await suggest(tx, c, id);
      let chosen: Suggestion[];
      if (input.audience === 'all') chosen = candidates;
      else if (input.audience === 'suggested') chosen = candidates.filter((s) => s.inRange);
      else {
        const wanted = new Set(input.audience);
        chosen = candidates.filter((s) => wanted.has(s.userId));
      }
      if (chosen.length === 0) throw badRequest('No active drivers match that selection.');
      const openLegs = await tx
        .select()
        .from(legs)
        .where(and(eq(legs.transportId, id), eq(legs.status, 'open')))
        .orderBy(asc(legs.seq));
      if (openLegs.length === 0) throw badRequest('Every leg already has a driver.');
      await tx
        .insert(transportRequests)
        .values(chosen.map((s) => ({ orgId: c.org.id, transportId: id, userId: s.userId })))
        .onConflictDoNothing();
      if (t.status === 'draft') await tx.update(transports).set({ status: 'recruiting' }).where(eq(transports.id, id));
      const legLines = openLegs
        .slice(0, 12)
        .map((l) => `  Leg ${l.seq}: ${l.startName} to ${l.endName}, ${Math.round(miles(l.distanceM))} mi, leaves ${formatWhen(l.departAt, c.org.timezone)}`)
        .join('\n');
      const more = openLegs.length > 12 ? `\n  …and ${openLegs.length - 12} more` : '';
      await notifyMany(
        tx,
        chosen.map((s) => s.userId),
        {
          orgId: c.org.id,
          kind: 'volunteer_request',
          title: `Drivers needed: "${t.title}"`,
          body: `${c.user.name} is looking for volunteer drivers for "${t.title}" (${t.originName} to ${t.destName}).${input.message ? `\n\n"${input.message}"` : ''}\n\nOpen legs:\n${legLines}${more}\n\nOpen the link to pick a leg you can drive.`,
          url: transportUrl(c, id),
        },
      );
      return { requested: chosen.length };
    });
  });

  // ----- offers and assignment -----

  app.post('/transports/:id/legs/:legId/offers', { config: { rateLimit: { max: env.isTest ? 100_000 : 20, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    const { id, legId } = req.params as { id: string; legId: string };
    const input = parse(offerSchema, req.body);
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const leg = await getLeg(tx, id, legId);
      if (leg.driverId) throw badRequest('This leg already has a driver.');
      const [existing] = await tx
        .select({ status: legOffers.status })
        .from(legOffers)
        .where(and(eq(legOffers.legId, legId), eq(legOffers.userId, c.user.id)));
      await tx
        .insert(legOffers)
        .values({ orgId: c.org.id, legId, userId: c.user.id, note: input.note, status: 'offered' })
        .onConflictDoUpdate({ target: [legOffers.legId, legOffers.userId], set: { status: 'offered', note: input.note } });
      if (existing?.status !== 'offered' && t.createdBy !== c.user.id) {
        await notify(tx, {
          orgId: c.org.id,
          userId: t.createdBy,
          kind: 'offer_received',
          dedupeMinutes: 60,
          title: `${c.user.name} offered to drive leg ${leg.seq} of "${t.title}"`,
          body: `${c.user.name} can drive leg ${leg.seq} (${leg.startName} to ${leg.endName}).${input.note ? ` Note: "${input.note}"` : ''} Open the transport to confirm them.`,
          url: transportUrl(c, id),
        });
      }
      return { ok: true };
    });
  });

  /** A driver takes back their offer, or steps down from a leg they were confirmed for. */
  app.delete('/transports/:id/legs/:legId/offers/mine', { config: { rateLimit: { max: env.isTest ? 100_000 : 20, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    const { id, legId } = req.params as { id: string; legId: string };
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const leg = await getLeg(tx, id, legId);
      if (leg.driverId === c.user.id) {
        if (leg.status !== 'filled') throw badRequest('This leg has already started.');
        await tx.update(legs).set({ driverId: null, status: 'open' }).where(eq(legs.id, legId));
        const [other] = await tx
          .select({ id: legs.id })
          .from(legs)
          .where(and(eq(legs.transportId, id), eq(legs.driverId, c.user.id), ne(legs.id, legId)));
        if (!other && !c.canManage) evictUser(c.user.id, id);
        if (t.createdBy !== c.user.id) {
          await notify(tx, {
            orgId: c.org.id,
            userId: t.createdBy,
            kind: 'driver_withdrew',
            dedupeMinutes: 60,
            title: `${c.user.name} can no longer drive leg ${leg.seq} of "${t.title}"`,
            body: `Leg ${leg.seq} (${leg.startName} to ${leg.endName}) is open again and needs a driver.`,
            url: transportUrl(c, id),
          });
        }
      }
      await tx
        .update(legOffers)
        .set({ status: 'withdrawn' })
        .where(and(eq(legOffers.legId, legId), eq(legOffers.userId, c.user.id)));
      await syncStatus(tx, c, id);
      return { ok: true };
    });
  });

  app.post('/transports/:id/offers/:offerId/accept', async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id, offerId } = req.params as { id: string; offerId: string };
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const [offer] = await tx.select().from(legOffers).where(eq(legOffers.id, offerId));
      if (!offer) throw notFound('Offer not found.');
      if (offer.status === 'withdrawn') throw badRequest('That driver withdrew their offer.');
      const leg = await getLeg(tx, id, offer.legId);
      await setLegDriver(tx, c, t, leg, offer.userId);
      return { status: await syncStatus(tx, c, id) };
    });
  });

  app.post('/transports/:id/legs/:legId/assign', async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { id, legId } = req.params as { id: string; legId: string };
    const { userId } = parse(assignSchema, req.body);
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const leg = await getLeg(tx, id, legId);
      if (userId) {
        const [member] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(and(eq(memberships.orgId, c.org.id), eq(memberships.userId, userId), ne(memberships.status, 'disabled')));
        if (!member) throw badRequest('That person is not an active member of this organization.');
      }
      await setLegDriver(tx, c, t, leg, userId);
      return { status: await syncStatus(tx, c, id) };
    });
  });

  /** The leg's driver (or a coordinator) marks it started or finished. */
  app.post('/transports/:id/legs/:legId/status', { config: { rateLimit: { max: env.isTest ? 100_000 : 20, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    const { id, legId } = req.params as { id: string; legId: string };
    const { status } = parse(legStatusSchema, req.body);
    return c.db(async (tx) => {
      const t = await getTransport(tx, c, id);
      assertEditable(t);
      const leg = await getLeg(tx, id, legId);
      if (!c.canManage && leg.driverId !== c.user.id) throw notFound('Leg not found.');
      if (!leg.driverId) throw badRequest('This leg has no driver yet.');
      if (t.status === 'draft') throw badRequest('This transport has not been announced yet.');
      if (leg.status === status) return { status: t.status };
      // Forward one step at a time: confirmed -> on the road -> handed off.
      const forward = (leg.status === 'filled' && status === 'in_progress') || (leg.status === 'in_progress' && status === 'done');
      // Only a coordinator can step back, to correct a mistake.
      const back = c.canManage && ((leg.status === 'in_progress' && status === 'filled') || (leg.status === 'done' && status === 'in_progress'));
      if (!forward && !back) throw badRequest('That change is not possible from the leg\'s current state.');
      if (!c.canManage && status === 'in_progress' && leg.departAt.getTime() - Date.now() > 12 * 3600_000) {
        throw badRequest('This leg is not due to start yet.');
      }
      await tx.update(legs).set({ status }).where(eq(legs.id, legId));
      // Sharing is for the drive itself: it ends with the handoff, and nothing is kept.
      if (status !== 'in_progress') await tx.delete(legPositions).where(eq(legPositions.legId, legId));
      const next = await syncStatus(tx, c, id);
      if (status === 'done') {
        const [following] = await tx
          .select()
          .from(legs)
          .where(and(eq(legs.transportId, id), eq(legs.seq, leg.seq + 1)));
        const tell = [t.createdBy, following?.driverId].filter((u): u is string => Boolean(u) && u !== c.user.id);
        await notifyMany(tx, tell, {
          orgId: c.org.id,
          kind: 'leg_done',
          dedupeMinutes: 60,
          title: `Leg ${leg.seq} of "${t.title}" is complete`,
          body: following
            ? `The handoff at ${leg.endName} is done. Leg ${following.seq} is next.`
            : `The last leg has arrived at ${leg.endName}. Transport complete!`,
          url: transportUrl(c, id),
        });
      }
      return { status: next };
    });
  });

  // ----- live location -----

  /** Where the animal is on the legs that are under way. For coordinators and this transport's drivers only. */
  app.get('/transports/:id/positions', async (req): Promise<LegPosition[]> => {
    const c = orgCtx(req);
    const { id } = req.params as { id: string };
    return c.db(async (tx) => {
      await getTransport(tx, c, id);
      if (!(await isCrew(tx, c, id))) return [];
      const rows = await tx
        .select({ p: legPositions })
        .from(legPositions)
        .innerJoin(legs, eq(legs.id, legPositions.legId))
        .where(
          and(
            eq(legPositions.transportId, id),
            eq(legs.status, 'in_progress'),
            gt(legPositions.recordedAt, new Date(Date.now() - POSITION_MAX_AGE_MINUTES * 60_000)),
          ),
        );
      return rows.map(({ p }) => ({ legId: p.legId, lat: p.lat, lng: p.lng, accuracyM: p.accuracyM, at: p.recordedAt.toISOString() }));
    });
  });

  /** The leg's driver reports where they are. Only while the leg is under way, and only if they chose to share. */
  app.put('/transports/:id/legs/:legId/position', { config: { rateLimit: { max: env.isTest ? 100_000 : 30, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    const { id, legId } = req.params as { id: string; legId: string };
    const input = parse(positionSchema, req.body);
    return c.db(async (tx) => {
      await getTransport(tx, c, id);
      const leg = await getLeg(tx, id, legId);
      if (leg.driverId !== c.user.id) throw notFound('Leg not found.');
      if (leg.status !== 'in_progress') throw badRequest('Location can be shared from pickup until the handoff.');
      const values = { lat: input.lat, lng: input.lng, accuracyM: input.accuracyM == null ? null : Math.round(input.accuracyM), recordedAt: new Date() };
      await tx
        .insert(legPositions)
        .values({ legId, orgId: c.org.id, transportId: id, userId: c.user.id, ...values })
        .onConflictDoUpdate({ target: legPositions.legId, set: { userId: c.user.id, ...values } });
      return { ok: true };
    });
  });

  /** The driver stops sharing; the position is removed straight away. */
  app.delete('/transports/:id/legs/:legId/position', async (req) => {
    const c = orgCtx(req);
    const { id, legId } = req.params as { id: string; legId: string };
    await c.db((tx) => tx.delete(legPositions).where(and(eq(legPositions.legId, legId), eq(legPositions.transportId, id), eq(legPositions.userId, c.user.id))));
    return { ok: true };
  });
}
