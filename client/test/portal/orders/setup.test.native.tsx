jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import type { OrderSetupAnswer } from '../../../src/portal/orders/api';
import { ACCESS, fakePortalApi, meOf, offline, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake } from '../analytics/fakes';

// P31 Ordering setup on native: the same editor as the web, saved over the version it loaded, without the template,
// the sheet import or the item sales upload, which read files (web only). Synthetic supplier and item.

afterEach(async () => {
  await cleanup();
});

const PATH = '/api/org/locations/l1/orders';
const SUPPLIER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const ITEM_ID = 'bbbbbbbbbbbbbbbbbbbbbbb1';

const ANSWER: OrderSetupAnswer = {
  setup: {
    version: 2,
    updatedAt: '2026-11-10T15:00:00.000Z',
    suppliers: [{ id: SUPPLIER_ID, name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
    items: [{
      id: ITEM_ID, name: 'Sample Lager', supplierId: SUPPLIER_ID, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 2,
      dealSize: null, neverRunOut: false, posNames: [{ name: 'Lager Can', perSale: 1 }],
    }],
  },
  coverage: null,
  itemCoverage: { [ITEM_ID]: 0 },
  counts: {},
};

function portal(answer: unknown = ANSWER, me = meOf(ACCESS.member)): FakePortalApi {
  const api = fakePortalApi({ me, fallback: analyticsFake({ [`${PATH}/setup`]: answer }) });
  api.answers[`${PATH}/setup`] = (body) => ({ setup: { ...ANSWER.setup, version: 3, items: (body as { setup: { items: unknown[] } }).setup.items } });
  return api;
}

test('native edits and saves the setup, and says to use a computer for the template, the import and item sales', async () => {
  const api = portal();
  await renderApp('/locations/l1/orders/setup', api);
  expect(await screen.findByText('Use a computer to download the template, import a sheet or upload item sales.')).toBeTruthy();
  expect(screen.getByText('No item sales yet.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Import a sheet' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Choose an item sales file' })).toBeNull();
  // No item sales stored: no “No sales matched” line yet.
  expect(screen.queryByText(/No sales matched/)).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('Par'), '5');
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Save the setup' }));
  await waitFor(() => { expect(writes(api)).toHaveLength(1); });
  const [put] = writes(api);
  expect(put?.method).toBe('PUT');
  expect(put?.body).toMatchObject({ expectedVersion: 2, setup: { items: [{ id: ITEM_ID, par: 5 }] } });
  expect(await screen.findByText('Saved the ordering setup.')).toBeTruthy();
});

test('a failed read says so with Try again; view-as disables Save', async () => {
  await renderApp('/locations/l1/orders/setup', portal(offline()));
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  await cleanup();

  const api = portal(ANSWER, viewAsMe(ACCESS.member));
  await renderApp('/locations/l1/orders/setup', api);
  const save = await screen.findByRole('button', { name: 'Save the setup' });
  expect(save.props.accessibilityState).toMatchObject({ disabled: true });
  expect(screen.getByRole('button', { name: 'Add an item' }).props.accessibilityState).toMatchObject({ disabled: true });
  expect(writes(api)).toEqual([]);
});
