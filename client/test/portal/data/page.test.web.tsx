import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DataItem } from '../../../src/portal/data/api';
import type { MeResponse, OrgResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, LOCATIONS, meOf, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { daysOf, locationsFake, salesOf, uploadOf } from '../locations/fakes';
import { choicesOf, choose, shownChoice } from '../../helpers/select';
import { aiOf, dailyTotalsOf, dataFake, itemOf, type DataFake } from './fakes';

// Your data (P26, D28) on web: the table of everything a location received, Turn off and on at once, the deletes
// with what each keeps, the downloads, All locations, Add a file and Paste text, and view-as and files-off.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

const saved: { name: string; size: number }[] = [];
let lastBlob: Blob | null = null;

beforeEach(() => {
  saved.length = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true, value: (blob: Blob) => { lastBlob = blob; return 'blob:https://townwise.tech/0000'; },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, size: lastBlob?.size ?? -1 });
  });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

const DAYS = daysOf('2025-01-01', 30, () => ({ guests: 50, netSalesCents: 150_000 }));

const ITEMS: DataItem[] = [
  itemOf('f_ref', { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' }),
  itemOf('u_file', {
    via: 'file', kind: 'xlsx', name: 'toast.xlsx', sizeBytes: 3 * 1024 * 1024, days: { count: 731, inUse: 731, firstDate: '2024-01-01', lastDate: '2025-12-31' },
    file: {
      id: 'file-u', hasClean: true, rawAvailable: true, rawExpiresAt: '2027-11-05T15:00:00.000Z', entries: null,
      canDownloadRaw: true, canDownloadClean: true, canDeleteRaw: true,
    },
  }),
  dailyTotalsOf('u_1'),
];

/** The portal API of the last setup, for its GET /api/org reads. */
let portal: FakePortalApi | null = null;

function orgReads(): number {
  return portal?.calls.filter((call) => call.method === 'GET' && call.path === '/api/org').length ?? 0;
}

async function settle(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

function setup(
  me: MeResponse, items: DataItem[] = ITEMS, opts: { files?: 'on' | 'off'; org?: OrgResponse } = {},
): DataFake {
  const inner = locationsFake({ sales: { l1: salesOf(DAYS, [uploadOf('u1')]) }, days: { l1: DAYS } });
  const fake = dataFake({ inner, items: items.map((item) => ({ ...item, file: item.file === null ? null : { ...item.file }, days: item.days === null ? null : { ...item.days } })) });
  if (opts.files === 'off') fake.files.lists[''] = refusal(503, 'files_unavailable');
  const api = fakePortalApi({ me, org: opts.org ?? orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake });
  portal = api;
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', '/locations/l1/data');
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location="/locations/l1/data" />
    </Head.Provider>,
  );
  return fake;
}

async function table(name = 'Your data for Main Street Bar'): Promise<HTMLElement> {
  return screen.findByRole('region', { name });
}

function rowsOf(root: HTMLElement): HTMLElement[] {
  return within(root).getAllByRole('row').slice(1);
}

function at(rows: HTMLElement[], index: number): HTMLElement {
  const row = rows[index];
  if (row === undefined) throw new Error(`no row ${String(index)}`);
  return row;
}

function buttons(row: HTMLElement): string[] {
  return within(row).queryAllByRole('button').map((button) => button.textContent);
}

function noticeHasFocus(notice: HTMLElement): boolean {
  return document.activeElement !== document.body && document.activeElement?.contains(notice) === true;
}

test('lists every item as a table row: item, added, kind, size, status and days', async () => {
  setup(meOf(ACCESS.admin));
  expect(await screen.findByRole('heading', { level: 2, name: 'Your data' })).toBeTruthy();
  expect(screen.getByText('Everything your team added')).toBeTruthy();
  expect(screen.getByText(/^Sales uploads, files and text your team added for Main Street Bar, newest first\./)).toBeTruthy();
  const rows = rowsOf(await table());
  expect(rows).toHaveLength(3);
  const head = within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent);
  expect(head).toEqual(['Item', 'Added', 'Kind', 'Size', 'Status', 'Days', 'Actions']);
  expect(within(at(rows, 0)).getByText('menu-notes.txt')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('Read by Townwise')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('Kept for reference')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('Nov 5, 2026, owner@example.com')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('2 KB')).toBeTruthy();
  expect(within(at(rows, 1)).getByText('Excel file')).toBeTruthy();
  expect(within(at(rows, 1)).getByText('731 of 731 in use, Jan 1, 2024 to Dec 31, 2025')).toBeTruthy();
  // The name and the kind both read Daily totals.
  expect(within(at(rows, 2)).getAllByText('Daily totals')).toHaveLength(2);
  expect(within(at(rows, 2)).getByText('Sent from a browser')).toBeTruthy();
  expect(within(at(rows, 2)).getByText('5 of 10 in use, May 1, 2026 to May 10, 2026')).toBeTruthy();
  expect(within(at(rows, 2)).getByText('No file kept')).toBeTruthy();
  expect(within(at(rows, 2)).getByText('Used')).toBeTruthy();
  expect(within(at(rows, 2)).getByText('On')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
});

test('Status says what TownwiseAI did with a row’s file after what Townwise did, and nothing with no read or once undone (D34)', async () => {
  const reference = { kind: 'pdf', state: 'kept', outcome: 'reference' } as const;
  setup(meOf(ACCESS.admin), [
    itemOf('f_queued', { ...reference, name: 'queued.pdf', ai: aiOf({ status: 'queued', kind: null }) }),
    itemOf('f_reading', { ...reference, name: 'reading.pdf', ai: aiOf({ status: 'reading', kind: null }) }),
    itemOf('f_done', { ...reference, name: 'done.pdf', ai: aiOf({ status: 'done' }) }),
    itemOf('f_failed', { ...reference, name: 'failed.pdf', ai: aiOf({ status: 'failed', reason: 'internal', kind: null }) }),
    itemOf('f_skipped', { ...reference, name: 'skipped.pdf', ai: aiOf({ status: 'skipped', reason: 'too_large', kind: null }) }),
    itemOf('f_undone', { ...reference, name: 'undone.pdf', ai: aiOf({ status: 'undone', kind: null }) }),
    itemOf('f_none', { ...reference, name: 'none.pdf' }),
    itemOf('f_later', { ...reference, name: 'later.pdf', ai: aiOf({ status: 'a_status_from_later', kind: null }) }),
    // A sales file that wrote days is its upload, and the read shows there.
    itemOf('u_sales', { state: 'used', name: 'sales.csv', ai: aiOf({ status: 'done' }) }),
  ]);
  const rows = rowsOf(await table());
  // Item, Added, Kind, Size, Status.
  const status = rows.map((row) => within(row).getAllByRole('cell')[4]?.textContent);
  expect(status).toEqual([
    'OnKept for reference · TownwiseAI is reading it',
    'OnKept for reference · TownwiseAI is reading it',
    'OnKept for reference · Read by TownwiseAI',
    'OnKept for reference · TownwiseAI couldn’t read it',
    'OnKept for reference · TownwiseAI didn’t read it',
    'OnKept for reference',
    'OnKept for reference',
    'OnKept for reference',
    'OnUsed · Read by TownwiseAI',
  ]);
});

test('Open is each row’s first action and opens the item’s page; an item still uploading has none', async () => {
  const ref = 'f_00000000000000000000000c';
  setup(meOf(ACCESS.admin), [
    itemOf(ref, { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' }),
    itemOf('f_up', { name: 'arriving.txt', state: 'uploading', canTurnOff: false }),
    dailyTotalsOf('u_1'),
  ]);
  const rows = rowsOf(await table());
  const open = within(at(rows, 0)).getByRole('link', { name: 'Open: menu-notes.txt' });
  expect(open.getAttribute('href')).toBe(`/locations/l1/data/${ref}`);
  expect(open.textContent).toBe('Open');
  // First among the row's actions.
  expect(within(at(rows, 0)).getAllByRole('cell').at(-1)?.textContent).toMatch(/^OpenTurn off/);
  expect(within(at(rows, 1)).queryByRole('link', { name: /^Open/ })).toBeNull();
  expect(within(at(rows, 2)).getByRole('link', { name: 'Open: Daily totals, May 1, 2026 to May 10, 2026' }).getAttribute('href')).toBe('/locations/l1/data/u_1');
  await settle(() => { fireEvent.click(open); });
  await waitFor(() => { expect(window.location.pathname).toBe(`/locations/l1/data/${ref}`); });
  expect(await screen.findByRole('heading', { level: 2, name: 'menu-notes.txt' })).toBeTruthy();
});

test('Turn off sends enabled false at once, the row reads Off, and the notice takes focus', async () => {
  const fake = setup(meOf(ACCESS.admin));
  await table();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
  expect(fake.patches).toEqual([{ ref: 'u_1', body: { enabled: false } }]);
  const notice = await screen.findByText(/^Turned off Daily totals, May 1, 2026 to May 10, 2026\./);
  expect(notice.textContent).toBe('Turned off Daily totals, May 1, 2026 to May 10, 2026. Main Street Bar’s numbers, forecasts and TownwiseAI leave it out until it’s turned on.');
  await waitFor(() => { expect(noticeHasFocus(notice)).toBe(true); });
  expect(within(at(rowsOf(await table()), 2)).getByText('Off')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Turn on: Daily totals, May 1, 2026 to May 10, 2026' }));
  expect(fake.patches.at(-1)).toEqual({ ref: 'u_1', body: { enabled: true } });
  expect(await screen.findByText('Turned on Daily totals, May 1, 2026 to May 10, 2026.')).toBeTruthy();
  expect(within(at(rowsOf(await table()), 2)).getByText('On')).toBeTruthy();
});

test('Delete on an upload says in words which days go and what stays, then deletes it', async () => {
  const fake = setup(meOf(ACCESS.admin));
  await table();
  fireEvent.click(screen.getByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 10, 2026' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this upload' });
  expect(within(dialog).getByText(
    'This deletes the 5 days this upload still holds for Main Street Bar, May 1, 2026 to May 10, 2026, and its file, if it has one. Days a later upload replaced stay, and so do notes. To keep the days out of your numbers without deleting them, turn it off instead. This can’t be undone.',
  )).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete upload' }));
  const notice = await screen.findByText('Deleted the upload and 5 days.');
  expect(fake.removed).toEqual([{ locationId: 'l1', ref: 'u_1' }]);
  await waitFor(() => { expect(noticeHasFocus(notice)).toBe(true); });
  await waitFor(() => { expect(rowsOf(screen.getByRole('table'))).toHaveLength(2); });
});

test('Delete on a stored file says it goes for everyone on the team', async () => {
  const fake = setup(meOf(ACCESS.admin));
  await table();
  fireEvent.click(screen.getByRole('button', { name: 'Delete: menu-notes.txt' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this file' });
  expect(within(dialog).getByText('This deletes menu-notes.txt for everyone on your team. This can’t be undone.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
  expect(await screen.findByText('Deleted menu-notes.txt.')).toBeTruthy();
  expect(fake.removed).toEqual([{ locationId: 'l1', ref: 'f_ref' }]);
});

test('a member sees Turn off on their own items only, and no Delete on any upload', async () => {
  setup(meOf(ACCESS.member), [
    itemOf('f_mine', { name: 'mine.txt', file: null, sizeBytes: 10 }),
    itemOf('f_theirs', { name: 'theirs.txt', file: null, sizeBytes: 10, canTurnOff: false, canDelete: false }),
    dailyTotalsOf('u_1', { canDelete: false }),
  ]);
  const rows = rowsOf(await table());
  expect(buttons(at(rows, 0))).toEqual(['Turn off', 'Delete']);
  expect(buttons(at(rows, 1))).toEqual([]);
  expect(buttons(at(rows, 2))).toEqual(['Turn off']);
  expect(screen.queryByRole('button', { name: 'Delete all originals for this location' })).toBeNull();
});

test('a refused action says why, in this page’s words', async () => {
  const fake = setup(meOf(ACCESS.admin));
  fake.answers['PATCH u_1'] = () => refusal(409, 'item_busy');
  fake.answers['PATCH f_ref'] = () => refusal(503, 'files_unavailable');
  await table();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
  expect(await screen.findByText('Townwise is still reading this file. Try again when it’s done.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off: menu-notes.txt' }));
  expect(await screen.findByText('File storage is off right now, so this can’t be done.')).toBeTruthy();
});

test('a 404 says the item is gone and the list loads again', async () => {
  const fake = setup(meOf(ACCESS.admin));
  fake.answers['PATCH u_1'] = () => refusal(404, 'not_found');
  await table();
  const loads = fake.lists.length;
  fireEvent.click(screen.getByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
  expect(await screen.findByText('This item isn’t available anymore.')).toBeTruthy();
  await waitFor(() => { expect(fake.lists.length).toBeGreaterThan(loads); });
});

test('view-as: names hidden, every action disabled in place with the read-only line, no downloads', async () => {
  const hidden = { name: null, canTurnOff: false, canDelete: false } as const;
  setup(viewAsMe(ACCESS.admin), ITEMS.map((item) => ({
    ...item, ...hidden, file: item.file === null ? null : { ...item.file, canDownloadRaw: false, canDownloadClean: false, canDeleteRaw: false },
  })));
  const rows = rowsOf(await table());
  // With no name, the item reads as its kind (in the item and the kind columns).
  expect(within(at(rows, 0)).getAllByText('CSV or text file')).toHaveLength(2);
  expect(within(at(rows, 1)).getAllByText('Excel file')).toHaveLength(2);
  expect(document.body.textContent).not.toContain('menu-notes.txt');
  for (const row of rows) {
    for (const button of within(row).getAllByRole('button')) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('aria-describedby')).toBe('data-ro');
    }
    expect(within(row).queryByRole('button', { name: /Download/ })).toBeNull();
  }
  expect(document.getElementById('data-ro')?.textContent).toMatch(/^Read-only while viewing as /);
  expect(screen.getByRole('button', { name: 'Paste text' }).getAttribute('aria-disabled')).toBe('true');
  const all = screen.getByRole('button', { name: 'Delete all originals for this location' });
  expect([all.getAttribute('aria-disabled'), all.getAttribute('aria-describedby')]).toEqual(['true', 'data-ro']);
  // With no name, each row's actions name it by its kind and its days, or when it was added.
  expect(within(at(rows, 1)).getByRole('button', { name: 'Turn off: Excel file, Jan 1, 2024 to Dec 31, 2025' })).toBeTruthy();
  // Opening is a read: Open stays a working link under view-as.
  const open = within(at(rows, 0)).getByRole('link', { name: 'Open: CSV or text file, added Nov 5, 2026' });
  expect([open.getAttribute('href'), open.getAttribute('aria-disabled')]).toEqual(['/locations/l1/data/f_ref', null]);
  expect(within(at(rows, 0)).getByRole('button', { name: 'Turn off: CSV or text file, added Nov 5, 2026' })).toBeTruthy();
});

test('All locations lists every location’s items with a Location column', async () => {
  const fake = setup(meOf(ACCESS.admin), [...ITEMS, dailyTotalsOf('u_2', { locationId: 'l2' })]);
  await table();
  expect(rowsOf(screen.getByRole('table'))).toHaveLength(3);
  // The portal's select on web (Select.web.tsx): the choices are read and picked by opening it.
  const show = screen.getByRole('combobox', { name: 'Show' });
  expect(choicesOf(show)).toEqual(['Main Street Bar', 'All locations']);
  choose(show, 'All locations');
  expect(shownChoice(show)).toBe('All locations');
  const all = await table('Your data for all locations');
  expect(fake.lists.at(-1)).toEqual({ locationId: null, after: null });
  const rows = rowsOf(all);
  expect(rows).toHaveLength(4);
  expect(within(all).getAllByRole('columnheader').map((cell) => cell.textContent)).toContain('Location');
  expect(within(at(rows, 3)).getByText('River Grill')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('Main Street Bar')).toBeTruthy();
});

test('a single-location organization has no Show select', async () => {
  const [first] = LOCATIONS;
  if (first === undefined) throw new Error('no location');
  setup(meOf(ACCESS.admin), ITEMS, { org: orgOf('org_admin', [first]) });
  await table('Your data for Test Group');
  expect(screen.queryByLabelText('Show')).toBeNull();
});

test('with one location the lead, the table and the empty line name the organization (D29)', async () => {
  const one = { org: orgOf('org_admin', LOCATIONS.slice(0, 1)) };
  setup(meOf(ACCESS.admin), ITEMS, one);
  expect(await table('Your data for Test Group')).toBeTruthy();
  expect(screen.getByText(/^Sales uploads, files and text your team added for Test Group, newest first\./)).toBeTruthy();
  cleanup();
  setup(meOf(ACCESS.admin), [], one);
  expect(await screen.findByText('Nothing here yet. What your team uploads or adds for Test Group shows here.')).toBeTruthy();
  expect(screen.queryByText(/Main Street Bar/)).toBeNull();
});

test('with one location the Turned off notice and the delete dialogs name the organization (D29)', async () => {
  const one = { org: orgOf('org_admin', LOCATIONS.slice(0, 1)) };
  setup(meOf(ACCESS.admin), ITEMS, one);
  await table('Your data for Test Group');
  fireEvent.click(screen.getByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
  expect((await screen.findByText(/^Turned off Daily totals/)).textContent).toBe(
    'Turned off Daily totals, May 1, 2026 to May 10, 2026. Test Group’s numbers, forecasts and TownwiseAI leave it out until it’s turned on.',
  );
  cleanup();
  setup(meOf(ACCESS.admin), ITEMS, one);
  await table('Your data for Test Group');
  fireEvent.click(screen.getByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 10, 2026' }));
  const upload = await screen.findByRole('dialog', { name: 'Delete this upload' });
  expect(within(upload).getByText(/^This deletes the 5 days this upload still holds for Test Group, May 1, 2026 to May 10, 2026,/)).toBeTruthy();
  cleanup();
  setup(meOf(ACCESS.admin), ITEMS, one);
  await table('Your data for Test Group');
  fireEvent.click(screen.getByRole('button', { name: 'Delete all originals for this location' }));
  const originals = await screen.findByRole('dialog', { name: 'Delete all originals for this location' });
  expect(within(originals).getByText(/^This deletes the original of every sales file for Test Group\./)).toBeTruthy();
  expect(screen.queryByText(/Main Street Bar/)).toBeNull();
});

test('stored files off: no Add a file or Paste text, and the list still shows uploads', async () => {
  setup(meOf(ACCESS.admin), [dailyTotalsOf('u_1')], { files: 'off' });
  const rows = rowsOf(await table());
  expect(rows).toHaveLength(1);
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' })).toBeTruthy(); });
  expect(screen.queryByRole('button', { name: 'Add a file' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Paste text' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete all originals for this location' })).toBeNull();
});

test('stored files on: Add a file and Paste text, with the helper', async () => {
  setup(meOf(ACCESS.admin));
  expect(await screen.findByRole('button', { name: 'Add a file' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Paste text' })).toBeTruthy();
  expect(screen.getByText(
    'Any kind of file up to 200 MB, kept as it is for your team. Townwise doesn’t read it for sales; use Upload sales history for that. With the box above off, TownwiseAI reads a file only when you ask, in a chat or on the file’s page. With it on, TownwiseAI reads each file you add and uses what it finds.',
  )).toBeTruthy();
});

test('Paste text saves an item and reloads the list; empty title and over 10,000 characters are refused in place', async () => {
  const fake = setup(meOf(ACCESS.admin));
  fireEvent.click(await screen.findByRole('button', { name: 'Paste text' }));
  expect(await screen.findByRole('heading', { name: 'Paste text' })).toBeTruthy();
  expect(screen.getByText('A few words your team will recognize. Leave out guests’ and staff names.')).toBeTruthy();
  expect(screen.getByText('Up to 10,000 characters.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Add a title.')).toBeTruthy();
  expect(screen.getByText('Paste some text.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Winter hours' } });
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'x'.repeat(10_001) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Keep it to 10,000 characters.')).toBeTruthy();
  expect(fake.texts).toEqual([]);
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Closed Mondays in January.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const notice = await screen.findByText('Saved Winter hours.');
  expect(fake.texts).toEqual([{ locationId: 'l1', body: { title: 'Winter hours', text: 'Closed Mondays in January.' } }]);
  await waitFor(() => { expect(noticeHasFocus(notice)).toBe(true); });
  expect(await screen.findByText('Winter hours.txt')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Paste text' })).toBeNull();
});

test('Cancel closes the Paste text form without a request', async () => {
  const fake = setup(meOf(ACCESS.admin));
  fireEvent.click(await screen.findByRole('button', { name: 'Paste text' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('heading', { name: 'Paste text' })).toBeNull();
  expect(fake.texts).toEqual([]);
});

test('Add a file uploads with purpose reference', async () => {
  const fake = setup(meOf(ACCESS.admin));
  await screen.findByRole('button', { name: 'Add a file' });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  fireEvent.change(input, { target: { files: [new File(['menu'], 'menu.pdf', { type: 'application/pdf' })] } });
  await waitFor(() => { expect(fake.files.calls.some((call) => call.method === 'POST' && call.path === '/files')).toBe(true); });
  const created = fake.files.calls.find((call) => call.method === 'POST' && call.path === '/files');
  expect(created?.body).toMatchObject({ name: 'menu.pdf', purpose: 'reference' });
});

test('downloads follow each item’s flags and save through a blob link', async () => {
  const fake = setup(meOf(ACCESS.admin));
  fake.files.downloads['/files/file-u/clean'] = () => new Blob(['date,guests,net_sales\r\n']);
  fake.files.downloads['/files/file-u/raw'] = () => new Blob(['abcd']);
  const rows = rowsOf(await table());
  // An item kept for reference is its original: Delete removes it whole, so it has no Delete original.
  expect(buttons(at(rows, 0))).toEqual(['Turn off', 'Download original', 'Delete']);
  expect(buttons(at(rows, 1))).toEqual(['Turn off', 'Download original', 'Download cleaned CSV', 'Delete original', 'Delete']);
  fireEvent.click(screen.getByRole('button', { name: 'Download cleaned CSV: toast.xlsx' }));
  await waitFor(() => { expect(saved).toEqual([{ name: 'toast-townwise.csv', size: 23 }]); });
  // The button is enabled again once the save has finished.
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Download original: toast.xlsx' }).getAttribute('aria-disabled')).not.toBe('true'); });
  fireEvent.click(screen.getByRole('button', { name: 'Download original: toast.xlsx' }));
  await waitFor(() => { expect(saved.at(-1)).toEqual({ name: 'toast.xlsx', size: 4 }); });
});

test('Delete original says what stays, then deletes only the original', async () => {
  const fake = setup(meOf(ACCESS.admin));
  await table();
  fireEvent.click(screen.getByRole('button', { name: 'Delete original: toast.xlsx' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete original' });
  expect(within(dialog).getByText('This deletes the original of toast.xlsx. The cleaned copy and the days it added stay. This can’t be undone.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete original' }));
  expect(await screen.findByText('Deleted the original. The cleaned copy and its days stay.')).toBeTruthy();
  expect(fake.files.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/file-u/raw']);
});

test('an org admin deletes every sales file’s original at once, and is told first that items kept for reference stay', async () => {
  const fake = setup(meOf(ACCESS.admin));
  await table();
  fireEvent.click(screen.getByRole('button', { name: 'Delete all originals for this location' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete all originals for this location' });
  expect(within(dialog).getByText(
    'This deletes the original of every sales file for Main Street Bar. Cleaned copies and days stay, and so do items kept for reference. Files still uploading or being read are skipped. This can’t be undone.',
  )).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete all originals for this location' }));
  const notice = await screen.findByText('Deleted 0 originals.');
  await waitFor(() => { expect(noticeHasFocus(notice)).toBe(true); });
  expect(fake.files.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/originals']);
});

test('Delete all originals needs a sales file’s original at the one location shown', async () => {
  // Only an item kept for reference and a browser upload: no sales file's original to delete.
  const [reference] = ITEMS;
  if (reference === undefined) throw new Error('no item');
  setup(meOf(ACCESS.admin), [reference, dailyTotalsOf('u_1')]);
  await table();
  expect(screen.queryByRole('button', { name: 'Delete all originals for this location' })).toBeNull();
  cleanup();
  setup(meOf(ACCESS.admin));
  await table();
  expect(screen.getByRole('button', { name: 'Delete all originals for this location' })).toBeTruthy();
  choose(screen.getByRole('combobox', { name: 'Show' }), 'All locations');
  await table('Your data for all locations');
  expect(screen.queryByRole('button', { name: 'Delete all originals for this location' })).toBeNull();
});

test('a download waits and fails in its own row: the other rows stay usable, and the error shows beside it', async () => {
  const fake = setup(meOf(ACCESS.admin));
  const request = fake.files.request.bind(fake.files);
  let fail: (() => void) | null = null;
  fake.files.request = (path, opts) => (path.endsWith('/files/file-u/clean')
    ? new Promise<Response>((_resolve, reject) => { fail = () => { reject(refusal(404, 'not_found')); }; })
    : request(path, opts));
  await table();
  fireEvent.click(screen.getByRole('button', { name: 'Download cleaned CSV: toast.xlsx' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Download cleaned CSV: toast.xlsx' }).textContent).toBe('Downloading…'); });
  expect(screen.getByRole('button', { name: 'Download original: toast.xlsx' }).getAttribute('aria-disabled')).toBe('true');
  for (const name of ['Download original: menu-notes.txt', 'Turn off: menu-notes.txt', 'Turn off: toast.xlsx', 'Turn off: Daily totals, May 1, 2026 to May 10, 2026']) {
    expect({ name, disabled: screen.getByRole('button', { name }).getAttribute('aria-disabled') }).toEqual({ name, disabled: null });
  }
  await settle(() => { fail?.(); });
  const row = at(rowsOf(await table()), 1);
  expect(within(row).getByRole('alert').textContent).toBe('This item isn’t available anymore.');
  expect(within(row).getByRole('button', { name: 'Download cleaned CSV: toast.xlsx' }).textContent).toBe('Download cleaned CSV');
  expect(within(at(rowsOf(await table()), 0)).queryByRole('alert')).toBeNull();
});

test('a sales file whose original was deleted says so; an item kept for reference claims no cleaned copy', async () => {
  const gone = { rawAvailable: false, canDownloadRaw: false, canDeleteRaw: false } as const;
  setup(meOf(ACCESS.admin), ITEMS.map((item) => ({ ...item, file: item.file === null ? null : { ...item.file, ...gone } })));
  const rows = rowsOf(await table());
  expect(within(at(rows, 1)).getByText('The original was deleted. The cleaned copy and days stay.')).toBeTruthy();
  expect(within(at(rows, 0)).queryByText(/The original was deleted/)).toBeNull();
  expect(within(at(rows, 2)).queryByText(/The original was deleted/)).toBeNull();
});

test('after Turn off, the organization is read again once the page closes, not before', async () => {
  setup(meOf(ACCESS.admin));
  await table();
  const before = orgReads();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
  await screen.findByText(/^Turned off Daily totals, May 1, 2026 to May 10, 2026\./);
  expect(orgReads()).toBe(before);
  await settle(() => { fireEvent.click(screen.getByRole('link', { name: 'Notes' })); });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/notes'); });
  await waitFor(() => { expect(orgReads()).toBe(before + 1); });
});

test('after an upload is deleted, the organization is read again once the page closes', async () => {
  setup(meOf(ACCESS.admin));
  await table();
  const before = orgReads();
  fireEvent.click(screen.getByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 10, 2026' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this upload' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete upload' }));
  await screen.findByText('Deleted the upload and 5 days.');
  await settle(() => { fireEvent.click(screen.getByRole('link', { name: 'Notes' })); });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/notes'); });
  await waitFor(() => { expect(orgReads()).toBe(before + 1); });
});

test('leaving with nothing changed reads the organization no more', async () => {
  setup(meOf(ACCESS.admin));
  await table();
  const before = orgReads();
  await settle(() => { fireEvent.click(screen.getByRole('link', { name: 'Notes' })); });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/notes'); });
  await settle(() => undefined);
  expect(orgReads()).toBe(before);
});

test('a list that fails after Show changes says so with Try again, not Loading', async () => {
  const fake = setup(meOf(ACCESS.admin), [...ITEMS, dailyTotalsOf('u_2', { locationId: 'l2' })]);
  await table();
  fake.answers['GET /api/org/data'] = () => refusal(503, 'unavailable');
  choose(screen.getByRole('combobox', { name: 'Show' }), 'All locations');
  expect(await screen.findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  expect(screen.queryByText('Loading your data')).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
  // Show stays, so the person can go back.
  expect(screen.getByLabelText('Show')).toBeTruthy();
  fake.answers = {};
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(rowsOf(await table('Your data for all locations'))).toHaveLength(4);
});

test('a list that fails to load again after a delete says so with Try again, in place of the old rows', async () => {
  const fake = setup(meOf(ACCESS.admin));
  await table();
  fake.answers['GET /api/org/data'] = () => refusal(503, 'unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 10, 2026' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this upload' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete upload' }));
  expect(await screen.findByText('Deleted the upload and 5 days.')).toBeTruthy();
  expect(await screen.findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  fake.answers = {};
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(rowsOf(screen.getByRole('table'))).toHaveLength(2); });
});

test('a ZIP lists the files inside it, a page at a time', async () => {
  const fake = setup(meOf(ACCESS.admin), [
    itemOf('f_zip', {
      name: 'export.zip', kind: 'zip', state: 'kept', outcome: 'reference',
      file: { id: 'file-zip', hasClean: false, rawAvailable: true, rawExpiresAt: null, entries: { total: 3, used: 0, kept: 3 }, canDownloadRaw: true, canDownloadClean: false, canDeleteRaw: true },
    }),
  ]);
  fake.files.entries['file-zip:'] = { entries: [{ index: 0, path: 'a/day-0.csv', depth: 1, kind: 'text', sizeBytes: 512, status: 'kept', outcome: 'reference', dayCount: null }], next: null };
  await table();
  expect(screen.getByText('3 files inside: 0 used, 3 kept, not used')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'See what’s inside' }));
  expect(await screen.findByText('a/day-0.csv')).toBeTruthy();
});

test('more than a page: Show older items loads the next page and appends it', async () => {
  const many = Array.from({ length: 3 }, (_, index) => itemOf(`f_${String(index)}`, { name: `file-${String(index)}.txt`, file: null }));
  const fake = setup(meOf(ACCESS.admin), many);
  fake.pageSize = 2;
  fireEvent.click(await screen.findByRole('button', { name: 'Show older items' }));
  await waitFor(() => { expect(rowsOf(screen.getByRole('table'))).toHaveLength(3); });
  expect(fake.lists.at(-1)).toEqual({ locationId: 'l1', after: '2' });
  expect(screen.queryByRole('button', { name: 'Show older items' })).toBeNull();
});

test('nothing yet: the empty line, and the failure to list shows the error with Try again', async () => {
  const fake = setup(meOf(ACCESS.admin), []);
  expect(await screen.findByText('Nothing here yet. What your team uploads or adds for Main Street Bar shows here.')).toBeTruthy();
  cleanup();
  const failing = setup(meOf(ACCESS.admin));
  failing.answers['GET /api/org/data'] = () => refusal(503, 'unavailable');
  expect(await screen.findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  failing.answers = {};
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await table()).toBeTruthy();
  expect(fake.items).toEqual([]);
});
