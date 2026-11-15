import { Dimensions, StyleSheet } from 'react-native';
import { render, screen, within } from '@testing-library/react-native';

import { CalendarGrid } from '../../../src/portal/calendar/CalendarGrid';
import { buildGrid, gridRange } from '../../../src/portal/calendar/grid';
import { ALL_FILTERS, monthBounds, monthLabel, type CalendarInput } from '../../../src/portal/calendar/model';
import { note, townEvent } from '../analytics/fakes';

// The Calendar's month grid on native (P28, spec 16.3), rendered from buildGrid: a Pressable per day, 42 of them, each
// a fixed height by width; the days either side keep their full-date labels; a day outside the 25 months is a disabled
// element with its label; up to three entry lines from 1024px. Today is Wed, Nov 11, 2026. Made-up titles only.

afterEach(() => {
  jest.restoreAllMocks();
});

function widthOf(width: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 2, fontScale: 1 });
}

const TODAY = '2026-11-11';
const BOUNDS = monthBounds(TODAY);

function input(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, covered: gridRange('2026-11', BOUNDS), forecast: null, salesDays: [],
    events: [townEvent({ start: '2026-11-21', title: 'Dartmouth home football' }), townEvent({ start: '2026-12-03', title: 'Tree lighting' })],
    notes: [note({ startDate: '2026-11-21', expectedGuests: 70 })],
    imported: [{ calendarId: 'c1', uid: 'i1', title: 'Wine delivery', startDate: '2026-11-21', endDate: '2026-11-21', startTime: null, endTime: null }],
    filters: ALL_FILTERS,
    ...fields,
  };
}

async function renderGrid(reads: CalendarInput = input(), selected = TODAY, month = '2026-11'): Promise<void> {
  await render(
    <CalendarGrid
      rows={buildGrid(month, reads, BOUNDS)}
      selected={selected}
      month={month}
      bounds={BOUNDS}
      onSelect={() => undefined}
      busy={false}
      label={monthLabel(month)}
      tooltip={() => null}
    />,
  );
}

function heightOf(label: string): unknown {
  const style = StyleSheet.flatten(screen.getByLabelText(label).props.style as never) as Record<string, unknown> | undefined;
  return style?.height;
}

const NOV_21 = 'Sat, Nov 21, 2026. Dartmouth home football. 1 note. From your calendar: Wine delivery.';

test('42 Pressables, each 104px tall at 1280 and 52px at 375', async () => {
  widthOf(1280);
  await renderGrid();
  expect(screen.getAllByRole('button')).toHaveLength(42);
  expect(heightOf(NOV_21)).toBe(104);
  expect(heightOf('Thu, Dec 3, 2026. Tree lighting.')).toBe(104);
  widthOf(375);
  await renderGrid();
  expect(heightOf(NOV_21)).toBe(52);
});

test('an outside day keeps its full-date label and its own entries', async () => {
  widthOf(1280);
  await renderGrid();
  const december = screen.getByLabelText('Thu, Dec 3, 2026. Tree lighting.');
  expect(within(december).getByText('Tree lighting')).toBeTruthy();
  expect(december.props.accessibilityState).toMatchObject({ selected: false });
});

test('a day outside the 25 months is disabled, with a label that says so', async () => {
  widthOf(1280);
  await renderGrid(input({ covered: gridRange('2027-11', BOUNDS) }), '2027-11-30', '2027-11');
  const inert = screen.getByLabelText('Sun, Dec 5, 2027. Outside the months the calendar shows.');
  expect(inert.props.accessibilityState).toMatchObject({ disabled: true });
  expect(within(inert).getByText('5')).toBeTruthy();
});

test('a three-entry day shows its three entry lines at 1280', async () => {
  widthOf(1280);
  await renderGrid();
  const day = screen.getByLabelText(NOV_21);
  for (const entry of ['Dartmouth home football', 'Private event, 70', 'Wine delivery']) expect(within(day).getByText(entry)).toBeTruthy();
  expect(within(day).queryByText(/more$/)).toBeNull();
});
