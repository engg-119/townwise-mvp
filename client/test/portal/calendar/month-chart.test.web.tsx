import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { calendarChart } from '../../../src/portal/calendar/chart';
import { gridDays } from '../../../src/portal/calendar/grid';
import { MIN_SLOT, MonthChart, monthSlot } from '../../../src/portal/calendar/MonthChart';
import { ALL_FILTERS, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { forecastDay, forecastOf } from './fakes';

// The month view's forecast chart on web (P28, D64), from calendarChart over November 2026's days: the forecast's
// points and range, an outlook day's dashed range, the status words standing upright, today shaded and the selected
// day lit with a mint mark, a press on a column selecting its day, and the whole chart hidden from screen readers
// with no tab stop. Today is Wed, Nov 11, 2026. Synthetic figures only.

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

function renderChart(selected = '2026-11-21'): jest.Mock {
  const onSelect = jest.fn();
  render(<MonthChart chart={chartOf()} selected={selected} onSelect={onSelect} busy={false} />);
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
  expect(screen.getByTestId('calendar-month-chart-key').textContent).toBe('ForecastLikely rangeOutlook rangeActual guestsSame weekday last year');
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
});

test('today is shaded and its date bold; the selected day is lit with a mint mark', () => {
  renderChart('2026-11-21');
  expect(chart().querySelectorAll('svg [data-shade="today"]')).toHaveLength(1);
  expect(chart().querySelectorAll('svg [data-hover="day"]')).toHaveLength(1);
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

test('pressing a column selects its day', () => {
  const onSelect = renderChart();
  fireEvent.click(screen.getByTestId('calendar-month-chart-2026-11-14'));
  expect(onSelect).toHaveBeenCalledWith('2026-11-14');
});

test('the chart is hidden from screen readers and takes no tab stop', () => {
  renderChart();
  expect(chart().getAttribute('aria-hidden')).toBe('true');
  expect(chart().querySelectorAll('[tabindex="0"]')).toHaveLength(0);
});
