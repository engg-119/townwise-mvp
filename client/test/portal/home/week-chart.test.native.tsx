jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, waitFor, within } from 'expo-router/testing-library';

import type { DayRecord } from '../../../src/portal/analytics/history';
import type { ForecastDay } from '../../../src/portal/estimates/api';
import { ACCESS, fakePortalApi, meOf, orgOf, refusal, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake, calendarBody, day, historyBody, holiday, note, run } from '../analytics/fakes';
import { forecastDay, forecastOf, NO_FORECAST } from '../calendar/fakes';
import { NOVEMBER } from '../estimates/fakes';

// This week's chart on Home, on native (spec P11, owner request 2026-11-18): the same chart as on web, drawn with
// react-native-svg, so phones show it too, and a tap chooses a day. Closed, booked and uncovered days in words, each
// day a button with its full name, the chosen day's panel with its link to the Calendar, Show the numbers with the
// day-by-day table, and This month's grid and At a glance as they were. Synthetic days and made-up figures only.

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 5, 12, 0, 0),
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
});

afterEach(async () => {
  await cleanup();
  jest.useRealTimers();
});

const PATH = '/api/org/locations/l1';
const CALENDAR = `${PATH}/calendar?from=2024-10-07&to=2026-11-30`;
const FORECAST = `${PATH}/forecast?from=2026-11-01&to=2026-11-30`;
const SATURDAY = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
// History through today, Thu, Nov 5, 2026, whose 120 guests so far are the week's one actual.
const DAYS = [...run('2024-09-01', '2026-11-04', (date) => (SATURDAY(date) ? 140 : 100)), day('2026-11-05', 120)];
const EVENTS = [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day')];

/** November from today: 212 (180 to 240) a day; Fri, Nov 6 closed; Sat, Nov 7 your buyout of 40; Sun, Nov 8 not covered. */
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
    } else days.push(forecastDay({ date }));
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
    [`${PATH}/orders`]: refusal(503, 'unavailable'),
    [`${PATH}/imports/current`]: refusal(503, 'files_unavailable'),
  });
  return fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
}

const TODAY_LABEL = 'Thu, Nov 5, 2026. Today. 212 guests, forecast, likely 180 to 240. 120 guests, actual. Same weekday last year, Thu, Nov 6, 2025: 100 guests.';

/**
 * The chart's drawn points of one radius: react-native-svg's native circles keep only their drawing props, so a
 * series is told by its point's size (forecast rings 4, the actual 4.5, last year 2), as WeekChart.tsx draws them.
 */
function points(r: number): unknown[] {
  return screen.container.queryAll((node) => node.type === 'RNSVGCircle' && node.props.r === r);
}

test('the chart draws on native: the forecast, its range, today’s actual and last year, keyed and scaled', async () => {
  await renderApp('/locations/l1', portal());
  expect(await screen.findByLabelText(TODAY_LABEL)).toBeTruthy();
  // The forecast's four open days are rings, today's actual is the one larger dot, and last year's seven days small dots.
  await waitFor(() => { expect(points(4)).toHaveLength(4); });
  expect(points(4.5)).toHaveLength(1);
  expect(points(2)).toHaveLength(7);
  // The key is hidden from screen readers, since each day's name says the same.
  expect(screen.queryByTestId('home-week-chart-key')).toBeNull();
  const key = screen.getByTestId('home-week-chart-key', { includeHiddenElements: true });
  for (const words of ['Forecast', 'Likely range', 'Actual guests', 'Same weekday last year']) {
    expect(within(key).getByText(words, { includeHiddenElements: true })).toBeTruthy();
  }
  expect(screen.getByText('Scale 0 to 250 guests. Scale fitted to this location.')).toBeTruthy();
  expect(screen.getByText('Tap a day to see it in full.')).toBeTruthy();
});

test('closed, booked and uncovered days are words in their columns, and each day is a button with its full name', async () => {
  await renderApp('/locations/l1', portal());
  await screen.findByLabelText(TODAY_LABEL);
  expect(within(screen.getByTestId('home-week-chart-2026-11-06')).getByText('Closed')).toBeTruthy();
  expect(within(screen.getByTestId('home-week-chart-2026-11-07')).getByText('Booked')).toBeTruthy();
  expect(within(screen.getByTestId('home-week-chart-2026-11-07')).getByText('~40 guests')).toBeTruthy();
  expect(within(screen.getByTestId('home-week-chart-2026-11-08')).getByText('No forecast')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Fri, Nov 6, 2026. Closed. Same weekday last year, Fri, Nov 7, 2025: 100 guests.' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sun, Nov 8, 2026. No forecast. Same weekday last year, Sun, Nov 9, 2025: 100 guests.' })).toBeTruthy();
  expect(screen.getByRole('button', { name: TODAY_LABEL }).props.accessibilityState).toMatchObject({ selected: true });
});

test('a tap chooses a day: its forecast, calendar and last year, and its link opens the day on the Calendar', async () => {
  const { router } = await renderApp('/locations/l1', portal());
  await screen.findByLabelText(TODAY_LABEL);
  const panel = (): ReturnType<typeof screen.getByLabelText> => screen.getByLabelText('This week’s chosen day');
  expect(within(panel()).getByRole('heading', { name: 'Today, Thu, Nov 5, 2026' })).toBeTruthy();
  await fireEvent.press(screen.getByTestId('home-week-chart-2026-11-11'));
  expect(within(panel()).getByRole('heading', { name: 'Wed, Nov 11, 2026' })).toBeTruthy();
  expect(within(panel()).getByText('About 212 guests, likely 180 to 240.')).toBeTruthy();
  expect(within(panel()).getByText('Veterans Day. Federal holiday.')).toBeTruthy();
  expect(within(panel()).getByText('Same weekday last year')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('home-week-chart-2026-11-07'));
  expect(within(panel()).getByText('Booked: a private buyout, 40 guests. No walk-in forecast.')).toBeTruthy();
  await fireEvent.press(within(panel()).getByRole('link', { name: 'Open this day on the Calendar' }));
  expect(router.getPathname()).toBe('/locations/l1/calendar');
  expect(router.getSearchParams()).toMatchObject({ day: '2026-11-07' });
});

test('Show the numbers gives the day-by-day table; This month and At a glance are as they were', async () => {
  await renderApp('/locations/l1', portal());
  await screen.findByLabelText(TODAY_LABEL);
  expect(screen.queryByLabelText('This week, day by day')).toBeNull();
  const [weekNumbers] = screen.getAllByRole('button', { name: /Show the numbers/ });
  if (weekNumbers === undefined) throw new Error('no Show the numbers');
  await fireEvent.press(weekNumbers);
  expect(screen.getByLabelText('This week, day by day')).toBeTruthy();
  expect(screen.getByLabelText('This week’s days in past years')).toBeTruthy();
  // This month's cells and At a glance's forecast tile read as before.
  expect(screen.getByLabelText(/^Fri, Nov 6, 2026\. This week\. Closed\./)).toBeTruthy();
  expect(screen.getByText('This week’s forecast')).toBeTruthy();
  expect(screen.getByText('~888')).toBeTruthy();
});

test('with no history and nothing published there is nothing to draw, so the days stay in view', async () => {
  await renderApp('/locations/l1', portal(NO_FORECAST, []));
  expect(await screen.findByLabelText('This week, day by day')).toBeTruthy();
  expect(screen.queryByTestId('home-week-chart-2026-11-05')).toBeNull();
});
