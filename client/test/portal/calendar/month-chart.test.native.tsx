import { fireEvent, render, screen } from '@testing-library/react-native';

import { calendarChart } from '../../../src/portal/calendar/chart';
import { MonthChart } from '../../../src/portal/calendar/MonthChart';
import { ALL_FILTERS, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { forecastDay, forecastOf } from './fakes';

// The month view's forecast chart on native (P28, D64): drawn with react-native-svg as on web, hidden from screen
// readers (the grid's cells say each day), and a tap on a column selects its day. Synthetic figures only.

const TODAY = '2026-11-11';
const DAYS = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];

function chartOf() {
  const reads: CalendarInput = {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' },
    forecast: forecastOf([forecastDay({ date: '2026-11-12' }), forecastDay({ date: '2026-11-13', status: 'closed', low: null, mid: null, high: null })]) as ForecastWindow,
    salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  return calendarChart(DAYS, reads, null);
}

test('the chart is hidden from screen readers, and a tap on a column selects its day', async () => {
  const onSelect = jest.fn();
  await render(<MonthChart chart={chartOf()} selected="2026-11-12" onSelect={onSelect} busy={false} />);
  expect(screen.queryByTestId('calendar-month-chart')).toBeNull();
  expect(screen.getByTestId('calendar-month-chart', { includeHiddenElements: true })).toBeTruthy();
  await fireEvent.press(screen.getByTestId('calendar-month-chart-2026-11-13', { includeHiddenElements: true }));
  expect(onSelect).toHaveBeenCalledWith('2026-11-13');
  expect(screen.getByText('Scale 0 to 250 guests.', { includeHiddenElements: true })).toBeTruthy();
});
