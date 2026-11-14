import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { OrderSetup, OrderSetupAnswer } from '../../../src/portal/orders/api';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { choose, choicesOf } from '../../helpers/select';
import { analyticsFake } from '../analytics/fakes';

// P31 Ordering setup on the web, through the whole app (the order-setup and item-sales specs): the page drawn from
// GET .../orders/setup, a save over the version it loaded, the 409 reload offer, view-as, the sheet import, and the
// item sales upload, whose request holds item ids, dates and servings only. Every supplier, item and name here is
// synthetic; a sentinel name sits in the uploaded file and must never reach a request.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

// Each test draws the whole app with a setup of many fields; under a loaded machine that takes longer than jest's 5 s.
jest.setTimeout(20_000);

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 13, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const ROUTE = '/locations/l1/orders/setup';
const PATH = '/api/org/locations/l1/orders';
const SUPPLIER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const LAGER_ID = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const IPA_ID = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const SENTINEL = 'Zelda Sentinel Party Package';

const SETUP: OrderSetup = {
  version: 3,
  updatedAt: '2026-11-10T15:00:00.000Z',
  suppliers: [{ id: SUPPLIER_ID, name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
  items: [
    {
      id: LAGER_ID, name: 'Sample Lager', supplierId: SUPPLIER_ID, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 2,
      dealSize: 5, neverRunOut: false, posNames: [{ name: 'Lager Can', perSale: 1 }],
    },
    {
      id: IPA_ID, name: 'Sample IPA', supplierId: SUPPLIER_ID, category: 'draft', unit: 'kegs', servingsPerUnit: 124, par: 1,
      dealSize: null, neverRunOut: true, posNames: [{ name: 'IPA Pint', perSale: 1 }, { name: 'IPA Pitcher', perSale: 4 }],
    },
  ],
};

const ANSWER: OrderSetupAnswer = {
  setup: SETUP,
  coverage: { firstDate: '2026-10-01', lastDate: '2026-10-31', dayCount: 31 },
  itemCoverage: { [LAGER_ID]: 20, [IPA_ID]: 0 },
  counts: { [LAGER_ID]: { quantity: 3, date: '2026-11-10' } },
};

/** The saved setup as the server answers a PUT: the sent rows, new ones with minted ids, at `version`. */
function stored(body: unknown, version: number): { setup: OrderSetup } {
  interface Sent {
    suppliers: (Omit<OrderSetup['suppliers'][number], 'id'> & { id?: string; key?: string })[];
    items: (Omit<OrderSetup['items'][number], 'id'> & { id?: string })[];
  }
  const { setup } = body as { setup: Sent };
  const ids = new Map<string, string>();
  const suppliers = setup.suppliers.map(({ key, id, ...rest }, index) => {
    const minted = id ?? `ccccccccccccccccccccccc${String(index)}`;
    ids.set(key ?? minted, minted);
    return { ...rest, id: minted };
  });
  const items = setup.items.map(({ id, ...rest }, index) => ({
    ...rest, id: id ?? `ddddddddddddddddddddddd${String(index)}`, supplierId: ids.get(rest.supplierId) ?? rest.supplierId,
  }));
  return { setup: { version, updatedAt: '2026-11-13T17:00:00.000Z', suppliers, items } };
}

function portal(options: { answer?: OrderSetupAnswer; me?: ReturnType<typeof meOf>; role?: 'member' | 'org_admin' } = {}): { api: FakePortalApi; gets: Record<string, unknown> } {
  const gets: Record<string, unknown> = { [`${PATH}/setup`]: options.answer ?? ANSWER };
  const api = fakePortalApi({ me: options.me ?? meOf(ACCESS.member), org: orgOf(options.role ?? 'member'), fallback: analyticsFake(gets) });
  return { api, gets };
}

function renderAt(api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', ROUTE);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={ROUTE} />
    </Head.Provider>,
  );
}

async function settle(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

function click(name: string, within_: HTMLElement = document.body): Promise<void> {
  return settle(() => { fireEvent.click(within(within_).getByRole('button', { name })); });
}

function type(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

function textFile(text: string, name: string): File {
  const file = new File([text], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  return file;
}

async function pick(testId: string, file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(`input[data-testid="${testId}"]`);
  if (input === null) throw new Error(`no ${testId} input`);
  await settle(() => { fireEvent.change(input, { target: { files: [file] } }); });
  await settle(() => undefined);
}

function puts(api: FakePortalApi): unknown[] {
  return writes(api).filter((call) => call.method === 'PUT').map((call) => call.body);
}

test('the page draws the GET answer: coverage, suppliers, items, each item’s count and whether sales matched it', async () => {
  const { api } = portal();
  renderAt(api);
  expect(await screen.findByText('Item sales cover Oct 1, 2026 to Oct 31, 2026, 31 days in all.')).toBeTruthy();
  const supplier = region('Supplier 1');
  expect(within(supplier).getByRole('textbox', { name: 'Supplier name' })).toHaveProperty('value', 'Sample Distributor');
  expect(within(supplier).getByRole('textbox', { name: 'Order by time' })).toHaveProperty('value', '14:00');
  expect(within(supplier).getByRole('combobox', { name: 'Delivery day' }).textContent).toBe('Thursday');
  const lager = region('Item 1');
  expect(within(lager).getByRole('textbox', { name: 'Item name' })).toHaveProperty('value', 'Sample Lager');
  expect(within(lager).getByRole('combobox', { name: 'Category' }).textContent).toBe('Bottles and cans');
  expect(within(lager).getByText('Last count: 3 cases on Nov 10, 2026.')).toBeTruthy();
  expect(within(lager).getByText('Sales matched on 20 days in the last 8 weeks.')).toBeTruthy();
  const ipa = region('Item 2');
  expect(within(ipa).getByText('No sales matched in the last 8 weeks. Check its point-of-sale names.')).toBeTruthy();
  expect(within(ipa).getByText('No count in the last 90 days.')).toBeTruthy();
  expect(within(ipa).getAllByRole('textbox', { name: 'Point-of-sale name' }).map((field) => (field as HTMLInputElement).value)).toEqual(['IPA Pint', 'IPA Pitcher']);
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Download the template' })).toBeTruthy();
  // A member doesn't delete item sales.
  expect(screen.queryByRole('button', { name: 'Delete item sales' })).toBeNull();
  expect(writes(api)).toEqual([]);
});

test('an edit shows as unsaved; Save sends the whole setup over the version it loaded, then over the saved one', async () => {
  const { api } = portal();
  api.answers[`${PATH}/setup`] = (body) => stored(body, (body as { expectedVersion: number }).expectedVersion + 1);
  renderAt(api);
  const lager = await screen.findByRole('region', { name: 'Item 1' });
  type(within(lager).getByRole('textbox', { name: 'Par' }), '4');
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  expect(screen.getByText('You have unsaved changes. Save the setup below.')).toBeTruthy();
  await click('Save the setup');
  await waitFor(() => { expect(puts(api)).toHaveLength(1); });
  expect(puts(api)[0]).toEqual({
    expectedVersion: 3,
    setup: {
      suppliers: [{ id: SUPPLIER_ID, name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
      items: [
        { ...SETUP.items[0], par: 4 },
        SETUP.items[1],
      ],
    },
  });
  expect(await screen.findByText('Saved the ordering setup.')).toBeTruthy();
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
  type(within(region('Item 1')).getByRole('textbox', { name: 'Par' }), '5');
  await click('Save the setup');
  await waitFor(() => { expect(puts(api)).toHaveLength(2); });
  expect((puts(api)[1] as { expectedVersion: number }).expectedVersion).toBe(4);
});

test('a new supplier goes with a key, and a new item names it by that key', async () => {
  const { api } = portal();
  api.answers[`${PATH}/setup`] = (body) => stored(body, 4);
  renderAt(api);
  await screen.findByRole('region', { name: 'Item 1' });
  await click('Add a supplier');
  const added = region('Supplier 2');
  type(within(added).getByRole('textbox', { name: 'Supplier name' }), 'Sample Brewery');
  choose(within(added).getByRole('combobox', { name: 'Delivery day' }), 'Tuesday');
  choose(within(added).getByRole('combobox', { name: 'Order by day' }), 'Monday');
  type(within(added).getByRole('textbox', { name: 'Order by time' }), '9:30');
  await click('Add an item');
  const item = region('Item 3');
  type(within(item).getByRole('textbox', { name: 'Item name' }), 'Sample Stout');
  expect(choicesOf(within(item).getByRole('combobox', { name: 'Supplier' }))).toEqual(['Choose a supplier', 'Sample Distributor', 'Sample Brewery']);
  choose(within(item).getByRole('combobox', { name: 'Supplier' }), 'Sample Brewery');
  choose(within(item).getByRole('combobox', { name: 'Category' }), 'Draft');
  choose(within(item).getByRole('combobox', { name: 'Unit' }), 'kegs');
  type(within(item).getByRole('textbox', { name: 'Servings per unit' }), '124');
  type(within(item).getByRole('textbox', { name: 'Par' }), '1');
  await click('Add a point-of-sale name', item);
  type(within(item).getByRole('textbox', { name: 'Point-of-sale name' }), 'Stout Pint');
  await click('Save the setup');
  await waitFor(() => { expect(puts(api)).toHaveLength(1); });
  const second = puts(api)[0] as { expectedVersion: number; setup: { suppliers: { key?: string }[]; items: { supplierId: string }[] } };
  expect(second.expectedVersion).toBe(3);
  const key = second.setup.suppliers[1]?.key ?? '';
  expect(second.setup.suppliers[1]).toEqual({ key, name: 'Sample Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '09:30' }] });
  expect(second.setup.items[2]).toEqual({
    name: 'Sample Stout', supplierId: key, category: 'draft', unit: 'kegs', servingsPerUnit: 124, par: 1, dealSize: null, neverRunOut: false,
    posNames: [{ name: 'Stout Pint', perSale: 1 }],
  });
});

test('a field that fails a check is marked and nothing is sent', async () => {
  const { api } = portal();
  renderAt(api);
  const supplier = await screen.findByRole('region', { name: 'Supplier 1' });
  type(within(supplier).getByRole('textbox', { name: 'Supplier name' }), ' ');
  type(within(region('Item 2')).getByRole('textbox', { name: 'Servings per unit' }), 'lots');
  await click('Save the setup');
  expect(screen.getByText('Fix the 2 marked fields before saving.')).toBeTruthy();
  expect(within(supplier).getByText('Enter a name of up to 60 characters.')).toBeTruthy();
  expect(within(region('Item 2')).getByText('Enter a number above 0, up to 2,000.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
});

test('409 setup_changed says someone else changed it and offers their changes, which replace the draft after a confirm', async () => {
  const { api, gets } = portal();
  api.answers[`${PATH}/setup`] = () => refusal(409, 'setup_changed');
  renderAt(api);
  const lager = await screen.findByRole('region', { name: 'Item 1' });
  type(within(lager).getByRole('textbox', { name: 'Par' }), '4');
  await click('Save the setup');
  expect(await screen.findByText('Someone else changed this setup since you opened it. Load their changes to see them; your unsaved changes here will be lost.')).toBeTruthy();
  gets[`${PATH}/setup`] = { ...ANSWER, setup: { ...SETUP, version: 5, items: [{ ...SETUP.items[0], par: 9 }, SETUP.items[1]] } };
  await click('Load their changes');
  const dialog = await screen.findByRole('dialog', { name: 'Load their changes' });
  expect(within(dialog).getByText('This replaces your unsaved changes here with the setup as it was last saved.')).toBeTruthy();
  await click('Load their changes', dialog);
  await waitFor(() => { expect(within(region('Item 1')).getByRole('textbox', { name: 'Par' })).toHaveProperty('value', '9'); });
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
  api.answers[`${PATH}/setup`] = (body) => stored(body, 6);
  await click('Save the setup');
  await waitFor(() => { expect(puts(api)).toHaveLength(2); });
  expect((puts(api)[1] as { expectedVersion: number }).expectedVersion).toBe(5);
});

test('view-as: the setup reads, every field is read-only and every write disabled; no file control is drawn', async () => {
  const { api } = portal({ me: viewAsMe(ACCESS.member) });
  renderAt(api);
  const lager = await screen.findByRole('region', { name: 'Item 1' });
  expect(screen.getByText(/^Read-only while viewing as /)).toBeTruthy();
  expect(within(lager).getByRole('textbox', { name: 'Par' }).getAttribute('aria-readonly')).toBe('true');
  expect(within(lager).getByRole('combobox', { name: 'Category' }).getAttribute('aria-disabled')).toBe('true');
  for (const name of ['Save the setup', 'Import a sheet', 'Add an item', 'Add a supplier', 'Choose an item sales file']) {
    expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true');
  }
  expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  await click('Save the setup');
  expect(writes(api)).toEqual([]);
});

test('import a sheet: rows merge by name into the draft, new suppliers are added, failing rows are listed, nothing saves', async () => {
  const { api } = portal();
  renderAt(api);
  await screen.findByRole('region', { name: 'Item 1' });
  const sheet = [
    'Item,Supplier,Category,Unit,Servings per unit,Par,Deal size,Never run out,Point-of-sale names',
    'Sample Lager,Sample Distributor,Bottles and cans,cases,24,6,5,no,Lager Can;Lager Bucket x5',
    'Sample Gin,Sample Spirits,Liquor,bottles,17,2,,yes,Gin Pour',
    'Bad Row,Sample Spirits,Wine,cases,24,1,,no,',
  ].join('\n');
  await pick('sheet-file', textFile(sheet, 'items.csv'));
  expect(await screen.findByText('Imported 2 items: 1 new, 1 replaced by name. Nothing is saved yet: check them below, then save the setup.')).toBeTruthy();
  expect(screen.getByText('Add the delivery days of the new suppliers: Sample Spirits.')).toBeTruthy();
  expect(screen.getByText('Row 4, Bad Row: Category: use Bottles and cans, Draft, Liquor or Cocktail ingredient.')).toBeTruthy();
  expect(within(region('Item 1')).getByRole('textbox', { name: 'Par' })).toHaveProperty('value', '6');
  expect(within(region('Item 3')).getByRole('textbox', { name: 'Item name' })).toHaveProperty('value', 'Sample Gin');
  expect(within(region('Supplier 2')).getByRole('textbox', { name: 'Supplier name' })).toHaveProperty('value', 'Sample Spirits');
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  expect(writes(api)).toEqual([]);

  await pick('sheet-file', textFile('Name,Qty\nLager,2', 'other.csv'));
  expect(await screen.findByText('The sheet needs these columns: Item, Supplier, Category, Unit, Servings per unit, Par. Start from the template.')).toBeTruthy();
});

const EXPORT = [
  'Location,Business Date,Menu Item,Item Qty,Net Amount',
  'Main Street Bar,2026-11-01,Lager Can,10,50.00',
  'Main Street Bar,2026-11-01,IPA Pitcher,2,40.00',
  `Main Street Bar,2026-11-01,${SENTINEL},1,100.00`,
  'Main Street Bar,2026-11-02,IPA Pint,5,35.00',
  'Main Street Bar,2026-11-02,Nachos,3,30.00',
  'Main Street Bar,2026-11-03,Nachos,1,10.00',
  'Main Street Bar,2026-11-03,Lager Can,n/a,0',
].join('\n');

test('item sales: Toast columns are proposed; the preview counts rows and lists unmatched names; the body holds no names', async () => {
  const { api } = portal();
  api.answers[`${PATH}/item-sales`] = () => ({ stored: 3, removed: 0 });
  renderAt(api);
  await screen.findByRole('region', { name: 'Item 1' });
  await pick('item-sales-file', textFile(EXPORT, 'export.csv'));
  expect(await screen.findByText('These columns match a Toast export. Check them, then match.')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Date column' }).textContent).toBe('Business Date');
  expect(screen.getByRole('combobox', { name: 'Item name column' }).textContent).toBe('Menu Item');
  expect(screen.getByRole('combobox', { name: 'Quantity column' }).textContent).toBe('Item Qty');
  await click('Match items');
  expect(await screen.findByText('Dates: Nov 1, 2026 to Nov 3, 2026, 3 days with rows.')).toBeTruthy();
  expect(screen.getByText('Rows read: 7. Rows matched to an item: 3.')).toBeTruthy();
  expect(screen.getByText('Items with sales: 2.')).toBeTruthy();
  expect(screen.getByText('Left out 1 row whose quantity is not a number of 0 or more.')).toBeTruthy();
  expect(screen.getByText('Nachos: 2 rows')).toBeTruthy();
  expect(screen.getByText(`${SENTINEL}: 1 row`)).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Add “Nachos” to an item' })).toBeTruthy();

  await click('Send item sales');
  await waitFor(() => { expect(screen.getByText('Saved item sales for 3 days, Nov 1, 2026 to Nov 3, 2026.')).toBeTruthy(); });
  const sent = writes(api).filter((call) => call.path === `${PATH}/item-sales`);
  expect(sent).toEqual([{
    method: 'POST', path: `${PATH}/item-sales`,
    body: {
      from: '2026-11-01', to: '2026-11-03',
      days: [
        { date: '2026-11-01', items: { [LAGER_ID]: 10, [IPA_ID]: 8 } },
        { date: '2026-11-02', items: { [IPA_ID]: 5 } },
        { date: '2026-11-03', items: {} },
      ],
    },
  }]);
  const everything = JSON.stringify(api.calls);
  for (const name of [SENTINEL, 'Nachos', 'Lager Can', 'Main Street Bar', 'export.csv']) expect(everything).not.toContain(name);
});

test('Add to an item puts an unmatched name on the item in the draft; the file is matched again once the setup is saved', async () => {
  const { api } = portal();
  api.answers[`${PATH}/setup`] = (body) => stored(body, 4);
  renderAt(api);
  await screen.findByRole('region', { name: 'Item 1' });
  await pick('item-sales-file', textFile(EXPORT, 'export.csv'));
  await click('Match items');
  choose(await screen.findByRole('combobox', { name: 'Add “Nachos” to an item' }), 'Sample Lager');
  expect(screen.getByText('Added to Sample Lager. Save the setup, then match the file again.')).toBeTruthy();
  expect(within(region('Item 1')).getAllByRole('textbox', { name: 'Point-of-sale name' }).map((field) => (field as HTMLInputElement).value)).toEqual(['Lager Can', 'Nachos']);
  await click('Save the setup');
  expect(await screen.findByText('The setup changed since this file was matched. Match it again before sending.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send item sales' }).getAttribute('aria-disabled')).toBe('true');
  await click('Match again');
  expect(await screen.findByText('Rows read: 7. Rows matched to an item: 5.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send item sales' }).getAttribute('aria-disabled')).toBeNull();
});

test('a file with no date column says the export needs one row per day or per sale, and sends nothing', async () => {
  const { api } = portal();
  renderAt(api);
  await screen.findByRole('region', { name: 'Item 1' });
  await pick('item-sales-file', textFile('Menu Item,Item Qty\nLager Can,4\nIPA Pint,2', 'totals.csv'));
  expect(await screen.findByText('This file has no column of dates. The export needs one row per day or per sale, with its date.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Match items' })).toBeNull();
  expect(writes(api)).toEqual([]);
});

test('a failed part stops the send and says which dates did not save; sending again resends them', async () => {
  const { api } = portal();
  const rows = ['Date,Item,Qty', '10/1/2026,Lager Can,1', '11/5/2026,Lager Can,2'];
  let calls = 0;
  api.answers[`${PATH}/item-sales`] = () => {
    calls += 1;
    return calls === 2 ? refusal(503, null) : { stored: 1, removed: 0 };
  };
  renderAt(api);
  await screen.findByRole('region', { name: 'Item 1' });
  await pick('item-sales-file', textFile(rows.join('\n'), 'square.csv'));
  expect(await screen.findByText('These columns match a Square export. Check them, then match.')).toBeTruthy();
  await click('Match items');
  await click('Send item sales');
  expect(await screen.findByText('Saved Oct 1, 2026 to Oct 31, 2026.')).toBeTruthy();
  expect(screen.getByText('Nov 1, 2026 to Nov 5, 2026 didn’t save. Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  await click('Send the rest again');
  expect(await screen.findByText('Saved item sales for 2 days, Oct 1, 2026 to Nov 5, 2026.')).toBeTruthy();
  const ranges = writes(api).filter((call) => call.path === `${PATH}/item-sales`).map((call) => {
    const body = call.body as { from: string; to: string };
    return `${body.from}..${body.to}`;
  });
  expect(ranges).toEqual(['2026-10-01..2026-10-31', '2026-11-01..2026-11-05', '2026-11-01..2026-11-05']);
});

test('an org admin deletes item sales after an in-page confirm', async () => {
  const { api, gets } = portal({ me: meOf(ACCESS.admin), role: 'org_admin' });
  api.answers[`${PATH}/item-sales`] = () => ({ removed: 31 });
  renderAt(api);
  await screen.findByText('Item sales cover Oct 1, 2026 to Oct 31, 2026, 31 days in all.');
  gets[`${PATH}/setup`] = { ...ANSWER, coverage: null, itemCoverage: { [LAGER_ID]: 0, [IPA_ID]: 0 } };
  await click('Delete item sales');
  const dialog = await screen.findByRole('dialog', { name: 'Delete item sales' });
  expect(within(dialog).getByText('This deletes 31 days of item sales for Main Street Bar. The setup and counts stay. This can’t be undone.')).toBeTruthy();
  expect(writes(api)).toEqual([]);
  await click('Delete item sales', dialog);
  expect(await screen.findByText('Deleted 31 days of item sales.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'DELETE', path: `${PATH}/item-sales`, body: undefined }]);
  expect(screen.getByText('No item sales yet.')).toBeTruthy();
});
