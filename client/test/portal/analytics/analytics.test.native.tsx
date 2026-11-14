jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
// Every function of the secure store is a mock, so the test can say none was called.
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import * as SecureStore from 'expo-secure-store';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { MONTH_ROWS_LINE } from '../../../src/portal/analytics/cells';
import { PANEL_EMPTY } from '../../../src/portal/analytics/panel';
import type { MeResponse } from '../../../src/portal/schemas';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake, calendarBody, day, historyBody, holiday, note, run, upload } from './fakes';

// P24 Analytics on native (home.md 4.4, D21): no grid and no SVG; a month list, newest first, whose days open the
// Day panel under their row, with every section's summary, basis line and numbers. Synthetic days only. The page
// stores nothing (P) and its copy is honest when the data is thin (T).

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 5, 12, 0, 0),
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

const PATH = '/api/org/locations/l1';
const DAYS = run('2025-09-01', '2026-11-04', (date) => 100 + (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 40 : 0));

/** `rules` answers GET .../rules; null leaves it unanswered (a 404), which Analytics reads as no rules. */
function portal(me: MeResponse, days = DAYS, uploads = [upload()], uploadsOff = false, rules: unknown[] | null = null): FakePortalApi {
  const from = days[0]?.date.slice(0, 4) ?? '2026';
  const fake = analyticsFake({
    ...(rules === null ? {} : { [`${PATH}/rules`]: { rules, limit: 30 } }),
    [`${PATH}/sales/history`]: { ...historyBody(days, uploads), uploadsOff },
    [`${PATH}/notes`]: { notes: [note({ startDate: '2026-10-10', detail: 'A rehearsal dinner.' })] },
    [`${PATH}/calendar?from=${from}-01-01&to=2026-12-31`]: calendarBody({ events: [holiday('2025-11-27', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving')] }),
  });
  return fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake });
}

test('a month list, newest first; a month opens its days, and a day opens the Day panel under its row', async () => {
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member)));
  expect(await screen.findByText('430 days, Sep 1, 2025 to Nov 4, 2026.')).toBeTruthy();
  const months = screen.getByLabelText('Months, daily guests');
  const rows = within(months).getAllByRole('button');
  expect(rows[0]?.props.accessibilityLabel).toBe('Nov 2026, 4 days with data, 100 guests on average');
  expect(rows.at(-1)?.props.accessibilityLabel).toMatch(/^Sep 2025, 30 days with data, /);
  // On native the Day panel shows only under a selected day's row.
  expect(screen.queryByText(PANEL_EMPTY)).toBeNull();
  await fireEvent.press(within(months).getByRole('button', { name: /^Oct 2026,/ }));
  const days = screen.getByLabelText('Days in Oct 2026');
  const saturday = within(days).getByRole('button', { name: 'Sat, Oct 10, 2026. 140 guests, $2,800. 1 note.' });
  expect(within(days).getByText('140, Your note')).toBeTruthy();
  await fireEvent.press(saturday);
  expect(screen.getByRole('heading', { name: 'Saturday, Oct 10, 2026' })).toBeTruthy();
  expect(screen.getByText('A rehearsal dinner.')).toBeTruthy();
  expect(screen.getByText('From the upload on Nov 4, 2026 by owner@example.com.')).toBeTruthy();
  // Next day moves the selection, and the panel follows it.
  await fireEvent.press(screen.getByRole('button', { name: 'Next day' }));
  expect(screen.getByRole('heading', { name: 'Sunday, Oct 11, 2026' })).toBeTruthy();
  // No SVG on native: the summaries, basis lines and tables carry the numbers.
  expect(screen.getByText('Your busiest day is Saturday, 140 guests on average; your quietest is Monday, 100.')).toBeTruthy();
  expect(screen.getAllByText(/^Based on 430 days with a guest count\.$/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/^Scale 0 to/)).toBeNull();
});

test('the filters change the numbers and the basis line, and nothing is stored', async () => {
  await renderApp('/locations/l1/analytics', portal(viewAsMe(ACCESS.member)));
  await screen.findByLabelText('Months, daily guests');
  const store = Object.values(SecureStore).filter((value) => jest.isMockFunction(value));
  for (const fn of store) fn.mockClear();
  expect(screen.getAllByText('Based on 430 days with a guest count.').length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByRole('checkbox', { name: 'Days with a note' }));
  expect(screen.getAllByText('Based on 429 days with a guest count. Leaves out 1 day with a note.').length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByRole('checkbox', { name: '2025' }));
  expect(screen.getAllByText(/^Based on 307 days with a guest count\. Leaves out 1 day with a note\. Only 2026\.$/).length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByRole('checkbox', { name: '2026' }));
  expect(screen.getByRole('checkbox', { name: '2026' }).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByText('Keep at least one year.')).toBeTruthy();
  expect(store).toContain(SecureStore.setItemAsync);
  for (const fn of store) expect(fn).not.toHaveBeenCalled();
});

test('thin and empty states say what is missing', async () => {
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), [day('2026-11-04', 90)]));
  expect(await screen.findByText(/^Year over year needs at least one full year before this one\. You have 1 month so far\./)).toBeTruthy();
  expect(screen.getByText('Townwise needs each kind of day to happen at least twice before it can say how much it moves your numbers.')).toBeTruthy();
  expect(screen.getByText('Regular nights: 1 night. Not enough nights yet.')).toBeTruthy();
  await cleanup();

  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), []));
  expect(await screen.findByText('No sales history yet.')).toBeTruthy();
  expect(screen.getByText('Upload from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Closed days' }).props.accessibilityState).toMatchObject({ disabled: true });
});

test('every upload turned off: says so and points to Your data, with no upload prompt', async () => {
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), [], [], true));
  expect(await screen.findByText('Every sales upload for this location is turned off. Turn one back on in Your data to see its days.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Your data' })).toBeTruthy();
  expect(screen.queryByText('No sales history yet.')).toBeNull();
  expect(screen.queryByText('Upload from a computer at townwise.tech.')).toBeNull();
});

// A seasonal closure: no rows in Jan 2026, and Christmas 2025 all zero (a closed day the filters leave out).
const SEASONAL = run('2025-09-01', '2026-11-04', (date) => {
  if (date.startsWith('2026-01')) return null;
  return date === '2025-12-25' ? 0 : 100;
});

test('Previous day and Next day stay on days the month list shows, skipping a month with no rows', async () => {
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), SEASONAL));
  const months = await screen.findByLabelText('Months, daily guests');
  expect(within(months).queryByRole('button', { name: /^Jan 2026,/ })).toBeNull();
  await fireEvent.press(within(months).getByRole('button', { name: /^Dec 2025,/ }));
  await fireEvent.press(within(screen.getByLabelText('Days in Dec 2025')).getByRole('button', { name: /^Wed, Dec 31, 2025\./ }));
  expect(screen.getByRole('heading', { name: 'Wednesday, Dec 31, 2025' })).toBeTruthy();
  // Next day jumps over January, which has no row, and the panel follows under Feb 1.
  await fireEvent.press(screen.getByRole('button', { name: 'Next day' }));
  expect(screen.getByRole('heading', { name: 'Sunday, Feb 1, 2026' })).toBeTruthy();
  expect(screen.getByLabelText('Days in Feb 2026')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Previous day' }));
  expect(screen.getByRole('heading', { name: 'Wednesday, Dec 31, 2025' })).toBeTruthy();
  // On the first day of data there is no earlier row, so Previous day is off and the panel stays.
  await fireEvent.press(within(months).getByRole('button', { name: /^Sep 2025,/ }));
  await fireEvent.press(within(screen.getByLabelText('Days in Sep 2025')).getByRole('button', { name: /^Mon, Sep 1, 2025\./ }));
  expect(screen.getByRole('heading', { name: 'Monday, Sep 1, 2025' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Previous day' }).props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(screen.getByRole('button', { name: 'Previous day' }));
  expect(screen.getByRole('heading', { name: 'Monday, Sep 1, 2025' })).toBeTruthy();
});

test('the month rows say they count the days the filters leave out (T)', async () => {
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), SEASONAL));
  const months = await screen.findByLabelText('Months, daily guests');
  // Dec 2025 counts its closed zero day in the month's average, while the basis line leaves it out.
  expect(within(months).getByRole('button', { name: /^Dec 2025,/ }).props.accessibilityLabel).toBe('Dec 2025, 31 days with data, 97 guests on average');
  expect(screen.getAllByText('Based on 398 days with a guest count. Leaves out 1 closed day.').length).toBeGreaterThan(0);
  expect(screen.getByText(MONTH_ROWS_LINE)).toBeTruthy();
});

test('F4 on native: the stored file by name and kind, and Your data, with no download here', async () => {
  const file = { id: '00000000-0000-0000-0000-00000000f001', name: 'sample-sales.csv', kind: 'text' as const };
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), DAYS, [upload({ file })]));
  const months = await screen.findByLabelText('Months, daily guests');
  await fireEvent.press(within(months).getByRole('button', { name: /^Oct 2026,/ }));
  await fireEvent.press(within(screen.getByLabelText('Days in Oct 2026')).getByRole('button', { name: /^Sat, Oct 10, 2026\./ }));
  expect(screen.getByText('File: sample-sales.csv (CSV or text file).')).toBeTruthy();
  expect(screen.getByText('Download from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Download cleaned CSV' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Your data' })).toBeTruthy();
});

test('a likely-closed day (spec D32) reads “Likely closed” in the month’s day list, not “Closed”', async () => {
  // Saturdays at 100 guests, then Oct 31 with 1 guest: under a tenth of its weekday's typical, so likely closed.
  const days = run('2026-09-05', '2026-11-04', (date) => (date === '2026-10-31' ? 1 : 100));
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), days));
  await fireEvent.press(within(await screen.findByLabelText('Months, daily guests')).getByRole('button', { name: /^Oct 2026,/ }));
  const list = screen.getByLabelText('Days in Oct 2026');
  // The default filters leave closed days out of the numbers, so it is also Left out.
  expect(within(list).getByText('1, Likely closed, Left out')).toBeTruthy();
  expect(within(list).queryByText('1, Closed, Left out')).toBeNull();
});

test('today’s partial upload with 1 guest is not “Likely closed”, though the same day a week earlier would be', async () => {
  // Today is Thu Nov 5, 2026 (fake clock). Thursdays run at 100 guests; today's row is a partial upload with 1 guest.
  const days = run('2026-09-05', '2026-11-05', (date) => (date === '2026-11-05' || date === '2026-10-29' ? 1 : 100));
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), days));
  await fireEvent.press(within(await screen.findByLabelText('Months, daily guests')).getByRole('button', { name: /^Oct 2026,/ }));
  expect(within(screen.getByLabelText('Days in Oct 2026')).getByText('1, Likely closed, Left out')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /^Nov 2026,/ }));
  const nov = screen.getByLabelText('Days in Nov 2026');
  expect(within(nov).getAllByText('1').length).toBeGreaterThan(0);
  expect(within(nov).queryByText(/Likely closed/)).toBeNull();
});

test('a business rule whose schedule says more guests marks a near-empty day open (D31 with D32), as a note does', async () => {
  const days = run('2026-09-05', '2026-11-04', (date) => (date === '2026-10-31' ? 1 : 100));
  const rule = {
    id: 'r1', text: 'Halloween party night', addedVia: 'page', createdByEmail: EMAIL, createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z', canEdit: true, scheduleSummary: 'More guests on Oct 31, 2026',
    schedule: { kind: 'other', startDate: '2026-10-31', endDate: '2026-10-31', weekdays: null, effect: 'more_guests', expectedGuests: null, startTime: null, endTime: null },
  };
  await renderApp('/locations/l1/analytics', portal(meOf(ACCESS.member), days, [upload()], false, [rule]));
  await fireEvent.press(within(await screen.findByLabelText('Months, daily guests')).getByRole('button', { name: /^Oct 2026,/ }));
  const list = screen.getByLabelText('Days in Oct 2026');
  // Open, so it is in the numbers: no Likely closed, and not Left out.
  expect(await within(list).findByText('1')).toBeTruthy();
  expect(within(list).queryByText(/Likely closed/)).toBeNull();
});
