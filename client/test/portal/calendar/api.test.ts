import {
  addOwnerCalendar, connectGoogleCalendars, dropGoogleConnection, fetchGoogleChoices, fetchOwnerCalendarEvents, fetchOwnerCalendars,
  GOOGLE_OFF, refreshOwnerCalendar, removeOwnerCalendar,
} from '../../../src/portal/calendar/api';
import { WEEKLY_TITLES_NOTICE } from '../../../src/portal/calendar/calendars';
import { ACCESS, fakePortalApi, meOf, refusal, writes } from '../../helpers/portal';
import { noContent, withRoutes } from '../team/fixtures';
import { calendarFake, ownerCalendar, ownerEvent } from './fakes';

// The owner calendar routes (spec 10.18, api/src/handlers/owner-calendars.ts; connect-owner-calendar design decision
// 11) and the Google calendar routes (api/src/handlers/google-calendars.ts; connect-google-calendar design decisions 8
// and 15) through a recording fake ApiClient. Made-up names, titles, addresses, codes and Google ids only.

const BASE = '/api/org/locations/l1/owner-calendars';
const GOOGLE_BASE = '/api/org/locations/l1/google-calendars';
/** A made-up client id and code, in Google's shapes. */
const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const CODE = '4/0Afake-code';

function api() {
  const fake = fakePortalApi({ me: meOf(ACCESS.member) });
  const routes = withRoutes(fake);
  return { fake, routes };
}

const FILE = ownerCalendar({ id: 'c1', label: 'Kitchen', kind: 'file', host: null, eventCount: 12 });
const LINK = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1 });
const GOOGLE = ownerCalendar({ id: 'c4', label: 'Google calendar', kind: 'google', host: null, eventCount: 40 });
const GOOGLE_ON = { available: true, connected: true, clientId: CLIENT_ID, canConnect: true };

describe('owner calendar calls (spec 10.18)', () => {
  test('GET .../owner-calendars returns the calendars and `google`, a status the client has no words for included, stripping other keys', async () => {
    const { fake, routes } = api();
    const later = { ...LINK, id: 'c3', status: 'gone_quiet' };
    routes.gets[BASE] = () => ({ calendars: [{ ...FILE, slot: 0 }, LINK, later, GOOGLE], google: { ...GOOGLE_ON, scopes: ['openid'] } });
    expect(await fetchOwnerCalendars(fake, 'l1')).toEqual({ calendars: [FILE, LINK, later, GOOGLE], google: GOOGLE_ON });
    expect(fake.calls).toEqual([{ method: 'GET', path: BASE, body: undefined }]);
  });

  test('a Google calendar and a kind the client doesn’t know both parse, so a later kind never fails the list', async () => {
    const { fake, routes } = api();
    const later = { ...FILE, id: 'c5', kind: 'outlook' };
    routes.gets[BASE] = () => ({ calendars: [GOOGLE, later], google: GOOGLE_OFF });
    expect(await fetchOwnerCalendars(fake, 'l1')).toEqual({ calendars: [GOOGLE, later], google: GOOGLE_OFF });
  });

  test('a calendar’s `mine` parses, and a calendar without it, from an API older than Reconnect, reads as not mine', async () => {
    const { fake, routes } = api();
    const older: Record<string, unknown> = { ...GOOGLE };
    delete older.mine;
    routes.gets[BASE] = () => ({ calendars: [{ ...GOOGLE, mine: true }, { ...older, id: 'c5' }], google: GOOGLE_ON });
    expect(await fetchOwnerCalendars(fake, 'l1')).toEqual({ calendars: [{ ...GOOGLE, mine: true }, { ...GOOGLE, id: 'c5', mine: false }], google: GOOGLE_ON });
    routes.gets[BASE] = () => ({ calendars: [{ ...GOOGLE, mine: 'yes' }] });
    await expect(fetchOwnerCalendars(fake, 'l1')).rejects.toThrow();
  });

  test('`google.canConnect` parses, false for staff, and reads as true from an API older than it', async () => {
    const { fake, routes } = api();
    const staff = { available: true, connected: false, clientId: null, canConnect: false };
    routes.gets[BASE] = () => ({ calendars: [], google: staff });
    expect((await fetchOwnerCalendars(fake, 'l1')).google).toEqual(staff);
    routes.gets[BASE] = () => ({ calendars: [], google: { available: true, connected: false, clientId: CLIENT_ID } });
    expect((await fetchOwnerCalendars(fake, 'l1')).google).toEqual({ available: true, connected: false, clientId: CLIENT_ID, canConnect: true });
  });

  test('an answer without `google`, from an API older than Google calendars, reads as Google calendars off', async () => {
    const { fake, routes } = api();
    routes.gets[BASE] = () => ({ calendars: [FILE] });
    expect(await fetchOwnerCalendars(fake, 'l1')).toEqual({ calendars: [FILE], google: { available: false, connected: false, clientId: null, canConnect: false } });
  });

  test('a calendar or a `google` the client can’t read is an invalid response', async () => {
    const { fake, routes } = api();
    routes.gets[BASE] = () => ({ calendars: [{ ...FILE, eventCount: 'many' }] });
    await expect(fetchOwnerCalendars(fake, 'l1')).rejects.toThrow();
    routes.gets[BASE] = () => ({ calendars: [FILE], google: { available: 'yes' } });
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

  test('POST .../owner-calendars sends a Google calendar by its Google id alone; refusals pass through', async () => {
    const { fake } = api();
    fake.answers[BASE] = () => ({ calendar: GOOGLE });
    const googleCalendarId = ['owner', 'example.com'].join('@');
    expect(await addOwnerCalendar(fake, 'l1', { kind: 'google', googleCalendarId })).toEqual(GOOGLE);
    fake.answers[BASE] = () => refusal(409, 'calendar_already_added');
    await expect(addOwnerCalendar(fake, 'l1', { kind: 'google', googleCalendarId: 'primary' })).rejects.toMatchObject({ status: 409, code: 'calendar_already_added' });
    expect(writes(fake)).toEqual([
      { method: 'POST', path: BASE, body: { kind: 'google', googleCalendarId } },
      { method: 'POST', path: BASE, body: { kind: 'google', googleCalendarId: 'primary' } },
    ]);
  });

  test('POST .../owner-calendars/:calendarId/refresh sends no body and returns the calendar', async () => {
    const { fake } = api();
    fake.answers[`${BASE}/c2/refresh`] = () => ({ calendar: { ...LINK, status: 'timeout' } });
    expect(await refreshOwnerCalendar(fake, 'l1', 'c2')).toEqual({ ...LINK, status: 'timeout' });
    fake.answers[`${BASE}/c2/refresh`] = () => refusal(429, 'rate_limited', 240);
    await expect(refreshOwnerCalendar(fake, 'l1', 'c2')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 240 });
    fake.answers[`${BASE}/c4/refresh`] = () => ({ calendar: { ...GOOGLE, status: 'google_revoked' } });
    expect(await refreshOwnerCalendar(fake, 'l1', 'c4')).toEqual({ ...GOOGLE, status: 'google_revoked' });
    expect(writes(fake)).toEqual([
      { method: 'POST', path: `${BASE}/c2/refresh`, body: undefined },
      { method: 'POST', path: `${BASE}/c2/refresh`, body: undefined },
      { method: 'POST', path: `${BASE}/c4/refresh`, body: undefined },
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
    const google = '/api/org/locations/a%2Fb/google-calendars';
    routes.gets[base] = () => ({ calendars: [] });
    routes.gets[`${base}/events?from=2026-11-01&to=2026-11-30`] = () => ({ events: [] });
    routes.gets[google] = () => ({ calendars: [] });
    routes.requests[`DELETE ${base}/c%3F1`] = noContent;
    fake.answers[base] = () => ({ calendar: FILE });
    fake.answers[`${base}/c%3F1/refresh`] = () => ({ calendar: LINK });
    fake.answers[`${google}/connect`] = () => ({ calendars: [] });
    await fetchOwnerCalendars(fake, 'a/b');
    await fetchOwnerCalendarEvents(fake, 'a/b', { from: '2026-11-01', to: '2026-11-30' });
    await addOwnerCalendar(fake, 'a/b', { kind: 'file', label: 'Kitchen', ics: '' });
    await refreshOwnerCalendar(fake, 'a/b', 'c?1');
    await removeOwnerCalendar(fake, 'a/b', 'c?1');
    await fetchGoogleChoices(fake, 'a/b');
    await connectGoogleCalendars(fake, 'a/b', CODE, WEEKLY_TITLES_NOTICE);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${base}`,
      `GET ${base}/events?from=2026-11-01&to=2026-11-30`,
      `POST ${base}`,
      `POST ${base}/c%3F1/refresh`,
      `DELETE ${base}/c%3F1`,
      `GET ${google}`,
      `POST ${google}/connect`,
    ]);
  });
});

describe('Google calendar calls (connect-google-calendar design decision 8)', () => {
  const PRIMARY = { id: ['owner', 'example.com'].join('@'), name: 'Owner', primary: true, added: true };
  const SHARED = { id: 'c_fake0123@group.calendar.google.com', name: 'Bookings', primary: false, added: false };

  test('connect posts the code, the agreement and the weekly notice in the body, never the path, and returns the choices', async () => {
    const { fake } = api();
    fake.answers[`${GOOGLE_BASE}/connect`] = () => ({ calendars: [{ ...PRIMARY, accessRole: 'owner' }, SHARED] });
    expect(await connectGoogleCalendars(fake, 'l1', CODE, WEEKLY_TITLES_NOTICE)).toEqual([PRIMARY, SHARED]);
    fake.answers[`${GOOGLE_BASE}/connect`] = () => refusal(409, 'google_other_account');
    await expect(connectGoogleCalendars(fake, 'l1', CODE, WEEKLY_TITLES_NOTICE)).rejects.toMatchObject({ status: 409, code: 'google_other_account' });
    expect(writes(fake)).toEqual([
      { method: 'POST', path: `${GOOGLE_BASE}/connect`, body: { code: CODE, agreed: true, titlesNotice: 1 } },
      { method: 'POST', path: `${GOOGLE_BASE}/connect`, body: { code: CODE, agreed: true, titlesNotice: 1 } },
    ]);
    for (const call of fake.calls) expect(call.path).not.toContain(CODE);
  });

  test('the choices are a GET of .../google-calendars; refusals pass through', async () => {
    const { fake, routes } = api();
    routes.gets[GOOGLE_BASE] = () => ({ calendars: [PRIMARY, SHARED] });
    expect(await fetchGoogleChoices(fake, 'l1')).toEqual([PRIMARY, SHARED]);
    routes.gets[GOOGLE_BASE] = () => refusal(409, 'google_reconnect');
    await expect(fetchGoogleChoices(fake, 'l1')).rejects.toMatchObject({ status: 409, code: 'google_reconnect' });
    expect(fake.calls).toEqual([
      { method: 'GET', path: GOOGLE_BASE, body: undefined },
      { method: 'GET', path: GOOGLE_BASE, body: undefined },
    ]);
  });

  test('dropping the connection is a DELETE of /api/org/google-connection with no body, resolving on 204', async () => {
    const { fake, routes } = api();
    routes.requests['DELETE /api/org/google-connection'] = noContent;
    await expect(dropGoogleConnection(fake)).resolves.toBeUndefined();
    routes.requests['DELETE /api/org/google-connection'] = () => refusal(409, 'google_connection_in_use');
    await expect(dropGoogleConnection(fake)).rejects.toMatchObject({ status: 409, code: 'google_connection_in_use' });
    expect(writes(fake)).toEqual([
      { method: 'DELETE', path: '/api/org/google-connection', body: undefined },
      { method: 'DELETE', path: '/api/org/google-connection', body: undefined },
    ]);
  });

  test('a choice the client can’t read is an invalid response', async () => {
    const { fake, routes } = api();
    routes.gets[GOOGLE_BASE] = () => ({ calendars: [{ ...SHARED, primary: 'no' }] });
    await expect(fetchGoogleChoices(fake, 'l1')).rejects.toThrow();
  });
});

describe('the Calendar page fake’s owner calendar routes', () => {
  test('the list answers `calendars` with no `google` (read as off), or rejects with its ApiError', async () => {
    const fake = calendarFake({ calendars: [FILE, LINK] });
    expect(await fetchOwnerCalendars(fake, 'l1')).toEqual({ calendars: [FILE, LINK], google: GOOGLE_OFF });
    fake.calendars = refusal(503, null);
    await expect(fetchOwnerCalendars(fake, 'l1')).rejects.toMatchObject({ status: 503 });
    expect(await fetchOwnerCalendars(calendarFake(), 'l1')).toEqual({ calendars: [], google: GOOGLE_OFF });
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
