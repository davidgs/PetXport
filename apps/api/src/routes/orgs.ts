import {
  inviteMemberSchema,
  logoSchema,
  MAX_LOGO_BYTES,
  orgSettingsSchema,
  placeSchema,
  pushSubscriptionSchema,
  stopsQuerySchema,
  updateMemberSchema,
  type AppNotification,
  type Member,
  type OrgDetail,
  type Stop,
} from '@petxport/shared';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { globalDb, shownName, type Tx } from '../db/client.js';
import { authTokens, orgLogos, legOffers, legs, memberships, notifications, organizations, pushSubscriptions, transports, userPhotos, users } from '../db/schema.js';
import { env, features } from '../env.js';
import { createAuthToken } from '../lib/auth.js';
import { HttpError, badRequest, notFound, orgCtx, parse, photoPath, requireAdmin, requireManage, type OrgCtx } from '../lib/http.js';
import { evictUser } from '../lib/hub.js';
import { enqueue } from '../lib/jobs.js';
import { findStops, getProvider, RoutingError } from '../routing/index.js';

/** Finds or creates the account for an email address and gives it a membership in this organization. */
export async function addMember(
  tx: Tx,
  c: OrgCtx,
  input: { name: string; email: string; role: 'admin' | 'coordinator' | 'driver' },
): Promise<{ userId: string; created: boolean }> {
  let [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email));
  if (!user) {
    [user] = await tx.insert(users).values({ name: input.name, email: input.email }).returning({ id: users.id });
  }
  const inserted = await tx
    .insert(memberships)
    .values({ orgId: c.org.id, userId: user!.id, role: input.role, status: 'invited', displayName: input.name })
    .onConflictDoNothing()
    .returning({ id: memberships.id });
  return { userId: user!.id, created: inserted.length > 0 };
}

/** Emails a link that lets the person set a password (if needed) and join the organization. */
export async function sendInvite(tx: Tx, c: OrgCtx, userId: string): Promise<void> {
  const [user] = await tx
    .select({ email: users.email, name: shownName })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, c.org.id)))
    .where(eq(users.id, userId));
  if (!user) return;
  const [sent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(authTokens)
    .where(and(eq(authTokens.inviteOrgId, c.org.id), gt(authTokens.createdAt, new Date(Date.now() - 86400_000))));
  if ((sent?.n ?? 0) >= env.invitesDailyLimitPerOrg) {
    throw new HttpError(429, 'This organization has reached its daily limit for invitation emails. Try again tomorrow.');
  }
  const token = await createAuthToken(userId, 'invite', { inviteOrgId: c.org.id, ttlHours: 24 * 14, db: tx });
  await enqueue(tx, 'email', {
    to: user.email,
    subject: `${c.user.name} invited you to ${c.org.name} on PetXport`,
    text: `Hi ${user.name},\n\n${c.user.name} added you to ${c.org.name}'s volunteer transport team on PetXport, where transports are planned and drivers sign up for legs.\n\nUse this link to join. It works for 14 days.\n\n${env.appUrl}/invite/${token}`,
  });
}

/**
 * Works out what an upload really is from its first bytes. Only plain bitmap formats are
 * accepted: SVG and HTML can carry scripts, so they are never stored or served.
 */
export function sniffImage(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Sends a stored picture so that it can only ever be shown as an image. */
export function sendPhoto(reply: FastifyReply, photo: { contentType: string; data: Buffer }): FastifyReply {
  return reply
    .header('Content-Type', photo.contentType)
    .header('Content-Length', photo.data.length)
    // If opened directly it can run nothing and load nothing.
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .header('Content-Disposition', 'inline; filename="photo"')
    .header('Cache-Control', 'private, max-age=31536000, immutable')
    .send(photo.data);
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req): Promise<OrgDetail> => {
    const c = orgCtx(req);
    const [logo] = await c.db((tx) => tx.select({ updatedAt: orgLogos.updatedAt }).from(orgLogos).where(eq(orgLogos.orgId, c.org.id)));
    return {
      id: c.org.id,
      slug: c.org.slug,
      name: c.org.name,
      legTargetMiles: c.org.legTargetMiles,
      legTargetMinutes: c.org.legTargetMinutes,
      handoffBufferMinutes: c.org.handoffBufferMinutes,
      timezone: c.org.timezone,
      // The version in the address changes with each upload, so browsers can cache it for good.
      logoUrl: logo ? `/api/o/${c.org.slug}/logo?v=${logo.updatedAt.getTime()}` : null,
      role: c.role,
      features: { ...features, vapidPublicKey: features.push ? env.vapidPublicKey : null },
    };
  });

  app.patch('/', async (req) => {
    const c = orgCtx(req);
    requireAdmin(c);
    const input = parse(orgSettingsSchema, req.body);
    if (Object.keys(input).length > 0) {
      await globalDb.update(organizations).set(input).where(eq(organizations.id, c.org.id));
    }
    return { ok: true };
  });

  // ----- logo -----

  app.get('/logo', async (req, reply) => {
    const c = orgCtx(req);
    const [logo] = await c.db((tx) => tx.select().from(orgLogos).where(eq(orgLogos.orgId, c.org.id)));
    if (!logo) throw notFound();
    return reply
      .header('Content-Type', logo.contentType)
      .header('Content-Length', logo.data.length)
      // Shown only as an image; if opened directly it can run nothing and load nothing.
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', 'inline; filename="logo"')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(logo.data);
  });

  app.put('/logo', { config: { rateLimit: { max: env.isTest ? 100_000 : 10, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireAdmin(c);
    const data = Buffer.from(parse(logoSchema, req.body).data, 'base64');
    if (data.length > MAX_LOGO_BYTES) throw badRequest('That image is too large. Use one under 300 KB.');
    const contentType = sniffImage(data);
    if (!contentType) throw badRequest('Use a PNG, JPEG or WebP image.');
    await c.db((tx) =>
      tx
        .insert(orgLogos)
        .values({ orgId: c.org.id, contentType, data })
        .onConflictDoUpdate({ target: orgLogos.orgId, set: { contentType, data, updatedAt: new Date() } }),
    );
    return { ok: true };
  });

  app.delete('/logo', async (req) => {
    const c = orgCtx(req);
    requireAdmin(c);
    await c.db((tx) => tx.delete(orgLogos).where(eq(orgLogos.orgId, c.org.id)));
    return { ok: true };
  });

  app.get('/members', async (req): Promise<Member[]> => {
    const c = orgCtx(req);
    requireManage(c);
    const rows = await c.db((tx) =>
      tx
        .select({ userId: users.id, name: shownName, photoAt: users.photoUpdatedAt, email: users.email, role: memberships.role, status: memberships.status })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, c.org.id))
        .orderBy(users.name),
    );
    return rows.map(({ photoAt, ...m }) => ({ ...m, photo: m.status === 'invited' ? null : photoPath(c.org.slug, m.userId, photoAt) }));
  });

  // ----- people's pictures -----

  /** A member's picture, for anyone in the same organization. */
  app.get('/people/:userId/photo', async (req, reply) => {
    const c = orgCtx(req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    const [member] = await c.db((tx) =>
      tx
        .select({ id: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.orgId, c.org.id), eq(memberships.userId, userId), eq(memberships.status, 'active'))),
    );
    if (!member) throw notFound();
    const [photo] = await globalDb.select().from(userPhotos).where(eq(userPhotos.userId, userId));
    if (!photo) throw notFound();
    return sendPhoto(reply, photo);
  });

  app.post('/members', { config: { rateLimit: { max: env.isTest ? 100_000 : 20, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const input = parse(inviteMemberSchema, req.body);
    if (input.role !== 'driver') requireAdmin(c);
    return c.db(async (tx) => {
      const { userId, created } = await addMember(tx, c, input);
      if (!created) throw new HttpError(409, 'That person is already a member of this organization.');
      await sendInvite(tx, c, userId);
      return { userId };
    });
  });

  app.post('/members/:userId/invite', { config: { rateLimit: { max: env.isTest ? 100_000 : 20, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { userId } = req.params as { userId: string };
    return c.db(async (tx) => {
      const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, c.org.id), eq(memberships.userId, userId)));
      if (!m) throw notFound();
      if (m.status !== 'invited') throw badRequest('That person has already joined.');
      await sendInvite(tx, c, userId);
      return { ok: true };
    });
  });

  app.patch('/members/:userId', async (req) => {
    const c = orgCtx(req);
    requireAdmin(c);
    const { userId } = req.params as { userId: string };
    const input = parse(updateMemberSchema, req.body);
    return c.db(async (tx) => {
      const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, c.org.id), eq(memberships.userId, userId)));
      if (!m) throw notFound();
      const losesAdmin = m.role === 'admin' && ((input.role && input.role !== 'admin') || input.status === 'disabled');
      if (losesAdmin) {
        // Locked, so two admins demoting each other at the same moment cannot leave none.
        const admins = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(and(eq(memberships.orgId, c.org.id), eq(memberships.role, 'admin'), eq(memberships.status, 'active')))
          .for('update');
        if (admins.length <= 1) throw badRequest('An organization needs at least one active admin.');
      }
      const set: Partial<typeof memberships.$inferInsert> = {};
      if (input.role) set.role = input.role;
      // Re-enabling someone who never accepted puts them back to "invited".
      if (input.status === 'disabled') set.status = 'disabled';
      else if (input.status === 'active' && m.status === 'disabled') set.status = 'active';
      if (Object.keys(set).length > 0) await tx.update(memberships).set(set).where(eq(memberships.id, m.id));
      if (set.status === 'disabled') {
        // Someone removed from the organization is taken off every leg that has not started,
        // their open offers are withdrawn, and any chat they have open stops updating.
        const freed = await tx
          .update(legs)
          .set({ driverId: null, status: 'open' })
          .where(and(eq(legs.driverId, userId), eq(legs.status, 'filled')))
          .returning({ id: legs.id, transportId: legs.transportId });
        await tx
          .update(legOffers)
          .set({ status: 'withdrawn' })
          .where(and(eq(legOffers.userId, userId), inArray(legOffers.status, ['offered', 'accepted'])));
        if (freed.length > 0) {
          await tx
            .update(transports)
            .set({ status: 'recruiting' })
            .where(and(inArray(transports.id, [...new Set(freed.map((f) => f.transportId))]), eq(transports.status, 'scheduled')));
        }
        evictUser(userId);
      }
      return { ok: true };
    });
  });

  // ----- address search -----

  app.get('/geocode', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    orgCtx(req);
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 3) return [];
    try {
      return await getProvider().geocode(q.slice(0, 200));
    } catch (err) {
      if (err instanceof RoutingError) throw badRequest(err.message);
      throw err;
    }
  });

  /** "Town, State" for a point on the map, used to label a handoff the coordinator clicked. */
  app.get('/reverse-geocode', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const point = parse(placeSchema.pick({ lat: true, lng: true }), {
      lat: Number((req.query as { lat?: string }).lat),
      lng: Number((req.query as { lng?: string }).lng),
    });
    const label = await getProvider().reverseGeocode(point).catch(() => null);
    return { label };
  });

  /** Candidate handoff places (gas stations, rest areas, hotels, restaurants) in a map area. */
  app.get('/stops', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req): Promise<Stop[]> => {
    const c = orgCtx(req);
    requireManage(c);
    const bounds = parse(stopsQuerySchema, req.query);
    try {
      return await findStops(bounds);
    } catch (err) {
      if (err instanceof RoutingError) throw badRequest(err.message);
      throw err;
    }
  });

  // ----- in-app notifications -----

  app.get('/notifications', async (req): Promise<AppNotification[]> => {
    const c = orgCtx(req);
    const rows = await c.db((tx) =>
      tx
        .select()
        .from(notifications)
        .where(eq(notifications.userId, c.user.id))
        .orderBy(desc(notifications.createdAt))
        .limit(50),
    );
    return rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      url: n.url,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
    }));
  });

  app.post('/notifications/read', async (req) => {
    const c = orgCtx(req);
    await c.db((tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, c.user.id), isNull(notifications.readAt))),
    );
    return { ok: true };
  });

  // ----- web push -----

  app.post('/push/subscribe', async (req) => {
    const c = orgCtx(req);
    const input = parse(pushSubscriptionSchema, req.body);
    await globalDb
      .insert(pushSubscriptions)
      .values({ userId: c.user.id, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: c.user.id, p256dh: input.keys.p256dh, auth: input.keys.auth },
      });
    return { ok: true };
  });

  app.post('/push/unsubscribe', async (req) => {
    const c = orgCtx(req);
    const { endpoint } = parse(pushSubscriptionSchema.pick({ endpoint: true }), req.body);
    await globalDb
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, c.user.id)));
    return { ok: true };
  });
}
