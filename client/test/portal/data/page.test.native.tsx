jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { daysOf, locationsFake, salesOf, uploadOf } from '../locations/fakes';
import { ownerCalendar } from '../calendar/fakes';
import { dailyTotalsOf, dataFake, itemOf } from './fakes';

// Your data on native (P26, D28): the same rows, each opening its item's page, where Turn off and Delete are
// (item.test.native.tsx); Add a file and Paste text are web only, so it says where to go instead. D61: the folders by
// default, and Newest first remembered in the device's secure store; most tests here read Newest first from it.

/** What the device's secure store holds for the View, read by dataView.ts once the page opens. */
let keptView: string | null = 'newest';

beforeEach(() => {
  keptView = 'newest';
  jest.mocked(SecureStore.getItemAsync).mockImplementation((key) => Promise.resolve(key === 'townwise.dataView.u1' ? keptView : null));
  jest.mocked(SecureStore.setItemAsync).mockImplementation(() => Promise.resolve());
});

afterEach(async () => {
  await cleanup();
  jest.mocked(SecureStore.setItemAsync).mockClear();
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

// D49 and D61: a calendar is an item of the list on native too, a tap opening its page inside the app.
test('a calendar is a row of the list, and a tap opens its page', async () => {
  const { api, fake } = setup();
  fake.calendars = [ownerCalendar({ id: 'fedcba9876543210fedcba98', label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 11 })];
  const { router } = await renderApp('/locations/l1/data', api);
  const list = await screen.findByLabelText('Your data for Main Street Bar');
  const link = await within(list).findByRole('link', { name: 'US holidays. Link, calendar.google.com, 11 events' });
  expect(within(list).getByText('Calendar')).toBeTruthy();
  await fireEvent.press(link);
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1/data/c_fedcba9876543210fedcba98'); });
});

// D60: on native the import is the line pointing to the web, at the top of the list; no Calendars group.
test('the import points to the web for a calendar file, and there is no separate Calendars group', async () => {
  const { api, fake } = setup();
  await renderApp('/locations/l1/data', api);
  expect(await screen.findByText('To add events from your own calendar file, open Townwise on the web.')).toBeTruthy();
  expect(screen.queryByText('No calendars yet.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Import a calendar file' })).toBeNull();
  expect(fake.calendarAdds).toEqual([]);
});

test('with nothing kept on the device the folders show, a folder opens in place, and Newest first is kept on the device', async () => {
  keptView = null;
  const { api, fake } = setup();
  fake.items = [
    itemOf(FILE, { name: 'menu-notes.txt', state: 'kept', outcome: 'reference', folder: 'menus' }), dailyTotalsOf('u_1', { folder: 'sales' }),
  ];
  fake.calendars = [ownerCalendar({ id: 'fedcba9876543210fedcba98', label: 'Kitchen', kind: 'file', eventCount: 4 })];
  const { router } = await renderApp('/locations/l1/data', api);
  const folders = await screen.findByLabelText('Folders, Your data for Main Street Bar');
  const calendars = within(folders).getByRole('button', { name: 'Calendars, 1 item' });
  expect(calendars.props.accessibilityState).toMatchObject({ expanded: false });
  expect(within(folders).getByRole('button', { name: 'Menus and recipes, 1 item' })).toBeTruthy();
  expect(screen.queryByLabelText('Your data for Main Street Bar')).toBeNull();
  await fireEvent.press(calendars);
  expect(within(folders).getByRole('button', { name: 'Calendars, 1 item' }).props.accessibilityState).toMatchObject({ expanded: true });
  const table = await screen.findByLabelText('Calendars, Your data for Main Street Bar');
  const link = within(table).getByRole('link', { name: 'Kitchen. File, 4 events' });
  await fireEvent.press(screen.getByRole('radio', { name: 'Newest first' }));
  expect(await screen.findByLabelText('Your data for Main Street Bar')).toBeTruthy();
  expect(jest.mocked(SecureStore.setItemAsync).mock.calls).toEqual([['townwise.dataView.u1', 'newest']]);
  await fireEvent.press(within(screen.getByLabelText('Your data for Main Street Bar')).getByRole('link', { name: 'Kitchen. File, 4 events' }));
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1/data/c_fedcba9876543210fedcba98'); });
  expect(link).toBeTruthy();
});

test('a device store that fails reads as Organized', async () => {
  jest.mocked(SecureStore.getItemAsync).mockImplementation(() => Promise.reject(new Error('locked')));
  const { api } = setup();
  await renderApp('/locations/l1/data', api);
  expect(await screen.findByLabelText('Folders, Your data for Main Street Bar')).toBeTruthy();
});
