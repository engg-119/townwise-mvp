import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DayRecord } from '../../../src/portal/analytics/history';
import { dayMonth, weekDates } from '../../../src/portal/analytics/week';
import { daysBetween } from '../../../src/portal/locations/dates';
import { REORDER_OVERVIEW } from '../../../src/portal/home/beside';
import { forecastLine } from '../../../src/portal/home/Home';
import type { LocationSummary, MeResponse } from '../../../src/portal/schemas';
import { theme } from '../../../src/theme';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, locationOf, meOf, offline, orgOf, refusal, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, day, historyBody, holiday, note, run, townEvent } from '../analytics/fakes';
import { forecastDay, forecastOf, NO_FORECAST } from '../calendar/fakes';
import { ruleOf } from '../rules/fakes';
import { NOVEMBER } from '../estimates/fakes';

// P11 Home on web (home.md 2, spec 16.3): the last week chart with its key and scale, the history card's heatmap
// that takes no focus, the upload links, and the honesty rule in the page as rendered. Synthetic days only.
// Pillars: with no published forecast, no figure for a day after the last day of data and no forecast wording
// anywhere (T, honesty); with one, This month shows only the published forecast's figures from today on, and a day
// opens in the Calendar (spec 16.3 P11); the chart prints its scale and the summary says how many days it
// compares (E); the page writes nothing, keeps nothing in browser storage and is the same under view-as (P).

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
const FORECAST = `${PATH}/forecast?from=2026-11-01&to=2026-11-30`;
const NOT_PUBLISHED = forecastLine('Main Street Bar');
const SATURDAY = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
const DAYS = run('2024-09-01', '2026-11-04', (date) => Math.round((SATURDAY(date) ? 140 : 100) * (date >= '2026-10-26' ? 1.1 : 1)));
const EVENTS = [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), townEvent({ start: '2026-11-07', title: 'Sample game' })];
const FORECAST_WORDING = /\blikely\b|\branges?\b|forecast:\s*\d|\bpredict/i;
const QUESTIONS = [
  { id: 'gap_2026-05-12_2026-05-13', kind: 'gap', from: '2026-05-12', to: '2026-05-13', dayCount: 2 },
  { id: 'gap_2026-04-02_2026-04-03', kind: 'gap', from: '2026-04-02', to: '2026-04-03', dayCount: 2 },
];

/**
 * `rules`: GET .../rules' body; without it the read is refused (404), which Home reads as no rules. `agent`: GET
 * .../agent's body, two questions by default.
 */
/** The last portal()'s fake, for the paths Home read. */
let lastFake: ReturnType<typeof analyticsFake> | null = null;

function portal(
  me: MeResponse, days: readonly DayRecord[] = DAYS, locations?: LocationSummary[], forecast: unknown = NO_FORECAST, rules?: unknown,
  agent: unknown = { questions: QUESTIONS, activity: [] }, extra: Record<string, unknown> = {},
): FakePortalApi {
  const fake = analyticsFake({
    ...(rules === undefined ? {} : { [`${PATH}/rules`]: rules }),
    [FORECAST]: forecast,
    [`${PATH}/sales/history`]: historyBody(days),
    [`${PATH}/notes`]: { notes: [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })] },
    [CALENDAR]: calendarBody({ events: EVENTS }),
    [`${PATH}/agent`]: agent,
    [`${PATH}/people-in-town?from=2026-11-01&to=2026-11-30`]: NOVEMBER,
    // Stored files are off, as in production today.
    [`${PATH}/imports/current`]: refusal(503, 'files_unavailable'),
    ...extra,
  });
  lastFake = fake;
  return fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member', locations), fallback: fake });
}

async function renderAt(api: FakePortalApi, ready: string = NOT_PUBLISHED): Promise<void> {
  const path = '/locations/l1';
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  await screen.findByText(ready);
}

/**
 * A sentence whose key figures are drawn bold (nested texts, owner request 2026-11-15): the innermost element whose
 * whole text is `text`, as getByText would find it unbroken.
 */
function sentence(text: string): (content: string, element: Element | null) => boolean {
  return (_content, element) => element !== null && element.textContent === text
    && Array.from(element.children).every((child) => child.textContent !== text);
}

function pageText(): string {
  return document.body.textContent;
}

test('the count of TownwiseAI’s questions includes its open weekly suggestions', async () => {
  const suggestion = {
    id: 's1', why: 'Thanksgiving is Thu, Nov 26.', calendar: [], createdAt: '2026-11-02T08:00:00.000Z', type: 'note',
    note: {
      kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
      startTime: null, endTime: null,
    },
  };
  const agent = { questions: QUESTIONS.slice(0, 1), activity: [], suggestions: [suggestion], weeklySuggestions: { on: true, available: true, canChange: false } };
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, NO_FORECAST, undefined, agent));
  expect((await screen.findByRole('link', { name: '2 questions from TownwiseAI' })).getAttribute('href')).toBe('/locations/l1/agent?panel=questions');
});

test('the last week chart prints its key and scale; the history heatmap is one picture with no focusable cell', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  expect(screen.getByText('Scale 0 to 200 guests. Scale fitted to this location.')).toBeTruthy();
  expect(screen.getByText('Same week last year')).toBeTruthy();
  const history = document.getElementById('home-history');
  if (history === null) throw new Error('no history card');
  const picture = within(history).getByRole('img');
  expect(picture.getAttribute('aria-label')).toMatch(/^Daily guests, Jan 1, 2026 to Nov 4, 2026\. Busiest: /);
  expect(picture.querySelectorAll('[tabindex]')).toHaveLength(0);
  expect(within(history).getByRole('link', { name: 'See it in Analytics' }).getAttribute('href')).toBe('/locations/l1/analytics');
  expect(within(history).getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(screen.getByRole('link', { name: 'Ask TownwiseAI' }).getAttribute('href')).toBe('/locations/l1/agent');
  // The count of TownwiseAI's questions links to its page, with the questions showing (?panel=questions).
  expect((await screen.findByRole('link', { name: '2 questions from TownwiseAI' })).getAttribute('href')).toBe('/locations/l1/agent?panel=questions');
  // Who's in town is its own block, read top to bottom: the honest no-number line, this week, later in the month (one
  // row per run of days, past days left out), the term's source once as a chip with its site's name, then the county's
  // jobs. Each group has an h3, so a screen reader can move between them.
  const people = screen.getByRole('region', { name: 'Who’s in town' });
  expect(await within(people).findByText('Fall term classes until Tue, Nov 17.')).toBeTruthy();
  for (const name of ['This week', 'Later in November', 'Food-service jobs in Grafton County']) {
    expect(within(people).getByRole('heading', { name, level: 3 })).toBeTruthy();
  }
  const order = [
    'Townwise can’t put a number on how many people are in Hanover yet.', 'This week', 'Fall term classes until Tue, Nov 17.',
    'Later in November', 'Nov 18 to 19', 'Nov 20 to 25', 'Fall term finals', 'From Nov 26', 'Dartmouth Registrar',
    'Food-service jobs in Grafton County', '4.5% fewer jobs in November 2025 than in an average month that year.',
  ].map((text) => people.textContent.indexOf(text));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(within(people).getByRole('link', { name: 'Dartmouth Registrar. Source' }).getAttribute('href')).toBe('https://registrar.dartmouth.edu/calendars/test');
  // No bare hosts, and no source the block doesn't use (the holiday's is the calendar block's).
  expect(within(people).queryByRole('link', { name: 'registrar.dartmouth.edu' })).toBeNull();
  expect(people.textContent).not.toMatch(/opm\.gov|Office of Personnel|County jobs are/);
  // Source chips on the calendar open the source.
  expect(screen.getAllByRole('link', { name: 'U.S. Office of Personnel Management. Source' })[0]?.getAttribute('href'))
    .toBe('https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/');
});

test('honesty: with history ending before this week, no day of this week carries a figure, and nothing reads as a forecast', async () => {
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  await renderAt(portal(meOf(ACCESS.member), DAYS.filter((day) => day.date <= '2026-10-24')));
  for (const date of weekDates('2026-11-05')) {
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

test('this week starts today, and none of its days carries a figure before its data is in', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const strip = screen.getByRole('table', { name: 'This week, day by day' });
  const heads = within(strip).getAllByRole('columnheader').map((cell) => cell.textContent);
  expect(heads[0]).toMatch(/^Thu.*Nov 5.*Today/);
  expect(heads[6]).toMatch(/^Wed.*Nov 11/);
  // Yesterday is history, not this week.
  expect(document.querySelector('[data-testid="home-day-2026-11-04"]')).toBeNull();
  const figures = weekDates('2026-11-05').map((date) => {
    const cell = document.querySelector(`[data-testid="home-day-${date}"]`);
    return /\d+ guests/.test(cell?.textContent ?? '');
  });
  expect(figures).toEqual([false, false, false, false, false, false, false]);
  expect(pageText()).not.toMatch(FORECAST_WORDING);
});

// Tue, Nov 3, 2026 had 1 guest: a tenth of its Tuesdays' typical guests or fewer (spec D32).
const NEAR_EMPTY = DAYS.map((day) => (day.date === '2026-11-03' ? { ...day, guests: 1, netSalesCents: 2000 } : day));

test('a near-empty day before today reads Likely closed (spec D32) in This month; This week starts today, without it', async () => {
  await renderAt(portal(meOf(ACCESS.member), NEAR_EMPTY));
  expect(screen.queryByTestId('home-day-2026-11-03')).toBeNull();
  expect(cellOf('2026-11-03').getAttribute('aria-label')).toBe('Tue, Nov 3, 2026. Likely closed (1 guest recorded).');
});

test('today’s partial upload is never likely closed (D32): only a day before the town’s today can be', async () => {
  await renderAt(portal(meOf(ACCESS.member), [...DAYS, day('2026-11-05', 1)]), 'This month in Hanover');
  expect(within(screen.getByTestId('home-day-2026-11-05')).queryByText(/Likely closed/)).toBeNull();
  expect(cellOf('2026-11-05').getAttribute('aria-label')).not.toMatch(/Likely closed/);
});

test('a business rule’s schedule with fewer guests (D31) says a near-empty day was open, on Home as on the Calendar', async () => {
  const slowTuesdays = ruleOf('r1', 'Slow Tuesdays', {
    schedule: { kind: 'other', startDate: '2026-10-01', endDate: null, weekdays: [2], effect: 'fewer_guests', expectedGuests: null, startTime: null, endTime: null },
    scheduleSummary: 'Fewer guests on Tuesdays from Oct 1, 2026',
  });
  const api = portal(meOf(ACCESS.member), NEAR_EMPTY, undefined, NO_FORECAST, { rules: [slowTuesdays], limit: 30 });
  await renderAt(api);
  await waitFor(() => { expect(cellOf('2026-11-03').getAttribute('aria-label')).not.toMatch(/Likely closed/); });
  expect(cellOf('2026-11-03').textContent).toBe('31');
  expect(api.calls.filter((call) => call.path === `${PATH}/rules`)).toHaveLength(1);
  // The hover tooltip reads the same rules, so it agrees with the cell.
  fireEvent(cellOf('2026-11-03'), pointer('pointerover', 'mouse'));
  expect(screen.getByTestId('calendar-tooltip').textContent).not.toMatch(/Likely closed/);
});

test('at a glance: last year’s same week, last week against it, and the next event, each from history or the calendar', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const glance = screen.getByRole('region', { name: 'At a glance' });
  expect(within(glance).getByText('740')).toBeTruthy();
  expect(within(glance).getByText('Same 7 days last year, Thu, Nov 6 to Wed, Nov 12, 2025. From all 7 days.')).toBeTruthy();
  expect(within(glance).getByText('814')).toBeTruthy();
  expect(within(glance).getByText(sentence('+10% against the same week last year (740), over all 7 days.'))).toBeTruthy();
  // The change is its own bold part of the sentence.
  expect(within(glance).getByText('+10%')).toBeTruthy();
  expect(within(glance).getByText('Sample game')).toBeTruthy();
  expect(within(glance).getByText('Sat, Nov 7, 2026, in 2 days')).toBeTruthy();
  expect(within(glance).queryByText(FORECAST_WORDING)).toBeNull();
});

test('this week is a strip of seven days from 1024px, today’s column raised, last year as bars with the figures printed', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const strip = screen.getByRole('table', { name: 'This week, day by day' });
  expect(within(strip).getAllByRole('columnheader')).toHaveLength(7);
  expect(within(strip).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['On the calendar', 'Last year', 'Two years ago']);
  expect(within(strip).getByText(sentence('Sat, Nov 8, 2025: 140 guests'))).toBeTruthy();
  expect(within(strip).getAllByText('140 guests').length).toBeGreaterThan(0);
  expect(screen.getByText('Bars show last year’s days, scaled to the busiest of them.')).toBeTruthy();
});

test('the month calendar: the arrow keys and a pointer preview the days beside the grid', async () => {
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
  expect(within(detail).getByRole('link', { name: 'Open this day on Orders' }).getAttribute('href')).toBe('/locations/l1/orders?day=2026-11-05');
  expect(cell('2026-11-05').getAttribute('aria-selected')).toBe('true');
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(cell('2026-11-11').getAttribute('aria-label')).toBe('Wed, Nov 11, 2026. This week. No forecast. Veterans Day.');
  // A past day says its stored figure; a later one, with no published forecast, has none.
  expect(cell('2026-11-03').getAttribute('aria-label')).toBe('Tue, Nov 3, 2026. 110 guests, actual.');
  expect(cell('2026-11-03').textContent).toBe('3110');
  expect(cell('2026-11-11').textContent).toBe('11No forecast');

  // The keys move the selection, and focus with it.
  cell('2026-11-05').focus();
  fireEvent.keyDown(cell('2026-11-05'), { key: 'ArrowRight' });
  expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-06');
  fireEvent.keyDown(cell('2026-11-06'), { key: 'ArrowDown' });
  expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-13');
  fireEvent.keyDown(cell('2026-11-13'), { key: 'ArrowLeft' });
  fireEvent.keyDown(cell('2026-11-12'), { key: 'ArrowLeft' });
  expect(within(detail).getByRole('heading', { name: 'Wed, Nov 11, 2026' })).toBeTruthy();
  expect(within(detail).getByRole('link', { name: 'Open this day on Orders' }).getAttribute('href')).toBe('/locations/l1/orders?day=2026-11-11');
  // A later day: its holiday and sources, last year's same weekday, and no figure of its own.
  expect(within(detail).getByText('Veterans Day. Federal holiday.')).toBeTruthy();
  expect(within(detail).getByRole('link', { name: 'U.S. Office of Personnel Management. Source' })).toBeTruthy();
  expect(within(detail).getByText(sentence('Wed, Nov 12, 2025: 100 guests'))).toBeTruthy();
  expect(within(detail).queryByText('This day')).toBeNull();
  expect(within(detail).queryByText('Forecast')).toBeNull();
  expect(cell('2026-11-11').getAttribute('tabindex')).toBe('0');
  fireEvent.keyDown(cell('2026-11-11'), { key: 'ArrowUp' });
  fireEvent.keyDown(cell('2026-11-04'), { key: 'ArrowLeft' });
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
  // The month card links to the Calendar.
  expect(screen.getByRole('link', { name: 'Open the calendar' }).getAttribute('href')).toBe('/locations/l1/calendar');
  expect(screen.getByText('Point at a day to see what’s on it. Choose one to open it in the Calendar.')).toBeTruthy();
});

const GAME_SOURCE = { label: 'home.dartmouth.edu', url: 'https://home.dartmouth.edu/' };

/**
 * November from today on, published: 180 to 240 around 212 each day, a private event of 70 on Saturday the 7th.
 * `gameSources`: the game's reason carries its source, as the API's does for a researched event.
 */
function published(gameSources = false): unknown {
  const days = [];
  for (let day = 5; day <= 30; day += 1) {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    days.push(date !== '2026-11-07' ? forecastDay({ date }) : forecastDay({
      date, low: 250, mid: 282, high: 310, model: { status: 'open', low: 180, mid: 212, high: 240 }, noteGuests: 70,
      reasons: [
        { kind: 'note', label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, sources: [], note: { id: 'n1', guests: 70, outcome: 'added' } },
        { kind: 'event', label: 'Sample game', effectPct: 12, effect: { direction: 'more', pct: 10, basis: 'model', days: null }, sources: gameSources ? [GAME_SOURCE] : [], note: null },
        { kind: 'weekday', label: 'Saturday', effectPct: null, effect: { direction: 'more', pct: 35, basis: 'history', days: 52 }, sources: [], note: null },
        { kind: 'term', label: 'Fall term', effectPct: null, effect: null, sources: [], note: null },
      ],
    }));
  }
  return forecastOf(days);
}

/** jsdom has no PointerEvent, so `pointerType` is set on a plain one. */
function pointer(type: string, pointerType: 'mouse' | 'touch'): Event {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

function cellOf(date: string): HTMLElement {
  const found = screen.getByRole('grid', { name: 'November 2026' }).querySelector<HTMLElement>(`[data-date="${date}"]`);
  if (found === null) throw new Error(`no cell for ${date}`);
  return found;
}

test('with a published forecast, This week starts with each day’s Forecast, its figure bold (owner request)', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, published()), 'This month in Hanover');
  const strip = screen.getByRole('table', { name: 'This week, day by day' });
  await waitFor(() => { expect(within(strip).getAllByRole('rowheader')[0]?.textContent).toBe('Forecast'); });
  // Thu, Nov 5 (today) to Wed, Nov 11: 212 a day, and Saturday the 7th with its private event.
  expect(within(strip).getAllByText(sentence('~212 guests, forecast, likely 180 to 240'))).toHaveLength(6);
  expect(within(strip).getByText(sentence('~282 guests, forecast, likely 250 to 310'))).toBeTruthy();
  expect(within(strip).getAllByText('~212 guests')).toHaveLength(6);
});

test('with a published forecast, This month shows each future day’s guests and no tagline', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, published()), 'This month in Hanover');
  await waitFor(() => { expect(cellOf('2026-11-05').textContent).toBe('5~212forecast'); });
  expect(screen.queryByText(NOT_PUBLISHED)).toBeNull();
  expect(screen.queryByText('In progress')).toBeNull();
  // Saturday: the published figure with the notes' guests under it, and both in its label with the range.
  expect(cellOf('2026-11-07').textContent).toBe('7~282+70forecast');
  expect(cellOf('2026-11-07').getAttribute('aria-label'))
    .toBe('Sat, Nov 7, 2026. This week. 282 guests, forecast, likely 250 to 310. Includes 70 guests from your notes. Sample game.');
  // Before today, the stored figure; never a forecast.
  expect(cellOf('2026-11-04').textContent).toBe('4110');
  // The day beside the grid gives the forecast and its three reasons with the largest effect, in the Calendar's order
  // (the note's +35 ties Saturday's and goes first), each with which way it usually moves guests.
  fireEvent.pointerOver(cellOf('2026-11-07'));
  const detail = screen.getByRole('region', { name: 'Selected day' });
  expect(within(detail).getByText('Forecast')).toBeTruthy();
  expect(within(detail).getByText('About 282 guests, likely 250 to 310. Includes 70 guests from your notes.')).toBeTruthy();
  expect(within(detail).getByText('Your private event, 70 guests, 6 pm to 9 pm')).toBeTruthy();
  expect(within(detail).getByText('Saturday: usually more guests')).toBeTruthy();
  expect(within(detail).getByText('Sample game: more guests in Townwise’s model')).toBeTruthy();
  expect(within(detail).queryByText(/^Fall term/)).toBeNull();
});

test('the day detail’s Why rows end in their source chips, and On the calendar leaves out what Why names, as the Calendar does', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, published(true)), 'This month in Hanover');
  await waitFor(() => { expect(cellOf('2026-11-07').textContent).toBe('7~282+70forecast'); });
  fireEvent.pointerOver(cellOf('2026-11-07'));
  const detail = screen.getByRole('region', { name: 'Selected day' });
  const source = within(detail).getByRole('link', { name: 'Dartmouth. Source: home.dartmouth.edu' });
  expect(source.textContent).toBe('Dartmouth');
  expect(source.getAttribute('href')).toBe('https://home.dartmouth.edu/');
  // The chip sits under the row's words (after their mark), in the same row.
  const row = within(detail).getByText('Sample game: more guests in Townwise’s model').parentElement?.parentElement;
  expect(row?.contains(source)).toBe(true);
  expect(row?.textContent).toBe('▲Sample game: more guests in Townwise’s modelDartmouth');
  // The game is in Why with its source, so On the calendar doesn't list it again.
  expect(within(detail).queryByText('Sample game. Town event.')).toBeNull();
  expect(within(detail).getByText('Nothing else on the calendar this day.')).toBeTruthy();
  // A day whose events Why doesn't name keeps them, with their sources.
  fireEvent.pointerOver(cellOf('2026-11-11'));
  expect(within(screen.getByRole('region', { name: 'Selected day' })).getByText('Veterans Day. Federal holiday.')).toBeTruthy();
});

/** The day detail's Why rows, each as its line with the mark before it and the mark's color (null with no mark). */
function whyRowsOf(detail: HTMLElement): [string, string | null][] {
  const part = within(detail).getByText('Why').parentElement;
  return [...(part?.children ?? [])].slice(1).map((row) => {
    const line = row.firstElementChild;
    const mark = line?.querySelector('[aria-hidden="true"]');
    const text = mark === null || mark === undefined ? null : [...mark.querySelectorAll('*')].find((each) => each.children.length === 0) ?? mark;
    return [line?.textContent ?? '', text === null ? null : window.getComputedStyle(text).color];
  });
}

test('the day detail keeps the three largest effects either way, in the Calendar’s order, a run reason’s after its colored mark', async () => {
  const run = (kind: string, label: string, direction: 'more' | 'fewer', pct: number, days: number) => ({
    kind, label, effectPct: null, effect: { direction, pct, basis: 'history', days } as const, sources: [], note: null,
  });
  const thanksgiving = forecastDay({
    date: '2026-11-26',
    reasons: [
      run('weekday', 'Thursday', 'more', 10, 52), run('term', 'Fall term', 'more', 15, 20), run('event', 'Turkey trot', 'more', 20, 4),
      run('holiday', 'Thanksgiving Day', 'fewer', 70, 1),
    ],
  });
  const days = [forecastDay({ date: '2026-11-05' }), thanksgiving];
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, forecastOf(days)), 'This month in Hanover');
  await waitFor(() => { expect(cellOf('2026-11-26').textContent).toBe('26~212forecast'); });
  fireEvent.pointerOver(cellOf('2026-11-26'));
  const detail = screen.getByRole('region', { name: 'Selected day' });
  // The 70% fall is kept over the 10% rise, and shown last, after the rises; its ▼ is the ramp's reddest step.
  expect(whyRowsOf(detail)).toEqual([
    ['▲Turkey trot: usually more guests', theme.color.effectUp2],
    ['▲Fall term: usually more guests', theme.color.effectUp1],
    ['▼Thanksgiving Day: fewer guests last time', theme.color.effectDown3],
  ]);
  // A screen reader hears the words only.
  expect(within(detail).getByText('▼').closest('[aria-hidden="true"]')).not.toBeNull();
  expect(within(detail).getByText('Thanksgiving Day: fewer guests last time').closest('[aria-hidden="true"]')).toBeNull();
});

test('a note’s row in the day detail is its label alone, with no mark; the run reasons beside it keep theirs', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, published()), 'This month in Hanover');
  await waitFor(() => { expect(cellOf('2026-11-07').textContent).toBe('7~282+70forecast'); });
  fireEvent.pointerOver(cellOf('2026-11-07'));
  expect(whyRowsOf(screen.getByRole('region', { name: 'Selected day' }))).toEqual([
    ['Your private event, 70 guests, 6 pm to 9 pm', null],
    ['▲Saturday: usually more guests', theme.color.effectUp2],
    ['▲Sample game: more guests in Townwise’s model', theme.color.effectUp1],
  ]);
});

test('hovering a day shows its top reasons; touch does not', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, published()), 'This month in Hanover');
  await waitFor(() => { expect(cellOf('2026-11-05').textContent).toBe('5~212forecast'); });
  fireEvent(cellOf('2026-11-07'), pointer('pointerover', 'touch'));
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  fireEvent(cellOf('2026-11-07'), pointer('pointerover', 'mouse'));
  const tip = screen.getByTestId('calendar-tooltip');
  expect(tip.getAttribute('aria-hidden')).toBe('true');
  expect(Array.from(tip.children, (line) => line.textContent)).toEqual([
    'Sat, Nov 7, 2026', '282 guests, forecast (likely 250 to 310)', 'Includes 70 guests from your notes',
    'Your private event, 70 guests, 6 pm to 9 pm', 'Saturday: usually more guests', 'Sample game: more guests in Townwise’s model',
  ]);
  fireEvent.pointerLeave(screen.getByRole('grid', { name: 'November 2026' }));
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
});

test('a business rule’s reason (D31) shows in the day detail and the tooltip, and its guests are named as the rule’s', async () => {
  const ruled = forecastOf([forecastDay({ date: '2026-11-05' }), forecastDay({
    date: '2026-11-06', low: 220, mid: 252, high: 280, model: { status: 'open', low: 180, mid: 212, high: 240 }, noteGuests: 40,
    reasons: [
      { kind: 'rule', label: 'Your rule: adds 40 guests on Fridays', effectPct: null, sources: [], note: null, rule: { id: 'r1', guests: 40, outcome: 'added' } },
      { kind: 'weekday', label: 'Friday', effectPct: null, sources: [], note: null },
    ],
  })]);
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, ruled), 'This month in Hanover');
  await waitFor(() => { expect(cellOf('2026-11-06').textContent).toBe('6~252+40forecast'); });
  expect(cellOf('2026-11-06').getAttribute('aria-label'))
    .toBe('Fri, Nov 6, 2026. This week. 252 guests, forecast, likely 220 to 280. Includes 40 guests from your rules. Private event.');
  fireEvent(cellOf('2026-11-06'), pointer('pointerover', 'mouse'));
  const detail = screen.getByRole('region', { name: 'Selected day' });
  expect(within(detail).getByText('About 252 guests, likely 220 to 280. Includes 40 guests from your rules.')).toBeTruthy();
  expect(within(detail).getByText('Your rule: adds 40 guests on Fridays')).toBeTruthy();
  expect(Array.from(screen.getByTestId('calendar-tooltip').children, (line) => line.textContent)).toEqual([
    'Fri, Nov 6, 2026', '252 guests, forecast (likely 220 to 280)', 'Includes 40 guests from your rules', 'Your rule: adds 40 guests on Fridays', 'Friday', 'Private event',
  ]);
});

test('clicking a day opens /locations/x/calendar?day=that day, and so does Enter', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, published()), 'This month in Hanover');
  fireEvent.click(cellOf('2026-11-21'));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/calendar'); });
  expect(window.location.search).toBe('?day=2026-11-21');
  cleanup();

  await renderAt(portal(meOf(ACCESS.member)));
  cellOf('2026-11-05').focus();
  fireEvent.keyDown(cellOf('2026-11-05'), { key: 'Enter' });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/calendar'); });
  expect(window.location.search).toBe('?day=2026-11-05');
});

/** Last week's chart: its svg, with a 280px box, since jsdom lays nothing out (the viewBox is 280 wide too). */
function lastWeekSvg(): SVGSVGElement {
  const svg = screen.getByRole('region', { name: 'Last week' }).querySelector<SVGSVGElement>('svg[viewBox="0 0 280 120"]');
  if (svg === null) throw new Error('no last week chart');
  svg.getBoundingClientRect = () => ({ left: 0, width: 280, top: 0, height: 120, right: 280, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });
  return svg;
}

/** A pointer event at `clientX`, with `pointerType` set, as jsdom has no PointerEvent. */
function pointerAt(type: string, pointerType: 'mouse' | 'touch', clientX: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

test('last week: a mouse over a day shows its row’s words, a touch shows nothing, and a click opens the day in the Calendar', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const svg = lastWeekSvg();
  // Seven 40px slots, Thu, Oct 29 to Wed, Nov 4: x 100 is the third, Sat, Oct 31.
  fireEvent(svg, pointerAt('pointermove', 'touch', 100));
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  fireEvent(svg, pointerAt('pointermove', 'mouse', 100));
  expect(Array.from(screen.getByTestId('chart-tooltip').children, (line) => line.textContent)).toEqual([
    'Sat, Oct 31, 2026', 'Last week: 154 guests', 'Same day last year: 140 guests', 'Change: +10%',
  ]);
  expect(svg.querySelector('[data-hover="day"]')).not.toBeNull();
  fireEvent.pointerLeave(svg);
  expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  fireEvent.click(svg, { clientX: 100 });
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/calendar'); });
  expect(window.location.search).toBe('?day=2026-10-31');
});

/** Home's history picture's cell for `date`. */
function historyCell(date: string): HTMLElement {
  const found = document.getElementById('home-history')?.querySelector<HTMLElement>(`[role="img"] [data-date="${date}"]`) ?? null;
  if (found === null) throw new Error(`no history cell for ${date}`);
  return found;
}

test('your history: a mouse over a day shows its words, a touch shows nothing, and a click opens the day in the Calendar', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  fireEvent(historyCell('2026-10-31'), pointerAt('pointerover', 'touch', 0));
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  fireEvent(historyCell('2026-10-31'), pointerAt('pointerover', 'mouse', 0));
  expect(Array.from(screen.getByTestId('calendar-tooltip').children, (line) => line.textContent)).toEqual(['Sat, Oct 31, 2026', '154 guests, $3,080.']);
  // Leaving the picture's grid box clears it.
  const box = document.getElementById('home-history')?.querySelector('[role="img"] > div');
  if (box === null || box === undefined) throw new Error('no history box');
  fireEvent.pointerLeave(box);
  expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  fireEvent.click(historyCell('2026-10-31'));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/calendar'); });
  expect(window.location.search).toBe('?day=2026-10-31');
});

test('your history: a day the Calendar can’t show (over 12 months back) hovers but opens nothing', async () => {
  const old = DAYS.filter((record) => record.date <= '2024-12-31');
  await renderAt(portal(meOf(ACCESS.member), old));
  const cell = historyCell('2024-10-05');
  expect(cell.hasAttribute('data-open')).toBe(false);
  fireEvent(cell, pointerAt('pointerover', 'mouse', 0));
  expect(screen.getByTestId('calendar-tooltip').textContent).toMatch(/^Sat, Oct 5, 2024/);
  fireEvent.click(cell);
  expect(window.location.pathname).toBe('/locations/l1');
});

test('without a published forecast, the lead says Townwise hasn’t published one yet', async () => {
  const api = portal(meOf(ACCESS.member));
  await renderAt(api);
  expect(screen.getByText('In progress')).toBeTruthy();
  // One read of this month's forecast, on its own, and one of Last week's seven days (D42), on its own too.
  expect(api.calls.filter((call) => call.path.startsWith(`${PATH}/forecast`)).map((call) => call.path).sort())
    .toEqual([`${PATH}/forecast?from=2026-10-29&to=2026-11-04`, FORECAST]);
});

test('a failed forecast read never fails Home', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, offline()));
  expect(screen.getByRole('heading', { name: 'This month in Hanover' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(cellOf('2026-11-11').textContent).toBe('11');
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
  // One location: the lead names the organization (D29).
  await renderAt(portal(meOf(ACCESS.admin), [], empty), forecastLine('Test Group'));
  const step = screen.getByRole('region', { name: 'Drop in everything you have' });
  expect((await within(step).findByRole('link', { name: 'Upload sales history' })).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(document.getElementById('home-history')).toBeNull();
  expect(screen.getByText('Sample game')).toBeTruthy();
});

// D49 (calendar-sources "Home's events read"): Home reads the location's own calendars' events over its forecast range,
// this month and This week's days past it, under the events route's 92 days; a failed read leaves Home showing.
const OWNER_EVENTS = `${PATH}/owner-calendars/events?from=2026-11-01&to=2026-11-30`;
const WINE_DINNER = {
  calendarId: 'fedcba9876543210fedcba98', calendar: 'US holidays', uid: 'w1', title: 'Wine dinner', startDate: '2026-11-06', endDate: '2026-11-06',
  startTime: null, endTime: null,
};

test('Home reads its calendars’ events for Nov 1 to 30, under 92 days, and This week lists them', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, NO_FORECAST, undefined, undefined, { [OWNER_EVENTS]: { events: [WINE_DINNER] } }));
  expect(lastFake?.paths).toContain(OWNER_EVENTS);
  expect(daysBetween('2026-11-01', '2026-11-30')).toBeLessThan(92);
  const week = screen.getByRole('region', { name: 'This week in Hanover' });
  expect(await within(week).findByText('Wine dinner')).toBeTruthy();
});

test('a refused events read leaves Home showing, with no imported events', async () => {
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, NO_FORECAST, undefined, undefined, { [OWNER_EVENTS]: refusal(400, 'bad_range') }));
  expect(screen.getByRole('heading', { name: 'This month in Hanover' })).toBeTruthy();
  expect(screen.queryByText('Wine dinner')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

// D49: the day detail lists every entry with its source, as the Calendar's panel does; "Open the calendar" sits under
// the grid's key; the Reorder part's explanation is behind a disclosure, closed by default.
test('the day detail lists a day’s imported event with its calendar’s chip, and a titled note by its name', async () => {
  const titled = { notes: [note({ startDate: '2026-11-06', title: 'Holiday party', detail: 'A rehearsal dinner.' })] };
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, NO_FORECAST, undefined, undefined, {
    [OWNER_EVENTS]: { events: [WINE_DINNER] }, [`${PATH}/notes`]: titled,
  }));
  const grid = screen.getByRole('grid', { name: 'November 2026' });
  const today = grid.querySelector('[data-date="2026-11-05"]');
  if (today === null) throw new Error('no today');
  fireEvent.keyDown(today, { key: 'ArrowRight' });
  const detail = screen.getByRole('region', { name: 'Selected day' });
  expect(await within(detail).findByText('From your calendar: Wine dinner')).toBeTruthy();
  const chip = within(detail).getByRole('link', { name: 'US holidays. Opens this calendar in Your data' });
  expect(chip.getAttribute('href')).toBe(`/locations/l1/data/c_${WINE_DINNER.calendarId}`);
  expect(within(detail).getByText('Your note: Holiday party.')).toBeTruthy();
  expect(within(detail).getByText('A rehearsal dinner.')).toBeTruthy();
  // The cell names both, and Home's This week shows the note's name.
  expect(grid.querySelector('[data-date="2026-11-06"]')?.getAttribute('aria-label')).toContain('Holiday party. From your calendar: Wine dinner.');
});

test('“Open the calendar” sits under the grid’s key, and the Reorder explanation opens from its disclosure', async () => {
  await renderAt(portal(meOf(ACCESS.member)));
  const open = screen.getByRole('link', { name: 'Open the calendar' });
  const key = screen.getByText('Town event or holiday');
  expect(key.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const detail = screen.getByRole('region', { name: 'Selected day' });
  expect(open.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const how = within(detail).getByRole('button', { name: 'How Townwise builds an order' });
  expect(how.getAttribute('aria-expanded')).toBe('false');
  expect(within(detail).queryByText(REORDER_OVERVIEW)).toBeNull();
  // The one-line status and the link stay in view.
  expect(within(detail).getByRole('link', { name: 'Open this day on Orders' })).toBeTruthy();
  fireEvent.click(how);
  expect(how.getAttribute('aria-expanded')).toBe('true');
  expect(within(detail).getByText(REORDER_OVERVIEW)).toBeTruthy();
});

test('This month marks a forecast and an actual apart, keys both, and says how the month’s forecast did (D49, 2026-11-18)', async () => {
  // Wed, Nov 4: 110 stored guests against a run made Nov 2 that said 90 to 120.
  const window = published() as { days: Parameters<typeof forecastOf>[0] };
  const past = forecastDay({ date: '2026-11-04', low: 90, mid: 100, high: 120, actual: 110, inRange: true, scored: true, madeAt: '2026-11-02' });
  await renderAt(portal(meOf(ACCESS.member), DAYS, undefined, forecastOf([past, ...window.days])), 'This month in Hanover');
  await waitFor(() => { expect(cellOf('2026-11-05').textContent).toBe('5~212forecast'); });
  const figure = (date: string): HTMLElement | null => cellOf(date).querySelector<HTMLElement>('[data-figure]');
  expect([figure('2026-11-04')?.getAttribute('data-figure'), figure('2026-11-04')?.textContent]).toEqual(['actual', '110']);
  expect([figure('2026-11-05')?.getAttribute('data-figure'), figure('2026-11-05')?.textContent]).toEqual(['forecast', '~212']);
  expect(figure('2026-11-04')?.style.color).not.toBe(figure('2026-11-05')?.style.color);
  expect(cellOf('2026-11-04').getAttribute('aria-label')).toBe('Wed, Nov 4, 2026. 110 guests, actual.');
  expect(screen.getByTestId('month-key').textContent).toMatch(/^94Actual guests~82Forecast/);
  expect(screen.getByText('So far this month: 1 of 1 day inside the forecast range.')).toBeTruthy();
  // The past day's detail and tooltip say how its forecast did, in the Calendar's words.
  fireEvent(cellOf('2026-11-04'), pointer('pointerover', 'mouse'));
  const detail = screen.getByRole('region', { name: 'Selected day' });
  expect(within(detail).getByText('Forecast was about 100 (likely 90 to 120); 110 guests came: inside the range.')).toBeTruthy();
  expect(screen.getByTestId('calendar-tooltip').textContent).toContain('110 guests, actualForecast was about 100 (likely 90 to 120); 110 guests came: inside the range');
});
