jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { Dimensions, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { monthLabel } from '../../../src/portal/calendar/model';
import { BOOKINGS } from '../../../src/portal/data/item/bookingWords';
import { ITEM } from '../../../src/portal/data/item/copy';
import { localToday } from '../../../src/portal/locations/dates';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { ownerCalendar, ownerEvent } from '../calendar/fakes';
import { locationsFake } from '../locations/fakes';
import { dataFake } from './fakes';

// A calendar's page in Your data on native (D49, calendar-detail): the same page as on web, its events a tap away from
// their day on the Calendar, and no read of the data item route. Dates are in today's month so the page shows them
// first. Wider than a phone the month is a grid whose tapped day lists its events (D62); a phone keeps the month's
// agenda. Made-up titles only.

let restore: (() => void) | null = null;

/** A phone's width, where the page keeps the agenda. */
function onPhone(): void {
  const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 375, height: 800, scale: 2, fontScale: 1 });
  restore = () => { spy.mockRestore(); };
}

afterEach(async () => {
  await cleanup();
  restore?.();
  restore = null;
});

const ID = 'fedcba9876543210fedcba98';
const DAY = `${localToday().slice(0, 7)}-11`;

function setup() {
  const fake = dataFake({ inner: locationsFake() });
  fake.calendars = [ownerCalendar({ id: ID, label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 1 })];
  fake.calendarEvents = [ownerEvent({ calendarId: ID, calendar: 'US holidays', uid: 'v1', title: 'Veterans Day', startDate: DAY })];
  return { fake, api: fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }) };
}

test('the page shows the calendar and its month as a grid; a tapped day lists its events, and a tap opens the event’s day', async () => {
  const { api, fake } = setup();
  const { router } = await renderApp(`/locations/l1/data/c_${ID}`, api);
  expect(await screen.findByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  const day = await screen.findByRole('button', { name: /^\w+, \w+ 11, \d{4}\.( Today\.)? 1 event: Veterans Day\.$/ });
  expect(within(day).getByText('Veterans Day')).toBeTruthy();
  await fireEvent.press(day);
  expect(screen.getByRole('button', { name: /^\w+, \w+ 11, \d{4}\./, selected: true })).toBeTruthy();
  const event = await screen.findByRole('link', { name: /^Veterans Day, .*\. Opens the day on the Calendar\.$/ });
  await fireEvent.press(event);
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1/calendar'); });
  expect(fake.paths.some((path) => path.includes('/data/c_'))).toBe(false);
});

test('a phone keeps the month’s agenda, each event a link to its day', async () => {
  onPhone();
  const { api } = setup();
  await renderApp(`/locations/l1/data/c_${ID}`, api);
  expect(await screen.findByRole('link', { name: /^Veterans Day, .*\. Opens the day on the Calendar\.$/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^\w+, \w+ 11, \d{4}\./ })).toBeNull();
});

test('on the grid a file calendar’s labeled event shows its tag, and its day says the label (D58, D62)', async () => {
  const fake = dataFake({ inner: locationsFake() });
  const bookings = { state: 'sorted', sortedAt: null, confirmedAt: null, counts: { buyout: 1, party: 0, own_event: 0, other: 0, unlabeled: 0 } };
  fake.calendars = [ownerCalendar({ id: ID, label: 'Master calendar', kind: 'file', eventCount: 1, format: 'csv', bookings })];
  fake.calendarEvents = [ownerEvent({
    calendarId: ID, calendar: 'Master calendar', uid: 'b1', title: 'Full house dinner', startDate: DAY, startTime: '18:00', endTime: '21:00', booking: 'buyout',
  })];
  await renderApp(`/locations/l1/data/c_${ID}`, fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }));
  const day = await screen.findByRole('button', { name: /^\w+, \w+ 11, \d{4}\.( Today\.)? 1 event: Full house dinner, 6 pm to 9 pm, Buyout\.$/ });
  expect(within(day).getByText('6 pm')).toBeTruthy();
  expect(within(day).getByText('Buyout')).toBeTruthy();
  // Review: the title keeps at least 40% of its line, the tag giving way first, so a long tag never hides it.
  const share = (text: string): Record<string, unknown> => StyleSheet.flatten(within(day).getByText(text).props.style as StyleProp<TextStyle>) as Record<string, unknown>;
  expect(share('Full house dinner')).toMatchObject({ flexBasis: '40%', flexGrow: 1, flexShrink: 0 });
  expect(share('Buyout')).toMatchObject({ flexShrink: 1, minWidth: 0 });
  expect(share('6 pm')).toMatchObject({ flexShrink: 0 });
  // Review: the month shown is named above the grid.
  expect(screen.getByRole('heading', { name: monthLabel(DAY.slice(0, 7)) })).toBeTruthy();
});

test('a file calendar’s Bookings: an org admin sees Sort’s words and both buttons; a member only the counts (D58)', async () => {
  // On a phone, where every event of the month lists with its label.
  onPhone();
  const bookings = { state: 'sorted', sortedAt: null, confirmedAt: null, counts: { buyout: 1, party: 0, own_event: 0, other: 0, unlabeled: 0 } };
  const fileFake = (): ReturnType<typeof dataFake> => {
    const fake = dataFake({ inner: locationsFake() });
    fake.calendars = [ownerCalendar({ id: ID, label: 'Master calendar', kind: 'file', eventCount: 1, format: 'csv', bookings })];
    fake.bookingSort = { available: true };
    fake.calendarEvents = [ownerEvent({ calendarId: ID, calendar: 'Master calendar', uid: 'b1', title: 'Full house dinner', startDate: DAY, booking: 'buyout' })];
    return fake;
  };
  const admin = fileFake();
  await renderApp(`/locations/l1/data/c_${ID}`, fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: admin }));
  expect(await screen.findByText('Sorted, not used for forecasts yet.')).toBeTruthy();
  expect(screen.getByText(BOOKINGS.sortExplain)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sort with TownwiseAI' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Use for forecasts' })).toBeTruthy();
  expect(await screen.findByRole('button', { name: /^Label for Full house dinner, / })).toBeTruthy();
  await cleanup();
  const member = fileFake();
  await renderApp(`/locations/l1/data/c_${ID}`, fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: member }));
  expect(await screen.findByText('Sorted, not used for forecasts yet.')).toBeTruthy();
  // The count's row and the event's label.
  await waitFor(() => { expect(screen.getAllByText('Buyout (takes the whole restaurant)')).toHaveLength(2); });
  expect(screen.queryByRole('button', { name: 'Sort with TownwiseAI' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use for forecasts' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Label for / })).toBeNull();
});

test('an unknown calendar shows the not-found state', async () => {
  const { api } = setup();
  await renderApp('/locations/l1/data/c_aaaaaaaaaaaaaaaaaaaaaaaa', api);
  // A row in the page, not a toast that fades (UI review S3).
  const gone = await screen.findByText(ITEM.calendarGone);
  expect(screen.queryByTestId('toast-text')).toBeNull();
  expect(gone).toBeTruthy();
});
