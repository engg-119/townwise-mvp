import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DayRecord } from '../../../src/portal/analytics/history';
import type { ForecastDay } from '../../../src/portal/estimates/api';
import { WEEK_PANEL_ID } from '../../../src/portal/home/WeekChart';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, refusal, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, day, historyBody, holiday, note, run } from '../analytics/fakes';
import { forecastDay, forecastOf, NO_FORECAST } from '../calendar/fakes';
import { NOVEMBER } from '../estimates/fakes';

// This week's chart on Home, on web (spec P11, owner request 2026-11-18): the published forecast's middle as points on
// a dashed line with its range as a band, today's stored guests as the actual beside it, the same weekdays last year as
// a faint line, closed, booked and uncovered days in words; each day a button with a full name that a mouse previews
// (never a touch) and a click, Enter or focus chooses, the chosen day's panel with its link to the Calendar; Show the
// numbers with the day-by-day table; and At a glance and This month as they were. Synthetic days and made-up figures.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide, which is a phone to react-native-web; most tests here cover the desktop layout.
let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function resize(to: number): void {
  width = to;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

// Only Date is faked, so "today" is Thu, Nov 5, 2026 and every timer stays real.
beforeEach(() => {
  resize(1280);
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
const CALENDAR = `${PATH}/calendar?from=2024-10-07&to=2026-11-30`;
const FORECAST = `${PATH}/forecast?from=2026-11-01&to=2026-11-30`;
const SATURDAY = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
// History through today, Thu, Nov 5, 2026, whose 120 guests so far are the week's one actual.
const DAYS = [...run('2024-09-01', '2026-11-04', (date) => (SATURDAY(date) ? 140 : 100)), day('2026-11-05', 120)];
const EVENTS = [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day')];
const FORECAST_WORDING = /\blikely\b|\branges?\b|forecast:\s*\d|\bpredict/i;

const MONDAY_REASONS: ForecastDay['reasons'] = [
  { kind: 'weekday', label: 'Monday', effectPct: null, effect: { direction: 'fewer', pct: 15, basis: 'history', days: 52 }, sources: [], note: null },
];

/**
 * November from today: 212 (180 to 240) a day; Fri, Nov 6 closed; Sat, Nov 7 your private buyout of 40; Sun, Nov 8
 * not covered, so it has no figure; Mon, Nov 9 with its weekday's reason.
 */
function published(): unknown {
  const days: ForecastDay[] = [];
  for (let at = 5; at <= 30; at += 1) {
    const date = `2026-11-${String(at).padStart(2, '0')}`;
    if (date === '2026-11-08') continue;
    if (date === '2026-11-06') days.push(forecastDay({ date, status: 'closed', low: null, mid: null, high: null }));
    else if (date === '2026-11-07') {
      days.push(forecastDay({
        date, status: 'booked', low: null, mid: null, high: null, noteGuests: 40,
        reasons: [{ kind: 'note', label: 'Your private buyout, 40 guests', effectPct: null, sources: [], note: { id: 'n2', guests: 40, outcome: 'booked' } }],
      }));
    } else days.push(forecastDay(date === '2026-11-09' ? { date, reasons: MONDAY_REASONS } : { date }));
  }
  return forecastOf(days);
}

function portal(forecast: unknown = published(), days: readonly DayRecord[] = DAYS): FakePortalApi {
  const fake = analyticsFake({
    [FORECAST]: forecast,
    [`${PATH}/sales/history`]: historyBody(days),
    [`${PATH}/notes`]: { notes: [note({ startDate: '2026-11-10', detail: 'A rehearsal dinner.' })] },
    [CALENDAR]: calendarBody({ events: EVENTS }),
    [`${PATH}/agent`]: { questions: [], activity: [] },
    [`${PATH}/people-in-town?from=2026-11-01&to=2026-11-30`]: NOVEMBER,
    [`${PATH}/imports/current`]: refusal(503, 'files_unavailable'),
  });
  const me = meOf(ACCESS.member);
  return fakePortalApi({ me, org: orgOf('member'), fallback: fake });
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
  await screen.findByText('This month in Hanover');
}

function week(): HTMLElement {
  return screen.getByRole('region', { name: 'This week in Hanover' });
}

function dayButton(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="home-week-chart-${date}"]`);
  if (found === null) throw new Error(`no chart day ${date}`);
  return found;
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'This week’s chosen day' });
}

/** The chart's drawn marks of one series. */
function marks(series: string): Element[] {
  return Array.from(week().querySelectorAll(`svg [data-series="${series}"]`));
}

/** jsdom has no PointerEvent, so react-native-web listens for mouseenter and mouseleave; `pointerType` is set on them. */
function hover(element: Element, type: 'mouseenter' | 'mouseleave', pointerType: 'mouse' | 'touch' = 'mouse'): void {
  const event = new MouseEvent(type, { bubbles: false });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => { element.dispatchEvent(event); });
}

/** Waits for the published forecast to reach the chart. */
async function forecastIn(): Promise<void> {
  await waitFor(() => { expect(marks('forecast-point')).toHaveLength(4); });
}

test('the forecast is points on a dashed line with its range as a band, today’s actual beside it, last year a faint line', async () => {
  await renderAt(portal());
  await forecastIn();
  // Thu 5 alone (Fri closed, Sat booked, Sun uncovered), then Mon 9 to Wed 11: two runs of the range, one of the line.
  expect(marks('range')).toHaveLength(2);
  expect(marks('forecast')).toHaveLength(1);
  expect(marks('actual')).toHaveLength(1);
  expect(marks('last-year')).toHaveLength(1);
  expect(marks('last-year-point')).toHaveLength(7);
  // The actual sits beside today's forecast, not on it.
  const [ring] = marks('forecast-point');
  const [actual] = marks('actual');
  expect(Number(actual?.getAttribute('cx'))).toBeGreaterThan(Number(ring?.getAttribute('cx')));
  // The drawing is a picture only; the key names what is drawn, and the scale is printed.
  const svg = week().querySelector('svg');
  expect(svg?.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByTestId('home-week-chart-key').textContent).toBe('ForecastLikely rangeActual guestsSame weekday last year');
  expect(screen.getByTestId('home-week-chart-key').getAttribute('aria-hidden')).toBe('true');
  expect(within(week()).getByText('Scale 0 to 250 guests. Scale fitted to this location.')).toBeTruthy();
});

test('closed, booked and uncovered days say so in words in their columns, with no point', async () => {
  await renderAt(portal());
  await forecastIn();
  expect(within(dayButton('2026-11-06')).getByText('Closed')).toBeTruthy();
  expect(within(dayButton('2026-11-07')).getByText('Booked')).toBeTruthy();
  expect(within(dayButton('2026-11-07')).getByText('~40 guests')).toBeTruthy();
  expect(within(dayButton('2026-11-08')).getByText('No forecast')).toBeTruthy();
  // An open day says nothing in its column: its point says it.
  expect(dayButton('2026-11-09').textContent).toBe('MonNov 9');
});

test('each day is a button named with everything its column shows and its calendar, today chosen at first', async () => {
  await renderAt(portal());
  await forecastIn();
  const group = screen.getByRole('group', { name: 'This week’s days' });
  const days = within(group).getAllByRole('button');
  expect(days).toHaveLength(7);
  expect(days[0]?.getAttribute('aria-label')).toBe(
    'Thu, Nov 5, 2026. Today. 212 guests, forecast, likely 180 to 240. 120 guests, actual. Same weekday last year, Thu, Nov 6, 2025: 100 guests.',
  );
  expect(dayButton('2026-11-06').getAttribute('aria-label')).toBe('Fri, Nov 6, 2026. Closed. Same weekday last year, Fri, Nov 7, 2025: 100 guests.');
  expect(dayButton('2026-11-07').getAttribute('aria-label'))
    .toBe('Sat, Nov 7, 2026. Booked: a private buyout, 40 guests, forecast. Same weekday last year, Sat, Nov 8, 2025: 140 guests.');
  expect(dayButton('2026-11-08').getAttribute('aria-label')).toBe('Sun, Nov 8, 2026. No forecast. Same weekday last year, Sun, Nov 9, 2025: 100 guests.');
  expect(dayButton('2026-11-11').getAttribute('aria-label')).toMatch(/^Wed, Nov 11, 2026\. 212 guests, forecast, likely 180 to 240\. .*Veterans Day\.$/);
  expect(dayButton('2026-11-10').getAttribute('aria-label')).toMatch(/Private event\.$/);
  // Today is the chosen day, and every day names the panel it controls.
  expect(days.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false']);
  expect(days.every((button) => button.getAttribute('aria-controls') === WEEK_PANEL_ID)).toBe(true);
  expect(within(panel()).getByRole('heading', { name: 'Today, Thu, Nov 5, 2026' })).toBeTruthy();
  expect(within(panel()).getByText('About 212 guests, likely 180 to 240.')).toBeTruthy();
  expect(within(panel()).getByText('120 guests')).toBeTruthy();
});

test('a mouse over a day previews it in the panel and lights its column; leaving restores the chosen day; a touch does nothing', async () => {
  await renderAt(portal());
  await forecastIn();
  hover(dayButton('2026-11-09'), 'mouseenter');
  expect(within(panel()).getByRole('heading', { name: 'Mon, Nov 9, 2026' })).toBeTruthy();
  expect(within(panel()).getByText('About 212 guests, likely 180 to 240.')).toBeTruthy();
  expect(within(panel()).getByText('Why')).toBeTruthy();
  expect(within(panel()).getByText(/^Monday/)).toBeTruthy();
  expect(week().querySelectorAll('svg [data-hover="day"]')).toHaveLength(1);
  hover(dayButton('2026-11-09'), 'mouseleave');
  expect(within(panel()).getByRole('heading', { name: 'Today, Thu, Nov 5, 2026' })).toBeTruthy();
  hover(dayButton('2026-11-10'), 'mouseenter', 'touch');
  expect(within(panel()).getByRole('heading', { name: 'Today, Thu, Nov 5, 2026' })).toBeTruthy();
});

test('a click or focus chooses a day: its forecast, calendar, last year and a link that opens it on the Calendar', async () => {
  await renderAt(portal());
  await forecastIn();
  fireEvent.click(dayButton('2026-11-11'));
  expect(dayButton('2026-11-11').getAttribute('aria-pressed')).toBe('true');
  expect(dayButton('2026-11-05').getAttribute('aria-pressed')).toBe('false');
  expect(within(panel()).getByRole('heading', { name: 'Wed, Nov 11, 2026' })).toBeTruthy();
  expect(within(panel()).getByText('Veterans Day. Federal holiday.')).toBeTruthy();
  expect(within(panel()).getByText('Same weekday last year')).toBeTruthy();
  expect(within(panel()).getByRole('link', { name: 'Open this day on the Calendar' }).getAttribute('href')).toBe('/locations/l1/calendar?day=2026-11-11');
  // A booked day: the buyout's words; a note's day: the note.
  fireEvent.click(dayButton('2026-11-07'));
  expect(within(panel()).getByText('Booked: a private buyout, 40 guests. No walk-in forecast.')).toBeTruthy();
  fireEvent.focus(dayButton('2026-11-10'));
  expect(within(panel()).getByRole('heading', { name: 'Tue, Nov 10, 2026' })).toBeTruthy();
  expect(within(panel()).getByText(/^Your note: Private event/)).toBeTruthy();
  // An uncovered day says it has no figure.
  fireEvent.click(dayButton('2026-11-08'));
  expect(within(panel()).getByText('No forecast figure for this day.')).toBeTruthy();
});

test('Show the numbers gives the day-by-day table, then the past years’ table', async () => {
  await renderAt(portal());
  await forecastIn();
  expect(within(week()).queryByRole('table', { name: 'This week, day by day' })).toBeNull();
  fireEvent.click(within(week()).getByRole('button', { name: /Show the numbers/ }));
  const strip = within(week()).getByRole('table', { name: 'This week, day by day' });
  expect(within(strip).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['Forecast', 'On the calendar', 'Last year', 'Two years ago']);
  expect(within(strip).getByText('Closed')).toBeTruthy();
  expect(within(week()).getByText('Bars show last year’s days, scaled to the busiest of them.')).toBeTruthy();
  expect(within(week()).getByLabelText('This week’s days in past years')).toBeTruthy();
});

test('At a glance’s forecast tile and This month’s grid are as they were', async () => {
  await renderAt(portal());
  await forecastIn();
  const glance = screen.getByRole('region', { name: 'At a glance' });
  expect(within(glance).getByText('This week’s forecast')).toBeTruthy();
  // Four open days of 212, Friday closed (0) and Saturday's buyout of 40, as before.
  expect(within(glance).getByText('~888')).toBeTruthy();
  expect(within(glance).getByText('Thu, Nov 5 to Wed, Nov 11, 2026: 6 of the 7 days’ forecasts added up. Sun, Nov 8 has no forecast figure.')).toBeTruthy();
  const grid = screen.getByRole('grid', { name: 'November 2026' });
  const cell = (date: string): Element | null => grid.querySelector(`[data-date="${date}"]`);
  expect(cell('2026-11-05')?.textContent).toBe('5~212forecast');
  expect(cell('2026-11-06')?.textContent).toBe('6Closed');
  expect(cell('2026-11-04')?.textContent).toBe('4100');
});

test('phones show the chart too, and a tap chooses a day', async () => {
  resize(375);
  await renderAt(portal());
  await forecastIn();
  fireEvent.click(dayButton('2026-11-09'));
  expect(within(panel()).getByRole('heading', { name: 'Mon, Nov 9, 2026' })).toBeTruthy();
});

test('with nothing published the chart draws last year alone, no day says a word, and nothing reads as a forecast', async () => {
  await renderAt(portal(NO_FORECAST, DAYS.slice(0, -1)));
  expect(marks('last-year-point')).toHaveLength(7);
  expect(marks('forecast-point')).toHaveLength(0);
  expect(marks('range')).toHaveLength(0);
  expect(marks('actual')).toHaveLength(0);
  expect(dayButton('2026-11-08').textContent).toBe('SunNov 8');
  expect(screen.getByTestId('home-week-chart-key').textContent).toBe('Same weekday last year');
  expect(within(panel()).queryByText('Forecast')).toBeNull();
  expect(week().textContent).not.toMatch(FORECAST_WORDING);
  expect(dayButton('2026-11-05').getAttribute('aria-label')).toBe('Thu, Nov 5, 2026. Today. No forecast. Same weekday last year, Thu, Nov 6, 2025: 100 guests.');
});

test('with no history and nothing published there is nothing to draw, so the days stay in view', async () => {
  await renderAt(portal(NO_FORECAST, []));
  expect(week().querySelector('svg [data-series]')).toBeNull();
  expect(document.querySelector('[data-testid^="home-week-chart-"]')).toBeNull();
  expect(within(week()).getByRole('table', { name: 'This week, day by day' })).toBeTruthy();
});
