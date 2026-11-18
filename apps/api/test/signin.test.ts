import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, features } from '../src/env.js';
import { drainJobs } from '../src/lib/jobs.js';
import { outbox } from '../src/notify/email.js';
import { smsOutbox } from '../src/notify/sms.js';
import { Agent, getApp, linkFor, resetDb, signup } from './helpers.js';
import { SoftAuthenticator } from './soft-authenticator.js';

const PASSWORD = 'correct horse battery';

async function emailedCode(to: string): Promise<string> {
  await drainJobs();
  const mail = [...outbox].reverse().find((e) => e.to === to && e.subject.includes('sign-in code'));
  if (!mail) throw new Error(`No code email for ${to}`);
  return mail.text.match(/code is (\d{6})/)![1]!;
}
const textedCode = () => smsOutbox[smsOutbox.length - 1]!.body.match(/code is (\d{6})/)![1]!;

afterAll(async () => {
  features.sms = false;
  await (await getApp()).close();
});

describe('two-step sign-in', () => {
  let tess: Agent;

  beforeAll(async () => {
    await resetDb();
    tess = await signup('Tess Two', 'tess@example.org');
  });

  it('is switched on only after the password and a code that really arrived', async () => {
    expect(await tess.ok('GET', '/api/me/security')).toMatchObject({ twoFactor: 'off', passkeys: [] });
    expect((await tess.req('POST', '/api/me/2fa/setup', { method: 'email', password: 'wrong' })).status).toBe(401);
    const { challengeId, sentTo } = await tess.ok('POST', '/api/me/2fa/setup', { method: 'email', password: PASSWORD });
    expect(sentTo).toBe('t•••@example.org');
    expect((await tess.req('POST', '/api/me/2fa/confirm', { challengeId, code: '000000' })).status).toBe(401);
    expect((await tess.ok('GET', '/api/me/security')).twoFactor).toBe('off');
    await tess.ok('POST', '/api/me/2fa/confirm', { challengeId, code: await emailedCode('tess@example.org') });
    expect((await tess.ok('GET', '/api/me/security')).twoFactor).toBe('email');
  });

  it('then the password alone signs nobody in', async () => {
    const agent = new Agent(await getApp());
    outbox.length = 0;
    const { twoFactor } = await agent.ok('POST', '/api/auth/login', { email: 'tess@example.org', password: PASSWORD });
    expect(twoFactor).toMatchObject({ channel: 'email', sentTo: 't•••@example.org', canUseEmail: false });
    expect((await agent.req('GET', '/api/me')).status).toBe(401);
    const code = await emailedCode('tess@example.org');
    // A setup-type challenge or someone else's reference cannot be used to finish a login.
    expect((await agent.req('POST', '/api/auth/2fa', { challengeId: '00000000-0000-4000-8000-000000000000', code })).status).toBe(400);
    await agent.ok('POST', '/api/auth/2fa', { challengeId: twoFactor.challengeId, code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect((await agent.ok('GET', '/api/me')).user.email).toBe('tess@example.org');
    // Single use.
    expect((await new Agent(await getApp()).req('POST', '/api/auth/2fa', { challengeId: twoFactor.challengeId, code })).status).toBe(400);
  });

  it('a code dies after five wrong guesses', async () => {
    const agent = new Agent(await getApp());
    const { twoFactor } = await agent.ok('POST', '/api/auth/login', { email: 'tess@example.org', password: PASSWORD });
    const code = await emailedCode('tess@example.org');
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) expect((await agent.req('POST', '/api/auth/2fa', { challengeId: twoFactor.challengeId, code: wrong })).status).toBe(401);
    expect((await agent.req('POST', '/api/auth/2fa', { challengeId: twoFactor.challengeId, code })).status).toBe(429);
    expect((await agent.req('GET', '/api/me')).status).toBe(401);
  });

  it('a password reset does not get around it', async () => {
    const agent = new Agent(await getApp());
    await agent.ok('POST', '/api/auth/forgot', { email: 'tess@example.org' });
    await drainJobs();
    const res = await agent.ok('POST', '/api/auth/reset', { token: linkFor('tess@example.org', 'reset'), password: 'a brand new password' });
    expect(res).toMatchObject({ loginRequired: true });
    expect((await agent.req('GET', '/api/me')).status).toBe(401);
    expect((await tess.req('GET', '/api/me')).status).toBe(401); // old sessions ended
    const { twoFactor } = await agent.ok('POST', '/api/auth/login', { email: 'tess@example.org', password: 'a brand new password' });
    await agent.ok('POST', '/api/auth/2fa', { challengeId: twoFactor.challengeId, code: await emailedCode('tess@example.org') });
    tess = agent;
  });

  it('works by text message, with email as the fallback, and limits how many codes are sent', async () => {
    await resetDb(); // fresh hourly allowance
    tess = await signup('Tess Two', 'tess@example.org');
    expect((await tess.req('POST', '/api/me/2fa/setup', { method: 'sms', phone: '919-555-0142', password: PASSWORD })).status).toBe(400); // SMS not configured
    features.sms = true;
    smsOutbox.length = 0;
    expect((await tess.req('POST', '/api/me/2fa/setup', { method: 'sms', phone: '12', password: PASSWORD })).status).toBe(400);
    const setup = await tess.ok('POST', '/api/me/2fa/setup', { method: 'sms', phone: '(919) 555-0142', password: PASSWORD });
    expect(setup.sentTo).toBe('•••• 0142');
    expect(smsOutbox[0]!.to).toBe('+19195550142');
    await tess.ok('POST', '/api/me/2fa/confirm', { challengeId: setup.challengeId, code: textedCode() });
    expect(await tess.ok('GET', '/api/me/security')).toMatchObject({ twoFactor: 'sms', phoneHint: '•••• 0142' });

    const agent = new Agent(await getApp());
    const { twoFactor } = await agent.ok('POST', '/api/auth/login', { email: 'tess@example.org', password: PASSWORD });
    expect(twoFactor).toMatchObject({ channel: 'sms', sentTo: '•••• 0142', canUseEmail: true });
    const smsCode = textedCode();
    // Phone not to hand: ask for it by email instead. The texted code stops working.
    outbox.length = 0;
    const resent = (await agent.ok('POST', '/api/auth/2fa/resend', { challengeId: twoFactor.challengeId, channel: 'email' })).twoFactor;
    expect(resent).toMatchObject({ channel: 'email', canUseEmail: false });
    expect((await agent.req('POST', '/api/auth/2fa', { challengeId: twoFactor.challengeId, code: smsCode })).status).toBe(400);
    await agent.ok('POST', '/api/auth/2fa', { challengeId: resent.challengeId, code: await emailedCode('tess@example.org') });

    // No more than eight codes an hour per account, however they are requested.
    const flood = new Agent(await getApp());
    let last = 200;
    for (let i = 0; i < 8 && last === 200; i++) last = (await flood.req('POST', '/api/auth/login', { email: 'tess@example.org', password: PASSWORD })).status;
    expect(last).toBe(429);

    await agent.ok('POST', '/api/me/2fa/disable', { password: PASSWORD });
    expect((await new Agent(await getApp()).ok('POST', '/api/auth/login', { email: 'tess@example.org', password: PASSWORD })).ok).toBe(true);
  });
});

describe('passkeys', () => {
  let pat: Agent;
  let device: SoftAuthenticator;

  beforeAll(async () => {
    await resetDb();
    pat = await signup('Pat Key', 'pat@example.org');
    device = new SoftAuthenticator(env.appOrigin);
  });

  it('adding one needs the password, and it is bound to this site', async () => {
    expect((await pat.req('POST', '/api/me/passkeys/options', { password: 'wrong' })).status).toBe(401);
    const { challengeId, options } = await pat.ok('POST', '/api/me/passkeys/options', { password: PASSWORD });
    expect(options).toMatchObject({ rp: { name: 'PetXport', id: 'localhost' }, user: { name: 'pat@example.org' }, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    await pat.ok('POST', '/api/me/passkeys', { challengeId, name: "Pat's phone", response: device.register(options) });
    // The same ceremony cannot be replayed.
    expect((await pat.req('POST', '/api/me/passkeys', { challengeId, name: 'again', response: device.register(options) })).status).toBe(400);
    expect((await pat.ok('GET', '/api/me/security')).passkeys).toMatchObject([{ name: "Pat's phone", lastUsedAt: null }]);
  });

  it('signs in without a password or code, even with two-step sign-in on', async () => {
    const setup = await pat.ok('POST', '/api/me/2fa/setup', { method: 'email', password: PASSWORD });
    await pat.ok('POST', '/api/me/2fa/confirm', { challengeId: setup.challengeId, code: await emailedCode('pat@example.org') });

    const agent = new Agent(await getApp());
    const { challengeId, options } = await agent.ok('POST', '/api/auth/passkey/options', {});
    expect(options).toMatchObject({ rpId: 'localhost', userVerification: 'required' });
    await agent.ok('POST', '/api/auth/passkey', { challengeId, response: device.authenticate(options) });
    expect((await agent.ok('GET', '/api/me')).user.email).toBe('pat@example.org');
    expect((await pat.ok('GET', '/api/me/security')).passkeys[0].lastUsedAt).not.toBeNull();
  });

  it('rejects replays, other sites, unverified users, tampering and unknown devices', async () => {
    const app = await getApp();
    const attempt = async (make: (options: any) => any, reuse?: { challengeId: string }) => {
      const agent = new Agent(app);
      const { challengeId, options } = await agent.ok('POST', '/api/auth/passkey/options', {});
      const res = await agent.req('POST', '/api/auth/passkey', { challengeId: reuse?.challengeId ?? challengeId, response: make(options) });
      expect((await agent.req('GET', '/api/me')).status).toBe(401);
      return { status: res.status, challengeId, options };
    };
    // A response signed for a look-alike site.
    expect((await attempt((o) => device.authenticate(o, { origin: 'https://petxport.evil.example' }))).status).toBe(401);
    // The device did not check a fingerprint/PIN.
    expect((await attempt((o) => device.authenticate(o, { userVerified: false }))).status).toBe(401);
    // Signature altered in transit.
    expect(
      (
        await attempt((o) => {
          const r = device.authenticate(o);
          const sig = Buffer.from(r.response.signature, 'base64url');
          sig[sig.length - 1]! ^= 0xff;
          return { ...r, response: { ...r.response, signature: sig.toString('base64url') } };
        })
      ).status,
    ).toBe(401);
    // A passkey this server has never seen.
    const stranger = new SoftAuthenticator(env.appOrigin);
    expect((await attempt((o) => stranger.authenticate(o))).status).toBe(401);
    // A valid response, captured and sent again against its (now used) challenge.
    const agent = new Agent(app);
    const { challengeId, options } = await agent.ok('POST', '/api/auth/passkey/options', {});
    const response = device.authenticate(options);
    await agent.ok('POST', '/api/auth/passkey', { challengeId, response });
    expect((await new Agent(app).req('POST', '/api/auth/passkey', { challengeId, response })).status).toBe(401);
    // ...or against a fresh challenge it was not signed for.
    expect((await attempt(() => response)).status).toBe(401);
  });

  it("cannot be removed by someone else, and stops working once its owner removes it", async () => {
    const other = await signup('Olive Other', 'olive@example.org');
    const [key] = (await pat.ok('GET', '/api/me/security')).passkeys;
    expect((await other.req('DELETE', `/api/me/passkeys/${key.id}`)).status).toBe(404);
    await pat.ok('DELETE', `/api/me/passkeys/${key.id}`);
    const agent = new Agent(await getApp());
    const { challengeId, options } = await agent.ok('POST', '/api/auth/passkey/options', {});
    expect((await agent.req('POST', '/api/auth/passkey', { challengeId, response: device.authenticate(options) })).status).toBe(401);
  });
});
