jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import type { GoogleCalendars } from '../../../src/portal/calendar/api';
import { WEEKLY_TITLES_NOTICE } from '../../../src/portal/calendar/calendars';
import { ACCESS, fakePortalApi, meOf, orgOf, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { townEvent } from '../analytics/fakes';
import { CALENDARS_PATH, calendarFake, forecastDay, forecastOf, ownerCalendar, type CalendarFake } from './fakes';

// "Your calendars" on native (P28; owner-calendar's "The Calendar page shows and manages stored calendars", its Native
// scenario, and google-calendar's): the header row's button, with an expanded state, opens the popover in a Modal;
// there is no calendar file import and no "Add a Google calendar", so the line pointing to the web shows in their
// place, while Google calendars list with Refresh now and Remove; Add a link works inside it; and Android's back button
// closes it, keeping what was typed. Today is Wed, Nov 11, 2026. Synthetic figures and made-up names only.

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 11, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

const SATURDAY = '2026-11-21';
/** The line with Google calendars off, as calendarFake's list answers. */
const NATIVE_LINE = 'To add events from your own calendar file, open Townwise on the web.';
/** The line while the list answers Google calendars on. */
const NATIVE_LINE_GOOGLE = 'To import a calendar file or connect a Google calendar, open Townwise on the web.';
/** A made-up iCal address; the API never sends one back. */
const URL = 'https://calendar.google.com/calendar/ical/sample/private-0a1b2c/basic.ics';
const KITCHEN = ownerCalendar({ id: 'c1', label: 'Kitchen', kind: 'file', eventCount: 12 });
/** The words on adding a link (calendar-event-suggestions design decision 11). [CONFIRM: the add screens' words] */
const WEEKLY_READING = 'Once a week TownwiseAI reads the titles, dates and hours of the next 3 months of events on a calendar you add here, with email addresses and phone numbers removed, to suggest notes for private events. Where TownwiseAI works on its own, it also reads the titles, dates and hours of every event in a calendar file when it is imported, past ones included, to label your bookings, and uses those labels for forecasts at once, with Undo. They reach Anthropic, which doesn’t train on them. An admin of your organization can turn off the weekly reading, or the sending of your calendars’ titles, on the TownwiseAI page.';

function setup(init: Partial<Pick<CalendarFake, 'calendars'>> = {}): { api: FakePortalApi; fake: CalendarFake } {
  const days = Array.from({ length: 20 }, (_, at) => forecastDay({ date: `2026-11-${String(11 + at)}` }));
  const fake = calendarFake({ events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })], forecasts: { '2026-11': forecastOf(days) }, ...init });
  return { api: fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }), fake };
}

/** The popover's card: the dialog its label names. */
function popover(): ReturnType<typeof screen.getByLabelText> {
  return screen.getByLabelText('Your calendars');
}

/** The host Modal around the popover, where Android's back button lands (onRequestClose). */
function modal(): Parameters<typeof fireEvent>[0] {
  let node = popover();
  while (node.type !== 'Modal' && node.parent !== null) node = node.parent;
  if (node.type !== 'Modal') throw new Error('no Modal');
  return node;
}

test('the button shows its expanded state, and opens the popover in a Modal with the native line in place of the import', async () => {
  const { api } = setup({ calendars: [KITCHEN] });
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const button = await screen.findByRole('button', { name: 'Your calendars (1)' });
  expect(button.props.accessibilityState).toMatchObject({ expanded: false });
  expect(screen.queryByLabelText('Your calendars')).toBeNull();
  await fireEvent.press(button);
  expect(screen.getByRole('button', { name: 'Your calendars (1)' }).props.accessibilityState).toMatchObject({ expanded: true });
  const card = popover();
  expect(card.props.role).toBe('dialog');
  expect(modal().props).toMatchObject({ visible: true, transparent: true, animationType: 'none' });
  expect(within(card).getByRole('heading', { name: 'Your calendars' })).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(within(card).getByText('File, 12 events')).toBeTruthy();
  expect(within(card).getByText(NATIVE_LINE)).toBeTruthy();
  expect(within(card).queryByText('Import a calendar file')).toBeNull();
  expect(within(card).getByRole('button', { name: 'Add a link' })).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'How importing works' })).toBeTruthy();
});

test('Add a link works inside the popover: the link is posted and the popover says what was added', async () => {
  const { api, fake } = setup();
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Your calendars' }));
  await fireEvent.press(within(popover()).getByRole('button', { name: 'Add a link' }));
  // Where the link is added, the popover says once that TownwiseAI reads its titles weekly.
  expect(within(popover()).getAllByText(WEEKLY_READING)).toHaveLength(1);
  await fireEvent.changeText(within(popover()).getByLabelText('Name'), 'Bookings');
  await fireEvent.changeText(within(popover()).getByLabelText('Calendar link'), URL);
  const bookings = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1 });
  api.answers[CALENDARS_PATH] = () => { fake.calendars = [bookings]; return { calendar: bookings }; };
  await fireEvent.press(within(popover()).getByRole('button', { name: 'Add link' }));
  expect(await within(popover()).findByText('Added Bookings: 1 event.')).toBeTruthy();
  expect(await within(popover()).findByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  expect(within(popover()).queryByLabelText('Calendar link')).toBeNull();
  expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy();
  // Posted from the popover that says titles are read weekly, so the add records that the person was told.
  expect(writes(api)).toEqual([{ method: 'POST', path: CALENDARS_PATH, body: { kind: 'link', label: 'Bookings', url: URL, titlesNotice: WEEKLY_TITLES_NOTICE } }]);
});

test('the back button closes it, and opened again it keeps what was typed', async () => {
  const { api } = setup();
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Your calendars' }));
  await fireEvent.press(within(popover()).getByRole('button', { name: 'Add a link' }));
  await fireEvent.changeText(within(popover()).getByLabelText('Name'), 'Bookings');
  await fireEvent(modal(), 'requestClose');
  expect(screen.queryByLabelText('Your calendars')).toBeNull();
  expect(screen.getByRole('button', { name: 'Your calendars' }).props.accessibilityState).toMatchObject({ expanded: false });
  await fireEvent.press(screen.getByRole('button', { name: 'Your calendars' }));
  expect(within(popover()).getByLabelText('Name').props.value).toBe('Bookings');
  expect(writes(api)).toEqual([]);
});

/** The list answers `google` as given; calendarFake answers without it. */
function serveGoogle(fake: CalendarFake, google: GoogleCalendars): void {
  const json = fake.json.bind(fake);
  fake.json = ((...args: Parameters<typeof json>) => {
    const [path, schema, opts] = args;
    if (path !== CALENDARS_PATH || (opts?.method ?? 'GET') !== 'GET' || !Array.isArray(fake.calendars)) return json(...args);
    fake.paths.push(path);
    return Promise.resolve(schema.parse({ calendars: fake.calendars, google }));
  }) as typeof json;
}

test('with Google calendars on, native offers no “Add a Google calendar”: the native line shows, and a Google calendar lists with Refresh now and Remove', async () => {
  const google = ownerCalendar({ id: 'c3', label: 'Google calendar', kind: 'google', eventCount: 40, status: 'google_rate_limited' });
  const { api, fake } = setup({ calendars: [KITCHEN, google] });
  serveGoogle(fake, { available: true, connected: true, clientId: '123-abc.apps.googleusercontent.com', canConnect: true });
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Your calendars (2)' }));
  const card = popover();
  expect(within(card).getByText(NATIVE_LINE_GOOGLE)).toBeTruthy();
  expect(within(card).queryByText(NATIVE_LINE)).toBeNull();
  expect(within(card).queryByText('Add a Google calendar')).toBeNull();
  expect(within(card).getByText('Google calendar, 40 events')).toBeTruthy();
  expect(within(card).getByText('Couldn’t refresh: Google was busy. Townwise tries again later.')).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'Refresh now: Google calendar' })).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'Remove Google calendar' })).toBeTruthy();
  expect(within(card).queryByRole('button', { name: 'Refresh now: Kitchen' })).toBeNull();
  expect(fake.paths.filter((path) => path.includes('google-calendars'))).toEqual([]);
  expect(writes(api)).toEqual([]);
});

test('native connects nowhere: a revoked Google calendar its person added tells them to reconnect on the web, a teammate’s to ask whoever added it, and neither offers Reconnect', async () => {
  const revoked = 'Couldn’t refresh: Google no longer lets Townwise read this calendar.';
  const mine = ownerCalendar({ id: 'c3', label: 'Bookings', kind: 'google', eventCount: 40, status: 'google_revoked', mine: true });
  const theirs = ownerCalendar({ id: 'c4', label: 'Staff rota', kind: 'google', eventCount: 2, status: 'google_revoked' });
  const { api, fake } = setup({ calendars: [mine, theirs] });
  serveGoogle(fake, { available: true, connected: false, clientId: '123-abc.apps.googleusercontent.com', canConnect: true });
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Your calendars (2)' }));
  const card = popover();
  expect(within(card).getByText(`${revoked} Reconnect on the web, or remove it.`)).toBeTruthy();
  expect(within(card).getByText(`${revoked} Ask whoever added it to reconnect, or remove it.`)).toBeTruthy();
  expect(within(card).getByText(NATIVE_LINE_GOOGLE)).toBeTruthy();
  expect(within(card).queryByRole('button', { name: 'Reconnect Bookings' })).toBeNull();
  expect(within(card).getByRole('button', { name: 'Remove Bookings' })).toBeTruthy();
  expect(writes(api)).toEqual([]);
});
