import { and, eq, inArray, or, sql, type AnyColumn } from 'drizzle-orm';
import { globalDb, withOrg } from '../db/client.js';
import { driverProfiles, organizations, users } from '../db/schema.js';

/** A stored number as Brevo writes it: digits only, with the country code (bare 10-digit numbers are US/Canada). */
const asDigits = (col: AnyColumn) =>
  sql`(case when length(regexp_replace(${col}, '\\D', '', 'g')) = 10 then '1' else '' end || regexp_replace(${col}, '\\D', '', 'g'))`;

/**
 * Someone replied STOP (Brevo told us, or refused to text them because they had): stop texting that number everywhere, and say so on their profile.
 * Returns how many driver profiles were switched off.
 */
export async function stopTexts(to: string): Promise<number> {
  const digits = to.replace(/\D/g, '');
  if (digits.length < 8) return 0;

  // Driver profiles belong to organizations, and each organization's rows are only reachable one at a time.
  const orgs = await globalDb.select({ id: organizations.id }).from(organizations);
  const userIds = new Set<string>();
  let profiles = 0;
  for (const org of orgs) {
    const rows = await withOrg(org.id, null, (tx) =>
      tx
        .update(driverProfiles)
        .set({ notifySms: false })
        .where(and(eq(driverProfiles.notifySms, true), sql`${asDigits(driverProfiles.phone)} = ${digits}`))
        .returning({ userId: driverProfiles.userId }),
    );
    profiles += rows.length;
    for (const r of rows) userIds.add(r.userId);
  }

  // The agreement to be texted is withdrawn, so it is not carried into the next organization they join.
  await globalDb
    .update(users)
    .set({ smsConsentAt: null })
    .where(or(sql`${asDigits(users.contactPhone)} = ${digits}`, userIds.size ? inArray(users.id, [...userIds]) : sql`false`));
  // Sign-in codes can no longer reach this number either; send them by email so nobody is locked out.
  await globalDb
    .update(users)
    .set({ twoFactor: 'email' })
    .where(and(eq(users.twoFactor, 'sms'), sql`${asDigits(users.phone)} = ${digits}`));
  return profiles;
}
