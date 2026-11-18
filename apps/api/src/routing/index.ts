import { env } from '../env.js';
import { mockProvider } from './mock.js';
import { orsProvider } from './ors.js';
import { osrmProvider } from './osrm.js';
import type { RoutingProvider } from './types.js';

let current: RoutingProvider | null = null;

export function getProvider(): RoutingProvider {
  if (current) return current;
  if (env.routingProvider === 'ors') {
    if (!env.orsApiKey) throw new Error('ROUTING_PROVIDER is "ors" but ORS_API_KEY is not set.');
    current = orsProvider;
  } else if (env.routingProvider === 'mock') current = mockProvider;
  else current = osrmProvider;
  return current;
}

/** Tests swap in their own provider. */
export function setProvider(provider: RoutingProvider | null): void {
  current = provider;
}

export * from './types.js';
export * from './plan.js';
export * from './split.js';
export * from './stops.js';
