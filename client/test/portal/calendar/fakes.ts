import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { TownEvent } from '../../../src/portal/analytics/api';
import type { OwnerCalendar, OwnerCalendarEvent } from '../../../src/portal/calendar/api';
import type { ForecastDay } from '../../../src/portal/estimates/api';
import type { NewNoteInput, Note, SalesDay } from '../../../src/portal/locations/api';
import { addDays } from '../../../src/portal/locations/dates';
import type { Rule } from '../../../src/portal/rules/api';
import { EMAIL, refusal } from '../../helpers/portal';
import { calendarBody } from '../analytics/fakes';
import { noteOf } from '../locations/fakes';

// The Calendar page's reads (spec 16.3 P28), for fakePortalApi's `fallback`: GET .../notes, .../rules,
// .../calendar, .../sales/days and .../forecast for location l1, and the owner calendars' two (spec 10.18): the list,
// GET .../owner-calendars, from `calendars`, and the stored events, GET .../owner-calendars/events, from `ownerEvents`
// (either may be an ApiError instead). They answer from mutable fields so a test can change what the next read returns
// (the forecast after a note is saved). Any range's calendar answers with `events`, its stored events with the
// `ownerEvents` that overlap it, its sales days from `days`, and its forecast from `forecasts` by month ('YYYY-MM'): a
// grid's read spans the days of the months either side, so the grid's month (the month of the range's 7th day: a grid
// has at most 6 leading days, a clamped range starts on the 1st, and a week's own range ends on it) decides an
// ApiError or no published forecast, and the days come from every month's window within the range. `setToday` moves
// the page's today, for a test that runs with only Date faked. `hold` keeps a route's read from one `from` waiting until
// the test releases it, so a test can see a grid whose reads are in flight. DELETE (through `request`) answers 204, or
// the ApiError a test sets in `deletes` for its path. Writes the portal fake answers itself (POST and PATCH) go in its
// `answers`. Town research (D66): the calendar's `found` answers the `found` events that overlap the range (or the
// literal `null`, a failed read), and GET .../research answers `research` (a 404 unless a test sets it). Every figure,
// name and title is made up.

export const PATH = '/api/org/locations/l1';
export const NOTES_PATH = `${PATH}/notes`;
export const RULES_PATH = `${PATH}/rules`;
export const CALENDARS_PATH = `${PATH}/owner-calendars`;
export const RESEARCH_PATH = `${PATH}/research`;

export interface CalendarFake extends ApiClient {
  notes: Note[] | ApiError;
  /** The location's business rules (D31); none unless a test sets them. */
  rules: Rule[];
  events: TownEvent[];
  days: SalesDay[];
  /** By month; an ApiError rejects that month's read. A month missing here has no published forecast. */
  forecasts: Record<string, unknown>;
  /** The location's owner calendars, oldest first; an ApiError rejects the list's read. */
  calendars: OwnerCalendar[] | ApiError;
  /** Their stored events, by start; an ApiError rejects every stored-events read. */
  ownerEvents: OwnerCalendarEvent[] | ApiError;
  /** The calendar read's `found`: events town research found, by start; null answers `found: null` (a failed read). */
  found: Record<string, unknown>[] | null;
  /** GET .../research's answer, or the ApiError it throws. */
  research: unknown;
  /** What a DELETE of a path answers instead of 204. */
  deletes: Record<string, ApiError>;
  /** Every GET path, in order. */
  paths: string[];
  /** Holds every read of `route` from `from` until the returned function runs; the reads then answer as usual. */
  hold: (route: HeldRoute, from: string) => () => void;
}

export type HeldRoute = 'calendar' | 'sales/days' | 'forecast' | 'owner-calendars/events';

interface WindowBody { available?: boolean; days?: { date: string }[] }

export const NO_FORECAST = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [] };

export function calendarFake(
  init: Partial<Pick<CalendarFake, 'notes' | 'rules' | 'events' | 'days' | 'forecasts' | 'calendars' | 'ownerEvents' | 'found' | 'research'>> = {},
): CalendarFake {
  const holds = new Map<string, Promise<void>>();
  const answer = <T>(value: unknown, schema: z.ZodType<T>): Promise<T> =>
    (value instanceof ApiError ? Promise.reject(value) : Promise.resolve(schema.parse(value)));
  const fake: CalendarFake = {
    notes: init.notes ?? [],
    rules: init.rules ?? [],
    events: init.events ?? [],
    days: init.days ?? [],
    forecasts: init.forecasts ?? {},
    calendars: init.calendars ?? [],
    ownerEvents: init.ownerEvents ?? [],
    found: init.found ?? [],
    research: init.research ?? refusal(404, 'not_found'),
    deletes: {},
    paths: [],
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      if ((opts?.method ?? 'GET') !== 'GET') return Promise.reject(refusal(404, 'not_found'));
      fake.paths.push(path);
      if (path === NOTES_PATH) return answer(fake.notes instanceof ApiError ? fake.notes : { notes: fake.notes }, schema);
      if (path === RULES_PATH) return answer({ rules: fake.rules, limit: 30 }, schema);
      if (path === CALENDARS_PATH) return answer(fake.calendars instanceof ApiError ? fake.calendars : { calendars: fake.calendars }, schema);
      if (path === RESEARCH_PATH) return answer(fake.research, schema);
      const range = /^\/api\/org\/locations\/l1\/(calendar|sales\/days|forecast|owner-calendars\/events)\?from=([\d-]+)&to=([\d-]+)$/.exec(path);
      const [, route, from = '', to = ''] = range ?? [];
      const respond = (): Promise<T> => {
        if (route === 'calendar') {
          const found = fake.found === null ? null : fake.found.filter((event) => String(event.start) <= to && String(event.end) >= from);
          return answer({ ...calendarBody({ events: fake.events.filter((event) => event.start <= to && event.end >= from) }), found }, schema);
        }
        if (route === 'sales/days') return answer({ days: fake.days.filter((day) => day.date >= from && day.date <= to) }, schema);
        if (route === 'forecast') return answer(forecastFor(fake.forecasts, from, to), schema);
        if (route === 'owner-calendars/events') {
          const stored = fake.ownerEvents;
          return answer(stored instanceof ApiError ? stored : { events: stored.filter((event) => event.startDate <= to && event.endDate >= from) }, schema);
        }
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
    request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      if (opts?.method !== 'DELETE') return Promise.reject(refusal(404, 'not_found'));
      const refused = fake.deletes[path];
      return refused === undefined ? Promise.resolve({ ok: true, status: 204 } as Response) : Promise.reject(refused);
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

/**
 * Makes `date` ('YYYY-MM-DD') the device's today, at noon, before the page renders: the page reads its today once
 * (locations/dates.ts localToday). Needs jest's fake Date (useFakeTimers).
 */
export function setToday(date: string): void {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  jest.setSystemTime(new Date(year, month - 1, day, 12, 0, 0));
}

/** A published forecast day as GET .../forecast sends it: open, 180 to 240 around 212, with a weekday reason. */
export function forecastDay(fields: Partial<ForecastDay> & Pick<ForecastDay, 'date'>): ForecastDay {
  const low = fields.low ?? 180;
  const mid = fields.mid ?? 212;
  const high = fields.high ?? 240;
  return {
    status: 'open', low, mid, high, model: { status: 'open', low, mid, high }, noteGuests: 0, moreNotes: 0,
    reasons: [{ kind: 'weekday', label: 'Weekday', effectPct: null, sources: [], note: null }], runId: 'r1', actual: null, inRange: null, outlook: false,
    ...fields,
  };
}

/** The window for `days`. */
export function forecastOf(days: ForecastDay[]): unknown {
  return { available: true, reason: null, runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, madeAt: '2026-11-01', live: null }], days, weeks: [] };
}

/** An owner calendar as GET .../owner-calendars sends it: a file named Kitchen with no events, refreshed fine. */
export function ownerCalendar(fields: Partial<OwnerCalendar> = {}): OwnerCalendar {
  return {
    id: 'c1', label: 'Kitchen', kind: 'file', host: null, eventCount: 0, skippedRepeating: 0, status: 'ok',
    lastSuccessAt: '2026-11-11T15:00:00.000Z', lastAttemptAt: '2026-11-11T15:00:00.000Z', createdAt: '2026-11-01T15:00:00.000Z',
    mine: false, format: null, bookings: null, fromFile: null, ...fields,
  };
}

/** A stored event as GET .../owner-calendars/events sends it: one all-day day in Kitchen, ending the day it starts. */
export function ownerEvent(fields: Partial<OwnerCalendarEvent> = {}): OwnerCalendarEvent {
  const startDate = fields.startDate ?? '2026-11-21';
  return {
    calendarId: 'c1', calendar: 'Kitchen', uid: 'e1', title: 'Wine delivery', startDate, endDate: startDate, startTime: null, endTime: null,
    booking: null, bookingBy: null, ...fields,
  };
}

/**
 * A note the API saved from this body. A body's `fromEvent` ({ calendarId, uid }, Make a note) comes back as the link
 * the API stores, with the note's dates standing in for the event's.
 */
export function savedNote(id: string, body: unknown): { note: Note } {
  const { fromEvent, ...input } = body as NewNoteInput;
  const link = fromEvent === undefined ? null : {
    ...fromEvent, startDate: input.startDate, endDate: input.endDate, startTime: input.startTime ?? null, endTime: input.endTime ?? null,
    linkedAt: '2026-11-11T15:00:00.000Z',
  };
  return { note: noteOf(id, { ...input, createdByEmail: EMAIL, createdAt: '2026-11-11T15:00:00.000Z', fromEvent: link }) };
}

/**
 * An event town research found, as the calendar read's `found` sends it (D66): a medium-confidence trivia night at a
 * made-up tavern on Sat, Nov 21, from research's own values (head 'base'), with one https source.
 */
export function foundEvent(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `l-${'a'.repeat(24)}`, head: 'base', title: 'Trivia night', start: '2026-11-21', end: '2026-11-21', weekdays: null, startTime: '19:00',
    kind: 'event', category: 'dining', status: 'scheduled', origin: 'competitor', confidence: 'medium', where: 'Example Tavern', who: 'Example Quiz Club',
    competitor: { entityId: 'e1', placeId: null }, sources: [{ label: 'example.com', url: 'https://example.com/trivia' }],
    lastSeenAt: '2026-11-10T12:00:00.000Z', edited: false, hidden: false, ...fields,
  };
}

/** GET .../research with the location's last run started by `trigger` and in `status`, and no town run. */
export function researchBody(trigger: 'weekly' | 'early' | 'press', status: string, added = 0): unknown {
  return {
    on: true, available: true, town: null,
    location: {
      status, finishedAt: status === 'running' ? null : '2026-11-11T14:00:00.000Z', threads: [], counts: { found: added, added, updated: 0, dropped: 0 },
      trigger, startedAt: '2026-11-11T13:00:00.000Z',
    },
    next: null, gaps: [], entities: [], hidden: [],
  };
}
