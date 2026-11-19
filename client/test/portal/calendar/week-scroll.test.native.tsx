import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { CalendarWeek } from '../../../src/portal/calendar/CalendarWeek';
import { calendarChart } from '../../../src/portal/calendar/chart';
import { buildDays, gridRange, weekLabel } from '../../../src/portal/calendar/grid';
import { ALL_FILTERS, monthBounds, type CalendarInput } from '../../../src/portal/calendar/model';
import { snapOffsets, stripDates } from '../../../src/portal/calendar/strip';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { theme } from '../../../src/theme';
import { forecastDay, forecastOf } from './fakes';

// The week view's scroll on native (P28, D64): a horizontal strip of the strip's days that snaps to each day's left
// edge, hidden from screen readers, each day its chart slice and short head, a tap selecting it; a stop hands the page
// the day nearest the scroll; under it the agenda of the 7 days in view, the selected row with a 2px mint border over
// the state fill. The view is 697 wide, so a day's step is 100. Today is Wed, Nov 11, 2026. Synthetic figures only.

const TODAY = '2026-11-11';
const BOUNDS = monthBounds(TODAY);
const DATES = stripDates({ from: '2026-11-04', to: '2026-12-08' });
const READS: CalendarInput = {
  today: TODAY, covered: gridRange('2026-11', BOUNDS),
  forecast: forecastOf([forecastDay({ date: '2026-11-21' })]) as ForecastWindow,
  salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
};

async function renderStrip(onSettle = jest.fn(), onSelect = jest.fn()): Promise<{ onSettle: jest.Mock; onSelect: jest.Mock }> {
  await render(
    <CalendarWeek
      days={buildDays(DATES, READS, BOUNDS)}
      selected="2026-11-21"
      weekStart="2026-11-18"
      bounds={BOUNDS}
      onSelect={onSelect}
      busy={false}
      label={weekLabel('2026-11-18')}
      tooltip={() => null}
      chart={calendarChart(DATES, READS, null)}
      onSettle={onSettle}
    />,
  );
  const strip = screen.getByTestId('calendar-strip', { includeHiddenElements: true });
  await fireEvent(strip.parent ?? strip, 'layout', { nativeEvent: { layout: { width: 697, height: 120, x: 0, y: 0 } } });
  return { onSettle, onSelect };
}

function styleOf(element: { props: { style?: unknown } }): Record<string, unknown> {
  return (StyleSheet.flatten(element.props.style as never) as Record<string, unknown> | undefined) ?? {};
}

test('the strip snaps to each day’s left edge and is hidden from screen readers', async () => {
  await renderStrip();
  expect(screen.queryByTestId('calendar-strip')).toBeNull();
  const strip = screen.getByTestId('calendar-strip', { includeHiddenElements: true });
  expect(strip.props.snapToOffsets).toEqual(snapOffsets(100, 35));
  expect(strip.props.decelerationRate).toBe('fast');
  expect(strip.props.horizontal).toBe(true);
});

test('a stop hands the page the day nearest the scroll', async () => {
  const { onSettle } = await renderStrip();
  const strip = screen.getByTestId('calendar-strip', { includeHiddenElements: true });
  await fireEvent(strip, 'momentumScrollEnd', { nativeEvent: { contentOffset: { x: 1730, y: 0 } } });
  expect(onSettle).toHaveBeenCalledWith('2026-11-21');
  onSettle.mockClear();
  // A drag that stops with no momentum is a stop too.
  await fireEvent(strip, 'scrollEndDrag', { nativeEvent: { contentOffset: { x: 960, y: 0 }, velocity: { x: 0, y: 0 } } });
  expect(onSettle).toHaveBeenCalledWith('2026-11-14');
});

test('a tap on a day of the strip selects it', async () => {
  const { onSelect } = await renderStrip();
  await fireEvent.press(screen.getByTestId('calendar-strip-2026-11-26', { includeHiddenElements: true }));
  expect(onSelect).toHaveBeenCalledWith('2026-11-26');
});

test('the agenda lists the 7 days in view, the selected one with a 2px mint border over the state fill', async () => {
  await renderStrip();
  const rows = screen.getAllByRole('button');
  expect(rows).toHaveLength(7);
  expect(rows[0]?.props.accessibilityLabel).toMatch(/^Wed, Nov 18, 2026\./);
  const saturday = screen.getByLabelText(/^Sat, Nov 21, 2026\./);
  expect(saturday.props.accessibilityState).toMatchObject({ selected: true });
  expect(styleOf(saturday)).toMatchObject({ borderColor: theme.color.mint, borderWidth: 2, backgroundColor: theme.color.state });
});
