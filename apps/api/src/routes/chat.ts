import { messageSchema, type ChatMessage } from '@petxport/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { globalDb, withOrg } from '../db/client.js';
import { legs, memberships, messageReads, messages, organizations, transports, users } from '../db/schema.js';
import { env } from '../env.js';
import { userFromRequest } from '../lib/auth.js';
import { forbidden, orgCtx, parse, photoPath, type OrgCtx } from '../lib/http.js';
import { notifyMany } from '../notify/index.js';
import { hasRoom, isWatching, joinRoom, leaveAllRooms, registerSocket, sendToRoom, unregisterSocket, type ChatClient } from '../lib/hub.js';
import { isCrew } from './transports.js';

const CHANNEL = 'petxport_chat';

// ----- live fan-out -----

function broadcast(message: ChatMessage): void {
  sendToRoom(message.transportId, JSON.stringify({ type: 'message', message }));
}

async function loadMessage(orgId: string, id: string): Promise<ChatMessage | null> {
  const [row] = await withOrg(orgId, null, (tx) =>
    tx
      .select({ m: messages, userName: users.name, photoAt: users.photoUpdatedAt, slug: organizations.slug })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.userId))
      .innerJoin(organizations, eq(organizations.id, messages.orgId))
      .where(eq(messages.id, id)),
  );
  return row ? toChatMessage(row.m, row.userName, photoPath(row.slug, row.m.userId, row.photoAt)) : null;
}

const toChatMessage = (m: typeof messages.$inferSelect, userName: string, userPhoto: string | null): ChatMessage => ({
  id: m.id,
  transportId: m.transportId,
  userId: m.userId,
  userName,
  userPhoto,
  body: m.body,
  createdAt: m.createdAt.toISOString(),
});

let listener: pg.Client | null = null;
let stopping = false;

/**
 * Listens for new-message notifications from Postgres, so a message posted
 * through any server process reaches sockets connected to this one.
 */
export async function startChatListener(onError: (err: unknown) => void = console.error): Promise<void> {
  stopping = false;
  const connect = async () => {
    const client = new pg.Client({ connectionString: env.databaseUrl });
    client.on('notification', (n) => {
      if (!n.payload) return;
      let parsed: { orgId: string; id: string; transportId: string };
      try {
        parsed = JSON.parse(n.payload) as typeof parsed;
      } catch {
        return;
      }
      const { orgId, id, transportId } = parsed;
      if (!hasRoom(transportId)) return;
      loadMessage(orgId, id)
        .then((m) => m && broadcast(m))
        .catch(onError);
    });
    client.on('error', (err) => {
      onError(err);
      listener = null;
      if (!stopping) setTimeout(() => connect().catch(onError), 2000);
    });
    await client.connect();
    await client.query(`listen ${CHANNEL}`);
    listener = client;
  };
  await connect();
}

export async function stopChatListener(): Promise<void> {
  stopping = true;
  await listener?.end().catch(() => undefined);
  listener = null;
}

// ----- routes -----

async function requireCrew(c: OrgCtx, transportId: string): Promise<void> {
  if (!(await c.db((tx) => isCrew(tx, c, transportId)))) {
    throw forbidden('The chat is for the coordinators and confirmed drivers of this transport.');
  }
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/transports/:id/messages', async (req): Promise<ChatMessage[]> => {
    const c = orgCtx(req);
    const { id } = req.params as { id: string };
    await requireCrew(c, id);
    return c.db(async (tx) => {
      const rows = await tx
        .select({ m: messages, userName: users.name, photoAt: users.photoUpdatedAt, slug: organizations.slug })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.userId))
        .innerJoin(organizations, eq(organizations.id, messages.orgId))
        .where(eq(messages.transportId, id))
        .orderBy(desc(messages.createdAt))
        .limit(200);
      await tx
        .insert(messageReads)
        .values({ orgId: c.org.id, transportId: id, userId: c.user.id })
        .onConflictDoUpdate({ target: [messageReads.transportId, messageReads.userId], set: { lastReadAt: new Date() } });
      return rows.reverse().map((r) => toChatMessage(r.m, r.userName, photoPath(r.slug, r.m.userId, r.photoAt)));
    });
  });

  app.post('/transports/:id/messages/read', async (req) => {
    const c = orgCtx(req);
    const { id } = req.params as { id: string };
    await requireCrew(c, id);
    await c.db((tx) =>
      tx
        .insert(messageReads)
        .values({ orgId: c.org.id, transportId: id, userId: c.user.id })
        .onConflictDoUpdate({ target: [messageReads.transportId, messageReads.userId], set: { lastReadAt: new Date() } }),
    );
    return { ok: true };
  });

  app.post('/transports/:id/messages', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<ChatMessage> => {
    const c = orgCtx(req);
    const { id } = req.params as { id: string };
    const { body } = parse(messageSchema, req.body);
    await requireCrew(c, id);
    return c.db(async (tx) => {
      const [t] = await tx.select().from(transports).where(eq(transports.id, id));
      const [m] = await tx.insert(messages).values({ orgId: c.org.id, transportId: id, userId: c.user.id, body }).returning();
      await tx
        .insert(messageReads)
        .values({ orgId: c.org.id, transportId: id, userId: c.user.id })
        .onConflictDoUpdate({ target: [messageReads.transportId, messageReads.userId], set: { lastReadAt: new Date() } });
      // Delivered to listeners only if this transaction commits.
      await tx.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify({ orgId: c.org.id, id: m!.id, transportId: id })})`);

      const drivers = await tx.select({ userId: legs.driverId }).from(legs).where(eq(legs.transportId, id));
      const away = [t!.createdBy, ...drivers.map((d) => d.userId)].filter(
        (u): u is string => Boolean(u) && u !== c.user.id && !isWatching(id, u!),
      );
      await notifyMany(tx, away, {
        orgId: c.org.id,
        kind: 'chat_message',
        title: `${c.user.name} in "${t!.title}"`,
        body: body.length > 300 ? `${body.slice(0, 300)}…` : body,
        url: `/o/${c.org.slug}/transports/${id}?tab=chat`,
      });
      return toChatMessage(m!, c.user.name, photoPath(c.org.slug, c.user.id, c.user.photoAt));
    });
  });
}

/** One socket per browser tab; the client subscribes to the conversations it has open. */
export async function chatSocket(app: FastifyInstance): Promise<void> {
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // Browsers always send Origin on a WebSocket handshake; another site's page must not open one with the user's cookie.
    const origin = req.headers.origin;
    if (origin && origin !== env.appOrigin) {
      socket.close(4403, 'Origin not allowed');
      return;
    }
    // Handlers are attached before anything is awaited, so a frame sent the moment the socket opens is not lost.
    const whoami = userFromRequest(req).catch(() => null);
    const client: ChatClient = { socket, userId: '', rooms: new Set() };
    let frames = 0;
    const window = setInterval(() => (frames = 0), 10_000);
    let counted = false;
    socket.on('close', () => {
      clearInterval(window);
      leaveAllRooms(client);
      if (counted) unregisterSocket(client.userId);
    });
    // Frames are handled one at a time, so a burst cannot occupy several database connections.
    let queue: Promise<unknown> = whoami.then((user) => {
      if (!user) return socket.close(4401, 'Not logged in');
      client.userId = user.id;
      if (socket.readyState > 1) return;
      if (!registerSocket(user.id)) return socket.close(4429, 'Too many connections');
      counted = true;
    });
    socket.on('message', (raw) => {
      // Each subscribe costs database queries; a client has no reason to send more than a few.
      if (++frames > 20) {
        socket.close(4429, 'Too many messages');
        return;
      }
      queue = queue.then(async () => {
        try {
          const user = await whoami;
          if (!user || !counted) return;
          const msg = JSON.parse(String(raw)) as { type?: string; slug?: string; transportId?: string };
          if (msg.type !== 'subscribe' || !msg.slug || !msg.transportId) return;
          const [org] = await globalDb.select().from(organizations).where(eq(organizations.slug, msg.slug));
          if (!org || org.disabledAt) return;
          const allowed = await withOrg(org.id, user.id, async (tx) => {
            const [m] = await tx
              .select({ role: memberships.role })
              .from(memberships)
              .where(and(eq(memberships.orgId, org.id), eq(memberships.userId, user.id), eq(memberships.status, 'active')));
            if (!m) return false;
            const c = { user, org, role: m.role, canManage: m.role !== 'driver' } as OrgCtx;
            return isCrew(tx, c, msg.transportId!);
          });
          if (!allowed) return;
          if (!joinRoom(msg.transportId, client, org.id)) return;
          socket.send(JSON.stringify({ type: 'subscribed', transportId: msg.transportId }));
        } catch {
          // Ignore malformed frames.
        }
      });
    });
  });
}
