import type { Stop, StopCategory } from '@petxport/shared';
import { env } from '../env.js';
import { RoutingError } from './types.js';

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Larger areas than this (in degrees) would return thousands of places; the app asks the user to zoom in. */
export const MAX_SPAN_DEG = 0.6;

const FALLBACK_NAME: Record<StopCategory, string> = {
  fuel: 'Gas station',
  rest_area: 'Rest area',
  lodging: 'Hotel',
  food: 'Restaurant',
  shopping: 'Shopping centre',
};

function categoryOf(tags: Record<string, string>): StopCategory | null {
  if (tags.highway === 'rest_area' || tags.highway === 'services') return 'rest_area';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.tourism === 'hotel' || tags.tourism === 'motel') return 'lodging';
  if (tags.amenity === 'restaurant' || tags.amenity === 'fast_food' || tags.amenity === 'cafe') return 'food';
  if (tags.shop === 'mall' || tags.shop === 'supermarket' || tags.shop === 'department_store') return 'shopping';
  return null;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function toStops(elements: OverpassElement[]): Stop[] {
  const stops: Stop[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const category = categoryOf(tags);
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!category || lat == null || lng == null) continue;
    if (tags.access === 'private' || tags.access === 'no') continue;
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const address = [street, tags['addr:city']].filter(Boolean).join(', ') || null;
    stops.push({
      id: `${el.type}/${el.id}`,
      name: (tags.name ?? tags.brand ?? tags.operator ?? FALLBACK_NAME[category]).slice(0, 120),
      category,
      lat,
      lng,
      address,
    });
  }
  return stops;
}

const cache = new Map<string, { at: number; stops: Stop[] }>();
/** After every server has failed, do not make people wait on them again for a little while. */
let unavailableUntil = 0;
const BUSY = 'The place lookup service is busy. Move the map a little to try again, or tap the map to set the handoff yourself.';
const CACHE_MS = 15 * 60_000;

/** Gas stations, rest areas, hotels, restaurants and shopping centres inside a map area, from OpenStreetMap. */
export async function findStops(b: Bounds): Promise<Stop[]> {
  if (b.north - b.south > MAX_SPAN_DEG || b.east - b.west > MAX_SPAN_DEG) {
    throw new RoutingError('Zoom in further to see places.');
  }
  if (env.isTest) {
    return toStops([
      { type: 'node', id: 1, lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2, tags: { amenity: 'fuel', brand: 'Test Fuel', 'addr:street': 'Main St', 'addr:city': 'Testville' } },
      { type: 'way', id: 2, center: { lat: b.south, lon: b.west }, tags: { highway: 'rest_area', name: 'Mile 42 Rest Area' } },
      { type: 'node', id: 3, lat: b.north, lon: b.east, tags: { amenity: 'bench' } },
    ]);
  }
  // Snap outward to a coarse grid so small pans reuse the cached answer.
  const grid = 0.05;
  const box = [
    Math.floor(b.south / grid) * grid,
    Math.floor(b.west / grid) * grid,
    Math.ceil(b.north / grid) * grid,
    Math.ceil(b.east / grid) * grid,
  ].map((n) => n.toFixed(2));
  const key = box.join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.stops;

  const area = `(${key})`;
  const query = `[out:json][timeout:9];
(
  nwr["amenity"="fuel"]${area};
  nwr["highway"~"^(rest_area|services)$"]${area};
  nwr["tourism"~"^(hotel|motel)$"]${area};
  nwr["amenity"~"^(restaurant|fast_food|cafe)$"]["name"]${area};
  nwr["shop"~"^(mall|supermarket|department_store)$"]["name"]${area};
);
out center tags 600;`;
  if (Date.now() < unavailableUntil) throw new RoutingError(BUSY);
  // Public Overpass servers are often briefly overloaded, so each configured one is tried in turn.
  let res: Response | null = null;
  for (const url of env.overpassUrls) {
    try {
      const attempt = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'PetXport/0.1 (volunteer pet transport planner)' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(10_000),
      });
      res = attempt;
      if (attempt.ok) break;
    } catch {
      // Try the next server.
    }
  }
  if (!res?.ok) {
    if (!res || res.status === 429 || res.status >= 500) {
      unavailableUntil = Date.now() + 60_000;
      throw new RoutingError(BUSY);
    }
    throw new RoutingError(`Place lookup failed (${res.status}). You can still tap the map to set the handoff.`);
  }
  const body = (await res.json()) as { elements?: OverpassElement[] };
  const stops = toStops(body.elements ?? []);
  cache.set(key, { at: Date.now(), stops });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return stops;
}
