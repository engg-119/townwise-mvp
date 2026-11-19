jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import type { SalesHistory } from '../../../src/portal/analytics/api';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake } from '../locations/fakes';
import { dailyTotalsOf, dataFake, itemOf } from './fakes';

// One item of Your data on native (P27, D28): an upload's days, as on web, with Turn off and Delete; a stored file is
// drawn on the web only, so the page says where it opens, and reads nothing of it.

afterEach(async () => {
  await cleanup();
});

const UPLOAD = 'u_00000000000000000000000a';
const FILE = 'f_00000000000000000000000b';

const HISTORY: SalesHistory = {
  coverage: { dayCount: 2, guestsDayCount: 2, netSalesDayCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-02', missingDays: 0 },
  days: { date: ['2026-05-01', '2026-05-02'], guests: [50, 60], netSalesCents: [150_000, 180_000], upload: [0, 0] },
  uploads: [{
    id: UPLOAD.slice(2), uploadedAt: '2026-11-05T15:00:00.000Z', uploadedByEmail: 'owner@example.com', status: 'applied', firstDate: '2026-05-01',
    lastDate: '2026-05-02', file: null,
  }],
};

function setup() {
  const fake = dataFake({
    inner: locationsFake(),
    items: [
      dailyTotalsOf(UPLOAD, { days: { count: 2, inUse: 2, firstDate: '2026-05-01', lastDate: '2026-05-02' } }),
      itemOf(FILE, { name: 'menu-notes.txt', state: 'kept', outcome: 'reference', canEdit: true }),
    ],
  });
  fake.history.l1 = HISTORY;
  return { fake, api: fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake }) };
}

test('an upload’s page shows its details and the days it holds', async () => {
  const { api } = setup();
  await renderApp(`/locations/l1/data/${UPLOAD}`, api);
  const table = await screen.findByLabelText('Days in Daily totals, May 1, 2026 to May 2, 2026');
  expect(within(table).getByText('May 1, 2026')).toBeTruthy();
  expect(within(table).getByText('$1,800')).toBeTruthy();
  expect(screen.getByText('Daily totals · No file kept · Sent from a browser')).toBeTruthy();
  expect(screen.getByText('Days: 2 of 2 in use, May 1, 2026 to May 2, 2026')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to Your data' })).toBeTruthy();
});

test('a stored file’s page says it opens on the web, says where to download it, fetches nothing, and offers no edits', async () => {
  const { api, fake } = setup();
  await renderApp(`/locations/l1/data/${FILE}`, api);
  expect(await screen.findByText('Open this file from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.getByText('Download from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^(Rename|Edit)/ })).toBeNull();
  expect(fake.files.calls.filter((call) => call.path.endsWith('/raw'))).toEqual([]);
});

test('native has Turn off and Delete: Turn off acts at once, and a delete goes back to Your data, which says how it ended', async () => {
  const { api, fake } = setup();
  const { router } = await renderApp(`/locations/l1/data/${UPLOAD}`, api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 2, 2026' }));
  expect(await screen.findByText(/^Turned off Daily totals, May 1, 2026 to May 2, 2026\./)).toBeTruthy();
  expect(fake.patches).toEqual([{ ref: UPLOAD, body: { enabled: false } }]);
  await fireEvent.press(screen.getByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 2, 2026' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Delete upload' }));
  await waitFor(() => { expect(router.getPathname()).toBe('/locations/l1/data'); });
  expect(fake.removed).toEqual([{ locationId: 'l1', ref: UPLOAD }]);
  expect(await screen.findByText('Deleted the upload and 5 days.')).toBeTruthy();
});

// D60: a calendar file kept in Your data says what importing it did on native too, with the calendar's page a tap away
// and Try again for a fixable refusal.
test('a calendar file’s page says it was added as a calendar, and Try again re-imports a refused one', async () => {
  const { api, fake } = setup();
  const ADDED = 'f_00000000000000000000000c';
  const REFUSED = 'f_00000000000000000000000d';
  const kept = { kind: 'other', state: 'kept', outcome: 'reference' } as const;
  fake.items.push(
    itemOf(ADDED, { ...kept, name: 'Bookings.ics', calendar: { status: 'added', calendarId: 'c1', label: 'Bookings', eventCount: 2 } }),
    itemOf(REFUSED, { ...kept, name: 'Late.ics', calendar: { status: 'refused', reason: 'calendar_limit', retry: true } }),
  );
  await renderApp(`/locations/l1/data/${ADDED}`, api);
  expect(await screen.findByText('Added to your calendars as Bookings: 2 events.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the calendar' })).toBeTruthy();
  await cleanup();
  await renderApp(`/locations/l1/data/${REFUSED}`, api);
  expect(await screen.findByText('Not added to your calendars: this location already has 5 calendars. Remove one on the Calendar, then try again.')).toBeTruthy();
  const added = itemOf(REFUSED, { ...kept, name: 'Late.ics', calendar: { status: 'added', calendarId: 'c2', label: 'Late', eventCount: 1 } });
  // As the API does, the retry's outcome stays: the page's read after it finds the item added.
  fake.answers['POST calendar'] = () => {
    fake.items = fake.items.map((item) => (item.ref === REFUSED ? added : item));
    return { item: added };
  };
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Added to your calendars as Late: 1 event.')).toBeTruthy();
  expect(fake.calendarRetries).toEqual([REFUSED]);
});
