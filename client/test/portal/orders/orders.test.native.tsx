jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import type { LiveBoard, OrderLine } from '../../../src/portal/orders/api';
import { ACCESS, fakePortalApi, meOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake } from '../analytics/fakes';
import { noContent, withRoutes, type Routes } from '../team/fixtures';

// P30 Orders on native (design Decisions 2, 6 and 10; the order-board and order-counts specs): one section per supplier
// order, each line's edit and every rule with its own turn-off, "Enter a count" sending only the filled fields, and the
// way to the Ordering setup. Synthetic items only. A quantity that is empty or not a number is never sent (#68 N6).

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 13, 12, 0, 0),
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

const PATH = '/api/org/locations/l1/orders';

function line(fields: Partial<OrderLine> & Pick<OrderLine, 'itemId' | 'name' | 'recommended'>): OrderLine {
  return {
    supplier: 'Sample distributor', unit: 'cases', neverRunOut: false, alternative: null, par: 2, mu: 14, sigma: 3, orderUpTo: 20.2,
    target: 0.95, onHand: 5, countAgeDays: 1, confidence: 'high', dealSize: 6, coveredDays: 56, why: 'Thursday’s delivery lasts until Monday’s.',
    sample: false, edit: null, rules: [], ...fields,
  };
}

const KEG = line({ itemId: 'keg', name: 'Sample keg', supplier: 'Sample brewery', unit: 'kegs', recommended: 1, dealSize: null });
const LAGER = line({
  itemId: 'lager', name: 'Sample lager', recommended: 13,
  rules: [{ id: 'r1', delta: 2, situation: 'a football weekend' }, { id: 'r2', delta: -1, situation: 'slow after the holidays' }],
});
const SELTZER = line({ itemId: 'seltzer', name: 'Sample seltzer', recommended: 6, edit: { quantity: 8, reason: 'A wedding party' } });

const BOARD: LiveBoard = {
  available: true, sample: false, missing: ['a recent count'],
  orders: [
    {
      supplierId: 's1', supplier: 'Sample brewery', cutoff: '2026-11-16', cutoffTime: '12:00', delivery: '2026-11-17', coversThrough: '2026-11-19',
      deadline: 'Order by Mon, Nov 16, 12:00pm. Tuesday’s delivery lasts until Thursday’s.', lines: [KEG],
    },
    {
      supplierId: 's2', supplier: 'Sample distributor', cutoff: '2026-11-18', cutoffTime: '14:00', delivery: '2026-11-19', coversThrough: '2026-11-23',
      deadline: 'Order by Wed, Nov 18, 2:00pm. Thursday’s delivery lasts until Monday’s.', lines: [LAGER, SELTZER],
    },
  ],
};

const UNAVAILABLE = {
  available: false,
  reason: 'Townwise can’t build an order for this location until its ordering setup has a supplier schedule and items.',
  missing: ['the supplier schedule', 'the items'],
};

function portal(board: unknown = BOARD, me = meOf(ACCESS.member)): { api: FakePortalApi; routes: Routes } {
  const api = fakePortalApi({ me, fallback: analyticsFake({ [PATH]: board, [`${PATH}?sample=true`]: { ...BOARD, sample: true } }) });
  const routes = withRoutes(api, { requests: { [`POST ${PATH}/counts`]: noContent, [`POST ${PATH}/rules/off`]: noContent } });
  return { api, routes };
}

function boardReads(api: FakePortalApi): number {
  return api.calls.filter((call) => call.method === 'GET' && call.path === PATH).length;
}

test('one section per supplier order, soonest first, each with its deadline and its lines', async () => {
  const { api } = portal();
  await renderApp('/locations/l1/orders', api);
  const headings = await screen.findAllByRole('heading', { name: /^Sample (brewery|distributor)$/ });
  expect(headings.map((heading) => heading.props.children as string)).toEqual(['Sample brewery', 'Sample distributor']);
  expect(screen.getByText('Order by Mon, Nov 16, 12:00pm. Tuesday’s delivery lasts until Thursday’s.')).toBeTruthy();
  expect(screen.getByText('Order by Wed, Nov 18, 2:00pm. Thursday’s delivery lasts until Monday’s.')).toBeTruthy();
  expect(screen.getByText('Townwise still can’t see a recent count.')).toBeTruthy();
  expect(screen.getByLabelText('Sample brewery order')).toBeTruthy();
  expect(within(screen.getByLabelText('Sample distributor order')).getByText('13 cases')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Explain the Sample distributor order' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Save this line' })).toHaveLength(3);
  expect(writes(api)).toEqual([]);
});

test('each rule is listed on its line with its own turn-off', async () => {
  const { api } = portal();
  await renderApp('/locations/l1/orders', api);
  expect(await screen.findByText('Adds 2 cases to every order: “a football weekend”')).toBeTruthy();
  expect(screen.getByText('Takes 1 case off every order: “slow after the holidays”')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /^Turn this rule off/ })).toHaveLength(2);
  const reads = boardReads(api);
  await fireEvent.press(screen.getByRole('button', { name: 'Turn this rule off: slow after the holidays' }));
  await waitFor(() => { expect(boardReads(api)).toBe(reads + 1); });
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: `${PATH}/rules/off`, body: { ruleId: 'r2' } }]);
});

test('Remember this says the change goes on every later order of the item, and remembers the saved reason', async () => {
  const { api } = portal();
  api.answers[`${PATH}/rules`] = () => ({ rule: { id: 'r3', itemId: 'seltzer', delta: 2, situation: 'A wedding party', off: false } });
  await renderApp('/locations/l1/orders', api);
  expect(await screen.findByText('Remember this adds the same change to every later order of Sample seltzer, until you turn it off.')).toBeTruthy();
  // Only the seltzer has a saved edit that differs from its quantity and no rule for it yet.
  expect(screen.getAllByRole('button', { name: 'Remember this' })).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Remember this' }));
  await waitFor(() => { expect(writes(api)).toHaveLength(1); });
  expect(writes(api)).toEqual([{ method: 'POST', path: `${PATH}/rules`, body: { itemId: 'seltzer', situation: 'A wedding party' } }]);
});

test('a line’s quantity must be a whole number from 0 to 999 and the reason must be given before anything is sent', async () => {
  const { api } = portal();
  api.answers[`${PATH}/decisions`] = (body) => ({ decision: { ...(body as object), recommended: 1 } });
  await renderApp('/locations/l1/orders', api);
  const quantity = await screen.findByLabelText('Quantity for Sample keg');
  const reason = screen.getByLabelText('Reason for Sample keg');
  const save = async (): Promise<void> => {
    const [first] = screen.getAllByRole('button', { name: 'Save this line' });
    if (first === undefined) throw new Error('no Save this line');
    await fireEvent.press(first);
  };
  for (const text of ['', ' ', 'abc', '2.5', '-1', '1000']) {
    await fireEvent.changeText(quantity, text);
    await fireEvent.changeText(reason, 'Homecoming');
    await save();
    expect(screen.getByText('Enter a whole number from 0 to 999.')).toBeTruthy();
  }
  await fireEvent.changeText(quantity, '2');
  await fireEvent.changeText(reason, '   ');
  await save();
  expect(screen.getByText('Say why, in a few words.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  await fireEvent.changeText(reason, ' Homecoming ');
  await save();
  await waitFor(() => { expect(writes(api)).toHaveLength(1); });
  expect(writes(api)).toEqual([
    { method: 'POST', path: `${PATH}/decisions`, body: { itemId: 'keg', delivery: '2026-11-17', quantity: 2, reason: 'Homecoming' } },
  ]);
});

test('Enter a count: a field per item by supplier, empty to start; only the filled fields are sent, as today’s count', async () => {
  const { api } = portal();
  await renderApp('/locations/l1/orders', api);
  await fireEvent.press(await screen.findByRole('button', { name: 'Enter a count' }));
  expect(screen.getByText('Count what is on hand today, Nov 13, 2026, in each item’s unit. Leave an item empty to keep its last count.')).toBeTruthy();
  const keg = screen.getByLabelText('Sample keg, in kegs');
  const lager = screen.getByLabelText('Sample lager, in cases');
  const seltzer = screen.getByLabelText('Sample seltzer, in cases');
  for (const field of [keg, lager, seltzer]) expect(field.props.value).toBe('');

  // Nothing filled, then a number that is not a whole or half unit: nothing is sent.
  await fireEvent.press(screen.getByRole('button', { name: 'Save the count' }));
  expect(screen.getByText('Enter a count for at least one item.')).toBeTruthy();
  await fireEvent.changeText(lager, '3');
  await fireEvent.changeText(seltzer, '1.3');
  await fireEvent.press(screen.getByRole('button', { name: 'Save the count' }));
  expect(screen.getByText('Enter a number from 0 to 9,999, in whole or half units.')).toBeTruthy();
  await fireEvent.changeText(seltzer, 'two');
  await fireEvent.press(screen.getByRole('button', { name: 'Save the count' }));
  expect(screen.getByText('Enter a number from 0 to 9,999, in whole or half units.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  const reads = boardReads(api);
  await fireEvent.changeText(seltzer, ' 2.5 ');
  await fireEvent.press(screen.getByRole('button', { name: 'Save the count' }));
  await waitFor(() => { expect(boardReads(api)).toBe(reads + 1); });
  expect(writes(api)).toEqual([{ method: 'POST', path: `${PATH}/counts`, body: { date: '2026-11-13', items: { lager: 3, seltzer: 2.5 } } }]);
  expect(await screen.findByText('Saved today’s count for 2 items.')).toBeTruthy();
  expect(screen.queryByLabelText('Sample keg, in kegs')).toBeNull();
});

test('no ordering setup: the reason, what is missing, Set up ordering, and the labeled sample with nothing to save', async () => {
  const { api } = portal(UNAVAILABLE);
  const { router } = await renderApp('/locations/l1/orders', api);
  expect(await screen.findByText(UNAVAILABLE.reason)).toBeTruthy();
  expect(screen.getByText('Townwise still needs the supplier schedule and the items.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Preview with a sample bar' }));
  expect(await screen.findByText('Sample bar. These lines are not Main Street Bar’s stock, and nothing here can be saved.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save this line' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Enter a count' })).toBeNull();
  await fireEvent.press(screen.getByRole('link', { name: 'Set up ordering' }));
  expect(router.getPathname()).toBe('/locations/l1/orders/setup');
  expect(await screen.findByRole('heading', { name: 'Ordering setup' })).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('a live board links to its setup', async () => {
  const { api } = portal();
  const { router } = await renderApp('/locations/l1/orders', api);
  await fireEvent.press(await screen.findByRole('link', { name: 'Edit ordering setup' }));
  expect(router.getPathname()).toBe('/locations/l1/orders/setup');
});

test('view-as: the board reads, and every write is disabled in place', async () => {
  const { api } = portal(BOARD, viewAsMe(ACCESS.member));
  await renderApp('/locations/l1/orders', api);
  await screen.findAllByRole('button', { name: 'Save this line' });
  const controls = [
    ...screen.getAllByRole('button', { name: 'Save this line' }),
    ...screen.getAllByRole('button', { name: /^Turn this rule off/ }),
    screen.getByRole('button', { name: 'Remember this' }),
    screen.getByRole('button', { name: 'Enter a count' }),
  ];
  for (const control of controls) expect(control.props.accessibilityState).toMatchObject({ disabled: true });
  expect(writes(api)).toEqual([]);
});
