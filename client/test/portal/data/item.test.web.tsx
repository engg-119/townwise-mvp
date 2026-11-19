import '../../viewer/setup';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot, router } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { HistoryUpload, SalesHistory } from '../../../src/portal/analytics/api';
import type { DataItem } from '../../../src/portal/data/api';
import type { MeResponse, OrgResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, LOCATIONS, meOf, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { choicesOf, choose } from '../../helpers/select';
import { openMore } from '../../helpers/topBar';
import { documentBytes, para, workbookBytes } from '../../viewer/fixtures';
import { locationsFake } from '../locations/fakes';
import { dailyTotalsOf, dataFake, itemOf, type DataFake } from './fakes';

// One item of Your data on web (P27, D28): its details, an upload's days, and a stored file drawn in the browser by
// kind (text, a CSV grid, a workbook's sheets, a PDF opened in a new tab, a Word document, a picture), with every
// case that shows nothing saying why, and the actions Your data's rows used to carry (Turn off, Delete original,
// Delete), a delete going back to Your data with its outcome. All files are synthetic.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

const urls = { made: [] as string[], types: [] as string[], revoked: [] as string[] };

beforeEach(() => {
  // D61: Your data's rows read as one table, Newest first, remembered for the person signed in.
  window.localStorage.setItem('townwise.dataView.u1', 'newest');
  urls.made.length = 0;
  urls.types.length = 0;
  urls.revoked.length = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:https://townwise.tech/${String(urls.made.length)}`;
      urls.made.push(url);
      urls.types.push(blob.type);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => { urls.revoked.push(url); } });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  window.localStorage.clear();
});

/** A ref the routing allows: `u_` or `f_` and 24 hex digits. */
function refOf(type: 'u' | 'f', n: number): string {
  return `${type}_${n.toString(16).padStart(24, '0')}`;
}

/** The raw download path of an item made by itemOf. */
function rawPath(ref: string): string {
  return `/files/${ref.replace(/^[uf]_/, 'file-')}/raw`;
}

/** The fixtures' bytes as a Blob (their buffer is typed ArrayBufferLike). */
function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}

function storedFile(ref: string, extra: Partial<DataItem>): DataItem {
  return itemOf(ref, { state: 'kept', outcome: 'reference', ...extra });
}

interface Setup { fake: DataFake; api: FakePortalApi }

function setup(
  items: DataItem[], ref: string,
  opts: {
    me?: MeResponse; org?: OrgResponse; history?: SalesHistory; downloads?: Record<string, () => Blob | ReturnType<typeof refusal>>;
    /** Where the app opens; the item's page by default. */
    path?: string;
  } = {},
): Setup {
  const fake = dataFake({ inner: locationsFake(), items });
  if (opts.history !== undefined) fake.history.l1 = opts.history;
  Object.assign(fake.files.downloads, opts.downloads ?? {});
  const api = fakePortalApi({ me: opts.me ?? meOf(ACCESS.admin), org: opts.org ?? orgOf('org_admin'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = opts.path ?? `/locations/l1/data/${ref}`;
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return { fake, api };
}

function rawRequests(fake: DataFake): string[] {
  return fake.files.calls.filter((call) => call.path.endsWith('/raw') || call.path.endsWith('/clean')).map((call) => call.path);
}

const COVERAGE = { dayCount: 4, guestsDayCount: 4, netSalesDayCount: 3, firstDate: '2026-04-30', lastDate: '2026-05-03', missingDays: 0 };

function historyUpload(id: string): HistoryUpload {
  return {
    id, uploadedAt: '2026-11-05T15:00:00.000Z', uploadedByEmail: 'owner@example.com', status: 'applied', firstDate: '2026-04-30', lastDate: '2026-05-03',
    file: null,
  };
}

/** Four days: the 1st and 2nd last written by `uploadId`, the others by another upload. */
function historyOf(uploadId: string): SalesHistory {
  return {
    coverage: COVERAGE,
    days: {
      date: ['2026-04-30', '2026-05-01', '2026-05-02', '2026-05-03'],
      guests: [10, 50, null, 30],
      netSalesCents: [20_000, 150_000, 99_950, null],
      upload: [0, 1, 1, 0],
    },
    uploads: [historyUpload('0'.repeat(24)), historyUpload(uploadId)],
  };
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('an upload', () => {
  test('shows its details and the days it still holds, with the way back; the top bar keeps Your data marked', async () => {
    const ref = refOf('u', 1);
    setup([dailyTotalsOf(ref, { days: { count: 3, inUse: 2, firstDate: '2026-05-01', lastDate: '2026-05-03' } })], ref, { history: historyOf(ref.slice(2)) });
    expect(await screen.findByRole('heading', { level: 2, name: 'Daily totals' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Your data']);
    expect(screen.getByText('Daily totals · No file kept · Sent from a browser')).toBeTruthy();
    expect(screen.getByText('Added Nov 5, 2026 by owner@example.com')).toBeTruthy();
    expect(screen.getByText('On · Used')).toBeTruthy();
    expect(screen.getByText('Days: 2 of 3 in use, May 1, 2026 to May 3, 2026')).toBeTruthy();
    expect(screen.queryByText(/^Edited /)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Your data' }).getAttribute('href')).toBe('/locations/l1/data');
    expect(within(openMore()).getByRole('link', { name: 'Your data' }).getAttribute('aria-current')).toBe('true');

    const table = await screen.findByRole('region', { name: 'Days in Daily totals, May 1, 2026 to May 3, 2026' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Date', 'Guests', 'Net sales']);
    const rows = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([['May 1, 2026', '50', '$1,500'], ['May 2, 2026', 'No data', '$1,000']]);
    // No download for an upload with no file, and no file view to choose.
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Show' })).toBeNull();
  });

  test('turned off, it says so plainly and reads no history', async () => {
    const ref = refOf('u', 2);
    const { api } = setup([dailyTotalsOf(ref, { enabled: false })], ref, { history: historyOf(ref.slice(2)) });
    expect(await screen.findByText(
      'This upload is turned off, so its days are left out of your numbers and aren’t shown here. Turn it on above to see them.',
    )).toBeTruthy();
    expect(screen.getByText('Off · Used')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(api.calls.some((call) => call.path.endsWith('/sales/history'))).toBe(false);
  });

  test('with every day replaced by a later upload, it says it holds none', async () => {
    const ref = refOf('u', 3);
    setup([dailyTotalsOf(ref, { days: { count: 3, inUse: 0, firstDate: '2026-05-01', lastDate: '2026-05-03' } })], ref, { history: historyOf('9'.repeat(24)) });
    expect(await screen.findByText('Later uploads replaced every day this upload sent, so it holds none now.')).toBeTruthy();
  });

  test('a sales file’s upload also shows its original and its cleaned copy, chosen with Show', async () => {
    const ref = refOf('u', 4);
    const item = itemOf(ref, {
      name: 'toast.csv', kind: 'text', days: { count: 2, inUse: 2, firstDate: '2026-05-01', lastDate: '2026-05-02' },
      file: {
        id: 'file-sales', hasClean: true, rawAvailable: true, rawExpiresAt: null, entries: null, canDownloadRaw: true, canDownloadClean: true, canDeleteRaw: true,
      },
    });
    const { fake } = setup([item], ref, {
      history: historyOf(ref.slice(2)),
      downloads: {
        '/files/file-sales/raw': () => new Blob(['Date,Guests\n2026-05-01,50\n']),
        '/files/file-sales/clean': () => new Blob(['date,guests,net_sales\r\n2026-05-01,50,1500.00\r\n']),
      },
    });
    expect(await screen.findByRole('region', { name: 'Days in toast.csv' })).toBeTruthy();
    expect(rawRequests(fake)).toEqual([]);
    const show = screen.getByRole('combobox', { name: 'Show' });
    expect(choicesOf(show)).toEqual(['Days', 'Original file', 'Cleaned copy']);
    choose(show, 'Cleaned copy');
    const clean = await screen.findByRole('region', { name: 'Rows of the cleaned copy of toast.csv' });
    expect(within(clean).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['date', 'guests', 'net_sales', '2026-05-01', '50', '1500.00']);
    choose(screen.getByRole('combobox', { name: 'Show' }), 'Original file');
    const raw = await screen.findByRole('region', { name: 'Rows of toast.csv' });
    expect(within(raw).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Date', 'Guests', '2026-05-01', '50']);
    expect(rawRequests(fake)).toEqual(['/files/file-sales/clean', '/files/file-sales/raw']);
    // The header has both downloads.
    expect(screen.getByRole('button', { name: 'Download original: toast.csv' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download cleaned CSV: toast.csv' })).toBeTruthy();
  });
});

describe('a stored file', () => {
  test('text shows as text, with its details and the download; an edited item says who edited it and when', async () => {
    const ref = refOf('f', 10);
    setup([storedFile(ref, { name: 'notes.txt', sizeBytes: 60, editedAt: '2026-11-10T15:00:00.000Z', editedByEmail: 'gm@example.org' })], ref, {
      downloads: { [rawPath(ref)]: () => new Blob(['Closed Mondays in January.\nOpen late on Fridays.']) },
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'notes.txt' })).toBeTruthy();
    expect(screen.getByText('CSV or text file · 1 KB · Read by Townwise')).toBeTruthy();
    expect(screen.getByText('Edited Nov 10, 2026 by gm@example.org')).toBeTruthy();
    expect(screen.getByText('On · Kept for reference')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download original: notes.txt' })).toBeTruthy();
    const text = await screen.findByRole('region', { name: 'Text of notes.txt' });
    expect(text.textContent).toBe('Closed Mondays in January.\nOpen late on Fridays.');
    expect(text.getAttribute('tabindex')).toBe('0');
  });

  test('says Opening {size} file… for a frame before it reads the file', async () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const ref = refOf('f', 11);
    setup([storedFile(ref, { name: 'notes.txt', sizeBytes: 5 })], ref, { downloads: { [rawPath(ref)]: () => new Blob(['hello']) } });
    expect(await screen.findByText('Opening 1 KB file…')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Text of notes.txt' })).toBeNull();
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    expect((await screen.findByRole('region', { name: 'Text of notes.txt' })).textContent).toBe('hello');
  });

  test('a CSV is a grid of its first 1,000 rows, and says it cut the rest', async () => {
    const ref = refOf('f', 12);
    const csv = ['date,guests', ...Array.from({ length: 1004 }, (_, index) => `2026-01-01,${String(index)}`)].join('\n');
    setup([storedFile(ref, { name: 'export.csv', sizeBytes: csv.length })], ref, { downloads: { [rawPath(ref)]: () => new Blob([csv]) } });
    const grid = await screen.findByRole('region', { name: 'Rows of export.csv' });
    expect(screen.getByText('Showing the first 1,000 of 1,005 rows.')).toBeTruthy();
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(1000);
    const first = rows[0];
    if (first === undefined) throw new Error('no row');
    expect(within(first).getByRole('rowheader').textContent).toBe('1');
    expect(within(first).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['date', 'guests']);
    expect(screen.queryByText(/^Townwise reads the first/)).toBeNull();
  });

  test('a TSV wider than Townwise reads says the rest is left out', async () => {
    const ref = refOf('f', 13);
    const tsv = Array.from({ length: 201 }, (_, index) => `c${String(index)}`).join('\t');
    setup([storedFile(ref, { name: 'wide.tsv', sizeBytes: tsv.length })], ref, { downloads: { [rawPath(ref)]: () => new Blob([tsv]) } });
    const grid = await screen.findByRole('region', { name: 'Rows of wide.tsv' });
    expect(within(grid).getAllByRole('cell')).toHaveLength(200);
    expect(screen.getByText('Townwise reads the first 5,000 rows and 200 columns of a file, so the rest of this one is left out.')).toBeTruthy();
  });

  test('a workbook shows a grid per sheet under sheet tabs, with column letters, and a time with no date as its time', async () => {
    const ref = refOf('f', 14);
    const bytes = workbookBytes({
      sheets: [
        ['Sales', '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2" s="1"><v>0.5</v></c></row>'],
        ['Notes', '<row r="1"><c r="A1" t="inlineStr"><is><t>Closed on the 4th</t></is></c></row>'],
      ],
      sharedStrings: ['Guests', 'Opens at'],
      styles: '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="20"/></cellXfs>',
    });
    setup([storedFile(ref, { name: 'hours.xlsx', kind: 'xlsx', sizeBytes: bytes.length })], ref, { downloads: { [rawPath(ref)]: () => blobOf(bytes) } });
    const tabs = await screen.findByRole('tablist', { name: 'Sheets' });
    const [sales, notes] = within(tabs).getAllByRole('tab');
    if (sales === undefined || notes === undefined) throw new Error('two tabs');
    expect([sales.textContent, sales.getAttribute('aria-selected'), notes.textContent, notes.getAttribute('aria-selected')]).toEqual(['Sales', 'true', 'Notes', 'false']);
    const grid = screen.getByRole('region', { name: 'Sheet Sales' });
    expect(within(grid).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Row', 'A', 'B']);
    expect(within(grid).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Guests', 'Opens at', '42', '12:00:00']);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(sales.id);

    fireEvent.click(notes);
    const second = await screen.findByRole('region', { name: 'Sheet Notes' });
    expect(within(second).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Closed on the 4th']);
    // Left from the first sheet wraps to the last, and focus follows.
    fireEvent.keyDown(notes, { key: 'ArrowLeft' });
    expect(await screen.findByRole('region', { name: 'Sheet Sales' })).toBeTruthy();
    fireEvent.keyDown(sales, { key: 'ArrowLeft' });
    expect(await screen.findByRole('region', { name: 'Sheet Notes' })).toBeTruthy();
    expect(document.activeElement).toBe(notes);
  });

  test('a PDF draws no frame: Open PDF opens it in a new tab on a blob: URL with noopener, revoked 40 seconds later', async () => {
    const ref = refOf('f', 15);
    setup([storedFile(ref, { name: 'menu.pdf', kind: 'pdf', sizeBytes: 20 })], ref, { downloads: { [rawPath(ref)]: () => new Blob(['%PDF-1.4\n%synthetic\n']) } });
    const button = await screen.findByRole('button', { name: 'Open PDF: menu.pdf' });
    expect(button.textContent).toBe('Open PDF');
    expect(screen.getByText('A PDF opens in a new tab, in your browser’s own PDF viewer.')).toBeTruthy();
    expect(document.querySelector('iframe, embed, object')).toBeNull();
    expect(urls.made).toEqual([]);
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    jest.useFakeTimers();
    try {
      // The tab opens in the click itself, so a popup blocker lets it through.
      fireEvent.click(button);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith('blob:https://townwise.tech/0', '_blank', 'noopener');
      expect(urls.types).toEqual(['application/pdf']);
      act(() => { jest.advanceTimersByTime(39_999); });
      expect(urls.revoked).toEqual([]);
      act(() => { jest.advanceTimersByTime(1); });
      expect(urls.revoked).toEqual(['blob:https://townwise.tech/0']);
    } finally {
      jest.useRealTimers();
    }
    expect(document.querySelector('iframe, embed, object')).toBeNull();
  });

  test('a Word document shows its paragraphs, headings and tables as text', async () => {
    const ref = refOf('f', 16);
    const bytes = documentBytes(
      `${para('Winter hours', 'Heading1')}${para('Closed Mondays in January.')}<w:tbl><w:tr><w:tc>${para('Monday')}</w:tc><w:tc>${para('Closed')}</w:tc></w:tr></w:tbl>`,
    );
    setup([storedFile(ref, { name: 'hours.docx', kind: 'docx', sizeBytes: bytes.length })], ref, { downloads: { [rawPath(ref)]: () => blobOf(bytes) } });
    const doc = await screen.findByRole('region', { name: 'Contents of hours.docx' });
    expect(within(doc).getByRole('heading', { level: 3, name: 'Winter hours' })).toBeTruthy();
    expect(within(doc).getByText('Closed Mondays in January.')).toBeTruthy();
    expect(within(doc).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Monday', 'Closed']);
  });

  test('a picture shows from a data: URL when its bytes are a picture; one only named like a picture is refused', async () => {
    const ref = refOf('f', 17);
    const png = new Uint8Array([...PNG, 0, 0, 0, 13]);
    setup([storedFile(ref, { name: 'logo.png', kind: 'other', sizeBytes: png.length })], ref, { downloads: { [rawPath(ref)]: () => new Blob([png]) } });
    const image = await screen.findByRole('img', { name: 'logo.png' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgoAAAAN');
    expect(urls.made).toEqual([]);
    cleanup();

    const fake = refOf('f', 18);
    setup([storedFile(fake, { name: 'photo.png', kind: 'other', sizeBytes: 13 })], fake, { downloads: { [rawPath(fake)]: () => new Blob(['not a picture']) } });
    expect(await screen.findByText(
      'This file is named like a picture, but it isn’t a PNG, JPEG, GIF or WebP picture, so Townwise doesn’t show it. Use Download original to open it on your computer.',
    )).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a damaged workbook says so, and how to open it instead', async () => {
    const ref = refOf('f', 19);
    setup([storedFile(ref, { name: 'broken.xlsx', kind: 'xlsx', sizeBytes: 14 })], ref, { downloads: { [rawPath(ref)]: () => new Blob(['not a workbook']) } });
    expect(await screen.findByText('This file looks damaged, so Townwise can’t show it. Use Download original to open it on your computer.')).toBeTruthy();
  });

  test('a failed download says why, with Try again', async () => {
    const ref = refOf('f', 20);
    const { fake } = setup([storedFile(ref, { name: 'notes.txt', sizeBytes: 5 })], ref, { downloads: { [rawPath(ref)]: () => refusal(404, 'not_found') } });
    expect(await screen.findByText('This item isn’t available anymore.')).toBeTruthy();
    fake.files.downloads[rawPath(ref)] = () => new Blob(['hello']);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findByRole('region', { name: 'Text of notes.txt' })).textContent).toBe('hello');
  });
});

describe('what shows nothing says why', () => {
  test('only the person who added it or an org admin may open the original; nothing is fetched', async () => {
    const ref = refOf('f', 30);
    const item = storedFile(ref, { name: 'theirs.txt' });
    const { fake } = setup([{ ...item, file: item.file === null ? null : { ...item.file, canDownloadRaw: false } }], ref, { me: meOf(ACCESS.member) });
    expect(await screen.findByText('Only the person who added it or an org admin can open the original.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
    expect(rawRequests(fake)).toEqual([]);
  });

  test('view-as: no name, no download, and files don’t open', async () => {
    const ref = refOf('f', 31);
    const item = storedFile(ref, { name: null, canTurnOff: false, canDelete: false });
    const { fake } = setup(
      [{ ...item, file: item.file === null ? null : { ...item.file, canDownloadRaw: false, canDownloadClean: false, canDeleteRaw: false } }], ref,
      { me: viewAsMe(ACCESS.admin) },
    );
    expect(await screen.findByText('Files don’t open during view-as.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'CSV or text file' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
    expect(rawRequests(fake)).toEqual([]);
    // Turn off and Delete show, disabled in place under the read-only line, named by the kind and when it was added.
    expect(document.getElementById('item-ro')?.textContent).toMatch(/^Read-only while viewing as /);
    for (const name of ['Turn off: CSV or text file, added Nov 5, 2026', 'Delete: CSV or text file, added Nov 5, 2026']) {
      const button = screen.getByRole('button', { name });
      expect({ name, state: [button.getAttribute('aria-disabled'), button.getAttribute('aria-describedby')] }).toEqual({ name, state: ['true', 'item-ro'] });
    }
    expect(screen.queryByRole('button', { name: /^Delete original/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete: CSV or text file, added Nov 5, 2026' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.patches).toEqual([]);
  });

  test('a file over 25 MB is not fetched, and says its size', async () => {
    const ref = refOf('f', 32);
    const { fake } = setup([storedFile(ref, { name: 'big.csv', sizeBytes: 30 * 1024 * 1024 })], ref);
    expect(await screen.findByText('This file is 30 MB. Townwise shows files up to 25 MB here. Use Download original to open it on your computer.')).toBeTruthy();
    expect(rawRequests(fake)).toEqual([]);
  });

  test('an old Excel file can’t be drawn, and a ZIP lists what’s inside instead', async () => {
    const ref = refOf('f', 33);
    const { fake } = setup([storedFile(ref, { name: 'old.xls', kind: 'xls' })], ref);
    expect(await screen.findByText(
      'Townwise can’t show old Excel files (.xls) here. Save it as .xlsx and add it again to see it here. Use Download original to open it on your computer.',
    )).toBeTruthy();
    expect(rawRequests(fake)).toEqual([]);
    cleanup();

    const zip = refOf('f', 34);
    const item = storedFile(zip, { name: 'export.zip', kind: 'zip' });
    setup([{ ...item, file: item.file === null ? null : { ...item.file, entries: { total: 2, used: 0, kept: 2 } } }], zip);
    expect(await screen.findByText('Townwise can’t show what’s inside a ZIP here. Use Download original to open it on your computer.')).toBeTruthy();
    expect(screen.getByText('2 files inside: 0 used, 2 kept, not used')).toBeTruthy();
  });

  test('a file whose original was deleted has nothing left to show', async () => {
    const ref = refOf('f', 35);
    const item = storedFile(ref, { name: 'Text' });
    setup([{ ...item, file: item.file === null ? null : { ...item.file, rawAvailable: false, canDownloadRaw: false, canDeleteRaw: false } }], ref);
    expect(await screen.findByText('Its file was deleted, so there’s nothing left to show.')).toBeTruthy();
  });

  test('a calendar export says why it was kept and links to the Calendar, where Your calendars imports it (D58)', async () => {
    // Their originals deleted, so nothing is drawn below the status.
    const noRaw = (item: DataItem): DataItem => ({
      ...item, file: item.file === null ? null : { ...item.file, rawAvailable: false, canDownloadRaw: false, canDeleteRaw: false },
    });
    const ref = refOf('f', 37);
    setup([noRaw(storedFile(ref, { name: 'Master calendar.csv', outcome: 'calendar_export' }))], ref);
    expect(await screen.findByText(
      'On · Kept, not used: it’s a calendar export. Import it in Your calendars to see its events and let TownwiseAI read them all.',
    )).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Your calendars on the Calendar' }).getAttribute('href')).toBe('/locations/l1/calendar');
    cleanup();
    // Any other kept file has no such link.
    const other = refOf('f', 38);
    setup([noRaw(storedFile(other, { name: 'Text', outcome: 'no_header' }))], other);
    expect(await screen.findByText('On · Kept, not used: it has no header row.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open Your calendars on the Calendar' })).toBeNull();
  });

  test('a calendar file imported as a calendar says so with its events and opens the calendar’s page (D60)', async () => {
    const ref = refOf('f', 40);
    setup([storedFile(ref, {
      kind: 'other', name: 'Bookings.ics', calendar: { status: 'added', calendarId: '0123456789abcdef01234567', label: 'Bookings', eventCount: 12 },
    })], ref);
    expect(await screen.findByText('Added to your calendars as Bookings: 12 events.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the calendar' }).getAttribute('href')).toBe('/locations/l1/data/c_0123456789abcdef01234567');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
    // One event, and a calendar removed since: the file stays, and nothing offers to add it again.
    const one = refOf('f', 41);
    setup([storedFile(one, { kind: 'other', name: 'One.ics', calendar: { status: 'added', calendarId: 'c1', label: 'One', eventCount: 1 } })], one);
    expect(await screen.findByText('Added to your calendars as One: 1 event.')).toBeTruthy();
    cleanup();
    const gone = refOf('f', 42);
    setup([storedFile(gone, { kind: 'other', name: 'Gone.ics', calendar: { status: 'removed' } })], gone);
    expect(await screen.findByText('Added to your calendars once; that calendar was removed since. Removing a calendar keeps this file, and Townwise doesn’t add it again.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the calendar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
    // Any other file says nothing of calendars.
    const plain = refOf('f', 43);
    setup([storedFile(plain, { kind: 'other', name: 'Notes.txt', calendar: null })], plain);
    expect(await screen.findByText('Notes.txt')).toBeTruthy();
    expect(screen.queryByText(/your calendars/)).toBeNull();
  });

  test('a refused calendar file says why; Try again shows only for a fixable cause and shows what the retry answered (D60)', async () => {
    const ref = refOf('f', 44);
    setup([storedFile(ref, { kind: 'other', name: 'Broken.ics', calendar: { status: 'refused', reason: 'not_calendar', retry: false } })], ref);
    expect(await screen.findByText(
      'Not added to your calendars: Townwise can’t read this file as a calendar. Add an .ics file, or a CSV with event_id, title, start_at and end_at columns.',
    )).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
    const big = refOf('f', 45);
    setup([storedFile(big, { kind: 'other', name: 'Big.ics', calendar: { status: 'refused', reason: 'too_large', retry: false } })], big);
    expect(await screen.findByText('Not added to your calendars: this file is over 1 MB. Export a shorter range of your calendar, then add that file.')).toBeTruthy();
    cleanup();
    const full = refOf('f', 46);
    const { fake } = setup([storedFile(full, { kind: 'other', name: 'Late.ics', calendar: { status: 'refused', reason: 'calendar_limit', retry: true } })], full);
    expect(await screen.findByText('Not added to your calendars: this location already has 5 calendars. Remove one on the Calendar, then try again.')).toBeTruthy();
    const added = storedFile(full, { kind: 'other', name: 'Late.ics', calendar: { status: 'added', calendarId: 'c9', label: 'Late', eventCount: 3 } });
    // As the API does, the retry's outcome stays: the page's read after it finds the item added.
    fake.answers['POST calendar'] = () => {
      fake.items = [added];
      return { item: added };
    };
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Added to your calendars as Late: 3 events.')).toBeTruthy();
    await waitFor(() => { expect(fake.paths.filter((path) => path.endsWith(`/data/${full}`)).length).toBeGreaterThan(1); });
    expect(screen.getByText('Added to your calendars as Late: 3 events.')).toBeTruthy();
    expect(screen.queryByText(/^Not added to your calendars/)).toBeNull();
    expect(fake.calendarRetries).toEqual([full]);
    // A failed request says why and keeps the line.
    cleanup();
    const failing = setup([storedFile(full, { kind: 'other', name: 'Late.ics', calendar: { status: 'refused', reason: 'unavailable', retry: true } })], full);
    failing.fake.answers['POST calendar'] = () => refusal(503, 'unavailable');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
    expect(screen.getByText('Not added to your calendars: Townwise couldn’t read this file just now.')).toBeTruthy();
  });

  // UI review 2026-11-19: a calendar file's page talks about its import, never that TownwiseAI can't read it or that
  // Townwise can't show it.
  test('a calendar file’s TownwiseAI section and viewer never say it can’t be read or shown', async () => {
    const ref = refOf('f', 48);
    setup([storedFile(ref, {
      kind: 'other', name: 'Bookings.ics', canAiRead: true,
      calendar: { status: 'added', calendarId: '0123456789abcdef01234567', label: 'Bookings', eventCount: 12 },
    })], ref);
    expect(await screen.findByText('Added to your calendars as Bookings: 12 events.')).toBeTruthy();
    expect(await screen.findByText(
      'Townwise doesn’t show a calendar file here: its events show on the Calendar once it’s one of your calendars. Use Download original to open it on your computer.',
    )).toBeTruthy();
    expect(screen.queryByText(/can’t read this file/)).toBeNull();
    expect(screen.queryByText(/can’t show this kind of file/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'TownwiseAI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Let TownwiseAI read this file' })).toBeNull();
    cleanup();
    // Refused for a fixable cause: the same, with Try again.
    const full = refOf('f', 49);
    setup([storedFile(full, { kind: 'other', name: 'Late.ics', canAiRead: true, calendar: { status: 'refused', reason: 'calendar_limit', retry: true } })], full);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/can’t read this file/)).toBeNull();
    expect(screen.queryByText(/can’t show this kind of file/)).toBeNull();
  });

  test('an .ics file that is no calendar keeps the general words', async () => {
    const ref = refOf('f', 50);
    setup([storedFile(ref, { kind: 'other', name: 'Broken.ics', canAiRead: true, calendar: { status: 'refused', reason: 'not_calendar', retry: false } })], ref);
    expect(await screen.findByText('TownwiseAI reads PDFs, pictures, Excel and Word files, CSV and text files, and ZIPs of them, so it can’t read this file.')).toBeTruthy();
    expect(await screen.findByText('Townwise can’t show this kind of file here. Use Download original to open it on your computer.')).toBeTruthy();
  });

  test('a calendar file kept before calendar files were imported says so, and Import as a calendar adds it', async () => {
    const ref = refOf('f', 51);
    const { fake } = setup([storedFile(ref, { kind: 'other', name: 'Old bookings.ics', canAiRead: true, calendar: null })], ref);
    expect(await screen.findByText(
      'This calendar file was kept before Townwise added calendar files to your calendars, so it isn’t one of them. Import it as a calendar, or delete it if it’s already one of your calendars.',
    )).toBeTruthy();
    expect(screen.queryByText(/can’t read this file/)).toBeNull();
    const added = storedFile(ref, { kind: 'other', name: 'Old bookings.ics', calendar: { status: 'added', calendarId: 'c7', label: 'Old bookings', eventCount: 4 } });
    fake.answers['POST calendar'] = () => {
      fake.items = [added];
      return { item: added };
    };
    fireEvent.click(screen.getByRole('button', { name: 'Import as a calendar' }));
    expect(await screen.findByText('Added to your calendars as Old bookings: 4 events.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Import as a calendar' })).toBeNull();
    expect(fake.calendarRetries).toEqual([ref]);
    cleanup();
    // Its original deleted: nothing to import, and it says so.
    const gone = refOf('f', 52);
    const old = storedFile(gone, { kind: 'other', name: 'Old.ics', calendar: null });
    setup([{ ...old, file: old.file === null ? null : { ...old.file, rawAvailable: false } }], gone);
    expect(await screen.findByText(
      'This calendar file was kept before Townwise added calendar files to your calendars, and its original was deleted, so it can’t be imported.',
    )).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Import as a calendar' })).toBeNull();
  });

  test('under view-as Try again stays in place, disabled, described by the read-only line (D60)', async () => {
    const ref = refOf('f', 47);
    const { fake } = setup(
      [storedFile(ref, { kind: 'other', name: null, calendar: { status: 'refused', reason: 'calendar_limit', retry: true } })], ref, { me: viewAsMe(ACCESS.admin) },
    );
    const button = await screen.findByRole('button', { name: 'Try again' });
    expect(button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled).toBe(true);
    const described = (button.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described).toContain('item-ro');
    fireEvent.click(button);
    expect(fake.calendarRetries).toEqual([]);
  });

  test('an item that is gone says it may have been deleted or replaced by an edit, with the way back', async () => {
    setup([], refOf('f', 36));
    expect(await screen.findByText('This item isn’t here anymore. It may have been deleted, or replaced when someone saved an edit of it.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Your data' }).getAttribute('href')).toBe('/locations/l1/data');
  });
});

describe('the actions Your data’s rows used to carry', () => {
  /** The sales file an upload was read from: both downloads, and an original that can be deleted on its own. */
  function salesUpload(ref: string): DataItem {
    return itemOf(ref, {
      name: 'toast.csv', kind: 'text', days: { count: 2, inUse: 2, firstDate: '2026-05-01', lastDate: '2026-05-02' },
      file: { id: 'file-sales', hasClean: true, rawAvailable: true, rawExpiresAt: null, entries: null, canDownloadRaw: true, canDownloadClean: true, canDeleteRaw: true },
    });
  }

  /** The labels of the buttons in the item's row of actions, which holds `one`. */
  function actionsBeside(one: HTMLElement): string[] {
    const row = one.parentElement;
    if (row === null) throw new Error('no actions row');
    return within(row).getAllByRole('button').map((button) => button.textContent);
  }

  /** The notice is a toast, which never takes focus: the page's h1 has it in its place (spec 15.7, D55). */
  function headingHasFocus(notice: HTMLElement): boolean {
    return notice.closest('[data-testid="toast"]') !== null && document.activeElement === screen.getByRole('heading', { level: 1 });
  }

  function orgReads(api: FakePortalApi): number {
    return api.calls.filter((call) => call.method === 'GET' && call.path === '/api/org').length;
  }

  async function settle(fire: () => void): Promise<void> {
    await act(async () => {
      fire();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
  }

  /** The Delete section's heading and its buttons, which follow the item's content. */
  function deleteSection(): { heading: HTMLElement; buttons: string[] } {
    const heading = screen.getByRole('heading', { level: 2, name: 'Delete this item' });
    const section = heading.parentElement?.parentElement;
    if (section === null || section === undefined) throw new Error('no Delete section');
    return { heading, buttons: within(section).getAllByRole('button').map((button) => button.textContent) };
  }

  test('a sales file’s upload has Turn off and both downloads, then Delete original and Delete in a Delete section of their own; one kept for reference has no Delete original', async () => {
    const ref = refOf('u', 50);
    setup([salesUpload(ref)], ref, { history: historyOf(ref.slice(2)) });
    const turn = await screen.findByRole('button', { name: 'Turn off: toast.csv' });
    expect(actionsBeside(turn)).toEqual(['Turn off', 'Download original', 'Download cleaned CSV']);
    const { heading, buttons } = deleteSection();
    expect(buttons).toEqual(['Delete original', 'Delete']);
    // Below the item: after its actions in the page's order.
    expect(turn.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    const kept = refOf('f', 51);
    setup([storedFile(kept, { name: 'menu-notes.txt' })], kept);
    // The original is the whole item: Delete removes it whole.
    expect(actionsBeside(await screen.findByRole('button', { name: 'Turn off: menu-notes.txt' }))).toEqual(['Turn off', 'Download original']);
    expect(deleteSection().buttons).toEqual(['Delete']);
  });

  // The page drops the last action's notice as the dialog opens. Its toast lives its own time, so it may still be up:
  // what must not happen is a second one behind the dialog or after it.
  test('opening a delete’s dialog shows the last action’s notice no second time', async () => {
    const ref = refOf('f', 62);
    setup([storedFile(ref, { name: 'menu-notes.txt' })], ref);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off: menu-notes.txt' }));
    expect(await screen.findByText(/^Turned off menu-notes\.txt\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete: menu-notes.txt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this file' });
    expect(screen.getAllByText(/^Turned off menu-notes\.txt\./)).toHaveLength(1);
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Delete this file' })).toBeNull(); });
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(within(screen.getByRole('main')).queryByText(/^Turned off menu-notes\.txt\./)).toBeNull();
  });

  test('a delete opened from Your data goes back to that entry, so Your data is in the history once, and the page’s heading takes focus as its toast shows', async () => {
    const ref = refOf('f', 63);
    setup([storedFile(ref, { name: 'menu-notes.txt' }), storedFile(refOf('f', 64), { name: 'other.txt' })], ref, { path: '/locations/l1/data' });
    const list = await screen.findByRole('region', { name: 'Your data for Main Street Bar' });
    await settle(() => { fireEvent.click(within(list).getByRole('link', { name: 'menu-notes.txt' })); });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete: menu-notes.txt' }));
    await settle(() => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this file' })).getByRole('button', { name: 'Delete file' })); });
    await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/data'); });
    const notice = await screen.findByText('Deleted menu-notes.txt.');
    await waitFor(() => { expect(headingHasFocus(notice)).toBe(true); });
    // The item's entry was taken off, not replaced by a second Your data: nothing is left to go back to.
    expect(router.canGoBack()).toBe(false);
  });

  test('Turn off acts at once, says so in a toast, moves focus to the heading and shows Off; Turn on puts it back', async () => {
    const ref = refOf('u', 52);
    const { fake } = setup([dailyTotalsOf(ref)], ref, { history: historyOf(ref.slice(2)) });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
    expect(fake.patches).toEqual([{ ref, body: { enabled: false } }]);
    const notice = await screen.findByText(/^Turned off Daily totals, May 1, 2026 to May 10, 2026\./);
    expect(notice.textContent).toBe('Turned off Daily totals, May 1, 2026 to May 10, 2026. Main Street Bar’s numbers, forecasts and TownwiseAI leave it out until it’s turned on.');
    await waitFor(() => { expect(headingHasFocus(notice)).toBe(true); });
    expect(await screen.findByText('Off · Used')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on: Daily totals, May 1, 2026 to May 10, 2026' }));
    expect(fake.patches.at(-1)).toEqual({ ref, body: { enabled: true } });
    expect(await screen.findByText('Turned on Daily totals, May 1, 2026 to May 10, 2026.')).toBeTruthy();
    expect(await screen.findByText('On · Used')).toBeTruthy();
  });

  test('Delete on an upload says in words which days go and what stays, then goes back to Your data, which says how it ended', async () => {
    const ref = refOf('u', 53);
    const { fake, api } = setup([dailyTotalsOf(ref), storedFile(refOf('f', 54), { name: 'menu-notes.txt' })], ref, { history: historyOf(ref.slice(2)) });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 10, 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this upload' });
    expect(within(dialog).getByText(
      'This deletes the 5 days this upload still holds for Main Street Bar, May 1, 2026 to May 10, 2026, and its file, if it has one. Days a later upload replaced stay, and so do notes. To keep the days out of your numbers without deleting them, turn it off instead. This can’t be undone.',
    )).toBeTruthy();
    const before = orgReads(api);
    await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete upload' })); });
    expect(fake.removed).toEqual([{ locationId: 'l1', ref }]);
    await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/data'); });
    expect(await screen.findByText('Deleted the upload and 5 days.')).toBeTruthy();
    const rows = within(await screen.findByRole('region', { name: 'Your data for Main Street Bar' })).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual(['menu-notes.txt']);
    // The item's page closed, so the organization's day counts are read again.
    await waitFor(() => { expect(orgReads(api)).toBe(before + 1); });
  });

  test('Delete on a stored file says it goes for everyone on the team, and Your data says it went', async () => {
    const ref = refOf('f', 55);
    const { fake } = setup([storedFile(ref, { name: 'menu-notes.txt' })], ref);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete: menu-notes.txt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this file' });
    expect(within(dialog).getByText('This deletes menu-notes.txt for everyone on your team. This can’t be undone.')).toBeTruthy();
    await settle(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' })); });
    expect(fake.removed).toEqual([{ locationId: 'l1', ref }]);
    const notice = await screen.findByText('Deleted menu-notes.txt.');
    expect(window.location.pathname).toBe('/locations/l1/data');
    // Opened straight at the item, Your data takes its place, and its heading takes focus there too.
    await waitFor(() => { expect(headingHasFocus(notice)).toBe(true); });
    expect(await screen.findByText('Nothing here yet. What your team uploads or adds for Main Street Bar shows here.')).toBeTruthy();
  });

  test('Delete original says what stays, deletes only the original and stays on the page', async () => {
    const ref = refOf('u', 56);
    const { fake } = setup([salesUpload(ref)], ref, { history: historyOf(ref.slice(2)) });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete original: toast.csv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete original' });
    expect(within(dialog).getByText('This deletes the original of toast.csv. The cleaned copy and the days it added stay. This can’t be undone.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete original' }));
    const notice = await screen.findByText('Deleted the original. The cleaned copy and its days stay.');
    await waitFor(() => { expect(headingHasFocus(notice)).toBe(true); });
    expect(fake.files.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/file-sales/raw']);
    expect(fake.removed).toEqual([]);
    expect(window.location.pathname).toBe(`/locations/l1/data/${ref}`);
  });

  test('a member sees Turn off and Delete only where the API gives the right', async () => {
    const mine = refOf('f', 57);
    setup([storedFile(mine, { name: 'mine.txt' })], mine, { me: meOf(ACCESS.member) });
    expect(await screen.findByRole('button', { name: 'Turn off: mine.txt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete: mine.txt' })).toBeTruthy();
    cleanup();
    const theirs = refOf('f', 58);
    setup([storedFile(theirs, { name: 'theirs.txt', canTurnOff: false, canDelete: false })], theirs, { me: meOf(ACCESS.member) });
    expect(await screen.findByRole('heading', { level: 2, name: 'theirs.txt' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Turn off|Delete)/ })).toBeNull();
  });

  test('a refused action says why in Your data’s words, and a 404 reads the item again, which says it is gone', async () => {
    const ref = refOf('f', 59);
    const { fake } = setup([storedFile(ref, { name: 'menu-notes.txt' })], ref);
    fake.answers[`PATCH ${ref}`] = () => refusal(409, 'item_busy');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off: menu-notes.txt' }));
    expect(await screen.findByText('Townwise is still reading this file. Try again when it’s done.')).toBeTruthy();
    fake.answers[`DELETE ${ref}`] = () => refusal(503, 'files_unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Delete: menu-notes.txt' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this file' })).getByRole('button', { name: 'Delete file' }));
    expect(await screen.findByText('File storage is off right now, so this can’t be done.')).toBeTruthy();
    // A failed delete stays here.
    expect(window.location.pathname).toBe(`/locations/l1/data/${ref}`);
    fake.answers[`PATCH ${ref}`] = () => refusal(404, 'not_found');
    fake.items = [];
    fireEvent.click(screen.getByRole('button', { name: 'Turn off: menu-notes.txt' }));
    expect(await screen.findByText('This item isn’t here anymore. It may have been deleted, or replaced when someone saved an edit of it.')).toBeTruthy();
  });

  test('with one location the Turned off notice and the upload’s delete dialog name the organization (D29)', async () => {
    const one = orgOf('org_admin', LOCATIONS.slice(0, 1));
    const ref = refOf('u', 60);
    setup([dailyTotalsOf(ref)], ref, { org: one, history: historyOf(ref.slice(2)) });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off: Daily totals, May 1, 2026 to May 10, 2026' }));
    expect((await screen.findByText(/^Turned off Daily totals/)).textContent).toBe(
      'Turned off Daily totals, May 1, 2026 to May 10, 2026. Test Group’s numbers, forecasts and TownwiseAI leave it out until it’s turned on.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete: Daily totals, May 1, 2026 to May 10, 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this upload' });
    expect(within(dialog).getByText(/^This deletes the 5 days this upload still holds for Test Group, May 1, 2026 to May 10, 2026,/)).toBeTruthy();
  });

  test('after Turn off the organization is read again once the page closes, not before', async () => {
    const ref = refOf('f', 61);
    const { api } = setup([storedFile(ref, { name: 'menu-notes.txt' })], ref);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off: menu-notes.txt' }));
    await screen.findByText(/^Turned off menu-notes\.txt\./);
    const before = orgReads(api);
    await settle(() => undefined);
    expect(orgReads(api)).toBe(before);
    await settle(() => { fireEvent.click(screen.getByRole('link', { name: 'Back to Your data' })); });
    await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/data'); });
    await waitFor(() => { expect(orgReads(api)).toBe(before + 1); });
  });
});
