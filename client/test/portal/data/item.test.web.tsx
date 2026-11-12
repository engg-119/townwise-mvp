import '../../viewer/setup';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { HistoryUpload, SalesHistory } from '../../../src/portal/analytics/api';
import type { DataItem } from '../../../src/portal/data/api';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { choicesOf, choose } from '../../helpers/select';
import { documentBytes, para, workbookBytes } from '../../viewer/fixtures';
import { locationsFake } from '../locations/fakes';
import { dailyTotalsOf, dataFake, itemOf, type DataFake } from './fakes';

// One item of Your data on web (P27, D28): its details, an upload's days, and a stored file drawn in the browser by
// kind (text, a CSV grid, a workbook's sheets, a PDF in the browser's viewer, a Word document, a picture), with every
// case that shows nothing saying why. All files are synthetic.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

const urls = { made: [] as string[], types: [] as string[], revoked: [] as string[] };

beforeEach(() => {
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
  opts: { me?: MeResponse; history?: SalesHistory; downloads?: Record<string, () => Blob | ReturnType<typeof refusal>> } = {},
): Setup {
  const fake = dataFake({ inner: locationsFake(), items });
  if (opts.history !== undefined) fake.history.l1 = opts.history;
  Object.assign(fake.files.downloads, opts.downloads ?? {});
  const api = fakePortalApi({ me: opts.me ?? meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = `/locations/l1/data/${ref}`;
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
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).getByRole('link', { name: 'Your data' }).getAttribute('aria-current')).toBe('true');

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
      'This upload is turned off, so its days are left out of your numbers and aren’t shown here. Turn it on in Your data to see them.',
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

  test('a PDF opens in the browser’s viewer on a blob: URL, revoked when the page goes', async () => {
    const ref = refOf('f', 15);
    setup([storedFile(ref, { name: 'menu.pdf', kind: 'pdf', sizeBytes: 20 })], ref, { downloads: { [rawPath(ref)]: () => new Blob(['%PDF-1.4\n%synthetic\n']) } });
    const frame = await screen.findByTitle('PDF: menu.pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBeNull();
    await waitFor(() => { expect(frame.getAttribute('src')).toBe('blob:https://townwise.tech/0'); });
    expect(urls.types).toEqual(['application/pdf']);
    expect(urls.revoked).toEqual([]);
    cleanup();
    expect(urls.revoked).toEqual(['blob:https://townwise.tech/0']);
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

  test('an item that is gone says it may have been deleted or replaced by an edit, with the way back', async () => {
    setup([], refOf('f', 36));
    expect(await screen.findByText('This item isn’t here anymore. It may have been deleted, or replaced when someone saved an edit of it.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Your data' }).getAttribute('href')).toBe('/locations/l1/data');
  });
});
