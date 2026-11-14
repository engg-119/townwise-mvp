import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { FileView, ImportView } from '../../../src/portal/files/api';
import { STEP } from '../../../src/portal/onboarding/history';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, locationOf, meOf, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, historyBody } from '../analytics/fakes';
import { aiOf, dataFake, itemOf, type DataFake } from '../data/fakes';
import { NOVEMBER } from '../estimates/fakes';
import { fileViewOf, importViewOf } from '../files/fakes';

// The TownwiseAI opt-in under onboarding step 3's drop (D34, spec 11A.9, P11 step 3), on web: off by default, so a
// dropped file is never sent; checked, each file that finishes uploading is sent once, but only after Townwise has
// read it for sales (asking before that answers 400), through its upload when it wrote days and through itself when
// it wrote none; a kind TownwiseAI can't read is never sent; a refusal shows on the file's row and never undoes the
// upload. Stored files off shows the browser upload, which never offers TownwiseAI. Synthetic files of zeros only.

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
});

const PATH = '/api/org/locations/l1';
const EMPTY = [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })];
const OPT_IN = 'Let TownwiseAI read these files and use what it finds';
const HELP = 'Each file you add is sent whole to Anthropic’s Claude to read. You can undo what TownwiseAI adds from a file on its page.';
const ASKED = 'Added. TownwiseAI is reading it; open it on Your data to see what it finds.';

const WROTE_DAYS: FileView['result'] = {
  dayCount: 3, firstDate: '2026-10-01', lastDate: '2026-10-03', guestsDayCount: 3, netSalesDayCount: 3, inserted: 3, replaced: 0, kept: 0,
  closedDates: [], missingDays: 0, uploadId: '0000000000000000000000a1',
};

async function show(me: MeResponse, current: unknown): Promise<{ api: FakePortalApi; fake: DataFake }> {
  const analytics = analyticsFake({
    [`${PATH}/sales/history`]: historyBody([]),
    [`${PATH}/notes`]: { notes: [] },
    [`${PATH}/calendar?from=2024-10-07&to=2026-11-30`]: calendarBody(),
    [`${PATH}/agent`]: { questions: [], activity: [] },
    [`${PATH}/people-in-town?from=2026-11-01&to=2026-11-30`]: NOVEMBER,
  });
  const fake = dataFake({ inner: analytics });
  // Your data's fake answers the sales history itself.
  fake.history.l1 = historyBody([]);
  fake.files.current = current;
  fake.answers['POST ai'] = () => ({ item: itemOf('f_any', { ai: aiOf({ status: 'queued', kind: null }) }) });
  const api = fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member', EMPTY), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', '/locations/l1');
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location="/locations/l1" />
    </Head.Provider>,
  );
  await screen.findByText(/^Townwise hasn’t published a forecast for /);
  return { api, fake };
}

function zeros(name: string, size: number): File {
  return new File([new Uint8Array(size)], name);
}

/** Drops `names` and lets each finish uploading; the server then lists them stored in import i1. */
async function drop(fake: DataFake, names: string[]): Promise<void> {
  await screen.findByRole('heading', { name: STEP.dropHeading });
  const input = screen.getByTestId('history-files');
  Object.defineProperty(input, 'files', { configurable: true, value: names.map((name) => zeros(name, 4)) });
  fireEvent.change(input);
  fake.files.current = {
    import: importViewOf('i1', { files: names.map((name, index) => fileViewOf(`f${String(index + 1)}`, { name, status: 'stored', result: null, hasClean: false })) }),
  };
  await waitFor(() => {
    for (const put of fake.files.puts.splice(0)) put.ok();
    expect(fake.files.calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(names.length);
  });
  // The queue marks an upload done only after its complete call answers, and the box is read when a file is done:
  // wait until the step shows none still sending, so a box clicked next is clicked after every file finished.
  await waitFor(() => {
    expect(screen.queryByText(STEP.readHelpNone)).toBeNull();
    expect(screen.queryByText(STEP.readHelpSending)).toBeNull();
  });
}

/** Read my history, answered with `view`: the screen shows the files as the server now lists them. */
async function readAs(fake: DataFake, view: ImportView): Promise<void> {
  const read = await screen.findByRole('button', { name: STEP.read });
  await waitFor(() => { expect(read.getAttribute('aria-disabled')).toBeNull(); });
  fake.files.answers['POST /imports/i1/start'] = () => ({ import: view });
  fake.files.current = { import: view };
  fireEvent.click(read);
  await screen.findByRole('region', { name: STEP.readingTitle });
}

function reading(files: FileView[]): ImportView {
  return importViewOf('i1', { status: 'reading', startedAt: '2026-11-05T17:00:00.000Z', files, progress: { filesTotal: files.length, filesDone: 0, bytesTotal: 8, bytesDone: 0 } });
}

async function settle(ms = 20): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole('list', { name: 'Your files' })).getAllByRole('listitem').find((item) => within(item).queryByText(name) !== null);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
}

test('the box under the drop is off by default and says what reading sends, with the privacy link; a file dropped with it off is never sent', async () => {
  const { fake } = await show(meOf(ACCESS.admin), { import: null });
  const box = await screen.findByRole('checkbox', { name: OPT_IN });
  expect((box as HTMLInputElement).checked).toBe(false);
  expect(box.getAttribute('aria-describedby')?.split(' ')).toContain(screen.getByText(HELP).id);
  expect(screen.getByRole('link', { name: 'How Townwise handles your data' }).getAttribute('href')).toBe('/privacy');

  await drop(fake, ['sales.csv']);
  // Checked only after the file finished: it was added with the box off, so it is still never sent.
  fireEvent.click(box);
  expect((box as HTMLInputElement).checked).toBe(true);
  await readAs(fake, reading([fileViewOf('f1', { name: 'sales.csv', status: 'read', result: WROTE_DAYS })]));
  await settle();
  expect(fake.ai).toEqual([]);
  expect(screen.queryByText(ASKED)).toBeNull();
});

test('checked, each file is sent once only after Townwise read it for sales: through its upload when it wrote days, else itself', async () => {
  const { fake, api } = await show(meOf(ACCESS.admin), { import: null });
  fireEvent.click(await screen.findByRole('checkbox', { name: OPT_IN }));
  await drop(fake, ['sales.csv', 'calendar.pdf']);
  // Stored, not read yet: asking now would answer 400, so nothing is sent.
  await settle();
  expect(fake.ai).toEqual([]);

  await readAs(fake, reading([
    fileViewOf('f1', { name: 'sales.csv', status: 'read', result: WROTE_DAYS }),
    fileViewOf('f2', { name: 'calendar.pdf', kind: 'pdf', status: 'reading', result: null }),
  ]));
  await waitFor(() => { expect(fake.ai).toHaveLength(1); });
  // A file that wrote days is its upload on Your data: its own f_ ref answers 404.
  expect(fake.ai).toEqual([{ method: 'POST', ref: 'u_0000000000000000000000a1', body: {} }]);
  expect(await within(rowOf('sales.csv')).findByText(ASKED)).toBeTruthy();
  expect(within(rowOf('calendar.pdf')).queryByText(ASKED)).toBeNull();

  // The next status read (2 seconds) finds the calendar kept, not used for sales: it is sent as itself.
  fake.files.current = {
    import: reading([
      fileViewOf('f1', { name: 'sales.csv', status: 'read', result: WROTE_DAYS }),
      fileViewOf('f2', { name: 'calendar.pdf', kind: 'pdf', status: 'kept', outcome: 'no_sales_columns', result: null }),
    ]),
  };
  await waitFor(() => { expect(fake.ai).toHaveLength(2); }, { timeout: 4000 });
  expect(fake.ai[1]).toEqual({ method: 'POST', ref: 'f_f2', body: {} });
  expect(await within(rowOf('calendar.pdf')).findByText(ASKED)).toBeTruthy();
  // Once each: later status reads send nothing more, and no name travels in a path.
  await settle(2500);
  expect(fake.ai).toHaveLength(2);
  expect(api.calls.some((call) => call.path.includes('calendar.pdf') || call.path.includes('sales.csv'))).toBe(false);
}, 20_000);

test('a kind TownwiseAI can’t read is never sent, and its row says why', async () => {
  const { fake } = await show(meOf(ACCESS.admin), { import: null });
  fake.files.answers['POST /files/f1/complete'] = () => ({
    file: fileViewOf('f1', { name: 'old.xls', kind: 'xls', status: 'stored', result: null, hasClean: false }), import: { id: 'i1', status: 'open' },
  });
  fireEvent.click(await screen.findByRole('checkbox', { name: OPT_IN }));
  await drop(fake, ['old.xls']);
  await readAs(fake, reading([fileViewOf('f1', { name: 'old.xls', kind: 'xls', status: 'kept', outcome: 'old_excel', result: null })]));
  expect(await within(rowOf('old.xls')).findByText(
    'Added. TownwiseAI can’t read old Excel files (.xls). Save it as .xlsx and add it again to let TownwiseAI read it.',
  )).toBeTruthy();
  await settle();
  expect(fake.ai).toEqual([]);
});

test('a refusal says why on the file’s row and keeps the upload; 503 ai_unavailable hides the box', async () => {
  const { fake } = await show(meOf(ACCESS.admin), { import: null });
  fake.answers['POST ai'] = () => refusal(503, 'ai_unavailable');
  fireEvent.click(await screen.findByRole('checkbox', { name: OPT_IN }));
  await drop(fake, ['sales.csv']);
  await readAs(fake, reading([fileViewOf('f1', { name: 'sales.csv', status: 'read', result: WROTE_DAYS })]));
  expect(await within(rowOf('sales.csv')).findByText(
    'Added, but TownwiseAI didn’t start reading it. TownwiseAI can’t read files right now. Try again later.',
  )).toBeTruthy();
  // The drop stays open while reading, without the box.
  expect(screen.getByRole('heading', { name: STEP.dropHeading })).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: OPT_IN })).toBeNull();
  expect(fake.files.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
});

test('409 ai_read_running: TownwiseAI is already reading it, and the row says so', async () => {
  const { fake } = await show(meOf(ACCESS.admin), { import: null });
  fake.answers['POST ai'] = () => refusal(409, 'ai_read_running');
  fireEvent.click(await screen.findByRole('checkbox', { name: OPT_IN }));
  await drop(fake, ['sales.csv']);
  await readAs(fake, reading([fileViewOf('f1', { name: 'sales.csv', status: 'read', result: WROTE_DAYS })]));
  expect(await within(rowOf('sales.csv')).findByText(ASKED)).toBeTruthy();
});

test('stored files off: the browser upload, which never offers TownwiseAI', async () => {
  const { fake } = await show(meOf(ACCESS.admin), refusal(503, 'files_unavailable'));
  expect(await screen.findByRole('heading', { name: STEP.offTitle })).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: OPT_IN })).toBeNull();
  expect(screen.queryByText(HELP)).toBeNull();
  expect(fake.ai).toEqual([]);
});

test('view-as: the box is shown disabled with the read-only line and can’t be checked', async () => {
  await show(viewAsMe(ACCESS.admin), { import: null });
  const box = await screen.findByRole('checkbox', { name: OPT_IN });
  expect(box.getAttribute('aria-disabled')).toBe('true');
  expect(box.getAttribute('aria-describedby')?.split(' ')).toContain('history-step-ro');
  fireEvent.click(box);
  expect((box as HTMLInputElement).checked).toBe(false);
});
