jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

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
// first. Made-up titles only.

afterEach(async () => {
  await cleanup();
});

const ID = 'fedcba9876543210fedcba98';
const DAY = `${localToday().slice(0, 7)}-11`;

function setup() {
  const fake = dataFake({ inner: locationsFake() });
  fake.calendars = [ownerCalendar({ id: ID, label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 1 })];
  fake.calendarEvents = [ownerEvent({ calendarId: ID, calendar: 'US holidays', uid: 'v1', title: 'Veterans Day', startDate: DAY })];
  return { fake, api: fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }) };
}

test('the page shows the calendar and its month, and a tap opens the event’s day on the Calendar', async () => {
  const { api, fake } = setup();
  const { router } = await renderApp(`/locations/l1/data/c_${ID}`, api);
  expect(await screen.findByText('Link, calendar.google.com, 1 event')).toBeTruthy();
  const event = await screen.findByRole('link', { name: /^Veterans Day, .*\. Opens the day on the Calendar\.$/ });
  await fireEvent.press(event);
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1/calendar'); });
  expect(fake.paths.some((path) => path.includes('/data/c_'))).toBe(false);
});

test('a file calendar’s Bookings: an org admin sees Sort’s words and both buttons; a member only the counts (D58)', async () => {
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
