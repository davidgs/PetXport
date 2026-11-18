import { eq } from 'drizzle-orm';
import * as webpush from 'web-push';
import { globalDb } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';
import { env, features } from '../env.js';

let configured = false;

/** Sends to every browser the user has enabled. Returns how many deliveries were accepted. */
export async function sendPush(userId: string, payload: { title: string; body: string; url: string | null }): Promise<number> {
  if (!features.push) return 0;
  if (!configured) {
    webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
    configured = true;
  }
  const subs = await globalDb.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 3600 },
      );
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // The browser has dropped this subscription.
      if (status === 404 || status === 410) {
        await globalDb.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
      } else throw err;
    }
  }
  return sent;
}
