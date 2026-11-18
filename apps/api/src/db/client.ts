import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

const db = drizzle(pool, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The only way to reach organization data. Runs `fn` in a transaction scoped
 * to one organization; row-level security hides every other organization's rows.
 */
export function withOrg<T>(orgId: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId ?? ''}, true)`,
    );
    return fn(tx);
  });
}

/** Scoped to a user with no organization: can see that user's own memberships and nothing else tenant-owned. */
export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', '', true), set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * For the global tables only (users, sessions, organizations, auth_tokens,
 * push_subscriptions, jobs). Tenant tables queried through this return no rows.
 */
export const globalDb = db;

/**
 * The name to show for a member. Until someone has accepted their invitation
 * this is what the organization itself typed, never the name on an account
 * they may hold with another organization. Needs `memberships` and `users` in the query.
 */
export const shownName = sql<string>`case when ${schema.memberships.status} = 'invited' and ${schema.memberships.displayName} is not null then ${schema.memberships.displayName} else ${schema.users.name} end`;

export { schema };
