import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, type FakePortalApi } from '../../helpers/portal';
import { townEvent } from '../analytics/fakes';
import { calendarFake, forecastDay, forecastOf, setToday } from './fakes';

// P28 Calendar's forecast chart and scrolling week on the page (D64): the chart above the month grid, a press on its
// column selecting the day as the grid does (the panel follows) and moving focus to its cell, the “Forecast chart” chip hiding and showing it in both
// views, each week column's slice, and the week's scroll: a stop moves the label to the days in view and the selected
// day into them, a stop that keeps it in view keeps it, and Next week moves on 7 days from wherever the scroll stopped.
// The week's view is 697px wide, so a day's step is 100px. Today is Wed, Nov 11, 2026. Synthetic figures only.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

const width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });
const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('data-scroller') ? 697 : 0; },
  });
});

afterAll(() => {
  if (realClientWidth !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth);
});

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

function setup(): FakePortalApi {
  const days = (from: number, to: number, month: string) => Array.from({ length: to - from + 1 }, (_, at) => forecastDay({ date: `${month}-${String(from + at).padStart(2, '0')}` }));
  const fake = calendarFake({
    events: [townEvent({ start: '2026-11-21', title: 'Dartmouth home football' })],
    days: [{ date: '2026-11-07', guests: 138, netSalesCents: 276000 }, { date: '2025-11-13', guests: 96, netSalesCents: 192000 }],
    forecasts: { '2026-11': forecastOf(days(11, 30, '2026-11')), '2026-12': forecastOf(days(1, 31, '2026-12')) },
  });
  return fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
}

async function renderAt(path: string, name: string): Promise<HTMLElement> {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: setup() });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return screen.findByRole('grid', { name });
}

function day(): string | null {
  return new URLSearchParams(window.location.search).get('day');
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Selected day' });
}

function chip(): HTMLElement {
  return within(screen.getByRole('group', { name: 'Show on the calendar' })).getByRole('button', { name: 'Forecast chart' });
}

function scroller(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-scroller]');
  if (found === null) throw new Error('no scroller');
  return found;
}

/** Once the view is measured, the strip is scrolled to its first day in view, `days` days in. */
async function placedAt(days: number): Promise<void> {
  await waitFor(() => { expect(scroller().scrollLeft).toBe(days * 100); });
}

/** The week's scroll stops `days` days into the strip. */
function stopAt(days: number): void {
  scroller().scrollLeft = days * 100;
  act(() => { fireEvent(scroller(), new Event('scrollend')); });
}

test('the month’s chart sits above the grid, and a press on its column selects the day as the grid does', async () => {
  const grid = await renderAt('/locations/l1/calendar', 'November 2026');
  const chart = await screen.findByTestId('calendar-month-chart');
  expect(chart.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(chart.getAttribute('aria-hidden')).toBe('true');
  // November's 30 days, the forecast drawn from today on and last year's same weekday where stored.
  expect(chart.querySelectorAll('[data-testid^="calendar-month-chart-2026-11-"]')).toHaveLength(30);
  expect(chart.querySelectorAll('svg [data-series="forecast-point"]')).toHaveLength(20);
  expect(chart.querySelectorAll('svg [data-series="last-year-point"]')).toHaveLength(1);
  fireEvent.click(screen.getByTestId('calendar-month-chart-2026-11-21'));
  await waitFor(() => { expect(day()).toBe('2026-11-21'); });
  expect(within(panel()).getByRole('heading', { name: 'Sat, Nov 21, 2026' })).toBeTruthy();
  expect(document.querySelector('[role="grid"] [data-date="2026-11-21"]')?.getAttribute('aria-selected')).toBe('true');
});

test('a press on the month chart’s column moves focus to the day’s grid cell, so the arrow keys go on from it', async () => {
  await renderAt('/locations/l1/calendar', 'November 2026');
  const column = await screen.findByTestId('calendar-month-chart-2026-11-21');
  fireEvent.mouseDown(column);
  fireEvent.click(column);
  const cell = document.querySelector('[role="grid"] [data-date="2026-11-21"]');
  // Never left inside the aria-hidden chart (Chrome blocks aria-hidden on a focused element's ancestor).
  expect(document.activeElement).toBe(cell);
  expect(screen.getByTestId('calendar-month-chart').contains(document.activeElement)).toBe(false);
  await waitFor(() => { expect(day()).toBe('2026-11-21'); });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });
  await waitFor(() => { expect(day()).toBe('2026-11-22'); });
  expect(document.activeElement).toBe(document.querySelector('[role="grid"] [data-date="2026-11-22"]'));
});

test('the Forecast chart chip hides the chart and shows it again, in both views', async () => {
  await renderAt('/locations/l1/calendar?day=2026-11-21', 'November 2026');
  await screen.findByTestId('calendar-month-chart');
  expect(chip().getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(chip());
  expect(screen.queryByTestId('calendar-month-chart')).toBeNull();
  expect(chip().getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(within(screen.getByRole('group', { name: 'Calendar view' })).getByRole('button', { name: 'Week' }));
  await screen.findByRole('grid', { name: 'Nov 18 to 24, 2026' });
  expect(document.querySelector('[data-chart]')).toBeNull();
  fireEvent.click(chip());
  expect(document.querySelector('[role="grid"] [data-date="2026-11-21"] [data-chart] svg')).not.toBeNull();
});

test('a stop that leaves the selected day out of view moves the label and the selected day into the days in view', async () => {
  // The strip from Nov 4 holds Nov 18 to 24 in view, 14 days in.
  await renderAt('/locations/l1/calendar?day=2026-11-19&view=week', 'Nov 18 to 24, 2026');
  await placedAt(14);
  stopAt(17);
  // Nov 21 to 27 are in view: Nov 19 is behind them, so the first of them is selected.
  expect(await screen.findByRole('grid', { name: 'Nov 21 to 27, 2026' })).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-21'); });
  expect(screen.getByText('Nov 21 to 27, 2026')).toBeTruthy();
  expect([...document.querySelectorAll('[data-view]')].map((each) => each.getAttribute('data-date'))[0]).toBe('2026-11-21');
});

test('a stop that keeps the selected day in view keeps it selected', async () => {
  await renderAt('/locations/l1/calendar?day=2026-11-23&view=week', 'Nov 18 to 24, 2026');
  await placedAt(14);
  stopAt(16);
  expect(await screen.findByRole('grid', { name: 'Nov 20 to 26, 2026' })).toBeTruthy();
  expect(day()).toBe('2026-11-23');
});

test('Next week moves on 7 days from wherever the scroll stopped, with the selected day', async () => {
  setToday('2026-11-11');
  await renderAt('/locations/l1/calendar?day=2026-11-18&view=week', 'Nov 18 to 24, 2026');
  await placedAt(14);
  stopAt(15);
  expect(await screen.findByRole('grid', { name: 'Nov 19 to 25, 2026' })).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-19'); });
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(await screen.findByRole('grid', { name: 'Nov 26 to Dec 2, 2026' })).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-26'); });
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  // Today shows today's block again, today first (D40).
  expect(await screen.findByRole('grid', { name: 'Nov 11 to 17, 2026' })).toBeTruthy();
  await waitFor(() => { expect(day()).toBe('2026-11-11'); });
});
