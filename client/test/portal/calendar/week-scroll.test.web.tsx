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
// (in the week view's stylesheet), its row free to shrink to the view so a day stays a seventh of it, the view kept
// where the page says (at once on the first layout, smoothly after, at once under reduced motion, and still when days
// are added before the first, in a browser that re-snaps on the insert too), a stop read on scrollend (or, where it is
// missing, once scroll events stop with no finger down) and handed to the page as the day nearest the scroll, each
// column's slice of the chart over its own day and neighbors, the key and scale of the days in view, the selected
// column's mint outline, focus following the selected day, a focus ring inside the column, and at 640px and below an
// aria-hidden strip out of the tab order over the agenda of the 7 days in view. The view is 697px wide, so a day's
// step is 100px. Today is Wed, Nov 11, 2026. Synthetic figures only.

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
  forecast: forecastOf([
    forecastDay({ date: '2026-11-18' }), forecastDay({ date: '2026-11-21' }), forecastDay({ date: '2026-12-01', low: 150, high: 290, outlook: true }),
  ]) as ForecastWindow,
  salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
};

/** Takes `onscrollend` away from the window, as in a browser without the event; returns the undo. */
function withoutScrollEnd(): () => void {
  let owner: object | null = window;
  while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'onscrollend')) owner = Object.getPrototypeOf(owner) as object | null;
  if (owner === null) return () => undefined;
  const from = owner;
  const descriptor = Object.getOwnPropertyDescriptor(from, 'onscrollend');
  Reflect.deleteProperty(from, 'onscrollend');
  return () => { if (descriptor !== undefined) Object.defineProperty(from, 'onscrollend', descriptor); };
}

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
  // The row may shrink to the view, and the scroller's one track is the view's width, so however many days the strip
  // holds, each stays a seventh of the view (a grid item's automatic minimum would otherwise grow the row past the
  // view once the days' minimum widths add up to more than it, and every day with it).
  expect(css).toContain('.tw-cw [data-strip-row]{display:grid;min-width:0;');
  expect(scroller().style.gridTemplateColumns).toBe('minmax(0, 1fr)');
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

test('days added before the first keep the same day in view where the browser re-snaps on the insert, with no scroll back', () => {
  const { rerender } = render(week());
  const element = scroller();
  const scrollTo = jest.fn();
  element.scrollTo = scrollTo;
  // Chrome under mandatory snap keeps the snapped day where it is when days are inserted before it, so scrollLeft has
  // already moved by their width when the page reads it: stand in for that by taking the scroll from the day shown.
  let shown = '2026-11-18';
  const cells = (): string[] => [...element.querySelectorAll('[data-strip-row] > *')].map((cell) => cell.getAttribute('data-date') ?? '');
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    get: () => cells().indexOf(shown) * STEP,
    set: (left: number) => { shown = cells()[Math.round(left / STEP)] ?? shown; },
  });
  fireEvent.scroll(element);
  rerender(week({ strip: { from: '2026-10-14', to: '2026-12-08' } }));
  expect(shown).toBe('2026-11-18');
  expect(element.scrollLeft).toBe(35 * STEP);
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
  const restore = withoutScrollEnd();
  const onSettle = jest.fn();
  render(week({ onSettle }));
  restore();
  scroller().scrollLeft = 960;
  fireEvent.scroll(scroller());
  act(() => { jest.advanceTimersByTime(100); });
  fireEvent.scroll(scroller());
  act(() => { jest.advanceTimersByTime(100); });
  expect(onSettle).not.toHaveBeenCalled();
  act(() => { jest.advanceTimersByTime(20); });
  expect(onSettle).toHaveBeenCalledWith('2026-11-14');
});

test('where scrollend is missing, a pause with a finger still down is not a stop; lifting it is', () => {
  jest.useFakeTimers();
  const restore = withoutScrollEnd();
  const onSettle = jest.fn();
  render(week({ onSettle }));
  restore();
  fireEvent.touchStart(scroller());
  scroller().scrollLeft = 960;
  fireEvent.scroll(scroller());
  act(() => { jest.advanceTimersByTime(500); });
  expect(onSettle).not.toHaveBeenCalled();
  fireEvent.touchEnd(scroller());
  act(() => { jest.advanceTimersByTime(120); });
  expect(onSettle).toHaveBeenCalledWith('2026-11-14');
});

test('where scrollend is sent, a pause in scroll events is never taken for a stop (a held trackpad or finger)', () => {
  jest.useFakeTimers();
  const onSettle = jest.fn();
  render(week({ onSettle }));
  scroller().scrollLeft = 960;
  fireEvent.scroll(scroller());
  act(() => { jest.advanceTimersByTime(1000); });
  expect(onSettle).not.toHaveBeenCalled();
  fireEvent(scroller(), new Event('scrollend'));
  expect(onSettle).toHaveBeenCalledWith('2026-11-14');
});

test('each column draws its own slice of the chart, today shaded and the selected one tinted mint', () => {
  render(week({ chart: true }));
  const slices = scroller().querySelectorAll('[data-chart] svg');
  expect(slices).toHaveLength(35);
  // Saturday's slice is drawn over Friday, Saturday and Sunday alone (its line runs on to its edges), its viewBox
  // showing the middle one: each column draws a constant few days however long the strip grows.
  expect(column('2026-11-21').querySelectorAll('[data-series="forecast-point"]')).toHaveLength(1);
  expect(column('2026-11-21').querySelector('svg')?.getAttribute('viewBox')?.split(' ')[0]).toBe(String(STEP - 3 - 2));
  expect(column('2026-11-21').querySelectorAll('[data-chosen="day"]')).toHaveLength(1);
  expect(column('2026-11-21').querySelector('[data-chosen="day"]')?.getAttribute('fill')).toBe(theme.color.mint);
  expect(column(TODAY).querySelectorAll('[data-shade="today"]')).toHaveLength(1);
  expect(column('2026-11-20').querySelectorAll('[data-chosen="day"], [data-hover="day"], [data-shade]')).toHaveLength(0);
  expect(column('2026-11-21').querySelector('[data-chart]')?.getAttribute('aria-hidden')).toBe('true');
});

test('under the days, the key of what the 7 days in view draw and the scale; an outlook day keys “Outlook range” once in view', () => {
  const { rerender } = render(week({ chart: true }));
  const key = (): HTMLElement => screen.getByTestId('calendar-week-chart-key');
  expect(key().compareDocumentPosition(scroller()) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  expect(key().textContent).toBe('ForecastLikely rangeScale 0 to 500 guests.');
  expect(key().getAttribute('aria-hidden')).toBe('true');
  // Dec 1, an outlook day, comes into view.
  rerender(week({ chart: true, start: '2026-11-26', selected: '2026-11-28' }));
  expect(key().textContent).toBe('ForecastLikely rangeOutlook rangeScale 0 to 500 guests.');
  // No chart, no key.
  rerender(week({ start: '2026-11-26', selected: '2026-11-28' }));
  expect(screen.queryByTestId('calendar-week-chart-key')).toBeNull();
});

test('focus on a column follows the selected day when a stop moves it, so the next key starts from the day in view', () => {
  const onSelect = jest.fn();
  const { rerender } = render(week({ selected: '2026-11-18', onSelect }));
  // Focus elsewhere on the page (a toolbar button) stays where it is.
  const button = document.createElement('button');
  document.body.append(button);
  act(() => { button.focus(); });
  rerender(week({ start: '2026-11-18', selected: '2026-11-19', onSelect }));
  expect(document.activeElement).toBe(button);
  button.remove();
  act(() => { column('2026-11-19').focus(); });
  // A stop moved the view a week on, and the page moved the selected day into it.
  rerender(week({ start: '2026-11-25', selected: '2026-11-25', onSelect }));
  expect(document.activeElement).toBe(column('2026-11-25'));
  fireEvent.keyDown(column('2026-11-25'), { key: 'ArrowRight' });
  expect(onSelect).toHaveBeenCalledWith('2026-11-26', true, null);
});

test('a focused column’s ring is drawn inside it, so the scroller never clips it', () => {
  render(week());
  const css = [...document.querySelectorAll('style')].map((style) => style.textContent).join('\n');
  // Over the shell's `#tw-portal :focus-visible` ring (outline-offset 2px), by its specificity.
  expect(css).toContain('#tw-portal .tw-cw [role="gridcell"]:focus-visible{outline-offset:-4px}');
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
  // Hidden on purpose, so out of the tab order: a browser makes an overflowing scroller a tab stop otherwise.
  expect(scroller().getAttribute('tabindex')).toBe('-1');
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

test('at 640px and below a press on the strip moves focus to the day’s agenda row, never into the hidden strip', () => {
  setWidth(600);
  const onSelect = jest.fn();
  render(week({ chart: true, onSelect }));
  const strip = scroller().querySelector('[data-strip="2026-11-20"]');
  if (strip === null) throw new Error('no strip day');
  // fireEvent answers false when the event's default was prevented: the browser's focus on mousedown.
  expect(fireEvent.mouseDown(strip)).toBe(false);
  fireEvent.click(strip);
  expect(onSelect).toHaveBeenCalledWith('2026-11-20');
  expect(document.activeElement).toBe(column('2026-11-20'));
  expect(scroller().contains(document.activeElement)).toBe(false);
  fireEvent.keyDown(column('2026-11-20'), { key: 'ArrowDown' });
  expect(onSelect).toHaveBeenLastCalledWith('2026-11-21', true, null);
});
