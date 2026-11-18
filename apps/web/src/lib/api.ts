import type { Me, OrgDetail } from '@petxport/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

/** The organization in the URL, and a prefix for its API paths. */
export function useOrgPath() {
  const { slug = '' } = useParams();
  return { slug, base: `/o/${slug}`, apiBase: `/o/${slug}` };
}

export function useOrg() {
  const { slug, apiBase } = useOrgPath();
  return useQuery({ queryKey: ['org', slug], queryFn: () => api<OrgDetail>(apiBase), staleTime: 60_000 });
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

/** Signs out, and stops this browser receiving the account's push notifications. */
export async function logout(): Promise<void> {
  let pushEndpoint: string | undefined;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      pushEndpoint = sub.endpoint;
      await sub.unsubscribe();
    }
  } catch {
    // Push is optional; signing out must still work.
  }
  await api('/auth/logout', { body: pushEndpoint ? { pushEndpoint } : {} });
}
