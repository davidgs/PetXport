import {
  acceptInviteSchema,
  createOrgSchema,
  forgotSchema,
  loginSchema,
  resetSchema,
  signupSchema,
  verifySchema,
  type Me,
  type OrgSummary,
} from '@petxport/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { globalDb, withOrg, withUser, type Tx } from '../db/client.js';
import { driverProfiles, memberships, organizations, pushSubscriptions, users } from '../db/schema.js';
import { env, features } from '../env.js';
import {
  consumeAuthToken,
  createAuthToken,
  clearLoginFailures,
  endAllSessions,
  endSession,
  findAuthToken,
  hashPassword,
  loginLockedMinutes,
  recentTokenCount,
  recordLoginFailure,
  revokeLinks,
  startSession,
  verifyPassword,
} from '../lib/auth.js';
import { HttpError, badRequest, forbidden, notFound, parse, requireUser } from '../lib/http.js';
import { enqueue } from '../lib/jobs.js';
import { beginTwoFactor } from './security.js';

const authLimit = { config: { rateLimit: { max: env.isTest ? 10_000 : 10, timeWindow: '1 minute' } } };

/** The opt-in box is only shown while this server can send texts, so it only counts then. */
const wantsTexts = (optIn: boolean | undefined): boolean => Boolean(optIn) && features.sms;

/**
 * Puts the number (and the text-message choice) someone gave when creating their account into
 * their driver profile for an organization they are joining as a driver. `explicit` means they
 * just filled in the form; otherwise the account's stored answers are used and nothing a
 * profile already holds is overwritten.
 */
async function carryPhoneToProfile(
  tx: Tx,
  orgId: string,
  userId: string,
  role: string,
  given: { phone: string | null; smsOptIn: boolean; explicit: boolean },
): Promise<void> {
  if (role !== 'driver' || !given.phone) return;
  const [existing] = await tx
    .select({ id: driverProfiles.id, phone: driverProfiles.phone })
    .from(driverProfiles)
    .where(and(eq(driverProfiles.orgId, orgId), eq(driverProfiles.userId, userId)));
  const values = { phone: given.phone, notifySms: given.smsOptIn };
  if (!existing) await tx.insert(driverProfiles).values({ ...values, orgId, userId });
  else if (given.explicit || !existing.phone) await tx.update(driverProfiles).set(values).where(eq(driverProfiles.id, existing.id));
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const MAX_LINKS_PER_HOUR = 3;

  async function sendVerification(user: { id: string; email: string; name: string }): Promise<void> {
    if ((await recentTokenCount(user.id, 'verify')) >= MAX_LINKS_PER_HOUR) return;
    const token = await createAuthToken(user.id, 'verify', { ttlHours: 24 });
    await enqueue(globalDb, 'email', {
      to: user.email,
      subject: 'Confirm your email for PetXport',
      text: `Hi ${user.name},\n\nSomeone, hopefully you, created a PetXport account with this email address. Open this link and enter the password you chose to finish. It works for 24 hours.\n\n${env.appUrl}/verify/${token}\n\nIf this was not you, ignore this email and nothing will happen.`,
    });
  }

  /**
   * Always answers the same way, so it cannot be used to find out who has an
   * account. The account is unusable until its owner opens the emailed link
   * AND re-enters the password, so registering someone else's address gains nothing.
   */
  app.post('/api/auth/signup', authLimit, async (req) => {
    const input = parse(signupSchema, req.body);
    const [existing] = await globalDb.select().from(users).where(eq(users.email, input.email));
    if (existing?.emailVerifiedAt) {
      if ((await recentTokenCount(existing.id, 'verify')) < MAX_LINKS_PER_HOUR) {
        // Recorded as a link so the cap above also applies to this notice.
        await createAuthToken(existing.id, 'verify', { ttlHours: 0 });
        await enqueue(globalDb, 'email', {
          to: existing.email,
          subject: 'You already have a PetXport account',
          text: `Hi ${existing.name},\n\nSomeone tried to create a PetXport account with this email address, but you already have one. If it was you, log in here, or use "Forgot your password?" on that page:\n\n${env.appUrl}/login\n\nIf it was not you, there is nothing you need to do.`,
        });
      }
      return { ok: true };
    }
    const passwordHash = await hashPassword(input.password);
    const contact = { contactPhone: input.phone, smsConsentAt: wantsTexts(input.smsOptIn) ? new Date() : null };
    let user = existing;
    if (existing) {
      // Never verified: at most a roster entry or an abandoned sign-up. The pending password is replaced.
      await globalDb.update(users).set({ passwordHash, ...contact }).where(eq(users.id, existing.id));
    } else {
      [user] = await globalDb.insert(users).values({ name: input.name, email: input.email, passwordHash, ...contact }).returning();
    }
    await sendVerification(user!);
    return { ok: true };
  });

  app.post('/api/auth/verify', authLimit, async (req, reply) => {
    const input = parse(verifySchema, req.body);
    const token = await findAuthToken(input.token, 'verify');
    if (!token) throw badRequest('This confirmation link has expired or was already used. Sign up again to get a new one.');
    const [user] = await globalDb.select().from(users).where(eq(users.id, token.userId));
    // Whoever clicks the link must also know the password that was chosen at sign-up.
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new HttpError(401, 'That is not the password this account was created with. If you did not sign up, you can ignore the email.');
    }
    if (!(await consumeAuthToken(token.id))) throw badRequest('This confirmation link was already used.');
    await globalDb.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
    await startSession(reply, user.id);
    return { ok: true };
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const locked = loginLockedMinutes(input.email);
    if (locked > 0) throw new HttpError(429, `Too many attempts for this account. Try again in ${locked} minutes, or reset your password.`);
    const [user] = await globalDb.select().from(users).where(eq(users.email, input.email));
    if (!(await verifyPassword(user?.passwordHash ?? null, input.password)) || !user) {
      recordLoginFailure(input.email);
      throw new HttpError(401, 'That email and password do not match.');
    }
    if (!user.emailVerifiedAt) {
      // Only reachable with the right password, so this does not reveal anything to a stranger.
      await sendVerification(user);
      throw new HttpError(403, 'Please confirm your email first. We have sent you a new link.');
    }
    clearLoginFailures(input.email);
    // With two-step sign-in on, the password alone opens nothing: a code is sent and the browser asks for it.
    if (user.twoFactor !== 'off') return { twoFactor: await beginTwoFactor(user) };
    await startSession(reply, user.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const body = (req.body ?? {}) as { pushEndpoint?: unknown };
    // On a shared computer the next person must not receive this user's notifications.
    if (req.user && typeof body.pushEndpoint === 'string') {
      await globalDb
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.endpoint, body.pushEndpoint.slice(0, 1000)), eq(pushSubscriptions.userId, req.user.id)));
    }
    await endSession(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/forgot', authLimit, async (req) => {
    const { email } = parse(forgotSchema, req.body);
    const [user] = await globalDb.select().from(users).where(eq(users.email, email));
    if (user && (await recentTokenCount(user.id, 'reset')) < MAX_LINKS_PER_HOUR) {
      const token = await createAuthToken(user.id, 'reset', { ttlHours: 2 });
      await enqueue(globalDb, 'email', {
        to: user.email,
        subject: 'Reset your PetXport password',
        text: `Hi ${user.name},\n\nUse this link to choose a new password. It works for 2 hours.\n\n${env.appUrl}/reset/${token}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    }
    // Same answer either way, so this cannot be used to discover who has an account.
    return { ok: true };
  });

  app.post('/api/auth/reset', authLimit, async (req, reply) => {
    const input = parse(resetSchema, req.body);
    const token = await findAuthToken(input.token, 'reset');
    if (!token) throw badRequest('This reset link has expired or was already used.');
    const [user] = await globalDb.select().from(users).where(eq(users.id, token.userId));
    if (!user) throw badRequest('This reset link has expired or was already used.');
    if (!(await consumeAuthToken(token.id))) throw badRequest('This reset link has expired or was already used.');
    // Receiving the link proves the address, so this also verifies it.
    await globalDb
      .update(users)
      .set({ passwordHash: await hashPassword(input.password), emailVerifiedAt: user.emailVerifiedAt ?? new Date() })
      .where(eq(users.id, user.id));
    await revokeLinks(user.id, ['reset', 'verify']);
    clearLoginFailures(user.email);
    await endAllSessions(user.id);
    // A reset proves control of the mailbox only. With two-step sign-in on, they still log in the usual way.
    if (user.twoFactor !== 'off') return { ok: true, loginRequired: true };
    await startSession(reply, user.id);
    return { ok: true, loginRequired: false };
  });

  app.get('/api/me', async (req): Promise<Me> => {
    const user = requireUser(req);
    const rows = await withUser(user.id, (tx) =>
      tx
        .select({
          id: organizations.id,
          slug: organizations.slug,
          name: organizations.name,
          role: memberships.role,
          status: memberships.status,
        })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(and(eq(memberships.userId, user.id), isNull(organizations.disabledAt)))
        .orderBy(organizations.name),
    );
    const orgs: OrgSummary[] = rows.filter((r) => r.status !== 'disabled');
    return { user, orgs, allowOrgSignup: env.allowOrgSignup || user.isPlatformAdmin };
  });

  app.patch('/api/me', async (req) => {
    const user = requireUser(req);
    const { name } = parse(signupSchema.pick({ name: true }), req.body);
    await globalDb.update(users).set({ name }).where(eq(users.id, user.id));
    return { ok: true };
  });

  // ----- organizations -----

  app.post('/api/orgs', async (req) => {
    const user = requireUser(req);
    if (!env.allowOrgSignup && !user.isPlatformAdmin) {
      throw forbidden('Creating new organizations is turned off on this server.');
    }
    const input = parse(createOrgSchema, req.body);
    const [taken] = await globalDb.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, input.slug));
    if (taken) throw new HttpError(409, 'That web address is already taken. Try another.');
    const [org] = await globalDb
      .insert(organizations)
      .values({ name: input.name, slug: input.slug, ...(input.timezone ? { timezone: input.timezone } : {}) })
      .returning();
    await withOrg(org!.id, user.id, (tx) =>
      tx.insert(memberships).values({ orgId: org!.id, userId: user.id, role: 'admin', status: 'active' }),
    );
    return { slug: org!.slug };
  });

  /** Accept an invitation while logged in (from the organization picker). */
  app.post('/api/orgs/:orgId/accept', async (req) => {
    const user = requireUser(req);
    const { orgId } = req.params as { orgId: string };
    const [org] = await globalDb.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org || org.disabledAt) throw notFound('No invitation found.');
    const [account] = await globalDb
      .select({ contactPhone: users.contactPhone, smsConsentAt: users.smsConsentAt })
      .from(users)
      .where(eq(users.id, user.id));
    const updated = await withOrg(orgId, user.id, async (tx) => {
      const rows = await tx
        .update(memberships)
        .set({ status: 'active' })
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, user.id), eq(memberships.status, 'invited')))
        .returning({ id: memberships.id, role: memberships.role });
      if (rows[0]) {
        await carryPhoneToProfile(tx, orgId, user.id, rows[0].role, {
          phone: account?.contactPhone ?? null,
          smsOptIn: Boolean(account?.smsConsentAt),
          explicit: false,
        });
      }
      return rows;
    });
    if (updated.length === 0) throw notFound('No invitation found.');
    return { ok: true };
  });

  // ----- emailed invitations -----

  async function loadInvite(rawToken: string) {
    const token = await findAuthToken(rawToken, 'invite');
    if (!token?.inviteOrgId) throw notFound('This invitation has expired or was already used. Ask your coordinator for a new one.');
    const [user] = await globalDb.select().from(users).where(eq(users.id, token.userId));
    const [org] = await globalDb.select().from(organizations).where(eq(organizations.id, token.inviteOrgId));
    if (!user || !org || org.disabledAt) throw notFound();
    const [membership] = await withOrg(org.id, user.id, (tx) =>
      tx
        .select({ role: memberships.role, status: memberships.status, displayName: memberships.displayName })
        .from(memberships)
        .where(and(eq(memberships.orgId, org.id), eq(memberships.userId, user.id))),
    );
    // Removed from the organization since the invitation was sent.
    if (!membership || membership.status === 'disabled') throw notFound('This invitation is no longer valid. Ask your coordinator for a new one.');
    // An account that already has a confirmed password is not signed in by an invitation link.
    const established = Boolean(user.passwordHash && user.emailVerifiedAt);
    return { token, user, org, membership, established };
  }

  app.get('/api/invites/:token', authLimit, async (req) => {
    const { user, org, membership, established } = await loadInvite((req.params as { token: string }).token);
    return {
      orgName: org.name,
      orgSlug: org.slug,
      email: user.email,
      name: established ? user.name : (membership.displayName ?? user.name),
      role: membership.role,
      needsPassword: !established,
    };
  });

  app.post('/api/invites/:token/accept', authLimit, async (req, reply) => {
    const { token, user, org, membership, established } = await loadInvite((req.params as { token: string }).token);
    const input = parse(acceptInviteSchema, req.body);
    if (!established && !input.password) throw badRequest('Choose a password to finish setting up your account.');
    if (!established && !input.phone) throw badRequest('Enter your phone number to finish setting up your account.');
    if (!(await consumeAuthToken(token.id))) throw notFound('This invitation was already used.');
    if (!established) {
      await globalDb
        .update(users)
        .set({
          passwordHash: await hashPassword(input.password!),
          emailVerifiedAt: new Date(),
          name: input.name ?? membership.displayName ?? user.name,
          contactPhone: input.phone!,
          smsConsentAt: wantsTexts(input.smsOptIn) ? new Date() : null,
        })
        .where(eq(users.id, user.id));
      // Anyone who had set a password on this address without proving they own it is signed out.
      await endAllSessions(user.id);
    }
    // Someone who already has an account is not asked again here; their stored answers are used.
    const given = established
      ? { phone: user.contactPhone, smsOptIn: Boolean(user.smsConsentAt), explicit: false }
      : { phone: input.phone!, smsOptIn: wantsTexts(input.smsOptIn), explicit: true };
    await withOrg(org.id, user.id, async (tx) => {
      await tx
        .update(memberships)
        .set({ status: 'active' })
        .where(and(eq(memberships.orgId, org.id), eq(memberships.userId, user.id), eq(memberships.status, 'invited')));
      await carryPhoneToProfile(tx, org.id, user.id, membership.role, given);
    });
    // A brand-new account is signed in (the link proved the address and they just chose the password).
    // An existing account must log in as usual: a forwarded or leaked invitation must not open it.
    if (!established) await startSession(reply, user.id);
    return { slug: org.slug, role: membership.role, loginRequired: established };
  });
}
