import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DayRecord } from '../../../src/portal/analytics/history';
import { forecastRange, homeCalendarRange, weekDates } from '../../../src/portal/analytics/week';
import type { ForecastDay, LiveAccuracy } from '../../../src/portal/estimates/api';
import { forecastLine } from '../../../src/portal/home/Home';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, offline, orgOf, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, historyBody, note, run } from '../analytics/fakes';
import { forecastDay, NO_FORECAST } from '../calendar/fakes';

// Home's Last week with the published forecast, on web (D42, home-last-week). Today is Mon, Nov 23, 2026, so last week
// is Mon, Nov 16 to Sun, Nov 22, read on its own (GET .../forecast?from=2026-11-16&to=2026-11-22). Pillars: every
// forecast figure is the read's own and only a published run's (never an unpublished guess); the error is the read's
// `accuracy`; a forecast-only row says so and is never summed; with the read failing or nothing published the card and
// its tile are exactly today's. Synthetic days and made-up figures only.

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

// Only Date is faked, so "today" is Mon, Nov 23, 2026 and every timer stays real.
beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 23, 12, 0, 0),
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

const TODAY = '2026-11-23';
const PATH = '/api/org/locations/l1';
const CALENDAR = `${PATH}/calendar?from=${homeCalendarRange(TODAY).from}&to=${homeCalendarRange(TODAY).to}`;
const MONTH = `${PATH}/forecast?from=${forecastRange(TODAY).from}&to=${forecastRange(TODAY).to}`;
const LAST_WEEK = `${PATH}/forecast?from=2026-11-16&to=2026-11-22`;
const WEEK = weekDates('2026-11-16');
// 100 guests a day, and 110 from Nov 16, 2026: last week is 10% up on the same days last year.
const HISTORY = run('2024-09-01', '2026-11-22', (date) => (date >= '2026-11-16' ? 110 : 100));
const UP_TO_FRIDAY = HISTORY.filter((day) => day.date <= '2026-11-20');
const UP_TO_LAST_SUNDAY = HISTORY.filter((day) => day.date <= '2026-11-15');

function published(days: ForecastDay[], accuracy: LiveAccuracy | null): unknown {
  return {
    available: true, reason: null, runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, engine: 'model', madeAt: '2026-11-09', live: null }],
    days, accuracy, weeks: [],
  };
}

const scored = (date: string, inRange = true): ForecastDay => forecastDay({ date, low: 90, mid: 105, high: 120, actual: 110, inRange, scored: true });
/** Nov 16 to 20 scored (WAPE 9.8%, 4 in range), and Sat, Nov 21 and Sun, Nov 22 forecast with no guests stored. */
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
    [`${PATH}/notes`]: { notes: [note({ startDate: '2026-11-25', detail: 'A rehearsal dinner.' })] },
    [CALENDAR]: calendarBody(),
  });
  return fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
}

async function renderHome(api: FakePortalApi): Promise<HTMLElement> {
  const path = '/locations/l1';
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return screen.findByRole('region', { name: 'Last week' });
}

/** A sentence whose key figures are drawn bold: the innermost element whose whole text is `text`. */
function sentence(text: string): (content: string, element: Element | null) => boolean {
  return (_content, element) => element !== null && element.textContent === text
    && Array.from(element.children).every((child) => child.textContent !== text);
}

function glance(): HTMLElement {
  return screen.getByRole('region', { name: 'At a glance' });
}

function rowOf(table: HTMLElement, day: string): string {
  const cell = within(table).getByText(day);
  const row = cell.closest('[role="row"], [role="listitem"]');
  if (row === null) throw new Error(`no row for ${day}`);
  return row.textContent;
}

function openNumbers(card: HTMLElement): HTMLElement {
  fireEvent.click(within(card).getByRole('button', { name: /Show the numbers/ }));
  return within(card).getByRole('region', { name: 'Last week against the same week last year' });
}

test('a mix of scored and forecast-only days: the error, the forecast-only sentence, the last-year sentence, and no total over forecast days', async () => {
  const api = portal(UP_TO_FRIDAY, MIXED);
  const card = await renderHome(api);
  expect(await within(card).findByText(sentence('Townwise’s forecast was off by 10% over 5 days. 4 of 5 days inside the forecast range.'))).toBeTruthy();
  // The percentage and the counts are bold.
  for (const bold of ['10%', '5 days', '4 of 5 days']) expect(within(card).getByText(bold).tagName).not.toBe('DIV');
  expect(within(card).getByText('No guest count uploaded for Sat and Sun yet; this is Townwise’s forecast.')).toBeTruthy();
  expect(within(card).getByText(sentence('Last week: 550 guests on the 5 days both weeks have, 10% more than the same days last year (500).'))).toBeTruthy();
  // The order: the error, then the forecast-only days, then last year.
  const text = card.textContent;
  expect(text.indexOf('off by 10%')).toBeLessThan(text.indexOf('No guest count uploaded'));
  expect(text.indexOf('No guest count uploaded')).toBeLessThan(text.indexOf('Last week: 550'));
  // The upload link stays.
  expect(within(card).getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  // The chart draws Saturday and Sunday in the forecast style, outlined with their range, and keys it Forecast.
  expect(card.querySelectorAll('[data-series="forecast"]')).toHaveLength(2);
  expect(within(card).getByText('Forecast')).toBeTruthy();
  // No sum over the forecast days anywhere on the card: 550 + 210 + 170.
  expect(text).not.toMatch(/\b930\b/);

  const table = openNumbers(card);
  expect(within(table).getByText('Forecast')).toBeTruthy();
  expect(within(table).getByText('In range')).toBeTruthy();
  expect(rowOf(table, 'Sat, Nov 21, 2026')).toContain('Forecast, no guest count uploaded yet: about 210 guests, 180 to 245');
  expect(rowOf(table, 'Sun, Nov 22, 2026')).toContain('Forecast, no guest count uploaded yet: about 170 guests, 150 to 190');
  // Scored rows keep their guests, with the forecast and whether it landed in range beside them.
  const monday = rowOf(table, 'Mon, Nov 16, 2026');
  expect(monday).toContain('110');
  expect(monday).toContain('About 105, 90 to 120');
  expect(monday).toContain('Yes');
  expect(rowOf(table, 'Fri, Nov 20, 2026')).toContain('No');

  // The tile follows the card, with today's words after it.
  expect(within(glance()).getByText(sentence('Off by 10% against the forecast over 5 days.'))).toBeTruthy();
  expect(within(glance()).getByText('Off by 10%')).toBeTruthy();
  expect(within(glance()).getByText(sentence('+10% against the same week last year (500), over the 5 days both weeks have.'))).toBeTruthy();
  // One read of last week, on its own, beside the month's.
  expect(api.calls.filter((call) => call.path.startsWith(`${PATH}/forecast`)).map((call) => call.path).sort()).toEqual([LAST_WEEK, MONTH].sort());
});

test('no uploads since last Sunday: the forecast for these days replaces “Your history ends”, with each day listed and the upload link', async () => {
  const days = WEEK.map((date) => forecastDay({ date, low: 180, mid: 210, high: 245, scored: false }));
  const card = await renderHome(portal(UP_TO_LAST_SUNDAY, published(days, null)));
  expect(await within(card).findByText('No guest count uploaded for these days yet; this is Townwise’s forecast.')).toBeTruthy();
  expect(within(card).queryByText(/Your history ends/)).toBeNull();
  expect(within(card).queryByText(/landed in/)).toBeNull();
  expect(within(card).getByRole('link', { name: 'Upload sales history' })).toBeTruthy();
  expect(card.querySelectorAll('[data-series="forecast"]')).toHaveLength(7);
  const table = openNumbers(card);
  for (const date of ['Mon, Nov 16, 2026', 'Sun, Nov 22, 2026']) {
    expect(rowOf(table, date)).toContain('Forecast, no guest count uploaded yet: about 210 guests, 180 to 245');
  }
  // No weekly total: 7 x 210.
  expect(card.textContent).not.toMatch(/1,470/);
  expect(within(glance()).getByText('No guest count uploaded yet; Last week shows Townwise’s forecast.')).toBeTruthy();
  expect(within(glance()).queryByText(/Your sales stop at/)).toBeNull();
});

test('few scored days: only the in-range count, with no percentage', async () => {
  const card = await renderHome(portal(HISTORY, published([scored('2026-11-16'), scored('2026-11-17', false), scored('2026-11-18')], null)));
  expect(await within(card).findByText(sentence('2 of 3 days inside the forecast range.'))).toBeTruthy();
  expect(within(card).queryByText(/off by/)).toBeNull();
  expect(within(glance()).queryByText(/against the forecast/)).toBeNull();
});

test('the read failing: exactly today’s card and tile, with no forecast words', async () => {
  const api = portal(UP_TO_LAST_SUNDAY, offline());
  const card = await renderHome(api);
  expect(await within(card).findByText('Your history ends Nov 15, 2026. Upload the days since to compare last week.')).toBeTruthy();
  expect(card.textContent).not.toMatch(/forecast/i);
  expect(within(glance()).getByText('Your sales stop at Sun, Nov 15, 2026.')).toBeTruthy();
  // Home never fails with it, and the card has no Try again of its own.
  expect(screen.getByRole('heading', { name: /^Welcome back/ })).toBeTruthy();
  expect(within(card).queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('nothing published: today’s comparison, and the lead’s In progress line unchanged', async () => {
  const card = await renderHome(portal(HISTORY, NO_FORECAST));
  expect(await screen.findByText(forecastLine('Main Street Bar'))).toBeTruthy();
  expect(within(card).getByText(sentence('Last week: 770 guests, 10% more than the same week last year (700), compared over 7 days.'))).toBeTruthy();
  expect(card.textContent).not.toMatch(/forecast|landed in/i);
  expect(card.querySelectorAll('[data-series="forecast"]')).toHaveLength(0);
});

test('no figure from a draft: with a draft covering last week and nothing published, the read answers none and the card shows no forecast figure', async () => {
  // The API reads published runs only (14.4); a draft never reaches the read, so the answer is no_published_forecast.
  const card = await renderHome(portal(UP_TO_LAST_SUNDAY, NO_FORECAST));
  expect(await within(card).findByText('Your history ends Nov 15, 2026. Upload the days since to compare last week.')).toBeTruthy();
  expect(card.textContent).not.toMatch(/About \d|forecast/i);
  // And Home never fills in a day the read doesn't give: only Saturday is published here, so only Saturday shows one.
  cleanup();
  const one = await renderHome(portal(UP_TO_FRIDAY, published([forecastDay({ date: '2026-11-21', low: 180, mid: 210, high: 245, scored: false })], null)));
  expect(await within(one).findByText('No guest count uploaded for Sat, Nov 21 yet; this is Townwise’s forecast.')).toBeTruthy();
  const table = openNumbers(one);
  expect(rowOf(table, 'Sun, Nov 22, 2026')).not.toMatch(/Forecast|About/);
  expect(table.textContent.match(/no guest count uploaded yet/g)).toHaveLength(1);
});

/** The flex basis of the cell a block sits in, in its BlockRow (jsdom computes react-native-web's style rules). */
function basisOf(block: HTMLElement): string {
  const cell = block.parentElement;
  if (cell === null) throw new Error('no cell');
  return getComputedStyle(cell).flexBasis;
}

test('from 1024px, with a published forecast Last week takes a line of its own under This month, for its six columns', async () => {
  // A third of the row (span 4) leaves about 6px of text for a column of flex 1 at 1024px once Forecast and In range
  // join, so the card takes the full width; history only, it stays a third beside This month.
  await renderHome(portal(UP_TO_FRIDAY, MIXED));
  const card = await screen.findByRole('region', { name: 'Last week' });
  await within(card).findByText(sentence('Townwise’s forecast was off by 10% over 5 days. 4 of 5 days inside the forecast range.'));
  const month = screen.getByRole('region', { name: /^This month in / });
  expect(basisOf(screen.getByRole('region', { name: 'Last week' }))).toBe('100%');
  expect(basisOf(month)).toBe('100%');
  // This month, then Last week, in the same row.
  expect(month.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  cleanup();
  const history = await renderHome(portal(HISTORY, NO_FORECAST));
  await within(history).findByText(sentence('Last week: 770 guests, 10% more than the same week last year (700), compared over 7 days.'));
  expect(basisOf(history)).not.toBe('100%');
  expect(basisOf(screen.getByRole('region', { name: /^This month in / }))).not.toBe('100%');
});
