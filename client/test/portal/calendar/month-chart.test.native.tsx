import { AccessibilityInfo, ScrollView } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

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

describe('a month wider than the box is brought to the selected day', () => {
  const NOVEMBER = Array.from({ length: 30 }, (_, at) => `2026-11-${String(at + 1).padStart(2, '0')}`);
  const reads: CalendarInput = {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' }, forecast: forecastOf([forecastDay({ date: '2026-11-21' })]) as ForecastWindow,
    salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  const scrollTo = (): jest.Mock<unknown, [unknown]> => (ScrollView.prototype as unknown as { scrollTo: jest.Mock<unknown, [unknown]> }).scrollTo;

  beforeEach(() => { scrollTo().mockClear(); });
  afterEach(() => { jest.restoreAllMocks(); });

  test.each([false, true])('animated, or at once under Reduce Motion (reduce motion %s)', async (reduced) => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced);
    await render(<MonthChart chart={calendarChart(NOVEMBER, reads, null)} selected="2026-11-21" onSelect={jest.fn()} busy={false} />);
    await act(async () => { await Promise.resolve(); });
    const scroller = screen.getByTestId('calendar-month-chart-scroller', { includeHiddenElements: true });
    await fireEvent(scroller.parent ?? scroller, 'layout', { nativeEvent: { layout: { width: 320, height: 160, x: 0, y: 0 } } });
    // 30 days at the 24px least are 720px in a 320px box: the 21st's column (20.5 columns in) in the middle.
    expect(scrollTo().mock.calls.at(-1)?.[0]).toEqual({ x: 20.5 * 24 - 160, animated: !reduced });
  });

  test('a month that fits scrolls nowhere', async () => {
    await render(<MonthChart chart={calendarChart(NOVEMBER, reads, null)} selected="2026-11-21" onSelect={jest.fn()} busy={false} />);
    const scroller = screen.getByTestId('calendar-month-chart-scroller', { includeHiddenElements: true });
    await fireEvent(scroller.parent ?? scroller, 'layout', { nativeEvent: { layout: { width: 1200, height: 160, x: 0, y: 0 } } });
    scrollTo().mockClear();
    await fireEvent(scroller.parent ?? scroller, 'layout', { nativeEvent: { layout: { width: 1100, height: 160, x: 0, y: 0 } } });
    expect(scrollTo()).not.toHaveBeenCalled();
  });
});
