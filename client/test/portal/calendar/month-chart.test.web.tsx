import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { calendarChart } from '../../../src/portal/calendar/chart';
import { gridDays } from '../../../src/portal/calendar/grid';
import { MIN_SLOT, MonthChart, monthSlot } from '../../../src/portal/calendar/MonthChart';
import { ALL_FILTERS, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { theme } from '../../../src/theme';
import { forecastDay, forecastOf } from './fakes';

// The month view's forecast chart on web (P28, D64), from calendarChart over November 2026's days: the forecast's
// points and range, an outlook day's dashed range, the status words standing upright (none in a month with no
// forecast, which says so once), today shaded and the selected day tinted mint with a mint mark, apart from today's
// shade and from a hovered column, a press on a column selecting its day, and the whole chart hidden from screen
// readers with no tab stop, its scroller included. Today is Wed, Nov 11, 2026. Synthetic figures only.

afterEach(cleanup);

const TODAY = '2026-11-11';
const NOVEMBER = gridDays('2026-11').filter((date) => date.startsWith('2026-11'));

function chartOf() {
  const reads: CalendarInput = {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' },
    forecast: forecastOf([
      forecastDay({ date: '2026-11-12' }),
      forecastDay({ date: '2026-11-13' }),
      forecastDay({ date: '2026-11-14', status: 'closed', low: null, mid: null, high: null }),
      forecastDay({ date: '2026-11-21', low: 150, mid: 212, high: 290, outlook: true }),
    ]) as ForecastWindow,
    salesDays: [{ date: '2026-11-09', guests: 131, netSalesCents: 262_000 }],
    events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  return calendarChart(NOVEMBER, reads, [{ date: '2025-11-13', guests: 96, netSalesCents: 192_000 }]);
}

function renderChart(selected = '2026-11-21', drawn = chartOf()): jest.Mock {
  const onSelect = jest.fn();
  render(<MonthChart chart={drawn} selected={selected} onSelect={onSelect} busy={false} />);
  return onSelect;
}

function chart(): HTMLElement {
  return screen.getByTestId('calendar-month-chart');
}

function series(name: string): Element[] {
  return [...chart().querySelectorAll(`svg [data-series="${name}"]`)];
}

test('a column per day of the month, at least 24px wide', () => {
  renderChart();
  expect(chart().querySelectorAll('[data-testid^="calendar-month-chart-2026-"]')).toHaveLength(30);
  expect(monthSlot(1200, 30)).toBe(40);
  expect(monthSlot(320, 30)).toBe(MIN_SLOT);
});

test('the forecast’s points and range, the outlook day’s range dashed, the stored guests and last year', () => {
  renderChart();
  expect(series('forecast-point')).toHaveLength(3);
  expect(series('range').length).toBeGreaterThan(0);
  expect(series('outlook-range')).toHaveLength(1);
  expect(series('outlook-range')[0]?.getAttribute('stroke-dasharray')).toBe('3 2');
  expect(series('actual')).toHaveLength(1);
  expect(series('last-year-point')).toHaveLength(1);
  expect(screen.getByTestId('calendar-month-chart-key-items').textContent).toBe('ForecastLikely rangeOutlook rangeActual guestsSame weekday last year');
  expect(chart().textContent).toContain('Scale 0 to 500 guests.');
});

test('a day with no point says why, standing upright in its column', () => {
  renderChart();
  const words = series('status').map((word) => word.textContent);
  // The 14th is closed, the days after the read's last are No forecast, and past days with nothing stored No data.
  expect(words).toContain('CLOSED');
  expect(words).toContain('NO FORECAST');
  expect(words).toContain('NO DATA');
  expect(series('status')[0]?.getAttribute('transform')).toMatch(/rotate\(-90\)$/);
  expect(chart().textContent).not.toContain('No forecast for these days.');
});

test('a month with no forecast point draws no words, and says so once under the plot', () => {
  const reads: CalendarInput = {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' }, forecast: forecastOf([]) as ForecastWindow,
    salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  const empty = calendarChart(NOVEMBER, reads, [{ date: '2025-11-13', guests: 96, netSalesCents: 192_000 }]);
  // Every day of it has a status word to give (No data, No forecast), which the grid's cells already say.
  expect(empty.days.every((day) => day.status !== null)).toBe(true);
  expect(empty.drawn.forecast).toBe(false);
  renderChart('2026-11-21', empty);
  expect(series('status')).toHaveLength(0);
  expect(series('last-year-point')).toHaveLength(1);
  expect(chart().textContent).toContain('No forecast for these days.');
});

test('today is shaded and its date bold; the selected day is tinted mint with a mint mark', () => {
  renderChart('2026-11-21');
  expect(chart().querySelectorAll('svg [data-shade="today"]')).toHaveLength(1);
  // The selected column is mint (fill and edges), so it never reads as today's white shade; nothing is hovered.
  const chosen = chart().querySelectorAll('svg [data-chosen="day"]');
  expect(chosen).toHaveLength(1);
  expect(chosen[0]?.getAttribute('fill')).toBe(theme.color.mint);
  expect(chosen[0]?.getAttribute('stroke')).toBe(theme.color.mint);
  expect(chart().querySelector('svg [data-shade="today"]')?.getAttribute('fill')).toBe(theme.color.white);
  expect(chart().querySelectorAll('svg [data-hover="day"]')).toHaveLength(0);
  const today = screen.getByTestId(`calendar-month-chart-${TODAY}`);
  expect(today.textContent).toBe('11');
  // Today's date has its own style (`white`, bold), which no other date has.
  const dateOf = (day: string): string => [...screen.getByTestId(`calendar-month-chart-${day}`).querySelectorAll('div')]
    .find((element) => element.children.length === 0 && element.textContent !== '')?.className ?? '';
  expect(dateOf(TODAY)).not.toBe(dateOf('2026-11-12'));
  expect(dateOf('2026-11-12')).toBe(dateOf('2026-11-13'));
  // The mark under each date: the selected day's alone is drawn.
  const markOf = (day: string): string => screen.getByTestId(`calendar-month-chart-${day}`).lastElementChild?.className ?? '';
  const drawn = NOVEMBER.filter((day) => markOf(day) !== markOf('2026-11-01'));
  expect(drawn).toEqual(['2026-11-21']);
});

test('a pointer over another column lights it white, and the selected column keeps its mint', () => {
  renderChart('2026-11-21');
  fireEvent.mouseOver(screen.getByTestId('calendar-month-chart-2026-11-12'));
  fireEvent.pointerOver(screen.getByTestId('calendar-month-chart-2026-11-12'), { pointerType: 'mouse' });
  fireEvent.mouseEnter(screen.getByTestId('calendar-month-chart-2026-11-12'));
  expect(chart().querySelectorAll('svg [data-hover="day"]')).toHaveLength(1);
  expect(chart().querySelectorAll('svg [data-chosen="day"]')).toHaveLength(1);
  // The hovered box sits at the 12th's column (the 11th index), the chosen one at the 21st's.
  const x = (selector: string): number => Number(/^M([\d.]+)/.exec(chart().querySelector(selector)?.getAttribute('d') ?? '')?.[1]);
  expect(x('svg [data-hover="day"]')).toBeLessThan(x('svg [data-chosen="day"]'));
});

test('pressing a column selects its day, and its mousedown never moves focus into the hidden chart', () => {
  const onSelect = renderChart();
  // fireEvent answers false when the event's default was prevented: the browser's focus on mousedown.
  expect(fireEvent.mouseDown(screen.getByTestId('calendar-month-chart-2026-11-14'))).toBe(false);
  fireEvent.click(screen.getByTestId('calendar-month-chart-2026-11-14'));
  expect(onSelect).toHaveBeenCalledWith('2026-11-14');
});

test('a column with a status word draws no same weekday last year, so the faint line never runs through the word', () => {
  const reads = (lastYear: string[]) => calendarChart(NOVEMBER, {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' },
    forecast: forecastOf([
      forecastDay({ date: '2026-11-12' }),
      forecastDay({ date: '2026-11-13' }),
      forecastDay({ date: '2026-11-14', status: 'closed', low: null, mid: null, high: null }),
    ]) as ForecastWindow,
    salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  }, lastYear.map((date) => ({ date, guests: 96, netSalesCents: 192_000 })));
  // The same weekdays last year of Nov 12, 13 and 14 (closed, its word upright in its column).
  renderChart('2026-11-21', reads(['2025-11-13', '2025-11-14', '2025-11-15']));
  expect(series('status').map((word) => word.textContent)).toContain('CLOSED');
  expect(series('last-year-point')).toHaveLength(2);
  // The line runs from the 12th to the 13th and stops there: two points, so it never reaches the 14th's column.
  expect(series('last-year')[0]?.getAttribute('d')?.match(/[ML]/g)).toEqual(['M', 'L']);
  expect(screen.getByTestId('calendar-month-chart-key-items').textContent).toContain('Same weekday last year');
  cleanup();
  // Last year only on the closed day: nothing is drawn, so the key leaves it out.
  renderChart('2026-11-21', reads(['2025-11-15']));
  expect(series('last-year-point')).toHaveLength(0);
  expect(series('last-year')).toHaveLength(0);
  expect(screen.getByTestId('calendar-month-chart-key-items').textContent).not.toContain('Same weekday last year');
});

test('the chart is hidden from screen readers and takes no tab stop', () => {
  renderChart();
  expect(chart().getAttribute('aria-hidden')).toBe('true');
  expect(chart().querySelectorAll('[tabindex="0"]')).toHaveLength(0);
  // Its scroller too: a browser makes an overflowing scroller a tab stop unless it says otherwise.
  expect(screen.getByTestId('calendar-month-chart-scroller').getAttribute('tabindex')).toBe('-1');
});

test('backtest days (D72) draw apart from the forecast, dotted and text2, the key names them, and the month says no “No forecast”', () => {
  const backtest = (date: string) => ({
    date, engine: 'model', dataThrough: '2026-06-30', low: 100, mid: 125, high: 150, runId: 'r0', actual: null, inRange: null,
  });
  const window = forecastOf([forecastDay({ date: '2026-11-12' }), forecastDay({ date: '2026-11-13' })]) as ForecastWindow;
  const reads: CalendarInput = {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' }, backtest: true,
    forecast: { ...window, backtest: [backtest('2026-11-02'), backtest('2026-11-03'), backtest('2026-11-04')] },
    salesDays: [{ date: '2026-11-03', guests: 131, netSalesCents: 262_000 }], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  renderChart('2026-11-03', calendarChart(NOVEMBER, reads, null));
  expect(series('backtest-point')).toHaveLength(3);
  expect(series('backtest-point')[0]?.getAttribute('stroke')).toBe(theme.color.text2);
  expect(series('forecast-point')).toHaveLength(2);
  // Each has its own line, never joined: the backtest's dotted, the forecast's dashed.
  expect(series('backtest')).toHaveLength(1);
  expect(series('backtest')[0]?.getAttribute('stroke-dasharray')).toBe('1 3');
  expect(series('backtest')[0]?.getAttribute('d')?.match(/[ML]/g)).toEqual(['M', 'L', 'L']);
  expect(series('forecast')[0]?.getAttribute('stroke-dasharray')).toBe('4 3');
  expect(series('backtest-range')).toHaveLength(1);
  expect(series('backtest-range')[0]?.getAttribute('stroke-dasharray')).toBe('1 2');
  expect(screen.getByTestId('calendar-month-chart-key-items').textContent).toBe('ForecastLikely rangeBacktestBacktest rangeActual guests');
  expect(chart().textContent).not.toContain('No forecast for these days.');
  cleanup();
  // Backtest days alone still draw, with no “No forecast for these days.”
  renderChart('2026-11-03', calendarChart(NOVEMBER, { ...reads, forecast: { ...forecastOf([]) as ForecastWindow, backtest: [backtest('2026-11-02')] } }, null));
  expect(series('backtest-point')).toHaveLength(1);
  expect(screen.getByTestId('calendar-month-chart-key-items').textContent).toContain('Backtest');
  expect(chart().textContent).not.toContain('No forecast for these days.');
});
