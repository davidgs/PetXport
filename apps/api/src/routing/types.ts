import type { Place } from '@petxport/shared';

export type LngLat = [number, number];
export interface Point {
  lat: number;
  lng: number;
}

export interface RouteLeg {
  distanceM: number;
  durationS: number;
  /** [lng, lat] pairs. */
  geometry: LngLat[];
}

export interface RouteResult {
  distanceM: number;
  durationS: number;
  /** One per consecutive pair of points passed to route(). */
  legs: RouteLeg[];
}

export interface RoutingProvider {
  name: string;
  geocode(query: string): Promise<Place[]>;
  /** A short "Town, State" style label, or null when nothing is nearby. */
  reverseGeocode(point: Point): Promise<string | null>;
  route(points: Point[]): Promise<RouteResult>;
}

/** A problem the coordinator can act on (no route, too long, provider limit reached). */
export class RoutingError extends Error {}
