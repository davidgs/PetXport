import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// Both src/ and dist/ sit three levels below the repository root.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(repoRoot, '.env'), quiet: true } as Parameters<typeof config>[0]);

const isTest = process.env.NODE_ENV === 'test';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return v;
}

function databaseUrls() {
  if (!isTest) {
    return {
      app: required('DATABASE_URL'),
      migration: process.env.MIGRATION_DATABASE_URL ?? '',
    };
  }
  const app = required('TEST_DATABASE_URL');
  const migration = required('TEST_MIGRATION_DATABASE_URL');
  for (const url of [app, migration]) {
    const dbName = new URL(url).pathname.replace(/^\//, '');
    if (!dbName.endsWith('_test')) {
      throw new Error(`Refusing to run tests against database "${dbName}": its name must end in _test.`);
    }
  }
  return { app, migration };
}

const urls = databaseUrls();
const orsKey = isTest ? '' : (process.env.ORS_API_KEY ?? '');

export const env = {
  isTest,
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 3000),
  appUrl: (process.env.APP_URL ?? 'http://localhost:5180').replace(/\/$/, ''),
  appOrigin: new URL(process.env.APP_URL ?? 'http://localhost:5180').origin,
  /**
   * Which peers may set X-Forwarded-For. Only the local reverse proxy by default, so a
   * client cannot fake its address to dodge rate limits.
   */
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  // Tests create organizations freely; elsewhere new rescues join by invitation unless this is switched on.
  allowOrgSignup: isTest || process.env.ALLOW_ORG_SIGNUP === 'true',
  /** Accounts with these email addresses are platform admins ("super-admins"). */
  platformAdminEmails: (isTest ? '' : (process.env.PLATFORM_ADMIN_EMAILS ?? ''))
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  databaseUrl: urls.app,
  migrationDatabaseUrl: urls.migration,
  routingProvider: isTest ? 'mock' : (process.env.ROUTING_PROVIDER ?? (orsKey ? 'ors' : 'osrm')),
  orsApiKey: orsKey,
  osrmUrl: (process.env.OSRM_URL ?? 'https://router.project-osrm.org').replace(/\/$/, ''),
  nominatimUrl: (process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
  overpassUrls: (process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  smtpUrl: isTest ? '' : (process.env.SMTP_URL ?? ''),
  mailFrom: process.env.MAIL_FROM ?? 'PetXport <no-reply@localhost>',
  vapidPublicKey: isTest ? '' : (process.env.VAPID_PUBLIC_KEY ?? ''),
  vapidPrivateKey: isTest ? '' : (process.env.VAPID_PRIVATE_KEY ?? ''),
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@localhost',
  /** Brevo API key (not the SMTP key) and the sender shown on texts; both are needed for SMS. */
  brevoApiKey: isTest ? '' : (process.env.BREVO_API_KEY ?? ''),
  brevoSmsSender: isTest ? '' : (process.env.BREVO_SMS_SENDER ?? '').trim(),
  /** Shared secret Brevo sends with each webhook call (STOP replies). Without it the webhook is off. */
  brevoWebhookSecret: isTest ? 'test-webhook-secret' : (process.env.BREVO_WEBHOOK_SECRET ?? '').trim(),
  /** Troubleshooting only: write each webhook call from Brevo to the log in full, phone numbers included. */
  brevoWebhookDebug: process.env.BREVO_WEBHOOK_DEBUG === 'true',
  smsDailyLimitPerOrg: Number(process.env.SMS_DAILY_LIMIT_PER_ORG ?? 300),
  invitesDailyLimitPerOrg: Number(process.env.INVITES_DAILY_LIMIT_PER_ORG ?? 500),
  /** In production, refuse to run without SMTP unless this is set (links would be written to the log). */
  allowEmailToLog: process.env.ALLOW_EMAIL_TO_LOG === 'true',
};

export const features = {
  sms: Boolean(env.brevoApiKey && env.brevoSmsSender),
  push: Boolean(env.vapidPublicKey && env.vapidPrivateKey),
};
