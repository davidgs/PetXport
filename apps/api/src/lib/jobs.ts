import { sql } from 'drizzle-orm';
import { globalDb, type Tx } from '../db/client.js';
import { jobs } from '../db/schema.js';

type JobHandler = (payload: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, JobHandler>();

export function registerJob(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

/** Queue work. Pass the current transaction so the job only exists if the transaction commits. */
export async function enqueue(
  db: Tx | typeof globalDb,
  kind: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string } = {},
): Promise<void> {
  await db
    .insert(jobs)
    .values({ kind, payload, runAt: opts.runAt ?? new Date(), dedupeKey: opts.dedupeKey ?? null })
    .onConflictDoNothing({ target: jobs.dedupeKey });
}

const MAX_ATTEMPTS = 5;

/** Runs every job that is due. Returns how many were processed. */
export async function runDueJobs(limit = 20): Promise<number> {
  const claimed = await globalDb.execute<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number }>(sql`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
    where id in (
      select id from jobs
      where (status = 'pending' and run_at <= now())
         or (status = 'running' and locked_at < now() - interval '5 minutes')
      -- Bulk address lookups never hold up emails, notifications and reminders.
      order by (kind = 'geocode_driver'), run_at
      limit ${limit}
      for update skip locked
    )
    returning id, kind, payload, attempts`);
  for (const job of claimed.rows) {
    try {
      const handler = handlers.get(job.kind);
      if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
      await handler(job.payload);
      // Emails carry sign-in links; nothing readable is kept once the job is finished.
      await globalDb.execute(sql`update jobs set status = 'done', last_error = null, payload = '{}'::jsonb where id = ${job.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= MAX_ATTEMPTS) {
        await globalDb.execute(sql`update jobs set status = 'failed', last_error = ${message}, payload = '{}'::jsonb where id = ${job.id}`);
      } else {
        const delaySeconds = 30 * 2 ** job.attempts;
        await globalDb.execute(sql`
          update jobs set status = 'pending', last_error = ${message},
            run_at = now() + make_interval(secs => ${delaySeconds})
          where id = ${job.id}`);
      }
    }
  }
  return claimed.rows.length;
}

/** Runs jobs until none are due. Used by tests. */
export async function drainJobs(): Promise<void> {
  while ((await runDueJobs()) > 0);
}

let timer: NodeJS.Timeout | null = null;

export function startWorker(intervalMs = 2000, onError: (err: unknown) => void = console.error): void {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueJobs();
      // Finished jobs are kept for a while so dedupe keys keep working.
      await globalDb.execute(sql`delete from jobs where status = 'done' and created_at < now() - interval '30 days'`);
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
  }, intervalMs);
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
