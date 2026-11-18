/**
 * Fills a development database with a demo rescue so there is something to
 * look at: `pnpm seed`. Refuses to run in production.
 *
 * Demo logins (all use the password below):
 *   coordinator  casey@demo.test
 *   drivers      ravi@demo.test, maya@demo.test, noor@demo.test, theo@demo.test, ines@demo.test
 */
import { buildApp } from '../app.js';
import { env } from '../env.js';
import { drainJobs } from '../lib/jobs.js';
import { outbox } from '../notify/email.js';
import { pool } from './client.js';

const PASSWORD = 'demo-password-123';
const SLUG = 'demo-rescue';

if (env.isProduction) throw new Error('The seed script is for development only.');
// It creates accounts whose password is written in this file, so it only ever touches a development database.
const dbName = new URL(env.databaseUrl).pathname.replace(/^\//, '');
if (!/_(dev|test)$/.test(dbName)) throw new Error(`Refusing to seed "${dbName}": the demo data is only for databases whose name ends in _dev or _test.`);
if (env.smtpUrl) throw new Error('Unset SMTP_URL before seeding, so demo invitations are not really emailed.');

// The demo coordinator creates their own organization, which is normally by invitation only.
env.allowOrgSignup = true;

const app = await buildApp();
const log = console.log;
console.log = () => undefined; // keep the demo emails out of the terminal

async function call(cookie: string, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  return { body: res.json(), cookie: first ? first.split(';')[0]! : cookie };
}

const existing = await pool.query('select 1 from organizations where slug = $1', [SLUG]);
if (existing.rowCount) {
  log(`The demo organization already exists at /o/${SLUG}. Nothing to do.`);
} else {
  await call('', 'POST', '/api/auth/signup', { name: 'Casey Coordinator', email: 'casey@demo.test', password: PASSWORD, phone: '(919) 555-0100' });
  await drainJobs();
  const verifyToken = [...outbox].reverse().find((e) => e.to === 'casey@demo.test')!.text.match(/\/verify\/([\w-]+)/)![1];
  const casey = (await call('', 'POST', '/api/auth/verify', { token: verifyToken, password: PASSWORD })).cookie;
  await call(casey, 'POST', '/api/orgs', { name: 'Demo Rescue', slug: SLUG });
  const O = `/api/o/${SLUG}`;

  const roster = [
    ['Ravi Patel', 'ravi', 'Raleigh, NC', 35.7796, -78.6382, 'Honda CR-V', 'large'],
    ['Maya Brooks', 'maya', 'South Hill, VA', 36.7265, -78.1289, 'Subaru Outback', 'xlarge'],
    ['Noor Haddad', 'noor', 'Fredericksburg, VA', 38.3032, -77.4605, 'Toyota Sienna', 'xlarge'],
    ['Theo Lindqvist', 'theo', 'Baltimore, MD', 39.2904, -76.6122, 'Ford Escape', 'medium'],
    ['Ines Moreau', 'ines', 'Cherry Hill, NJ', 39.9268, -75.0246, 'Kia Soul', 'large'],
  ] as const;
  const drivers: { cookie: string; userId: string }[] = [];
  for (const [name, id, town, lat, lng, vehicle, size] of roster) {
    const email = `${id}@demo.test`;
    const { body } = await call(casey, 'POST', `${O}/drivers`, {
      name,
      email,
      phone: `919-555-01${10 + drivers.length}`,
      homeAddress: town,
      homeLat: lat,
      homeLng: lng,
      maxMiles: 60,
      vehicle,
      crateCapacity: 2,
      maxAnimalSize: size,
      availability: 'Weekends',
    });
    await drainJobs();
    const token = [...outbox].reverse().find((e) => e.to === email)!.text.match(/\/invite\/([\w-]+)/)![1];
    const accepted = await call('', 'POST', `/api/invites/${token}/accept`, { password: PASSWORD, phone: '(919) 555-0101' });
    drivers.push({ cookie: accepted.cookie, userId: body.userId });
  }

  const depart = new Date(Date.now() + 6 * 86400_000);
  depart.setHours(8, 0, 0, 0);
  log('Planning a demo route (uses the routing service, may take a few seconds)…');
  const { body: created } = await call(casey, 'POST', `${O}/transports`, {
    title: 'Biscuit and Gravy to their foster in Brooklyn',
    origin: { name: 'Raleigh, NC', lat: 35.7796, lng: -78.6382 },
    destination: { name: 'Brooklyn, NY', lat: 40.6526, lng: -73.9497 },
    departAt: depart.toISOString(),
    notes: 'Paperwork travels in the blue folder. Please send a photo to the team chat at each handoff.',
    animals: [
      { name: 'Biscuit', breed: 'Beagle mix', size: 'small', notes: 'Shy at first. Loves cheese.' },
      { name: 'Gravy', breed: 'Lab mix', size: 'large', notes: 'Gets car sick: no food 2 hours before.' },
    ],
  });
  const T = `${O}/transports/${created.id}`;
  await call(casey, 'POST', `${T}/request-volunteers`, { audience: 'all', message: 'Two sweet dogs heading to a wonderful foster. Any leg helps!' });
  const { body: detail } = await call(casey, 'GET', T);
  const legs = detail.legs as { id: string }[];
  // Leg 1 is confirmed, leg 2 has two offers waiting, the rest are open.
  if (legs[0]) await call(casey, 'POST', `${T}/legs/${legs[0].id}/assign`, { userId: drivers[0]!.userId });
  if (legs[1]) {
    await call(drivers[1]!.cookie, 'POST', `${T}/legs/${legs[1].id}/offers`, { note: 'I have a large crate.' });
    await call(drivers[2]!.cookie, 'POST', `${T}/legs/${legs[1].id}/offers`, {});
  }
  await call(casey, 'POST', `${T}/messages`, { body: 'Thanks for taking the first leg, Ravi! I will bring the dogs to the pickup at 7:45.' });
  await call(drivers[0]!.cookie, 'POST', `${T}/messages`, { body: 'Happy to help. See you then.' });
  await drainJobs();
  log(`Done. Log in as casey@demo.test and open /o/${SLUG}. The demo password is at the top of apps/api/src/db/seed.ts.`);
}

await app.close();
await pool.end();
