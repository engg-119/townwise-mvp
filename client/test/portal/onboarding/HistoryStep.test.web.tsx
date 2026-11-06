import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { FileView, ImportView } from '../../../src/portal/files/api';
import { FORECAST_LINE } from '../../../src/portal/home/Home';
import { STEP } from '../../../src/portal/onboarding/history';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, locationOf, meOf, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, historyBody, run, type AnalyticsFake } from '../analytics/fakes';
import { NOVEMBER } from '../estimates/fakes';
import { entryOf, fileViewOf, filesFake, importViewOf, type FilesFake } from '../files/fakes';

// Onboarding step 3 on Home, on web (spec P11, 11A; storage2 2.1, 2.2, 13 and 15.3): the drop zone with what to
// drop in and the location card beside it, many files uploading at once with their own progress and time left, Read
// my history, the Reading screen (each file's status and time left, the question, kept files with their reason,
// found so far and the calendar), Done handing over to Home, the browser upload while stored files are off or
// after a refusal, and view-as with no drop and no upload. Synthetic files of zeros only.
// Pillars: "Estimating" where the server or the queue has no basis, and every line from the server's own counts
// (T, E); nothing kept in browser storage, nothing uploaded under view-as, and the daily-totals choice always
// linked (P).

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 5, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const PATH = '/api/org/locations/l1';
const HISTORY = `${PATH}/sales/history`;
const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
const EMPTY = [locationOf('l1', 'Main Street Bar', HANOVER)];
const DAYS = run('2026-10-01', '2026-10-03', () => 80);
const READ_FOUND = {
  dayCount: 3, firstDate: '2026-10-01', lastDate: '2026-10-03', guestsDayCount: 3, netSalesDayCount: 3, closedDates: [], missingDays: 0,
};

const RESULT: FileView['result'] = {
  dayCount: 3, firstDate: '2026-10-01', lastDate: '2026-10-03', guestsDayCount: 3, netSalesDayCount: 3, inserted: 3, replaced: 0, kept: 0,
  closedDates: [], missingDays: 0, uploadId: '00000000-0000-0000-0000-00000000a001',
};

interface Setup { api: FakePortalApi; files: FilesFake; analytics: AnalyticsFake }

async function show(me: MeResponse, current: unknown): Promise<Setup> {
  const analytics = analyticsFake({
    [HISTORY]: historyBody([]),
    [`${PATH}/notes`]: { notes: [] },
    [`${PATH}/calendar?from=2024-10-07&to=2026-11-30`]: calendarBody(),
    [`${PATH}/agent`]: { questions: [], activity: [] },
    [`${PATH}/people-in-town?from=2026-11-01&to=2026-11-30`]: NOVEMBER,
  });
  const files = filesFake({ inner: analytics });
  files.current = current;
  const api = fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member', EMPTY), fallback: files });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = '/locations/l1';
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  await screen.findByText(FORECAST_LINE);
  return { api, files, analytics };
}

function step(): HTMLElement {
  return screen.getByRole('region', { name: STEP.title });
}

function zeros(name: string, size: number): File {
  return new File([new Uint8Array(size)], name);
}

function choose(files: File[]): void {
  const input = screen.getByTestId('history-files');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  fireEvent.change(input);
}

/** Answers every chunk the queue has sent, until each file is complete. */
async function sendAll(files: FilesFake, count: number): Promise<void> {
  await waitFor(() => {
    for (const put of files.puts.splice(0)) put.ok();
    expect(files.calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(count);
  });
}

test('the drop step: what to drop in, the location card, the accept hint, Read my history disabled, and the daily-totals link', async () => {
  await show(meOf(ACCESS.admin), { import: null });
  const region = await screen.findByRole('region', { name: STEP.title });
  expect(within(region).getByText(STEP.step)).toBeTruthy();
  expect(within(region).getByRole('heading', { name: STEP.dropHeading })).toBeTruthy();
  expect(within(region).getByText('Any file: CSV, Excel, PDF, Word, ZIP or text.')).toBeTruthy();
  for (const each of ['Daily sales summaries', 'Sales reports, as Excel, CSV or PDF', 'ZIPs of exports']) expect(within(region).getByText(each)).toBeTruthy();
  const card = within(region).getByRole('region', { name: STEP.cardEyebrow });
  expect(within(card).getByRole('heading', { name: 'Main Street Bar' })).toBeTruthy();
  expect(within(card).getByText('Hanover, NH')).toBeTruthy();
  expect(within(card).getByText('College town')).toBeTruthy();
  expect(within(region).getByText(/Each original is deleted after 365 days/)).toBeTruthy();
  const read = within(region).getByRole('button', { name: STEP.read });
  expect(read.getAttribute('aria-disabled')).toBe('true');
  expect(read.getAttribute('aria-describedby')).toBe('history-step-read-help');
  expect(within(region).getByText(STEP.readHelpNone)).toBeTruthy();
  expect(within(region).getByRole('link', { name: STEP.dailyTotalsLink }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  // The cards that need days stay away while the step shows.
  expect(document.getElementById('home-history')).toBeNull();
});

test('many files upload at once, each with its own progress and line, then Read my history starts reading', async () => {
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  const { files, api } = await show(meOf(ACCESS.admin), { import: null });
  await screen.findByRole('heading', { name: STEP.dropHeading });
  choose([zeros('sales_2024.csv', 8), zeros('sales_2025.csv', 8), zeros('export.zip', 8), zeros('report.pdf', 8)]);
  // Three at a time; the fourth waits its turn.
  await waitFor(() => { expect(files.calls.filter((call) => call.method === 'POST' && call.path === '/files')).toHaveLength(3); });
  const list = screen.getByRole('list', { name: 'Your files' });
  expect(within(list).getByText('report.pdf')).toBeTruthy();
  expect(within(list).getByText('Waiting to upload')).toBeTruthy();
  expect(within(list).getAllByRole('progressbar').length).toBeGreaterThan(0);
  expect(screen.getByText(/^4 files, 1 KB · /)).toBeTruthy();
  expect(within(list).getByRole('button', { name: 'Cancel report.pdf' })).toBeTruthy();

  files.current = {
    import: importViewOf('i1', {
      files: ['f1', 'f2', 'f3', 'f4'].map((id) => fileViewOf(id, { status: 'stored', result: null, hasClean: false })),
    }),
  };
  await sendAll(files, 4);
  const read = await screen.findByRole('button', { name: STEP.read });
  await waitFor(() => { expect(read.getAttribute('aria-disabled')).toBeNull(); });

  files.answers['POST /imports/i1/start'] = () => ({
    import: importViewOf('i1', {
      status: 'reading', startedAt: '2026-11-05T17:00:00.000Z',
      files: [
        fileViewOf('f1', { name: 'sales_2024.csv', status: 'reading', result: null, etaSeconds: null, progress: { phase: 'reading', done: 2, total: 8, unit: 'bytes' } }),
        fileViewOf('f2', { name: 'sales_2025.csv', status: 'queued', result: null, etaSeconds: null, queuePosition: 1 }),
      ],
      progress: { filesTotal: 2, filesDone: 0, bytesTotal: 16, bytesDone: 2 },
    }),
  });
  files.current = files.answers['POST /imports/i1/start'](undefined);
  fireEvent.click(read);
  await screen.findByRole('region', { name: STEP.readingTitle });
  // No basis for a time left yet: "Estimating", never a guess.
  expect(screen.getByText('0 of 2 files read · Estimating')).toBeTruthy();
  expect(screen.getByText('Reading · Estimating')).toBeTruthy();
  expect(screen.getByText('Waiting to be read, 1 in line · Estimating')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: 'sales_2024.csv, read' }).getAttribute('aria-valuenow')).toBe('25');
  expect(screen.getByText(STEP.closeOk)).toBeTruthy();
  // The names travel in the create bodies only, never in a path.
  expect(api.calls.some((call) => call.path.includes('sales_2024'))).toBe(false);
  expect(files.calls.filter((call) => call.method === 'POST' && call.path === '/files').map((call) => call.body)).toContainEqual(
    { name: 'sales_2024.csv', sizeBytes: 8, purpose: 'history' },
  );
  expect(setItem).not.toHaveBeenCalled();
});

/** One file uploaded by this screen and listed by the server as stored, with Read my history enabled. */
async function uploadOne(files: FilesFake): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: STEP.dropHeading });
  choose([zeros('sales.csv', 4)]);
  files.current = { import: importViewOf('i1', { files: [fileViewOf('f1', { name: 'sales.csv', status: 'stored', result: null, hasClean: false })] }) };
  await sendAll(files, 1);
  const read = await screen.findByRole('button', { name: STEP.read });
  await waitFor(() => { expect(read.getAttribute('aria-disabled')).toBeNull(); });
  return read;
}

test('Remove on a file this screen just uploaded that the server refuses to delete: the row stays and says why', async () => {
  const { files } = await show(meOf(ACCESS.admin), { import: null });
  const read = await uploadOne(files);
  files.answers['DELETE /files/f1'] = () => refusal(503, 'storage_unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Remove sales.csv' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(files.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/f1']);
  // Still stored on the server, so still listed and still counted for Read my history.
  expect(within(screen.getByRole('list', { name: 'Your files' })).getByText('sales.csv')).toBeTruthy();
  expect(read.getAttribute('aria-disabled')).toBeNull();
});

test('Remove on a file this screen just uploaded: once the server deletes it, the row leaves', async () => {
  const { files } = await show(meOf(ACCESS.admin), { import: null });
  const read = await uploadOne(files);
  files.answers['DELETE /files/f1'] = () => {
    files.current = { import: importViewOf('i1', { files: [] }) };
    return undefined;
  };
  fireEvent.click(screen.getByRole('button', { name: 'Remove sales.csv' }));
  await waitFor(() => { expect(screen.queryByRole('list', { name: 'Your files' })).toBeNull(); });
  expect(read.getAttribute('aria-disabled')).toBe('true');
  expect(files.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/f1']);
});

test('Cancel on a file still sending stops it and deletes what the server has', async () => {
  const { files } = await show(meOf(ACCESS.admin), { import: null });
  await screen.findByRole('heading', { name: STEP.dropHeading });
  choose([zeros('slow.csv', 8)]);
  const cancel = await screen.findByRole('button', { name: 'Cancel slow.csv' });
  await waitFor(() => { expect(files.puts).toHaveLength(1); });
  fireEvent.click(cancel);
  await waitFor(() => { expect(screen.queryByRole('list', { name: 'Your files' })).toBeNull(); });
  expect(files.puts[0]?.signal?.aborted).toBe(true);
  expect(files.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/f1']);
});

test('files dropped anywhere on the step are added, and the zone says how many are coming', async () => {
  const { files } = await show(meOf(ACCESS.member), { import: null });
  await screen.findByRole('heading', { name: STEP.dropHeading });
  const file = zeros('march.csv', 4);
  const dataTransfer = { types: ['Files'], items: [{}, {}], files: [file], dropEffect: 'none' };
  fireEvent.dragEnter(screen.getByText(STEP.lead), { dataTransfer });
  expect(screen.getByRole('heading', { name: 'Drop to add 2 files' })).toBeTruthy();
  fireEvent.drop(screen.getByText(STEP.lead), { dataTransfer });
  expect(screen.getByRole('heading', { name: STEP.dropHeading })).toBeTruthy();
  await waitFor(() => { expect(files.calls.filter((call) => call.method === 'POST' && call.path === '/files')).toHaveLength(1); });
});

test('files dropped just outside the step are caught and ignored, so the browser never opens them over the page', async () => {
  const { files } = await show(meOf(ACCESS.admin), { import: null });
  await screen.findByRole('heading', { name: STEP.dropHeading });
  const dataTransfer = { types: ['Files'], items: [{}], files: [zeros('stray.csv', 4)], dropEffect: 'copy' };
  // fireEvent answers false when a listener prevented the browser's default (opening the file in the tab).
  expect(fireEvent.dragOver(document.body, { dataTransfer })).toBe(false);
  expect(dataTransfer.dropEffect).toBe('none');
  expect(fireEvent.drop(document.body, { dataTransfer })).toBe(false);
  // A drag of text or a link is left alone.
  expect(fireEvent.drop(document.body, { dataTransfer: { types: ['text/plain'], items: [], files: [] } })).toBe(true);
  expect(files.calls.filter((call) => call.method === 'POST')).toEqual([]);
  // Inside the step a drop still adds the file.
  fireEvent.drop(screen.getByText(STEP.lead), { dataTransfer });
  await waitFor(() => { expect(files.calls.filter((call) => call.method === 'POST' && call.path === '/files')).toHaveLength(1); });
});

test('a refusal says why on its row and offers the browser upload', async () => {
  const { files } = await show(meOf(ACCESS.admin), { import: null });
  await screen.findByRole('heading', { name: STEP.dropHeading });
  files.answers['POST /files'] = () => refusal(409, 'daily_upload_limit');
  choose([zeros('big.csv', 8)]);
  expect(await screen.findByText('Your organization reached today’s upload limit. Upload the rest tomorrow.')).toBeTruthy();
  expect(screen.getByText(STEP.refusedOffer)).toBeTruthy();
  expect(screen.getByRole('link', { name: STEP.dailyTotalsLink }).getAttribute('href')).toBe('/locations/l1/sales/upload');
});

test('stored files off: no drop zone, the browser upload instead', async () => {
  await show(meOf(ACCESS.admin), refusal(503, 'files_unavailable'));
  expect(await screen.findByRole('heading', { name: STEP.offTitle })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: STEP.dropHeading })).toBeNull();
  expect(screen.queryByTestId('history-files')).toBeNull();
  expect(screen.getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
});

test('reading: the question, each file kept and not used with its reason, a ZIP’s count, and found so far', async () => {
  const question = {
    id: 'q1', fileId: 'f2', fileName: 'sales_2026.csv', kind: 'date_column' as const,
    options: [{ id: '0', label: 'Business Date' }, { id: '1', label: 'Closed Date' }, { id: 'not_sure', label: 'not_sure' }],
    suggested: '0', family: null,
  };
  const view: ImportView = importViewOf('i1', {
    status: 'waiting', startedAt: '2026-11-05T17:00:00.000Z', question, found: READ_FOUND,
    progress: { filesTotal: 4, filesDone: 3, bytesTotal: 40, bytesDone: 30 },
    files: [
      fileViewOf('f1', { name: 'sales_2025.csv', result: RESULT }),
      fileViewOf('f2', { name: 'sales_2026.csv', status: 'waiting', result: null }),
      fileViewOf('f3', { name: 'old.xls', kind: 'xls', status: 'kept', outcome: 'old_excel', result: null }),
      fileViewOf('f4', { name: 'toast.zip', kind: 'zip', status: 'kept', outcome: 'nothing_usable', result: null, entries: { total: 12, used: 0, kept: 12 } }),
    ],
  });
  const { analytics, files } = await show(meOf(ACCESS.admin), { import: view });
  analytics.answers[HISTORY] = historyBody(DAYS);
  expect(await screen.findByRole('heading', { name: 'Which column has the date of each sale?' })).toBeTruthy();
  expect(screen.getByText('3 of 4 files read · Waiting for your answer')).toBeTruthy();
  expect(screen.getByText('Used: 3 days, Oct 1, 2026 to Oct 3, 2026')).toBeTruthy();
  expect(screen.getByText('Kept, not used: Townwise can’t read old Excel files yet. Save it as .xlsx or CSV and drop it again.')).toBeTruthy();
  expect(screen.getByText('Kept, not used: none of the files inside had daily sales Townwise could use.')).toBeTruthy();
  expect(screen.getByText('12 files inside: 0 used, 12 kept, not used')).toBeTruthy();
  // A ZIP's files inside, each with its own status and reason (storage2 2.2).
  files.entries['f4:'] = { entries: [entryOf(0, { status: 'kept', outcome: 'system_file', dayCount: null })], next: null };
  fireEvent.click(screen.getByRole('button', { name: 'See what’s inside' }));
  const inside = await screen.findByRole('list', { name: 'Files inside toast.zip' });
  expect(within(inside).getByText('export/day-0.csv')).toBeTruthy();
  expect(screen.getByText('3 days, Oct 1, 2026 to Oct 3, 2026.')).toBeTruthy();
  // The calendar is one picture named by its summary.
  const calendar = document.getElementById('history-step-calendar');
  if (calendar === null) throw new Error('no calendar');
  expect(within(calendar).getByRole('img').getAttribute('aria-label')).toMatch(/^Your history so far\. /);
  // Screen readers hear the pause once.
  expect(screen.getAllByRole('status').filter((element) => element.textContent === STEP.questionLine)).toHaveLength(1);
});

test('done: the step says what it found and hands over to Home, which shows the history card', async () => {
  const open = importViewOf('i1', { files: [fileViewOf('f1', { status: 'stored', result: null })] });
  const { files, analytics, api } = await show(meOf(ACCESS.admin), { import: open });
  const read = await screen.findByRole('button', { name: STEP.read });
  const done = importViewOf('i1', { status: 'done', finishedAt: '2026-11-05T17:01:00.000Z', found: READ_FOUND, files: [fileViewOf('f1')] });
  files.answers['POST /imports/i1/start'] = () => ({ import: done });
  files.current = { import: done };
  fireEvent.click(read);
  // Shown, and said once by the status line.
  expect(await screen.findAllByText('Done. 3 days, Oct 1, 2026 to Oct 3, 2026.')).toHaveLength(2);
  expect(screen.getByText(STEP.opening)).toBeTruthy();
  analytics.answers[HISTORY] = historyBody(DAYS);
  api.org = orgOf('org_admin', [locationOf('l1', 'Main Street Bar', HANOVER, {
    coverage: { dayCount: 3, guestsDayCount: 3, netSalesDayCount: 3, firstDate: '2026-10-01', lastDate: '2026-10-03', missingDays: 0 },
  })]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: STEP.goHome })); await Promise.resolve(); });
  await waitFor(() => { expect(document.getElementById('home-history')).not.toBeNull(); });
  expect(screen.queryByRole('region', { name: STEP.readingTitle })).toBeNull();
});

test('nothing usable: the reasons stay listed with the drop zone, and no hand-over', async () => {
  const view = importViewOf('i1', {
    status: 'done', finishedAt: '2026-11-05T17:01:00.000Z',
    files: [fileViewOf('f1', { name: 'scan.pdf', kind: 'pdf', status: 'kept', outcome: 'pdf_scanned', result: null })],
  });
  await show(meOf(ACCESS.admin), { import: view });
  // Shown, and said once by the status line.
  expect(await screen.findAllByText(STEP.nothingUsed)).toHaveLength(2);
  expect(screen.getByText('Kept, not used: this PDF is a scan, with no text Townwise can read.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: STEP.dropHeading })).toBeTruthy();
  expect(screen.queryByRole('button', { name: STEP.goHome })).toBeNull();
});

test('view-as: no drop and no upload, the controls disabled with the read-only line, and no write', async () => {
  const { api } = await show(viewAsMe(ACCESS.admin), { import: importViewOf('i1', { files: [fileViewOf('f1', { name: null, status: 'stored', result: null, canDelete: false })] }) });
  await screen.findByRole('heading', { name: STEP.dropHeading });
  const region = step();
  expect(within(region).queryByTestId('history-files')).toBeNull();
  const choose = within(region).getByRole('button', { name: STEP.chooseMore });
  expect(choose.getAttribute('aria-disabled')).toBe('true');
  expect(choose.getAttribute('aria-describedby')).toBe('history-step-ro');
  expect(within(region).getByText('Read-only while viewing as gm@example.org.')).toBeTruthy();
  expect(within(region).getByRole('button', { name: STEP.read }).getAttribute('aria-disabled')).toBe('true');
  // The browser upload is no way in either: disabled in place like Home's other upload links.
  expect(within(region).queryByRole('link', { name: STEP.dailyTotalsLink })).toBeNull();
  const daily = within(region).getByRole('button', { name: STEP.dailyTotalsLink });
  expect(daily.getAttribute('aria-disabled')).toBe('true');
  expect(daily.getAttribute('aria-describedby')).toBe('history-step-ro');
  // The name is the kind's label under view-as, and no row can be removed.
  expect(within(region).getByText('CSV or text file, uploaded Nov 5, 2026')).toBeTruthy();
  expect(within(region).queryByRole('button', { name: /^Remove / })).toBeNull();
  fireEvent.drop(within(region).getByText(STEP.lead), { dataTransfer: { types: ['Files'], items: [{}], files: [zeros('a.csv', 4)] } });
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});
