jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { Dimensions } from 'react-native';
import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import type { MeResponse } from '../../../src/portal/schemas';
import {
  ACCESS, deferred, fakePortalApi, LOCATIONS, meOf, offline, orgOf, refusal, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { daysOf, locationsFake, salesOf, uploadOf, type LocationsFake } from './fakes';

// P12 Sales data on native (spec 16.3, 10.4, D21): no chart, its text summary and the numbers.

afterEach(async () => {
  await cleanup();
});

// 400 calendar days from Jan 1, 2025 to Feb 4, 2026, with no rows on Jan 11 to 13, 2025 and no net sales every
// twentieth day.
const DAYS = daysOf('2025-01-01', 400, (index) => (index >= 10 && index <= 12
  ? null
  : { guests: 50 + (index % 30), netSalesCents: index % 20 === 0 ? null : 150_000 }));
const SALES = salesOf(DAYS, [uploadOf('u2', { status: 'applying', uploadedByEmail: 'gm@example.org', kept: 0 }), uploadOf('u1')]);
const EMPTY_LINE = 'No sales history yet for Main Street Bar. Upload a CSV export from your point-of-sale system. The upload sends Townwise only the date, guest count and net sales for each day.';

function setup(me: MeResponse, sales: unknown = SALES): { api: FakePortalApi; fake: LocationsFake } {
  const fake = locationsFake({ sales: { l1: sales }, days: { l1: DAYS }, notes: { l1: [] } });
  return { api: fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake }), fake };
}

test('loading shows one line', async () => {
  const { api } = setup(meOf(ACCESS.member), deferred<unknown>().promise);
  await renderApp('/locations/l1/sales', api);
  expect(await screen.findByText('Loading sales data')).toBeTruthy();
});

test('coverage, the chart’s text and numbers, by month, and uploads', async () => {
  const { api, fake } = setup(meOf(ACCESS.member));
  await renderApp('/locations/l1/sales', api);
  expect(await screen.findByText('397 days, Jan 1, 2025 to Feb 4, 2026. 3 days missing in between.')).toBeTruthy();
  expect(screen.getByText('Missing days might be closures.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Add a closure note.' })).toBeTruthy();
  expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();
  // The chart covers the last 365 days of data, ending at the last day; native shows its summary.
  expect(fake.dayRanges[0]).toEqual({ locationId: 'l1', from: '2025-02-05', to: '2026-02-04' });
  expect(screen.getByText('Last 365 days of data')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Daily guests' })).toBeTruthy();
  expect(screen.getByText(/^Daily guests, Feb 5, 2025 to Feb 4, 2026\. Highest: 79 guests on .+\. Lowest day with data: 50 guests on .+\.$/)).toBeTruthy();
  expect(screen.getByText('See the chart at townwise.tech.')).toBeTruthy();
  expect(screen.queryByLabelText('Daily guests and net sales, last 365 days of data')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: /Show the numbers/ }));
  const daily = screen.getByLabelText('Daily guests and net sales, last 365 days of data');
  expect(within(daily).getByText('Feb 5, 2025')).toBeTruthy();
  expect(within(daily).getAllByText('No data').length).toBeGreaterThan(0);
  // By month: sums over the days with a value, in whole dollars.
  const months = screen.getByLabelText('Sales by month');
  expect(within(months).getByRole('button', { name: 'Jan 2025' })).toBeTruthy();
  // January 2025: 28 days with rows, 26 of them with net sales of $1,500.
  expect(within(months).getByText('$39,000')).toBeTruthy();
  await fireEvent.press(within(months).getByRole('button', { name: 'Jan 2026' }));
  const january = await screen.findByLabelText('Days in Jan 2026');
  expect(fake.dayRanges.at(-1)).toEqual({ locationId: 'l1', from: '2026-01-01', to: '2026-01-31' });
  expect(within(january).getByText('Jan 31, 2026')).toBeTruthy();
  expect(within(months).getByRole('button', { name: 'Jan 2026' }).props.accessibilityState).toMatchObject({ expanded: true });
  await fireEvent.press(within(months).getByRole('button', { name: 'Jan 2026' }));
  expect(screen.queryByLabelText('Days in Jan 2026')).toBeNull();
  // Uploads and files moved to Your data: P12 keeps one line and a link, and no Uploads table.
  expect(screen.getByRole('heading', { name: 'Uploads and files' })).toBeTruthy();
  expect(screen.getByText('Every upload and file for Main Street Bar is on Your data, where your team can download it, turn it off or delete it.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Your data' })).toBeTruthy();
  expect(screen.queryByLabelText('Uploads')).toBeNull();
  // Members have no Delete sales data section.
  expect(screen.queryByRole('heading', { name: 'Delete sales data' })).toBeNull();
  expect(writes(api)).toEqual([]);
});

test('at 320px By month is one compact table, and a month still opens its days', async () => {
  const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 320 });
  try {
    const { api } = setup(meOf(ACCESS.admin));
    await renderApp('/locations/l1/sales', api);
    await screen.findByLabelText('Sales by month');
    const months = screen.getByLabelText('Sales by month');
    // One header row, not a label per month, and every month keeps its four cells.
    for (const head of ['Month', 'Days', 'Guests', 'Net sales']) expect(within(months).getAllByText(head)).toHaveLength(1);
    expect(within(months).getAllByRole('button')).toHaveLength(SALES.months.length);
    expect(within(months).getByText('$39,000')).toBeTruthy();
    // A screen reader hears each value with its column (January 2025: 26 days of $1,500 net sales).
    expect(within(months).getByLabelText('Net sales: $39,000')).toBeTruthy();
    for (const head of ['Days', 'Guests', 'Net sales']) {
      expect(within(months).getAllByLabelText(new RegExp(`^${head}: \\$?[\\d,]+$`))).toHaveLength(SALES.months.length);
    }
    await fireEvent.press(within(months).getByRole('button', { name: 'Feb 2026' }));
    const february = await screen.findByLabelText('Days in Feb 2026');
    expect(within(february).getAllByText('Guests')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Delete all sales data' })).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});

test('a location with no guest counts charts daily net sales, in dollars', async () => {
  const days = daysOf('2026-01-01', 10, (index) => ({ guests: null, netSalesCents: 100_000 + index * 10_000 }));
  const fake = locationsFake({ sales: { l1: salesOf(days) }, days: { l1: days } });
  await renderApp('/locations/l1/sales', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }));
  expect(await screen.findByRole('heading', { name: 'Daily net sales' })).toBeTruthy();
  expect(screen.getByText('10 days, Jan 1, 2026 to Jan 10, 2026. 0 days missing in between.')).toBeTruthy();
  expect(screen.queryByText('Missing days might be closures.')).toBeNull();
  expect(screen.getByText('Daily net sales, Jan 1, 2026 to Jan 10, 2026. Highest: $1,900 on Jan 10, 2026. Lowest day with data: $1,000 on Jan 1, 2026.')).toBeTruthy();
});

test('Add a closure note opens the note form as a closure; closing it drops the query, so a reload shows the list', async () => {
  const { api } = setup(meOf(ACCESS.member));
  const { router } = await renderApp('/locations/l1/sales', api);
  await fireEvent.press(await screen.findByRole('link', { name: 'Add a closure note.' }));
  expect(router.getPathname()).toBe('/locations/l1/notes');
  expect(await screen.findByRole('heading', { name: 'Add a note' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Closure' }).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByRole('button', { name: 'Closed' }).props.accessibilityState).toMatchObject({ checked: true });
  expect(router.getSearchParams().new).toBe('closure');
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('heading', { name: 'Add a note' })).toBeNull();
  await waitFor(() => { expect(router.getSearchParams().new).toBeUndefined(); });
  expect(screen.queryByRole('heading', { name: 'Add a note' })).toBeNull();
});

test('empty: says what is missing and where to upload; no delete, even for an org admin', async () => {
  const { api } = setup(meOf(ACCESS.admin), salesOf([]));
  await renderApp('/locations/l1/sales', api);
  expect(await screen.findByText(EMPTY_LINE)).toBeTruthy();
  expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Delete sales data' })).toBeNull();
  expect(screen.queryByLabelText('Sales by month')).toBeNull();
});

test('org admins delete all sales data behind the typed name, then see the notice and the empty page', async () => {
  const { api, fake } = setup(meOf(ACCESS.admin));
  api.answers['/api/org/locations/l1/sales'] = () => {
    fake.sales.l1 = salesOf([]);
    return { deletedDays: 397, deletedUploads: 2 };
  };
  await renderApp('/locations/l1/sales', api);
  expect(await screen.findByRole('heading', { name: 'Delete sales data' })).toBeTruthy();
  expect(screen.getByText('Admins only')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Delete all sales data' }));
  expect(screen.getByText('This deletes 397 days of sales data for Main Street Bar, any days turned off on its Your data page, and every file on that page. Notes stay. This can’t be undone.')).toBeTruthy();
  const confirm = (): ReturnType<typeof screen.getByRole> => {
    const button = screen.getAllByRole('button', { name: 'Delete all sales data' }).at(-1);
    if (button === undefined) throw new Error('no dialog');
    return button;
  };
  expect(confirm().props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(confirm());
  expect(writes(api)).toEqual([]);
  await fireEvent.changeText(screen.getByLabelText('Type Main Street Bar to confirm.'), 'Main Street Bar');
  await fireEvent.press(confirm());
  expect(await screen.findByText('Deleted 397 days.')).toBeTruthy();
  expect(await screen.findByText(EMPTY_LINE)).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'DELETE', path: '/api/org/locations/l1/sales', body: undefined }]);
});

test('a failed delete keeps the dialog open with the shared copy', async () => {
  const { api } = setup(meOf(ACCESS.admin));
  api.answers['/api/org/locations/l1/sales'] = () => offline();
  await renderApp('/locations/l1/sales', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Delete all sales data' }));
  await fireEvent.changeText(screen.getByLabelText('Type Main Street Bar to confirm.'), 'Main Street Bar');
  const confirm = screen.getAllByRole('button', { name: 'Delete all sales data' }).at(-1);
  if (confirm === undefined) throw new Error('no dialog');
  await fireEvent.press(confirm);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  expect(screen.getByText('This deletes 397 days of sales data for Main Street Bar, any days turned off on its Your data page, and every file on that page. Notes stay. This can’t be undone.')).toBeTruthy();
  // Opened again, the dialog starts without the earlier error.
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Delete all sales data' }));
  expect(screen.getByLabelText('Type Main Street Bar to confirm.')).toBeTruthy();
  expect(screen.queryByText('Can’t reach Townwise. Check your connection and try again.')).toBeNull();
});

test('a delete after another admin deleted the location closes the dialog and says it isn’t available', async () => {
  const { api } = setup(meOf(ACCESS.admin));
  api.answers['/api/org/locations/l1/sales'] = () => {
    api.org = orgOf('org_admin', LOCATIONS.filter((location) => location.id !== 'l1'));
    return refusal(404, 'not_found');
  };
  await renderApp('/locations/l1/sales', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Delete all sales data' }));
  await fireEvent.changeText(screen.getByLabelText('Type Main Street Bar to confirm.'), 'Main Street Bar');
  const confirm = screen.getAllByRole('button', { name: 'Delete all sales data' }).at(-1);
  if (confirm === undefined) throw new Error('no dialog');
  await fireEvent.press(confirm);
  expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
  expect(screen.queryByLabelText('Type Main Street Bar to confirm.')).toBeNull();
  expect(screen.queryByText('Something went wrong with that request. Reload the page and try again.')).toBeNull();
  expect(screen.getAllByRole('link', { name: 'Locations' }).length).toBeGreaterThan(0);
});

test('errors: the shared copy with Try again; an unknown location is not available', async () => {
  const { api, fake } = setup(meOf(ACCESS.member), offline());
  await renderApp('/locations/l1/sales', api);
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  fake.sales.l1 = refusal(404, 'not_found');
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
});

test('view-as: Delete and the closure-note link are disabled in place, with the read-only line', async () => {
  const { api } = setup(viewAsMe(ACCESS.admin));
  const { router } = await renderApp('/locations/l1/sales', api);
  expect(await screen.findByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
  const closure = screen.getByRole('button', { name: 'Add a closure note.' });
  expect(closure.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(closure);
  expect(router.getPathname()).toBe('/locations/l1/sales');
  const remove = screen.getByRole('button', { name: 'Delete all sales data' });
  expect(remove.props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(remove);
  await waitFor(() => { expect(screen.queryByLabelText('Type Main Street Bar to confirm.')).toBeNull(); });
  expect(writes(api)).toEqual([]);
});
