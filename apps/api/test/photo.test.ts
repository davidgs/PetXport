import { beforeAll, describe, expect, it } from 'vitest';
import { addDriver, createOrg, getApp, resetDb, signup, type Agent } from './helpers.js';

// The smallest thing the server accepts as a PNG: the signature plus padding.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]).toString('base64');

const fetchAs = async (agent: Agent, url: string) => (await getApp()).inject({ method: 'GET', url, headers: { cookie: agent.cookie } });

describe('pictures of people', () => {
  let ada: Agent;
  let dan: Agent;
  let danId: string;
  let outsider: Agent;
  const A = '/api/o/alpha';

  beforeAll(async () => {
    await resetDb();
    ada = await signup('Ada Admin', 'ada@alpha.example');
    await createOrg(ada, 'Alpha Rescue', 'alpha');
    ({ agent: dan, userId: danId } = await addDriver(ada, A, 'Dan Driver', 'dan@drivers.example'));
    outsider = await signup('Olive Other', 'olive@other.example');
    await createOrg(outsider, 'Other Rescue', 'other');
  });

  it('starts with none', async () => {
    expect((await dan.ok('GET', '/api/me')).user.photo).toBeNull();
    expect((await fetchAs(dan, '/api/me/photo')).statusCode).toBe(404);
    expect((await ada.ok('GET', `${A}/drivers`)).find((d: any) => d.userId === danId).photo).toBeNull();
  });

  it('refuses things that are not pictures', async () => {
    expect((await dan.req('PUT', '/api/me/photo', { data: Buffer.from('<svg onload=alert(1)>   ').toString('base64') })).status).toBe(400);
    expect((await dan.req('PUT', '/api/me/photo', { data: 'not base64!' })).status).toBe(400);
  });

  it('lets someone add a picture that their own rescue can see, and nobody else', async () => {
    await dan.ok('PUT', '/api/me/photo', { data: PNG });
    const mine = (await dan.ok('GET', '/api/me')).user.photo as string;
    expect(mine).toMatch(/^\/api\/me\/photo\?v=\d+$/);
    const own = await fetchAs(dan, mine);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('image/png');
    expect(own.headers['content-security-policy']).toContain('sandbox');

    const listed = (await ada.ok('GET', `${A}/drivers`)).find((d: any) => d.userId === danId).photo as string;
    expect(listed).toMatch(new RegExp(`^${A}/people/${danId}/photo\\?v=\\d+$`));
    expect((await fetchAs(ada, listed)).statusCode).toBe(200);
    expect((await ada.ok('GET', `${A}/members`)).find((m: any) => m.userId === danId).photo).toBe(listed);

    // Another rescue cannot fetch it, through its own address or Dan's.
    expect((await fetchAs(outsider, listed)).statusCode).toBe(404);
    expect((await fetchAs(outsider, `/api/o/other/people/${danId}/photo`)).statusCode).toBe(404);
    expect((await (await getApp()).inject({ method: 'GET', url: listed })).statusCode).toBe(401);
  });

  it('lets them take it down again', async () => {
    await dan.ok('DELETE', '/api/me/photo');
    expect((await dan.ok('GET', '/api/me')).user.photo).toBeNull();
    expect((await fetchAs(ada, `${A}/people/${danId}/photo`)).statusCode).toBe(404);
  });
});
