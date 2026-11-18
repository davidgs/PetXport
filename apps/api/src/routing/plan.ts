import type { Place } from '@petxport/shared';
import { chooseLegCount, cutPoints, simplify } from './split.js';
import type { LngLat, RoutingProvider } from './types.js';

export interface PlannedLeg {
  start: Place;
  end: Place;
  distanceM: number;
  durationS: number;
  geometry: LngLat[];
}

/** Routes origin → handoffs → destination and returns one leg per hop. */
export async function planThrough(
  provider: RoutingProvider,
  origin: Place,
  destination: Place,
  handoffs: Place[],
): Promise<PlannedLeg[]> {
  const stops = [origin, ...handoffs, destination];
  const result = await provider.route(stops);
  return result.legs.map((leg, i) => ({
    start: stops[i]!,
    end: stops[i + 1]!,
    distanceM: Math.round(leg.distanceM),
    durationS: Math.round(leg.durationS),
    geometry: simplify(leg.geometry),
  }));
}

/** Splits a trip into legs of roughly the target length, with handoffs named after the nearest town. */
export async function planRoute(
  provider: RoutingProvider,
  origin: Place,
  destination: Place,
  target: { miles: number; minutes: number },
): Promise<PlannedLeg[]> {
  const whole = await provider.route([origin, destination]);
  const n = chooseLegCount(whole.distanceM, whole.durationS, target.miles, target.minutes);
  if (n === 1) {
    const leg = whole.legs[0]!;
    return [
      {
        start: origin,
        end: destination,
        distanceM: Math.round(leg.distanceM),
        durationS: Math.round(leg.durationS),
        geometry: simplify(leg.geometry),
      },
    ];
  }
  const handoffs: Place[] = [];
  for (const [i, point] of cutPoints(whole.legs[0]!.geometry, n).entries()) {
    let label: string | null = null;
    try {
      label = await provider.reverseGeocode(point);
    } catch {
      // A missing label is not worth failing the plan for.
    }
    handoffs.push({ name: label ? `Near ${label}` : `Handoff ${i + 1}`, lat: point.lat, lng: point.lng });
  }
  return planThrough(provider, origin, destination, handoffs);
}
