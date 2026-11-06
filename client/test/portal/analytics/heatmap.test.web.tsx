import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { dayContext } from '../../../src/portal/analytics/days';
import { Heatmap } from '../../../src/portal/analytics/Heatmap';
import { READS_LINE } from '../../../src/portal/analytics/YourData';
import { PANEL_EMPTY } from '../../../src/portal/analytics/panel';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, day, historyBody, holiday, note, run, townEvent } from './fakes';

// P24 Analytics on web (home.md 4.4, 4.5, spec 16.3): the heatmap's grids, its one tab stop and keys, hover
// previews, the Day panel with the upload, the event's source link and the note, and the filters that change the
// marks and the basis line. Synthetic days only. Pillars: the panel names its sources (T); a filter changes the
// basis line (E); the page writes nothing and keeps nothing in storage, and is the same under view-as (P).

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

// Only Date is faked, so "today" is Nov 5, 2026 and every timer stays real.
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
// Jan 1, 2025 to Nov 4, 2026: Saturdays busier, Christmas 2025 all zero.
const DAYS = run('2025-01-01', '2026-11-04', (date) => (date === '2025-12-25' ? 0 : 100 + (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 40 : 0)));
const NOTE = note({ startDate: '2026-10-10', detail: 'A rehearsal dinner.' });
const EVENTS = [
  holiday('2025-11-27', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving'),
  townEvent({ start: '2026-10-17', title: 'Sample homecoming' }),
];

function portal(me: MeResponse, days = DAYS): FakePortalApi {
  const fake = analyticsFake({
    [`${PATH}/sales/history`]: historyBody(days),
    [`${PATH}/notes`]: { notes: [NOTE] },
    [`${PATH}/calendar?from=2025-01-01&to=2026-12-31`]: calendarBody({ events: EVENTS }),
    [`${PATH}/calendar?from=2026-01-01&to=2026-12-31`]: calendarBody({ events: [] }),
  });
  return fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: fake });
}

function renderAt(api: FakePortalApi): void {
  const path = '/locations/l1/analytics';
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

async function ready(api: FakePortalApi = portal(meOf(ACCESS.member))): Promise<FakePortalApi> {
  renderAt(api);
  await screen.findAllByRole('grid');
  return api;
}

function cell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-date="${date}"]`);
  if (found === null) throw new Error(`no focusable cell for ${date}`);
  return found;
}

function key(name: string, init: KeyboardEventInit = {}): void {
  const target = document.activeElement;
  if (target === null) throw new Error('nothing has focus');
  fireEvent.keyDown(target, { key: name, ...init });
}

function focused(): string | null {
  return document.activeElement?.getAttribute('data-date') ?? null;
}

function only<T>(list: readonly T[], index = 0): T {
  const found = list[index];
  if (found === undefined) throw new Error(`nothing at ${String(index)}`);
  return found;
}

function basis(): string {
  return screen.getAllByText(/^Based on /)[0]?.textContent ?? '';
}

test('one grid per year, newest first, with one tab stop at the last day with data', async () => {
  await ready();
  expect(screen.getAllByRole('grid').map((grid) => grid.getAttribute('aria-label'))).toEqual(['2026, daily guests', '2025, daily guests']);
  const stops = document.querySelectorAll('[role="gridcell"][tabindex="0"]');
  expect(stops).toHaveLength(1);
  expect(stops[0]?.getAttribute('data-date')).toBe('2026-11-04');
  // Rows are weekdays, Monday first, each with its row header.
  const rows = within(only(screen.getAllByRole('grid'))).getAllByRole('row');
  expect(rows).toHaveLength(7);
  expect(within(only(rows)).getByRole('rowheader').textContent).toContain('Monday');
  // Every focusable cell says what its fill and marks show.
  expect(cell('2026-10-17').getAttribute('aria-label')).toBe('Sat, Oct 17, 2026. 140 guests, $2,800. Town event: Sample homecoming.');
  expect(cell('2025-12-25').getAttribute('aria-label')).toBe('Thu, Dec 25, 2025. 0 guests, $0. Closed. Left out by your filters.');
  // Days after today are blank and never focusable.
  expect(document.querySelector('[data-date="2026-11-06"]')).toBeNull();
  expect(screen.getByText(PANEL_EMPTY)).toBeTruthy();
});

test('the keys move focus: a day, a week, the week’s ends, 52 weeks across years, and never past today', async () => {
  await ready();
  cell('2026-11-04').focus();
  key('ArrowDown');
  expect(focused()).toBe('2026-11-05');
  key('ArrowDown');
  expect(focused()).toBe('2026-11-05');
  key('ArrowLeft');
  expect(focused()).toBe('2026-10-29');
  key('ArrowUp');
  expect(focused()).toBe('2026-10-28');
  key('Home');
  expect(focused()).toBe('2026-10-26');
  key('End');
  expect(focused()).toBe('2026-11-01');
  key('PageUp');
  expect(focused()).toBe('2025-11-02');
  key('PageDown');
  expect(focused()).toBe('2026-11-01');
  key('Home', { ctrlKey: true });
  expect(focused()).toBe('2025-01-01');
  key('End', { ctrlKey: true });
  expect(focused()).toBe('2026-11-04');
  // Still one tab stop, and it moved with focus.
  expect(document.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  expect(cell('2026-11-04').tabIndex).toBe(0);
});

test('Enter selects: the panel has the numbers, the event with its source, the note and the upload; Escape clears', async () => {
  await ready();
  cell('2026-10-10').focus();
  key('Enter');
  const day = await screen.findByRole('region', { name: 'Saturday, Oct 10, 2026' });
  expect(cell('2026-10-10').getAttribute('aria-selected')).toBe('true');
  expect(within(day).getByText('140')).toBeTruthy();
  expect(within(day).getByText('$2,800')).toBeTruthy();
  expect(within(day).getByText('Private event, more guests than usual')).toBeTruthy();
  expect(within(day).getByText('A rehearsal dinner.')).toBeTruthy();
  expect(within(day).getByText('From the upload on Nov 4, 2026 by owner@example.com.')).toBeTruthy();
  expect(within(day).getByRole('link', { name: 'Open Notes' }).getAttribute('href')).toBe('/locations/l1/notes');
  expect(within(day).getByRole('link', { name: 'Ask TownwiseAI about this day' }).getAttribute('href')).toBe('/locations/l1/agent');
  // While a day is selected, the keys move the selection with focus.
  key('ArrowRight');
  const event = await screen.findByRole('region', { name: 'Saturday, Oct 17, 2026' });
  expect(within(event).getByText('Sample homecoming')).toBeTruthy();
  expect(within(event).getByRole('link', { name: 'Source: home.dartmouth.edu' }).getAttribute('href')).toBe('https://home.dartmouth.edu/');
  key('Escape');
  expect(await screen.findByText(PANEL_EMPTY)).toBeTruthy();
  expect(focused()).toBe('2026-10-17');
});

test('a pointer over a cell previews it, leaving the grid restores the selection; Previous day focuses its cell', async () => {
  await ready();
  fireEvent.click(cell('2026-10-17'));
  expect(await screen.findByRole('region', { name: 'Saturday, Oct 17, 2026' })).toBeTruthy();
  fireEvent.pointerOver(cell('2025-11-27'));
  const preview = await screen.findByRole('region', { name: 'Thursday, Nov 27, 2025' });
  expect(within(preview).getByText('Thanksgiving Day')).toBeTruthy();
  expect(within(preview).getByRole('link', { name: 'Source: U.S. Office of Personnel Management' })).toBeTruthy();
  const grid = cell('2025-11-27').closest('[role="grid"]')?.parentElement?.parentElement;
  if (grid === null || grid === undefined) throw new Error('no grid root');
  fireEvent.pointerLeave(grid);
  const back = await screen.findByRole('region', { name: 'Saturday, Oct 17, 2026' });
  fireEvent.click(within(back).getByRole('button', { name: 'Previous day' }));
  await screen.findByRole('region', { name: 'Friday, Oct 16, 2026' });
  await waitFor(() => { expect(focused()).toBe('2026-10-16'); });
});

test('the filters: marks leave the labels but not the panel, inclusion changes the basis line, one year always stays', async () => {
  await ready();
  const before = basis();
  expect(before).toBe('Based on 672 days with a guest count. Leaves out 1 closed day.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Town events' }));
  expect(cell('2026-10-17').getAttribute('aria-label')).toBe('Sat, Oct 17, 2026. 140 guests, $2,800.');
  fireEvent.click(cell('2026-10-17'));
  expect(within(await screen.findByRole('region', { name: 'Saturday, Oct 17, 2026' })).getByText('Sample homecoming')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Closed days' }));
  expect(basis()).toBe('Based on 673 days with a guest count.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Days with a note' }));
  expect(basis()).toBe('Based on 672 days with a guest count. Leaves out 1 day with a note.');
  // Years: unchecking 2025 leaves one grid; the last year can't be unchecked.
  fireEvent.click(screen.getByRole('checkbox', { name: '2025' }));
  expect(screen.getAllByRole('grid')).toHaveLength(1);
  const last = screen.getByRole('checkbox', { name: '2026' });
  fireEvent.click(last);
  expect((last as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Keep at least one year.')).toBeTruthy();
  expect(last.getAttribute('aria-describedby')).toBe('analytics-keep-year');
  // The metric switch: one tab stop, the arrows move it, and every block follows.
  const guests = screen.getByRole('radio', { name: 'Guests' });
  expect(guests.getAttribute('tabindex')).toBe('0');
  act(() => { guests.focus(); });
  fireEvent.keyDown(guests, { key: 'ArrowRight' });
  expect(screen.getByRole('radio', { name: 'Net sales' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getAllByRole('grid')[0]?.getAttribute('aria-label')).toBe('2026, daily net sales');
});

test('every section prints its summary, the basis line and the numbers behind it, with charts drawn aria-hidden', async () => {
  await ready();
  expect(screen.getByText('Your busiest day is Saturday, 140 guests on average; your quietest is Monday, 100.')).toBeTruthy();
  expect(screen.getAllByText(/^Based on 672 days/)).toHaveLength(6);
  for (const svg of document.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getAllByText(/^Scale 0 to 200 guests\. Scale fitted to this location\.$/).length).toBeGreaterThan(0);
  expect(screen.getByText('Weather as a driver.')).toBeTruthy();
  expect(screen.getByText(READS_LINE)).toBeTruthy();
  expect(screen.getByText('Nov 4, 2026 by owner@example.com')).toBeTruthy();
});

test('the page writes nothing, keeps nothing in storage, and is the same under view-as', async () => {
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  const api = await ready(portal(viewAsMe(ACCESS.member)));
  fireEvent.click(cell('2026-10-17'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Closed days' }));
  await screen.findByRole('region', { name: 'Saturday, Oct 17, 2026' });
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  expect(setItem).not.toHaveBeenCalled();
  expect(screen.getAllByRole('grid')).toHaveLength(2);
  expect(screen.queryByText(/^Read-only while viewing as/)).toBeNull();
});

test('with no history: the filters are disabled and the page says so, with the upload link', async () => {
  renderAt(portal(meOf(ACCESS.member), []));
  expect(await screen.findByText('No sales history yet.')).toBeTruthy();
  const box = screen.getByRole('checkbox', { name: 'Closed days' });
  expect(box.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(box);
  expect((box as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(screen.queryByRole('grid')).toBeNull();
});

test('one day of history: year over year says what is missing and offers older history', async () => {
  await ready(portal(meOf(ACCESS.member), [day('2026-11-04', 90)]));
  expect(screen.getByText(/^Year over year needs at least one full year before this one\. You have 1 month so far\./)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Upload older history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(screen.getByText('Townwise needs each kind of day to happen at least twice before it can say how much it moves your numbers.')).toBeTruthy();
});

test('Enter on a cell selects it even while the pointer rests on another', async () => {
  await ready();
  fireEvent.pointerOver(cell('2025-11-27'));
  expect(await screen.findByRole('region', { name: 'Thursday, Nov 27, 2025' })).toBeTruthy();
  cell('2026-10-10').focus();
  key('Enter');
  expect(await screen.findByRole('region', { name: 'Saturday, Oct 10, 2026' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Thursday, Nov 27, 2025' })).toBeNull();
});

test('unchecking the selected day’s year clears the selection', async () => {
  await ready();
  fireEvent.click(cell('2025-11-27'));
  expect(await screen.findByRole('region', { name: 'Thursday, Nov 27, 2025' })).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: '2025' }));
  expect(await screen.findByText(PANEL_EMPTY)).toBeTruthy();
  // A filter that keeps the year keeps the selection.
  fireEvent.click(cell('2026-10-17'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Closed days' }));
  expect(await screen.findByRole('region', { name: 'Saturday, Oct 17, 2026' })).toBeTruthy();
});

test('"Keep at least one year." is read from a polite live region that is there before it is needed', async () => {
  await ready();
  const region = document.getElementById('analytics-keep-year-live');
  expect(region?.getAttribute('aria-live')).toBe('polite');
  expect(region?.textContent).toBe('');
  fireEvent.click(screen.getByRole('checkbox', { name: '2025' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '2026' }));
  expect(region?.textContent).toBe('Keep at least one year.');
});

test('interactive={false} (Home, Reading): one picture named by its label, nothing focusable, no grid, pending days dashed', () => {
  const days = run('2026-10-01', '2026-10-20', () => 100);
  render(
    <Heatmap
      days={days}
      metric="guests"
      marks={{ townEvents: true, holidays: true, notes: true, closures: true }}
      context={dayContext([], [])}
      included={() => true}
      years={[2026]}
      interactive={false}
      pending={{ from: '2026-10-21', to: '2026-11-04' }}
      label="Daily guests, Oct 1, 2026 to Oct 20, 2026."
      today="2026-11-05"
    />,
  );
  const pictures = screen.getAllByRole('img');
  expect(pictures).toHaveLength(1);
  expect(pictures[0]?.getAttribute('aria-label')).toBe('Daily guests, Oct 1, 2026 to Oct 20, 2026.');
  expect(document.querySelectorAll('[tabindex]')).toHaveLength(0);
  expect(document.querySelectorAll('[role="grid"], [role="gridcell"], [role="row"], [data-date]')).toHaveLength(0);
  // 15 pending days (Oct 21 to Nov 4) are drawn dashed: "Not read yet".
  const dashed = [...document.querySelectorAll<HTMLElement>('div')].filter((each) => each.style.border.includes('dashed'));
  expect(dashed).toHaveLength(15);
  // A picture has nothing to scroll to by keyboard, so it fits its width instead of scrolling sideways.
  for (const each of document.querySelectorAll<HTMLElement>('div')) {
    expect(each.style.overflowX).not.toBe('auto');
    expect(each.style.minWidth).not.toBe('720px');
  }
});
