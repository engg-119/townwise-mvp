jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import type { DayRecord } from '../../../src/portal/analytics/history';
import { forecastRange, homeCalendarRange, weekDates } from '../../../src/portal/analytics/week';
import type { ForecastDay, LiveAccuracy } from '../../../src/portal/estimates/api';
import { forecastLine } from '../../../src/portal/home/Home';
import { NATIVE_UPLOAD } from '../../../src/portal/locations/parts';
import { ACCESS, fakePortalApi, meOf, offline, orgOf, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake, calendarBody, historyBody, run } from '../analytics/fakes';
import { forecastDay, NO_FORECAST } from '../calendar/fakes';

// Home's Last week with the published forecast, on native (D42, home-last-week; D21): the same sentences and the table,
// and no bars. Today is Mon, Nov 23, 2026, so last week is Nov 16 to 22, read on its own. Every forecast figure is the
// read's own and only a published run's; with the read failing or nothing published the card is exactly today's.
// Synthetic days and made-up figures only.

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 23, 12, 0, 0),
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

const TODAY = '2026-11-23';
const PATH = '/api/org/locations/l1';
const CALENDAR = `${PATH}/calendar?from=${homeCalendarRange(TODAY).from}&to=${homeCalendarRange(TODAY).to}`;
const MONTH = `${PATH}/forecast?from=${forecastRange(TODAY).from}&to=${forecastRange(TODAY).to}`;
const LAST_WEEK = `${PATH}/forecast?from=2026-11-16&to=2026-11-22`;
const WEEK = weekDates('2026-11-16');
const HISTORY = run('2024-09-01', '2026-11-22', (date) => (date >= '2026-11-16' ? 110 : 100));
const UP_TO_FRIDAY = HISTORY.filter((day) => day.date <= '2026-11-20');
const UP_TO_LAST_SUNDAY = HISTORY.filter((day) => day.date <= '2026-11-15');

function published(days: ForecastDay[], accuracy: LiveAccuracy | null): unknown {
  return { available: true, reason: null, runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, madeAt: '2026-11-09', live: null }], days, accuracy, weeks: [] };
}

const scored = (date: string, inRange = true): ForecastDay => forecastDay({ date, low: 90, mid: 105, high: 120, actual: 110, inRange, scored: true });
const MIXED = published([
  ...WEEK.slice(0, 5).map((date, index) => scored(date, index !== 4)),
  forecastDay({ date: '2026-11-21', low: 180.4, mid: 210.2, high: 244.1, scored: false }),
  forecastDay({ date: '2026-11-22', low: 150, mid: 170, high: 190, scored: false }),
], { days: 5, inRange: 4, typicalErrorPct: 9.8, from: '2026-11-16', to: '2026-11-20' });

function portal(days: readonly DayRecord[], lastWeek: unknown, month: unknown = NO_FORECAST): FakePortalApi {
  const fake = analyticsFake({
    [MONTH]: month,
    [LAST_WEEK]: lastWeek,
    [`${PATH}/sales/history`]: historyBody(days),
    [`${PATH}/notes`]: { notes: [] },
    [CALENDAR]: calendarBody(),
  });
  return fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
}

async function card(api: FakePortalApi): Promise<ReturnType<typeof within>> {
  await renderApp('/locations/l1', api);
  await screen.findByText(forecastLine('Main Street Bar'));
  return within(screen.getByLabelText('Last week'));
}

test('a mix: the sentences and the table, with each forecast-only row saying so, and no bars', async () => {
  const lastWeek = await card(portal(UP_TO_FRIDAY, MIXED));
  expect(await lastWeek.findByText('Townwise’s forecast was off by 10% over 5 days. 4 of 5 days inside the forecast range.')).toBeTruthy();
  expect(lastWeek.getByText('No guest count uploaded for Sat and Sun yet; this is Townwise’s forecast.')).toBeTruthy();
  expect(lastWeek.getByText('Last week: 550 guests on the 5 days both weeks have, 10% more than the same days last year (500).')).toBeTruthy();
  // Native draws no chart (D21): no key, no scale.
  expect(lastWeek.queryByText('Forecast')).toBeNull();
  expect(lastWeek.queryByText(/^Scale 0 to/)).toBeNull();
  await fireEvent.press(lastWeek.getByRole('button', { name: /Show the numbers/ }));
  expect(lastWeek.getByText('Forecast, no guest count uploaded yet: ~210 guests, 180 to 245')).toBeTruthy();
  expect(lastWeek.getByText('Forecast, no guest count uploaded yet: ~170 guests, 150 to 190')).toBeTruthy();
  expect(lastWeek.getAllByText('About 105, 90 to 120')).toHaveLength(5);
  expect(lastWeek.getByText('In range')).toBeTruthy();
  expect(lastWeek.getAllByText('Yes')).toHaveLength(4);
  // The tile follows the card.
  expect(screen.getByText('Off by 10% against the forecast over 5 days.')).toBeTruthy();
});

test('no uploads since last Sunday: the forecast for these days and the upload link, and no weekly total', async () => {
  const days = WEEK.map((date) => forecastDay({ date, low: 180, mid: 210, high: 245, scored: false }));
  const lastWeek = await card(portal(UP_TO_LAST_SUNDAY, published(days, null)));
  expect(await lastWeek.findByText('No guest count uploaded for these days yet; this is Townwise’s forecast.')).toBeTruthy();
  expect(lastWeek.queryByText(/Your history ends/)).toBeNull();
  // Native has no upload (D20): the card says where to upload instead.
  expect(lastWeek.getByText(NATIVE_UPLOAD)).toBeTruthy();
  await fireEvent.press(lastWeek.getByRole('button', { name: /Show the numbers/ }));
  expect(lastWeek.getAllByText('Forecast, no guest count uploaded yet: ~210 guests, 180 to 245')).toHaveLength(7);
  expect(lastWeek.queryByText(/1,470/)).toBeNull();
  expect(screen.getByText('No guest counts for these days yet. Upload your sales to see how Townwise’s forecast did.')).toBeTruthy();
});

test('the read failing or nothing published: exactly today’s card, with no forecast words', async () => {
  const failed = await card(portal(UP_TO_LAST_SUNDAY, offline()));
  expect(await failed.findByText('Your history ends Nov 15, 2026. Upload the days since to compare last week.')).toBeTruthy();
  expect(failed.queryByText(/forecast/i)).toBeNull();
  expect(failed.queryByRole('button', { name: 'Try again' })).toBeNull();
  await cleanup();

  const none = await card(portal(HISTORY, NO_FORECAST));
  expect(none.getByText('Last week: 770 guests, 10% more than the same week last year (700), compared over 7 days.')).toBeTruthy();
  expect(none.queryByText(/forecast|landed in/i)).toBeNull();
});

// At a glance's This week on native (D43): the same shared tile as on web, the forecast's seven days added up.
test('This week’s forecast adds up the seven days from today, with today beside it', async () => {
  const next = weekDates(TODAY).map((date, index) => forecastDay({ date, low: 90 + index * 10, mid: 110.4 + index * 10, high: 130 + index * 10 }));
  await renderApp('/locations/l1', portal(HISTORY, offline(), published(next, null)));
  const glance = within(await screen.findByLabelText('At a glance'));
  expect(await glance.findByText('This week’s forecast')).toBeTruthy();
  expect(glance.getByText('~980')).toBeTruthy();
  expect(glance.getByText(/^Today: ~110 guests, forecast, 90 to 130\.$/)).toBeTruthy();
  expect(glance.getByText(/^Busiest: Sun, Nov 29, 2026 \(~170 guests, forecast\)\.$/)).toBeTruthy();
  expect(glance.getByText('Mon, Nov 23 to Sun, Nov 29, 2026: the 7 days’ forecasts added up.')).toBeTruthy();
  expect(glance.queryByText('This week, last year')).toBeNull();
});
