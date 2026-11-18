import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  MAX_PHOTO_BYTES,
  otpResendSchema,
  photoSchema,
  otpVerifySchema,
  passkeyLoginSchema,
  passkeyRegisterSchema,
  passwordConfirmSchema,
  twoFactorSetupSchema,
  type SecuritySettings,
  type TwoFactorStep,
} from '@petxport/shared';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { globalDb } from '../db/client.js';
import { authChallenges, passkeys, userPhotos, users } from '../db/schema.js';
import { env, features } from '../env.js';
import { clearLoginFailures, startSession, verifyPassword } from '../lib/auth.js';
import { HttpError, badRequest, notFound, parse, requireUser } from '../lib/http.js';
import { enqueue } from '../lib/jobs.js';
import { normalizePhone, sendSms } from '../notify/sms.js';
import { sendPhoto, sniffImage } from './orgs.js';

type UserRow = typeof users.$inferSelect;
type Channel = 'email' | 'sms';

const CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 8;
const limit = (max: number) => ({ config: { rateLimit: { max: env.isTest ? 100_000 : max, timeWindow: '1 minute' } } });

/** The "relying party" a passkey is bound to: this site's host name. Passkeys never work on any other site. */
const rpID = new URL(env.appOrigin).hostname;

const hashCode = (challengeId: string, code: string) => createHash('sha256').update(`${challengeId}:${code}`).digest('hex');

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}
const maskPhone = (phone: string) => `•••• ${phone.replace(/\D/g, '').slice(-4)}`;

async function deliverCode(user: UserRow, channel: Channel, code: string, phone?: string): Promise<void> {
  if (channel === 'sms') {
    const to = phone ?? user.phone;
    if (!to || !features.sms) throw badRequest('Text messages are not available. Use email instead.');
    await sendSms(to, `Your PetXport code is ${code}. It works for ${CODE_MINUTES} minutes. Never share it with anyone.`);
    return;
  }
  await enqueue(globalDb, 'email', {
    to: user.email,
    subject: 'Your PetXport sign-in code',
    text: `Hi ${user.name},\n\nYour code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you did not just try to sign in, someone else knows your password: change it from "Forgot your password?" on the log-in page.\n\nPetXport will never ask you for this code by phone or email.`,
  });
}

/** Creates and sends a code. `kind` separates signing in from switching two-step sign-in on. */
async function issueCode(
  user: UserRow,
  kind: 'otp_login' | 'otp_setup',
  channel: Channel,
  data: { method?: Channel; phone?: string } = {},
): Promise<string> {
  const [recent] = await globalDb
    .select({ n: sql<number>`count(*)::int` })
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.userId, user.id),
        inArray(authChallenges.kind, ['otp_login', 'otp_setup']),
        gt(authChallenges.createdAt, new Date(Date.now() - 3600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) throw new HttpError(429, 'Too many codes have been requested for this account. Try again in an hour.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const [row] = await globalDb
    .insert(authChallenges)
    .values({ userId: user.id, kind, secret: 'pending', data: { channel, ...data }, expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) })
    .returning({ id: authChallenges.id });
  await globalDb.update(authChallenges).set({ secret: hashCode(row!.id, code) }).where(eq(authChallenges.id, row!.id));
  await deliverCode(user, channel, code, data.phone);
  return row!.id;
}

/** Checks a code. Each wrong guess is counted, and the code dies after a few. */
async function checkCode(challengeId: string, kind: 'otp_login' | 'otp_setup', code: string) {
  const [row] = await globalDb
    .update(authChallenges)
    .set({ attempts: sql`${authChallenges.attempts} + 1` })
    .where(and(eq(authChallenges.id, challengeId), eq(authChallenges.kind, kind), isNull(authChallenges.usedAt), gt(authChallenges.expiresAt, new Date())))
    .returning();
  const expired = new HttpError(400, 'That code has expired. Ask for a new one.');
  if (!row || !row.userId) throw expired;
  if (row.attempts > MAX_CODE_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
  const given = Buffer.from(hashCode(challengeId, code));
  const wanted = Buffer.from(row.secret);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new HttpError(401, 'That code is not right. Check it and try again.');
  const used = await globalDb
    .update(authChallenges)
    .set({ usedAt: new Date() })
    .where(and(eq(authChallenges.id, challengeId), isNull(authChallenges.usedAt)))
    .returning({ id: authChallenges.id });
  if (used.length === 0) throw expired;
  return row as typeof row & { userId: string };
}

/** Called once the password is right: sends the code and tells the browser what to ask for. */
export async function beginTwoFactor(user: UserRow, preferred?: Channel): Promise<TwoFactorStep> {
  const wantsSms = user.twoFactor === 'sms' && Boolean(user.phone) && features.sms;
  const channel: Channel = preferred === 'email' || !wantsSms ? 'email' : 'sms';
  const challengeId = await issueCode(user, 'otp_login', channel);
  return {
    challengeId,
    channel,
    sentTo: channel === 'sms' ? maskPhone(user.phone!) : maskEmail(user.email),
    // The address is already how a forgotten password is recovered, so it can always stand in for the phone.
    canUseEmail: channel === 'sms',
  };
}

async function loadUser(id: string): Promise<UserRow> {
  const [user] = await globalDb.select().from(users).where(eq(users.id, id));
  if (!user) throw notFound();
  return user;
}

/** Changing how the account is protected needs the password again, not just an open session. */
async function confirmPassword(userId: string, password: string): Promise<UserRow> {
  const user = await loadUser(userId);
  if (!(await verifyPassword(user.passwordHash, password))) throw new HttpError(401, 'That password is not right.');
  return user;
}

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  // ----- finishing sign-in with a code -----

  app.post('/api/auth/2fa', limit(10), async (req, reply) => {
    const input = parse(otpVerifySchema, req.body);
    const challenge = await checkCode(input.challengeId, 'otp_login', input.code);
    const user = await loadUser(challenge.userId);
    clearLoginFailures(user.email);
    await startSession(reply, user.id);
    return { ok: true };
  });

  /** A fresh code, optionally by email when the phone is not to hand. Needs the reference from the password step. */
  app.post('/api/auth/2fa/resend', limit(5), async (req): Promise<{ twoFactor: TwoFactorStep }> => {
    const input = parse(otpResendSchema, req.body);
    const [old] = await globalDb
      .update(authChallenges)
      .set({ usedAt: new Date() })
      .where(and(eq(authChallenges.id, input.challengeId), eq(authChallenges.kind, 'otp_login'), isNull(authChallenges.usedAt), gt(authChallenges.expiresAt, new Date())))
      .returning();
    if (!old?.userId) throw badRequest('That sign-in attempt has expired. Start again from the log-in page.');
    return { twoFactor: await beginTwoFactor(await loadUser(old.userId), input.channel) };
  });

  // ----- settings -----

  // ----- your own picture -----

  app.get('/api/me/photo', async (req, reply) => {
    const user = requireUser(req);
    const [photo] = await globalDb.select().from(userPhotos).where(eq(userPhotos.userId, user.id));
    if (!photo) throw notFound();
    return sendPhoto(reply, photo);
  });

  app.put('/api/me/photo', limit(10), async (req) => {
    const user = requireUser(req);
    const data = Buffer.from(parse(photoSchema, req.body).data, 'base64');
    if (data.length > MAX_PHOTO_BYTES) throw badRequest('That picture is too large. Use one under 200 KB.');
    const contentType = sniffImage(data);
    if (!contentType) throw badRequest('Use a PNG, JPEG or WebP image.');
    await globalDb.transaction(async (tx) => {
      await tx.insert(userPhotos).values({ userId: user.id, contentType, data }).onConflictDoUpdate({ target: userPhotos.userId, set: { contentType, data } });
      await tx.update(users).set({ photoUpdatedAt: new Date() }).where(eq(users.id, user.id));
    });
    return { ok: true };
  });

  app.delete('/api/me/photo', async (req) => {
    const user = requireUser(req);
    await globalDb.transaction(async (tx) => {
      await tx.delete(userPhotos).where(eq(userPhotos.userId, user.id));
      await tx.update(users).set({ photoUpdatedAt: null }).where(eq(users.id, user.id));
    });
    return { ok: true };
  });

  app.get('/api/me/security', async (req): Promise<SecuritySettings> => {
    const me = requireUser(req);
    const user = await loadUser(me.id);
    const keys = await globalDb.select().from(passkeys).where(eq(passkeys.userId, me.id)).orderBy(desc(passkeys.createdAt));
    return {
      twoFactor: user.twoFactor,
      phoneHint: user.phone ? maskPhone(user.phone) : null,
      smsAvailable: features.sms,
      passkeys: keys.map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null })),
    };
  });

  /** Step 1 of switching two-step sign-in on: prove the code actually arrives. */
  app.post('/api/me/2fa/setup', limit(5), async (req) => {
    const me = requireUser(req);
    const input = parse(twoFactorSetupSchema, req.body);
    const user = await confirmPassword(me.id, input.password);
    let phone: string | undefined;
    if (input.method === 'sms') {
      if (!features.sms) throw badRequest('Text messages are not set up on this server. Use email instead.');
      phone = normalizePhone(input.phone ?? '');
      if (!/^\+\d{10,15}$/.test(phone)) throw badRequest('Enter a mobile number with its area code.');
    }
    const challengeId = await issueCode(user, 'otp_setup', input.method, { method: input.method, phone });
    return { challengeId, sentTo: input.method === 'sms' ? maskPhone(phone!) : maskEmail(user.email) };
  });

  app.post('/api/me/2fa/confirm', limit(10), async (req) => {
    const me = requireUser(req);
    const input = parse(otpVerifySchema, req.body);
    const challenge = await checkCode(input.challengeId, 'otp_setup', input.code);
    if (challenge.userId !== me.id || !challenge.data?.method) throw badRequest('That code has expired. Ask for a new one.');
    await globalDb
      .update(users)
      .set({ twoFactor: challenge.data.method, ...(challenge.data.method === 'sms' ? { phone: challenge.data.phone } : {}) })
      .where(eq(users.id, me.id));
    return { ok: true };
  });

  app.post('/api/me/2fa/disable', limit(5), async (req) => {
    const me = requireUser(req);
    await confirmPassword(me.id, parse(passwordConfirmSchema, req.body).password);
    await globalDb.update(users).set({ twoFactor: 'off' }).where(eq(users.id, me.id));
    return { ok: true };
  });

  // ----- passkeys -----

  app.post('/api/me/passkeys/options', limit(10), async (req) => {
    const me = requireUser(req);
    const user = await confirmPassword(me.id, parse(passwordConfirmSchema, req.body).password);
    const existing = await globalDb.select().from(passkeys).where(eq(passkeys.userId, me.id));
    if (existing.length >= 10) throw badRequest('You can have up to 10 passkeys. Remove one first.');
    const options = await generateRegistrationOptions({
      rpName: 'PetXport',
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.credentialId, transports: k.transports ?? undefined })),
      // Stored on the device and unlocked with its fingerprint, face or PIN, so it can sign in without a password.
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const [row] = await globalDb
      .insert(authChallenges)
      .values({ userId: me.id, kind: 'passkey_register', secret: options.challenge, expiresAt: new Date(Date.now() + 5 * 60_000) })
      .returning({ id: authChallenges.id });
    return { challengeId: row!.id, options };
  });

  app.post('/api/me/passkeys', limit(10), async (req) => {
    const me = requireUser(req);
    const input = parse(passkeyRegisterSchema, req.body);
    const [challenge] = await globalDb
      .update(authChallenges)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(authChallenges.id, input.challengeId),
          eq(authChallenges.kind, 'passkey_register'),
          eq(authChallenges.userId, me.id),
          isNull(authChallenges.usedAt),
          gt(authChallenges.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!challenge) throw badRequest('That took too long. Try adding the passkey again.');
    const verification = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.secret,
      expectedOrigin: env.appOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
    }).catch(() => null);
    if (!verification?.verified) throw badRequest('That passkey could not be verified. Try again.');
    const { credential } = verification.registrationInfo;
    const inserted = await globalDb
      .insert(passkeys)
      .values({
        userId: me.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        name: input.name,
      })
      .onConflictDoNothing()
      .returning({ id: passkeys.id });
    if (inserted.length === 0) throw badRequest('That passkey is already registered.');
    return { id: inserted[0]!.id };
  });

  app.delete('/api/me/passkeys/:id', limit(10), async (req) => {
    const me = requireUser(req);
    const { id } = req.params as { id: string };
    const removed = await globalDb
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, me.id)))
      .returning({ id: passkeys.id });
    if (removed.length === 0) throw notFound();
    return { ok: true };
  });

  /** Signing in with a passkey needs no email address first: the device offers the accounts it holds. */
  app.post('/api/auth/passkey/options', limit(20), async () => {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const [row] = await globalDb
      .insert(authChallenges)
      .values({ kind: 'passkey_login', secret: options.challenge, expiresAt: new Date(Date.now() + 5 * 60_000) })
      .returning({ id: authChallenges.id });
    return { challengeId: row!.id, options };
  });

  app.post('/api/auth/passkey', limit(10), async (req, reply) => {
    const input = parse(passkeyLoginSchema, req.body);
    const failed = new HttpError(401, 'That passkey was not recognised. Log in with your password instead.');
    const [challenge] = await globalDb
      .update(authChallenges)
      .set({ usedAt: new Date() })
      .where(and(eq(authChallenges.id, input.challengeId), eq(authChallenges.kind, 'passkey_login'), isNull(authChallenges.usedAt), gt(authChallenges.expiresAt, new Date())))
      .returning();
    if (!challenge) throw failed;
    const response = input.response as unknown as AuthenticationResponseJSON;
    if (typeof response.id !== 'string') throw failed;
    const [key] = await globalDb.select().from(passkeys).where(eq(passkeys.credentialId, response.id));
    if (!key) throw failed;
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.secret,
      expectedOrigin: env.appOrigin,
      expectedRPID: rpID,
      credential: { id: key.credentialId, publicKey: new Uint8Array(key.publicKey), counter: key.counter, transports: key.transports ?? undefined },
      // The device itself checked a fingerprint, face or PIN, which is why no second step is asked for.
      requireUserVerification: true,
    }).catch(() => null);
    if (!verification?.verified) throw failed;
    const user = await loadUser(key.userId);
    if (!user.emailVerifiedAt) throw failed;
    await globalDb
      .update(passkeys)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(passkeys.id, key.id));
    await startSession(reply, user.id);
    return { ok: true };
  });
}
