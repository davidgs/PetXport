import { PUBLIC_PATHS, STATCOUNTER } from '@petxport/shared';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { globalDb, withOrg } from './db/client.js';
import { memberships, organizations } from './db/schema.js';
import { env, repoRoot, features } from './env.js';
import { userFromRequest } from './lib/auth.js';
import { HttpError, notFound, requireUser } from './lib/http.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes, chatSocket } from './routes/chat.js';
import { driverRoutes } from './routes/drivers.js';
import { orgRoutes } from './routes/orgs.js';
import { securityRoutes } from './routes/security.js';
import { transportRoutes } from './routes/transports.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.isTest
      ? false
      : {
          level: env.isProduction ? 'info' : 'warn',
          serializers: {
            // Invitation, reset and confirmation links are as good as a password; keep them out of the log.
            req: (req) => ({
              method: req.method,
              url: req.url.replace(/\/(invites?|reset|verify)\/[^/?#]+/g, '/$1/[redacted]'),
              remoteAddress: req.ip,
            }),
          },
        },
    trustProxy: env.trustProxy,
    bodyLimit: 1_048_576,
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(rateLimit, {
    global: true,
    max: env.isTest ? 1_000_000 : 600,
    timeWindow: '1 minute',
    // Runs after the session is read, so a signed-in person has their own allowance wherever they connect from.
    hook: 'preHandler',
    keyGenerator: (req) => req.user?.id ?? req.ip,
  });

  app.decorateRequest('user', null);
  app.decorateRequest('org', null);
  app.decorateRequest('role', null);

  // Sent with every response.
  const tiles = 'https://tiles.openfreemap.org';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // MapLibre positions markers with inline styles.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${tiles}`,
    "font-src 'self'",
    `connect-src 'self' ${env.appOrigin.replace(/^http/, 'ws')} ${tiles}`,
    "worker-src 'self' blob:",
    "child-src blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  // The public pages of the site named in STATCOUNTER may load its visitor counter. Nothing else may:
  // not the log-in pages, not the app, and not a copy of this software running anywhere else.
  const counted = new URL(env.appUrl).hostname === STATCOUNTER.host;
  const publicCsp = csp
    .replace("script-src 'self'", "script-src 'self' https://www.statcounter.com")
    .replace("img-src 'self'", "img-src 'self' https://c.statcounter.com")
    .replace("connect-src 'self'", "connect-src 'self' https://c.statcounter.com");
  const isPublicPage = (url: string) => (PUBLIC_PATHS as readonly string[]).includes(url.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/');
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    // Invitation and reset links carry a secret in the URL; never pass it on as a referrer.
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', counted && isPublicPage(req.url) ? publicCsp : csp);
    if (env.appUrl.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // API answers hold personal data: keep them out of shared and back-button caches.
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Second line of defence behind SameSite cookies: a browser on another site cannot change anything.
      const origin = req.headers.origin;
      if ((origin && origin !== env.appOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError(403, 'This request did not come from the PetXport site. (If you run this server, check that APP_URL matches the address in the browser.)');
      }
    }
    // Cookies are SameSite=Lax; requiring JSON bodies as well means a cross-site form cannot change anything.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['content-length'] && req.headers['content-length'] !== '0') {
      const type = req.headers['content-type'] ?? '';
      if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
    }
    req.user = await userFromRequest(req);
  });

  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const field = issue?.path.join('.');
      return reply.status(400).send({ error: field ? `${field}: ${issue?.message}` : (issue?.message ?? 'Invalid input') });
    }
    // An id that is not a UUID can never match a row.
    if (err.code === '22P02') return reply.status(404).send({ error: 'Not found' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    if (env.isTest) console.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server.' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  // What the sign-up and invitation pages need to know before anyone is logged in.
  app.get('/api/features', async () => ({ sms: features.sms }));

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(securityRoutes);
  await app.register(webhookRoutes);
  await app.register(chatSocket);

  // Everything below /api/o/:slug runs inside one organization.
  await app.register(
    async (scoped) => {
      scoped.addHook('preHandler', async (req) => {
        const user = requireUser(req);
        const { slug } = req.params as { slug: string };
        const [org] = await globalDb.select().from(organizations).where(eq(organizations.slug, slug));
        // The same answer whether the organization does not exist or the user is not in it.
        if (!org || org.disabledAt) throw notFound('Organization not found.');
        const [member] = await withOrg(org.id, user.id, (tx) =>
          tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.orgId, org.id), eq(memberships.userId, user.id), eq(memberships.status, 'active'))),
        );
        if (!member) throw notFound('Organization not found.');
        req.org = org;
        req.role = member.role;
      });
      await scoped.register(orgRoutes);
      await scoped.register(driverRoutes);
      await scoped.register(transportRoutes);
      await scoped.register(chatRoutes);
    },
    { prefix: '/api/o/:slug' },
  );

  // In production the built web app is served by this same process.
  const webDist = path.join(repoRoot, 'apps/web/dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found' }));
  }

  return app;
}
