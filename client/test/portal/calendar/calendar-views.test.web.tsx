import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot, router } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, offline, orgOf, type FakePortalApi } from '../../helpers/portal';
import { townEvent } from '../analytics/fakes';
import { calendarFake, forecastDay, forecastOf, PATH, setToday, type CalendarFake } from './fakes';

// P28 Calendar's views on web (spec 16.3). The month view: the grid is always 6 weeks, a leading or trailing day is
// selected in place, the grid moves only on Previous, Next, Today, PageUp and PageDown or when the selected day leaves
// it, a month whose reads are in flight renders at once with its uncovered days pending, the cells are the same height
// every month, the filters sit where the width puts them, and focus survives a change of grid. The week view: 7-day
// blocks counted from today, Month and Week kept in `?view=`, no read on a switch while the block lies inside the grid
// and its own days' read when it runs past, the grid's month kept across it, Previous, Next and the keys by blocks, its
// own forecast notice, and focus that survives a switch from outside the page. Today is Wed, Nov 11, 2026 unless a
// test sets it. Synthetic figures and made-up titles only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

// Only Date is faked, so "today" is Wed, Nov 11, 2026 and every timer stays real.
beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 11, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  if (width !== 1280) setWidth(1280);
});

/** November and December from today on, each day 180 to 240 around 212. */
function forecasts(): Record<string, unknown> {
  const days = (from: number, to: number, month: string) => Array.from({ length: to - from + 1 }, (_, at) => forecastDay({ date: `${month}-${String(from + at).padStart(2, '0')}` }));
  return { '2026-11': forecastOf(days(11, 30, '2026-11')), '2026-12': forecastOf(days(1, 31, '2026-12')) };
}

function setup(init: Partial<Pick<CalendarFake, 'forecasts'>> = {}): { api: FakePortalApi; fake: CalendarFake } {
  const fake = calendarFake({
    events: [townEvent({ start: '2026-11-21', title: 'Dartmouth home football' }), townEvent({ start: '2026-12-03', title: 'Tree lighting' })],
    days: [{ date: '2026-11-07', guests: 138, netSalesCents: 276000 }],
    forecasts: forecasts(),
    ...init,
  });
  return { api: fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake }), fake };
}

async function renderAt(path: string, api: FakePortalApi, month = 'November 2026'): Promise<HTMLElement> {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return screen.findByRole('grid', { name: month });
}

function cell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`);
  if (found === null) throw new Error(`no cell for ${date}`);
  return found;
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Selected day' });
}

function day(): string | null {
  return new URLSearchParams(window.location.search).get('day');
}

function query(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function forecastReads(fake: CalendarFake): string[] {
  return fake.paths.filter((path) => path.includes('/forecast?'));
}

function before(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** jsdom has no PointerEvent, so `pointerType` is set on a plain one. */
function mouseOver(element: Element): void {
  const event = new MouseEvent('pointerover', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  fireEvent(element, event);
}

test('clicking a trailing day selects it in place: the grid stays on November and nothing more is read', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const reads = fake.paths.length;
  fireEvent.click(cell('2026-12-03'));
  await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Thu, Dec 3, 2026' })).toBeTruthy(); });
  expect(screen.getByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(cell('2026-12-03').getAttribute('aria-selected')).toBe('true');
  expect(cell('2026-12-03').getAttribute('data-outside')).toBe('1');
  expect(day()).toBe('2026-12-03');
  expect(fake.paths.slice(reads)).toEqual([]);
  expect(forecastReads(fake)).toEqual([`${PATH}/forecast?from=2026-10-26&to=2026-12-06`]);
});

test('ArrowDown into a month still loading: December’s grid at once, its uncovered days pending', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-30', api);
  const releases = [fake.hold('calendar', '2026-11-30'), fake.hold('forecast', '2026-11-30')];
  cell('2026-11-30').focus();
  fireEvent.keyDown(cell('2026-11-30'), { key: 'ArrowDown' });
  const grid = await screen.findByRole('grid', { name: 'December 2026' });
  expect(grid.getAttribute('aria-busy')).toBe('true');
  expect(document.activeElement).toBe(cell('2026-12-07'));
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  // November's reads cover Nov 30 to Dec 6; Dec 7 on wait for December's.
  expect(cell('2026-12-03').textContent).toContain('Tree lighting');
  expect(cell('2026-12-03').textContent).toContain('212');
  expect(cell('2026-12-12').textContent).toBe('12');
  expect(cell('2026-12-12').getAttribute('aria-label')).toBe('Sat, Dec 12, 2026. Loading.');
  expect(within(panel()).getByText('Loading the day')).toBeTruthy();
  mouseOver(cell('2026-12-12'));
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  // A covered day still has its tooltip.
  mouseOver(cell('2026-12-03'));
  expect(screen.getByTestId('calendar-tooltip')).toBeTruthy();
  await act(async () => { for (const release of releases) release(); await Promise.resolve(); });
  await waitFor(() => { expect(screen.getByRole('grid', { name: 'December 2026' }).getAttribute('aria-busy')).toBe('false'); });
  expect(cell('2026-12-12').textContent).toContain('212');
  expect(within(panel()).getByRole('heading', { name: 'Mon, Dec 7, 2026' })).toBeTruthy();
});

test('Next month from November shows December with Dec 1 selected, though Dec 1 is in November’s grid', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-11', api);
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
  await waitFor(() => { expect(cell('2026-12-01').getAttribute('aria-selected')).toBe('true'); });
  expect(screen.getByRole('grid', { name: 'December 2026' })).toBeTruthy();
  expect(day()).toBe('2026-12-01');
});

test('Previous and Next step from the grid’s month, not from a trailing day’s own', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(cell('2026-12-03'));
  await waitFor(() => { expect(day()).toBe('2026-12-03'); });
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
  cleanup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', setup().api);
  fireEvent.click(cell('2026-12-03'));
  await waitFor(() => { expect(day()).toBe('2026-12-03'); });
  fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
  expect(await screen.findByRole('grid', { name: 'October 2026' })).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-10-01'); });
});

test('PageDown from a trailing day keeps the day selected and focused and moves the grid; ?day= stays', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(cell('2026-12-06'));
  await waitFor(() => { expect(day()).toBe('2026-12-06'); });
  cell('2026-12-06').focus();
  fireEvent.keyDown(cell('2026-12-06'), { key: 'PageDown' });
  expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
  expect(cell('2026-12-06').getAttribute('aria-selected')).toBe('true');
  expect(cell('2026-12-06').hasAttribute('data-outside')).toBe(false);
  expect(document.activeElement).toBe(cell('2026-12-06'));
  expect(day()).toBe('2026-12-06');
  // PageUp from it shows November again, still on Dec 6.
  fireEvent.keyDown(cell('2026-12-06'), { key: 'PageUp' });
  await waitFor(() => { expect(cell('2026-11-06').getAttribute('aria-selected')).toBe('true'); });
  expect(screen.getByRole('grid', { name: 'November 2026' })).toBeTruthy();
});

test('Today from a trailing day shows November with Nov 11 selected', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(cell('2026-12-03'));
  await waitFor(() => { expect(day()).toBe('2026-12-03'); });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  await waitFor(() => { expect(cell('2026-11-11').getAttribute('aria-selected')).toBe('true'); });
  expect(screen.getByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(day()).toBe('2026-11-11');
});

test('Today with today already selected in October’s trailing row shows November; ?day= stays', async () => {
  jest.setSystemTime(new Date(2026, 10, 3, 12, 0, 0));
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-10-15', api, 'October 2026');
  fireEvent.click(cell('2026-11-03'));
  await waitFor(() => { expect(day()).toBe('2026-11-03'); });
  expect(screen.getByRole('grid', { name: 'October 2026' })).toBeTruthy();
  expect(cell('2026-11-03').getAttribute('data-outside')).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(cell('2026-11-03').getAttribute('aria-selected')).toBe('true');
  expect(cell('2026-11-03').hasAttribute('data-outside')).toBe(false);
  expect(day()).toBe('2026-11-03');
});

test('at 1280 every cell is 104px tall in November 2026, January 2027 and February 2027', async () => {
  for (const [path, month] of [['2026-11-11', 'November 2026'], ['2027-01-15', 'January 2027'], ['2027-02-15', 'February 2027']] as const) {
    const grid = await renderAt(`/locations/l1/calendar?day=${path}`, setup().api, month);
    const heights = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"]')].map((each) => each.style.height);
    expect(heights).toHaveLength(42);
    expect(new Set(heights)).toEqual(new Set(['104px']));
    cleanup();
  }
});

test('the filters sit after the grid at 375, and before it at 800 and 1280', async () => {
  for (const [at, after] of [[375, true], [800, false], [1280, false]] as const) {
    setWidth(at);
    const grid = await renderAt('/locations/l1/calendar?day=2026-11-21', setup().api);
    const filters = screen.getByRole('group', { name: 'Show on the calendar' });
    expect(before(grid, filters)).toBe(after);
    expect(before(filters, panel())).toBe(true);
    cleanup();
  }
});

test('a ?day= outside the grid from elsewhere moves the grid, and focus on a cell follows to the new cell', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  cell('2026-11-21').focus();
  expect(document.activeElement).toBe(cell('2026-11-21'));
  act(() => { router.setParams({ day: '2026-09-15' }); });
  expect(await screen.findByRole('grid', { name: 'September 2026' })).toBeTruthy();
  await waitFor(() => { expect(document.activeElement).toBe(cell('2026-09-15')); });
  expect(document.activeElement).not.toBe(document.body);
});

test('a ?day= change from elsewhere leaves focus on a toolbar button alone', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const next = screen.getByRole('button', { name: 'Next month' });
  next.focus();
  act(() => { router.setParams({ day: '2026-09-15' }); });
  expect(await screen.findByRole('grid', { name: 'September 2026' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next month' }));
});

// The week view: 7-day blocks counted from today (refine-calendar-and-home design decision 4). Today is Wed, Nov 11,
// 2026 unless a test sets it, so the blocks start on Wednesdays: Nov 11 to 17, Nov 18 to 24, Nov 25 to Dec 1, and so on.

/** A file over 1 MB, which the import refuses unread. */
function chooseLargeFile(): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const file = new File(['BEGIN:VCALENDAR'], 'everything.ics', { type: 'text/calendar' });
  Object.defineProperty(file, 'size', { value: 1024 * 1024 + 1 });
  Object.defineProperty(file, 'text', { value: () => { throw new Error('read a file over 1 MB'); } });
  fireEvent.change(input, { target: { files: [file] } });
}

const TOO_LARGE = 'This file is over 1 MB. Export a shorter range of your calendar, or a CSV with fewer columns.';
const NOVEMBER_FORECAST = `${PATH}/forecast?from=2026-10-26&to=2026-12-06`;

function viewButton(name: 'Month' | 'Week'): HTMLElement {
  return within(screen.getByRole('group', { name: 'Calendar view' })).getByRole('button', { name });
}

function columns(grid: HTMLElement): HTMLElement[] {
  return [...grid.querySelectorAll<HTMLElement>('[role="gridcell"]')];
}

/** The 7 columns in view of the scrolling week (D64): the strip renders weeks either side of them. */
function inView(grid: HTMLElement): HTMLElement[] {
  return columns(grid).filter((column) => column.hasAttribute('data-view'));
}

test('Week sets view=week and keeps the day, with no read; Month takes view out of the URL', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(viewButton('Month').getAttribute('aria-pressed')).toBe('true');
  const reads = fake.paths.length;
  fireEvent.click(viewButton('Week'));
  // Nov 21 is in the block of Nov 18 to 24, inside November's grid.
  expect(await screen.findByRole('grid', { name: 'Nov 18 to 24, 2026' })).toBeTruthy();
  await waitFor(() => { expect(query().get('view')).toBe('week'); });
  expect(query().get('day')).toBe('2026-11-21');
  expect(viewButton('Week').getAttribute('aria-pressed')).toBe('true');
  expect(viewButton('Month').getAttribute('aria-pressed')).toBe('false');
  expect(cell('2026-11-21').getAttribute('aria-selected')).toBe('true');
  fireEvent.click(viewButton('Month'));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  await waitFor(() => { expect(query().has('view')).toBe(false); });
  expect(window.location.search).not.toContain('undefined');
  expect(query().get('day')).toBe('2026-11-21');
  expect(fake.paths.slice(reads)).toEqual([]);
});

test('a load at ?view=week opens the block that holds the selected day; any other view opens the month', async () => {
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', setup().api, 'Nov 18 to 24, 2026');
  expect(screen.getByText('Nov 18 to 24, 2026')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Previous week' })).toBeTruthy();
  expect(cell('2026-11-21').getAttribute('aria-selected')).toBe('true');
  // The week's figures and cards, from the grid's reads.
  expect(cell('2026-11-21').textContent).toContain('212');
  expect(cell('2026-11-21').textContent).toContain('Dartmouth home football');
  cleanup();
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=year', setup().api);
  expect(viewButton('Month').getAttribute('aria-pressed')).toBe('true');
});

test('the week’s columns at 1280: a grid named by the block, 7 gridcells in view from Wednesday, one tab stop, Saturday’s figure and range', async () => {
  const grid = await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', setup().api, 'Nov 18 to 24, 2026');
  expect(inView(grid).map((column) => column.getAttribute('data-date'))).toEqual([
    '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24',
  ]);
  // The strip renders 2 weeks either side to scroll to (D64): Nov 4 to Dec 8.
  expect(columns(grid)).toHaveLength(35);
  expect(columns(grid)[0]?.getAttribute('data-date')).toBe('2026-11-04');
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(inView(grid)[0]?.textContent).toContain('Wed 18');
  const saturday = cell('2026-11-21').querySelector('[data-head]');
  expect(saturday?.textContent).toContain('212');
  expect(saturday?.textContent).toContain('180 to 240');
});

test('with no ?day= the week opens on today, in its first column with its Today tag, selected', async () => {
  setToday('2026-11-15');
  const grid = await renderAt('/locations/l1/calendar?view=week', setup().api, 'Nov 15 to 21, 2026');
  expect(screen.getByText('Nov 15 to 21, 2026')).toBeTruthy();
  const first = inView(grid)[0];
  if (first === undefined) throw new Error('no first column');
  expect(first.getAttribute('data-date')).toBe('2026-11-15');
  expect(first.textContent).toContain('Sun 15');
  expect(within(first).getByText('Today')).toBeTruthy();
  expect(first.getAttribute('aria-selected')).toBe('true');
  // Next week moves the day a block on.
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 22 to 28, 2026' })).toBeTruthy();
  expect(screen.getByText('Nov 22 to 28, 2026')).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-22'); });
  expect(cell('2026-11-22').getAttribute('aria-selected')).toBe('true');
});

test('ArrowRight from a block’s last day selects the next block’s first, which shows with that column focused', async () => {
  await renderAt('/locations/l1/calendar?day=2026-11-17&view=week', setup().api, 'Nov 11 to 17, 2026');
  cell('2026-11-17').focus();
  fireEvent.keyDown(cell('2026-11-17'), { key: 'ArrowRight' });
  expect(await screen.findByRole('grid', { name: 'Nov 18 to 24, 2026' })).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-18'); });
  expect(cell('2026-11-18').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(cell('2026-11-18'));
});

test('PageDown in the week view steps from the selected day’s own month, and the block that holds the new day shows', async () => {
  await renderAt('/locations/l1/calendar?day=2026-10-28&view=week', setup().api, 'Oct 28 to Nov 3, 2026');
  cell('2026-10-28').focus();
  fireEvent.keyDown(cell('2026-10-28'), { key: 'PageDown' });
  expect(await screen.findByRole('grid', { name: 'Nov 25 to Dec 1, 2026' })).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-28'); });
  expect(cell('2026-11-28').getAttribute('aria-selected')).toBe('true');
});

test('Home and End in the week view go to the block’s first and last day', async () => {
  setToday('2026-11-15');
  await renderAt('/locations/l1/calendar?day=2026-11-18&view=week', setup().api, 'Nov 15 to 21, 2026');
  cell('2026-11-18').focus();
  fireEvent.keyDown(cell('2026-11-18'), { key: 'Home' });
  await waitFor(() => { expect(day()).toBe('2026-11-15'); });
  expect(document.activeElement).toBe(cell('2026-11-15'));
  fireEvent.keyDown(cell('2026-11-15'), { key: 'End' });
  await waitFor(() => { expect(day()).toBe('2026-11-21'); });
  expect(screen.getByRole('grid', { name: 'Nov 15 to 21, 2026' })).toBeTruthy();
});

test('Next week and Previous week move a block; a block past the grid reads its own days, and the grid’s month follows the day', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', api, 'Nov 18 to 24, 2026');
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 25 to Dec 1, 2026' })).toBeTruthy();
  expect(screen.getByText('Nov 25 to Dec 1, 2026')).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-28'); });
  // Nov 25 to Dec 1 is still in November's grid: nothing new is read.
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST]);
  // Dec 2 to 8 runs past it (Dec 6), so its own days are read; Dec 5 keeps November's grid.
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Dec 2 to 8, 2026' })).toBeTruthy();
  await waitFor(() => { expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST, `${PATH}/forecast?from=2026-12-02&to=2026-12-08`]); });
  // Dec 12 leaves November's grid, so December's grid is read.
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Dec 9 to 15, 2026' })).toBeTruthy();
  await waitFor(() => { expect(forecastReads(fake)).toContain(`${PATH}/forecast?from=2026-11-30&to=2027-01-10`); });
  const reads = forecastReads(fake).length;
  // Dec 2 to 8 is inside December's grid now.
  fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
  expect(await screen.findByRole('grid', { name: 'Dec 2 to 8, 2026' })).toBeTruthy();
  expect(forecastReads(fake)).toHaveLength(reads);
  fireEvent.click(viewButton('Month'));
  // Dec 5 is in December's grid, which the page shows now.
  expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
});

test('a block past the grid’s last day reads its own days, keeps the covered days showing while it reads, and Month reads the grid again', async () => {
  setToday('2026-11-15');
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?view=week', api, 'Nov 15 to 21, 2026');
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 22 to 28, 2026' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 29 to Dec 5, 2026' })).toBeTruthy();
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST]);
  const releases = (['calendar', 'forecast', 'owner-calendars/events'] as const).map((route) => fake.hold(route, '2026-12-06'));
  const reads = fake.paths.length;
  // Dec 6 to 12: Dec 6 is the last day of November's grid (Oct 26 to Dec 6), the rest past it.
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  const grid = await screen.findByRole('grid', { name: 'Dec 6 to 12, 2026' });
  await waitFor(() => { expect(fake.paths.length).toBe(reads + 4); });
  // No day of it is past, so no sales days but the chart's same weekdays last year (D64).
  expect([...fake.paths.slice(reads)].sort()).toEqual([
    `${PATH}/calendar?from=2026-12-06&to=2026-12-12`, `${PATH}/forecast?from=2026-12-06&to=2026-12-12`,
    `${PATH}/owner-calendars/events?from=2026-12-06&to=2026-12-12`, `${PATH}/sales/days?from=2025-12-07&to=2025-12-13`,
  ]);
  expect(grid.getAttribute('aria-busy')).toBe('true');
  expect(cell('2026-12-06').textContent).toContain('212');
  for (const date of ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12']) {
    expect(cell(date).getAttribute('aria-label')).toMatch(/\. Loading\.$/);
  }
  expect(cell('2026-12-07').getAttribute('aria-label')).toBe('Mon, Dec 7, 2026. Loading.');
  expect(cell('2026-12-07').textContent).toBe('Mon 7');
  expect(cell('2026-12-07').hasAttribute('aria-describedby')).toBe(false);
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  mouseOver(cell('2026-12-07'));
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  await act(async () => { for (const release of releases) release(); await Promise.resolve(); });
  await waitFor(() => { expect(screen.getByRole('grid', { name: 'Dec 6 to 12, 2026' }).getAttribute('aria-busy')).toBe('false'); });
  expect(cell('2026-12-07').textContent).toContain('212');
  fireEvent.click(viewButton('Month'));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  await waitFor(() => { expect(forecastReads(fake).filter((path) => path === NOVEMBER_FORECAST)).toHaveLength(2); });
});

test('a day past the grid’s edge inside a block that crosses it moves the grid’s month, read once with the block dimmed', async () => {
  setToday('2026-11-15');
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?view=week', api, 'Nov 15 to 21, 2026');
  for (const label of ['Nov 22 to 28, 2026', 'Nov 29 to Dec 5, 2026', 'Dec 6 to 12, 2026']) {
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByRole('grid', { name: label })).toBeTruthy();
  }
  await waitFor(() => { expect(screen.getByRole('grid', { name: 'Dec 6 to 12, 2026' }).getAttribute('aria-busy')).toBe('false'); });
  expect(forecastReads(fake)).toEqual([NOVEMBER_FORECAST, `${PATH}/forecast?from=2026-12-06&to=2026-12-12`]);
  const releases = (['calendar', 'forecast', 'owner-calendars/events'] as const).map((route) => fake.hold(route, '2026-11-30'));
  const reads = fake.paths.length;
  // Dec 9 is past November's grid (Oct 26 to Dec 6), so the grid's month becomes December, whose grid holds the block.
  fireEvent.click(cell('2026-12-09'));
  await waitFor(() => { expect(day()).toBe('2026-12-09'); });
  await waitFor(() => { expect(fake.paths.length).toBe(reads + 4); });
  expect([...fake.paths.slice(reads)].sort()).toEqual([
    `${PATH}/calendar?from=2026-11-30&to=2027-01-10`, `${PATH}/forecast?from=2026-11-30&to=2027-01-10`,
    `${PATH}/owner-calendars/events?from=2026-11-30&to=2027-01-10`, `${PATH}/sales/days?from=2025-12-01&to=2026-01-11`,
  ]);
  // The same days stay on screen, with the kept reads' data, dimmed while December's grid reads.
  const grid = screen.getByRole('grid', { name: 'Dec 6 to 12, 2026' });
  expect(grid.getAttribute('aria-busy')).toBe('true');
  expect(cell('2026-12-09').textContent).toContain('212');
  await act(async () => { for (const release of releases) release(); await Promise.resolve(); });
  await waitFor(() => { expect(screen.getByRole('grid', { name: 'Dec 6 to 12, 2026' }).getAttribute('aria-busy')).toBe('false'); });
  expect(fake.paths).toHaveLength(reads + 4);
});

test('Week inside the grid reads nothing more: the block shows its data at once', async () => {
  setToday('2026-11-15');
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar', api);
  const reads = fake.paths.length;
  fireEvent.click(viewButton('Week'));
  const grid = await screen.findByRole('grid', { name: 'Nov 15 to 21, 2026' });
  expect(grid.getAttribute('aria-busy')).toBe('false');
  expect(cell('2026-11-21').textContent).toContain('212');
  expect(fake.paths.slice(reads)).toEqual([]);
});

test('at the 25 months’ ends Next week or Previous week is disabled in place, and only that one', async () => {
  // The block after Nov 24 to 30, 2027 lies wholly past the last month, and ArrowRight from its last day is consumed.
  await renderAt('/locations/l1/calendar?day=2027-11-30&view=week', setup().api, 'Nov 24 to 30, 2027');
  expect(screen.getByRole('button', { name: 'Next week' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('button', { name: 'Previous week' }).getAttribute('aria-disabled')).not.toBe('true');
  expect(fireEvent.keyDown(cell('2027-11-30'), { key: 'ArrowRight' })).toBe(false);
  expect(day()).toBe('2027-11-30');
  cleanup();
  // The block before Oct 29 to Nov 4, 2025 lies wholly before the first, and Oct 29 to 31 are inert.
  const grid = await renderAt('/locations/l1/calendar?day=2025-11-01&view=week', setup().api, 'Oct 29 to Nov 4, 2025');
  expect(screen.getByRole('button', { name: 'Previous week' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('button', { name: 'Next week' }).getAttribute('aria-disabled')).not.toBe('true');
  const inert = columns(grid).filter((column) => column.getAttribute('aria-disabled') === 'true');
  expect(inert.map((column) => column.getAttribute('aria-label'))).toEqual(
    ['Wed, Oct 29, 2025', 'Thu, Oct 30, 2025', 'Fri, Oct 31, 2025'].map((date) => `${date}. Outside the months the calendar shows.`),
  );
  for (const column of inert) expect(column.hasAttribute('data-date')).toBe(false);
});

test('Week at the range’s first end reads nothing more: the clamped block lies inside November 2025’s grid', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2025-11-01', api, 'November 2025');
  expect(forecastReads(fake)).toEqual([`${PATH}/forecast?from=2025-11-01&to=2025-12-07`]);
  const reads = fake.paths.length;
  fireEvent.click(viewButton('Week'));
  const grid = await screen.findByRole('grid', { name: 'Oct 29 to Nov 4, 2025' });
  expect(columns(grid).filter((column) => column.getAttribute('aria-disabled') === 'true')).toHaveLength(3);
  expect(grid.getAttribute('aria-busy')).toBe('false');
  expect(fake.paths.slice(reads)).toEqual([]);
});

test('Week then Month returns to the grid you left: a trailing day keeps November’s grid', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(cell('2026-12-03'));
  await waitFor(() => { expect(day()).toBe('2026-12-03'); });
  fireEvent.click(viewButton('Week'));
  expect(await screen.findByRole('grid', { name: 'Dec 2 to 8, 2026' })).toBeTruthy();
  fireEvent.click(viewButton('Month'));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(cell('2026-12-03').getAttribute('aria-selected')).toBe('true');
});

test('an import refusal shown before a switch is still shown after it', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const calendars = screen.getByRole('button', { name: 'Your calendars' });
  /** The "Your calendars" popover, which floats over the page: it is closed for a switch and opened again after. */
  const popover = (): HTMLElement => screen.getByRole('dialog', { name: 'Your calendars' });
  const close = (): void => { fireEvent.click(within(popover()).getByRole('button', { name: 'Close' })); };
  fireEvent.click(calendars);
  chooseLargeFile();
  expect(await within(popover()).findByText(TOO_LARGE)).toBeTruthy();
  close();
  fireEvent.click(viewButton('Week'));
  expect(await screen.findByRole('grid', { name: 'Nov 18 to 24, 2026' })).toBeTruthy();
  // The button is never remounted by a switch, so the popover's message is kept.
  expect(screen.getByRole('button', { name: 'Your calendars' })).toBe(calendars);
  fireEvent.click(calendars);
  expect(within(popover()).getByText(TOO_LARGE)).toBeTruthy();
  close();
  fireEvent.click(viewButton('Month'));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Your calendars' })).toBe(calendars);
  fireEvent.click(calendars);
  expect(within(popover()).getByText(TOO_LARGE)).toBeTruthy();
  expect(calendars.getAttribute('aria-expanded')).toBe('true');
});

test('at 1280 the header row holds Today, Previous month, Next month, the label, the view switch and Your calendars, in that order, the button its last item', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  const label = screen.getByText('November 2026');
  const row = label.parentElement?.parentElement;
  if (row === null || row === undefined) throw new Error('no header row');
  const order = [
    screen.getByRole('button', { name: 'Today' }), screen.getByRole('button', { name: 'Previous month' }), screen.getByRole('button', { name: 'Next month' }),
    label, screen.getByRole('group', { name: 'Calendar view' }), screen.getByRole('button', { name: 'Your calendars' }),
  ];
  order.slice(1).forEach((element, index) => { expect(before(order[index] as Element, element)).toBe(true); });
  const button = screen.getByRole('button', { name: 'Your calendars' });
  expect(button.parentElement).toBe(row);
  // Its popover floats over the page, so nothing follows the button in the row, and closed it is not in the document.
  expect(row.lastElementChild).toBe(button);
  expect(button.hasAttribute('aria-controls')).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('at 1280 the header label is 216px wide in both views', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(window.getComputedStyle(screen.getByText('November 2026')).width).toBe('216px');
  fireEvent.click(viewButton('Week'));
  expect(await screen.findByRole('grid', { name: 'Nov 18 to 24, 2026' })).toBeTruthy();
  expect(window.getComputedStyle(screen.getByText('Nov 18 to 24, 2026')).width).toBe('216px');
});

test('a failed forecast read in the week view names the block', async () => {
  setToday('2026-11-15');
  const { api } = setup({ forecasts: { '2026-11': offline() } });
  await renderAt('/locations/l1/calendar?view=week', api, 'Nov 15 to 21, 2026');
  expect(await screen.findByText('Couldn’t load the forecast for Nov 15 to 21. Try again.')).toBeTruthy();
  expect(cell('2026-11-21').textContent).not.toContain('212');
  expect(cell('2026-11-21').textContent).not.toContain('180 to 240');
  // A failed read is not an answer: no day says “No forecast”, and the range lines stay blank.
  expect(screen.getByRole('grid', { name: 'Nov 15 to 21, 2026' }).textContent).not.toContain('No forecast');
});

test('with focus on a week column, ?view taken out from elsewhere leaves focus on the selected cell of the month grid', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', api, 'Nov 18 to 24, 2026');
  cell('2026-11-21').focus();
  expect(document.activeElement).toBe(cell('2026-11-21'));
  act(() => { router.setParams({ view: undefined }); });
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  await waitFor(() => { expect(document.activeElement).toBe(cell('2026-11-21')); });
  expect(document.activeElement).not.toBe(document.body);
});
