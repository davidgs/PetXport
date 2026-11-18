import { formatAddress, type AddressParts, type Place } from '@petxport/shared';
import { env } from '../env.js';
import { RoutingError, type LngLat, type Point, type RouteResult, type RoutingProvider } from './types.js';

const BASE = 'https://api.openrouteservice.org';

interface OrsFeature<P> {
  geometry: { coordinates: LngLat[] | LngLat };
  properties: P;
}

async function orsFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const body = (await res.json().catch(() => null)) as (T & { error?: { code?: number; message?: string } | string }) | null;
  if (!res.ok || !body) {
    if (res.status === 429) {
      throw new RoutingError('The routing service limit has been reached for now. Try again later.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new RoutingError('The OpenRouteService API key was rejected. Check ORS_API_KEY.');
    }
    const err = body?.error;
    const code = typeof err === 'object' ? err?.code : undefined;
    const message = typeof err === 'object' ? err?.message : err;
    if (code === 2004) throw new RoutingError('That trip is too long to route in one go (limit is about 3,700 miles).');
    if (code === 2009 || code === 2010) throw new RoutingError('No driving route was found between those places.');
    throw new RoutingError(`Routing failed: ${message ?? `HTTP ${res.status}`}`);
  }
  return body;
}

export const orsProvider: RoutingProvider = {
  name: 'ors',
  async geocode(query) {
    const params = new URLSearchParams({ api_key: env.orsApiKey, text: query, size: '5' });
    const body = await orsFetch<{
      features: OrsFeature<{
        label: string;
        name?: string;
        layer?: string;
        housenumber?: string;
        street?: string;
        locality?: string;
        localadmin?: string;
        county?: string;
        region?: string;
        region_a?: string;
        postalcode?: string;
        country_code?: string;
      }>[];
    }>(`${BASE}/geocode/search?${params}`);
    return body.features.map((f): Place => {
      const [lng, lat] = f.geometry.coordinates as LngLat;
      const p = f.properties;
      const parts: AddressParts = {
        street: [p.housenumber, p.street].filter(Boolean).join(' ') || null,
        city: p.locality ?? p.localadmin ?? null,
        state: p.region_a ?? p.region ?? null,
        postalCode: p.postalcode ?? null,
        country: p.country_code?.toLowerCase().slice(0, 2) ?? null,
      };
      // Businesses and landmarks lead with their name; plain addresses and towns do not repeat it.
      const placeName = p.layer === 'venue' ? p.name : null;
      const label = formatAddress(parts.city || parts.street ? parts : { ...parts, city: p.county }, placeName);
      return { name: label || p.label, lat, lng, parts };
    });
  },
  async reverseGeocode(point) {
    const params = new URLSearchParams({
      api_key: env.orsApiKey,
      'point.lon': String(point.lng),
      'point.lat': String(point.lat),
      size: '1',
      layers: 'locality,localadmin,county',
    });
    const body = await orsFetch<{
      features: OrsFeature<{ name?: string; region_a?: string; region?: string; label?: string }>[];
    }>(`${BASE}/geocode/reverse?${params}`);
    const p = body.features[0]?.properties;
    if (!p) return null;
    return [p.name, p.region_a ?? p.region].filter(Boolean).join(', ') || p.label || null;
  },
  async route(points: Point[]): Promise<RouteResult> {
    const body = await orsFetch<{
      features: OrsFeature<{
        summary: { distance: number; duration: number };
        segments: { distance: number; duration: number }[];
        way_points: number[];
      }>[];
    }>(`${BASE}/v2/directions/driving-car/geojson`, {
      method: 'POST',
      headers: { Authorization: env.orsApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: points.map((p) => [p.lng, p.lat]), instructions: false }),
    });
    const feature = body.features[0];
    if (!feature) throw new RoutingError('No driving route was found between those places.');
    const line = feature.geometry.coordinates as LngLat[];
    const { segments, way_points: wayPoints, summary } = feature.properties;
    return {
      distanceM: summary.distance,
      durationS: summary.duration,
      legs: segments.map((seg, i) => ({
        distanceM: seg.distance,
        durationS: seg.duration,
        geometry: line.slice(wayPoints[i], (wayPoints[i + 1] ?? line.length - 1) + 1),
      })),
    };
  },
};
