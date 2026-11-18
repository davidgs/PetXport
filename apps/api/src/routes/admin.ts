import { adminOrgUpdateSchema, inviteOrgSchema, type AdminOrg } from '@petxport/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { globalDb, shownName, withOrg, type Tx } from '../db/client.js';
import { memberships, organizations, users } from '../db/schema.js';
import { env } from '../env.js';
import { createAuthToken } from '../lib/auth.js';
import { HttpError, badRequest, notFound, parse, requirePlatformAdmin, type OrgRow, type SessionUser } from '../lib/http.js';
import { evictOrg } from '../lib/hub.js';
import { enqueue } from '../lib/jobs.js';

/**
 * Platform ("super") admin area: create rescue organizations and invite the
 * person who will run each one.
 *
 * A platform admin is not a member of the organizations they create. They can
 * see who administers an organization and how large it is, but its drivers,
 * transports and messages stay behind the same row-level security as for
 * everyone else.
 */

async function sendOrgInvite(tx: Tx, inviter: SessionUser, org: OrgRow, userId: string): Promise<void> {
  const [user] = await tx
    .select({ email: users.email, name: shownName })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, org.id)))
    .where(eq(users.id, userId));
  if (!user) return;
  const token = await createAuthToken(userId, 'invite', { inviteOrgId: org.id, ttlHours: 24 * 30, db: tx });
  await enqueue(tx, 'email', {
    to: user.email,
    subject: `${org.name} is set up on PetXport`,
    text:
      `Hi ${user.name},\n\n${inviter.name} has set up a private space for ${org.name} on PetXport, a tool for planning volunteer pet transports: ` +
      `keep your list of drivers, split a route into legs, ask volunteers to sign up, and keep everyone on a transport in touch.\n\n` +
      `You are its administrator. Use this link to choose a password and get started. It works for 30 days.\n\n${env.appUrl}/invite/${token}\n\n` +
      `Once you are in, invite your drivers and coordinators from the Drivers and Settings pages. Nobody outside ${org.name} can see your data.`,
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/orgs', async (req): Promise<AdminOrg[]> => {
    requirePlatformAdmin(req);
    const orgs = await globalDb.select().from(organizations).orderBy(organizations.name);
    const out: AdminOrg[] = [];
    for (const org of orgs) {
      // Counts and admin contacts only; each organization is read inside its own scope.
      const info = await withOrg(org.id, null, async (tx) => {
        const admins = await tx
          .select({ name: shownName, email: users.email, status: memberships.status })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.orgId, org.id), eq(memberships.role, 'admin')))
          .orderBy(users.name);
        const counts = await tx.execute<{ members: number; drivers: number; transports: number }>(sql`
          select (select count(*)::int from memberships where status <> 'disabled') as members,
                 (select count(*)::int from driver_profiles) as drivers,
                 (select count(*)::int from transports) as transports`);
        return { admins, counts: counts.rows[0]! };
      });
      out.push({
        id: org.id,
        slug: org.slug,
        name: org.name,
        createdAt: org.createdAt.toISOString(),
        suspended: Boolean(org.disabledAt),
        admins: info.admins,
        memberCount: info.counts.members,
        driverCount: info.counts.drivers,
        transportCount: info.counts.transports,
      });
    }
    return out;
  });

  /** Creates the organization and emails its first administrator a link to take it over. */
  app.post('/api/admin/orgs', { config: { rateLimit: { max: env.isTest ? 100_000 : 20, timeWindow: '1 minute' } } }, async (req) => {
    const inviter = requirePlatformAdmin(req);
    const input = parse(inviteOrgSchema, req.body);
    const [taken] = await globalDb.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, input.slug));
    if (taken) throw new HttpError(409, 'That web address is already taken. Try another.');
    return globalDb.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.name, slug: input.slug, ...(input.timezone ? { timezone: input.timezone } : {}) })
        .returning();
      let [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.adminEmail));
      if (!user) {
        [user] = await tx.insert(users).values({ name: input.adminName, email: input.adminEmail }).returning({ id: users.id });
      }
      await tx.execute(sql`select set_config('app.org_id', ${org!.id}, true), set_config('app.user_id', ${user!.id}, true)`);
      await tx.insert(memberships).values({ orgId: org!.id, userId: user!.id, role: 'admin', status: 'invited', displayName: input.adminName });
      await sendOrgInvite(tx, inviter, org!, user!.id);
      return { id: org!.id, slug: org!.slug };
    });
  });

  /** Sends a fresh link to every administrator who has not accepted yet. */
  app.post('/api/admin/orgs/:orgId/invite', async (req) => {
    const inviter = requirePlatformAdmin(req);
    const { orgId } = req.params as { orgId: string };
    const [org] = await globalDb.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw notFound();
    const sent = await withOrg(org.id, null, async (tx) => {
      const pending = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.orgId, org.id), eq(memberships.role, 'admin'), eq(memberships.status, 'invited')));
      for (const p of pending) await sendOrgInvite(tx, inviter, org, p.userId);
      return pending.length;
    });
    if (sent === 0) throw badRequest('Every administrator of this organization has already joined.');
    return { sent };
  });

  /** Suspend or restore an organization. Nothing is deleted. */
  app.patch('/api/admin/orgs/:orgId', async (req) => {
    requirePlatformAdmin(req);
    const { orgId } = req.params as { orgId: string };
    const { suspended } = parse(adminOrgUpdateSchema, req.body);
    const updated = await globalDb
      .update(organizations)
      .set({ disabledAt: suspended ? new Date() : null })
      .where(eq(organizations.id, orgId))
      .returning({ id: organizations.id });
    if (updated.length === 0) throw notFound();
    if (suspended) evictOrg(orgId);
    return { ok: true };
  });
}
