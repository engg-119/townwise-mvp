import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DayRecord } from '../../../src/portal/analytics/history';
import { dayMonth, weekDates } from '../../../src/portal/analytics/week';
import { FORECAST_LINE } from '../../../src/portal/home/Home';
import type { LocationSummary, MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, locationOf, meOf, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, historyBody, holiday, note, run, townEvent } from '../analytics/fakes';
import { NOVEMBER } from '../estimates/fakes';

// P11 Home on web (home.md 2, spec 16.3): the last week chart with its key and scale, the history card's heatmap
// that takes no focus, the upload links, and the honesty rule in the page as rendered. Synthetic days only.
// Pillars: no figure for a day after the last day of data and no forecast wording anywhere (T, honesty); the chart
// prints its scale and the summary says how many days it compares (E); the page writes nothing, keeps nothing in
// browser storage and is the same under view-as (P).

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

// Only Date is faked, so "today" is Thu, Nov 5, 2026 and every timer stays real.
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
const CALENDAR = `${PATH}/calendar?from=2024-10-07&to=2026-11-30`;
const SATURDAY = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
const DAYS = run('2024-09-01', '2026-11-04', (date) => Math.round((SATURDAY(date) ? 140 : 100) * (date >= '2026-10-26' ? 1.1 : 1)));
const EVENTS = [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), townEvent({ start: '2026-11-07', title: 'Sample game' })];
const FORECAST_WORDING = /\blikely\b|\branges?\b|forecast:\s*\d|\bpredict/i;
const QUESTIONS = [
  { id: 'gap_2026-05-12_2026-05-13', kind: 'gap', from: '2026-05-12', to: '2026-05-13', dayCount: 2 },
  { id: 'gap_2026-04-02_2026-04-03', kind: 'gap', from: '2026-04-02', to: '2026-04-03', dayCount: 2 },
];

function portal(me: MeResponse, days: readonly DayRecord[] = DAYS, locations?: LocationSummary[]): FakePortalApi {
  const fake = analyticsFake({
    [`${PATH}/sales/history`]: historyBody(days),
    [`${PATH}/notes`]: { notes: [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })] },
    [CALENDAR]: calendarBody({ events: EVENTS }),
    [`${PATH}/agent`]: { questions: QUESTIONS, activity: [] },
    [`${PATH}/people-in-town?from=2026-11-01&to=2026-11-30`]: NOVEMBER,
    // Stored files are off, as in production today.
    [`${PATH}/imports/current`]: refusal(503, 'files_unavailable'),
  });
  return fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member', locations), fallback: fake });
}

async function renderAt(api: FakePortalApi): Promise<void> {
  const path = '/locations/l1';
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  await screen.findByText(FORECAST_LINE);
}

function pageText(): string {
  return document.body.textContent;
}

test('the last week chart prints its key and scale; the history heatmap is one picture with no focusable cell', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  expect(screen.getByText('Scale 0 to 200 guests. Scale fitted to this location.')).toBeTruthy();
  expect(screen.getByText('Same week last year')).toBeTruthy();
  const history = document.getElementById('home-history');
  if (history === null) throw new Error('no history card');
  const picture = within(history).getByRole('img');
  expect(picture.getAttribute('aria-label')).toMatch(/^Daily guests, Jan 1, 2026 to Nov 4, 2026\. Busiest: /);
  expect(picture.querySelectorAll('[tabindex], [data-date]')).toHaveLength(0);
  expect(within(history).getByRole('link', { name: 'See it in Analytics' }).getAttribute('href')).toBe('/locations/l1/analytics');
  expect(within(history).getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(screen.getByRole('link', { name: 'Ask TownwiseAI' }).getAttribute('href')).toBe('/locations/l1/agent');
  // The count of TownwiseAI's questions links to its page.
  expect((await screen.findByRole('link', { name: '2 questions from TownwiseAI' })).getAttribute('href')).toBe('/locations/l1/agent');
  // Who's in town is its own block, its sources linked.
  const people = screen.getByRole('region', { name: 'Who’s in town' });
  expect(await within(people).findByText('Fall term classes until Tue, Nov 17.')).toBeTruthy();
  expect(within(people).getByRole('link', { name: 'registrar.dartmouth.edu' }).getAttribute('href')).toBe('https://registrar.dartmouth.edu/calendars/test');
  // Source links on the calendar open the source.
  expect(screen.getAllByRole('link', { name: 'Source: U.S. Office of Personnel Management' })[0]?.getAttribute('href'))
    .toBe('https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/');
});

test('honesty: with history ending before this week, no day of this week carries a figure, and nothing reads as a forecast', async () => {
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  await renderAt(portal(meOf(ACCESS.member), DAYS.filter((day) => day.date <= '2026-10-24')));
  for (const date of weekDates('2026-11-02')) {
    const cell = document.querySelector(`[data-testid="home-day-${date}"]`);
    if (cell === null) throw new Error(`no row for ${date}`);
    expect(cell.textContent.replace(dayMonth(date), '')).not.toMatch(/\d/);
  }
  expect(pageText()).not.toMatch(FORECAST_WORDING);
  expect(screen.getByText('Your history ends Oct 24, 2026. Upload the days since to compare last week.')).toBeTruthy();
  // At a glance says the same in short, with the way to fix it.
  const glance = screen.getByRole('region', { name: 'At a glance' });
  expect(within(glance).getByText('Your sales stop at Sat, Oct 24, 2026.')).toBeTruthy();
  expect(within(glance).getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(setItem).not.toHaveBeenCalled();
});

test('with this week partly in, only its past days carry a figure', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const figures = weekDates('2026-11-02').map((date) => {
    const cell = document.querySelector(`[data-testid="home-day-${date}"]`);
    return /\d+ guests/.test(cell?.textContent ?? '');
  });
  expect(figures).toEqual([true, true, true, false, false, false, false]);
  expect(pageText()).not.toMatch(FORECAST_WORDING);
});

test('at a glance: last year’s same week, last week against it, and the next event, each from history or the calendar', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const glance = screen.getByRole('region', { name: 'At a glance' });
  expect(within(glance).getByText('740')).toBeTruthy();
  expect(within(glance).getByText('Same week last year, Mon, Nov 3 to Sun, Nov 9, 2025. From all 7 days.')).toBeTruthy();
  expect(within(glance).getByText('814')).toBeTruthy();
  expect(within(glance).getByText('+10% against the same week last year (740), over all 7 days.')).toBeTruthy();
  expect(within(glance).getByText('Sample game')).toBeTruthy();
  expect(within(glance).getByText('Sat, Nov 7, 2026, in 2 days')).toBeTruthy();
  expect(within(glance).queryByText(FORECAST_WORDING)).toBeNull();
});

test('this week is a strip of seven days from 1024px, today’s column raised, last year as bars with the figures printed', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const strip = screen.getByRole('table', { name: 'This week, day by day' });
  expect(within(strip).getAllByRole('columnheader')).toHaveLength(7);
  expect(within(strip).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['On the calendar', 'Last year', 'Two years ago']);
  expect(within(strip).getByText('Sat, Nov 8, 2025: 140 guests')).toBeTruthy();
  expect(screen.getByText('Bars show last year’s days, scaled to the busiest of them.')).toBeTruthy();
});

test('the month calendar opens any day: a click, the arrow keys, and a pointer preview', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const grid = screen.getByRole('grid', { name: 'November 2026' });
  const detail = screen.getByRole('region', { name: 'Selected day' });
  const cell = (date: string): HTMLElement => {
    const found = grid.querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (found === null) throw new Error(`no cell for ${date}`);
    return found;
  };
  // Today is selected at first, and is the grid's one tab stop.
  expect(within(detail).getByRole('heading', { name: 'Today, Thu, Nov 5, 2026' })).toBeTruthy();
  expect(within(detail).getByRole('link', { name: 'Today, Thu, Nov 5, 2026' }).getAttribute('href')).toBe('/locations/l1/orders?day=2026-11-05');
  expect(cell('2026-11-05').getAttribute('aria-selected')).toBe('true');
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(cell('2026-11-11').getAttribute('aria-label')).toBe('Wed, Nov 11, 2026. Veterans Day.');

  // A click opens a later day: its holiday and sources, last year's same weekday, and no figure of its own.
  fireEvent.click(cell('2026-11-11'));
  expect(within(detail).getByRole('heading', { name: 'Wed, Nov 11, 2026' })).toBeTruthy();
  expect(within(detail).getByRole('link', { name: 'Wed, Nov 11, 2026' }).getAttribute('href')).toBe('/locations/l1/orders?day=2026-11-11');
  expect(within(detail).getByText('Veterans Day. Federal holiday.')).toBeTruthy();
  expect(within(detail).getByRole('link', { name: 'Source: U.S. Office of Personnel Management' })).toBeTruthy();
  expect(within(detail).getByText('Wed, Nov 12, 2025: 100 guests')).toBeTruthy();
  expect(within(detail).queryByText('This day')).toBeNull();
  expect(cell('2026-11-11').getAttribute('tabindex')).toBe('0');

  // The keys move the selection, and focus with it.
  cell('2026-11-11').focus();
  fireEvent.keyDown(cell('2026-11-11'), { key: 'ArrowLeft' });
  expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-10');
  fireEvent.keyDown(cell('2026-11-10'), { key: 'ArrowUp' });
  expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-03');
  expect(within(detail).getByRole('heading', { name: 'Tue, Nov 3, 2026' })).toBeTruthy();
  // A past day with data has its own figure.
  expect(within(detail).getByText('This day')).toBeTruthy();
  expect(within(detail).getByText('110 guests')).toBeTruthy();

  // A pointer over a day previews it; leaving the grid restores the selection.
  fireEvent.pointerOver(cell('2026-11-06'));
  expect(within(detail).getByText('Your note: Private event, more guests than usual.')).toBeTruthy();
  expect(within(detail).getByText('A rehearsal dinner.')).toBeTruthy();
  fireEvent.pointerLeave(grid);
  expect(within(detail).getByRole('heading', { name: 'Tue, Nov 3, 2026' })).toBeTruthy();
  expect(pageText()).not.toMatch(FORECAST_WORDING);
});

test('show the numbers opens the last week table', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const lastWeek = screen.getByRole('region', { name: 'Last week' });
  fireEvent.click(within(lastWeek).getByRole('button', { name: /Show the numbers/ }));
  const table = within(lastWeek).getByRole('region', { name: 'Last week against the same week last year' });
  expect(within(table).getByText('Sat, Oct 31, 2026')).toBeTruthy();
  expect(within(table).getAllByText('+10%').length).toBeGreaterThan(0);
});

test('view-as: the same page, the upload links disabled with the read-only line, and no write', async () => {
  const api = portal(viewAsMe(ACCESS.member));
  await renderAt(api);
  expect(screen.getAllByText('Read-only while viewing as gm@example.org.').length).toBeGreaterThan(0);
  const history = document.getElementById('home-history');
  if (history === null) throw new Error('no history card');
  const upload = within(history).getByRole('button', { name: 'Upload sales history' });
  expect(upload.getAttribute('aria-disabled')).toBe('true');
  expect(upload.getAttribute('aria-describedby')).toBe('home-ro');
  expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('while needsHistory is true the history step shows in place of the cards that need days', async () => {
  const empty = [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })];
  // Stored files off: the step offers the browser upload (onboarding's own tests cover the drop).
  await renderAt(portal(meOf(ACCESS.admin), [], empty));
  const step = screen.getByRole('region', { name: 'Drop in everything you have' });
  expect((await within(step).findByRole('link', { name: 'Upload sales history' })).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(document.getElementById('home-history')).toBeNull();
  expect(screen.getByText('Sample game')).toBeTruthy();
});
