import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { FileView } from '../../../src/portal/files/api';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe } from '../../helpers/portal';
import { daysOf, locationsFake, salesOf, uploadOf } from '../locations/fakes';
import { entryOf, fileViewOf, filesFake, type FilesFake } from './fakes';

// Your files on P12 (storage2 2.3, 2.4): each file with what Townwise did with it, a ZIP's files inside, the
// downloads and deletes its flags allow with what each delete keeps, Delete all originals for org admins, and
// under view-as kinds instead of names, no downloads and no deletes. Off (503) it doesn't show.

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

function setup(me: MeResponse, files: FileView[] | ReturnType<typeof refusal>): FilesFake {
  const fake = filesFake({ inner: locationsFake({ sales: { l1: salesOf(DAYS, [uploadOf('u1')]) }, days: { l1: DAYS } }) });
  fake.lists[''] = files;
  const api = fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', '/locations/l1/sales');
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location="/locations/l1/sales" />
    </Head.Provider>,
  );
  return fake;
}

function at(rows: HTMLElement[], index: number): HTMLElement {
  const row = rows[index];
  if (row === undefined) throw new Error(`no row ${String(index)}`);
  return row;
}

async function list(): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: 'Your files' });
  return screen.getByRole('list', { name: 'Your files' });
}

const FILES: FileView[] = [
  fileViewOf('f1', { name: 'march.csv', sizeBytes: 2048 }),
  fileViewOf('f2', { name: 'old.xls', kind: 'xls', status: 'kept', outcome: 'old_excel', result: null, hasClean: false }),
  fileViewOf('f3', {
    name: 'toast-export.zip', kind: 'zip', sizeBytes: 3 * 1024 * 1024, entries: { total: 3, used: 2, kept: 1 },
  }),
];

test('each file says what Townwise did with it, and a ZIP lists the files inside, a page at a time', async () => {
  const fake = setup(meOf(ACCESS.admin), FILES);
  fake.entries['f3:'] = { entries: [entryOf(0), entryOf(1, { status: 'kept', outcome: 'system_file', path: '__MACOSX/x', dayCount: null })], next: 1 };
  fake.entries['f3:1'] = { entries: [entryOf(2)], next: null };
  const rows = within(await list()).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  expect(within(at(rows, 0)).getByText('march.csv')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('CSV or text file, 2 KB, uploaded Nov 5, 2026 by owner@example.com')).toBeTruthy();
  expect(within(at(rows, 0)).getByText('Used: 731 days, Jan 1, 2024 to Dec 31, 2025')).toBeTruthy();
  expect(within(at(rows, 1)).getByText(
    'Kept, not used: Townwise can’t read old Excel files yet. Save it as .xlsx or CSV and drop it again.',
  )).toBeTruthy();
  const zip = at(rows, 2);
  expect(within(zip).getByText('3 files inside: 2 used, 1 kept, not used')).toBeTruthy();
  fireEvent.click(within(zip).getByRole('button', { name: 'See what’s inside' }));
  const inside = await screen.findByRole('list', { name: 'Files inside toast-export.zip' });
  expect(within(inside).getByText('export/day-0.csv')).toBeTruthy();
  expect(within(inside).getByText('1 KB · Kept, not used: it’s a system file your computer added.')).toBeTruthy();
  fireEvent.click(within(inside).getByRole('button', { name: 'Show more' }));
  expect(await within(inside).findByText('export/day-2.csv')).toBeTruthy();
  expect(within(inside).queryByRole('button', { name: 'Show more' })).toBeNull();
});

test('downloads and deletes follow each file’s flags; a deleted original says what stays, without guessing why', async () => {
  setup(meOf(ACCESS.member), [
    fileViewOf('f1', { name: 'mine.csv' }),
    fileViewOf('f2', { name: 'theirs.csv', canDownloadRaw: false, canDelete: false, canDeleteRaw: false }),
    // Uploaded today with no original: it was deleted by a person, not by the year's retention.
    fileViewOf('f3', { name: 'old.csv', rawAvailable: false, rawExpiresAt: null }),
  ]);
  const rows = within(await list()).getAllByRole('listitem');
  const names = (row: HTMLElement): string[] => within(row).queryAllByRole('button').map((button) => button.textContent);
  expect(names(at(rows, 0))).toEqual(['Download original', 'Download cleaned CSV', 'Delete original', 'Delete file']);
  expect(names(at(rows, 1))).toEqual(['Download cleaned CSV']);
  expect(names(at(rows, 2))).toEqual(['Download cleaned CSV', 'Delete file']);
  expect(within(at(rows, 2)).getByText('The original was deleted. The cleaned copy and days stay.')).toBeTruthy();
  expect(document.body.textContent).not.toContain('after a year');
  // Only org admins delete every original at once.
  expect(screen.queryByRole('button', { name: 'Delete all originals for this location' })).toBeNull();
});

test('Download cleaned CSV saves the file through a blob link named after the original', async () => {
  const fake = setup(meOf(ACCESS.admin), FILES);
  fake.downloads['/files/f1/clean'] = () => new Blob(['date,guests,net_sales\r\n']);
  await list();
  fireEvent.click(screen.getByRole('button', { name: 'Download cleaned CSV: march.csv' }));
  await waitFor(() => { expect(saved).toEqual([{ name: 'march-townwise.csv', size: 23 }]); });
});

test('an original over 32 MiB comes in parts, in order, and a failed part is tried again', async () => {
  const big = 70 * 1024 * 1024;
  const fake = setup(meOf(ACCESS.admin), [fileViewOf('f1', { name: 'big.csv', sizeBytes: big })]);
  let failures = 0;
  fake.downloads['/files/f1/raw?part=0'] = () => new Blob(['a'.repeat(4)]);
  fake.downloads['/files/f1/raw?part=1'] = () => (failures++ === 0 ? refusal(503, 'storage_unavailable') : new Blob(['b'.repeat(4)]));
  fake.downloads['/files/f1/raw?part=2'] = () => new Blob(['c'.repeat(2)]);
  await list();
  fireEvent.click(screen.getByRole('button', { name: 'Download original: big.csv' }));
  await waitFor(() => { expect(saved).toEqual([{ name: 'big.csv', size: 10 }]); });
  expect(fake.calls.filter((call) => call.path.includes('/raw')).map((call) => call.path)).toEqual([
    '/files/f1/raw?part=0', '/files/f1/raw?part=1', '/files/f1/raw?part=1', '/files/f1/raw?part=2',
  ]);
});

test('Delete original says what stays before it runs, then deletes only the original', async () => {
  const fake = setup(meOf(ACCESS.admin), FILES);
  await list();
  fireEvent.click(screen.getByRole('button', { name: 'Delete original: march.csv' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete original' });
  expect(within(dialog).getByText('This deletes the original of march.csv. The cleaned copy and the days it added stay. This can’t be undone.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete original' }));
  expect(await screen.findByText('Original deleted. The cleaned copy and days stay.')).toBeTruthy();
  expect(fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/f1/raw']);
});

test('while the list reloads after a delete, the section and its notice stay on screen', async () => {
  const fake = setup(meOf(ACCESS.admin), FILES);
  await list();
  // The reload after the delete never answers.
  fake.lists[''] = new Promise(() => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Delete original: march.csv' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete original' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete original' }));
  expect(await screen.findByText('Original deleted. The cleaned copy and days stay.')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Your files' })).getAllByRole('listitem')).toHaveLength(3);
});

test('a download refused for too many requests says when to try, not that an upload will retry', async () => {
  const fake = setup(meOf(ACCESS.admin), FILES);
  fake.downloads['/files/f1/clean'] = () => refusal(429, 'rate_limited', 120);
  await list();
  fireEvent.click(screen.getByRole('button', { name: 'Download cleaned CSV: march.csv' }));
  expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
  expect(document.body.textContent).not.toContain('Too many uploads');
});

test('Delete file keeps the days and says so; a busy file says why it wasn’t deleted', async () => {
  const fake = setup(meOf(ACCESS.admin), FILES);
  fake.answers['DELETE /files/f1'] = () => ({ deleted: true, daysKept: 731 });
  fake.answers['DELETE /files/f2'] = () => refusal(409, 'file_busy');
  await list();
  fireEvent.click(screen.getByRole('button', { name: 'Delete file: march.csv' }));
  let dialog = await screen.findByRole('dialog', { name: 'Delete file' });
  expect(within(dialog).getByText(/The 731 days it added stay in your sales data/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
  expect(await screen.findByText('File deleted. The 731 days it added stay.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Delete file: old.xls' }));
  dialog = await screen.findByRole('dialog', { name: 'Delete file' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
  expect(await screen.findByText('This file is still uploading or being read. Try again when it’s done.')).toBeTruthy();
});

test('org admins delete every original of the location at once, after a confirm that says what stays', async () => {
  const fake = setup(meOf(ACCESS.admin), FILES);
  fake.answers['DELETE /originals'] = () => ({ deletedOriginals: 2, skippedBusy: 1 });
  await list();
  fireEvent.click(screen.getByRole('button', { name: 'Delete all originals for this location' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete all originals for this location' });
  expect(within(dialog).getByText(/Cleaned copies and days stay/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete all originals for this location' }));
  expect(await screen.findByText('Deleted 2 originals. 1 file was busy and kept.')).toBeTruthy();
  expect(fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/originals']);
});

test('under view-as files show as kinds and dates, with no download or delete, and Delete all disabled in place', async () => {
  // The API's view-as answer: no names, and no download or delete rights.
  const hidden = { name: null, canDownloadRaw: false, canDownloadClean: false, canDelete: false, canDeleteRaw: false } as const;
  setup(viewAsMe(ACCESS.admin), FILES.map((file) => ({ ...file, ...hidden })));
  const rows = within(await list()).getAllByRole('listitem');
  expect(within(at(rows, 0)).getByText('CSV or text file, uploaded Nov 5, 2026')).toBeTruthy();
  expect(within(at(rows, 2)).getByText('ZIP archive, uploaded Nov 5, 2026')).toBeTruthy();
  for (const row of rows) {
    const buttons = within(row).queryAllByRole('button').map((button) => button.textContent);
    expect(buttons.filter((label) => label !== 'See what’s inside')).toEqual([]);
  }
  const all = screen.getByRole('button', { name: 'Delete all originals for this location' });
  expect(all.getAttribute('aria-disabled')).toBe('true');
  expect(all.getAttribute('aria-describedby')).toBe('files-ro');
  expect(document.body.textContent).not.toContain('march.csv');
});

test('under view-as no download or delete shows even if a file’s flags allow them', async () => {
  setup(viewAsMe(ACCESS.admin), FILES.map((file) => ({ ...file, name: null })));
  const rows = within(await list()).getAllByRole('listitem');
  for (const row of rows) {
    const buttons = within(row).queryAllByRole('button').map((button) => button.textContent);
    expect(buttons.filter((label) => label !== 'See what’s inside')).toEqual([]);
  }
});

test('while stored files are off, P12 has no Your files section', async () => {
  setup(meOf(ACCESS.admin), refusal(503, 'files_unavailable'));
  expect(await screen.findByRole('heading', { name: 'Uploads' })).toBeTruthy();
  await waitFor(() => { expect(screen.queryByRole('heading', { name: 'Your files' })).toBeNull(); });
});

test('any other failure to list shows Your files with the error and Try again, then the list', async () => {
  const fake = setup(meOf(ACCESS.admin), refusal(503, 'storage_unavailable'));
  await screen.findByRole('heading', { name: 'Your files' });
  expect(screen.getByText('Townwise isn’t responding. Try again in a minute.')).toBeTruthy();
  fake.lists[''] = FILES;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(within(await screen.findByRole('list', { name: 'Your files' })).getAllByRole('listitem')).toHaveLength(3);
});
