import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../../src/api/client';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import {
  ACCESS, deferred, EMAIL, fakePortalApi, LOCATIONS, meOf, offline, orgOf, refusal, TARGET_EMAIL, viewAsMe, writes, type FakePortalApi,
} from '../../helpers/portal';
import { choicesOf, choose as pick, shownChoice } from '../../helpers/select';

// P13 on the web, through the whole app: choose a file, match columns, check the totals, send. Every file here is
// synthetic. A sentinel name sits in the cells of every file and must never reach the screen (D11) or the request
// (11.1), except a location column's values once the person names that column.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide, which is a phone to react-native-web; these tests cover the desktop layout.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

afterEach(() => {
  cleanup();
});

const PATH = '/locations/l1/sales/upload';
const UPLOAD = '/api/org/locations/l1/sales/uploads';
const SENTINEL = 'Zelda Sentinelname';

const FILE = [
  'Business Date,Customer,Guest Count,Net Sales,Server',
  `2025-03-04,${SENTINEL},120,"$1,000.25",${SENTINEL}`,
  `2025-03-05,${SENTINEL},90,980.00,${SENTINEL}`,
  `2025-03-06,${SENTINEL},101,(12.00),${SENTINEL}`,
  `2025-03-07,${SENTINEL},88,750.5,${SENTINEL}`,
  `Total,${SENTINEL},399,"$2,718.75",${SENTINEL}`,
].join('\n');

const DAYS = [
  { date: '2025-03-04', guests: 120, netSalesCents: 100_025 },
  { date: '2025-03-05', guests: 90, netSalesCents: 98_000 },
  { date: '2025-03-07', guests: 88, netSalesCents: 75_050 },
];

function renderAt(api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', PATH);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={PATH} />
    </Head.Provider>,
  );
}

function adminApi(): FakePortalApi {
  return fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
}

function memberApi(): FakePortalApi {
  return fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
}

function csvFile(text: string, name = 'export.csv', options?: { size?: number; text?: () => Promise<string> }): File {
  const file = new File([text], name, { type: 'text/csv' });
  // jsdom's Blob has no text(); the page reads files with File.text() (spec 11.1).
  Object.defineProperty(file, 'text', { value: options?.text ?? (() => Promise.resolve(text)) });
  if (options?.size !== undefined) Object.defineProperty(file, 'size', { value: options.size });
  return file;
}

function fileInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[type="file"]');
}

/** Fires an event and lets the reads and writes it starts settle inside act. */
async function settle(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

function click(name: string): Promise<void> {
  return settle(() => { fireEvent.click(screen.getByRole('button', { name })); });
}

async function choose(file: File): Promise<void> {
  await screen.findByRole('heading', { name: 'Choose a file' });
  const input = fileInput();
  if (input === null) throw new Error('no file input');
  await settle(() => { fireEvent.change(input, { target: { files: [file] } }); });
}

async function toMatch(file: File): Promise<void> {
  await choose(file);
  await screen.findByRole('heading', { name: 'Match columns' });
}

async function toCheck(file: File): Promise<void> {
  await toMatch(file);
  await click('Check the totals');
  await screen.findByRole('heading', { name: 'Check the totals' });
}

function select(name: string): HTMLElement {
  return screen.getByRole('combobox', { name });
}

function optionsOf(name: string): string[] {
  return choicesOf(select(name));
}

function answerFor(counts: { dayCount: number; inserted: number; replaced: number; kept: number }): () => unknown {
  return () => ({
    upload: {
      id: 'up1', uploadedAt: '2026-11-04T15:00:00.000Z', uploadedByEmail: EMAIL, status: 'applied', ...counts,
      firstDate: '2025-03-04', lastDate: '2025-03-07', hasGuests: true, hasNetSales: true,
    },
    coverage: { dayCount: 402, guestsDayCount: 402, netSalesDayCount: 382, firstDate: '2025-01-01', lastDate: '2026-02-04', missingDays: 0 },
    calibration: { state: 'not_calibrated', dayCount: 402, firstDate: '2025-01-01', lastDate: '2026-02-04' },
  });
}

function orgReads(api: FakePortalApi): number {
  return api.calls.filter((call) => call.method === 'GET' && call.path === '/api/org').length;
}

function pageText(): string {
  return document.body.textContent;
}

test('step 1: the four steps, what is sent, and an outline Choose a CSV file', async () => {
  renderAt(adminApi());
  expect(await screen.findByRole('heading', { name: 'Upload sales history' })).toBeTruthy();
  expect(screen.getByText('Step 1 of 4: Choose a file, Match columns, Check the totals, Send.')).toBeTruthy();
  expect(screen.getByText(/^Export a daily sales summary from your point-of-sale system as a CSV file\./)).toBeTruthy();
  expect(screen.getByText('A .csv or .txt file up to 50 MB, separated by commas, semicolons or tabs.')).toBeTruthy();
  // The location column's values do show once that column is named, so no line says cells never show.
  expect(screen.getByText(/Townwise shows column names, not what’s in the cells\. Only a location column’s values show, once you name that column\.$/)).toBeTruthy();
  expect(pageText()).not.toMatch(/never (what’s in|shows what’s in)/);
  expect(screen.getByRole('button', { name: 'Choose a CSV file' }).getAttribute('aria-disabled')).toBeNull();
  expect(fileInput()?.getAttribute('accept')).toBe('.csv,.txt,text/csv,text/plain');
  expect(screen.queryByText(/\[CONFIRM|\[DECISION NEEDED/)).toBeNull();
});

test('an org admin’s upload: match, check, send one body of days, and the replace-by-day result', async () => {
  const api = adminApi();
  api.answers[UPLOAD] = answerFor({ dayCount: 3, inserted: 2, replaced: 1, kept: 0 });
  renderAt(api);
  await toMatch(csvFile(FILE));
  expect(screen.getByText('Step 2 of 4: Choose a file, Match columns, Check the totals, Send.')).toBeTruthy();
  // Header guesses preselect the pickers; each lists header names with their kind, never a cell.
  expect(shownChoice(select('Date'))).toBe('Business Date: dates');
  expect(shownChoice(select('Guests'))).toBe('Guest Count: numbers');
  expect(shownChoice(select('Net sales'))).toBe('Net Sales: numbers');
  expect(optionsOf('Date')).toEqual(['Choose a column', 'Business Date: dates', 'Customer: text', 'Guest Count: numbers', 'Net Sales: numbers', 'Server: text']);
  expect(optionsOf('Guests')[0]).toBe('Not in this file');
  expect(pageText()).not.toContain(SENTINEL);
  expect(screen.getByText(/Cell values stay hidden, except a location column’s once you name it\.$/)).toBeTruthy();
  expect(pageText()).not.toMatch(/never (what’s in|shows what’s in)/);

  await click('Check the totals');
  await screen.findByRole('heading', { name: 'Check the totals' });
  expect(screen.getByText('3 rows became 3 days, Mar 4, 2025 to Mar 7, 2025.')).toBeTruthy();
  expect(screen.getByText('1 row had no readable date (row 6).')).toBeTruthy();
  expect(screen.getByText('A negative daily total')).toBeTruthy();
  expect(screen.getByText('298')).toBeTruthy();
  expect(screen.getByText('$2,731')).toBeTruthy();
  expect(screen.getByText('Check these against your point-of-sale system.')).toBeTruthy();
  expect(screen.getByText('You already have Jan 1, 2025 to Feb 4, 2026. Days in both will be replaced by this file.')).toBeTruthy();
  const preview = screen.getByRole('region', { name: 'First 3 days' });
  expect(preview).toBeTruthy();
  // The group label prints once, above the table; the date column is headed Date, so stacked rows do not repeat it.
  expect(screen.getAllByText('First 3 days')).toHaveLength(1);
  expect(within(preview).getByRole('columnheader', { name: 'Date' })).toBeTruthy();
  expect(pageText()).not.toContain(SENTINEL);

  await click('Send 3 days');
  expect(await screen.findByText('Saved 3 days for Main Street Bar: 2 new, 1 replaced.')).toBeTruthy();
  expect(screen.getByText('Your sales history is in: 402 days, Jan 1, 2025 to Feb 4, 2026.')).toBeTruthy();
  expect(screen.getByText('Step 4 of 4: Choose a file, Match columns, Check the totals, Send.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'See your sales data' }).getAttribute('href')).toBe('/locations/l1/sales');
  expect(screen.getByRole('link', { name: 'Add notes for unusual days' }).getAttribute('href')).toBe('/locations/l1/notes');
  // One request, with { days } and nothing else.
  expect(writes(api)).toEqual([{ method: 'POST', path: UPLOAD, body: { days: DAYS } }]);
  expect(JSON.stringify(writes(api))).not.toContain(SENTINEL);
  // The file is gone: no control holds it and no step can go back to it.
  expect(fileInput()).toBeNull();
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
});

test('a member’s upload adds new days only, with the member copy before and after', async () => {
  const api = memberApi();
  api.answers[UPLOAD] = answerFor({ dayCount: 3, inserted: 2, replaced: 0, kept: 1 });
  renderAt(api);
  await toCheck(csvFile(FILE));
  expect(screen.getByText('You already have Jan 1, 2025 to Feb 4, 2026. Days you already have stay as they are. Only an admin can replace them.')).toBeTruthy();
  await click('Send 3 days');
  expect(await screen.findByText('Saved 2 new days for Main Street Bar.')).toBeTruthy();
  expect(screen.getByText('1 day already had data. Ask an admin to replace it.')).toBeTruthy();
});

test('view-as: Choose a CSV file is disabled and no file control exists, so no client file is read', async () => {
  renderAt(fakePortalApi({ me: viewAsMe(ACCESS.member), org: orgOf('member') }));
  await screen.findByRole('heading', { name: 'Choose a file' });
  const button = screen.getByRole('button', { name: 'Choose a CSV file' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.hasAttribute('disabled')).toBe(false);
  const line = screen.getByText(`Read-only while viewing as ${TARGET_EMAIL}.`);
  expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(line.getAttribute('id'));
  expect(fileInput()).toBeNull();
  fireEvent.click(button);
  expect(screen.getByRole('heading', { name: 'Choose a file' })).toBeTruthy();
});

test('the item-level choice blocks Check the totals, and one check or order adds rows up', async () => {
  renderAt(adminApi());
  await toMatch(csvFile(FILE));
  await click('One item on a check');
  const message = await screen.findByText('Item-level exports aren’t supported. Export daily totals or checks, not items.');
  const check = screen.getByRole('button', { name: 'Check the totals' });
  expect(check.getAttribute('aria-disabled')).toBe('true');
  expect(check.getAttribute('aria-describedby')).toContain('upload-row-msgs');
  expect(message.closest('#upload-row-msgs')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'One item on a check' }).getAttribute('aria-pressed')).toBe('true');
  await click('One check or order');
  expect(await screen.findByText('We add up rows that share a date.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check the totals' }).getAttribute('aria-disabled')).toBeNull();
});

test('guests, net sales or both: neither blocks Check the totals', async () => {
  renderAt(adminApi());
  await toMatch(csvFile(FILE));
  pick(select('Guests'), 'Not in this file');
  pick(select('Net sales'), 'Not in this file');
  expect(await screen.findByText('Choose a guests column, a net sales column, or both.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check the totals' }).getAttribute('aria-disabled')).toBe('true');
  pick(select('Net sales'), 'Net Sales: numbers');
  await waitFor(() => { expect(screen.queryByText('Choose a guests column, a net sales column, or both.')).toBeNull(); });
});

test('slash dates: the order is the person’s to confirm, unless a part above 12 sets it', async () => {
  renderAt(adminApi());
  await toMatch(csvFile('Date,Guests\n03/04/2025,5\n04/05/2025,6'));
  expect(screen.getByRole('button', { name: 'Month first (03/04/2025 is March 4, 2025)' }).getAttribute('aria-pressed')).toBe('true');
  await click('Day first (03/04/2025 is April 3, 2025)');
  await click('Check the totals');
  expect(await screen.findByText('2 rows became 2 days, Apr 3, 2025 to May 4, 2025.')).toBeTruthy();
  await click('Back');
  await screen.findByRole('heading', { name: 'Match columns' });
  await click('Back');
  await toMatch(csvFile('Date,Guests\n03/04/2025,5\n25/12/2025,6'));
  // Set and shown, not offered.
  expect(screen.getByText('Day first (03/04/2025 is April 3, 2025)')).toBeTruthy();
  expect(screen.getByText('Set from the dates in this file.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Month first/ })).toBeNull();
  await click('Check the totals');
  expect(await screen.findByText('2 rows became 2 days, Apr 3, 2025 to Dec 25, 2025.')).toBeTruthy();
});

test('slash dates that prove both orders: the person chooses, and the page says why', async () => {
  renderAt(adminApi());
  await toMatch(csvFile('Date,Guests\n13/02/2025,5\n02/13/2025,6\n01/01/2025,7'));
  expect(screen.queryByText('Set from the dates in this file.')).toBeNull();
  const why = screen.getByText('Some dates in this column work only day first, and others only month first. Choose the order. Rows whose date doesn’t fit it are skipped.');
  const dayFirst = screen.getByRole('button', { name: 'Day first (03/04/2025 is April 3, 2025)' });
  expect(dayFirst.getAttribute('aria-describedby')).toBe(why.id);
  await click('Day first (03/04/2025 is April 3, 2025)');
  await click('Check the totals');
  expect(await screen.findByText('2 rows became 2 days, Jan 1, 2025 to Feb 13, 2025.')).toBeTruthy();
  expect(screen.getByText('1 row had no readable date (row 3).')).toBeTruthy();
});

test('a location column lists its values, the only cells shown, and other locations’ rows are left out', async () => {
  const text = [
    'Date,Store,Customer,Guests',
    `2025-03-04,Main Street Bar,${SENTINEL},10`,
    `2025-03-04,Elm Street Cafe,${SENTINEL},20`,
    `2025-03-05, Main Street Bar ,${SENTINEL},11`,
  ].join('\n');
  const api = adminApi();
  api.answers[UPLOAD] = answerFor({ dayCount: 2, inserted: 2, replaced: 0, kept: 0 });
  renderAt(api);
  await toMatch(csvFile(text));
  expect(pageText()).not.toContain('Elm Street Cafe');
  // Opening the list needs its own act, so the pick runs outside settle, which then waits out the file read.
  pick(select('Location column (optional)'), 'Store: text');
  await settle(() => undefined);
  const values = await screen.findByRole('combobox', { name: 'Which value is Main Street Bar?' });
  expect(optionsOf('Which value is Main Street Bar?')).toEqual(['Choose a value', 'Elm Street Cafe', 'Main Street Bar']);
  await waitFor(() => { expect(shownChoice(values)).toBe('Main Street Bar'); });
  expect(pageText()).not.toContain(SENTINEL);
  await click('Check the totals');
  expect(await screen.findByText('1 row was for another location.')).toBeTruthy();
  await click('Send 2 days');
  await screen.findByText('Saved 2 days for Main Street Bar: 2 new, 0 replaced.');
  expect(writes(api)[0]?.body).toEqual({ days: [{ date: '2025-03-04', guests: 10, netSalesCents: null }, { date: '2025-03-05', guests: 11, netSalesCents: null }] });
});

test('a location column whose values don’t include the location’s name waits for a choice', async () => {
  renderAt(adminApi());
  await toMatch(csvFile('Date,Store,Guests\n2025-03-04,Store 1,10\n2025-03-04,Store 2,20'));
  // Opening the list needs its own act, so the pick runs outside settle, which then waits out the file read.
  pick(select('Location column (optional)'), 'Store: text');
  await settle(() => undefined);
  expect(await screen.findByText('Choose which value is Main Street Bar.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check the totals' }).getAttribute('aria-disabled')).toBe('true');
  pick(select('Which value is Main Street Bar?'), 'Store 2');
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Check the totals' }).getAttribute('aria-disabled')).toBeNull(); });
});

test('while a location column’s values are read, Check the totals is described only by messages on the page', async () => {
  const text = 'Date,Store,Guests\n2025-03-04,Store 1,10\n2025-03-04,Store 2,20';
  const later = deferred<string>();
  let reads = 0;
  renderAt(adminApi());
  await toMatch(csvFile(text, 'export.csv', { text: () => { reads += 1; return reads === 1 ? Promise.resolve(text) : later.promise; } }));
  // Opening the list needs its own act, so the pick runs outside settle, which then waits out the file read.
  pick(select('Location column (optional)'), 'Store: text');
  await settle(() => undefined);
  expect(screen.getByText('Reading 1 KB file…')).toBeTruthy();
  const check = screen.getByRole('button', { name: 'Check the totals' });
  expect(check.getAttribute('aria-disabled')).toBe('true');
  const described = (check.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== '');
  for (const id of described) expect(document.getElementById(id)).not.toBeNull();
  await act(async () => { later.resolve(text); await later.promise; });
  const message = await screen.findByText('Choose which value is Main Street Bar.');
  expect(screen.getByRole('button', { name: 'Check the totals' }).getAttribute('aria-describedby')?.split(' ')).toContain('upload-location-msgs');
  expect(message.closest('#upload-location-msgs')).toBeTruthy();
});

test.each<[string, File, string]>([
  ['larger than 50 MB', csvFile('Date\n', 'export.csv', { size: 50 * 1024 * 1024 + 1 }), 'That file is larger than 50 MB.'],
  ['an Excel file', csvFile('PK', 'export.xlsx'), 'That doesn’t look like a CSV file. Excel file? Save it as CSV first.'],
  ['a spreadsheet renamed to .csv', csvFile('PK\u0003\u0004binary'), 'That doesn’t look like a CSV file. Excel file? Save it as CSV first.'],
  ['a file with no header row', csvFile('2025-03-04,12,980\n2025-03-05,9,700'), 'That file has no header row.'],
  ['an empty file', csvFile(''), 'That file has no header row.'],
  ['a file the browser can’t read', csvFile('x', 'export.csv', { text: () => Promise.reject(new Error('NotReadableError')) }), 'That file can’t be read. Choose it again.'],
])('step 1 refuses %s', async (_name, file, message) => {
  renderAt(adminApi());
  await choose(file);
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Choose a file' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose a CSV file' })).toBeTruthy();
});

test('a headerless file whose first row has a date and a name is refused, and no cell shows (D11)', async () => {
  renderAt(adminApi());
  await choose(csvFile(`2025-03-04,${SENTINEL},12,980.00\n2025-03-05,${SENTINEL},9,700.00`));
  expect(await screen.findByText('That file has no header row.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Match columns' })).toBeNull();
  expect(pageText()).not.toContain(SENTINEL);
});

test('“Reading {size} file…” shows while the file is read', async () => {
  const text = deferred<string>();
  renderAt(adminApi());
  await choose(csvFile(FILE, 'export.csv', { text: () => text.promise }));
  expect(await screen.findByText('Reading 1 KB file…')).toBeTruthy();
  await act(async () => { text.resolve(FILE); await text.promise; });
  expect(await screen.findByRole('heading', { name: 'Match columns' })).toBeTruthy();
});

test('check errors: repeated dates in one-day mode, and no readable date; Back returns to Match columns', async () => {
  renderAt(adminApi());
  await toCheck(csvFile('Date,Guests\n2025-03-04,1\n2025-03-04,2\n2025-03-05,3'));
  expect(screen.getByText('1 date appears more than once (row 3). Choose “One check or order”, or fix the file.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();
  await click('Back');
  pick(await screen.findByRole('combobox', { name: 'Date' }), 'Guests: numbers');
  await click('Check the totals');
  expect(await screen.findByText('No rows had a readable date. Check the Date column.')).toBeTruthy();
});

test('a semicolon file with 1.234 in net sales is stopped with a clear line, never sent as $1.23', async () => {
  const api = adminApi();
  renderAt(api);
  await toCheck(csvFile('Business Date;Guest Count;Net Sales\n2025-03-04;5;1.234\n2025-03-05;6;980'));
  expect(screen.getByText('The net sales in this file may use a comma for decimals, as in 1.234,50. Townwise reads only a dot for decimals, so it can’t be sure of these amounts. Export the file with a dot for decimals, then choose it again.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();
  expect(writes(api)).toEqual([]);
});

test('more than 3,660 days is refused', async () => {
  const lines = ['Date,Guests'];
  const start = Date.UTC(2012, 0, 1);
  for (let i = 0; i < 3661; i += 1) lines.push(`${new Date(start + i * 86_400_000).toISOString().slice(0, 10)},1`);
  renderAt(adminApi());
  await toCheck(csvFile(lines.join('\n')));
  expect(screen.getByText('This file covers more than 10 years. Upload up to 10 years at a time.')).toBeTruthy();
});

test('“Sending {days} days…”, then a 500 keeps the days so Send can run again', async () => {
  const api = adminApi();
  const first = deferred<unknown>();
  let calls = 0;
  api.answers[UPLOAD] = () => {
    calls += 1;
    return calls === 1 ? first.promise : answerFor({ dayCount: 3, inserted: 0, replaced: 3, kept: 0 })();
  };
  renderAt(api);
  await toCheck(csvFile(FILE));
  await click('Send 3 days');
  expect(await screen.findByText('Sending 3 days…')).toBeTruthy();
  await act(async () => { first.resolve(new ApiError('http', 'down', { status: 500 })); await first.promise; });
  expect(await screen.findByText('The upload didn’t finish, and some days may have saved. Send again. Days are never duplicated.')).toBeTruthy();
  await click('Send 3 days');
  expect(await screen.findByText('Saved 3 days for Main Street Bar: 0 new, 3 replaced.')).toBeTruthy();
  expect(writes(api).map((call) => call.body)).toEqual([{ days: DAYS }, { days: DAYS }]);
});

test('a network error or 429 uses the shared copy, and Try again sends the same days', async () => {
  const api = adminApi();
  let calls = 0;
  api.answers[UPLOAD] = () => {
    calls += 1;
    return calls === 1 ? offline() : calls === 2 ? refusal(429, 'rate_limited', 120) : answerFor({ dayCount: 3, inserted: 3, replaced: 0, kept: 0 })();
  };
  renderAt(api);
  await toCheck(csvFile(FILE));
  await click('Send 3 days');
  expect(await screen.findByText('Can’t reach Townwise. Check your connection and try again.')).toBeTruthy();
  await click('Try again');
  expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
  await click('Try again');
  expect(await screen.findByText('Saved 3 days for Main Street Bar: 3 new, 0 replaced.')).toBeTruthy();
});

test('a 404: the location isn’t available, with a way back to Locations, and nothing is sent again', async () => {
  const api = adminApi();
  api.answers[UPLOAD] = () => refusal(404, 'not_found');
  renderAt(api);
  await toCheck(csvFile(FILE));
  await click('Send 3 days');
  expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  // The page's own way back, not the top bar's Locations.
  const nav = screen.getByRole('navigation', { name: 'Main' });
  const back = screen.getAllByRole('link', { name: 'Locations' }).find((link) => !nav.contains(link));
  if (back === undefined) throw new Error('no way back to Locations');
  expect(back.getAttribute('href')).toBe('/dashboard');
  expect(orgReads(api)).toBe(1);
  // The organization's list may be stale; it is read again once the page closes.
  await settle(() => { fireEvent.click(back); });
  await waitFor(() => { expect(orgReads(api)).toBe(2); });
  expect(writes(api)).toHaveLength(1);
});

test('a 404 for an organization’s only location: Locations opens Locations, not the missing location again', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin', LOCATIONS.slice(0, 1)) });
  api.answers[UPLOAD] = () => refusal(404, 'not_found');
  renderAt(api);
  await toCheck(csvFile(FILE));
  // Deleted elsewhere while the person checked the totals.
  api.org = orgOf('org_admin', []);
  await click('Send 3 days');
  expect(await screen.findByText('This location isn’t available.')).toBeTruthy();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  const back = screen.getAllByRole('link', { name: 'Locations' }).find((link) => !nav.contains(link));
  if (back === undefined) throw new Error('no way back to Locations');
  // Locations redirects an organization with one location to it. The organization read when the page closes
  // must reach Locations first, so the person stays on Locations instead of going back to the missing location.
  await settle(() => { fireEvent.click(back); });
  expect(await screen.findByRole('heading', { name: 'Add your first location' })).toBeTruthy();
  expect(window.location.pathname).toBe('/dashboard');
  expect(screen.queryByText('This location isn’t available.')).toBeNull();
  expect(orgReads(api)).toBe(2);
  expect(writes(api)).toHaveLength(1);
});

test('a 404 that answers after the person left still reads the organization again', async () => {
  const api = adminApi();
  const answer = deferred<unknown>();
  api.answers[UPLOAD] = () => answer.promise;
  renderAt(api);
  await toCheck(csvFile(FILE));
  await click('Send 3 days');
  await screen.findByText('Sending 3 days…');
  await settle(() => { fireEvent.click(screen.getByRole('link', { name: 'Notes' })); });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/notes'); });
  expect(orgReads(api)).toBe(1);
  await act(async () => { answer.resolve(refusal(404, 'not_found')); await answer.promise; });
  await waitFor(() => { expect(orgReads(api)).toBe(2); });
});

test('one check or order: rows that share a date are added up, with net sales rounded once per day', async () => {
  const text = [
    'Date,Guests,Net Sales',
    '2025-03-04,2,10.005',
    '2025-03-04,3,10.005',
    '2025-03-05,4,5.00',
  ].join('\n');
  const api = adminApi();
  api.answers[UPLOAD] = answerFor({ dayCount: 2, inserted: 2, replaced: 0, kept: 0 });
  renderAt(api);
  await toMatch(csvFile(text));
  await click('One check or order');
  await click('Check the totals');
  expect(await screen.findByText('3 rows became 2 days, Mar 4, 2025 to Mar 5, 2025.')).toBeTruthy();
  expect(screen.getByText('We add up rows that share a date.')).toBeTruthy();
  await click('Send 2 days');
  await screen.findByText('Saved 2 days for Main Street Bar: 2 new, 0 replaced.');
  expect(writes(api)[0]?.body).toEqual({ days: [{ date: '2025-03-04', guests: 5, netSalesCents: 2001 }, { date: '2025-03-05', guests: 4, netSalesCents: 500 }] });
});

test('a 400 is a client bug: the shared request copy, and Try again starts over', async () => {
  const api = adminApi();
  api.answers[UPLOAD] = () => refusal(400, 'invalid_request');
  renderAt(api);
  await toCheck(csvFile(FILE));
  await click('Send 3 days');
  expect(await screen.findByText('Something went wrong with that request. Reload the page and try again.')).toBeTruthy();
  await click('Try again');
  expect(await screen.findByRole('heading', { name: 'Choose a file' })).toBeTruthy();
  expect(writes(api)).toHaveLength(1);
});
