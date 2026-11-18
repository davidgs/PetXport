import {
  createDriverSchema,
  driverProfileSchema,
  importDriversSchema,
  inviteDriversSchema,
  parseInviteList,
  parseCsv,
  type Driver,
  type DriverProfileInput,
} from '@petxport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { shownName, withOrg, type Tx } from '../db/client.js';
import { env } from '../env.js';
import { driverProfiles, memberships, users } from '../db/schema.js';
import { badRequest, notFound, orgCtx, parse, photoPath, requireManage, type OrgCtx } from '../lib/http.js';
import { enqueue, registerJob } from '../lib/jobs.js';
import { getProvider } from '../routing/index.js';
import { addMember, sendInvite } from './orgs.js';

/** Swaps the stored date for the picture's address. Like the name, it is not shown until the invitation is accepted. */
function withPhoto<T extends { userId: string; photoAt: Date | null; memberStatus: string }>(c: OrgCtx, row: T): Omit<T, 'photoAt'> & { photo: string | null } {
  const { photoAt, ...rest } = row;
  return { ...rest, photo: row.memberStatus === 'invited' ? null : photoPath(c.org.slug, row.userId, photoAt) };
}

function driverSelect(tx: Tx, c: OrgCtx) {
  return tx
    .select({
      userId: users.id,
      name: shownName,
      photoAt: users.photoUpdatedAt,
      email: users.email,
      memberStatus: memberships.status,
      role: memberships.role,
      phone: driverProfiles.phone,
      homeAddress: driverProfiles.homeAddress,
      homeLat: driverProfiles.homeLat,
      homeLng: driverProfiles.homeLng,
      homeStreet: driverProfiles.homeStreet,
      homeCity: driverProfiles.homeCity,
      homeState: driverProfiles.homeState,
      homePostalCode: driverProfiles.homePostalCode,
      homeCountry: driverProfiles.homeCountry,
      maxMiles: driverProfiles.maxMiles,
      availability: driverProfiles.availability,
      vehicle: driverProfiles.vehicle,
      crateCapacity: driverProfiles.crateCapacity,
      maxAnimalSize: driverProfiles.maxAnimalSize,
      notes: driverProfiles.notes,
      notifyEmail: driverProfiles.notifyEmail,
      notifySms: driverProfiles.notifySms,
      notifyPush: driverProfiles.notifyPush,
      active: driverProfiles.active,
    })
    .from(driverProfiles)
    .innerJoin(users, eq(users.id, driverProfiles.userId))
    .innerJoin(memberships, and(eq(memberships.userId, driverProfiles.userId), eq(memberships.orgId, driverProfiles.orgId)))
    .$dynamic();
}

/** Creates or updates a profile. An address without coordinates is geocoded in the background. */
async function saveProfile(tx: Tx, c: OrgCtx, userId: string, input: DriverProfileInput, self = false): Promise<void> {
  const [existing] = await tx.select().from(driverProfiles).where(eq(driverProfiles.userId, userId));
  const values: Partial<typeof driverProfiles.$inferInsert> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (values as Record<string, unknown>)[key] = value;
  }
  if (!self) {
    // Text messages cost money and need consent: only the person themself can switch them on,
    // and changing someone's number for them switches texts off until they confirm.
    if (!existing?.notifySms || ('phone' in values && values.phone !== existing.phone)) values.notifySms = false;
    else delete values.notifySms;
  } else if (!c.canManage) {
    // "Notes" is the coordinators' own record about a driver; the driver does not edit it.
    delete values.notes;
  }
  const addressChanged = 'homeAddress' in values && values.homeAddress !== existing?.homeAddress;
  const hasCoords = values.homeLat != null && values.homeLng != null;
  if (addressChanged && !hasCoords) {
    // Typed by hand or imported, not picked from the search: the old location and pieces no longer apply.
    values.homeLat = null;
    values.homeLng = null;
    Object.assign(values, { homeStreet: null, homeCity: null, homeState: null, homePostalCode: null, homeCountry: null });
  }
  if (self && values.notifySms && !existing?.notifySms) {
    // Ticking the box on your own profile is the agreement to be texted; keep the date as the record.
    await tx.update(users).set({ smsConsentAt: new Date() }).where(eq(users.id, userId));
  }
  let profileId = existing?.id;
  if (existing) {
    if (Object.keys(values).length > 0) await tx.update(driverProfiles).set(values).where(eq(driverProfiles.id, existing.id));
  } else {
    const [row] = await tx
      .insert(driverProfiles)
      .values({ ...values, orgId: c.org.id, userId })
      .returning({ id: driverProfiles.id });
    profileId = row!.id;
  }
  if (addressChanged && !hasCoords && values.homeAddress) {
    await enqueue(tx, 'geocode_driver', { orgId: c.org.id, profileId, address: values.homeAddress });
  }
}

registerJob('geocode_driver', async (payload) => {
  const { orgId, profileId, address, tidy } = payload as { orgId: string; profileId: string; address: string; tidy?: boolean };
  const [place] = await getProvider().geocode(address);
  if (!place) return;
  await withOrg(orgId, null, (tx) =>
    tx
      .update(driverProfiles)
      .set({
        homeLat: place.lat,
        homeLng: place.lng,
        homeStreet: place.parts?.street ?? null,
        homeCity: place.parts?.city ?? null,
        homeState: place.parts?.state ?? null,
        homePostalCode: place.parts?.postalCode ?? null,
        homeCountry: place.parts?.country ?? null,
        // What someone typed is normally left as they wrote it; `tidy` (see tidy-addresses.ts)
        // also replaces the stored line with the short form.
        ...(tidy ? { homeAddress: place.name } : {}),
      })
      // Only if the address has not been changed again since.
      .where(and(eq(driverProfiles.id, profileId), eq(driverProfiles.homeAddress, address))),
  );
});

const CSV_COLUMNS: Record<string, keyof DriverProfileInput | 'name' | 'email'> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  address: 'homeAddress',
  'home address': 'homeAddress',
  vehicle: 'vehicle',
  availability: 'availability',
  'max miles': 'maxMiles',
  'crate capacity': 'crateCapacity',
  notes: 'notes',
};

export async function driverRoutes(app: FastifyInstance): Promise<void> {
  app.get('/drivers', async (req): Promise<Driver[]> => {
    const c = orgCtx(req);
    requireManage(c);
    return (await c.db((tx) => driverSelect(tx, c).orderBy(users.name))).map((d) => withPhoto(c, d));
  });

  app.post('/drivers', { config: { rateLimit: { max: env.isTest ? 100_000 : 30, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { name, email, sendInvite: invite, ...profile } = parse(createDriverSchema, req.body);
    return c.db(async (tx) => {
      const { userId, created } = await addMember(tx, c, { name, email, role: 'driver' });
      const [existing] = await tx.select({ id: driverProfiles.id }).from(driverProfiles).where(eq(driverProfiles.userId, userId));
      if (existing) throw badRequest('That person is already on the driver list.');
      await saveProfile(tx, c, userId, profile);
      if (created && invite) await sendInvite(tx, c, userId);
      return { userId };
    });
  });

  app.post('/drivers/import', { config: { rateLimit: { max: env.isTest ? 100_000 : 5, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const input = parse(importDriversSchema, req.body);
    const rows = parseCsv(input.csv);
    const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
    if (!header.includes('name') || !header.includes('email')) {
      throw badRequest('The first row must be column names and include at least "name" and "email".');
    }
    if (rows.length > 2000) throw badRequest('Import at most 2,000 drivers at a time.');
    const skipped: { row: number; reason: string }[] = [];
    let added = 0;
    await c.db(async (tx) => {
      for (const [i, row] of rows.entries()) {
        const record: Record<string, unknown> = {};
        header.forEach((h, col) => {
          const key = CSV_COLUMNS[h];
          const value = row[col]?.trim();
          if (!key || !value) return;
          record[key] = key === 'maxMiles' || key === 'crateCapacity' ? Number(value) : value;
        });
        const parsed = createDriverSchema.safeParse({ ...record, sendInvite: input.sendInvites });
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          skipped.push({ row: i + 2, reason: `${issue?.path.join('.') || 'row'}: ${issue?.message ?? 'invalid'}` });
          continue;
        }
        const { name, email, sendInvite: invite, ...profile } = parsed.data;
        const { userId, created } = await addMember(tx, c, { name, email, role: 'driver' });
        const [existing] = await tx.select({ id: driverProfiles.id }).from(driverProfiles).where(eq(driverProfiles.userId, userId));
        if (existing) {
          skipped.push({ row: i + 2, reason: `${email} is already on the driver list` });
          continue;
        }
        await saveProfile(tx, c, userId, profile);
        if (created && invite) await sendInvite(tx, c, userId);
        added++;
      }
    });
    return { added, skipped };
  });

  /**
   * The quick way to grow the roster: paste email addresses, and each person
   * gets a link to set a password and fill in their own driver details.
   */
  app.post('/drivers/invite', { config: { rateLimit: { max: env.isTest ? 100_000 : 5, timeWindow: '1 minute' } } }, async (req) => {
    const c = orgCtx(req);
    requireManage(c);
    const { people, invalid } = parseInviteList(parse(inviteDriversSchema, req.body).emails);
    if (people.length > 500) throw badRequest('Invite at most 500 people at a time.');
    const skipped: { email: string; reason: string }[] = invalid.map((entry) => ({ email: entry, reason: 'not an email address' }));
    let invited = 0;
    await c.db(async (tx) => {
      for (const person of people) {
        const { userId } = await addMember(tx, c, { ...person, role: 'driver' });
        const [member] = await tx
          .select({ status: memberships.status })
          .from(memberships)
          .where(and(eq(memberships.orgId, c.org.id), eq(memberships.userId, userId)));
        if (member?.status === 'disabled') {
          skipped.push({ email: person.email, reason: 'was removed from this organization; restore them in Settings first' });
          continue;
        }
        const [profile] = await tx.select({ id: driverProfiles.id }).from(driverProfiles).where(eq(driverProfiles.userId, userId));
        if (!profile) await saveProfile(tx, c, userId, {} as DriverProfileInput);
        if (member?.status === 'active') {
          skipped.push({ email: person.email, reason: profile ? 'already on the team' : 'already on the team; added to the driver list' });
          continue;
        }
        // Still "invited": a fresh link is sent, which also covers reminding someone.
        await sendInvite(tx, c, userId);
        invited++;
      }
    });
    return { invited, skipped };
  });

  app.get('/drivers/:userId', async (req): Promise<Driver> => {
    const c = orgCtx(req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    if (userId !== c.user.id) requireManage(c);
    const [found] = await c.db((tx) => driverSelect(tx, c).where(eq(driverProfiles.userId, userId)));
    if (!found) throw notFound('No driver profile yet.');
    const row = withPhoto(c, found);
    // Coordinators' notes about a driver are not shown to that driver.
    return c.canManage ? row : { ...row, notes: null };
  });

  app.put('/drivers/:userId', async (req) => {
    const c = orgCtx(req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    const isSelf = userId === c.user.id;
    if (!isSelf) requireManage(c);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parse(driverProfileSchema, body);
    return c.db(async (tx) => {
      const [member] = await tx
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.orgId, c.org.id), eq(memberships.userId, userId)));
      if (!member) throw notFound();
      await saveProfile(tx, c, userId, input, isSelf);
      const newName = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) : '';
      if (newName && c.canManage && !isSelf && member.status === 'invited') {
        // Coordinators may correct the name they entered for someone who has not joined yet.
        // This only changes how this organization sees them, never the person's own account.
        await tx.update(memberships).set({ displayName: newName }).where(eq(memberships.id, member.id));
      }
      return { ok: true };
    });
  });
}
