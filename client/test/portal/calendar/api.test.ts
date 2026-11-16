import {
  addOwnerCalendar, fetchOwnerCalendarEvents, fetchOwnerCalendars, refreshOwnerCalendar, removeOwnerCalendar,
} from '../../../src/portal/calendar/api';
import { ACCESS, fakePortalApi, meOf, refusal, writes } from '../../helpers/portal';
import { noContent, withRoutes } from '../team/fixtures';
import { calendarFake, ownerCalendar, ownerEvent } from './fakes';

// The owner calendar routes (spec 10.18, api/src/handlers/owner-calendars.ts; connect-owner-calendar design decision
// 11) through a recording fake ApiClient. Made-up names, titles and addresses only.

const BASE = '/api/org/locations/l1/owner-calendars';

function api() {
  const fake = fakePortalApi({ me: meOf(ACCESS.member) });
  const routes = withRoutes(fake);
  return { fake, routes };
}

const FILE = ownerCalendar({ id: 'c1', label: 'Kitchen', kind: 'file', host: null, eventCount: 12 });
const LINK = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1 });

describe('owner calendar calls (spec 10.18)', () => {
  test('GET .../owner-calendars returns the calendars, a status the client has no words for included, stripping other keys', async () => {
    const { fake, routes } = api();
    const later = { ...LINK, id: 'c3', status: 'gone_quiet' };
    routes.gets[BASE] = () => ({ calendars: [{ ...FILE, slot: 0 }, LINK, later] });
    expect(await fetchOwnerCalendars(fake, 'l1')).toEqual([FILE, LINK, later]);
    expect(fake.calls).toEqual([{ method: 'GET', path: BASE, body: undefined }]);
  });

  test('a calendar the client can’t read is an invalid response', async () => {
    const { fake, routes } = api();
    routes.gets[BASE] = () => ({ calendars: [{ ...FILE, kind: 'folder' }] });
    await expect(fetchOwnerCalendars(fake, 'l1')).rejects.toThrow();
  });

  test('GET .../owner-calendars/events?from=&to= returns the events', async () => {
    const { fake, routes } = api();
    const timed = ownerEvent({ calendarId: 'c1', calendar: 'Kitchen', uid: 'e1', title: 'Wine delivery', startDate: '2026-11-21', startTime: '18:00', endTime: '21:00' });
    const allDay = ownerEvent({ calendarId: 'c2', calendar: 'Bookings', uid: 'e1', title: 'Linen pickup', startDate: '2026-11-24', endDate: '2026-11-25' });
    routes.gets[`${BASE}/events?from=2026-10-26&to=2026-12-06`] = () => ({ events: [{ ...timed, generation: 3 }, allDay] });
    expect(await fetchOwnerCalendarEvents(fake, 'l1', { from: '2026-10-26', to: '2026-12-06' })).toEqual([timed, allDay]);
    expect(fake.calls).toEqual([{ method: 'GET', path: `${BASE}/events?from=2026-10-26&to=2026-12-06`, body: undefined }]);
  });

  test('POST .../owner-calendars sends a file or a link and returns the calendar; refusals pass through', async () => {
    const { fake } = api();
    fake.answers[BASE] = (body) => ({ calendar: (body as { kind: string }).kind === 'file' ? FILE : LINK });
    const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    const url = 'https://calendar.google.com/calendar/ical/example/basic.ics';
    expect(await addOwnerCalendar(fake, 'l1', { kind: 'file', label: 'Kitchen', ics })).toEqual(FILE);
    expect(await addOwnerCalendar(fake, 'l1', { kind: 'link', label: 'Bookings', url })).toEqual(LINK);
    fake.answers[BASE] = () => refusal(400, 'not_calendar');
    await expect(addOwnerCalendar(fake, 'l1', { kind: 'file', label: 'Notes', ics: 'date,guests' })).rejects.toMatchObject({ status: 400, code: 'not_calendar' });
    expect(writes(fake)).toEqual([
      { method: 'POST', path: BASE, body: { kind: 'file', label: 'Kitchen', ics } },
      { method: 'POST', path: BASE, body: { kind: 'link', label: 'Bookings', url } },
      { method: 'POST', path: BASE, body: { kind: 'file', label: 'Notes', ics: 'date,guests' } },
    ]);
  });

  test('POST .../owner-calendars/:calendarId/refresh sends no body and returns the calendar', async () => {
    const { fake } = api();
    fake.answers[`${BASE}/c2/refresh`] = () => ({ calendar: { ...LINK, status: 'timeout' } });
    expect(await refreshOwnerCalendar(fake, 'l1', 'c2')).toEqual({ ...LINK, status: 'timeout' });
    fake.answers[`${BASE}/c2/refresh`] = () => refusal(429, 'rate_limited', 240);
    await expect(refreshOwnerCalendar(fake, 'l1', 'c2')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 240 });
    expect(writes(fake)).toEqual([
      { method: 'POST', path: `${BASE}/c2/refresh`, body: undefined },
      { method: 'POST', path: `${BASE}/c2/refresh`, body: undefined },
    ]);
  });

  test('DELETE .../owner-calendars/:calendarId goes through request, resolving on 204 and passing refusals through', async () => {
    const { fake, routes } = api();
    routes.requests[`DELETE ${BASE}/c1`] = noContent;
    await expect(removeOwnerCalendar(fake, 'l1', 'c1')).resolves.toBeUndefined();
    routes.requests[`DELETE ${BASE}/c9`] = () => refusal(404, 'not_found');
    await expect(removeOwnerCalendar(fake, 'l1', 'c9')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(writes(fake)).toEqual([
      { method: 'DELETE', path: `${BASE}/c1`, body: undefined },
      { method: 'DELETE', path: `${BASE}/c9`, body: undefined },
    ]);
  });

  test('the location and calendar ids are encoded', async () => {
    const { fake, routes } = api();
    const base = '/api/org/locations/a%2Fb/owner-calendars';
    routes.gets[base] = () => ({ calendars: [] });
    routes.gets[`${base}/events?from=2026-11-01&to=2026-11-30`] = () => ({ events: [] });
    routes.requests[`DELETE ${base}/c%3F1`] = noContent;
    fake.answers[base] = () => ({ calendar: FILE });
    fake.answers[`${base}/c%3F1/refresh`] = () => ({ calendar: LINK });
    await fetchOwnerCalendars(fake, 'a/b');
    await fetchOwnerCalendarEvents(fake, 'a/b', { from: '2026-11-01', to: '2026-11-30' });
    await addOwnerCalendar(fake, 'a/b', { kind: 'file', label: 'Kitchen', ics: '' });
    await refreshOwnerCalendar(fake, 'a/b', 'c?1');
    await removeOwnerCalendar(fake, 'a/b', 'c?1');
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${base}`,
      `GET ${base}/events?from=2026-11-01&to=2026-11-30`,
      `POST ${base}`,
      `POST ${base}/c%3F1/refresh`,
      `DELETE ${base}/c%3F1`,
    ]);
  });
});

describe('the Calendar page fake’s owner calendar routes', () => {
  test('the list answers `calendars`, or rejects with its ApiError', async () => {
    const fake = calendarFake({ calendars: [FILE, LINK] });
    expect(await fetchOwnerCalendars(fake, 'l1')).toEqual([FILE, LINK]);
    fake.calendars = refusal(503, null);
    await expect(fetchOwnerCalendars(fake, 'l1')).rejects.toMatchObject({ status: 503 });
    expect(await fetchOwnerCalendars(calendarFake(), 'l1')).toEqual([]);
    expect(fake.paths).toEqual([BASE, BASE]);
  });

  test('the events read answers the events overlapping its range, and can be held', async () => {
    const before = ownerEvent({ uid: 'e1', startDate: '2026-10-20', endDate: '2026-10-25' });
    const across = ownerEvent({ uid: 'e2', startDate: '2026-10-25', endDate: '2026-10-26' });
    const inside = ownerEvent({ uid: 'e3', startDate: '2026-11-21' });
    const after = ownerEvent({ uid: 'e4', startDate: '2026-12-07' });
    const fake = calendarFake({ ownerEvents: [before, across, inside, after] });
    expect(await fetchOwnerCalendarEvents(fake, 'l1', { from: '2026-10-26', to: '2026-12-06' })).toEqual([across, inside]);
    const release = fake.hold('owner-calendars/events', '2026-11-30');
    let answered = false;
    const held = fetchOwnerCalendarEvents(fake, 'l1', { from: '2026-11-30', to: '2027-01-10' }).then((events) => { answered = true; return events; });
    await Promise.resolve();
    expect(answered).toBe(false);
    release();
    expect(await held).toEqual([after]);
  });

  test('a DELETE answers 204, or the ApiError set for its path', async () => {
    const fake = calendarFake();
    await expect(removeOwnerCalendar(fake, 'l1', 'c1')).resolves.toBeUndefined();
    fake.deletes[`${BASE}/c2`] = refusal(404, 'not_found');
    await expect(removeOwnerCalendar(fake, 'l1', 'c2')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
