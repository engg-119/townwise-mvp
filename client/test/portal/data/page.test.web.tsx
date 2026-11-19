import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DataItem } from '../../../src/portal/data/api';
import type { MeResponse, OrgResponse } from '../../../src/portal/schemas';
import { theme } from '../../../src/theme';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, LOCATIONS, meOf, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { daysOf, locationsFake, salesOf, uploadOf } from '../locations/fakes';
import { choicesOf, choose, shownChoice } from '../../helpers/select';
import { openMore } from '../../helpers/topBar';
import { ownerCalendar } from '../calendar/fakes';
import { aiOf, dailyTotalsOf, dataFake, itemOf, type DataFake } from './fakes';

// Your data (P26, D28) on web: the table of everything a location received, each row opening its item's page (where
// Turn off, the downloads and the deletes are: item.test.web.tsx), All locations, Add a file and Paste text, Delete
// all originals, and view-as and files-off.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  window.localStorage.clear();
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

/**
 * The page for `me`, with `items` and `calendars`. `view` is the View remembered in this browser for the person signed
 * in: Newest first unless given, so most tests read one table; 'organized' leaves nothing remembered (the default).
 */
function setup(
  me: MeResponse, items: DataItem[] = ITEMS,
  opts: { files?: 'on' | 'off'; org?: OrgResponse; calendars?: unknown[]; view?: 'organized' | 'newest'; pageSize?: number } = {},
): DataFake {
  if ((opts.view ?? 'newest') === 'newest') window.localStorage.setItem(`townwise.dataView.${me.user.id}`, 'newest');
  const inner = locationsFake({ sales: { l1: salesOf(DAYS, [uploadOf('u1')]) }, days: { l1: DAYS } });
  const fake = dataFake({ inner, items: items.map((item) => ({ ...item, file: item.file === null ? null : { ...item.file }, days: item.days === null ? null : { ...item.days } })) });
  if (opts.files === 'off') fake.files.lists[''] = refusal(503, 'files_unavailable');
  if (opts.calendars !== undefined) fake.calendars = opts.calendars;
  if (opts.pageSize !== undefined) fake.pageSize = opts.pageSize;
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

// On web theme.color is var(--tw-<token>), which jsdom leaves unresolved, so a computed color names its token.
const RAISED = theme.color.raised;

/** The notice is a toast, which never takes focus: the page's h1 has it in its place (spec 15.7, D55). */
function headingHasFocus(notice: HTMLElement): boolean {
  return notice.closest('[data-testid="toast"]') !== null && document.activeElement === screen.getByRole('heading', { level: 1 });
}

test('lists every item as a table row: item, added, kind, size, status and days', async () => {
  setup(meOf(ACCESS.admin));
  expect(await screen.findByRole('heading', { level: 2, name: 'Your data' })).toBeTruthy();
  expect(screen.getByText('Everything your team added')).toBeTruthy();
  expect(screen.getByText(/^Sales uploads, calendars, files and text your team added for Main Street Bar\./)).toBeTruthy();
  // Item sales, the ordering setup and counts are not listed here: one line points to where they live.
  expect(screen.getByText('Item sales, the ordering setup and counts live in Orders, under Ordering setup.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Ordering setup' }).getAttribute('href')).toBe('/locations/l1/orders/setup');
  const rows = rowsOf(await table());
  expect(rows).toHaveLength(3);
  const head = within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent);
  expect(head).toEqual(['Item', 'Added', 'Kind', 'Size', 'Status', 'Days']);
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

test('a row opens its item’s page from a press anywhere on it; its name is its one link; an item still uploading has none', async () => {
  const ref = 'f_00000000000000000000000c';
  const upload = 'u_00000000000000000000000d';
  setup(meOf(ACCESS.admin), [
    itemOf(ref, { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' }),
    itemOf('f_up', { name: 'arriving.txt', state: 'uploading', canTurnOff: false }),
    dailyTotalsOf(upload),
  ]);
  const rows = rowsOf(await table());
  const link = within(at(rows, 0)).getByRole('link', { name: 'menu-notes.txt' });
  expect([link.tagName, link.getAttribute('href'), link.textContent]).toEqual(['A', `/locations/l1/data/${ref}`, 'menu-notes.txt']);
  // The actions are on the item's page: no Open, no Turn off, downloads or deletes, and nothing else focusable.
  for (const row of rows) {
    expect(within(row).queryAllByRole('button')).toEqual([]);
    expect(within(row).queryByRole('link', { name: /^Open/ })).toBeNull();
    const focusable = [...row.querySelectorAll<HTMLElement>('a[href], button, [tabindex]')].filter((element) => element.tabIndex >= 0);
    expect(focusable).toEqual(within(row).queryAllByRole('link'));
  }
  // A linked row is not a tab stop of its own.
  expect([at(rows, 0).tabIndex, at(rows, 2).tabIndex]).toEqual([-1, -1]);
  // An item with no name is named by its kind and its days, as its page's actions name it.
  expect(within(at(rows, 2)).getByRole('link', { name: 'Daily totals, May 1, 2026 to May 10, 2026' }).getAttribute('href')).toBe(`/locations/l1/data/${upload}`);
  expect(within(at(rows, 1)).queryByRole('link')).toBeNull();
  // The row is raised on hover and while its link has focus; an unlinked row goes nowhere when pressed.
  fireEvent.focus(link);
  expect(window.getComputedStyle(at(rows, 0)).backgroundColor).toBe(RAISED);
  fireEvent.blur(link);
  expect(window.getComputedStyle(at(rows, 0)).backgroundColor).not.toBe(RAISED);
  fireEvent.mouseEnter(at(rows, 2));
  expect(window.getComputedStyle(at(rows, 2)).backgroundColor).toBe(RAISED);
  await settle(() => { fireEvent.click(within(at(rows, 1)).getByText('arriving.txt')); });
  expect(window.location.pathname).toBe('/locations/l1/data');
  // A press on another cell of a linked row opens its page.
  await settle(() => { fireEvent.click(within(at(rows, 0)).getByText('Kept for reference')); });
  await waitFor(() => { expect(window.location.pathname).toBe(`/locations/l1/data/${ref}`); });
  expect(await screen.findByRole('heading', { level: 2, name: 'menu-notes.txt' })).toBeTruthy();
});

test('a linked row’s name is underlined, as links are, so a phone’s card shows it opens; an unlinked row keeps the default cursor', async () => {
  setup(meOf(ACCESS.admin), [
    itemOf('f_00000000000000000000000c', { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' }),
    itemOf('f_up', { name: 'arriving.txt', state: 'uploading', canTurnOff: false }),
  ]);
  const rows = rowsOf(await table());
  const name = within(at(rows, 0)).getByText('menu-notes.txt');
  expect(window.getComputedStyle(name).textDecorationLine || window.getComputedStyle(name).textDecoration).toContain('underline');
  expect(window.getComputedStyle(within(at(rows, 1)).getByText('arriving.txt')).textDecorationLine || '').not.toContain('underline');
  expect(window.getComputedStyle(at(rows, 0)).cursor).toBe('pointer');
  expect(window.getComputedStyle(at(rows, 1)).cursor).toBe('auto');
  expect(at(rows, 1).tabIndex).toBe(-1);
});

test('a press that ends a text selection across a row selects and opens nothing', async () => {
  setup(meOf(ACCESS.admin), [itemOf('f_00000000000000000000000c', { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' })]);
  const row = at(rowsOf(await table()), 0);
  const selection = jest.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Kept for' } as Selection);
  await settle(() => { fireEvent.click(within(row).getByText('Kept for reference')); });
  expect(window.location.pathname).toBe('/locations/l1/data');
  selection.mockRestore();
  await settle(() => { fireEvent.click(within(row).getByText('Kept for reference')); });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/data/f_00000000000000000000000c'); });
});

test('pressing a row’s link opens its page once, not once for the link and again for the row', async () => {
  const ref = 'f_00000000000000000000000c';
  setup(meOf(ACCESS.admin), [itemOf(ref, { name: 'menu-notes.txt', state: 'kept', outcome: 'reference' })]);
  const link = within(at(rowsOf(await table()), 0)).getByRole('link', { name: 'menu-notes.txt' });
  const before = window.history.length;
  await settle(() => { fireEvent.click(link); });
  await waitFor(() => { expect(window.location.pathname).toBe(`/locations/l1/data/${ref}`); });
  expect(await screen.findByRole('heading', { level: 2, name: 'menu-notes.txt' })).toBeTruthy();
  expect(window.history.length).toBe(before + 1);
});

test('view-as: names hidden, rows still open their pages, and the page’s writes disabled in place with the read-only line', async () => {
  const hidden = { name: null, canTurnOff: false, canDelete: false } as const;
  setup(viewAsMe(ACCESS.admin), ITEMS.map((item) => ({
    ...item, ...hidden, file: item.file === null ? null : { ...item.file, canDownloadRaw: false, canDownloadClean: false, canDeleteRaw: false },
  })));
  const rows = rowsOf(await table());
  // With no name, the item reads as its kind (in the item and the kind columns).
  expect(within(at(rows, 0)).getAllByText('CSV or text file')).toHaveLength(2);
  expect(within(at(rows, 1)).getAllByText('Excel file')).toHaveLength(2);
  expect(document.body.textContent).not.toContain('menu-notes.txt');
  for (const row of rows) expect(within(row).queryAllByRole('button')).toEqual([]);
  expect(document.getElementById('data-ro')?.textContent).toMatch(/^Read-only while viewing as /);
  expect(screen.getByRole('button', { name: 'Paste text' }).getAttribute('aria-disabled')).toBe('true');
  const all = screen.getByRole('button', { name: 'Delete all originals for this location' });
  expect([all.getAttribute('aria-disabled'), all.getAttribute('aria-describedby')]).toEqual(['true', 'data-ro']);
  // Opening is a read: each row stays a working link, named by its kind and its days, or when it was added.
  const open = within(at(rows, 0)).getByRole('link', { name: 'CSV or text file, added Nov 5, 2026' });
  expect([open.getAttribute('href'), open.getAttribute('aria-disabled')]).toEqual(['/locations/l1/data/f_ref', null]);
  expect(within(at(rows, 1)).getByRole('link', { name: 'Excel file, Jan 1, 2024 to Dec 31, 2025' })).toBeTruthy();
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
  expect(screen.getByText(/^Sales uploads, calendars, files and text your team added for Test Group\./)).toBeTruthy();
  cleanup();
  setup(meOf(ACCESS.admin), [], one);
  expect(await screen.findByText('Nothing here yet. What your team uploads or adds for Test Group shows here.')).toBeTruthy();
  expect(screen.queryByText(/Main Street Bar/)).toBeNull();
});

test('with one location the Delete all originals dialog names the organization (D29)', async () => {
  const one = { org: orgOf('org_admin', LOCATIONS.slice(0, 1)) };
  setup(meOf(ACCESS.admin), ITEMS, one);
  await table('Your data for Test Group');
  fireEvent.click(screen.getByRole('button', { name: 'Delete all originals for this location' }));
  const originals = await screen.findByRole('dialog', { name: 'Delete all originals for this location' });
  expect(within(originals).getByText(/^This deletes the original of every sales file for Test Group\./)).toBeTruthy();
  expect(screen.queryByText(/Main Street Bar/)).toBeNull();
});

test('stored files off: no Add a file or Paste text, and the list still shows uploads', async () => {
  const fake = setup(meOf(ACCESS.admin), [dailyTotalsOf('u_1')], { files: 'off' });
  const rows = rowsOf(await table());
  expect(rows).toHaveLength(1);
  expect(within(at(rows, 0)).getByRole('link', { name: 'Daily totals, May 1, 2026 to May 10, 2026' })).toBeTruthy();
  await waitFor(() => { expect(fake.files.calls.some((call) => call.path === '/files')).toBe(true); });
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
  await waitFor(() => { expect(headingHasFocus(notice)).toBe(true); });
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
  await waitFor(() => { expect(headingHasFocus(notice)).toBe(true); });
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

test('a sales file whose original was deleted says so; an item kept for reference claims no cleaned copy', async () => {
  const gone = { rawAvailable: false, canDownloadRaw: false, canDeleteRaw: false } as const;
  setup(meOf(ACCESS.admin), ITEMS.map((item) => ({ ...item, file: item.file === null ? null : { ...item.file, ...gone } })));
  const rows = rowsOf(await table());
  expect(within(at(rows, 1)).getByText('The original was deleted. The cleaned copy and days stay.')).toBeTruthy();
  expect(within(at(rows, 0)).queryByText(/The original was deleted/)).toBeNull();
  expect(within(at(rows, 2)).queryByText(/The original was deleted/)).toBeNull();
});

test('after Delete all originals, the organization is read again once the page closes, not before', async () => {
  setup(meOf(ACCESS.admin));
  await table();
  const before = orgReads();
  fireEvent.click(screen.getByRole('button', { name: 'Delete all originals for this location' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete all originals for this location' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete all originals for this location' }));
  await screen.findByText('Deleted 0 originals.');
  expect(orgReads()).toBe(before);
  // The page hands focus to its notice; once that lands, More opens and stays open (focus leaving it closes it).
  await settle(() => undefined);
  const notes = within(openMore()).getByRole('link', { name: 'Notes' });
  await settle(() => { fireEvent.click(notes); });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/notes'); });
  await waitFor(() => { expect(orgReads()).toBe(before + 1); });
});

test('leaving with nothing changed reads the organization no more', async () => {
  setup(meOf(ACCESS.admin));
  await table();
  const before = orgReads();
  const notes = within(openMore()).getByRole('link', { name: 'Notes' });
  await settle(() => { fireEvent.click(notes); });
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
  fireEvent.click(screen.getByRole('button', { name: 'Delete all originals for this location' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete all originals for this location' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete all originals for this location' }));
  expect(await screen.findByText('Deleted 0 originals.')).toBeTruthy();
  expect(await screen.findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  fake.answers = {};
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => { expect(rowsOf(screen.getByRole('table'))).toHaveLength(3); });
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
  // The row's own control only opens the list: the press doesn't also open the item's page.
  await settle(() => { fireEvent.click(screen.getByRole('button', { name: 'See what’s inside' })); });
  expect(await screen.findByText('a/day-0.csv')).toBeTruthy();
  expect(window.location.pathname).toBe('/locations/l1/data');
  // A press on an entry inside the list stays in the list too.
  await settle(() => { fireEvent.click(screen.getByText('a/day-0.csv')); });
  expect(window.location.pathname).toBe('/locations/l1/data');
  expect(screen.getByText('a/day-0.csv')).toBeTruthy();
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

// D61: one list. Calendars are items of it (D49's pages, `c_<id>`), "Organized" shows folders by default, and the View
// switch to "Newest first" is remembered in this browser per person signed in.
const KITCHEN = ownerCalendar({ id: '0123456789abcdef01234567', label: 'Kitchen', kind: 'file', eventCount: 12, createdAt: '2026-11-01T15:00:00.000Z' });
const HOLIDAYS = ownerCalendar({
  id: 'fedcba9876543210fedcba98', label: 'US holidays', kind: 'link', host: 'calendar.google.com', eventCount: 11, createdAt: '2026-11-06T15:00:00.000Z',
});

/** Items the API filed (D61), one in a folder this client doesn't know. */
const FILED: DataItem[] = [
  itemOf('f_menu', { name: 'menu-notes.txt', state: 'kept', outcome: 'reference', folder: 'menus' }),
  itemOf('f_photo', { name: 'photo.jpg', kind: 'other', state: 'kept', outcome: 'reference', folder: 'unsorted' }),
  itemOf('f_later', { name: 'later.txt', state: 'kept', outcome: 'reference', folder: 'a_folder_from_later' }),
  dailyTotalsOf('u_1', { folder: 'sales' }),
  dailyTotalsOf('u_2', { folder: 'sales', days: { count: 3, inUse: 3, firstDate: '2026-04-01', lastDate: '2026-04-03' } }),
];

/** Three items, each a second older than the one before, and all newer than KITCHEN. */
const THREE: DataItem[] = Array.from({ length: 3 }, (_, index) => itemOf(`f_${String(index)}`, {
  name: `file-${String(index)}.txt`, file: null, addedAt: `2026-11-05T15:00:0${String(5 - index)}.000Z`,
}));

async function folderList(name = 'Folders, Your data for Main Street Bar'): Promise<HTMLElement> {
  return screen.findByRole('list', { name });
}

function folderButton(name: RegExp | string): HTMLElement {
  return screen.getByRole('button', { name });
}

test('Organized is the default: the folders in order, each a closed button naming its count', async () => {
  setup(meOf(ACCESS.admin), FILED, { view: 'organized', calendars: [KITCHEN] });
  const folders = await folderList();
  const buttons = within(folders).getAllByRole('button');
  expect(buttons.map((button) => [button.getAttribute('aria-label'), button.getAttribute('aria-expanded')])).toEqual([
    ['Sales, 2 items', 'false'], ['Calendars, 1 item', 'false'], ['Menus and recipes, 1 item', 'false'], ['Inventory and orders, 0 items', 'false'],
    ['Staffing, 0 items', 'false'], ['Notes and pasted text, 0 items', 'false'], ['Other, 0 items', 'false'], ['Not sorted yet, 2 items', 'false'],
  ]);
  // Each shows its name and count, and is a tab stop.
  expect(within(at(buttons, 0)).getByText('Sales')).toBeTruthy();
  expect(within(at(buttons, 0)).getByText('2')).toBeTruthy();
  expect(buttons.every((button) => button.tabIndex === 0)).toBe(true);
  expect(screen.queryByRole('table')).toBeNull();
  const group = screen.getByRole('radiogroup', { name: 'View' });
  expect(within(group).getAllByRole('radio').map((radio) => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([
    ['Organized', 'true'], ['Newest first', 'false'],
  ]);
  // No separate Calendars group or uploads heading any more.
  expect(screen.queryByRole('heading', { name: 'Calendars' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Uploads and files' })).toBeNull();
  expect(screen.queryByRole('list', { name: 'Calendars' })).toBeNull();
});

test('a folder opens its own table in place, under its button, and closes again; an empty one says so', async () => {
  setup(meOf(ACCESS.admin), FILED, { view: 'organized', calendars: [KITCHEN] });
  await folderList();
  const sales = folderButton('Sales, 2 items');
  await settle(() => { fireEvent.click(sales); });
  expect(sales.getAttribute('aria-expanded')).toBe('true');
  const region = await table('Sales, Your data for Main Street Bar');
  // aria-controls names the opened part, which holds the table.
  const controlled = document.getElementById(sales.getAttribute('aria-controls') ?? '');
  expect(controlled?.contains(region)).toBe(true);
  expect(sales.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(rowsOf(region).map((row) => within(row).getAllByRole('link')[0]?.getAttribute('href'))).toEqual(['/locations/l1/data/u_1', '/locations/l1/data/u_2']);
  // A calendar is its folder's item, opening its page.
  await settle(() => { fireEvent.click(folderButton('Calendars, 1 item')); });
  const calendars = await table('Calendars, Your data for Main Street Bar');
  const link = within(calendars).getByRole('link', { name: 'Kitchen. File, 12 events' });
  expect(link.getAttribute('href')).toBe('/locations/l1/data/c_0123456789abcdef01234567');
  expect(within(calendars).getByText('Calendar')).toBeTruthy();
  // An empty folder, and Not sorted yet, which says how Townwise files an item and holds an unknown folder's item.
  await settle(() => { fireEvent.click(folderButton('Staffing, 0 items')); });
  expect(screen.getByText('Nothing in this folder yet.')).toBeTruthy();
  await settle(() => { fireEvent.click(folderButton('Not sorted yet, 2 items')); });
  expect(screen.getByText(/^Townwise files an item once it knows what it is/)).toBeTruthy();
  const unsorted = await table('Not sorted yet, Your data for Main Street Bar');
  expect(within(unsorted).getByRole('link', { name: 'later.txt' })).toBeTruthy();
  await settle(() => { fireEvent.click(sales); });
  expect(sales.getAttribute('aria-expanded')).toBe('false');
  expect(sales.getAttribute('aria-controls')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Sales, Your data for Main Street Bar' })).toBeNull();
  // Opening is a read: a row of an open folder opens its page.
  await settle(() => { fireEvent.click(link); });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/data/c_0123456789abcdef01234567'); });
});

test('Newest first is one table, calendars among the items by when they were added, each a Calendar with its events', async () => {
  setup(meOf(ACCESS.member), ITEMS, { calendars: [KITCHEN, HOLIDAYS] });
  const rows = rowsOf(await table());
  expect(rows).toHaveLength(5);
  // US holidays (Nov 6) is newest, the items (Nov 5) next, Kitchen (Nov 1) last.
  const holidays = within(at(rows, 0)).getByRole('link', { name: 'US holidays. Link, calendar.google.com, 11 events' });
  expect(holidays.getAttribute('href')).toBe('/locations/l1/data/c_fedcba9876543210fedcba98');
  expect(within(at(rows, 0)).getByText('Calendar')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('Nov 6, 2026')).toBeTruthy();
  expect(within(at(rows, 4)).getByRole('link', { name: 'Kitchen. File, 12 events' })).toBeTruthy();
  expect(within(at(rows, 4)).getByText('File, 12 events')).toBeTruthy();
  // The host is text, and no link holds a calendar's address.
  expect(within(at(rows, 0)).getAllByRole('link')).toHaveLength(1);
  expect(screen.queryByRole('list', { name: /^Folders/ })).toBeNull();
});

test('Newest first holds back a calendar older than the items loaded until Show older items reaches it', async () => {
  setup(meOf(ACCESS.admin), THREE, { calendars: [KITCHEN], pageSize: 2 });
  expect(rowsOf(await table())).toHaveLength(2);
  expect(screen.queryByRole('link', { name: 'Kitchen. File, 12 events' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
  await waitFor(() => { expect(rowsOf(screen.getByRole('table'))).toHaveLength(4); });
  expect(within(at(rowsOf(screen.getByRole('table')), 3)).getByRole('link', { name: 'Kitchen. File, 12 events' })).toBeTruthy();
});

test('Organized while older items are still to load holds every calendar and says its counts are of what is shown', async () => {
  setup(meOf(ACCESS.admin), THREE, { view: 'organized', calendars: [KITCHEN], pageSize: 2 });
  await folderList();
  expect(screen.getByText('The folders count the items shown so far. Show older items below sorts in the rest.')).toBeTruthy();
  expect(folderButton('Not sorted yet, 2 items')).toBeTruthy();
  expect(folderButton('Calendars, 1 item')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
  await waitFor(() => { expect(screen.queryByText(/^The folders count the items shown so far/)).toBeNull(); });
  expect(folderButton('Not sorted yet, 3 items')).toBeTruthy();
});

test('the View is one tab stop; the arrows move it; Newest first is remembered in this browser for the person', async () => {
  setup(meOf(ACCESS.admin), ITEMS, { view: 'organized' });
  const group = await screen.findByRole('radiogroup', { name: 'View' });
  const organized = within(group).getByRole('radio', { name: 'Organized' });
  const newest = within(group).getByRole('radio', { name: 'Newest first' });
  expect([organized.tabIndex, newest.tabIndex]).toEqual([0, -1]);
  await settle(() => { fireEvent.keyDown(organized, { key: 'ArrowRight' }); });
  expect(newest.getAttribute('aria-checked')).toBe('true');
  expect([organized.tabIndex, newest.tabIndex]).toEqual([-1, 0]);
  expect(document.activeElement).toBe(newest);
  expect(rowsOf(await table())).toHaveLength(3);
  expect(window.localStorage.getItem('townwise.dataView.u1')).toBe('newest');
  // Another visit opens Newest first.
  cleanup();
  setup(meOf(ACCESS.admin), ITEMS, { view: 'organized' });
  expect(rowsOf(await table())).toHaveLength(3);
  await settle(() => { fireEvent.click(screen.getByRole('radio', { name: 'Organized' })); });
  expect(await folderList()).toBeTruthy();
  expect(window.localStorage.getItem('townwise.dataView.u1')).toBe('organized');
});

test('the View is each signed-in person’s own, and the person viewing as keeps theirs, with folders working read-only', async () => {
  window.localStorage.setItem('townwise.dataView.u2', 'newest');
  setup(meOf(ACCESS.admin), ITEMS, { view: 'organized' });
  expect(await folderList()).toBeTruthy();
  cleanup();
  // Staff viewing as someone: their own pick (s1), and the folders and the switch work under view-as.
  setup(viewAsMe(ACCESS.admin), FILED, { view: 'organized' });
  await folderList();
  await settle(() => { fireEvent.click(folderButton('Sales, 2 items')); });
  expect(rowsOf(await table('Sales, Your data for Main Street Bar'))).toHaveLength(2);
  await settle(() => { fireEvent.click(screen.getByRole('radio', { name: 'Newest first' })); });
  expect(window.localStorage.getItem('townwise.dataView.s1')).toBe('newest');
  expect(window.localStorage.getItem('townwise.dataView.u1')).toBeNull();
});

test('storage that throws: the page opens Organized and the View still switches', async () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  setup(meOf(ACCESS.admin), ITEMS, { view: 'organized' });
  expect(await folderList()).toBeTruthy();
  await settle(() => { fireEvent.click(screen.getByRole('radio', { name: 'Newest first' })); });
  expect(rowsOf(await table())).toHaveLength(3);
});

test('nothing yet, calendars included: the empty line in place of the folders', async () => {
  setup(meOf(ACCESS.admin), [], { view: 'organized' });
  expect(await screen.findByText('Nothing here yet. What your team uploads or adds for Main Street Bar shows here.')).toBeTruthy();
  expect(screen.queryByRole('list', { name: /^Folders/ })).toBeNull();
  cleanup();
  setup(meOf(ACCESS.admin), [], { view: 'organized', calendars: [KITCHEN] });
  expect(within(await folderList()).getByRole('button', { name: 'Calendars, 1 item' })).toBeTruthy();
});

test('Import a calendar file stays at the top of the list, with no calendar and with stored files off (D60)', async () => {
  setup(meOf(ACCESS.member));
  const region = await table();
  const button = screen.getByRole('button', { name: 'Import a calendar file' });
  expect(button.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button.compareDocumentPosition(screen.getByRole('radiogroup', { name: 'View' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText('No calendars yet.')).toBeNull();
  cleanup();
  setup(meOf(ACCESS.member), ITEMS, { files: 'off', calendars: [KITCHEN] });
  expect(within(await table()).getByRole('link', { name: 'Kitchen. File, 12 events' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Import a calendar file' })).toBeTruthy();
});

/** The calendar import's file input (Add a file has its own), and a chosen file whose text is `text` (jsdom's Blob lacks it). */
function chooseCalendarFile(name: string, text: string, size?: number): void {
  const input = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find((each) => each.accept.includes('.ics'));
  if (input === undefined) throw new Error('no calendar file input');
  const file = new File(['x'], name, { type: 'text/calendar' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  fireEvent.change(input, { target: { files: [file] } });
}

test('Import a calendar file posts the file as Your calendars does, says what it did, and the list reads fresh with it (D60)', async () => {
  const fake = setup(meOf(ACCESS.member));
  await table();
  const reads = fake.lists.length;
  const button = screen.getByRole('button', { name: 'Import a calendar file' });
  // Described by the weekly reading's words it sends `titlesNotice` for.
  const help = screen.getByText(/^Once a week TownwiseAI reads the titles/);
  expect(button.getAttribute('aria-describedby')).toBe(help.id);
  chooseCalendarFile('Front desk.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  expect(await screen.findByText('Added Front desk: 2 events.')).toBeTruthy();
  expect(fake.calendarAdds).toEqual([{ kind: 'file', label: 'Front desk', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', titlesNotice: 1 }]);
  await waitFor(() => { expect(fake.lists.length).toBe(reads + 1); });
  const link = await within(await table()).findByRole('link', { name: /^Front desk\./ });
  expect(link.getAttribute('href')).toBe('/locations/l1/data/c_c1');
});

test('a refused import says why at the top of the list and adds nothing; a file over 1 MB is refused unread (D60)', async () => {
  const fake = setup(meOf(ACCESS.member));
  await table();
  fake.answers['POST owner-calendars'] = () => refusal(409, 'calendar_limit');
  chooseCalendarFile('Late.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  expect(await screen.findByText('This location has 5 calendars, the most it can hold. Remove one to add another.')).toBeTruthy();
  chooseCalendarFile('Big.ics', '', 1024 * 1024 + 1);
  expect(await screen.findByText('This file is over 1 MB. Export a shorter range of your calendar, or a CSV with fewer columns.')).toBeTruthy();
  expect(fake.calendarAdds).toHaveLength(1);
  expect(within(await table()).queryByRole('link', { name: /^Late/ })).toBeNull();
});

test('under view-as Import a calendar file stays in place, disabled, described by the read-only line (D60)', async () => {
  const fake = setup(viewAsMe(ACCESS.member));
  await table();
  const button = screen.getByRole('button', { name: 'Import a calendar file' });
  expect(button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled).toBe(true);
  expect((button.getAttribute('aria-describedby') ?? '').split(' ')).toContain('data-ro');
  expect(fake.calendarAdds).toEqual([]);
});

test('a fresh read of the list (text saved) shows a calendar the API imported meanwhile (D60)', async () => {
  const fake = setup(meOf(ACCESS.member));
  expect(rowsOf(await table())).toHaveLength(3);
  // The API imported a calendar file meanwhile; saving pasted text reads the list fresh, as a stored file does.
  fake.calendars = [KITCHEN];
  fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
  fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Winter hours' } });
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Closed Mondays.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await within(await table()).findByRole('link', { name: 'Kitchen. File, 12 events' })).toBeTruthy();
});
