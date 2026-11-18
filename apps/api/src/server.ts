import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { env, features } from './env.js';
import { purgeExpired } from './lib/auth.js';
import { startWorker, stopWorker } from './lib/jobs.js';
import { startChatListener, stopChatListener } from './routes/chat.js';
import { getProvider } from './routing/index.js';

if (env.isProduction && !env.smtpUrl && !env.allowEmailToLog) {
  console.error('SMTP_URL is not set. Without it, sign-in links would be written to the server log instead of being emailed.\nSet SMTP_URL, or set ALLOW_EMAIL_TO_LOG=true if you really want that.');
  process.exit(1);
}

const app = await buildApp();
await startChatListener((err) => app.log.error(err));
startWorker(2000, (err) => app.log.error(err));
const purge = setInterval(() => purgeExpired().catch((err) => app.log.error(err)), 30 * 60_000);
await purgeExpired();
await app.listen({ port: env.port, host: process.env.HOST ?? '127.0.0.1' });

console.log(
  `PetXport API on port ${env.port} | routing: ${getProvider().name} | email: ${env.smtpUrl ? 'smtp' : 'console'} | push: ${features.push ? 'on' : 'off'} | sms: ${features.sms ? 'on' : 'off'}`,
);

if (env.isProduction) {
  const warn = (msg: string) => console.warn(`WARNING: ${msg}`);
  if (!env.appUrl.startsWith('https://')) warn('APP_URL is not https. Login cookies will be sent unencrypted; put TLS in front before real use.');
  if (!env.smtpUrl && env.allowEmailToLog) warn('SMTP_URL is not set. Invitation and password-reset links are being written to this log instead of emailed.');
  if (env.platformAdminEmails.length === 0 && !env.allowOrgSignup) warn('No PLATFORM_ADMIN_EMAILS set and sign-up is closed, so nobody can create an organization.');
  if (process.env.HOST && !['127.0.0.1', '::1', 'localhost'].includes(process.env.HOST)) {
    warn(`Listening on ${process.env.HOST} directly. Make sure only your reverse proxy can reach this port.`);
  }
} else if (env.appUrl.startsWith('https://')) {
  console.warn('WARNING: APP_URL is https but NODE_ENV is not "production". Set NODE_ENV=production on a real server.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    clearInterval(purge);
    stopWorker();
    await stopChatListener();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
