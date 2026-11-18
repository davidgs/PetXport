import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { env } from '../src/env.js';
import { resetLoginThrottle } from '../src/lib/auth.js';
import { drainJobs } from '../src/lib/jobs.js';
import { outbox } from '../src/notify/email.js';

export async function resetDb(): Promise<void> {
  const client = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await client.connect();
  await client.query('truncate organizations, users, jobs, auth_challenges cascade');
  await client.end();
  outbox.length = 0;
  resetLoginThrottle();
}

let app: FastifyInstance | null = null;
export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp();
  return app;
}

/** A logged-in browser, more or less: keeps its session cookie between requests. */
export class Agent {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async req<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.app.inject({
      method,
      url,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers['set-cookie'];
    const first = Array.isArray(set) ? set[0] : set;
    if (first) this.cookie = first.split(';')[0]!;
    let parsed: unknown = null;
    try {
      parsed = res.json();
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed as T };
  }

  /** Like req, but fails the test unless the response is 2xx. */
  async ok<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
    const res = await this.req<T>(method, url, body);
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
}

export async function signup(name: string, email: string): Promise<Agent> {
  const agent = new Agent(await getApp());
  await agent.ok('POST', '/api/auth/signup', { name, email, password: 'correct horse battery', phone: '(919) 555-0100' });
  // Signing up only sends a confirmation link; the account works once it is opened with the password.
  await drainJobs();
  await agent.ok('POST', '/api/auth/verify', { token: linkFor(email, 'verify'), password: 'correct horse battery' });
  return agent;
}

/** The secret from the most recent emailed link of this kind to this address. */
export function linkFor(email: string, kind: 'verify' | 'invite' | 'reset'): string {
  const mail = [...outbox].reverse().find((e) => e.to === email && e.text.includes(`/${kind}/`));
  if (!mail) throw new Error(`No ${kind} email for ${email}`);
  return mail.text.match(new RegExp(`/${kind}/([\\w-]+)`))![1]!;
}

export async function createOrg(agent: Agent, name: string, slug: string): Promise<string> {
  await agent.ok('POST', '/api/orgs', { name, slug });
  return `/api/o/${slug}`;
}

/** Adds a driver to the roster and returns an agent logged in as them (via the emailed invite). */
export async function addDriver(
  coordinator: Agent,
  base: string,
  name: string,
  email: string,
  profile: Record<string, unknown> = {},
): Promise<{ agent: Agent; userId: string }> {
  const { userId } = await coordinator.ok('POST', `${base}/drivers`, { name, email, ...profile });
  await drainJobs();
  const invite = [...outbox].reverse().find((e) => e.to === email && e.text.includes('/invite/'));
  if (!invite) throw new Error(`No invite email for ${email}`);
  const token = invite.text.match(/\/invite\/([\w-]+)/)![1]!;
  const agent = new Agent(await getApp());
  await agent.ok('POST', `/api/invites/${token}/accept`, { password: 'correct horse battery', phone: typeof profile.phone === 'string' ? profile.phone : '(919) 555-0100' });
  return { agent, userId };
}

export const RALEIGH = { name: 'Raleigh, NC', lat: 35.7796, lng: -78.6382 };
export const RICHMOND = { name: 'Richmond, VA', lat: 37.5407, lng: -77.436 };
export const DC = { name: 'Washington, DC', lat: 38.9072, lng: -77.0369 };
export const NYC = { name: 'New York, NY', lat: 40.7128, lng: -74.006 };

export const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
