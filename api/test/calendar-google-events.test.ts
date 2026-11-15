// Reading a Google calendar (src/calendar/google-events.ts, openspec change connect-google-calendar: the google-calendar
// spec's "A Google calendar is read with a fixed, minimal request", design decision 7): the mapping by ics.ts's rules,
// the window ahead read first and the window before only with what is left, paging, the cut, an aborted read, and the
// statuses by the client's codes. Tests never call Google; every title, id and token here is made up.
import { describe, expect, it } from 'vitest';

import { MAX_EVENT_PAGES, eventsOfGoogle, readGoogleCalendar } from '../src/calendar/google-events.ts';
import {
  createGoogleCalendarClient, GoogleCalendarError, type GoogleAccess, type GoogleCalendarClient, type GoogleEventItem, type GoogleEventsPage,
  type GoogleEventsQuery, type GoogleFailure,
} from '../src/calendar/google.ts';
import { MAX_EVENTS, type IcsEvent } from '../src/calendar/ics.ts';
import { utcDay } from '../src/dates.ts';

const TODAY = '2026-11-15';
const HANOVER = { today: TODAY, timeZone: 'America/New_York' };
const REFRESH = '1//0test-refresh-token-0000';
const ACCESS = 'ya29.test-access-token-0000';
const CALENDAR = 'bookings.team@group.calendar.example.test';

function plusDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

function allDay(id: string, date: string, endDate = plusDays(date, 1), extra: Partial<GoogleEventItem> = {}): GoogleEventItem {
  return { id, status: 'confirmed', summary: id, start: { date, dateTime: null }, end: { date: endDate, dateTime: null }, ...extra };
}

function timed(id: string, start: string, end: string, summary: string | null = id): GoogleEventItem {
  return { id, status: 'confirmed', summary, start: { date: null, dateTime: start }, end: { date: null, dateTime: end } };
}

interface FakeClient {
  readonly client: GoogleCalendarClient;
  readonly refreshes: string[];
  readonly queries: GoogleEventsQuery[];
}

/**
 * A client whose events come from `pages(query)`: each window's items, by start, paged `pageSize` at a time with the
 * offset as the page token. `refresh` answers the access.
 */
function fakeClient(opts: {
  events?: (query: GoogleEventsQuery) => readonly GoogleEventItem[];
  pageSize?: number;
  refresh?: () => Promise<GoogleAccess>;
  onPage?: (query: GoogleEventsQuery) => void;
  fail?: (query: GoogleEventsQuery) => GoogleCalendarError | null;
}): FakeClient {
  const refreshes: string[] = [];
  const queries: GoogleEventsQuery[] = [];
  const unused = (): Promise<never> => Promise.reject(new Error('not used here'));
  const client: GoogleCalendarClient = {
    exchangeCode: unused,
    listCalendars: unused,
    getCalendar: unused,
    refreshAccess(refreshToken) {
      refreshes.push(refreshToken);
      return opts.refresh?.() ?? Promise.resolve({ accessToken: ACCESS, refreshToken: null });
    },
    listEvents(accessToken, calendarId, query): Promise<GoogleEventsPage> {
      expect([accessToken, calendarId]).toEqual([ACCESS, CALENDAR]);
      queries.push(query);
      opts.onPage?.(query);
      const failure = opts.fail?.(query) ?? null;
      if (failure !== null) return Promise.reject(failure);
      const all = opts.events?.(query) ?? [];
      const size = opts.pageSize ?? 500;
      const offset = Number(query.pageToken ?? '0');
      const next = offset + size;
      return Promise.resolve({ items: all.slice(offset, next), nextPageToken: next < all.length ? String(next) : null });
    },
  };
  return { client, refreshes, queries };
}

function read(fake: FakeClient, signal?: AbortSignal) {
  return readGoogleCalendar(fake.client, { refreshToken: REFRESH, calendarId: CALENDAR, town: HANOVER, signal });
}

async function eventsRead(fake: FakeClient): Promise<IcsEvent[]> {
  const result = await read(fake);
  if (!result.ok) throw new Error(`read failed: ${result.code}`);
  expect(result.parsed.skippedRepeating).toBe(0);
  return [...result.parsed.events];
}

const AHEAD = { timeMin: '2026-11-14T00:00:00Z', timeMax: '2027-12-21T00:00:00Z' };
const BEFORE = { timeMin: '2025-10-10T00:00:00Z', timeMax: '2026-11-15T00:00:00Z' };

/** `perDay` all-day events on each day of a window's days, by start, as Google would answer them. */
function busyDays(prefix: string, perDay: number) {
  return (query: GoogleEventsQuery): GoogleEventItem[] => {
    const items: GoogleEventItem[] = [];
    for (let day = query.timeMin.slice(0, 10); day < query.timeMax.slice(0, 10); day = plusDays(day, 1)) {
      for (let n = 0; n < perDay; n += 1) items.push(allDay(`${prefix}${day}-${String(n)}`, day));
    }
    return items;
  };
}

describe('the events request (the google-calendar spec scenario)', () => {
  it('a Hanover location’s calendar read on 2026-11-15: one token call, then exactly the fixed query ahead first, with no description, location, attendee or organizer asked for', async () => {
    const calls: { url: string; body: string | null }[] = [];
    const answers: unknown[] = [
      { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' },
      // As Google answers: an absent field is left out, never null.
      { items: [{ id: 'evt1', status: 'confirmed', summary: 'evt1', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } }] },
      { items: [] },
    ];
    const client = createGoogleCalendarClient({
      clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret',
      fetch: (url, init) => {
        calls.push({ url, body: typeof init.body === 'string' ? init.body : null });
        return Promise.resolve(Response.json(answers.shift()));
      },
    });
    const result = await readGoogleCalendar(client, { refreshToken: REFRESH, calendarId: CALENDAR, town: HANOVER });
    expect(result).toEqual({
      ok: true, refreshToken: null,
      parsed: { events: [{ uid: 'evt1', title: 'evt1', startDate: '2026-11-20', endDate: '2026-11-20', startTime: null, endTime: null }], skippedRepeating: 0 },
    });
    expect(calls.map((call) => call.url.split('?')[0])).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://www.googleapis.com/calendar/v3/calendars/bookings.team%40group.calendar.example.test/events',
      'https://www.googleapis.com/calendar/v3/calendars/bookings.team%40group.calendar.example.test/events',
    ]);
    expect(new URLSearchParams(calls[0]?.body ?? '').get('refresh_token')).toBe(REFRESH);
    const query = (index: number): [string, string][] => [...new URL(calls[index]?.url ?? '').searchParams.entries()];
    const fixed = (window: { timeMin: string; timeMax: string }): [string, string][] => [
      ['singleEvents', 'true'], ['orderBy', 'startTime'], ['showDeleted', 'false'], ['eventTypes', 'default'],
      ['timeMin', window.timeMin], ['timeMax', window.timeMax], ['timeZone', 'America/New_York'], ['maxResults', '500'],
      ['fields', 'nextPageToken,items(id,status,summary,start,end)'],
    ];
    expect(query(1)).toEqual(fixed({ timeMin: '2026-11-14T00:00:00Z', timeMax: '2027-12-21T00:00:00Z' }));
    // Then the window before, with what is left.
    expect(query(2)).toEqual(fixed({ timeMin: '2025-10-10T00:00:00Z', timeMax: '2026-11-15T00:00:00Z' }));
    for (const call of calls) expect(call.url).not.toMatch(/description|location|attendee|organizer/i);
  });
});

describe('mapping, by ics.ts’s rules', () => {
  it('an all-day event’s end date is exclusive (the google-calendar spec scenario), and one with no end is one day', () => {
    expect(eventsOfGoogle([
      allDay('weekend', '2026-12-04', '2026-12-06'),
      allDay('one', '2026-12-10'),
      { id: 'no-end', status: 'confirmed', summary: 'No end', start: { date: '2026-12-12', dateTime: null }, end: null },
    ], HANOVER)).toEqual([
      { uid: 'weekend', title: 'weekend', startDate: '2026-12-04', endDate: '2026-12-05', startTime: null, endTime: null },
      { uid: 'one', title: 'one', startDate: '2026-12-10', endDate: '2026-12-10', startTime: null, endTime: null },
      { uid: 'no-end', title: 'No end', startDate: '2026-12-12', endDate: '2026-12-12', startTime: null, endTime: null },
    ]);
  });

  it('a timed event is the town’s wall time, across a daylight saving change and in another zone', () => {
    const items = [
      // 01:30 EST to 03:30 EDT: an hour long, as Eastern clocks skip 02:00 to 03:00 on 2026-03-08.
      timed('dst', '2026-03-08T01:30:00-05:00', '2026-03-08T03:30:00-04:00'),
      // A UTC instant: 23:30Z to 01:00Z is 18:30 to 20:00 Eastern.
      timed('utc', '2026-12-03T23:30:00Z', '2026-12-04T01:00:00Z'),
      // Before and after the November change: 18:00 in the town both times.
      timed('october', '2026-10-30T18:00:00-04:00', '2026-10-30T20:00:00-04:00'),
      timed('november', '2026-11-06T18:00:00-05:00', '2026-11-06T20:00:00-05:00'),
    ];
    expect(eventsOfGoogle(items, HANOVER).map((event) => [event.uid, event.startDate, event.startTime, event.endTime])).toEqual([
      ['dst', '2026-03-08', '01:30', '03:30'],
      ['october', '2026-10-30', '18:00', '20:00'],
      ['november', '2026-11-06', '18:00', '20:00'],
      ['utc', '2026-12-03', '18:30', '20:00'],
    ]);
    expect(eventsOfGoogle(items, { today: TODAY, timeZone: 'America/Los_Angeles' }).find((event) => event.uid === 'utc'))
      .toMatchObject({ startDate: '2026-12-03', startTime: '15:30', endTime: '17:00' });
  });

  it('keeps hours for a late night that ends by 06:00, and none for an event that runs past it or past midnight to the day after', () => {
    expect(eventsOfGoogle([
      timed('late', '2026-12-12T22:00:00-05:00', '2026-12-13T02:00:00-05:00'),
      timed('six', '2026-12-29T19:00:00-05:00', '2026-12-30T06:00:00-05:00'),
      timed('seven', '2026-12-30T20:00:00-05:00', '2026-12-31T07:00:00-05:00'),
      timed('midnight', '2026-12-18T19:00:00-05:00', '2026-12-19T00:00:00-05:00'),
    ], HANOVER).map((event) => [event.uid, event.startDate, event.endDate, event.startTime, event.endTime])).toEqual([
      ['late', '2026-12-12', '2026-12-12', '22:00', '02:00'],
      ['midnight', '2026-12-18', '2026-12-18', null, null],
      ['six', '2026-12-29', '2026-12-29', '19:00', '06:00'],
      ['seven', '2026-12-30', '2026-12-31', null, null],
    ]);
  });

  it('skips canceled and unreadable events, names an untitled one, cuts a title at 200 characters and keeps a backslash as written', () => {
    const events = eventsOfGoogle([
      allDay('cancelled', '2026-12-01', undefined, { status: 'cancelled' }),
      allDay('untitled', '2026-12-02', undefined, { summary: null }),
      allDay('blank', '2026-12-03', undefined, { summary: '   ' }),
      allDay('long', '2026-12-04', undefined, { summary: `${'A'.repeat(199)}\u{1F600}tail` }),
      allDay('escaped', '2026-12-05', undefined, { summary: 'Wine\\, cheese \\n more' }),
      allDay('spaced', '2026-12-06', undefined, { summary: 'Rehearsal\n  dinner' }),
      { id: 'no-start', status: 'confirmed', summary: 'No start', start: null, end: null },
      { id: 'bad-date', status: 'confirmed', summary: 'Bad', start: { date: '2026-02-30', dateTime: null }, end: null },
      timed('bad-time', 'not a time', '2026-12-07T10:00:00Z'),
    ], HANOVER);
    expect(events.map((event) => [event.uid, event.title])).toEqual([
      ['untitled', 'Untitled event'], ['blank', 'Untitled event'], ['long', 'A'.repeat(199)], ['escaped', 'Wine\\, cheese \\n more'],
      ['spaced', 'Rehearsal dinner'],
    ]);
  });

  it('keeps each instance of a repeating event with its own UID (the weekly event scenario)', async () => {
    const weekly = ['2026-11-20', '2026-11-27', '2026-12-04'].map((day) =>
      timed(`weekly_${day.replace(/-/g, '')}T230000Z`, `${day}T18:00:00-05:00`, `${day}T19:00:00-05:00`, 'Trivia night'));
    const fake = fakeClient({ events: (query) => (query.timeMin === AHEAD.timeMin ? weekly : []) });
    const events = await eventsRead(fake);
    expect(events.map((event) => [event.uid, event.title, event.startDate])).toEqual([
      ['weekly_20261120T230000Z', 'Trivia night', '2026-11-20'],
      ['weekly_20261127T230000Z', 'Trivia night', '2026-11-27'],
      ['weekly_20261204T230000Z', 'Trivia night', '2026-12-04'],
    ]);
  });

  it('one single event and a weekly event with 52 instances store 53 events and no repeating event skipped (the owner-calendar spec scenario)', async () => {
    const instances = Array.from({ length: 52 }, (_, week) => allDay(`standing_${String(week)}`, plusDays(TODAY, week * 7 - 180)));
    const fake = fakeClient({ events: (query) => [...instances, allDay('single', '2026-12-24')].filter((item) => (item.start?.date ?? '') < query.timeMax.slice(0, 10) && (item.end?.date ?? '') > query.timeMin.slice(0, 10)) });
    expect(await eventsRead(fake)).toHaveLength(53);
  });

  it('keeps only events within 400 days of the town’s today', () => {
    expect(eventsOfGoogle([
      allDay('too-early', plusDays(TODAY, -402), plusDays(TODAY, -400)),
      allDay('first-day', plusDays(TODAY, -401), plusDays(TODAY, -399)),
      allDay('last-day', plusDays(TODAY, 400)),
      allDay('too-late', plusDays(TODAY, 401)),
    ], HANOVER).map((event) => event.uid)).toEqual(['first-day', 'last-day']);
  });
});

describe('the read: ahead first, then before with what is left', () => {
  it('reads ahead, then before, following pages, and counts an event in both windows once', async () => {
    const spanning = allDay('spanning', plusDays(TODAY, -3), plusDays(TODAY, 2));
    const fake = fakeClient({
      pageSize: 2,
      events: (query) => (query.timeMin === AHEAD.timeMin
        ? [spanning, allDay('a1', plusDays(TODAY, 1)), allDay('a2', plusDays(TODAY, 2)), allDay('a3', plusDays(TODAY, 3))]
        : [allDay('b1', plusDays(TODAY, -30)), spanning, allDay('b2', plusDays(TODAY, -1))]),
    });
    const events = await eventsRead(fake);
    expect(fake.refreshes).toEqual([REFRESH]);
    expect(fake.queries).toEqual([
      { ...AHEAD, timeZone: 'America/New_York', pageToken: null },
      { ...AHEAD, timeZone: 'America/New_York', pageToken: '2' },
      { ...BEFORE, timeZone: 'America/New_York', pageToken: null },
      { ...BEFORE, timeZone: 'America/New_York', pageToken: '2' },
    ]);
    expect(events.map((event) => event.uid)).toEqual(['b1', 'spanning', 'b2', 'a1', 'a2', 'a3']);
  });

  it('a busy calendar keeps what is ahead: 2,000 stored, none ending more than 2 days before today, and no page before requested (the google-calendar spec scenario)', async () => {
    const fake = fakeClient({ events: busyDays('busy-', 20) });
    const events = await eventsRead(fake);
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events.every((event) => event.endDate >= plusDays(TODAY, -2))).toBe(true);
    expect(fake.queries.every((query) => query.timeMin === AHEAD.timeMin)).toBe(true);
    expect(fake.queries).toHaveLength(4);
  });

  it('reads the window before only with room left, and the cut keeps the next events ahead of the earlier ones', async () => {
    // 1,990 ahead; the before read brings 500 more, of which the 10 latest fit.
    const ahead = Array.from({ length: 1_990 }, (_, index) => allDay(`ahead-${String(index)}`, plusDays(TODAY, Math.floor(index / 5))));
    const before = Array.from({ length: 500 }, (_, index) => allDay(`before-${String(index)}`, plusDays(TODAY, index - 500)));
    const fake = fakeClient({ events: (query) => (query.timeMin === AHEAD.timeMin ? ahead : before) });
    const events = await eventsRead(fake);
    expect(fake.queries.map((query) => [query.timeMin, query.pageToken])).toEqual([
      [AHEAD.timeMin, null], [AHEAD.timeMin, '500'], [AHEAD.timeMin, '1000'], [AHEAD.timeMin, '1500'], [BEFORE.timeMin, null],
    ]);
    expect(events).toHaveLength(MAX_EVENTS);
    const uids = new Set(events.map((event) => event.uid));
    for (const item of ahead) expect(uids.has(item.id)).toBe(true);
    expect(events.filter((event) => event.uid.startsWith('before-')).map((event) => event.uid))
      .toEqual(Array.from({ length: 10 }, (_, index) => `before-${String(490 + index)}`));
  });

  it('stops at 8 pages in all, whatever Google still offers', async () => {
    const fake = fakeClient({ pageSize: 10, events: busyDays('day-', 1) });
    const events = await eventsRead(fake);
    expect(MAX_EVENT_PAGES).toBe(8);
    expect(fake.queries).toHaveLength(8);
    expect(fake.queries.every((query) => query.timeMin === AHEAD.timeMin)).toBe(true);
    expect(events).toHaveLength(80);
  });

  it('answers a new refresh token Google sent with the access', async () => {
    const fake = fakeClient({ refresh: () => Promise.resolve({ accessToken: ACCESS, refreshToken: '1//0test-new-refresh-token' }) });
    expect(await read(fake)).toMatchObject({ ok: true, refreshToken: '1//0test-new-refresh-token' });
  });
});

describe('stopping', () => {
  it('an aborted signal stops the read before the next page, and nothing is answered to write', async () => {
    const controller = new AbortController();
    const fake = fakeClient({ pageSize: 1, events: busyDays('day-', 1), onPage: () => { controller.abort(); } });
    expect(await read(fake, controller.signal)).toEqual({ ok: false, code: 'stopped' });
    expect(fake.queries).toHaveLength(1);
  });

  it('a call aborted in flight is stopped, not a failure', async () => {
    const controller = new AbortController();
    const fake = fakeClient({
      fail: () => {
        controller.abort();
        return new GoogleCalendarError('unavailable');
      },
    });
    expect(await read(fake, controller.signal)).toEqual({ ok: false, code: 'stopped' });
    const refreshing = fakeClient({
      refresh: () => {
        controller.abort();
        return Promise.reject(new GoogleCalendarError('unavailable'));
      },
    });
    expect(await read(refreshing, controller.signal)).toEqual({ ok: false, code: 'stopped' });
  });

  it('a signal aborted before the read calls nothing', async () => {
    const fake = fakeClient({});
    expect(await read(fake, AbortSignal.abort())).toEqual({ ok: false, code: 'stopped' });
    expect(fake.refreshes).toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  it('a signal aborted as the last page arrives is still stopped', async () => {
    const controller = new AbortController();
    const fake = fakeClient({ events: () => [], onPage: (query) => { if (query.timeMin === BEFORE.timeMin) controller.abort(); } });
    expect(await read(fake, controller.signal)).toEqual({ ok: false, code: 'stopped' });
  });
});

describe('failures', () => {
  const statuses: [GoogleFailure, string][] = [
    ['invalid_grant', 'google_revoked'], ['unauthorized', 'google_revoked'], ['rate_limited', 'google_rate_limited'],
    ['api_disabled', 'google_unavailable'], ['forbidden', 'google_forbidden'], ['not_found', 'google_not_found'],
    ['invalid_client', 'google_unavailable'], ['unavailable', 'google_unavailable'], ['bad_response', 'google_unavailable'],
  ];

  it.each(statuses)('a token refresh failing %s records %s, with the client’s error, and reads no events', async (code, status) => {
    const error = new GoogleCalendarError(code, 400);
    const fake = fakeClient({ refresh: () => Promise.reject(error) });
    expect(await read(fake)).toEqual({ ok: false, code: status, op: 'token', error });
    expect(fake.queries).toEqual([]);
  });

  it.each(statuses)('an events page failing %s records %s, with the client’s error', async (code, status) => {
    const error = new GoogleCalendarError(code, 403);
    const fake = fakeClient({ fail: (query) => (query.pageToken === null && query.timeMin === BEFORE.timeMin ? error : null) });
    expect(await read(fake)).toEqual({ ok: false, code: status, op: 'events', error });
  });

  it('lets an error that is not the client’s through', async () => {
    const fake = fakeClient({ refresh: () => Promise.reject(new RangeError('a bug')) });
    await expect(read(fake)).rejects.toThrow(RangeError);
  });
});
