import type { WebSocket } from 'ws';

/** Live chat connections on this server process, grouped by the transport they are watching. */
export interface ChatClient {
  socket: WebSocket;
  userId: string;
  /** Transports this socket has joined. */
  rooms: Set<string>;
}

const rooms = new Map<string, Set<ChatClient>>();
/** Which organization each open conversation belongs to. */
const roomOrg = new Map<string, string>();
const socketsPerUser = new Map<string, number>();

export const MAX_SOCKETS_PER_USER = 10;

/** Counts a new connection; false means the user already has too many open. */
export function registerSocket(userId: string): boolean {
  const n = socketsPerUser.get(userId) ?? 0;
  if (n >= MAX_SOCKETS_PER_USER) return false;
  socketsPerUser.set(userId, n + 1);
  return true;
}

export function unregisterSocket(userId: string): void {
  const n = (socketsPerUser.get(userId) ?? 1) - 1;
  if (n <= 0) socketsPerUser.delete(userId);
  else socketsPerUser.set(userId, n);
}

export const MAX_ROOMS_PER_SOCKET = 30;

export function joinRoom(transportId: string, client: ChatClient, orgId: string): boolean {
  if (client.rooms.size >= MAX_ROOMS_PER_SOCKET && !client.rooms.has(transportId)) return false;
  let room = rooms.get(transportId);
  if (!room) rooms.set(transportId, (room = new Set()));
  roomOrg.set(transportId, orgId);
  room.add(client);
  client.rooms.add(transportId);
  return true;
}

export function leaveAllRooms(client: ChatClient): void {
  for (const id of client.rooms) {
    const room = rooms.get(id);
    room?.delete(client);
    if (room?.size === 0) dropRoom(id);
  }
  client.rooms.clear();
}

/**
 * Stops a user receiving a conversation they are no longer part of (taken off a
 * leg, removed from the organization). With no transportId, every conversation.
 */
export function evictUser(userId: string, transportId?: string): void {
  for (const [id, room] of rooms) {
    if (transportId && id !== transportId) continue;
    for (const client of room) {
      if (client.userId !== userId) continue;
      room.delete(client);
      client.rooms.delete(id);
      if (client.socket.readyState === 1) client.socket.send(JSON.stringify({ type: 'unsubscribed', transportId: id }));
    }
    if (room.size === 0) dropRoom(id);
  }
}

function dropRoom(id: string): void {
  rooms.delete(id);
  roomOrg.delete(id);
}

/** Closes every conversation of a suspended organization. */
export function evictOrg(orgId: string): void {
  for (const [id, room] of rooms) {
    if (roomOrg.get(id) !== orgId) continue;
    for (const client of room) {
      client.rooms.delete(id);
      if (client.socket.readyState === 1) client.socket.send(JSON.stringify({ type: 'unsubscribed', transportId: id }));
    }
    dropRoom(id);
  }
}

/** Ends every live connection of a user (logout, password change). */
export function disconnectUser(userId: string): void {
  for (const room of rooms.values()) {
    for (const client of room) if (client.userId === userId) client.socket.close(4401, 'Signed out');
  }
}

export const hasRoom = (transportId: string) => rooms.has(transportId);

/** Whether the user has this conversation open right now (on this server process). */
export function isWatching(transportId: string, userId: string): boolean {
  for (const client of rooms.get(transportId) ?? []) if (client.userId === userId) return true;
  return false;
}

export function sendToRoom(transportId: string, data: string): void {
  for (const client of rooms.get(transportId) ?? []) {
    if (client.socket.readyState === 1) client.socket.send(data);
  }
}
