/**
 * One-off clean-up: `pnpm addresses:tidy`.
 *
 * Driver addresses saved before addresses were stored in pieces are one long line that
 * includes the neighbourhood and county. This looks each of them up again, fills in the
 * street, city, state and postal code, and replaces the line with the short form
 * ("1776 Pierre Place, Apex, NC 27502").
 *
 * It only queues the work; the running server performs the lookups (about one a second),
 * so start the server if it is not running. Run with the owner connection, because it has
 * to see every organization.
 */
import pg from 'pg';
import { env } from '../env.js';

if (!env.migrationDatabaseUrl) throw new Error('MIGRATION_DATABASE_URL is not set.');
const client = new pg.Client({ connectionString: env.migrationDatabaseUrl });
await client.connect();
const res = await client.query(`
  insert into jobs (kind, payload)
  select 'geocode_driver', jsonb_build_object('orgId', org_id, 'profileId', id, 'address', home_address, 'tidy', true)
  from driver_profiles
  where home_address is not null and home_address <> '' and home_city is null`);
await client.end();
console.log(`Queued ${res.rowCount} address${res.rowCount === 1 ? '' : 'es'} to tidy. They are updated as the server works through them.`);
