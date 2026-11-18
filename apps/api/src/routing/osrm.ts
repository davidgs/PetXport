import { formatAddress, type AddressParts, type Place } from '@petxport/shared';
import { env } from '../env.js';
import { RoutingError, type LngLat, type Point, type RouteResult, type RoutingProvider } from './types.js';

const USER_AGENT = 'PetXport/0.1 (volunteer pet transport planner)';

// Nominatim's usage policy allows at most one request per second.
let nominatimQueue: Promise<unknown> = Promise.resolve();
let nominatimWaiting = 0;
function nominatim<T>(path: string): Promise<T> {
  // Requests are spaced a second apart; beyond a short queue it is better to say so than to stall everyone.
  if (nominatimWaiting >= 15) return Promise.reject(new RoutingError('Address lookup is busy. Try again in a moment.'));
  nominatimWaiting++;
  const run = async () => {
    const res = await fetch(`${env.nominatimUrl}${path}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new RoutingError(`Address lookup failed (${res.status}). Try again in a moment.`);
    const body = (await res.json()) as T;
    await new Promise((r) => setTimeout(r, 1100));
    return body;
  };
  const next = nominatimQueue.then(run, run).finally(() => nominatimWaiting--);
  nominatimQueue = next.catch(() => undefined);
  return next;
}

interface NominatimAddress {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  postcode?: string;
  country_code?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  county?: string;
  state?: string;
  'ISO3166-2-lvl4'?: string;
}

/** "US-NC" -> "NC"; otherwise the full state or province name. */
const stateOf = (a: NominatimAddress) => a['ISO3166-2-lvl4']?.split('-')[1] ?? a.state;

/**
 * Nominatim describes a result as every containing area in turn ("…, Olive Chapel Park, Apex,
 * Wake County, North Carolina, 27502, United States"). This keeps the pieces of a postal
 * address and drops neighbourhoods and counties. A county is kept only when it is the result
 * itself, i.e. there is no town to name instead.
 */
export function nominatimPlace(r: { display_name: string; name?: string; lat: string; lon: string; address?: NominatimAddress }): Place {
  const a = r.address ?? {};
  const road = a.road ?? a.pedestrian;
  const parts: AddressParts = {
    street: [a.house_number, road].filter(Boolean).join(' ') || null,
    city: a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? null,
    state: stateOf(a) ?? null,
    postalCode: a.postcode ?? null,
    country: a.country_code?.toLowerCase().slice(0, 2) ?? null,
  };
  // The result's own name when it is a business or landmark rather than the street or town itself.
  const placeName = r.name && r.name !== road && r.name !== a.house_number ? r.name : null;
  const label = formatAddress(parts.city || parts.street ? parts : { ...parts, city: a.county }, placeName);
  return { name: label || r.display_name, lat: Number(r.lat), lng: Number(r.lon), parts };
}

/** OSRM for routing and Nominatim for geocoding. Works with the public demo servers or self-hosted ones. */
export const osrmProvider: RoutingProvider = {
  name: 'osrm',
  async geocode(query) {
    const rows = await nominatim<Parameters<typeof nominatimPlace>[0][]>(
      `/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`,
    );
    // Two results can now read the same (a street and a building on it); keep the first of each.
    const seen = new Set<string>();
    return rows.map(nominatimPlace).filter((p) => !seen.has(p.name) && seen.add(p.name));
  },
  async reverseGeocode(point) {
    const row = await nominatim<{ address?: NominatimAddress }>(
      `/reverse?format=jsonv2&zoom=10&lat=${point.lat}&lon=${point.lng}`,
    );
    const a = row.address;
    if (!a) return null;
    const town = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? a.county;
    const state = stateOf(a);
    return [town, state].filter(Boolean).join(', ') || null;
  },
  async route(points: Point[]): Promise<RouteResult> {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const res = await fetch(`${env.osrmUrl}/route/v1/driving/${coords}?overview=false&steps=true&geometries=geojson`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
      routes?: {
        distance: number;
        duration: number;
        legs: { distance: number; duration: number; steps: { geometry: { coordinates: LngLat[] } }[] }[];
      }[];
    } | null;
    const route = body?.routes?.[0];
    if (!res.ok || !route) {
      if (body?.code === 'NoRoute') throw new RoutingError('No driving route was found between those places.');
      throw new RoutingError(`Routing failed: ${body?.message ?? `HTTP ${res.status}`}`);
    }
    return {
      distanceM: route.distance,
      durationS: route.duration,
      legs: route.legs.map((leg) => {
        const geometry: LngLat[] = [];
        for (const step of leg.steps) {
          for (const c of step.geometry.coordinates) {
            const last = geometry[geometry.length - 1];
            if (!last || last[0] !== c[0] || last[1] !== c[1]) geometry.push(c);
          }
        }
        return { distanceM: leg.distance, durationS: leg.duration, geometry };
      }),
    };
  },
};
