import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { globalDb } from '../db/client.js';
import { authChallenges, authTokens, sessions, users } from '../db/schema.js';
import { env } from '../env.js';
import { disconnectUser } from './hub.js';

const SESSION_COOKIE = 'petxport_session';
const SESSION_DAYS = 30;

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const hashPassword = (password: string) => hash(password);

// Checked when there is no account (or no password), so a wrong email takes as long as a wrong password.
const dummyHash = hash('petxport-no-such-account');

export async function verifyPassword(passwordHash: string | null, password: string): Promise<boolean> {
  try {
    const ok = await verify(passwordHash ?? (await dummyHash), password);
    return ok && passwordHash !== null;
  } catch {
    return false;
  }
}

// ----- sign-in throttling, per email address (the per-IP limit is set on the routes) -----

const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

/** Minutes until sign-in may be tried again for this address, or 0. */
export function loginLockedMinutes(email: string): number {
  const f = failures.get(email);
  if (!f || f.resetAt < Date.now()) return 0;
  return f.count >= MAX_FAILURES ? Math.ceil((f.resetAt - Date.now()) / 60_000) : 0;
}

export function recordLoginFailure(email: string): void {
  const now = Date.now();
  if (failures.size > 50_000) {
    for (const [key, f] of failures) if (f.resetAt < now) failures.delete(key);
    if (failures.size > 50_000) failures.clear();
  }
  const f = failures.get(email);
  if (!f || f.resetAt < now) failures.set(email, { count: 1, resetAt: now + LOCK_MS });
  else f.count++;
}

export const clearLoginFailures = (email: string) => failures.delete(email);

/** Used by tests. */
export const resetLoginThrottle = () => failures.clear();

export async function startSession(reply: FastifyReply, userId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await globalDb.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.appUrl.startsWith('https://'),
    expires: expiresAt,
  });
}

export async function endSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await globalDb.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function endAllSessions(userId: string): Promise<void> {
  await globalDb.delete(sessions).where(eq(sessions.userId, userId));
  disconnectUser(userId);
}

export async function userFromRequest(req: FastifyRequest) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const [row] = await globalDb
    .select({ id: users.id, name: users.name, email: users.email, isPlatformAdmin: users.isPlatformAdmin, photoAt: users.photoUpdatedAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()), isNotNull(users.emailVerifiedAt)));
  if (!row) return null;
  return {
    ...row,
    isPlatformAdmin: row.isPlatformAdmin || env.platformAdminEmails.includes(row.email),
    photo: row.photoAt ? `/api/me/photo?v=${row.photoAt.getTime()}` : null,
  };
}

export async function createAuthToken(
  userId: string,
  kind: 'invite' | 'reset' | 'verify',
  opts: { inviteOrgId?: string; ttlHours: number; db?: Pick<typeof globalDb, 'insert'> },
): Promise<string> {
  const token = newToken();
  // Pass the open transaction when the user row was created in it and is not committed yet.
  await (opts.db ?? globalDb).insert(authTokens).values({
    tokenHash: hashToken(token),
    userId,
    kind,
    inviteOrgId: opts.inviteOrgId ?? null,
    expiresAt: new Date(Date.now() + opts.ttlHours * 3600_000),
  });
  return token;
}

export async function findAuthToken(token: string, kind: 'invite' | 'reset' | 'verify') {
  const [row] = await globalDb
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.kind, kind),
        isNull(authTokens.usedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

/** Marks a link used. False means someone else used it first (two requests racing with one link). */
export async function consumeAuthToken(id: string): Promise<boolean> {
  const rows = await globalDb
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.id, id), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id });
  return rows.length === 1;
}

/** After a password change, older reset and confirmation links for the account stop working. */
export async function revokeLinks(userId: string, kinds: ('reset' | 'verify')[]): Promise<void> {
  for (const kind of kinds) {
    await globalDb
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(authTokens.userId, userId), eq(authTokens.kind, kind), isNull(authTokens.usedAt)));
  }
}

/** How many links of this kind were emailed to the user in the last hour; used to cap repeat emails. */
export async function recentTokenCount(userId: string, kind: 'invite' | 'reset' | 'verify'): Promise<number> {
  const [row] = await globalDb
    .select({ n: sql<number>`count(*)::int` })
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.kind, kind), gt(authTokens.createdAt, new Date(Date.now() - 3600_000))));
  return row?.n ?? 0;
}

/** Housekeeping: expired sessions and long-dead links. */
export async function purgeExpired(): Promise<void> {
  await globalDb.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  await globalDb.delete(authTokens).where(or(lt(authTokens.expiresAt, weekAgo), lt(authTokens.usedAt, weekAgo)));
  await globalDb.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date(Date.now() - 3600_000)));
}
