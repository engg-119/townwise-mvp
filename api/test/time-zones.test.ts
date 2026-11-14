// A location's time zone and local day (spec 13.2): the twelve towns are Eastern exactly, another town gets its
// state's zone (approximate in split states), and the local day turns at local midnight across both DST changes.
import { describe, expect, it } from 'vitest';

import { localDay, localMinutes, timeZoneOf, weekdayOf } from '../src/time-zones.ts';
import { TOWNS, US_STATE_CODES } from '../src/towns.ts';

describe('timeZoneOf', () => {
  it('puts each of the twelve towns in America/New_York, exactly', () => {
    for (const town of TOWNS) {
      expect(timeZoneOf({ townId: town.townId, name: town.name, state: town.state })).toEqual({ timeZone: 'America/New_York', approximate: false });
    }
  });

  it('gives another town a real zone for every one of the 51 codes, approximate only in the split states', () => {
    const split = ['AK', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'OR', 'SD', 'TN', 'TX'];
    for (const state of US_STATE_CODES) {
      const zone = timeZoneOf({ townId: null, name: 'Elsewhere', state });
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone.timeZone })).not.toThrow();
      expect({ state, approximate: zone.approximate }).toEqual({ state, approximate: split.includes(state) });
    }
    expect(US_STATE_CODES).toHaveLength(51);
    expect(timeZoneOf({ townId: null, name: 'Woodstock', state: 'VT' }).timeZone).toBe('America/New_York');
    expect(timeZoneOf({ townId: null, name: 'Bend', state: 'OR' })).toEqual({ timeZone: 'America/Los_Angeles', approximate: true });
    expect(timeZoneOf({ townId: null, name: 'Hilo', state: 'HI' })).toEqual({ timeZone: 'Pacific/Honolulu', approximate: false });
  });
});

describe('localMinutes', () => {
  it('counts minutes since the town’s midnight, 0 at midnight and across a DST change', () => {
    const eastern = 'America/New_York';
    expect(localMinutes(new Date('2026-06-01T12:00:00.000Z'), eastern)).toBe(8 * 60);
    expect(localMinutes(new Date('2026-01-15T04:30:00.000Z'), eastern)).toBe(23 * 60 + 30);
    expect(localMinutes(new Date('2026-06-01T04:00:00.000Z'), eastern)).toBe(0);
    expect(localMinutes(new Date('2026-11-01T18:59:00.000Z'), eastern)).toBe(13 * 60 + 59);
    expect(localMinutes(new Date('2026-06-01T12:00:00.000Z'), 'America/Los_Angeles')).toBe(5 * 60);
  });
});

describe('localDay', () => {
  it('reads 03:30 UTC on Nov 6 as Nov 5 in Eastern time, and noon UTC as the same day', () => {
    expect(localDay(new Date('2026-11-06T03:30:00Z'), 'America/New_York')).toBe('2026-11-05');
    expect(localDay(new Date('2026-06-01T12:00:00Z'), 'America/New_York')).toBe('2026-06-01');
  });

  it('turns at local midnight on both sides of the DST changes (2026-03-08 and 2026-11-01)', () => {
    // EST (UTC-5) before 2026-03-08 02:00 local, EDT (UTC-4) after.
    expect(localDay(new Date('2026-03-08T04:59:00Z'), 'America/New_York')).toBe('2026-03-07');
    expect(localDay(new Date('2026-03-08T05:00:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDay(new Date('2026-03-09T03:59:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDay(new Date('2026-03-09T04:00:00Z'), 'America/New_York')).toBe('2026-03-09');
    // EDT before 2026-11-01 02:00 local, EST after.
    expect(localDay(new Date('2026-11-01T03:59:00Z'), 'America/New_York')).toBe('2026-10-31');
    expect(localDay(new Date('2026-11-01T04:00:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDay(new Date('2026-11-02T04:59:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDay(new Date('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02');
  });
});

describe('weekdayOf', () => {
  it('names the weekday of a day', () => {
    expect(['2026-11-01', '2026-11-02', '2026-11-05', '2026-11-07', '2026-11-21'].map(weekdayOf)).toEqual(['Sun', 'Mon', 'Thu', 'Sat', 'Sat']);
  });
});
