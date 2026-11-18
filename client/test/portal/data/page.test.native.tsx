jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { daysOf, locationsFake, salesOf, uploadOf } from '../locations/fakes';
import { ownerCalendar } from '../calendar/fakes';
import { dailyTotalsOf, dataFake, itemOf } from './fakes';

// Your data on native (P26, D28): the same rows, each opening its item's page, where Turn off and Delete are
// (item.test.native.tsx); Add a file and Paste text are web only, so it says where to go instead.

afterEach(async () => {
  await cleanup();
});

const FILE = 'f_00000000000000000000000b';

const DAYS = daysOf('2025-01-01', 30, () => ({ guests: 50, netSalesCents: 150_000 }));

function setup() {
  const inner = locationsFake({ sales: { l1: salesOf(DAYS, [uploadOf('u1')]) }, days: { l1: DAYS } });
  const fake = dataFake({
    inner,
    items: [itemOf(FILE, { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' }), dailyTotalsOf('u_1')],
  });
  return { fake, api: fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake }) };
}

test('native lists the same rows with no actions in them, and a row opens its item’s page', async () => {
  const { api } = setup();
  const { router } = await renderApp('/locations/l1/data', api);
  const list = await screen.findByLabelText('Your data for Main Street Bar');
  expect(within(list).getByText('Kept for reference')).toBeTruthy();
  expect(within(list).getByText('5 of 10 in use, May 1, 2026 to May 10, 2026')).toBeTruthy();
  expect(within(list).getByText('No file kept')).toBeTruthy();
  expect(within(list).queryAllByRole('button')).toEqual([]);
  expect(screen.queryByText('Download from a computer at townwise.tech.')).toBeNull();
  const link = within(list).getByRole('link', { name: 'Daily totals, May 1, 2026 to May 10, 2026' });
  expect(link).toBeTruthy();
  await fireEvent.press(within(list).getByRole('link', { name: 'menu-notes.txt' }));
  await waitFor(() => { expect(router.getPathname()).toBe(`/locations/l1/data/${FILE}`); });
  expect(await screen.findByRole('button', { name: 'Turn off: menu-notes.txt' })).toBeTruthy();
});

test('native has no Add a file or Paste text and says Upload from a computer at townwise.tech.', async () => {
  const { api, fake } = setup();
  await renderApp('/locations/l1/data', api);
  await screen.findByLabelText('Your data for Main Street Bar');
  expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add a file' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Paste text' })).toBeNull();
  expect(screen.queryByText(/^Any kind of file up to 200 MB/)).toBeNull();
  // Stored files are not asked about on native: nothing there can add one.
  expect(fake.files.calls.filter((call) => call.path.startsWith('/files'))).toEqual([]);
});

// D49 (calendar-detail): the Calendars group on native, a tap opening the calendar's page inside the app.
test('the Calendars group lists the location’s calendars, and a tap opens one’s page', async () => {
  const { api, fake } = setup();
  fake.calendars = [ownerCalendar({ id: 'fedcba9876543210fedcba98', label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 11 })];
  const { router } = await renderApp('/locations/l1/data', api);
  const link = await screen.findByRole('link', { name: 'US holidays. Link, calendar.google.com, 11 events' });
  await fireEvent.press(link);
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1/data/c_fedcba9876543210fedcba98'); });
});
