import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { TownEvent } from '../../../src/portal/analytics/api';
import type { ForecastDay } from '../../../src/portal/estimates/api';
import type { Note, NoteInput, SalesDay } from '../../../src/portal/locations/api';
import { addDays } from '../../../src/portal/locations/dates';
import type { Rule } from '../../../src/portal/rules/api';
import { EMAIL, refusal } from '../../helpers/portal';
import { calendarBody } from '../analytics/fakes';
import { noteOf } from '../locations/fakes';

// The Calendar page's five reads (spec 16.3 P28), for fakePortalApi's `fallback`: GET .../notes, .../rules,
// .../calendar, .../sales/days and .../forecast for location l1, answered from mutable fields so a test can change
// what the next read returns (the forecast after a note is saved). Any range's calendar answers with `events`, its
// sales days from `days`, and its forecast from `forecasts` by month ('YYYY-MM'): a grid's read spans the days of the
// months either side, so the grid's month (the month of the range's 7th day: a grid has at most 6 leading days, and a
// clamped range starts on the 1st) decides an ApiError or no published forecast, and the days come from every month's
// window within the range. `hold` keeps a route's read from one `from` waiting until the test releases it, so a test
// can see a grid whose reads are in flight. DELETE (through `request`) answers 204. Writes the portal fake answers
// itself (POST and PATCH) go in its `answers`. Every figure is made up.

export const PATH = '/api/org/locations/l1';
export const NOTES_PATH = `${PATH}/notes`;
export const RULES_PATH = `${PATH}/rules`;

export interface CalendarFake extends ApiClient {
  notes: Note[] | ApiError;
  /** The location's business rules (D31); none unless a test sets them. */
  rules: Rule[];
  events: TownEvent[];
  days: SalesDay[];
  /** By month; an ApiError rejects that month's read. A month missing here has no published forecast. */
  forecasts: Record<string, unknown>;
  /** Every GET path, in order. */
  paths: string[];
  /** Holds every read of `route` from `from` until the returned function runs; the reads then answer as usual. */
  hold: (route: HeldRoute, from: string) => () => void;
}

export type HeldRoute = 'calendar' | 'sales/days' | 'forecast';

interface WindowBody { available?: boolean; days?: { date: string }[] }

export const NO_FORECAST = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [] };

export function calendarFake(init: Partial<Pick<CalendarFake, 'notes' | 'rules' | 'events' | 'days' | 'forecasts'>> = {}): CalendarFake {
  const holds = new Map<string, Promise<void>>();
  const answer = <T>(value: unknown, schema: z.ZodType<T>): Promise<T> =>
    (value instanceof ApiError ? Promise.reject(value) : Promise.resolve(schema.parse(value)));
  const fake: CalendarFake = {
    notes: init.notes ?? [],
    rules: init.rules ?? [],
    events: init.events ?? [],
    days: init.days ?? [],
    forecasts: init.forecasts ?? {},
    paths: [],
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      if ((opts?.method ?? 'GET') !== 'GET') return Promise.reject(refusal(404, 'not_found'));
      fake.paths.push(path);
      if (path === NOTES_PATH) return answer(fake.notes instanceof ApiError ? fake.notes : { notes: fake.notes }, schema);
      if (path === RULES_PATH) return answer({ rules: fake.rules, limit: 30 }, schema);
      const range = /^\/api\/org\/locations\/l1\/(calendar|sales\/days|forecast)\?from=([\d-]+)&to=([\d-]+)$/.exec(path);
      const [, route, from = '', to = ''] = range ?? [];
      const respond = (): Promise<T> => {
        if (route === 'calendar') {
          return answer(calendarBody({ events: fake.events.filter((event) => event.start <= to && event.end >= from) }), schema);
        }
        if (route === 'sales/days') return answer({ days: fake.days.filter((day) => day.date >= from && day.date <= to) }, schema);
        if (route === 'forecast') return answer(forecastFor(fake.forecasts, from, to), schema);
        return Promise.reject(refusal(404, 'not_found'));
      };
      const held = holds.get(`${route ?? ''} ${from}`);
      return held === undefined ? respond() : held.then(respond);
    },
    hold(route, from) {
      let release = (): void => undefined;
      holds.set(`${route} ${from}`, new Promise<void>((resolve) => { release = resolve; }));
      return () => { holds.delete(`${route} ${from}`); release(); };
    },
    request(_path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      if (opts?.method !== 'DELETE') return Promise.reject(refusal(404, 'not_found'));
      return Promise.resolve({ ok: true, status: 204 } as Response);
    },
    stream: () => Promise.reject(refusal(404, 'not_found')),
    logout: () => Promise.resolve(),
  };
  return fake;
}

/**
 * The forecast read for `from` to `to`: the grid month's entry decides an ApiError or no published forecast; an
 * available window answers with every month's days within the range.
 */
function forecastFor(forecasts: Record<string, unknown>, from: string, to: string): unknown {
  const own = forecasts[addDays(from, 6).slice(0, 7)];
  if (own === undefined) return NO_FORECAST;
  if (own instanceof ApiError || (own as WindowBody).available !== true) return own;
  const days = Object.values(forecasts)
    .flatMap((each) => (each instanceof ApiError || (each as WindowBody).available !== true ? [] : (each as WindowBody).days ?? []))
    .filter((day) => day.date >= from && day.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { ...(own as object), days };
}

/** A published forecast day as GET .../forecast sends it: open, 180 to 240 around 212, with a weekday reason. */
export function forecastDay(fields: Partial<ForecastDay> & Pick<ForecastDay, 'date'>): ForecastDay {
  const low = fields.low ?? 180;
  const mid = fields.mid ?? 212;
  const high = fields.high ?? 240;
  return {
    status: 'open', low, mid, high, model: { status: 'open', low, mid, high }, noteGuests: 0, moreNotes: 0,
    reasons: [{ kind: 'weekday', label: 'Weekday', effectPct: null, sources: [], note: null }], runId: 'r1', actual: null, inRange: null,
    ...fields,
  };
}

/** The window for `days`. */
export function forecastOf(days: ForecastDay[]): unknown {
  return { available: true, reason: null, runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, madeAt: '2026-11-01', live: null }], days, weeks: [] };
}

/** A note the API saved from this body. */
export function savedNote(id: string, body: unknown): { note: Note } {
  return { note: noteOf(id, { ...(body as NoteInput), createdByEmail: EMAIL, createdAt: '2026-11-11T15:00:00.000Z' }) };
}
