import type { z } from 'zod';

import type { ApiClient, RequestOptions } from '../../../src/api/client';
import { fetchForecast, forecastWindowSchema } from '../../../src/portal/estimates/api';

// The one client read of a location's published forecast (spec 10.13, GET .../forecast), shared by the Calendar,
// Home and TownwiseAI's pages. The fixture is the shape api/src/forecasts/reader.ts sends (ForecastWindow, as
// api/test/estimates.int.test.ts pins it), with the notes adjusting a day on read (spec 14.5). Every figure is made up.

const RUN = {
  id: 'r1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' },
  trainingSource: 'files_from_owner', trainedFrom: '2024-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', frozen: true,
  interval: { level: 0.8, widened: false }, backtest: null,
  live: { days: 6, inRange: 5, typicalErrorPct: 4.8, from: '2026-05-01', to: '2026-05-07' },
};

const PAST_DAY = {
  date: '2026-05-01', weekday: 'Fri', status: 'open', low: 80, mid: 100, high: 120, baseline: null,
  reasons: [
    { kind: 'weekday', label: 'Friday', effectPct: null, effect: null, sources: [], note: null },
    {
      kind: 'term', label: 'Spring term classes', effectPct: 12, effect: null,
      sources: [{ label: 'Dartmouth calendar', url: 'https://home.dartmouth.edu/calendar' }], note: null,
    },
  ],
  runId: 'r1', madeAt: '2026-05-01', madeAfterDay: true, actual: 100, inRange: true,
  model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 0, moreNotes: 0,
};

/** A private event of 70 guests, added on read: the day's range moves, the model's stays. */
const NOTED_DAY = {
  date: '2026-05-09', weekday: 'Sat', status: 'open', low: 150, mid: 170, high: 190, baseline: null,
  reasons: [
    { kind: 'note', label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, effect: null, sources: [], note: { id: 'n1', guests: 70, outcome: 'added' } },
    // From today on, how the location's own history usually ran on a Saturday (spec 14.4).
    { kind: 'weekday', label: 'Saturday', effectPct: null, effect: { direction: 'more', pct: 35, basis: 'history', days: 52 }, sources: [], note: null },
  ],
  runId: 'r1', madeAt: '2026-05-01', madeAfterDay: false, actual: null, inRange: null,
  model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 70, moreNotes: 2,
};

const WINDOW = {
  available: true, reason: null, runs: [RUN], days: [PAST_DAY, NOTED_DAY],
  weeks: [{ from: '2026-05-04', to: '2026-05-10', openDays: 6, low: 600, mid: 670, high: 740, runId: 'r1', madeAt: '2026-05-01', actual: null, inRange: null, noteGuests: 70 }],
  notCovered: [],
};

describe('forecastWindowSchema', () => {
  test('parses the API’s window, notes on read included, and strips the keys no page reads', () => {
    const parsed = forecastWindowSchema.parse(WINDOW);
    expect(parsed).toEqual({
      available: true, reason: null,
      runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, madeAt: '2026-05-01', live: RUN.live }],
      days: [
        {
          date: '2026-05-01', status: 'open', low: 80, mid: 100, high: 120,
          model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 0, moreNotes: 0,
          reasons: PAST_DAY.reasons, runId: 'r1', actual: 100, inRange: true,
        },
        {
          date: '2026-05-09', status: 'open', low: 150, mid: 170, high: 190,
          model: { status: 'open', low: 80, mid: 100, high: 120 }, noteGuests: 70, moreNotes: 2,
          reasons: NOTED_DAY.reasons, runId: 'r1', actual: null, inRange: null,
        },
      ],
      weeks: [{ from: '2026-05-04', to: '2026-05-10', openDays: 6, low: 600, mid: 670, high: 740, runId: 'r1', noteGuests: 70 }],
    });
  });

  test('a booked or closed day, a reason kind this client doesn’t know, and a week from an API before notes', () => {
    const booked = {
      ...NOTED_DAY, status: 'booked', low: null, mid: null, high: null, noteGuests: 70, moreNotes: 0,
      reasons: [
        { kind: 'note', label: 'Your private buyout, 70 guests', effectPct: null, sources: [], note: { id: 'n2', guests: 70, outcome: 'booked' } },
        { kind: 'parade', label: 'Something new', effectPct: null, effect: { direction: 'sideways', pct: 5, basis: 'history', days: 3 }, sources: [], note: null },
      ],
    };
    const closed = { ...PAST_DAY, status: 'closed', low: null, mid: null, high: null, model: { status: 'closed', low: null, mid: null, high: null }, inRange: null };
    const oldWeek = { from: '2026-05-04', to: '2026-05-10', openDays: 6, low: 600, mid: 670, high: 740, runId: 'r1', madeAt: '2026-05-01', actual: null, inRange: null };
    const parsed = forecastWindowSchema.parse({ ...WINDOW, days: [booked, closed], weeks: [oldWeek] });
    expect(parsed.days.map((day) => [day.status, day.mid, day.noteGuests])).toEqual([['booked', null, 70], ['closed', null, 0]]);
    expect(parsed.days[0]?.reasons.map((reason) => [reason.kind, reason.note?.outcome ?? null])).toEqual([['note', 'booked'], ['parade', null]]);
    // An effect this client can't read is none, never a broken page; one from an API before effects is missing.
    expect(parsed.days[0]?.reasons.map((reason) => reason.effect)).toEqual([undefined, null]);
    expect(parsed.weeks[0]?.noteGuests).toBe(0);
  });

  test('no published forecast', () => {
    const none = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], notCovered: [{ from: '2026-05-01', to: '2026-05-31' }] };
    expect(forecastWindowSchema.parse(none)).toEqual({ available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [] });
  });

  test('a source that is not a web link is dropped, so no page renders it as one', () => {
    const day = {
      ...PAST_DAY,
      reasons: [{ kind: 'event', label: 'Town event', effectPct: null, sources: [{ label: 'Bad', url: 'javascript:alert(1)' }, { label: 'Town', url: 'http://example.org' }], note: null }],
    };
    expect(forecastWindowSchema.parse({ ...WINDOW, days: [day] }).days[0]?.reasons[0]?.sources).toEqual([{ label: 'Town', url: 'http://example.org' }]);
  });
});

test('fetchForecast reads GET .../forecast for the range, the location id escaped', async () => {
  const paths: string[] = [];
  const api: ApiClient = {
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      paths.push(`${opts?.method ?? 'GET'} ${path}`);
      return Promise.resolve(schema.parse(WINDOW));
    },
    request: () => Promise.reject(new Error('not used')),
    stream: () => Promise.reject(new Error('not used')),
    logout: () => Promise.resolve(),
  };
  const window = await fetchForecast(api, 'a b', { from: '2026-05-01', to: '2026-05-31' });
  expect(paths).toEqual(['GET /api/org/locations/a%20b/forecast?from=2026-05-01&to=2026-05-31']);
  expect(window.days).toHaveLength(2);
});
