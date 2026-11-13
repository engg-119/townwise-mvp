import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { TownEvent } from '../../../src/portal/analytics/api';
import type { ForecastDay } from '../../../src/portal/estimates/api';
import type { Note, NoteInput, SalesDay } from '../../../src/portal/locations/api';
import type { Rule } from '../../../src/portal/rules/api';
import { EMAIL, refusal } from '../../helpers/portal';
import { calendarBody } from '../analytics/fakes';
import { noteOf } from '../locations/fakes';

// The Calendar page's five reads (spec 16.3 P27), for fakePortalApi's `fallback`: GET .../notes, .../rules,
// .../calendar, .../sales/days and .../forecast for location l1, answered from mutable fields so a test can change
// what the next read returns (the forecast after a note is saved). Any month's calendar answers with `events`, its
// sales days from `days`, and its forecast from `forecasts` by month ('YYYY-MM'), or no published forecast. DELETE
// (through `request`) answers 204. Writes the portal fake answers itself (POST and PATCH) go in its `answers`.
// Every figure is made up.

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
}

export const NO_FORECAST = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [] };

export function calendarFake(init: Partial<Pick<CalendarFake, 'notes' | 'rules' | 'events' | 'days' | 'forecasts'>> = {}): CalendarFake {
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
      if (route === 'calendar') {
        return answer(calendarBody({ events: fake.events.filter((event) => event.start <= to && event.end >= from) }), schema);
      }
      if (route === 'sales/days') return answer({ days: fake.days.filter((day) => day.date >= from && day.date <= to) }, schema);
      if (route === 'forecast') return answer(fake.forecasts[from.slice(0, 7)] ?? NO_FORECAST, schema);
      return Promise.reject(refusal(404, 'not_found'));
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
