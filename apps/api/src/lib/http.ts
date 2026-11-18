import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@petxport/shared';
import type { z } from 'zod';
import { withOrg, type Tx } from '../db/client.js';
import type { organizations } from '../db/schema.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
export const badRequest = (msg: string) => new HttpError(400, msg);

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  return schema.parse(data ?? {});
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  isPlatformAdmin: boolean;
  /** Path of their own picture, or null. */
  photo: string | null;
  photoAt: Date | null;
}

/** Where a member's picture is served within an organization. The date makes a new picture a new address. */
export const photoPath = (slug: string, userId: string, at: Date | null): string | null =>
  at ? `/api/o/${slug}/people/${userId}/photo?v=${at.getTime()}` : null;

export type OrgRow = typeof organizations.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    org: OrgRow | null;
    role: Role | null;
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'Please log in.');
  return req.user;
}

/** Everything a handler under /api/o/:slug needs. */
export interface OrgCtx {
  user: SessionUser;
  org: OrgRow;
  role: Role;
  canManage: boolean;
  isAdmin: boolean;
  db<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function orgCtx(req: FastifyRequest): OrgCtx {
  const user = requireUser(req);
  if (!req.org || !req.role) throw notFound();
  const org = req.org;
  const role = req.role;
  return {
    user,
    org,
    role,
    canManage: role === 'admin' || role === 'coordinator',
    isAdmin: role === 'admin',
    db: (fn) => withOrg(org.id, user.id, fn),
  };
}

export function requirePlatformAdmin(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  // 404 rather than 403, so the admin area is not advertised to ordinary accounts.
  if (!user.isPlatformAdmin) throw notFound();
  return user;
}

export function requireManage(c: OrgCtx): void {
  if (!c.canManage) throw forbidden('Only coordinators can do that.');
}

export function requireAdmin(c: OrgCtx): void {
  if (!c.isAdmin) throw forbidden('Only organization admins can do that.');
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
