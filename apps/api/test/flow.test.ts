import { METERS_PER_MILE } from '@petxport/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { env, features } from '../src/env.js';
import { drainJobs } from '../src/lib/jobs.js';
import { outbox } from '../src/notify/email.js';
import { startChatListener, stopChatListener } from '../src/routes/chat.js';
import { Agent, NYC, RALEIGH, addDriver, createOrg, getApp, inDays, linkFor, resetDb, signup } from './helpers.js';

const O = '/api/o/happy-tails';

afterAll(async () => {
  await stopChatListener();
  await (await getApp()).close();
});

describe('planning a transport from request to completion', () => {
  let cora: Agent; // coordinator (org admin)
  let drivers: { agent: Agent; userId: string; email: string }[] = [];
  let transportId: string;
  let legs: any[];

  beforeAll(async () => {
    await resetDb();
    cora = await signup('Cora Coordinator', 'cora@happytails.example');
    await createOrg(cora, 'Happy Tails Rescue', 'happy-tails');
  });

  it('builds a driver roster, by hand and by CSV import', async () => {
    const homes = [
      ['Ravi', 35.78, -78.64], // Raleigh
      ['Maya', 37.2, -77.6],
      ['Noor', 38.6, -76.9],
      ['Theo', 39.7, -75.6],
      ['Ines', 40.4, -74.4],
    ] as const;
    for (const [name, lat, lng] of homes) {
      const email = `${name.toLowerCase()}@drivers.example`;
      const d = await addDriver(cora, O, `${name} Driver`, email, { phone: '919-555-0100', homeAddress: `${name}'s house`, homeLat: lat, homeLng: lng, maxMiles: 60 });
      drivers.push({ ...d, email });
    }
    const imported = await cora.ok('POST', `${O}/drivers/import`, {
      csv: 'Name,Email,Phone,Address,Max Miles\n"Far, Fiona",fiona@drivers.example,555-0000,"Atlanta, GA",40\nNo Email,,,,\nRavi Again,ravi@drivers.example,,,\n',
    });
    expect(imported.added).toBe(1);
    expect(imported.skipped.map((s: { row: number }) => s.row)).toEqual([3, 4]);
    await drainJobs(); // geocodes Fiona's address with the mock provider

    const roster = await cora.ok('GET', `${O}/drivers`);
    expect(roster).toHaveLength(6);
    const fiona = roster.find((d: { email: string }) => d.email === 'fiona@drivers.example');
    // Her typed address is kept as written; the lookup fills in its location and its pieces.
    expect(fiona).toMatchObject({ name: 'Far, Fiona', memberStatus: 'invited', maxMiles: 40, homeLat: 33.749, homeAddress: 'Atlanta, GA', homeCity: 'Atlanta', homeState: 'GA', homeStreet: null });
    expect(roster.find((d: { email: string }) => d.email === 'ravi@drivers.example').memberStatus).toBe('active');
  });

  it('splits the route into legs of about 100 miles with a schedule', async () => {
    const departAt = inDays(7);
    transportId = (
      await cora.ok('POST', `${O}/transports`, {
        title: 'Biscuit and Gravy go north',
        origin: RALEIGH,
        destination: NYC,
        departAt,
        animals: [{ name: 'Biscuit', breed: 'Beagle mix', size: 'small' }, { name: 'Gravy', size: 'large' }],
      })
    ).id;
    const t = await cora.ok('GET', `${O}/transports/${transportId}`);
    legs = t.legs;
    expect(t.status).toBe('draft');
    expect(t.animals).toHaveLength(2);
    expect(legs.length).toBe(5);
    expect(legs[0].start.name).toBe('Raleigh, NC');
    expect(legs[4].end.name).toBe('New York, NY');
    expect(legs[0].departAt).toBe(departAt);
    for (const [i, leg] of legs.entries()) {
      expect(leg.distanceM / METERS_PER_MILE).toBeLessThan(116);
      expect(leg.status).toBe('open');
      if (i > 0) {
        // 15 minute handoff buffer between legs
        expect(Date.parse(leg.departAt) - Date.parse(legs[i - 1].arriveAt)).toBe(15 * 60_000);
      }
    }
    expect(t.distanceM).toBe(legs.reduce((n: number, l: any) => n + l.distanceM, 0));
  });

  it('lets the coordinator move a handoff and change the start time', async () => {
    const handoffs = legs.slice(0, -1).map((l: any) => l.end);
    handoffs[0] = { name: 'Truck stop off I-85', lat: handoffs[0].lat + 0.05, lng: handoffs[0].lng };
    await cora.ok('POST', `${O}/transports/${transportId}/replan`, { handoffs });
    const departAt = inDays(8);
    await cora.ok('PATCH', `${O}/transports/${transportId}`, { departAt });
    const t = await cora.ok('GET', `${O}/transports/${transportId}`);
    expect(t.legs.map((l: any) => l.id)).toEqual(legs.map((l: any) => l.id));
    expect(t.legs[0].end.name).toBe('Truck stop off I-85');
    expect(t.legs[1].start.name).toBe('Truck stop off I-85');
    expect(t.legs[0].departAt).toBe(departAt);
    legs = t.legs;
  });

  it('offers real places near the route as handoff points, and saves a chosen one', async () => {
    const h = legs[1].end;
    const box = `south=${h.lat - 0.05}&west=${h.lng - 0.05}&north=${h.lat + 0.05}&east=${h.lng + 0.05}`;
    const stops = await cora.ok('GET', `${O}/stops?${box}`);
    expect(stops.map((s: any) => [s.name, s.category])).toEqual([
      ['Test Fuel', 'fuel'],
      ['Mile 42 Rest Area', 'rest_area'],
    ]);
    expect(stops[0].address).toBe('Main St, Testville');
    expect((await cora.req('GET', `${O}/stops?south=35&west=-79&north=37&east=-77`)).status).toBe(400);
    expect((await drivers[0]!.agent.req('GET', `${O}/stops?${box}`)).status).toBe(403);
    expect(await cora.ok('GET', `${O}/reverse-geocode?lat=36.72&lng=-78.12`)).toEqual({ label: 'Town 36.72,-78.12' });

    const handoffs = legs.slice(0, -1).map((l: any) => l.end);
    handoffs[1] = { name: `${stops[0].name}, ${stops[0].address}`, lat: stops[0].lat, lng: stops[0].lng };
    await cora.ok('POST', `${O}/transports/${transportId}/replan`, { handoffs });
    const t = await cora.ok('GET', `${O}/transports/${transportId}`);
    expect(t.legs[1].end).toEqual({ name: 'Test Fuel, Main St, Testville', lat: stops[0].lat, lng: stops[0].lng });
    expect(t.legs[2].start.name).toBe('Test Fuel, Main St, Testville');
    legs = t.legs;

    // Saving the same handoffs again is a no-op.
    expect(await cora.ok('POST', `${O}/transports/${transportId}/replan`, { handoffs })).toEqual({ ok: true, unchanged: true });
    expect(await cora.ok('POST', `${O}/transports/${transportId}/replan`, { handoffs: handoffs.map((h: any) => ({ ...h, name: '' })) })).toMatchObject({ unchanged: true });
  });

  it('suggests nearby drivers and sends the request to them', async () => {
    const suggestions = await cora.ok('GET', `${O}/transports/${transportId}/suggestions`);
    expect(suggestions[0]).toMatchObject({ name: 'Ravi Driver', legSeq: 1, inRange: true });
    expect(suggestions.find((s: any) => s.name === 'Far, Fiona').inRange).toBe(false);

    outbox.length = 0;
    const res = await cora.ok('POST', `${O}/transports/${transportId}/request-volunteers`, { audience: 'suggested', message: 'Two sweet dogs!' });
    expect(res.requested).toBe(5);
    await drainJobs();
    const requests = outbox.filter((e) => e.subject.includes('Drivers needed'));
    expect(requests.map((e) => e.to).sort()).toEqual(drivers.map((d) => d.email).sort());
    expect(requests[0]!.text).toContain('Two sweet dogs!');
    expect(requests[0]!.text).toContain(`/o/happy-tails/transports/${transportId}`);
    expect((await cora.ok('GET', `${O}/transports/${transportId}`)).status).toBe('recruiting');

    const open = await drivers[0]!.agent.ok('GET', `${O}/my/requests`);
    expect(open).toMatchObject([{ transportId, openLegs: 5, myOffers: 0 }]);
    const inApp = await drivers[0]!.agent.ok('GET', `${O}/notifications`);
    expect(inApp[0].kind).toBe('volunteer_request');
  });

  it('collects offers, and confirming one declines the rest', async () => {
    outbox.length = 0;
    await drivers[0]!.agent.ok('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/offers`, { note: 'I have a crate' });
    await drivers[1]!.agent.ok('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/offers`, {});
    await drainJobs();
    expect(outbox.filter((e) => e.to === 'cora@happytails.example' && e.subject.includes('offered to drive'))).toHaveLength(2);

    let t = await cora.ok('GET', `${O}/transports/${transportId}`);
    expect(t.legs[0].offers).toHaveLength(2);
    expect(t.legs[0].offers[0]).toMatchObject({ name: 'Ravi Driver', status: 'offered', note: 'I have a crate' });
    // A driver sees their own offer but not other people's, and no phone numbers yet.
    const asDriver = await drivers[1]!.agent.ok('GET', `${O}/transports/${transportId}`);
    expect(asDriver.legs[0].offers).toBeUndefined();
    expect(asDriver.legs[0].myOffer).toBe('offered');
    expect(asDriver.viewer).toMatchObject({ canManage: false, isCrew: false });

    outbox.length = 0;
    await cora.ok('POST', `${O}/transports/${transportId}/offers/${t.legs[0].offers[0].id}/accept`, {});
    await drainJobs();
    t = await cora.ok('GET', `${O}/transports/${transportId}`);
    expect(t.legs[0]).toMatchObject({ status: 'filled', driver: { name: 'Ravi Driver', phone: '919-555-0100' } });
    expect(t.legs[0].offers.map((o: any) => o.status)).toEqual(['accepted', 'declined']);
    expect(outbox.find((e) => e.to === drivers[0]!.email)!.subject).toContain('You are confirmed');
    expect(outbox.find((e) => e.to === drivers[1]!.email)!.subject).toContain('Another driver is covering');
    expect((await drivers[1]!.agent.req('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/offers`, {})).status).toBe(400);
  });

  it('becomes scheduled when every leg has a driver, and sends the itinerary notice and reminders', async () => {
    outbox.length = 0;
    for (let i = 1; i < 5; i++) {
      const res = await cora.ok('POST', `${O}/transports/${transportId}/legs/${legs[i].id}/assign`, { userId: drivers[i]!.userId });
      expect(res.status).toBe(i === 4 ? 'scheduled' : 'recruiting');
    }
    await drainJobs();
    const allSet = outbox.filter((e) => e.subject.includes('All set'));
    expect(allSet.map((e) => e.to).sort()).toEqual(drivers.map((d) => d.email).sort());

    const mine = await drivers[2]!.agent.ok('GET', `${O}/my/legs`);
    expect(mine).toMatchObject([{ transportId, seq: 3, legCount: 5, status: 'filled' }]);
    // Now part of the crew: can see the phone numbers of the drivers either side.
    const t = await drivers[2]!.agent.ok('GET', `${O}/transports/${transportId}`);
    expect(t.viewer.isCrew).toBe(true);
    expect(t.legs[1].driver.phone).toBe('919-555-0100');
    expect(await drivers[2]!.agent.ok('GET', `${O}/my/requests`)).toEqual([]);

    const { pool } = await import('../src/db/client.js');
    const reminders = await pool.query(`select payload, run_at from jobs where kind = 'reminder' and status = 'pending'`);
    expect(reminders.rowCount).toBe(10); // a day before and two hours before, for each of five legs
  });

  it('reopens a leg when its driver steps down', async () => {
    outbox.length = 0;
    await drivers[4]!.agent.ok('DELETE', `${O}/transports/${transportId}/legs/${legs[4].id}/offers/mine`);
    await drainJobs();
    let t = await cora.ok('GET', `${O}/transports/${transportId}`);
    expect(t.status).toBe('recruiting');
    expect(t.legs[4]).toMatchObject({ status: 'open', driver: null });
    expect(outbox.find((e) => e.to === 'cora@happytails.example')!.subject).toContain('can no longer drive leg 5');
    await cora.ok('POST', `${O}/transports/${transportId}/legs/${legs[4].id}/assign`, { userId: drivers[4]!.userId });
    t = await cora.ok('GET', `${O}/transports/${transportId}`);
    expect(t.status).toBe('scheduled');
  });

  it('carries chat between the crew live, and notifies people who are away', async () => {
    const app = await getApp();
    await startChatListener();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/ws`, { headers: { cookie: drivers[0]!.agent.cookie } });
    const received: any[] = [];
    ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'subscribe', slug: 'happy-tails', transportId }));
    await waitFor(() => received.some((m) => m.type === 'subscribed'));

    await drainJobs(); // flush notices left over from the previous step
    outbox.length = 0;
    await cora.ok('POST', `${O}/transports/${transportId}/messages`, { body: 'Running 10 minutes early!' });
    await waitFor(() => received.some((m) => m.type === 'message'));
    expect(received.find((m) => m.type === 'message').message).toMatchObject({ body: 'Running 10 minutes early!', userName: 'Cora Coordinator' });
    await drainJobs();
    const emailed = outbox.map((e) => e.to);
    expect(emailed).not.toContain(drivers[0]!.email); // had the chat open
    expect(emailed).toContain(drivers[1]!.email); // was away

    const t = await drivers[1]!.agent.ok('GET', `${O}/transports/${transportId}`);
    expect(t.unreadMessages).toBe(1);
    expect(await drivers[1]!.agent.ok('GET', `${O}/transports/${transportId}/messages`)).toHaveLength(1);
    expect((await drivers[1]!.agent.ok('GET', `${O}/transports/${transportId}`)).unreadMessages).toBe(0);

    // Someone who is not on the transport cannot subscribe or read.
    const outsider = await addDriver(cora, O, 'Olive Outsider', 'olive@drivers.example');
    expect((await outsider.agent.req('GET', `${O}/transports/${transportId}/messages`)).status).toBe(403);
    ws.close();
  });

  it('tracks progress leg by leg through to completion', async () => {
    // A driver cannot start a leg that is days away, or skip straight to "handed off".
    expect((await drivers[0]!.agent.req('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'in_progress' })).status).toBe(400);
    expect((await drivers[0]!.agent.req('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'done' })).status).toBe(400);
    await cora.ok('PATCH', `${O}/transports/${transportId}`, { departAt: new Date(Date.now() + 3600_000).toISOString() });
    await drainJobs();
    // Only the leg's own driver (or a coordinator) can update it.
    expect((await drivers[1]!.agent.req('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'in_progress' })).status).toBe(404);
    // Location can only be shared by the leg's own driver, and only between pickup and handoff.
    const leg1 = `${O}/transports/${transportId}/legs/${legs[0].id}`;
    const here = { lat: 36.1, lng: -78.2, accuracyM: 12.4 };
    expect((await drivers[0]!.agent.req('PUT', `${leg1}/position`, here)).status).toBe(400);
    expect((await drivers[0]!.agent.ok('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'in_progress' })).status).toBe('in_progress');
    expect(await cora.ok('GET', `${O}/transports/${transportId}/positions`)).toEqual([]);
    expect((await drivers[1]!.agent.req('PUT', `${leg1}/position`, here)).status).toBe(404);
    expect((await drivers[0]!.agent.req('PUT', `${leg1}/position`, { lat: 123, lng: 0 })).status).toBe(400);
    await drivers[0]!.agent.ok('PUT', `${leg1}/position`, here);
    await drivers[0]!.agent.ok('PUT', `${leg1}/position`, { ...here, lat: 36.2 });
    // The coordinator and the other drivers on this transport see the latest position only.
    for (const viewer of [cora, drivers[1]!.agent]) {
      const seen = await viewer.ok('GET', `${O}/transports/${transportId}/positions`);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ legId: legs[0].id, lat: 36.2, lng: -78.2, accuracyM: 12 });
    }
    // A driver who is not on this transport sees nothing.
    const bystander = await addDriver(cora, O, 'Bea Bystander', 'bea@drivers.example');
    const peek = await bystander.agent.req('GET', `${O}/transports/${transportId}/positions`);
    expect(peek.status === 404 || (peek.status === 200 && peek.body.length === 0)).toBe(true);
    // Stopping removes it at once; so does the handoff.
    await drivers[0]!.agent.ok('DELETE', `${leg1}/position`);
    expect(await cora.ok('GET', `${O}/transports/${transportId}/positions`)).toEqual([]);
    await drivers[0]!.agent.ok('PUT', `${leg1}/position`, here);
    expect(await cora.ok('GET', `${O}/transports/${transportId}/positions`)).toHaveLength(1);
    outbox.length = 0;
    await drivers[0]!.agent.ok('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'done' });
    await drainJobs();
    expect(outbox.find((e) => e.to === drivers[1]!.email)!.subject).toContain('Leg 1');
    expect(await cora.ok('GET', `${O}/transports/${transportId}/positions`)).toEqual([]);
    expect((await drivers[0]!.agent.req('PUT', `${leg1}/position`, here)).status).toBe(400);
    // Drivers cannot undo; a coordinator can, to correct a mistake.
    expect((await drivers[0]!.agent.req('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'in_progress' })).status).toBe(400);
    await cora.ok('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'in_progress' });
    await cora.ok('POST', `${O}/transports/${transportId}/legs/${legs[0].id}/status`, { status: 'done' });
    for (let i = 1; i < 5; i++) {
      await drivers[i]!.agent.ok('POST', `${O}/transports/${transportId}/legs/${legs[i].id}/status`, { status: 'in_progress' });
      const res = await drivers[i]!.agent.ok('POST', `${O}/transports/${transportId}/legs/${legs[i].id}/status`, { status: 'done' });
      expect(res.status).toBe(i === 4 ? 'completed' : 'in_progress');
    }
    const list = await cora.ok('GET', `${O}/transports`);
    expect(list[0]).toMatchObject({ status: 'completed', legCount: 5, filledCount: 5, animalCount: 2 });
    expect((await cora.req('PATCH', `${O}/transports/${transportId}`, { title: 'x' })).status).toBe(400);
  });
});

describe('accounts', () => {
  beforeAll(resetDb);

  it('rejects wrong passwords and weak passwords', async () => {
    const app = await getApp();
    await signup('Pat', 'pat@example.org');
    const agent = new Agent(app);
    expect((await agent.req('POST', '/api/auth/login', { email: 'pat@example.org', password: 'nope' })).status).toBe(401);
    expect((await agent.req('POST', '/api/auth/signup', { name: 'X', email: 'x@example.org', password: 'short', phone: '(919) 555-0100' })).status).toBe(400);
    expect((await agent.req('POST', '/api/auth/signup', { name: 'X', email: 'x@example.org', password: 'long enough password' })).status).toBe(400);
    expect((await agent.req('GET', '/api/me')).status).toBe(401);
    expect((await agent.req('POST', '/api/auth/login', { email: 'PAT@example.org', password: 'correct horse battery' })).status).toBe(200);
    expect((await agent.ok('GET', '/api/me')).user.name).toBe('Pat');
  });

  it('resets a password by email and signs out other sessions', async () => {
    const app = await getApp();
    const old = await signup('Sam', 'sam@example.org');
    outbox.length = 0;
    const agent = new Agent(app);
    await agent.ok('POST', '/api/auth/forgot', { email: 'sam@example.org' });
    await agent.ok('POST', '/api/auth/forgot', { email: 'nobody@example.org' });
    await drainJobs();
    expect(outbox).toHaveLength(1);
    const token = outbox[0]!.text.match(/\/reset\/([\w-]+)/)![1];
    await agent.ok('POST', '/api/auth/reset', { token, password: 'a brand new password' });
    expect((await agent.req('POST', '/api/auth/reset', { token, password: 'another new password' })).status).toBe(400);
    expect((await old.req('GET', '/api/me')).status).toBe(401);
    expect((await new Agent(app).req('POST', '/api/auth/login', { email: 'sam@example.org', password: 'a brand new password' })).status).toBe(200);
  });

  it('keeps at least one admin and enforces unique organization addresses', async () => {
    const admin = await signup('Ada', 'ada@example.org');
    await createOrg(admin, 'Paws', 'paws');
    expect((await admin.req('POST', '/api/orgs', { name: 'Paws 2', slug: 'paws' })).status).toBe(409);
    expect((await admin.req('POST', '/api/orgs', { name: 'Bad', slug: 'No Spaces!' })).status).toBe(400);
    const me = await admin.ok('GET', '/api/me');
    expect((await admin.req('PATCH', `/api/o/paws/members/${me.user.id}`, { role: 'driver' })).status).toBe(400);
    await admin.ok('PATCH', '/api/o/paws', { legTargetMiles: 60, handoffBufferMinutes: 20 });
    expect(await admin.ok('GET', '/api/o/paws')).toMatchObject({ legTargetMiles: 60, handoffBufferMinutes: 20, role: 'admin' });
  });
});

describe('invitations', () => {
  let root: Agent; // platform admin
  const inviteToken = (to: string) => [...outbox].reverse().find((e) => e.to === to && e.text.includes('/invite/'))!.text.match(/\/invite\/([\w-]+)/)![1]!;

  beforeAll(async () => {
    await resetDb();
    root = await signup('Rory Root', 'root@platform.example');
    const { default: pg } = await import('pg');
    const owner = new pg.Client({ connectionString: env.migrationDatabaseUrl });
    await owner.connect();
    await owner.query(`update users set is_platform_admin = true where email = 'root@platform.example'`);
    await owner.end();
  });

  it('keeps organization creation and the admin area to platform admins when sign-up is closed', async () => {
    env.allowOrgSignup = false;
    try {
      const pat = await signup('Pat Public', 'pat@public.example');
      expect((await pat.ok('GET', '/api/me')).allowOrgSignup).toBe(false);
      expect((await pat.req('POST', '/api/orgs', { name: 'Sneaky', slug: 'sneaky' })).status).toBe(403);
      expect((await pat.req('GET', '/api/admin/orgs')).status).toBe(404);
      expect((await pat.req('POST', '/api/admin/orgs', { name: 'Sneaky', slug: 'sneaky', adminName: 'Pat', adminEmail: 'pat@public.example' })).status).toBe(404);
      expect((await root.ok('GET', '/api/me')).user.isPlatformAdmin).toBe(true);
    } finally {
      env.allowOrgSignup = true;
    }
  });

  it('lets a platform admin set up a rescue and hand it to its administrator', async () => {
    outbox.length = 0;
    await root.ok('POST', '/api/admin/orgs', { name: 'Second Chance Dogs', slug: 'second-chance', adminName: 'Gail Garcia', adminEmail: 'gail@secondchance.example' });
    expect((await root.req('POST', '/api/admin/orgs', { name: 'Dupe', slug: 'second-chance', adminName: 'X', adminEmail: 'x@example.org' })).status).toBe(409);
    await drainJobs();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: 'gail@secondchance.example', subject: 'Second Chance Dogs is set up on PetXport' });

    let [org] = await root.ok('GET', '/api/admin/orgs');
    expect(org).toMatchObject({ name: 'Second Chance Dogs', suspended: false, memberCount: 1, admins: [{ email: 'gail@secondchance.example', status: 'invited' }] });
    // The platform admin created it but is not a member, so cannot look inside.
    expect((await root.req('GET', '/api/o/second-chance')).status).toBe(404);
    expect((await root.req('GET', '/api/o/second-chance/drivers')).status).toBe(404);

    const app = await getApp();
    const gail = new Agent(app);
    const token = inviteToken('gail@secondchance.example');
    expect(await gail.ok('GET', `/api/invites/${token}`)).toMatchObject({ orgName: 'Second Chance Dogs', role: 'admin', needsPassword: true });
    expect(await gail.ok('POST', `/api/invites/${token}/accept`, { name: 'Gail Garcia', password: 'correct horse battery', phone: '(919) 555-0100' })).toEqual({ slug: 'second-chance', role: 'admin', loginRequired: false });
    expect(await gail.ok('GET', '/api/o/second-chance')).toMatchObject({ role: 'admin', name: 'Second Chance Dogs' });
    [org] = await root.ok('GET', '/api/admin/orgs');
    expect(org.admins[0].status).toBe('active');
    expect((await root.req('POST', `/api/admin/orgs/${org.id}/invite`, {})).status).toBe(400);
  });

  it('lets a rescue admin invite drivers by pasting email addresses', async () => {
    const gail = new Agent(await getApp());
    await gail.ok('POST', '/api/auth/login', { email: 'gail@secondchance.example', password: 'correct horse battery' });
    const O = '/api/o/second-chance';
    outbox.length = 0;
    const res = await gail.ok('POST', `${O}/drivers/invite`, {
      emails: 'dee.dee-ramos@drivers.example, Sam Okafor <SAM@drivers.example>\nnot-an-email; gail@secondchance.example\ndee.dee-ramos@drivers.example',
    });
    expect(res.invited).toBe(2);
    expect(res.skipped).toEqual([
      { email: 'not-an-email', reason: 'not an email address' },
      { email: 'gail@secondchance.example', reason: 'already on the team; added to the driver list' },
    ]);
    await drainJobs();
    expect(outbox.map((e) => e.to).sort()).toEqual(['dee.dee-ramos@drivers.example', 'sam@drivers.example']);
    const roster = await gail.ok('GET', `${O}/drivers`);
    expect(roster.map((d: any) => [d.name, d.memberStatus, d.role]).sort()).toEqual([
      ['Dee Dee Ramos', 'invited', 'driver'],
      ['Gail Garcia', 'active', 'admin'],
      ['Sam Okafor', 'invited', 'driver'],
    ]);

    const deeToken = inviteToken('dee.dee-ramos@drivers.example');
    // Inviting again re-sends the link rather than failing.
    outbox.length = 0;
    expect((await gail.ok('POST', `${O}/drivers/invite`, { emails: 'sam@drivers.example' })).invited).toBe(1);
    await drainJobs();

    const sam = new Agent(await getApp());
    const token = inviteToken('sam@drivers.example');
    expect(await sam.ok('GET', `/api/invites/${token}`)).toMatchObject({ role: 'driver', name: 'Sam Okafor' });
    // A phone number is required; agreeing to texts is a separate choice that is never assumed.
    expect((await sam.req('POST', `/api/invites/${token}/accept`, { name: 'Samuel Okafor', password: 'correct horse battery' })).status).toBe(400);
    expect((await sam.req('POST', `/api/invites/${token}/accept`, { name: 'Samuel Okafor', password: 'correct horse battery', phone: '555-0100' })).status).toBe(400);
    // With texts switched off on the server, the box is not shown and a forged "yes" counts for nothing.
    expect(await sam.ok('GET', '/api/features')).toEqual({ sms: false });
    const deeEarly = new Agent(await getApp());
    await deeEarly.ok('POST', `/api/invites/${deeToken}/accept`, { password: 'correct horse battery', phone: '919-555-0177', smsOptIn: true });
    const deeMe = await deeEarly.ok('GET', '/api/me');
    expect(await deeEarly.ok('GET', `${O}/drivers/${deeMe.user.id}`)).toMatchObject({ phone: '919-555-0177', notifySms: false });

    features.sms = true;
    await sam.ok('POST', `/api/invites/${token}/accept`, { name: 'Samuel Okafor', password: 'correct horse battery', phone: '(919) 555-0100', smsOptIn: true });
    features.sms = false;
    const me = await sam.ok('GET', '/api/me');
    expect(await sam.ok('GET', `${O}/drivers/${me.user.id}`)).toMatchObject({ phone: '(919) 555-0100', notifySms: true });

    // Sam replies STOP to a text. Brevo reports it; only a call carrying the shared secret counts.
    const stop = (secret: string, body: unknown) =>
      app.inject({ method: 'POST', url: '/api/webhooks/brevo/sms', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, payload: JSON.stringify(body) });
    const app = await getApp();
    expect((await stop('wrong', { msg_status: 'unsubscribed', to: '19195550100' })).statusCode).toBe(404);
    expect((await stop(env.brevoWebhookSecret, { msg_status: 'delivered', to: '19195550100' })).json()).toMatchObject({ stopped: 0 });
    expect((await sam.ok('GET', `${O}/drivers/${me.user.id}`)).notifySms).toBe(true);
    expect((await stop(env.brevoWebhookSecret, { msg_status: 'unsubscribed', to: '19195550100' })).json()).toMatchObject({ stopped: 1 });
    expect((await sam.ok('GET', `${O}/drivers/${me.user.id}`)).notifySms).toBe(false);
    // Brevo sometimes files the reply under another status; the word itself is enough.
    features.sms = true;
    await sam.ok('PUT', `${O}/drivers/${me.user.id}`, { phone: '(919) 555-0100', notifySms: true });
    features.sms = false;
    expect((await stop(env.brevoWebhookSecret, { msg_status: 'subscribe', reply: 'Start', to: '19195550100' })).json()).toMatchObject({ stopped: 0 });
    expect((await stop(env.brevoWebhookSecret, { msg_status: 'replied', reply: ' stop ', to: '19195550100' })).json()).toMatchObject({ stopped: 1 });
    // Sam can switch texts back on himself.
    features.sms = true;
    await sam.ok('PUT', `${O}/drivers/${me.user.id}`, { phone: '(919) 555-0100', notifySms: true });
    features.sms = false;
    expect((await sam.ok('GET', `${O}/drivers/${me.user.id}`)).notifySms).toBe(true);

    const dee = deeEarly;
    // A coordinator cannot agree on a driver's behalf.
    await gail.ok('PUT', `${O}/drivers/${deeMe.user.id}`, { notifySms: true });
    expect((await dee.ok('GET', `${O}/drivers/${deeMe.user.id}`)).notifySms).toBe(false);
    expect(me.user.name).toBe('Samuel Okafor');
    expect(me.orgs).toMatchObject([{ slug: 'second-chance', role: 'driver', status: 'active' }]);
    await sam.ok('PUT', `${O}/drivers/${me.user.id}`, { phone: '555-0142', homeAddress: 'Raleigh, NC' });
    expect((await sam.req('POST', `${O}/drivers/invite`, { emails: 'friend@example.org' })).status).toBe(403);
  });

  it('suspending an organization locks its members out without deleting anything', async () => {
    const gail = new Agent(await getApp());
    await gail.ok('POST', '/api/auth/login', { email: 'gail@secondchance.example', password: 'correct horse battery' });
    const [org] = await root.ok('GET', '/api/admin/orgs');
    await root.ok('PATCH', `/api/admin/orgs/${org.id}`, { suspended: true });
    expect((await gail.req('GET', '/api/o/second-chance')).status).toBe(404);
    expect((await gail.ok('GET', '/api/me')).orgs).toEqual([]);
    await root.ok('PATCH', `/api/admin/orgs/${org.id}`, { suspended: false });
    expect(await gail.ok('GET', '/api/o/second-chance/drivers')).toHaveLength(3);
    expect((await root.ok('GET', '/api/admin/orgs'))[0]).toMatchObject({ suspended: false, driverCount: 3, memberCount: 3 });
  });
});

describe('security', () => {
  beforeAll(resetDb);

  it('an account is unusable until its owner confirms the email with the password', async () => {
    const app = await getApp();
    const attacker = new Agent(app);
    // Someone registers an address they do not own (say, a platform admin's, or a volunteer's).
    expect(await attacker.ok('POST', '/api/auth/signup', { name: 'Not Vera', email: 'vera@victim.example', password: 'attacker password 1', phone: '(919) 555-0100' })).toEqual({ ok: true });
    expect((await attacker.req('GET', '/api/me')).status).toBe(401);
    expect((await attacker.req('POST', '/api/auth/login', { email: 'vera@victim.example', password: 'attacker password 1' })).status).toBe(403);
    await drainJobs();
    const token = linkFor('vera@victim.example', 'verify');
    // Vera receives the link and clicks it, but does not know the attacker's password: nothing is activated.
    const vera = new Agent(app);
    expect((await vera.req('POST', '/api/auth/verify', { token, password: 'whatever vera types' })).status).toBe(401);
    expect((await attacker.req('POST', '/api/auth/login', { email: 'vera@victim.example', password: 'attacker password 1' })).status).toBe(403);

    // Later a rescue invites Vera. Accepting replaces the squatter's password and signs out any session.
    const admin = await signup('Ada Admin', 'ada@rescue.example');
    await createOrg(admin, 'Rescue', 'rescue');
    await admin.ok('POST', '/api/o/rescue/drivers/invite', { emails: 'Vera Real <vera@victim.example>' });
    await drainJobs();
    const invite = linkFor('vera@victim.example', 'invite');
    expect(await vera.ok('GET', `/api/invites/${invite}`)).toMatchObject({ name: 'Vera Real', needsPassword: true });
    await vera.ok('POST', `/api/invites/${invite}/accept`, { password: 'vera own password 1', phone: '(919) 555-0100' });
    expect((await vera.ok('GET', '/api/me')).user.name).toBe('Vera Real');
    expect((await attacker.req('POST', '/api/auth/login', { email: 'vera@victim.example', password: 'attacker password 1' })).status).toBe(401);
    expect((await attacker.req('POST', '/api/auth/verify', { token, password: 'attacker password 1' })).status).toBe(401);
  });

  it('signing up never reveals whether an address has an account', async () => {
    const app = await getApp();
    outbox.length = 0;
    const res = await new Agent(app).req('POST', '/api/auth/signup', { name: 'Ada Again', email: 'ada@rescue.example', password: 'another password 1', phone: '(919) 555-0100' });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    await drainJobs();
    expect(outbox.map((e) => e.subject)).toEqual(['You already have a PetXport account']);
    // The existing password is untouched.
    expect((await new Agent(app).req('POST', '/api/auth/login', { email: 'ada@rescue.example', password: 'correct horse battery' })).status).toBe(200);
  });

  it('an invitation link does not sign in an account that already exists', async () => {
    const app = await getApp();
    const other = await signup('Olga Other', 'olga@other.example');
    await createOrg(other, 'Other Rescue', 'other-rescue');
    // Ada (admin of "rescue") is invited to a second organization.
    await other.ok('POST', '/api/o/other-rescue/drivers/invite', { emails: 'ada@rescue.example' });
    await drainJobs();
    const invite = linkFor('ada@rescue.example', 'invite');
    const stranger = new Agent(app); // someone who got hold of the forwarded email
    expect(await stranger.ok('GET', `/api/invites/${invite}`)).toMatchObject({ needsPassword: false });
    expect(await stranger.ok('POST', `/api/invites/${invite}/accept`, { password: 'takeover attempt 1', phone: '(919) 555-0100' })).toMatchObject({ loginRequired: true });
    expect((await stranger.req('GET', '/api/me')).status).toBe(401);
    expect((await stranger.req('POST', '/api/auth/login', { email: 'ada@rescue.example', password: 'takeover attempt 1' })).status).toBe(401);
    expect((await stranger.req('POST', `/api/invites/${invite}/accept`, {})).status).toBe(404); // single use
  });

  it("adding someone's email does not reveal the name on their account elsewhere", async () => {
    const other = new Agent(await getApp());
    await other.ok('POST', '/api/auth/login', { email: 'olga@other.example', password: 'correct horse battery' });
    await other.ok('POST', '/api/o/other-rescue/drivers', { name: 'Guess Who', email: 'vera@victim.example' });
    const roster = await other.ok('GET', '/api/o/other-rescue/drivers');
    expect(roster.find((d: any) => d.email === 'vera@victim.example').name).toBe('Guess Who');
    expect(JSON.stringify(roster)).not.toContain('Vera Real');
  });

  it('locks sign-in for an address after repeated wrong passwords', async () => {
    const agent = new Agent(await getApp());
    for (let i = 0; i < 8; i++) {
      expect((await agent.req('POST', '/api/auth/login', { email: 'olga@other.example', password: `wrong ${i}` })).status).toBe(401);
    }
    expect((await agent.req('POST', '/api/auth/login', { email: 'olga@other.example', password: 'correct horse battery' })).status).toBe(429);
  });

  it('caps how many reset emails one address can be sent', async () => {
    const agent = new Agent(await getApp());
    outbox.length = 0;
    for (let i = 0; i < 6; i++) await agent.ok('POST', '/api/auth/forgot', { email: 'ada@rescue.example' });
    await drainJobs();
    expect(outbox.filter((e) => e.subject.includes('Reset'))).toHaveLength(3);
  });

  it('rejects requests from other sites, and push endpoints that are not a browser push service', async () => {
    const app = await getApp();
    const admin = new Agent(app);
    await admin.ok('POST', '/api/auth/login', { email: 'ada@rescue.example', password: 'correct horse battery' });
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/o/rescue/drivers/invite',
      headers: { cookie: admin.cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: JSON.stringify({ emails: 'x@example.org' }),
    });
    expect(crossSite.statusCode).toBe(403);
    const keys = { p256dh: 'k', auth: 'a' };
    for (const endpoint of ['http://169.254.169.254/latest/meta-data', 'https://localhost:5432/', 'https://internal.example/push', 'https://fcm.googleapis.com.evil.example/x']) {
      expect((await admin.req('POST', '/api/o/rescue/push/subscribe', { endpoint, keys })).status, endpoint).toBe(400);
    }
    expect((await admin.req('POST', '/api/o/rescue/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys })).status).toBe(200);
  });

  it('sends security headers and keeps API answers out of caches', async () => {
    const res = await (await getApp()).inject({ method: 'GET', url: '/api/health' });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('only the person themself can switch on text messages, and removal frees their legs', async () => {
    const admin = new Agent(await getApp());
    await admin.ok('POST', '/api/auth/login', { email: 'ada@rescue.example', password: 'correct horse battery' });
    const R = '/api/o/rescue';
    const roster = await admin.ok('GET', `${R}/drivers`);
    const vera = roster.find((d: any) => d.email === 'vera@victim.example');
    await admin.ok('PUT', `${R}/drivers/${vera.userId}`, { phone: '555-0100', notifySms: true, notes: 'Coordinator-only note' });
    const after = (await admin.ok('GET', `${R}/drivers`)).find((d: any) => d.userId === vera.userId);
    expect(after).toMatchObject({ phone: '555-0100', notifySms: false, notes: 'Coordinator-only note' });

    const veraAgent = new Agent(await getApp());
    await veraAgent.ok('POST', '/api/auth/login', { email: 'vera@victim.example', password: 'vera own password 1' });
    expect((await veraAgent.ok('GET', `${R}/drivers/${vera.userId}`)).notes).toBeNull();
    await veraAgent.ok('PUT', `${R}/drivers/${vera.userId}`, { phone: '555-0100', notifySms: true, notes: 'overwrite attempt' });
    expect((await admin.ok('GET', `${R}/drivers`)).find((d: any) => d.userId === vera.userId)).toMatchObject({ notifySms: true, notes: 'Coordinator-only note' });

    const tid = (await admin.ok('POST', `${R}/transports`, { title: 'Short hop', origin: RALEIGH, destination: { name: 'Durham, NC', lat: 35.994, lng: -78.8986 }, departAt: inDays(3) })).id;
    const leg = (await admin.ok('GET', `${R}/transports/${tid}`)).legs[0];
    expect((await admin.ok('POST', `${R}/transports/${tid}/legs/${leg.id}/assign`, { userId: vera.userId })).status).toBe('scheduled');
    await admin.ok('PATCH', `${R}/members/${vera.userId}`, { status: 'disabled' });
    const t = await admin.ok('GET', `${R}/transports/${tid}`);
    expect(t).toMatchObject({ status: 'recruiting', legs: [{ status: 'open', driver: null }] });
    expect((await veraAgent.req('GET', `${R}/transports/${tid}`)).status).toBe(404);
  });

  it('the app database role cannot make anyone a platform admin', async () => {
    const { pool } = await import('../src/db/client.js');
    await expect(pool.query(`update users set is_platform_admin = true where email = 'ada@rescue.example'`)).rejects.toThrow(/database owner/);
    await expect(pool.query(`create table sneaky (id int)`)).rejects.toThrow(/permission denied/);
  });
});

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
