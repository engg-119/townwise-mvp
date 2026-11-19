import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { CalendarWeek } from '../../../src/portal/calendar/CalendarWeek.web';
import { calendarChart } from '../../../src/portal/calendar/chart';
import { buildDays, gridRange, weekLabel } from '../../../src/portal/calendar/grid';
import { ALL_FILTERS, monthBounds, type CalendarInput } from '../../../src/portal/calendar/model';
import { stripDates } from '../../../src/portal/calendar/strip';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { theme } from '../../../src/theme';
import { forecastDay, forecastOf } from './fakes';

// The week view's scroll on web (P28, D64): the strip's days in one scroll container that snaps to a day's left edge
// (in the week view's stylesheet), the view kept where the page says (at once on the first layout, smoothly after, at
// once under reduced motion, and still when days are added before the first), a stop read on scrollend or once scroll
// events stop and handed to the page as the day nearest the scroll, each column's slice of the chart, the selected
// column's mint outline, and at 640px and below an aria-hidden strip over the agenda of the 7 days in view. The view is
// 697px wide, so a day's step is 100px. Today is Wed, Nov 11, 2026. Synthetic figures only.

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });
const VIEW = 697;
const STEP = 100;
const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('data-scroller') ? VIEW : 0; },
  });
});

afterAll(() => {
  if (realClientWidth !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth);
});

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  if (width !== 1280) setWidth(1280);
  Reflect.deleteProperty(window, 'matchMedia');
});

const TODAY = '2026-11-11';
const BOUNDS = monthBounds(TODAY);
const STRIP = { from: '2026-11-04', to: '2026-12-08' };

const READS: CalendarInput = {
  today: TODAY, covered: gridRange('2026-11', BOUNDS),
  forecast: forecastOf([forecastDay({ date: '2026-11-18' }), forecastDay({ date: '2026-11-21' })]) as ForecastWindow,
  salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
};

interface Options { start?: string; strip?: { from: string; to: string }; selected?: string; onSettle?: jest.Mock; onSelect?: jest.Mock; chart?: boolean }

function week(options: Options = {}): React.JSX.Element {
  const dates = stripDates(options.strip ?? STRIP);
  const start = options.start ?? '2026-11-18';
  return (
    <CalendarWeek
      days={buildDays(dates, READS, BOUNDS)}
      selected={options.selected ?? '2026-11-21'}
      weekStart={start}
      bounds={BOUNDS}
      onSelect={options.onSelect ?? jest.fn()}
      busy={false}
      label={weekLabel(start)}
      tooltip={() => null}
      chart={options.chart === true ? calendarChart(dates, READS, null) : null}
      onSettle={options.onSettle ?? jest.fn()}
    />
  );
}

function scroller(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-scroller]');
  if (found === null) throw new Error('no scroller');
  return found;
}

function column(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`);
  if (found === null) throw new Error(`no column for ${date}`);
  return found;
}

function reducedMotion(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined,
    }),
  });
}

test('the scroller snaps to each day’s left edge, a seventh of the view per day', () => {
  render(week());
  const css = [...document.querySelectorAll('style')].map((style) => style.textContent).join('\n');
  expect(css).toContain('.tw-cw [data-scroller]{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;');
  expect(css).toContain('grid-auto-columns:calc((100% - 18px) / 7)');
  expect(css).toContain('.tw-cw [data-strip-row]>*{scroll-snap-align:start}');
  // From 641px the scroller is the grid, every day of the strip a column in its one row; the 7 in view are marked.
  expect(scroller().getAttribute('role')).toBe('grid');
  expect(scroller().querySelectorAll('[role="gridcell"]')).toHaveLength(35);
  expect([...scroller().querySelectorAll('[data-view]')].map((each) => each.getAttribute('data-date'))).toEqual(stripDates({ from: '2026-11-18', to: '2026-11-24' }));
});

test('it opens on the first day in view at once', () => {
  render(week());
  expect(scroller().scrollLeft).toBe(14 * STEP);
});

test('a new first day in view scrolls there smoothly; under reduced motion at once', () => {
  const { rerender } = render(week());
  const scrollTo = jest.fn();
  scroller().scrollTo = scrollTo;
  rerender(week({ start: '2026-11-25', selected: '2026-11-28' }));
  expect(scrollTo).toHaveBeenCalledWith({ left: 21 * STEP, behavior: 'smooth' });
  cleanup();
  reducedMotion();
  const again = render(week());
  scroller().scrollTo = scrollTo;
  scrollTo.mockClear();
  again.rerender(week({ start: '2026-11-25', selected: '2026-11-28' }));
  expect(scrollTo).not.toHaveBeenCalled();
  expect(scroller().scrollLeft).toBe(21 * STEP);
});

test('days added before the first move the scroll by their width, so nothing on screen moves', () => {
  const { rerender } = render(week());
  const scrollTo = jest.fn();
  scroller().scrollTo = scrollTo;
  rerender(week({ strip: { from: '2026-10-14', to: '2026-12-08' } }));
  expect(scroller().scrollLeft).toBe(35 * STEP);
  expect(scrollTo).not.toHaveBeenCalled();
});

test('a stop on scrollend hands the page the day nearest the scroll', () => {
  const onSettle = jest.fn();
  render(week({ onSettle }));
  // 17.3 days in: Nov 4 plus 17 is Nov 21.
  scroller().scrollLeft = 1730;
  fireEvent(scroller(), new Event('scrollend'));
  expect(onSettle).toHaveBeenCalledWith('2026-11-21');
  // A stop on the day already first in view hands nothing.
  onSettle.mockClear();
  scroller().scrollLeft = 1400;
  fireEvent(scroller(), new Event('scrollend'));
  expect(onSettle).not.toHaveBeenCalled();
});

test('where scrollend is missing, a stop is read 120ms after the last scroll event', () => {
  jest.useFakeTimers();
  const onSettle = jest.fn();
  render(week({ onSettle }));
  scroller().scrollLeft = 960;
  fireEvent.scroll(scroller());
  act(() => { jest.advanceTimersByTime(100); });
  fireEvent.scroll(scroller());
  act(() => { jest.advanceTimersByTime(100); });
  expect(onSettle).not.toHaveBeenCalled();
  act(() => { jest.advanceTimersByTime(20); });
  expect(onSettle).toHaveBeenCalledWith('2026-11-14');
});

test('each column draws its own slice of the chart, today shaded and the selected one lit', () => {
  render(week({ chart: true }));
  const slices = scroller().querySelectorAll('[data-chart] svg');
  expect(slices).toHaveLength(35);
  // Saturday's slice holds its own point, and its viewBox shows its own column.
  expect(column('2026-11-21').querySelectorAll('[data-series="forecast-point"]')).toHaveLength(1);
  expect(column('2026-11-21').querySelector('svg')?.getAttribute('viewBox')?.split(' ')[0]).toBe(String(17 * (STEP - 3 - 2)));
  expect(column('2026-11-21').querySelectorAll('[data-hover="day"]')).toHaveLength(1);
  expect(column(TODAY).querySelectorAll('[data-shade="today"]')).toHaveLength(1);
  expect(column('2026-11-20').querySelectorAll('[data-hover="day"], [data-shade]')).toHaveLength(0);
  expect(column('2026-11-21').querySelector('[data-chart]')?.getAttribute('aria-hidden')).toBe('true');
});

test('the selected column has a 2px mint outline over the state fill; the others do not', () => {
  render(week());
  expect(column('2026-11-21').style.backgroundColor).toBe(theme.color.state);
  expect(column('2026-11-21').style.boxShadow).toBe(`inset 0 0 0 1px ${theme.color.mint}`);
  expect(column('2026-11-21').style.borderColor).toBe(theme.color.mint);
  expect(column('2026-11-20').style.backgroundColor).toBe(theme.color.raised);
  expect(column('2026-11-20').style.boxShadow).toBe('');
});

test('at 640px and below the strip is aria-hidden over the agenda of the 7 days in view, and a press on the strip selects', () => {
  setWidth(600);
  const onSelect = jest.fn();
  render(week({ chart: true, onSelect }));
  expect(scroller().getAttribute('aria-hidden')).toBe('true');
  expect(scroller().querySelectorAll('[data-strip]')).toHaveLength(35);
  const grid = screen.getByRole('grid', { name: 'Nov 18 to 24, 2026' });
  expect(within(grid).getAllByRole('row').map((row) => row.querySelector('[data-date]')?.getAttribute('data-date'))).toEqual(
    stripDates({ from: '2026-11-18', to: '2026-11-24' }),
  );
  const strip = scroller().querySelector('[data-strip="2026-11-26"]');
  if (strip === null) throw new Error('no strip day');
  fireEvent.click(strip);
  expect(onSelect).toHaveBeenCalledWith('2026-11-26');
});
