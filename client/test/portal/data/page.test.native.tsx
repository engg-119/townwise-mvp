jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { daysOf, locationsFake, salesOf, uploadOf } from '../locations/fakes';
import { dailyTotalsOf, dataFake, itemOf } from './fakes';

// Your data on native (P26, D28): the same rows, Turn off and Delete; downloads, Add a file and Paste text are web
// only, so it says where to go instead.

afterEach(async () => {
  await cleanup();
});

const DAYS = daysOf('2025-01-01', 30, () => ({ guests: 50, netSalesCents: 150_000 }));

function setup() {
  const inner = locationsFake({ sales: { l1: salesOf(DAYS, [uploadOf('u1')]) }, days: { l1: DAYS } });
  const fake = dataFake({
    inner,
    items: [itemOf('f_ref', { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' }), dailyTotalsOf('u_1')],
  });
  return { fake, api: fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake }) };
}

test('native lists the same rows, offers Turn off and Delete, and says Download from a computer at townwise.tech. in place of downloads', async () => {
  const { api, fake } = setup();
  await renderApp('/locations/l1/data', api);
  const list = await screen.findByLabelText('Your data for Main Street Bar');
  expect(within(list).getByText('menu-notes.txt')).toBeTruthy();
  expect(within(list).getByText('Kept for reference')).toBeTruthy();
  expect(within(list).getByText('5 of 10 in use, May 1, 2026 to May 10, 2026')).toBeTruthy();
  expect(within(list).getByText('No file kept')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn off: menu-notes.txt' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete: menu-notes.txt' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 10, 2026' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
  expect(screen.getByText('Download from a computer at townwise.tech.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
  expect(await screen.findByText(/^Turned off Daily totals, May 1, 2026 to May 10, 2026\./)).toBeTruthy();
  expect(fake.patches).toEqual([{ ref: 'u_1', body: { enabled: false } }]);
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
