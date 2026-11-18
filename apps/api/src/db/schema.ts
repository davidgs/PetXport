import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Every table with an `org_id` column gets row-level security applied by
// src/db/rls.sql on each migration run. Do not name a column `org_id` unless
// the table's rows belong to exactly one organization.

export const roleEnum = pgEnum('role', ['admin', 'coordinator', 'driver']);
export const memberStatusEnum = pgEnum('member_status', ['invited', 'active', 'disabled']);
export const animalSizeEnum = pgEnum('animal_size', ['small', 'medium', 'large', 'xlarge']);
export const transportStatusEnum = pgEnum('transport_status', [
  'draft',
  'recruiting',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
]);
export const legStatusEnum = pgEnum('leg_status', ['open', 'filled', 'in_progress', 'done']);
export const offerStatusEnum = pgEnum('offer_status', ['offered', 'accepted', 'declined', 'withdrawn']);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------- global tables (no org_id) ----------

export const organizations = pgTable('organizations', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  legTargetMiles: integer('leg_target_miles').notNull().default(100),
  legTargetMinutes: integer('leg_target_minutes').notNull().default(120),
  handoffBufferMinutes: integer('handoff_buffer_minutes').notNull().default(15),
  /** IANA zone used when writing times in emails and texts. */
  timezone: text('timezone').notNull().default('America/New_York'),
  /** Set by a platform admin to suspend the organization; its members can no longer open it. */
  disabledAt: ts('disabled_at'),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  /** Set once the person has proved they receive mail at this address (verification, invite or reset link). */
  emailVerifiedAt: ts('email_verified_at'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  /** Second step at sign-in: a code by email or text message. */
  twoFactor: text('two_factor', { enum: ['off', 'email', 'sms'] }).notNull().default('off'),
  /** Number confirmed for sign-in codes. Separate from the per-organization driver contact number. */
  phone: text('phone'),
  /** Number given when the account was created. Copied into the driver profile of each organization joined. */
  contactPhone: text('contact_phone'),
  /** When this person last ticked the box agreeing to text messages; kept as the record of consent. */
  smsConsentAt: ts('sms_consent_at'),
  /** When the person last changed their picture; null when they have none. Lets pages link to it without loading it. */
  photoUpdatedAt: ts('photo_updated_at'),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const authTokens = pgTable('auth_tokens', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['invite', 'reset', 'verify'] }).notNull(),
  // Deliberately not named org_id: this table is looked up before any org context exists.
  inviteOrgId: uuid('invite_org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

/**
 * Short-lived, single-use steps in signing in: an emailed or texted code, or a
 * passkey ceremony in progress. The id is handed to the browser as an opaque reference.
 */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['otp_login', 'otp_setup', 'passkey_register', 'passkey_login'] }).notNull(),
    /** For codes: a hash of the code. For passkeys: the WebAuthn challenge. */
    secret: text('secret').notNull(),
    data: jsonb('data').$type<{ channel?: 'email' | 'sms'; method?: 'email' | 'sms'; phone?: string }>(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('auth_challenges_user_idx').on(t.userId, t.createdAt)],
);

export const passkeys = pgTable(
  'passkeys',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: bytea('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: jsonb('transports').$type<string[]>(),
    name: text('name').notNull(),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('push_user_idx').on(t.userId)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    dedupeKey: text('dedupe_key').unique(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    runAt: ts('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lockedAt: ts('locked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_due_idx').on(t.status, t.runAt)],
);

// ---------- tenant tables (org_id + row-level security) ----------

const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    status: memberStatusEnum('status').notNull().default('active'),
    /**
     * The name this organization typed when adding the person. Shown until they join, so that
     * adding someone's email never reveals the name on an account they hold elsewhere.
     */
    displayName: text('display_name'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('memberships_org_user_idx').on(t.orgId, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const driverProfiles = pgTable(
  'driver_profiles',
  {
    id: id(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phone: text('phone'),
    homeAddress: text('home_address'),
    homeLat: doublePrecision('home_lat'),
    homeLng: doublePrecision('home_lng'),
    // The same address in pieces. home_address stays as the single line people read.
    homeStreet: text('home_street'),
    homeCity: text('home_city'),
    homeState: text('home_state'),
    homePostalCode: text('home_postal_code'),
    homeCountry: text('home_country'),
    maxMiles: integer('max_miles'),
    availability: text('availability'),
    vehicle: text('vehicle'),
    crateCapacity: integer('crate_capacity'),
    maxAnimalSize: animalSizeEnum('max_animal_size'),
    notes: text('notes'),
    notifyEmail: boolean('notify_email').notNull().default(true),
    notifySms: boolean('notify_sms').notNull().default(false),
    notifyPush: boolean('notify_push').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('driver_profiles_org_user_idx').on(t.orgId, t.userId)],
);

export const transports = pgTable(
  'transports',
  {
    id: id(),
    orgId: orgId(),
    title: text('title').notNull(),
    status: transportStatusEnum('status').notNull().default('draft'),
    originName: text('origin_name').notNull(),
    originLat: doublePrecision('origin_lat').notNull(),
    originLng: doublePrecision('origin_lng').notNull(),
    destName: text('dest_name').notNull(),
    destLat: doublePrecision('dest_lat').notNull(),
    destLng: doublePrecision('dest_lng').notNull(),
    departAt: ts('depart_at').notNull(),
    distanceM: integer('distance_m').notNull(),
    durationS: integer('duration_s').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('transports_org_depart_idx').on(t.orgId, t.departAt)],
);

export const transportAnimals = pgTable(
  'transport_animals',
  {
    id: id(),
    orgId: orgId(),
    transportId: uuid('transport_id')
      .notNull()
      .references(() => transports.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    species: text('species').notNull().default('Dog'),
    breed: text('breed'),
    size: animalSizeEnum('size').notNull().default('medium'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [index('animals_transport_idx').on(t.transportId)],
);

export const legs = pgTable(
  'legs',
  {
    id: id(),
    orgId: orgId(),
    transportId: uuid('transport_id')
      .notNull()
      .references(() => transports.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    startName: text('start_name').notNull(),
    startLat: doublePrecision('start_lat').notNull(),
    startLng: doublePrecision('start_lng').notNull(),
    endName: text('end_name').notNull(),
    endLat: doublePrecision('end_lat').notNull(),
    endLng: doublePrecision('end_lng').notNull(),
    distanceM: integer('distance_m').notNull(),
    durationS: integer('duration_s').notNull(),
    departAt: ts('depart_at').notNull(),
    arriveAt: ts('arrive_at').notNull(),
    geometry: jsonb('geometry').notNull().$type<[number, number][]>(),
    driverId: uuid('driver_id').references(() => users.id, { onDelete: 'set null' }),
    status: legStatusEnum('status').notNull().default('open'),
  },
  (t) => [uniqueIndex('legs_transport_seq_idx').on(t.transportId, t.seq), index('legs_driver_idx').on(t.driverId)],
);

/**
 * Where the animal is right now, while a driver has chosen to share it. One row per leg, holding
 * only the latest position; it is removed when sharing stops or the leg ends, so no trail is kept.
 */
export const legPositions = pgTable('leg_positions', {
  legId: uuid('leg_id')
    .primaryKey()
    .references(() => legs.id, { onDelete: 'cascade' }),
  orgId: orgId(),
  transportId: uuid('transport_id')
    .notNull()
    .references(() => transports.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  accuracyM: integer('accuracy_m'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
});

export const legOffers = pgTable(
  'leg_offers',
  {
    id: id(),
    orgId: orgId(),
    legId: uuid('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: offerStatusEnum('status').notNull().default('offered'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('leg_offers_leg_user_idx').on(t.legId, t.userId)],
);

/** An organization's uploaded logo. Kept out of `organizations` so the image is only loaded when it is served. */
export const orgLogos = pgTable('org_logos', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  data: bytea('data').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** A person's picture of themselves. Kept out of `users` so the image is only loaded when it is served. */
export const userPhotos = pgTable('user_photos', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  data: bytea('data').notNull(),
});

/** Which drivers were asked to volunteer for a transport. */
export const transportRequests = pgTable(
  'transport_requests',
  {
    id: id(),
    orgId: orgId(),
    transportId: uuid('transport_id')
      .notNull()
      .references(() => transports.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('transport_requests_idx').on(t.transportId, t.userId)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    orgId: orgId(),
    transportId: uuid('transport_id')
      .notNull()
      .references(() => transports.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('messages_transport_idx').on(t.transportId, t.createdAt)],
);

export const messageReads = pgTable(
  'message_reads',
  {
    orgId: orgId(),
    transportId: uuid('transport_id')
      .notNull()
      .references(() => transports.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: ts('last_read_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.transportId, t.userId] })],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    url: text('url'),
    /** Per-channel delivery result, e.g. { email: 'sent', sms: 'skipped', push: 'error: ...' }. */
    channels: jsonb('channels').$type<Record<string, string>>(),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);
