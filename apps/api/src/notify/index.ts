import { and, eq, gt, sql } from 'drizzle-orm';
import { withOrg, type Tx } from '../db/client.js';
import { driverProfiles, legs, memberships, notifications, organizations, transports, users } from '../db/schema.js';
import { env, features } from '../env.js';
import { enqueue, registerJob } from '../lib/jobs.js';
import { sendEmail } from './email.js';
import { sendPush } from './push.js';
import { sendSms } from './sms.js';

export interface NotificationInput {
  orgId: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  /** App path, e.g. /o/my-rescue/transports/<id>. */
  url?: string | null;
  /**
   * Skip if the same notice (kind, title, link) already went to this person within this many
   * minutes. Used where the recipient did not cause the event, so someone toggling a button
   * cannot flood a coordinator's inbox or phone.
   */
  dedupeMinutes?: number;
}

/** Records an in-app notification and queues delivery on the user's chosen channels. */
export async function notify(tx: Tx, { dedupeMinutes, ...input }: NotificationInput): Promise<void> {
  if (dedupeMinutes) {
    const [recent] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, input.userId),
          eq(notifications.kind, input.kind),
          eq(notifications.title, input.title),
          gt(notifications.createdAt, new Date(Date.now() - dedupeMinutes * 60_000)),
        ),
      )
      .limit(1);
    if (recent) return;
  }
  const [row] = await tx
    .insert(notifications)
    .values({ ...input, url: input.url ?? null })
    .returning({ id: notifications.id });
  await enqueue(tx, 'deliver', { orgId: input.orgId, notificationId: row!.id });
}

export async function notifyMany(tx: Tx, userIds: Iterable<string>, input: Omit<NotificationInput, 'userId'>): Promise<void> {
  for (const userId of new Set(userIds)) await notify(tx, { ...input, userId });
}

registerJob('email', async (payload) => {
  await sendEmail(payload as { to: string; subject: string; text: string });
});

registerJob('deliver', async (payload) => {
  const { orgId, notificationId } = payload as { orgId: string; notificationId: string };
  const data = await withOrg(orgId, null, async (tx) => {
    const [n] = await tx.select().from(notifications).where(eq(notifications.id, notificationId));
    if (!n) return null;
    const [user] = await tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, n.userId));
    const [profile] = await tx.select().from(driverProfiles).where(eq(driverProfiles.userId, n.userId));
    const [member] = await tx
      .select({ status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, n.userId)));
    const [org] = await tx
      .select({ name: organizations.name, disabledAt: organizations.disabledAt })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    // Chat falls back to email at most once an hour per conversation.
    const [recentChatEmail] =
      n.kind === 'chat_message'
        ? await tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, n.userId),
                eq(notifications.kind, 'chat_message'),
                eq(notifications.url, n.url ?? ''),
                gt(notifications.createdAt, new Date(Date.now() - 3600_000)),
                sql`${notifications.channels}->>'email' = 'sent'`,
              ),
            )
            .limit(1)
        : [];
    return { n, user, profile, org, member, recentChatEmail: Boolean(recentChatEmail) };
  });
  if (!data?.user || !data.org) return;
  // Removed from the organization (or the organization suspended) since this was queued.
  if (!data.member || data.member.status === 'disabled' || data.org.disabledAt) return;
  const { n, user, profile, org } = data;
  const link = n.url ? `${env.appUrl}${n.url}` : env.appUrl;
  const result: Record<string, string> = {};
  const attempt = async (channel: string, fn: () => Promise<string>) => {
    try {
      result[channel] = await fn();
    } catch (err) {
      result[channel] = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
  };

  const wantsPush = features.push && (profile?.notifyPush ?? true);
  let pushed = 0;
  if (wantsPush) {
    await attempt('push', async () => {
      pushed = await sendPush(n.userId, { title: n.title, body: n.body, url: n.url });
      return pushed > 0 ? 'sent' : 'no devices';
    });
  }

  const isChat = n.kind === 'chat_message';
  const wantsEmail = (profile?.notifyEmail ?? true) && (!isChat || (pushed === 0 && !data.recentChatEmail));
  if (wantsEmail) {
    await attempt('email', async () => {
      await sendEmail({
        to: user.email,
        subject: `[${org.name}] ${n.title}`,
        text: `Hi ${user.name},\n\n${n.body}\n\n${link}\n\n— ${org.name}, via PetXport`,
      });
      return 'sent';
    });
  }

  if (!isChat && features.sms && profile?.notifySms && profile.phone) {
    await attempt('sms', async () => {
      // A ceiling on what one organization can spend in a day, whatever happens.
      const sentToday = await withOrg(orgId, null, (tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(notifications)
          .where(and(gt(notifications.createdAt, new Date(Date.now() - 86400_000)), sql`${notifications.channels}->>'sms' = 'sent'`)),
      );
      if ((sentToday[0]?.n ?? 0) >= env.smsDailyLimitPerOrg) return 'skipped: daily limit reached';
      await sendSms(profile.phone!, `${org.name}: ${n.title}. ${link} Reply STOP to stop these texts.`);
      return 'sent';
    });
  }

  await withOrg(orgId, null, (tx) => tx.update(notifications).set({ channels: result }).where(eq(notifications.id, n.id)));
});

// ---------- reminders ----------

const REMINDERS = [
  { which: 'day', leadMs: 24 * 3600_000, label: 'tomorrow' },
  { which: 'soon', leadMs: 2 * 3600_000, label: 'in about 2 hours' },
] as const;

/** Queues reminders for every assigned leg of a scheduled transport. Safe to call repeatedly. */
export async function scheduleReminders(tx: Tx, orgId: string, transportId: string): Promise<void> {
  const rows = await tx.select().from(legs).where(eq(legs.transportId, transportId));
  for (const leg of rows) {
    if (!leg.driverId) continue;
    for (const r of REMINDERS) {
      const runAt = new Date(leg.departAt.getTime() - r.leadMs);
      if (runAt.getTime() < Date.now()) continue;
      const departAt = leg.departAt.toISOString();
      await enqueue(
        tx,
        'reminder',
        { orgId, legId: leg.id, driverId: leg.driverId, departAt, which: r.which },
        { runAt, dedupeKey: `reminder:${leg.id}:${leg.driverId}:${departAt}:${r.which}` },
      );
    }
  }
}

registerJob('reminder', async (payload) => {
  const p = payload as { orgId: string; legId: string; driverId: string; departAt: string; which: string };
  await withOrg(p.orgId, null, async (tx) => {
    const [row] = await tx
      .select({ leg: legs, transport: transports, slug: organizations.slug, timezone: organizations.timezone })
      .from(legs)
      .innerJoin(transports, eq(transports.id, legs.transportId))
      .innerJoin(organizations, eq(organizations.id, legs.orgId))
      .where(eq(legs.id, p.legId));
    // Skip if the leg was reassigned, rescheduled or the transport is no longer going ahead.
    if (!row || row.leg.driverId !== p.driverId || row.leg.departAt.toISOString() !== p.departAt) return;
    if (row.transport.status !== 'scheduled' && row.transport.status !== 'in_progress') return;
    const label = REMINDERS.find((r) => r.which === p.which)?.label ?? 'soon';
    await notify(tx, {
      orgId: p.orgId,
      userId: p.driverId,
      kind: 'reminder',
      title: `Reminder: your transport leg is ${label}`,
      body: `You are driving leg ${row.leg.seq} of "${row.transport.title}": ${row.leg.startName} to ${row.leg.endName}, leaving ${formatWhen(row.leg.departAt, row.timezone)}.`,
      url: `/o/${row.slug}/transports/${row.transport.id}`,
    });
  });
});

export function formatWhen(d: Date, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return d.toLocaleString('en-US', { ...opts, timeZone });
  } catch {
    return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
  }
}
