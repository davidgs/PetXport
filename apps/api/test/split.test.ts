import { METERS_PER_MILE, formatAddress, formatPhone, haversineM, parseCsv } from '@petxport/shared';
import { nominatimPlace } from '../src/routing/osrm.js';
import { describe, expect, it } from 'vitest';
import { mockProvider } from '../src/routing/mock.js';
import { planRoute, planThrough } from '../src/routing/plan.js';
import { chooseLegCount, cutPoints, lineLengthM, scheduleLegs, simplify } from '../src/routing/split.js';
import type { LngLat } from '../src/routing/types.js';

const mi = (n: number) => n * METERS_PER_MILE;
const hours = (n: number) => n * 3600;

describe('chooseLegCount', () => {
  it('keeps a short trip as one leg', () => {
    expect(chooseLegCount(mi(60), hours(1.1), 100, 120)).toBe(1);
  });
  it('does not split a trip that is only slightly over the target', () => {
    expect(chooseLegCount(mi(110), hours(1.9), 100, 120)).toBe(1);
  });
  it('splits 250 miles into three legs', () => {
    expect(chooseLegCount(mi(250), hours(4), 100, 120)).toBe(3);
  });
  it('uses time when roads are slow', () => {
    // 150 mountain miles taking 5 hours: distance alone says 2 legs, time says 3.
    expect(chooseLegCount(mi(150), hours(5), 100, 120)).toBe(3);
  });
  it('handles a cross-country trip', () => {
    const n = chooseLegCount(mi(2800), hours(41), 100, 120);
    expect(n).toBe(25);
    expect(2800 / n).toBeLessThanOrEqual(115);
  });
  it('respects a custom target', () => {
    expect(chooseLegCount(mi(250), hours(4), 60, 90)).toBe(4);
  });
});

describe('cutPoints', () => {
  const line: LngLat[] = [
    [-78, 35],
    [-78, 36],
    [-78, 37],
    [-78, 38],
  ];
  it('returns n-1 evenly spaced points on the line', () => {
    const cuts = cutPoints(line, 3);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]!.lat).toBeCloseTo(36, 3);
    expect(cuts[1]!.lat).toBeCloseTo(37, 3);
  });
  it('interpolates inside a segment', () => {
    const cuts = cutPoints(line, 2);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.lat).toBeCloseTo(36.5, 3);
    expect(cuts[0]!.lng).toBe(-78);
  });
  it('returns nothing for a single leg', () => {
    expect(cutPoints(line, 1)).toEqual([]);
  });
  it('produces equal pieces on an uneven line', () => {
    const uneven: LngLat[] = [
      [-78, 35],
      [-78, 35.1],
      [-78, 37.9],
      [-78, 38],
    ];
    const cuts = cutPoints(uneven, 4);
    const stops = [{ lat: 35, lng: -78 }, ...cuts, { lat: 38, lng: -78 }];
    const pieces = stops.slice(1).map((s, i) => haversineM(stops[i]!, s));
    for (const p of pieces) expect(p).toBeCloseTo(lineLengthM(uneven) / 4, -2);
  });
});

describe('scheduleLegs', () => {
  it('chains legs with a handoff buffer', () => {
    const start = new Date('2026-12-05T13:00:00Z');
    const times = scheduleLegs(start, [hours(2), hours(1.5)], 15);
    expect(times[0]!.departAt.toISOString()).toBe('2026-12-05T13:00:00.000Z');
    expect(times[0]!.arriveAt.toISOString()).toBe('2026-12-05T15:00:00.000Z');
    expect(times[1]!.departAt.toISOString()).toBe('2026-12-05T15:15:00.000Z');
    expect(times[1]!.arriveAt.toISOString()).toBe('2026-12-05T16:45:00.000Z');
  });
});

describe('simplify', () => {
  it('keeps both ends and drops crowded points', () => {
    const line: LngLat[] = Array.from({ length: 1000 }, (_, i) => [-78, 35 + i * 0.0001]);
    const out = simplify(line, 75);
    expect(out[0]).toEqual([-78, 35]);
    expect(out[out.length - 1]![1]).toBeCloseTo(35.0999, 4);
    expect(out.length).toBeLessThan(200);
  });
});

describe('planRoute', () => {
  const raleigh = { name: 'Raleigh, NC', lat: 35.7796, lng: -78.6382 };
  const nyc = { name: 'New York, NY', lat: 40.7128, lng: -74.006 };

  it('splits Raleigh to New York into contiguous legs near the target', async () => {
    const legs = await planRoute(mockProvider, raleigh, nyc, { miles: 100, minutes: 120 });
    expect(legs.length).toBeGreaterThanOrEqual(4);
    expect(legs[0]!.start).toEqual(raleigh);
    expect(legs[legs.length - 1]!.end).toEqual(nyc);
    for (const [i, leg] of legs.entries()) {
      expect(leg.distanceM / METERS_PER_MILE).toBeLessThanOrEqual(116);
      expect(leg.durationS / 60).toBeLessThanOrEqual(139);
      if (i > 0) expect(leg.start).toEqual(legs[i - 1]!.end);
      expect(leg.geometry.length).toBeGreaterThan(1);
    }
    expect(legs[0]!.end.name).toMatch(/^Near Town/);
  });

  it('returns one leg for a short trip', async () => {
    const legs = await planRoute(mockProvider, raleigh, { name: 'Durham, NC', lat: 35.994, lng: -78.8986 }, { miles: 100, minutes: 120 });
    expect(legs).toHaveLength(1);
  });

  it('routes through chosen handoffs', async () => {
    const legs = await planThrough(mockProvider, raleigh, nyc, [{ name: 'Truck stop', lat: 37.54, lng: -77.43 }]);
    expect(legs).toHaveLength(2);
    expect(legs[0]!.end.name).toBe('Truck stop');
    expect(legs[1]!.start.name).toBe('Truck stop');
  });
});

describe('parseCsv', () => {
  it('handles quotes, embedded commas and blank lines', () => {
    const rows = parseCsv('name,email,address\r\n"Lee, Pat",pat@example.org,"12 Oak St, Cary NC"\n\n"Sam ""Skip"" Roe",sam@example.org,\n');
    expect(rows).toEqual([
      ['name', 'email', 'address'],
      ['Lee, Pat', 'pat@example.org', '12 Oak St, Cary NC'],
      ['Sam "Skip" Roe', 'sam@example.org', ''],
    ]);
  });
});

describe('addresses', () => {
  it('keeps the postal pieces of a lookup result and drops the neighbourhood and county', () => {
    const place = nominatimPlace({
      display_name: '1776, Pierre Place, Olive Chapel Park, Apex, Wake County, North Carolina, 27502, United States',
      name: '',
      lat: '35.7327',
      lon: '-78.8503',
      address: {
        house_number: '1776',
        road: 'Pierre Place',
        neighbourhood: 'Olive Chapel Park',
        town: 'Apex',
        county: 'Wake County',
        state: 'North Carolina',
        'ISO3166-2-lvl4': 'US-NC',
        postcode: '27502',
        country: 'United States',
        country_code: 'us',
      } as never,
    });
    expect(place.name).toBe('1776 Pierre Place, Apex, NC 27502');
    expect(place.parts).toEqual({ street: '1776 Pierre Place', city: 'Apex', state: 'NC', postalCode: '27502', country: 'us' });
  });

  it('names towns, businesses, bare counties and places abroad sensibly', () => {
    const base = { lat: '0', lon: '0' };
    expect(nominatimPlace({ ...base, display_name: 'Raleigh, Wake County, North Carolina, United States', name: 'Raleigh', address: { city: 'Raleigh', county: 'Wake County', 'ISO3166-2-lvl4': 'US-NC', country_code: 'us' } }).name).toBe('Raleigh, NC');
    expect(
      nominatimPlace({ ...base, display_name: 'x', name: 'Cracker Barrel', address: { house_number: '7071', road: 'Arundel Mills Circle', city: 'Hanover', county: 'Anne Arundel County', 'ISO3166-2-lvl4': 'US-MD', postcode: '21076', country_code: 'us' } }).name,
    ).toBe('Cracker Barrel, 7071 Arundel Mills Circle, Hanover, MD 21076');
    // A county is only named when it is the result itself.
    expect(nominatimPlace({ ...base, display_name: 'x', name: 'Wake County', address: { county: 'Wake County', 'ISO3166-2-lvl4': 'US-NC', country_code: 'us' } }).name).toBe('Wake County, NC');
    expect(nominatimPlace({ ...base, display_name: 'x', name: '', address: { house_number: '24', road: 'Sussex Drive', city: 'Ottawa', 'ISO3166-2-lvl4': 'CA-ON', postcode: 'K1M 1M4', country_code: 'ca' } }).name).toBe('24 Sussex Drive, Ottawa, ON K1M 1M4, CA');
    // Nothing usable: fall back to what the service said.
    expect(nominatimPlace({ ...base, display_name: 'Atlantic Ocean', address: {} }).name).toBe('Atlantic Ocean');
    expect(formatAddress({ city: 'Apex', state: 'NC' })).toBe('Apex, NC');
  });
});

describe('formatPhone', () => {
  it('shows ten-digit numbers as (xxx) yyy-zzzz however they were typed', () => {
    for (const typed of ['9195550123', '919-555-0123', '919.555.0123', '(919)555-0123', ' 919 555 0123 ', '1-919-555-0123', '+1 919 555 0123', '+19195550123']) {
      expect(formatPhone(typed), typed).toBe('(919) 555-0123');
    }
  });
  it('leaves anything else as entered', () => {
    expect(formatPhone('555-0123')).toBe('555-0123');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone('919-555-0123 x12')).toBe('919-555-0123 x12');
    expect(formatPhone('')).toBe('');
    expect(formatPhone(null)).toBe('');
  });
});
