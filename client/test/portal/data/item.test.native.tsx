jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, screen, within } from 'expo-router/testing-library';

import type { SalesHistory } from '../../../src/portal/analytics/api';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { locationsFake } from '../locations/fakes';
import { dailyTotalsOf, dataFake, itemOf } from './fakes';

// One item of Your data on native (P27, D28): an upload's days, as on web; a stored file is drawn on the web only,
// so the page says where it opens, and reads nothing of it.

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
      itemOf(FILE, { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' }),
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

test('a stored file’s page says it opens on the web, says where to download it, and fetches nothing', async () => {
  const { api, fake } = setup();
  await renderApp(`/locations/l1/data/${FILE}`, api);
  expect(await screen.findByText('Open this file from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.getByText('Download from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
  expect(fake.files.calls.filter((call) => call.path.endsWith('/raw'))).toEqual([]);
});
