jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { ACCESS, fakePortalApi, meOf, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { townEvent } from '../analytics/fakes';
import {
  CALENDARS_PATH, calendarFake, forecastDay, forecastOf, NOTES_PATH, ownerCalendar, ownerEvent, savedNote, type CalendarFake,
} from './fakes';

// P28 Calendar on native (spec 16.3): the same reads and grid as on web, a Pressable grid with the day
// panel under it, adding a note from the day, the location's stored calendar events, and "Your calendars" with links
// and Google calendars but no calendar file import (no file picker is installed) and no Google connect. Today is Wed, Nov 11, 2026. Synthetic figures and made-up
// titles and addresses only.

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

const GAME_REASON = {
  kind: 'event', label: 'Dartmouth home football', effectPct: null, effect: { direction: 'more', pct: 20, basis: 'history', days: 5 } as const, sources: [], note: null,
};
const SATURDAY = '2026-11-21';
/** The list here answers without `google` (Google calendars off), so the line names no Google connect. */
const NATIVE_LINE = 'To add events from your own calendar file, open Townwise on the web.';
const URL = 'https://calendar.google.com/calendar/ical/sample/private-0a1b2c/basic.ics';
const LABEL = 'Sat, Nov 21, 2026. Forecast about 212 guests, 180 to 240. Dartmouth home football.';

function november(guests = 0): unknown {
  const days = [];
  for (let day = 11; day <= 30; day += 1) {
    const date = `2026-11-${String(day)}`;
    if (date !== SATURDAY) days.push(forecastDay({ date }));
    else if (guests === 0) days.push(forecastDay({ date, reasons: [GAME_REASON] }));
    else {
      days.push(forecastDay({
        date, low: 180 + guests, mid: 212 + guests, high: 240 + guests, model: { status: 'open', low: 180, mid: 212, high: 240 }, noteGuests: guests,
        reasons: [{ kind: 'note', label: `Your private event, ${String(guests)} guests`, effectPct: null, sources: [], note: { id: 'n9', guests, outcome: 'added' } }, GAME_REASON],
      }));
    }
  }
  return forecastOf(days);
}

function setup(
  init: Partial<Pick<CalendarFake, 'calendars' | 'ownerEvents'>> = {}, me = meOf(ACCESS.member),
): { api: FakePortalApi; fake: CalendarFake } {
  const fake = calendarFake({ events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })], forecasts: { '2026-11': november() }, ...init });
  return { api: fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake }), fake };
}

function panel() {
  return screen.getByLabelText('Selected day');
}

test('tapping a day shows its forecast and reasons under the grid', async () => {
  const { api } = setup();
  await renderApp('/locations/l1/calendar', api);
  expect(await screen.findByText('Today, Wed, Nov 11')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(LABEL));
  expect(within(panel()).getByText('Sat, Nov 21, 2026')).toBeTruthy();
  expect(within(panel()).getByText('About 212 guests')).toBeTruthy();
  expect(within(panel()).getByText('Likely 180 to 240. About 8 in 10 days land in the range.')).toBeTruthy();
  expect(within(panel()).getByText('Dartmouth home football')).toBeTruthy();
  // The effect in words, which is what a screen reader hears; On the calendar doesn't repeat the game.
  expect(within(panel()).getByText('Usually about 20% more guests than the same weekday without it')).toBeTruthy();
  expect(within(panel()).queryByText('Dartmouth home football. Town event.')).toBeNull();
  expect(screen.getByLabelText(LABEL).props.accessibilityState).toMatchObject({ selected: true });
});

test('Your calendars: no file import, the line points to the web, and a link can be added, refreshed and removed', async () => {
  const { api, fake } = setup();
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  const button = await screen.findByRole('button', { name: 'Your calendars' });
  expect(button.props.accessibilityState).toMatchObject({ expanded: false });
  expect(screen.queryByText(NATIVE_LINE)).toBeNull();
  await fireEvent.press(button);
  expect(screen.getByRole('button', { name: 'Your calendars' }).props.accessibilityState).toMatchObject({ expanded: true });
  expect(screen.getByText(NATIVE_LINE)).toBeTruthy();
  expect(screen.queryByText('Import a calendar file')).toBeNull();
  expect(screen.getByText('No calendars yet.')).toBeTruthy();
  // "Your calendar" shows only with a calendar.
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();

  await fireEvent.press(screen.getByRole('button', { name: 'Add a link' }));
  await fireEvent.changeText(screen.getByLabelText('Name'), 'Bookings');
  await fireEvent.changeText(screen.getByLabelText('Calendar link'), URL);
  api.answers[CALENDARS_PATH] = () => refusal(503, 'calendar_links_unavailable');
  await fireEvent.press(screen.getByRole('button', { name: 'Add link' }));
  expect(await screen.findByText('Calendar links aren’t available right now. You can still import a calendar file on the web.')).toBeTruthy();
  const bookings = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1 });
  api.answers[CALENDARS_PATH] = () => { fake.calendars = [bookings]; return { calendar: bookings }; };
  await fireEvent.press(screen.getByRole('button', { name: 'Add link' }));
  expect(await screen.findByText('Added Bookings: 1 event.')).toBeTruthy();
  expect(await screen.findByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Your calendars (1)' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Your calendar' })).toBeTruthy();
  expect(screen.queryByLabelText('Calendar link')).toBeNull();

  api.answers[`${CALENDARS_PATH}/c2/refresh`] = () => ({ calendar: bookings });
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh now: Bookings' }));
  expect(await screen.findByText('Refreshed Bookings.')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Remove Bookings' }));
  expect(await screen.findByText('Remove this calendar?')).toBeTruthy();
  fake.calendars = [];
  await fireEvent.press(screen.getByRole('button', { name: 'Remove calendar' }));
  expect(await screen.findByText('Removed Bookings.')).toBeTruthy();
  expect(await screen.findByText('No calendars yet.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Your calendar' })).toBeNull();
  expect(writes(api)).toEqual([
    { method: 'POST', path: CALENDARS_PATH, body: { kind: 'link', label: 'Bookings', url: URL } },
    { method: 'POST', path: CALENDARS_PATH, body: { kind: 'link', label: 'Bookings', url: URL } },
    { method: 'POST', path: `${CALENDARS_PATH}/c2/refresh`, body: undefined },
    { method: 'DELETE', path: `${CALENDARS_PATH}/c2`, body: undefined },
  ]);
});

test('a Google calendar on native: listed as “Google calendar, 40 events”, refreshed and removed from the panel, with no connect', async () => {
  const google = ownerCalendar({ id: 'c3', label: 'Google calendar', kind: 'google', eventCount: 40 });
  const { api, fake } = setup({ calendars: [google] });
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Your calendars (1)' }));
  expect(screen.getByText('Google calendar, 40 events')).toBeTruthy();
  expect(screen.getByText(NATIVE_LINE)).toBeTruthy();
  expect(screen.queryByText('Add a Google calendar')).toBeNull();

  api.answers[`${CALENDARS_PATH}/c3/refresh`] = () => ({ calendar: { ...google, status: 'google_not_found' } });
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh now: Google calendar' }));
  expect((await screen.findAllByText('Couldn’t refresh: this Google calendar was deleted or is no longer shared with the account that added it.')).length)
    .toBeGreaterThan(0);

  await fireEvent.press(screen.getByRole('button', { name: 'Remove Google calendar' }));
  expect(await screen.findByText('Remove this calendar?')).toBeTruthy();
  fake.calendars = [];
  await fireEvent.press(screen.getByRole('button', { name: 'Remove calendar' }));
  expect(await screen.findByText('Removed Google calendar.')).toBeTruthy();
  expect(await screen.findByText('No calendars yet.')).toBeTruthy();
  expect(writes(api)).toEqual([
    { method: 'POST', path: `${CALENDARS_PATH}/c3/refresh`, body: undefined },
    { method: 'DELETE', path: `${CALENDARS_PATH}/c3`, body: undefined },
  ]);
});

test('view-as on native: the panel lists the calendars, and Add a link, Refresh now and Remove are disabled in place and send nothing', async () => {
  const kitchen = ownerCalendar({ id: 'c1', label: 'Kitchen', kind: 'file', eventCount: 12 });
  const bookings = ownerCalendar({ id: 'c2', label: 'Bookings', kind: 'link', host: 'calendar.google.com', eventCount: 1 });
  const { api } = setup({ calendars: [kitchen, bookings] }, viewAsMe(ACCESS.admin));
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Your calendars (2)' }));
  expect(screen.getByText('File, 12 events')).toBeTruthy();
  expect(screen.getByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  expect(screen.getByText(NATIVE_LINE)).toBeTruthy();
  for (const name of ['Add a link', 'Refresh now: Bookings', 'Remove Kitchen', 'Remove Bookings']) {
    const control = screen.getByRole('button', { name });
    expect(control.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(control);
  }
  expect(screen.queryByLabelText('Calendar link')).toBeNull();
  expect(screen.queryByText('Remove this calendar?')).toBeNull();
  // The page's own read-only line, and the panel's.
  expect(screen.getAllByText('Read-only while viewing as gm@example.org.')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'How importing works' }).props.accessibilityState).toMatchObject({ disabled: false });
  expect(writes(api)).toEqual([]);
});

test('stored events show on native: in the week’s agenda and the day panel', async () => {
  const { api } = setup({
    calendars: [ownerCalendar({ id: 'c1', label: 'Kitchen', eventCount: 1 })],
    ownerEvents: [ownerEvent({ calendarId: 'c1', uid: 'e1', title: 'Wine delivery', startDate: SATURDAY, startTime: '09:00', endTime: '10:00' })],
  });
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}&view=week`, api);
  const agenda = await screen.findByLabelText('Nov 18 to 24, 2026');
  expect(within(agenda).getByText('Wine delivery')).toBeTruthy();
  expect(within(panel()).getByText('From your calendar: Wine delivery')).toBeTruthy();
  expect(within(panel()).getByRole('button', { name: 'Make a note from Wine delivery' })).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('adds a note from the day and reloads the forecast', async () => {
  const { api, fake } = setup();
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Add an event' }));
  await fireEvent.changeText(screen.getByLabelText('Expected guests (optional)'), '70');
  api.answers[NOTES_PATH] = (body) => {
    const saved = savedNote('n9', body);
    fake.notes = [saved.note];
    fake.forecasts['2026-11'] = november(70);
    return saved;
  };
  await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
  expect(await screen.findByText('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.')).toBeTruthy();
  expect(await within(panel()).findByText('Adds 70 guests')).toBeTruthy();
  expect(within(panel()).getByText('About 282 guests')).toBeTruthy();
  expect(fake.paths.filter((path) => path.includes('/forecast?'))).toHaveLength(2);
  expect(writes(api)).toEqual([{
    method: 'POST', path: NOTES_PATH,
    body: {
      kind: 'private_event', startDate: SATURDAY, endDate: SATURDAY, weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
      startTime: null, endTime: null,
    },
  }]);
});

test('the Month and Week switch: Week shows the agenda of the block from today that holds the selected day, a row selects its day, Month the grid again', async () => {
  const { api, fake } = setup();
  await renderApp(`/locations/l1/calendar?day=${SATURDAY}`, api);
  expect(await screen.findByLabelText('November 2026')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Month' }).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByRole('button', { name: 'Week' }).props.accessibilityState).toMatchObject({ checked: false });
  const reads = fake.paths.length;
  await fireEvent.press(screen.getByRole('button', { name: 'Week' }));
  const agenda = await screen.findByLabelText('Nov 18 to 24, 2026');
  expect(screen.getByRole('button', { name: 'Week' }).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByRole('button', { name: 'Month' }).props.accessibilityState).toMatchObject({ checked: false });
  const rows = within(agenda).getAllByRole('button');
  expect(rows).toHaveLength(7);
  // Today is Wed, Nov 11: the block of Nov 18 to 24, Saturday its fourth row.
  expect(rows[3]?.props.accessibilityLabel).toBe(LABEL);
  expect(rows[3]?.props.accessibilityState).toMatchObject({ selected: true });
  expect(within(agenda).getByText('Dartmouth home football')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Previous week' })).toBeTruthy();
  const thursday = rows[1];
  if (thursday === undefined) throw new Error('no Thursday');
  await fireEvent.press(thursday);
  expect(await within(panel()).findByText('Thu, Nov 19, 2026')).toBeTruthy();
  expect(screen.getByLabelText('Nov 18 to 24, 2026')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Month' }));
  expect(await screen.findByLabelText('November 2026')).toBeTruthy();
  expect(screen.queryByLabelText('Nov 18 to 24, 2026')).toBeNull();
  expect(fake.paths.slice(reads)).toEqual([]);
});

test('an outlook day on native (D52): its cell’s label says outlook, its panel is headed Outlook with no 8 in 10, and the key line shows', async () => {
  const days = [];
  for (let day = 11; day <= 30; day += 1) {
    const date = `2026-11-${String(day)}`;
    days.push(day < 20 ? forecastDay({ date }) : forecastDay({ date, low: 150, mid: 212, high: 290, model: { status: 'open', low: 150, mid: 212, high: 290 }, outlook: true }));
  }
  const fake = calendarFake({ events: [], forecasts: { '2026-11': forecastOf(days) } });
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
  await renderApp('/locations/l1/calendar', api);
  expect(await screen.findByText('Today, Wed, Nov 11')).toBeTruthy();
  const label = 'Sat, Nov 21, 2026. Outlook about 212 guests, 150 to 290.';
  expect(screen.getByText('Days more than 3 months after Townwise’s last refresh show its outlook: a wider range that firms up as the weeks pass and your new sales come in.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(label));
  expect(within(panel()).getByText('Outlook')).toBeTruthy();
  expect(within(panel()).getByText('About 212 guests')).toBeTruthy();
  expect(within(panel()).getByText('Likely 150 to 290. Days more than 3 months away are less certain, so this range is wider.')).toBeTruthy();
  expect(within(panel()).queryByText(/8 in 10/)).toBeNull();
});
