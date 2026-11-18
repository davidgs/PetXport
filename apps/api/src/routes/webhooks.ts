import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { notFound } from '../lib/http.js';
import { stopTexts } from '../notify/stop.js';

/** Brevo's `msg_status` for a STOP reply, and for a send refused because the number had already stopped. */
const STOPPED = new Set(['unsubscribed', 'unsubscribe', 'bl', 'blacklisted']);

/** What carriers treat as opting out, whatever status Brevo files the reply under. */
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);

function secretMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(env.brevoWebhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /** Called by Brevo for text-message events. Brevo proves itself with the shared secret. */
  app.post('/api/webhooks/brevo/sms', async (req) => {
    const auth = req.headers.authorization ?? '';
    const header = req.headers['x-webhook-secret'];
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : typeof header === 'string' ? header : '';
    // Looks like any other missing page to someone guessing.
    if (!env.brevoWebhookSecret || !secretMatches(given)) throw notFound();

    if (env.brevoWebhookDebug) req.log.info({ payload: req.body }, 'brevo webhook payload');
    const events = Array.isArray(req.body) ? req.body : [req.body];
    let stopped = 0;
    for (const e of events as (Record<string, unknown> | null)[]) {
      if (!e || typeof e !== 'object') continue;
      const status = typeof e.msg_status === 'string' ? e.msg_status : '';
      // The word the person texted back, when Brevo passes it on. Only a single short word is
      // kept, so nothing anyone wrote in a longer reply reaches the log.
      const word = typeof e.reply === 'string' && /^[a-z]{1,12}$/i.test(e.reply.trim()) ? e.reply.trim().toUpperCase() : '';
      const hasNumber = typeof e.to === 'string' || typeof e.to === 'number';
      if (hasNumber && (STOPPED.has(status) || STOP_WORDS.has(word))) {
        const n = await stopTexts(String(e.to));
        stopped += n;
        req.log.info({ status, word, profiles: n }, 'texts stopped after a STOP reply');
      } else {
        // No numbers: just enough to see what Brevo calls each event.
        req.log.info({ status: status || (e.event ?? null), word, description: typeof e.description === 'string' ? e.description.slice(0, 40) : null, fields: Object.keys(e) }, 'text event ignored');
      }
    }
    return { ok: true, stopped };
  });
}
