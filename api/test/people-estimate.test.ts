// The people in town window (spec 13.2): a headcount range only where every input has a source, each reason for a
// null, the between-terms and summer rules, event attendance raising only the high end, outward rounding to 100,
// periods merged and split around events, and every public number resolving to a source id. All inputs are synthetic.
import { describe, expect, it } from 'vitest';

import { CAVEATS, peopleInTownWindow, type PeopleInTownWindow, type WindowInput } from '../src/people-in-town/estimate.ts';
import type { PeopleData, TownPeopleData } from '../src/people-in-town/sources.ts';
import type { TermDay, TermState } from '../src/people-in-town/term.ts';
import type { TownEvent } from '../src/town-calendar.ts';
import { TOWN_PROFILES } from '../src/town-profiles.ts';
import { TOWNS } from '../src/towns.ts';

const HANOVER = TOWNS.find((town) => town.townId === 'hanover-nh');
const NANTUCKET = TOWNS.find((town) => town.townId === 'nantucket-ma');
const HANOVER_PROFILE = TOWN_PROFILES.find((profile) => profile.townId === 'hanover-nh');

const SOURCES: PeopleData['sources'] = [
  { id: 'census-test', label: 'Synthetic census table', url: 'https://census.example.test/p1', retrieved: '2026-11-01', confidence: 'high' },
  { id: 'housing-test', label: 'Synthetic housing table', url: 'https://census.example.test/p5', retrieved: '2026-11-01', confidence: 'high' },
  { id: 'enroll-test', label: 'Synthetic enrollment', url: 'https://college.example.test/enrollment', retrieved: '2026-11-01', confidence: 'medium' },
  { id: 'closes-test', label: 'Synthetic housing calendar', url: 'https://college.example.test/housing', retrieved: '2026-11-01', confidence: 'medium' },
  { id: 'attend-test', label: 'Synthetic box scores', url: 'https://sports.example.test/box', retrieved: '2026-11-01', confidence: 'low' },
];

const FULL: TownPeopleData = {
  townId: 'hanover-nh',
  residents: { value: 10_000, moe90: 500, vintage: '2020', sourceId: 'census-test' },
  studentHousing: { value: 3000, vintage: '2020', sourceId: 'housing-test' },
  enrollment: { value: 4000, term: 'fall', institution: 'Example College', sourceId: 'enroll-test' },
  housingClosesBetweenTerms: { sourceId: 'closes-test' },
  eventAttendance: [{ group: 'hanover-nh:home-football', high: 6000, basis: 'reported_past', sourceId: 'attend-test' }],
  visitors: null,
};

function data(entry: Partial<TownPeopleData> = {}): PeopleData {
  return { sources: SOURCES, towns: [{ ...FULL, ...entry }] };
}

const TERM_SOURCE = { label: 'Example registrar', url: 'https://registrar.example.test/' };

function termDay(state: TermState): TermDay {
  if (state === 'unknown') return { state, label: null, events: [] };
  const event: TownEvent = {
    id: `test:${state}`, title: state, start: '2026-01-01', end: '2026-12-31', kind: 'term', scope: 'town', group: null,
    groupLabel: null, confidence: 'high', sources: [TERM_SOURCE],
  };
  return { state, label: state, events: [event] };
}

const FOOTBALL: TownEvent = {
  id: 'hanover-nh:2026-10-17:home-football-vs-test', title: 'Home football vs Test', start: '2026-10-17', end: '2026-10-17',
  kind: 'event', scope: 'town', group: 'hanover-nh:home-football', groupLabel: 'Home football', confidence: 'medium',
  sources: [{ label: 'Example athletics', url: 'https://sports.example.test/schedule' }],
};
const FESTIVAL: TownEvent = { ...FOOTBALL, id: 'hanover-nh:2026-10-17:test-festival', title: 'Test festival', group: 'hanover-nh:festival' };

const EMPTY_HISTORY = { metric: 'guests' as const, cells: [], first: null, last: null };

function windowOf(overrides: Partial<WindowInput> & { state?: TermState } = {}): PeopleInTownWindow {
  const { state = 'in_session', ...rest } = overrides;
  return peopleInTownWindow({
    town: { name: 'Hanover', state: 'NH' },
    record: HANOVER,
    profile: HANOVER_PROFILE,
    data: data(),
    range: { from: '2026-10-14', to: '2026-10-16' },
    timeZone: 'America/New_York',
    events: [],
    termOn: () => termDay(state),
    history: EMPTY_HISTORY,
    ...rest,
  });
}

describe('why a headcount is null', () => {
  it('no_population: a town outside the twelve, or a college town with no researched residents', () => {
    const outside = windowOf({ record: undefined, profile: undefined, town: { name: 'Woodstock', state: 'VT' } });
    expect(outside).toMatchObject({ available: false, reason: 'town_not_researched', town: { kind: null } });
    expect(outside.periods.map((period) => period.headcountWhy)).toEqual(['no_population']);
    expect(windowOf({ data: { sources: [], towns: [] } }).periods[0]?.headcountWhy).toBe('no_population');
    expect(windowOf({ data: data({ residents: null }) }).periods[0]?.headcountWhy).toBe('no_population');
  });

  it('visitors_unknown: a seasonal or event town never gets a headcount, even with residents researched', () => {
    const nantucket = windowOf({ record: NANTUCKET, town: { name: 'Nantucket', state: 'MA' }, data: data({ townId: 'nantucket-ma' }) });
    expect(nantucket.available).toBe(true);
    expect(nantucket.periods.map((period) => [period.headcount, period.headcountWhy])).toEqual([[null, 'visitors_unknown']]);
  });

  it('no_term_dates: an unknown term state', () => {
    expect(windowOf({ state: 'unknown' }).periods[0]).toMatchObject({ headcount: null, headcountWhy: 'no_term_dates' });
  });

  it('no_enrollment: between terms without enrollment or student housing, and the summer session without enrollment', () => {
    expect(windowOf({ state: 'between_terms', data: data({ enrollment: null }) }).periods[0]?.headcountWhy).toBe('no_enrollment');
    expect(windowOf({ state: 'between_terms', data: data({ studentHousing: null }) }).periods[0]?.headcountWhy).toBe('no_enrollment');
    expect(windowOf({ state: 'summer_session', data: data({ enrollment: null }) }).periods[0]?.headcountWhy).toBe('no_enrollment');
  });
});

describe('the headcount range', () => {
  it('is residents plus or minus the margin in session and during finals, from the census source', () => {
    for (const state of ['in_session', 'finals'] as const) {
      const [period] = windowOf({ state }).periods;
      expect(period?.headcount).toEqual({ low: 9500, high: 10_500, sourceIds: ['census-test'], excludes: [] });
      expect(period?.headcountWhy).toBeNull();
    }
    expect(windowOf().caveats).toContain(CAVEATS.census);
  });

  it('without a margin is the single count, and says so', () => {
    const window = windowOf({ data: data({ residents: { value: 10_000, moe90: null, vintage: '2020', sourceId: 'census-test' } }) });
    expect(window.periods[0]?.headcount).toMatchObject({ low: 10_000, high: 10_000 });
    expect(window.caveats).toContain('Residents are a single count from 2020, with no margin of error.');
  });

  it('between terms: low minus enrollment; high minus student housing only when housing closes', () => {
    const closes = windowOf({ state: 'between_terms' });
    expect(closes.periods[0]?.headcount).toEqual({
      low: 5500, high: 7500, sourceIds: ['census-test', 'enroll-test', 'housing-test', 'closes-test'], excludes: [],
    });
    expect(closes.caveats).toContain(CAVEATS.betweenTerms);
    const stays = windowOf({ state: 'between_terms', data: data({ housingClosesBetweenTerms: null }) });
    expect(stays.periods[0]?.headcount).toEqual({ low: 5500, high: 10_500, sourceIds: ['census-test', 'enroll-test'], excludes: [] });
  });

  it('summer session: low minus enrollment, high unchanged', () => {
    expect(windowOf({ state: 'summer_session' }).periods[0]?.headcount).toMatchObject({ low: 5500, high: 10_500 });
  });

  it('an event with researched attendance raises only the high end; one without is listed as left out', () => {
    const window = windowOf({ range: { from: '2026-10-17', to: '2026-10-17' }, events: [FOOTBALL, FESTIVAL] });
    expect(window.periods[0]?.headcount).toEqual({
      low: 9500, high: 16_500, sourceIds: ['census-test', 'attend-test'],
      excludes: ['This range leaves out visitors for Test festival; Townwise has no attendance figure.'],
    });
    expect(window.periods[0]?.events.map((event) => [event.title, event.attendanceHigh])).toEqual([
      ['Home football vs Test', 6000], ['Test festival', null],
    ]);
    expect(window.caveats).toContain(CAVEATS.attendance);
  });

  it('rounds the low end down and the high end up to the nearest 100, never below 0', () => {
    const odd = windowOf({ data: data({ residents: { value: 10_049, moe90: 51, vintage: '2020', sourceId: 'census-test' } }) });
    expect(odd.periods[0]?.headcount).toMatchObject({ low: 9900, high: 10_100 });
    const tiny = windowOf({ state: 'between_terms', data: data({ residents: { value: 300, moe90: null, vintage: '2020', sourceId: 'census-test' } }) });
    expect(tiny.periods[0]?.headcount).toMatchObject({ low: 0, high: 0 });
  });
});

describe('periods, season and sources', () => {
  it('merges identical days and splits around a single-day event, each period with its weekdays', () => {
    const window = windowOf({ range: { from: '2026-10-15', to: '2026-10-19' }, events: [FOOTBALL] });
    expect(window.periods.map((period) => [period.from, period.fromWeekday, period.to, period.toWeekday, period.events.length])).toEqual([
      ['2026-10-15', 'Thu', '2026-10-16', 'Fri', 0],
      ['2026-10-17', 'Sat', '2026-10-17', 'Sat', 1],
      ['2026-10-18', 'Sun', '2026-10-19', 'Mon', 0],
    ]);
  });

  it('lists term and season entries as context, never as events', () => {
    const term: TownEvent = { ...FOOTBALL, id: 'term', kind: 'term' };
    const season: TownEvent = { ...FOOTBALL, id: 'season', kind: 'season' };
    expect(windowOf({ range: { from: '2026-10-17', to: '2026-10-17' }, events: [term, season] }).periods[0]?.events).toEqual([]);
  });

  it('gives each month the county jobs index from the town profile, with the county caveats', () => {
    const window = windowOf({ range: { from: '2026-10-25', to: '2026-11-05' } });
    expect(window.season.map((month) => [month.month, month.countyFoodServiceJobsIndex, month.baseYear, month.county])).toEqual([
      ['2026-10', HANOVER_PROFILE?.series.index[9], 2024, 'Grafton County'],
      ['2026-11', HANOVER_PROFILE?.series.index[10], 2024, 'Grafton County'],
    ]);
    expect(window.caveats).toEqual(expect.arrayContaining([CAVEATS.county, CAVEATS.employment]));
  });

  it('gives visitors as a per-day average of a researched monthly count, with its caveat', () => {
    const window = windowOf({
      range: { from: '2026-06-01', to: '2026-06-30' },
      data: data({ visitors: { label: 'Synthetic park visits', monthly: [{ month: '2026-06', value: 3000 }], sourceId: 'attend-test' } }),
    });
    expect(window.visitors).toEqual([{ month: '2026-06', label: 'Synthetic park visits', perDayAverage: 100, sourceIds: ['attend-test'] }]);
    expect(window.caveats).toContain(CAVEATS.visitors);
  });

  it('every public number in the window sits in an object whose sourceIds all resolve; only your history is uncited', () => {
    const window = windowOf({
      state: 'between_terms', range: { from: '2026-10-01', to: '2026-11-30' }, events: [FOOTBALL, FESTIVAL],
      data: data({ visitors: { label: 'Synthetic park visits', monthly: [{ month: '2026-10', value: 3100 }], sourceId: 'attend-test' } }),
    });
    const ids = new Set(window.sources.map((source) => source.id));
    let numbers = 0;
    const walk = (value: unknown, cited: boolean): void => {
      if (typeof value === 'number') {
        numbers += 1;
        expect(cited).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, cited);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      let here = cited;
      if (Array.isArray(record.sourceIds)) {
        expect(record.sourceIds.length).toBeGreaterThan(0);
        for (const id of record.sourceIds as string[]) expect(ids.has(id)).toBe(true);
        here = true;
      }
      for (const [key, inner] of Object.entries(record)) {
        if (key !== 'yourHistory') walk(inner, here);
      }
    };
    walk(window, false);
    expect(numbers).toBeGreaterThan(5);
    expect(window.sources.every((source) => source.url.startsWith('https://'))).toBe(true);
    expect(window.sources.find((source) => source.id === 'bls-qcew')).toMatchObject({ confidence: 'high', url: 'https://www.bls.gov/cew/additional-resources/open-data/' });
  });

  it('numbers calendar sources cal-1, cal-2 in first-use order and keeps each one’s lowest rating', () => {
    const lowFestival: TownEvent = { ...FESTIVAL, confidence: 'low' };
    const window = windowOf({ data: { sources: [], towns: [] }, range: { from: '2026-10-17', to: '2026-10-17' }, events: [FOOTBALL, lowFestival] });
    expect(window.sources.filter((source) => source.id.startsWith('cal-'))).toEqual([
      { id: 'cal-1', label: 'Example athletics', url: 'https://sports.example.test/schedule', confidence: 'low' },
      { id: 'cal-2', label: 'Example registrar', url: 'https://registrar.example.test/', confidence: 'high' },
    ]);
  });
});
