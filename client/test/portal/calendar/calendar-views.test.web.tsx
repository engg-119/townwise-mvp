import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot, router } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, offline, orgOf, type FakePortalApi } from '../../helpers/portal';
import { townEvent } from '../analytics/fakes';
import { calendarFake, forecastDay, forecastOf, PATH, type CalendarFake } from './fakes';

// P28 Calendar's views on web (spec 16.3). The month view: the grid is always 6 weeks, a leading or trailing day is
// selected in place, the grid moves only on Previous, Next, Today, PageUp and PageDown or when the selected day leaves
// it, a month whose reads are in flight renders at once with its uncovered days pending, the cells are the same height
// every month, the filters sit where the width puts them, and focus survives a change of grid. The week view: Month
// and Week kept in `?view=`, no read on a switch, the grid's month kept across it, Previous and Next by weeks, its own
// forecast notice, and focus that survives a switch from outside the page. Today is Wed, Nov 11, 2026. Synthetic
// figures and made-up titles only.

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

// The week view

/** A file over 1 MB, which the import refuses unread. */
function chooseLargeFile(): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const file = new File(['BEGIN:VCALENDAR'], 'everything.ics', { type: 'text/calendar' });
  Object.defineProperty(file, 'size', { value: 1024 * 1024 + 1 });
  Object.defineProperty(file, 'text', { value: () => { throw new Error('read a file over 1 MB'); } });
  fireEvent.change(input, { target: { files: [file] } });
}

const TOO_LARGE = 'This file is over 1 MB. Export a shorter range of your calendar.';

function viewButton(name: 'Month' | 'Week'): HTMLElement {
  return within(screen.getByRole('group', { name: 'Calendar view' })).getByRole('button', { name });
}

test('Week sets view=week and keeps the day, with no read; Month takes view out of the URL', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(viewButton('Month').getAttribute('aria-pressed')).toBe('true');
  const reads = fake.paths.length;
  fireEvent.click(viewButton('Week'));
  expect(await screen.findByRole('grid', { name: 'Nov 16 to 22, 2026' })).toBeTruthy();
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

test('a load at ?view=week opens the selected day’s week; any other view opens the month', async () => {
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', setup().api, 'Nov 16 to 22, 2026');
  expect(screen.getByText('Nov 16 to 22, 2026')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Previous week' })).toBeTruthy();
  // The week's figures and cards, from the grid's reads.
  expect(cell('2026-11-21').textContent).toContain('212');
  expect(cell('2026-11-21').textContent).toContain('Dartmouth home football');
  cleanup();
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=year', setup().api);
  expect(viewButton('Month').getAttribute('aria-pressed')).toBe('true');
});

test('Next week and Previous week move a week; the grid’s month follows, so Month shows the new week’s grid', async () => {
  const { api, fake } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', api, 'Nov 16 to 22, 2026');
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 23 to 29, 2026' })).toBeTruthy();
  expect(screen.getByText('Nov 23 to 29, 2026')).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-28'); });
  // Nov 30 to Dec 6 is still in November's grid: nothing new is read.
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 30 to Dec 6, 2026' })).toBeTruthy();
  expect(forecastReads(fake)).toEqual([`${PATH}/forecast?from=2026-10-26&to=2026-12-06`]);
  // Dec 12 leaves it, so December's grid is read.
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Dec 7 to 13, 2026' })).toBeTruthy();
  await waitFor(() => { expect(forecastReads(fake)).toContain(`${PATH}/forecast?from=2026-11-30&to=2027-01-10`); });
  fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 30 to Dec 6, 2026' })).toBeTruthy();
  fireEvent.click(viewButton('Month'));
  // Dec 5 is in December's grid, which the page shows now.
  expect(await screen.findByRole('grid', { name: 'December 2026' })).toBeTruthy();
});

test('at the 25 months’ ends Next week or Previous week is disabled in place, and only that one', async () => {
  // The week after Nov 29 to Dec 5, 2027 lies wholly past the last month.
  await renderAt('/locations/l1/calendar?day=2027-11-30&view=week', setup().api, 'Nov 29 to Dec 5, 2027');
  expect(screen.getByRole('button', { name: 'Next week' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('button', { name: 'Previous week' }).getAttribute('aria-disabled')).not.toBe('true');
  cleanup();
  // The week before Oct 27 to Nov 2, 2025 lies wholly before the first.
  await renderAt('/locations/l1/calendar?day=2025-11-01&view=week', setup().api, 'Oct 27 to Nov 2, 2025');
  expect(screen.getByRole('button', { name: 'Previous week' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('button', { name: 'Next week' }).getAttribute('aria-disabled')).not.toBe('true');
});

test('Week then Month returns to the grid you left: a trailing day keeps November’s grid', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  fireEvent.click(cell('2026-12-03'));
  await waitFor(() => { expect(day()).toBe('2026-12-03'); });
  fireEvent.click(viewButton('Week'));
  expect(await screen.findByRole('grid', { name: 'Nov 30 to Dec 6, 2026' })).toBeTruthy();
  fireEvent.click(viewButton('Month'));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(cell('2026-12-03').getAttribute('aria-selected')).toBe('true');
});

test('an import refusal shown before a switch is still shown after it', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  chooseLargeFile();
  expect(await screen.findByText(TOO_LARGE)).toBeTruthy();
  fireEvent.click(viewButton('Week'));
  expect(await screen.findByRole('grid', { name: 'Nov 16 to 22, 2026' })).toBeTruthy();
  expect(screen.getByText(TOO_LARGE)).toBeTruthy();
  fireEvent.click(viewButton('Month'));
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  expect(screen.getByText(TOO_LARGE)).toBeTruthy();
});

test('at 1280 the header label is 216px wide in both views', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21', api);
  expect(window.getComputedStyle(screen.getByText('November 2026')).width).toBe('216px');
  fireEvent.click(viewButton('Week'));
  expect(await screen.findByRole('grid', { name: 'Nov 16 to 22, 2026' })).toBeTruthy();
  expect(window.getComputedStyle(screen.getByText('Nov 16 to 22, 2026')).width).toBe('216px');
});

test('a failed forecast read in the week view names the week', async () => {
  const { api } = setup({ forecasts: { '2026-11': offline() } });
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', api, 'Nov 16 to 22, 2026');
  expect(await screen.findByText('Couldn’t load the forecast for Nov 16 to 22. Try again.')).toBeTruthy();
  expect(cell('2026-11-21').textContent).not.toContain('212');
  expect(cell('2026-11-21').textContent).not.toContain('180 to 240');
  // A failed read is not an answer: no day says “No forecast”, and the range lines stay blank.
  expect(screen.getByRole('grid', { name: 'Nov 16 to 22, 2026' }).textContent).not.toContain('No forecast');
});

test('with focus on a week column, ?view taken out from elsewhere leaves focus on the selected cell of the month grid', async () => {
  const { api } = setup();
  await renderAt('/locations/l1/calendar?day=2026-11-21&view=week', api, 'Nov 16 to 22, 2026');
  cell('2026-11-21').focus();
  expect(document.activeElement).toBe(cell('2026-11-21'));
  act(() => { router.setParams({ view: undefined }); });
  expect(await screen.findByRole('grid', { name: 'November 2026' })).toBeTruthy();
  await waitFor(() => { expect(document.activeElement).toBe(cell('2026-11-21')); });
  expect(document.activeElement).not.toBe(document.body);
});
