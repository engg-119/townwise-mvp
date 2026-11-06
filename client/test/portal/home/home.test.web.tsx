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
import { ACCESS, EMAIL, fakePortalApi, locationOf, meOf, orgOf, viewAsMe, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake, calendarBody, historyBody, holiday, note, run, townEvent } from '../analytics/fakes';

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

function portal(me: MeResponse, days: readonly DayRecord[] = DAYS, locations?: LocationSummary[]): FakePortalApi {
  const fake = analyticsFake({
    [`${PATH}/sales/history`]: historyBody(days),
    [`${PATH}/notes`]: { notes: [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })] },
    [CALENDAR]: calendarBody({ events: EVENTS }),
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

test('while needsHistory is true the history step shows its upload, and the history card is not drawn', async () => {
  const empty = [locationOf('l1', 'Main Street Bar', { townId: 'hanover-nh', name: 'Hanover', state: 'NH' })];
  await renderAt(portal(meOf(ACCESS.admin), [], empty));
  const step = screen.getByRole('region', { name: 'Add your sales history' });
  expect(within(step).getByRole('link', { name: 'Upload sales history' }).getAttribute('href')).toBe('/locations/l1/sales/upload');
  expect(document.getElementById('home-history')).toBeNull();
  expect(screen.getByText('Sample game')).toBeTruthy();
});
