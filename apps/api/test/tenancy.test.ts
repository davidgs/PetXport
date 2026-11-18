import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { drainJobs } from '../src/lib/jobs.js';
import { Agent, DC, RALEIGH, addDriver, createOrg, getApp, inDays, resetDb, signup } from './helpers.js';

/**
 * Two rescues with a full set of data each. Everything one of them can
 * reach must be invisible to the other.
 */
describe('organization isolation', () => {
  let alice: Agent; // admin of rescue A
  let bob: Agent; // admin of rescue B
  let aDriver: Agent;
  const A = '/api/o/rescue-a';
  const B = '/api/o/rescue-b';
  let aTransport: string;
  let aLeg: string;
  let aDriverId: string;
  let bTransport: string;
  let raw: pg.Client;

  beforeAll(async () => {
    await resetDb();
    alice = await signup('Alice Admin', 'alice@a.example');
    bob = await signup('Bob Boss', 'bob@b.example');
    await createOrg(alice, 'Rescue A', 'rescue-a');
    await createOrg(bob, 'Rescue B', 'rescue-b');

    const d = await addDriver(alice, A, 'Dana Driver', 'dana@a.example', { phone: '919-555-0101', homeAddress: 'Raleigh, NC', homeLat: 35.78, homeLng: -78.64 });
    aDriver = d.agent;
    aDriverId = d.userId;
    await addDriver(bob, B, 'Bert Driver', 'bert@b.example', { phone: '202-555-0199' });

    aTransport = (await alice.ok('POST', `${A}/transports`, { title: 'A secret run', origin: RALEIGH, destination: DC, departAt: inDays(5), animals: [{ name: 'Biscuit' }] })).id;
    bTransport = (await bob.ok('POST', `${B}/transports`, { title: 'B run', origin: DC, destination: RALEIGH, departAt: inDays(6) })).id;
    const detail = await alice.ok('GET', `${A}/transports/${aTransport}`);
    aLeg = detail.legs[0].id;
    await alice.ok('POST', `${A}/transports/${aTransport}/request-volunteers`, { audience: 'all' });
    await aDriver.ok('POST', `${A}/transports/${aTransport}/legs/${aLeg}/offers`, {});
    await alice.ok('POST', `${A}/transports/${aTransport}/legs/${aLeg}/assign`, { userId: aDriverId });
    await alice.ok('POST', `${A}/transports/${aTransport}/messages`, { body: 'Private to rescue A' });
    await drainJobs();

    raw = new pg.Client({ connectionString: env.databaseUrl });
    await raw.connect();
  });

  afterAll(async () => {
    await raw.end();
    await (await getApp()).close();
  });

  it('hides the other organization entirely', async () => {
    for (const path of ['', '/members', '/drivers', '/transports', '/my/legs', '/my/requests', '/notifications']) {
      const res = await bob.req('GET', `${A}${path}`);
      expect(res.status, `GET ${A}${path}`).toBe(404);
    }
    const me = await bob.ok('GET', '/api/me');
    expect(me.orgs.map((o: { slug: string }) => o.slug)).toEqual(['rescue-b']);
  });

  it('returns only its own rows from every list', async () => {
    expect((await bob.ok('GET', `${B}/transports`)).map((t: { title: string }) => t.title)).toEqual(['B run']);
    expect((await bob.ok('GET', `${B}/drivers`)).map((d: { name: string }) => d.name)).toEqual(['Bert Driver']);
    expect((await bob.ok('GET', `${B}/members`)).map((m: { email: string }) => m.email).sort()).toEqual(['bert@b.example', 'bob@b.example']);
  });

  it("cannot reach another organization's records by id through its own URL space", async () => {
    const attempts: [Parameters<Agent['req']>[0], string, unknown?][] = [
      ['GET', `${B}/transports/${aTransport}`],
      ['PATCH', `${B}/transports/${aTransport}`, { title: 'hijacked' }],
      ['POST', `${B}/transports/${aTransport}/cancel`, {}],
      ['POST', `${B}/transports/${aTransport}/replan`, { handoffs: [] }],
      ['GET', `${B}/transports/${aTransport}/suggestions`],
      ['POST', `${B}/transports/${aTransport}/request-volunteers`, { audience: 'all' }],
      ['POST', `${B}/transports/${aTransport}/animals`, { name: 'Intruder' }],
      ['POST', `${B}/transports/${aTransport}/legs/${aLeg}/offers`, {}],
      ['POST', `${B}/transports/${aTransport}/legs/${aLeg}/assign`, { userId: null }],
      ['POST', `${B}/transports/${aTransport}/legs/${aLeg}/status`, { status: 'done' }],
      ['POST', `${B}/transports/${bTransport}/legs/${aLeg}/assign`, { userId: null }],
      ['GET', `${B}/transports/${aTransport}/messages`],
      ['POST', `${B}/transports/${aTransport}/messages`, { body: 'hello?' }],
      ['GET', `${B}/drivers/${aDriverId}`],
      ['PUT', `${B}/drivers/${aDriverId}`, { phone: '000' }],
      ['PATCH', `${B}/members/${aDriverId}`, { role: 'admin' }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await bob.req(method, url, body);
      expect([403, 404], `${method} ${url} -> ${res.status}`).toContain(res.status);
    }
    // Nothing changed for rescue A.
    const detail = await alice.ok('GET', `${A}/transports/${aTransport}`);
    expect(detail.title).toBe('A secret run');
    expect(detail.status).toBe('recruiting');
    expect(detail.animals).toHaveLength(1);
    expect(detail.legs[0].driver.userId).toBe(aDriverId);
    expect(await alice.ok('GET', `${A}/transports/${aTransport}/messages`)).toHaveLength(1);
  });

  it('keeps each organization\'s logo to itself, and accepts only real bitmap images', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    expect((await alice.ok('GET', A)).logoUrl).toBeNull();
    await alice.ok('PUT', `${A}/logo`, { data: png.toString('base64') });
    const { logoUrl } = await alice.ok('GET', A);
    expect(logoUrl).toMatch(/^\/api\/o\/rescue-a\/logo\?v=\d+$/);

    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: logoUrl, headers: { cookie: alice.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    expect(res.rawPayload.equals(png)).toBe(true);
    // Members can see it; drivers cannot change it; other organizations and visitors get nothing.
    expect((await app.inject({ method: 'GET', url: logoUrl, headers: { cookie: aDriver.cookie } })).statusCode).toBe(200);
    expect((await aDriver.req('PUT', `${A}/logo`, { data: png.toString('base64') })).status).toBe(403);
    expect((await aDriver.req('DELETE', `${A}/logo`)).status).toBe(403);
    expect((await bob.req('GET', `${A}/logo`)).status).toBe(404);
    expect((await bob.req('PUT', `${A}/logo`, { data: png.toString('base64') })).status).toBe(404);
    expect((await app.inject({ method: 'GET', url: logoUrl })).statusCode).toBe(401);
    expect((await bob.ok('GET', B)).logoUrl).toBeNull();

    // Scripts dressed up as images are refused whatever they are called.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    for (const bad of [svg, html]) expect((await alice.req('PUT', `${A}/logo`, { data: bad.toString('base64') })).status).toBe(400);
    expect((await alice.req('PUT', `${A}/logo`, { data: Buffer.concat([png, Buffer.alloc(300_000)]).toString('base64') })).status).toBe(400);
    expect((await alice.req('PUT', `${A}/logo`, { data: '<svg onload=alert(1)>' })).status).toBe(400);

    await alice.ok('DELETE', `${A}/logo`);
    expect((await alice.ok('GET', A)).logoUrl).toBeNull();
  });

  it('cannot assign a driver from another organization', async () => {
    const detail = await bob.ok('GET', `${B}/transports/${bTransport}`);
    const res = await bob.req('POST', `${B}/transports/${bTransport}/legs/${detail.legs[0].id}/assign`, { userId: aDriverId });
    expect(res.status).toBe(400);
  });

  it('a driver cannot use coordinator features or see transports they were not asked about', async () => {
    const other = (await alice.ok('POST', `${A}/transports`, { title: 'Not for Dana', origin: DC, destination: RALEIGH, departAt: inDays(9) })).id;
    expect((await aDriver.req('GET', `${A}/transports/${other}`)).status).toBe(404);
    expect((await aDriver.req('GET', `${A}/transports`)).status).toBe(403);
    expect((await aDriver.req('GET', `${A}/drivers`)).status).toBe(403);
    expect((await aDriver.req('POST', `${A}/transports/${aTransport}/cancel`, {})).status).toBe(403);
    expect((await aDriver.req('PATCH', `${A}`, { name: 'Mine now' })).status).toBe(403);
  });

  describe('at the database level, as the app role', () => {
    const tenantTables = [
      'memberships',
      'driver_profiles',
      'transports',
      'transport_animals',
      'legs',
      'leg_offers',
      'transport_requests',
      'messages',
      'message_reads',
      'notifications',
      'org_logos',
      'leg_positions',
    ];

    it('the app role cannot bypass row-level security', async () => {
      const role = await raw.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('every table with an org_id column has forced row-level security', async () => {
      const res = await raw.query(`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`);
      expect(res.rows.map((r) => r.relname).sort()).toEqual([...tenantTables].sort());
      for (const row of res.rows) expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('returns no rows from any tenant table without an organization set', async () => {
      for (const table of tenantTables) {
        const res = await raw.query(`select count(*)::int as n from ${table}`);
        expect(res.rows[0].n, table).toBe(0);
      }
    });

    it("returns only one organization's rows once it is set, and blocks cross-organization writes", async () => {
      const orgs = await raw.query(`select id, slug from organizations order by slug`);
      const [a, b] = orgs.rows as { id: string }[];
      await raw.query('begin');
      await raw.query(`select set_config('app.org_id', $1, true)`, [b!.id]);
      for (const table of tenantTables) {
        const res = await raw.query(`select count(*)::int as n from ${table} where org_id <> $1`, [b!.id]);
        expect(res.rows[0].n, table).toBe(0);
      }
      expect((await raw.query(`select title from transports`)).rows).toEqual([{ title: 'B run' }]);
      expect((await raw.query(`update transports set title = 'hijacked' where id = $1`, [aTransport])).rowCount).toBe(0);
      expect((await raw.query(`delete from legs where id = $1`, [aLeg])).rowCount).toBe(0);
      await expect(
        raw.query(`insert into messages (org_id, transport_id, user_id, body) select $1, $2, id, 'x' from users limit 1`, [a!.id, aTransport]),
      ).rejects.toThrow(/row-level security/);
      await raw.query('rollback');
    });
  });
});
