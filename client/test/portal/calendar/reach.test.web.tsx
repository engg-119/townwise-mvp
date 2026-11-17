import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { ForecastDay } from '../../../src/portal/estimates/api';
import { addDays } from '../../../src/portal/locations/dates';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { calendarFake, forecastDay, forecastOf } from './fakes';

// The Calendar's reach with a weekly run (D42, autonomous-forecasts 4.4): a run reaches today plus 91 days, and the
// Calendar, which reads 42-day grids, shows a day that far ahead from the run and says a day past it isn't covered.
// No code change: this pins that the six-week reads already reach it. Today is Wed, Nov 11, 2026, so today plus 91 is
// Wed, Feb 10, 2027. Synthetic figures only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

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
});

// The test boots the whole app cold in a file of one test, which under a full client run (every suite in parallel)
// can take several seconds before the first route renders.
jest.setTimeout(20_000);
/** For a wait that spans the app's first render or the grid's first read. */
const SLOW = { timeout: 5000 };

const TODAY = '2026-11-11';
const LAST = addDays(TODAY, 91);

/** A weekly run's days from today through today plus 91, by month, as the fake reads them. */
function run(): Record<string, unknown> {
  const byMonth: Record<string, ForecastDay[]> = {};
  for (let date = TODAY; date <= LAST; date = addDays(date, 1)) {
    const month = date.slice(0, 7);
    byMonth[month] = [...(byMonth[month] ?? []), forecastDay({ date, low: 150, mid: 175, high: 205 })];
  }
  return Object.fromEntries(Object.entries(byMonth).map(([month, days]) => [month, forecastOf(days)]));
}

/** An element whose whole text is `text`. */
function whole(text: string): (content: string, element: Element | null) => boolean {
  return (_content, element) => element?.textContent === text && [...element.children].every((child) => child.textContent !== text);
}

function cell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`);
  if (found === null) throw new Error(`no cell for ${date}`);
  return found;
}

test('a day 91 days after today shows its forecast, and the day after the run says it isn’t covered', async () => {
  expect(LAST).toBe('2027-02-10');
  const fake = calendarFake({ forecasts: run() });
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = `/locations/l1/calendar?day=${LAST}`;
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  await screen.findByRole('grid', { name: 'February 2027' }, SLOW);
  const panel = (): HTMLElement => screen.getByRole('region', { name: 'Selected day' });
  await waitFor(() => { expect(cell(LAST).getAttribute('aria-label')).toBe('Wed, Feb 10, 2027. Forecast about 175 guests, 150 to 205.'); }, SLOW);
  expect(within(panel()).getByText(whole('About 175 guests'))).toBeTruthy();
  // One read of the grid, of at most 42 days.
  const reads = fake.paths.filter((each) => each.includes('/forecast?'));
  expect(reads).toHaveLength(1);

  fireEvent.click(cell('2027-02-11'));
  await waitFor(() => { expect(within(panel()).getByRole('heading', { name: 'Thu, Feb 11, 2027' })).toBeTruthy(); }, SLOW);
  expect(within(panel()).getByText('The published forecast doesn’t cover this day.')).toBeTruthy();
  expect(within(panel()).queryByText(/^About \d/)).toBeNull();
});
