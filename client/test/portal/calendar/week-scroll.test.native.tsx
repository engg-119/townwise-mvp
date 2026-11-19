import { AccessibilityInfo, ScrollView, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

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
// the state fill; where the strip scrolls to (at once on its first layout, a far jump or under Reduce Motion, animated
// otherwise, and days added before the first keeping what is on screen); and the key under the strip. The view is 697
// wide, so a day's step is 100. Today is Wed, Nov 11, 2026. Synthetic figures only.

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

/** The strip's props with a new first day in view (and strip), as the page hands them after a stop or Next week. */
function strip(start: string, dates: readonly string[] = DATES): React.JSX.Element {
  return (
    <CalendarWeek
      days={buildDays(dates, READS, BOUNDS)}
      selected={start}
      weekStart={start}
      bounds={BOUNDS}
      onSelect={jest.fn()}
      busy={false}
      label={weekLabel(start)}
      tooltip={() => null}
      chart={calendarChart(dates, READS, null)}
      onSettle={jest.fn()}
    />
  );
}

/** The system's Reduce Motion answer, before the strip renders. */
function reduceMotion(on: boolean): void {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(on);
}

/** Every scrollTo the strip sent (the ScrollView mock's one shared jest.fn). */
function scrolls(): unknown[] {
  return (ScrollView.prototype as unknown as { scrollTo: jest.Mock<unknown, [unknown]> }).scrollTo.mock.calls.map((call) => call[0]);
}

async function layOut(): Promise<void> {
  const found = screen.getByTestId('calendar-strip', { includeHiddenElements: true });
  await fireEvent(found.parent ?? found, 'layout', { nativeEvent: { layout: { width: 697, height: 120, x: 0, y: 0 } } });
}

describe('where the strip scrolls to', () => {
  beforeEach(() => { (ScrollView.prototype as unknown as { scrollTo: jest.Mock }).scrollTo.mockClear(); });
  afterEach(() => { jest.restoreAllMocks(); });

  test('at once on its first layout; animated to a new first day in view; at once for a jump of more than 3 weeks', async () => {
    reduceMotion(false);
    const view = await render(strip('2026-11-18'));
    await act(async () => { await Promise.resolve(); });
    await layOut();
    expect(scrolls().at(-1)).toEqual({ x: 1400, animated: false });
    await view.rerender(strip('2026-11-25'));
    expect(scrolls().at(-1)).toEqual({ x: 2100, animated: true });
    // A fresh strip from Feb 2027, its view 14 days in: far away, so at once.
    const far = stripDates({ from: '2027-01-27', to: '2027-03-02' });
    await view.rerender(strip('2027-02-10', far));
    expect(scrolls().at(-1)).toEqual({ x: 1400, animated: false });
  });

  test('under Reduce Motion, at once', async () => {
    reduceMotion(true);
    const view = await render(strip('2026-11-18'));
    await act(async () => { await Promise.resolve(); });
    await layOut();
    await view.rerender(strip('2026-11-25'));
    expect(scrolls().at(-1)).toEqual({ x: 2100, animated: false });
  });

  test('days added before the first keep what is on screen (maintainVisibleContentPosition), and the strip stays on its day', async () => {
    reduceMotion(false);
    const view = await render(strip('2026-11-18'));
    await act(async () => { await Promise.resolve(); });
    await layOut();
    const found = screen.getByTestId('calendar-strip', { includeHiddenElements: true });
    expect(found.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    // A stop on Nov 18 near the start grows the strip 3 weeks before it: Nov 18 is now 35 days in.
    await view.rerender(strip('2026-11-18', stripDates({ from: '2026-10-14', to: '2026-12-08' })));
    expect(scrolls().at(-1)).toMatchObject({ x: 3500 });
  });
});

test('under the strip, the key of what the 7 days in view draw and the scale', async () => {
  await renderStrip();
  const key = screen.getByTestId('calendar-week-chart-key', { includeHiddenElements: true });
  expect(screen.queryByTestId('calendar-week-chart-key')).toBeNull();
  expect(within(key).getByText('Forecast', { includeHiddenElements: true })).toBeTruthy();
  expect(within(key).getByText('Scale 0 to 250 guests.', { includeHiddenElements: true })).toBeTruthy();
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
