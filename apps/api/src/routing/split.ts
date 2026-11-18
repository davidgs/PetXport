import { METERS_PER_MILE, haversineM } from '@petxport/shared';
import type { LngLat, Point } from './types.js';

/** How far a leg may exceed the target before another leg is added. */
export const LEG_TOLERANCE = 0.15;

/**
 * Fewest legs such that every leg (when cut evenly) is within tolerance of
 * both the distance target and the time target.
 */
export function chooseLegCount(
  distanceM: number,
  durationS: number,
  targetMiles: number,
  targetMinutes: number,
  tolerance = LEG_TOLERANCE,
): number {
  const ratio = Math.max(distanceM / (targetMiles * METERS_PER_MILE), durationS / (targetMinutes * 60));
  return Math.max(1, Math.ceil(ratio / (1 + tolerance) - 1e-9));
}

const dist = (a: LngLat, b: LngLat) => haversineM({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });

export function lineLengthM(line: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += dist(line[i - 1]!, line[i]!);
  return total;
}

/** The n-1 points that divide the line into n pieces of equal length. */
export function cutPoints(line: LngLat[], n: number): Point[] {
  if (n <= 1 || line.length < 2) return [];
  const total = lineLengthM(line);
  const cuts: Point[] = [];
  let walked = 0;
  let next = 1;
  for (let i = 1; i < line.length && next < n; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = dist(a, b);
    while (next < n && walked + seg >= (total * next) / n) {
      const t = seg === 0 ? 0 : ((total * next) / n - walked) / seg;
      cuts.push({ lng: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t });
      next++;
    }
    walked += seg;
  }
  return cuts;
}

/** Drops points closer than minStepM to the previously kept one. Keeps both ends. */
export function simplify(line: LngLat[], minStepM = 75): LngLat[] {
  if (line.length <= 2) return line;
  const out: LngLat[] = [line[0]!];
  for (let i = 1; i < line.length - 1; i++) {
    if (dist(out[out.length - 1]!, line[i]!) >= minStepM) out.push(line[i]!);
  }
  out.push(line[line.length - 1]!);
  return out.map(([lng, lat]) => [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
}

/** Each leg leaves when the previous one arrives plus the handoff buffer. */
export function scheduleLegs(
  departAt: Date,
  durationsS: number[],
  bufferMinutes: number,
): { departAt: Date; arriveAt: Date }[] {
  const out: { departAt: Date; arriveAt: Date }[] = [];
  let t = departAt.getTime();
  for (const d of durationsS) {
    const arrive = t + d * 1000;
    out.push({ departAt: new Date(t), arriveAt: new Date(arrive) });
    t = arrive + bufferMinutes * 60_000;
  }
  return out;
}
