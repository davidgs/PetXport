import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env, repoRoot } from '../env.js';

const apiRoot = path.join(repoRoot, 'apps/api');

/**
 * Runs the SQL files in `migrations/` that have not been run yet, in the order listed in
 * meta/_journal.json (both are written by `pnpm db:generate`). Each file is applied in one
 * transaction together with its record, so a failure leaves nothing half-done.
 *
 * The record lives in an ordinary table in the public schema. A separate schema would need
 * the CREATE privilege on the whole database, which managed hosting panels do not give the
 * database's own login.
 */
async function applyMigrations(client: pg.Client, folder: string): Promise<number> {
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  await client.query('create table if not exists public.schema_migrations (tag text primary key, applied_at timestamptz not null default now())');

  const done = new Set((await client.query('select tag from public.schema_migrations')).rows.map((r) => r.tag as string));
  if (done.size === 0) {
    // A database set up by earlier versions kept its record in drizzle's own table; carry it over.
    const old = await client.query("select to_regclass('drizzle.__drizzle_migrations') as t");
    if (old.rows[0].t) {
      const n = Number((await client.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n);
      for (const e of entries.slice(0, n)) {
        await client.query('insert into public.schema_migrations (tag) values ($1) on conflict do nothing', [e.tag]);
        done.add(e.tag);
      }
    }
  }

  let applied = 0;
  for (const entry of entries) {
    if (done.has(entry.tag)) continue;
    const statements = readFileSync(path.join(folder, `${entry.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .map((q) => q.trim())
      .filter(Boolean);
    await client.query('begin');
    try {
      for (const statement of statements) await client.query(statement);
      await client.query('insert into public.schema_migrations (tag) values ($1)', [entry.tag]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Database change ${entry.tag} failed: ${(err as Error).message}`);
    }
    applied++;
  }
  return applied;
}

/**
 * Creates/updates tables, makes sure the restricted app role exists, and
 * (re)applies row-level security to every tenant table.
 */
export async function runMigrations(log: (msg: string) => void = console.log): Promise<void> {
  if (!env.migrationDatabaseUrl) {
    throw new Error('MIGRATION_DATABASE_URL is not set. It must be an owner connection to the database.');
  }
  const app = new URL(env.databaseUrl);
  const appRole = decodeURIComponent(app.username);
  const appPassword = decodeURIComponent(app.password);
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) {
    throw new Error(`The role name in DATABASE_URL ("${appRole}") must be lowercase letters, digits and underscores.`);
  }

  const client = new pg.Client({ connectionString: env.migrationDatabaseUrl });
  await client.connect();
  try {
    const owner = (await client.query('select current_user as u')).rows[0].u as string;
    if (owner === appRole) {
      throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL must use different roles; the app role must not own the tables.');
    }

    const applied = await applyMigrations(client, path.join(apiRoot, 'migrations'));
    log(applied > 0 ? `Applied ${applied} database change${applied === 1 ? '' : 's'}.` : 'Tables are up to date.');

    const role = await client.query('select rolsuper, rolbypassrls from pg_roles where rolname = $1', [appRole]);
    if (role.rowCount === 0) {
      try {
        const quoted = (await client.query('select quote_literal($1) as q', [appPassword])).rows[0].q as string;
        await client.query(`create role ${appRole} login password ${quoted}`);
        log(`Created database role ${appRole}.`);
      } catch (err) {
        throw new Error(
          `Role ${appRole} does not exist and could not be created (${(err as Error).message}). ` +
            `Create it yourself with: CREATE ROLE ${appRole} LOGIN PASSWORD '...'; then run this again.`,
        );
      }
    } else if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
      throw new Error(`Role ${appRole} is a superuser or has BYPASSRLS, which would defeat organization isolation.`);
    }

    const dbName = (await client.query('select current_database() as d')).rows[0].d as string;
    await client.query(`grant connect on database "${dbName.replace(/"/g, '""')}" to ${appRole}`);

    const srcSql = path.join(apiRoot, 'src/db/rls.sql');
    const distSql = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rls.sql');
    const rls = readFileSync(existsSync(srcSql) ? srcSql : distSql, 'utf8').replaceAll(':APP_ROLE', appRole);
    await client.query(rls);
    log('Row-level security applied to all organization tables.');
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runMigrations().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
