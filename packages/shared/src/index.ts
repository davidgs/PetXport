import { z } from 'zod';

// ---------- constants ----------

export const ROLES = ['admin', 'coordinator', 'driver'] as const;
export type Role = (typeof ROLES)[number];

export const MEMBER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const ANIMAL_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
export type AnimalSize = (typeof ANIMAL_SIZES)[number];
export const ANIMAL_SIZE_LABELS: Record<AnimalSize, string> = {
  small: 'Small (under 25 lb)',
  medium: 'Medium (25–50 lb)',
  large: 'Large (50–90 lb)',
  xlarge: 'Extra large (90 lb+)',
};

export const TRANSPORT_STATUSES = [
  'draft',
  'recruiting',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type TransportStatus = (typeof TRANSPORT_STATUSES)[number];
export const TRANSPORT_STATUS_LABELS: Record<TransportStatus, string> = {
  draft: 'Draft',
  recruiting: 'Needs drivers',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const LEG_STATUSES = ['open', 'filled', 'in_progress', 'done'] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

export const OFFER_STATUSES = ['offered', 'accepted', 'declined', 'withdrawn'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const METERS_PER_MILE = 1609.344;

// ---------- input schemas ----------

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Use at least 10 characters').max(200);
/** No control characters: these values end up in email subjects and text messages. */
const noControl = /^[^\u0000-\u001f\u007f]*$/;
const name = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(120)
  .regex(noControl, 'Remove line breaks and control characters')
  // Names are quoted in emails to other people; a web address in one would be a ready-made phishing link.
  .refine((v) => !/(https?:|www\.|:\/\/)/i.test(v), 'A name cannot contain a web address');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const part = (max: number) => z.string().trim().max(max).nullish();

/** A postal address broken into the pieces people recognise. Any piece may be missing. */
export const addressPartsSchema = z.object({
  /** House number and street, e.g. "1776 Pierre Place". */
  street: part(200),
  city: part(120),
  /** State or province, abbreviated where there is a standard short form ("NC"). */
  state: part(80),
  postalCode: part(20),
  /** Two-letter country code, lower case ("us"). */
  country: part(2),
});
export type AddressParts = z.infer<typeof addressPartsSchema>;

export const placeSchema = z.object({
  /** One line for people to read, e.g. "1776 Pierre Place, Apex, NC 27502". */
  name: z.string().trim().min(1).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  parts: addressPartsSchema.optional(),
});
export type Place = z.infer<typeof placeSchema>;

/**
 * Shown beside every phone field where someone can agree to text messages. The wording is the
 * SMS provider's requirement; change it only together with their rules.
 */
export const SMS_DISCLOSURE =
  'Message frequency varies. Message and data rates may apply. Reply STOP to cancel or HELP for help. Your mobile information will not be sold or shared with third parties.';
/** What the opt-in box says. Kept here so the record of consent matches what was shown. */
export const SMS_OPT_IN_LABEL =
  'Yes, text me about transports I am part of: requests for drivers, schedule changes and reminders. Optional.';

/** A contact number: any usual way of writing one, with at least 10 digits. */
const contactPhone = z
  .string()
  .trim()
  .max(40)
  .regex(/^[0-9+().\-\s]*$/, 'Use digits only, for example (919) 555-0123')
  .refine((v) => v.replace(/\D/g, '').length >= 10, 'Enter your full phone number, including the area code');

export const signupSchema = z.object({
  name,
  email,
  password,
  phone: contactPhone,
  /** Agreeing to text messages is always a separate choice and never required. */
  smsOptIn: z.boolean().optional(),
});
export const loginSchema = z.object({ email, password: z.string().min(1).max(200) });
export const forgotSchema = z.object({ email });
export const verifySchema = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(200) });
const challengeId = z.string().uuid();
const otpCode = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'));

export const otpVerifySchema = z.object({ challengeId, code: otpCode });
export const otpResendSchema = z.object({ challengeId, channel: z.enum(['email', 'sms']).optional() });
export const twoFactorSetupSchema = z.object({
  method: z.enum(['email', 'sms']),
  /** Required for text messages. */
  phone: z.string().trim().max(30).optional(),
  password: z.string().min(1).max(200),
});
export const passwordConfirmSchema = z.object({ password: z.string().min(1).max(200) });
export const passkeyRegisterSchema = z.object({
  challengeId,
  name: z.string().trim().min(1).max(60).regex(noControl),
  response: z.record(z.string(), z.unknown()),
});
export const passkeyLoginSchema = z.object({ challengeId, response: z.record(z.string(), z.unknown()) });

/** Returned by login (and by a resend) when a code is needed to finish signing in. */
export interface TwoFactorStep {
  challengeId: string;
  channel: 'email' | 'sms';
  /** Where the code went, partly hidden: "j•••@example.org" or "•••• 0142". */
  sentTo: string;
  /** Whether "send it by email instead" can be offered. */
  canUseEmail: boolean;
}

export interface SecuritySettings {
  twoFactor: 'off' | 'email' | 'sms';
  phoneHint: string | null;
  smsAvailable: boolean;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
}

export const resetSchema = z.object({ token: z.string().min(10).max(200), password });
export const acceptInviteSchema = z.object({
  name: name.optional(),
  password: password.optional(),
  /** Required when the invitation creates a new account. */
  phone: contactPhone.optional(),
  smsOptIn: z.boolean().optional(),
});

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3–40 lowercase letters, numbers or dashes');

const timezone = z.string().trim().min(1).max(64);

export const createOrgSchema = z.object({ name, slug: slugSchema, timezone: timezone.optional() });

export const orgSettingsSchema = z.object({
  name: name.optional(),
  legTargetMiles: z.number().int().min(20).max(400).optional(),
  legTargetMinutes: z.number().int().min(30).max(480).optional(),
  handoffBufferMinutes: z.number().int().min(0).max(120).optional(),
  timezone: timezone.optional(),
});

/** Largest logo file accepted, after the browser has scaled it down. */
export const MAX_LOGO_BYTES = 300_000;
/** A logo as base64 (no data: prefix). The server works out the image type itself. */
export const logoSchema = z.object({ data: z.string().min(16).max(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+=*$/, 'Not a valid image upload') });

export const inviteMemberSchema = z.object({
  name,
  email,
  role: z.enum(ROLES),
});

/** Free text: one address per line or comma-separated; "Pat Lee <pat@example.org>" also works. */
export const inviteDriversSchema = z.object({ emails: z.string().min(3).max(50_000) });

/** A platform admin setting up a new rescue and inviting the person who will run it. */
export const inviteOrgSchema = z.object({
  name,
  slug: slugSchema,
  adminName: name,
  adminEmail: email,
  timezone: timezone.optional(),
});

export const adminOrgUpdateSchema = z.object({ suspended: z.boolean() });

export const updateMemberSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const driverProfileSchema = z.object({
  phone: optionalText(40),
  homeAddress: optionalText(300),
  homeLat: z.number().min(-90).max(90).nullish(),
  homeLng: z.number().min(-180).max(180).nullish(),
  homeStreet: part(200),
  homeCity: part(120),
  homeState: part(80),
  homePostalCode: part(20),
  homeCountry: part(2),
  maxMiles: z.number().int().min(1).max(2000).nullish(),
  availability: optionalText(500),
  vehicle: optionalText(200),
  crateCapacity: z.number().int().min(0).max(50).nullish(),
  maxAnimalSize: z.enum(ANIMAL_SIZES).nullish(),
  notes: optionalText(2000),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
  notifyPush: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type DriverProfileInput = z.infer<typeof driverProfileSchema>;

export const createDriverSchema = driverProfileSchema.extend({
  name,
  email,
  sendInvite: z.boolean().default(true),
});

export const importDriversSchema = z.object({
  csv: z.string().min(1).max(500_000),
  sendInvites: z.boolean().default(false),
});

export const animalSchema = z.object({
  name,
  species: z.string().trim().max(60).default('Dog'),
  breed: optionalText(120),
  size: z.enum(ANIMAL_SIZES).default('medium'),
  notes: optionalText(2000),
});

export const createTransportSchema = z.object({
  title: z.string().trim().min(1).max(200).regex(noControl, 'Remove line breaks'),
  origin: placeSchema,
  destination: placeSchema,
  departAt: z.string().datetime({ offset: true }),
  notes: optionalText(4000),
  animals: z.array(animalSchema).max(50).default([]),
});

export const updateTransportSchema = z.object({
  title: z.string().trim().min(1).max(200).regex(noControl, 'Remove line breaks').optional(),
  departAt: z.string().datetime({ offset: true }).optional(),
  notes: optionalText(4000).optional(),
});

/** Intermediate handoff points between origin and destination, in travel order. */
export const replanSchema = z.object({
  /** A handoff with an empty name is labelled by the server after the nearest town. */
  handoffs: z.array(placeSchema.extend({ name: z.string().trim().max(300) })).max(48),
});

export const requestVolunteersSchema = z.object({
  /** 'all' = every active driver; 'suggested' = drivers within range of a leg. */
  audience: z.union([z.enum(['all', 'suggested']), z.array(z.string().uuid()).min(1).max(1000)]),
  message: optionalText(1000),
});

export const offerSchema = z.object({ note: optionalText(500) });
export const assignSchema = z.object({ userId: z.string().uuid().nullable() });
export const legStatusSchema = z.object({ status: z.enum(['filled', 'in_progress', 'done']) });
export const messageSchema = z.object({ body: z.string().trim().min(1).max(2000) });

/** Browser push services. Anything else is refused, so the server can never be pointed at an arbitrary URL. */
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|[a-z0-9-]+\.push\.apple\.com)$/;
const pushEndpoint = z
  .string()
  .url()
  .max(1000)
  .refine((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && !url.port && !url.username && PUSH_HOSTS.test(url.hostname);
    } catch {
      return false;
    }
  }, 'Unsupported push service');

export const pushSubscriptionSchema = z.object({
  endpoint: pushEndpoint,
  keys: z.object({ p256dh: z.string().max(300), auth: z.string().max(300) }),
});

/** Largest profile photo accepted, after the browser has cropped and scaled it. */
export const MAX_PHOTO_BYTES = 200_000;
/** A profile photo as base64 (no data: prefix). The server works out the image type itself. */
export const photoSchema = z.object({ data: z.string().min(16).max(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+=*$/, 'Not a valid image upload') });

/** A position a driver's phone reports while they share their location on a leg. */
export const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(1_000_000).optional(),
});
/** A shared position older than this is no longer shown: the phone has stopped reporting. */
export const POSITION_MAX_AGE_MINUTES = 60;

// ---------- response types ----------

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  role: Role;
  status: MemberStatus;
}

export interface Me {
  /** `photo` is the path of the person's own picture, or null when they have not added one. */
  user: { id: string; name: string; email: string; isPlatformAdmin: boolean; photo: string | null };
  orgs: OrgSummary[];
  allowOrgSignup: boolean;
}

/** What a platform admin sees about an organization: who runs it and how big it is, never its contents. */
export interface AdminOrg {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  suspended: boolean;
  admins: { name: string; email: string; status: MemberStatus }[];
  memberCount: number;
  driverCount: number;
  transportCount: number;
}

export interface OrgDetail {
  id: string;
  slug: string;
  name: string;
  legTargetMiles: number;
  legTargetMinutes: number;
  handoffBufferMinutes: number;
  timezone: string;
  /** Path of the organization's own logo, or null to use the PetXport paw. */
  logoUrl: string | null;
  role: Role;
  features: { sms: boolean; push: boolean; vapidPublicKey: string | null };
}

export interface Member {
  userId: string;
  name: string;
  photo: string | null;
  email: string;
  role: Role;
  status: MemberStatus;
}

export interface Driver {
  userId: string;
  name: string;
  /** Path of the person's picture, or null. */
  photo: string | null;
  email: string;
  memberStatus: MemberStatus;
  role: Role;
  phone: string | null;
  homeAddress: string | null;
  homeLat: number | null;
  homeLng: number | null;
  homeStreet: string | null;
  homeCity: string | null;
  homeState: string | null;
  homePostalCode: string | null;
  homeCountry: string | null;
  maxMiles: number | null;
  availability: string | null;
  vehicle: string | null;
  crateCapacity: number | null;
  maxAnimalSize: AnimalSize | null;
  notes: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
  notifyPush: boolean;
  active: boolean;
}

export interface Animal {
  id: string;
  name: string;
  species: string;
  breed: string | null;
  size: AnimalSize;
  notes: string | null;
}

export interface Offer {
  id: string;
  userId: string;
  name: string;
  phone: string | null;
  status: OfferStatus;
  note: string | null;
  createdAt: string;
  /** Miles from the driver's home to the start of the leg, when known. */
  milesFromHome: number | null;
}

export interface Leg {
  id: string;
  seq: number;
  start: Place;
  end: Place;
  distanceM: number;
  durationS: number;
  departAt: string;
  arriveAt: string;
  geometry: [number, number][];
  status: LegStatus;
  /** Null when open. Phone is only included for coordinators and the transport's drivers. */
  driver: { userId: string; name: string; phone: string | null; photo: string | null } | null;
  /** Coordinators only. */
  offers?: Offer[];
  /** The viewer's own offer on this leg, if any. */
  myOffer: OfferStatus | null;
}

export interface TransportSummary {
  id: string;
  title: string;
  status: TransportStatus;
  originName: string;
  destName: string;
  departAt: string;
  distanceM: number;
  durationS: number;
  legCount: number;
  filledCount: number;
  animalCount: number;
  pendingOffers: number;
}

export interface TransportDetail {
  id: string;
  title: string;
  status: TransportStatus;
  origin: Place;
  destination: Place;
  departAt: string;
  distanceM: number;
  durationS: number;
  notes: string | null;
  animals: Animal[];
  legs: Leg[];
  coordinators: { userId: string; name: string; phone: string | null; photo: string | null }[];
  viewer: { canManage: boolean; isCrew: boolean; userId: string };
  requestedCount: number;
  unreadMessages: number;
}

export interface MyLeg {
  legId: string;
  transportId: string;
  transportTitle: string;
  transportStatus: TransportStatus;
  seq: number;
  legCount: number;
  start: Place;
  end: Place;
  departAt: string;
  arriveAt: string;
  distanceM: number;
  durationS: number;
  status: LegStatus;
}

export interface OpenRequest {
  transportId: string;
  title: string;
  departAt: string;
  originName: string;
  destName: string;
  openLegs: number;
  myOffers: number;
}

/** Where the animal is on a leg that is under way, as last reported by that leg's driver. */
export interface LegPosition {
  legId: string;
  lat: number;
  lng: number;
  /** How far off the phone thinks it might be, in meters. */
  accuracyM: number | null;
  at: string;
}

export interface Suggestion {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  /** Best-matching leg (closest start to the driver's home). */
  legSeq: number | null;
  milesFromHome: number | null;
  inRange: boolean;
  alreadyRequested: boolean;
}

export interface ChatMessage {
  id: string;
  transportId: string;
  userId: string;
  userName: string;
  userPhoto: string | null;
  body: string;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  readAt: string | null;
}

// ---------- helpers ----------

export function miles(meters: number): number {
  return meters / METERS_PER_MILE;
}

export function formatMiles(meters: number): string {
  const m = miles(meters);
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} mi`;
}

export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const SIZE_RANK: Record<AnimalSize, number> = { small: 0, medium: 1, large: 2, xlarge: 3 };
export function sizeRank(size: AnimalSize): number {
  return SIZE_RANK[size];
}

/** Great-circle distance in meters. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// ---------- handoff stops ----------

export const STOP_CATEGORIES = ['fuel', 'rest_area', 'lodging', 'food', 'shopping'] as const;
export type StopCategory = (typeof STOP_CATEGORIES)[number];
export const STOP_CATEGORY_LABELS: Record<StopCategory, string> = {
  fuel: 'Gas stations',
  rest_area: 'Rest areas',
  lodging: 'Hotels',
  food: 'Restaurants',
  shopping: 'Shopping',
};

/** A real-world place that could serve as a handoff point. */
export interface Stop {
  id: string;
  name: string;
  category: StopCategory;
  lat: number;
  lng: number;
  address: string | null;
}

export const stopsQuerySchema = z
  .object({
    south: z.coerce.number().min(-90).max(90),
    west: z.coerce.number().min(-180).max(180),
    north: z.coerce.number().min(-90).max(90),
    east: z.coerce.number().min(-180).max(180),
  })
  .refine((b) => b.north > b.south && b.east > b.west, 'Invalid map area');

/** Splits pasted text into people to invite. Entries without a usable address are returned in `invalid`. */
export function parseInviteList(text: string): { people: { name: string; email: string }[]; invalid: string[] } {
  const people = new Map<string, { name: string; email: string }>();
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const angled = entry.match(/^(.*?)<([^<>\s]+)>$/);
    const address = (angled ? angled[2]! : entry).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || address.length > 254) {
      invalid.push(entry.slice(0, 80));
      continue;
    }
    let personName = angled ? angled[1]!.trim().replace(/^["']|["']$/g, '').trim() : '';
    if (!personName) {
      // "pat.lee@example.org" -> "Pat Lee"; they can correct it when they join.
      personName = address
        .split('@')[0]!
        .split(/[._+-]+/)
        .filter(Boolean)
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(' ');
    }
    if (!people.has(address)) people.set(address, { name: personName.slice(0, 120) || address, email: address });
  }
  return { people: [...people.values()], invalid };
}

/**
 * One readable line from address pieces: "1776 Pierre Place, Apex, NC 27502".
 * Neighbourhoods and counties are deliberately left out; `placeName` is for a
 * business or landmark ("Cracker Barrel") and leads the line when given.
 * The country is only added outside the United States.
 */
export function formatAddress(parts: AddressParts, placeName?: string | null): string {
  const clean = (v?: string | null) => (v ?? '').trim();
  const street = clean(parts.street);
  const lead = clean(placeName);
  const region = [clean(parts.state), clean(parts.postalCode)].filter(Boolean).join(' ');
  const country = clean(parts.country).toLowerCase();
  const pieces = [
    lead && lead.toLowerCase() !== street.toLowerCase() && lead.toLowerCase() !== clean(parts.city).toLowerCase() ? lead : '',
    street,
    clean(parts.city),
    region,
    country && country !== 'us' ? country.toUpperCase() : '',
  ];
  return pieces.filter(Boolean).join(', ');
}

/**
 * A phone number as people expect to read it: "(919) 555-0123". Ten digits (with or without
 * a leading 1 or +1) get the standard North American form; anything else, such as an
 * international number or one with an extension, is left exactly as it was entered.
 */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const trimmed = phone.trim();
  // Letters mean an extension or a note ("x12", "ask for Sam"); do not guess.
  if (/[a-z]/i.test(trimmed)) return trimmed;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  else if (trimmed.startsWith('+') && !trimmed.startsWith('+1')) return trimmed;
  if (digits.length !== 10) return trimmed;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Pages anyone can read without logging in. They hold no personal data and no secrets in their addresses. */
export const PUBLIC_PATHS = ['/', '/features', '/how-it-works', '/privacy', '/terms'] as const;

/**
 * The visitor counter for the public pages of one particular site. These identifiers appear in
 * any page that uses the counter; they are not secrets. Another site running this software is
 * not counted, because `host` will not match.
 */
export const STATCOUNTER = { host: 'petxport.org', project: 13367923, security: 'a27fe9ed' } as const;
