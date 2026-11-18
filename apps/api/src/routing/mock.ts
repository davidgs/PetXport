import { haversineM, type Place } from '@petxport/shared';
import type { LngLat, Point, RouteResult, RoutingProvider } from './types.js';

const CITIES: Place[] = [
  { name: 'Raleigh, NC', lat: 35.7796, lng: -78.6382 },
  { name: 'Richmond, VA', lat: 37.5407, lng: -77.436 },
  { name: 'Washington, DC', lat: 38.9072, lng: -77.0369 },
  { name: 'Philadelphia, PA', lat: 39.9526, lng: -75.1652 },
  { name: 'New York, NY', lat: 40.7128, lng: -74.006 },
  { name: 'Atlanta, GA', lat: 33.749, lng: -84.388 },
];

/** Straight-line "roads" at 50 mph. Used by tests; needs no network. */
export const mockProvider: RoutingProvider = {
  name: 'mock',
  async geocode(query) {
    const q = query.toLowerCase();
    return CITIES.filter((c) => c.name.toLowerCase().includes(q)).map((c) => {
      const [city, state] = c.name.split(', ');
      return { ...c, parts: { street: null, city: city!, state: state!, postalCode: null, country: 'us' } };
    });
  },
  async reverseGeocode(point) {
    return `Town ${point.lat.toFixed(2)},${point.lng.toFixed(2)}`;
  },
  async route(points: Point[]): Promise<RouteResult> {
    const legs = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const distanceM = haversineM(a, b) * 1.2;
      const steps = Math.max(1, Math.ceil(distanceM / 2000));
      const geometry: LngLat[] = [];
      for (let s = 0; s <= steps; s++) {
        geometry.push([a.lng + ((b.lng - a.lng) * s) / steps, a.lat + ((b.lat - a.lat) * s) / steps]);
      }
      legs.push({ distanceM, durationS: distanceM / 22.352, geometry });
    }
    return {
      distanceM: legs.reduce((n, l) => n + l.distanceM, 0),
      durationS: legs.reduce((n, l) => n + l.durationS, 0),
      legs,
    };
  },
};
