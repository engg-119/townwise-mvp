import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CalendarGrid } from '../../../src/portal/calendar/CalendarGrid.web';
import type { CalendarCell } from '../../../src/portal/calendar/model';

// The Calendar's tooltip follows the pointer: over a day it shows, over anything that is not a day (a gap, the
// weekday row, an empty leading cell) it goes, and leaving the grid hides it.

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { cleanup(); jest.useRealTimers(); });

/** Lets the frame the clear waits for run. */
function frame(): void { act(() => { jest.runOnlyPendingTimers(); }); }

function cell(date: string): CalendarCell {
  return {
    date, isToday: false, inWeek: false, status: null, figure: null, noteGuests: 0, chips: [], more: 0,
    marks: { event: false, note: false, imported: false }, label: `Day ${date}`,
  };
}

function setup(): void {
  render(
    <CalendarGrid
      rows={[[null, cell('2026-11-03'), cell('2026-11-04'), null, null, null, null]]}
      selected="2026-11-03"
      onSelect={() => undefined}
      busy={false}
      label="November 2026"
      tooltip={(date) => ({ date, lines: [`Tip for ${date}`] })}
    />,
  );
}

test('the tooltip goes when the pointer moves onto the weekday row or an empty cell', () => {
  setup();
  const day = screen.getByRole('gridcell', { name: 'Day 2026-11-03' });
  fireEvent.pointerOver(day, { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-03')).not.toBeNull();
  fireEvent.pointerOver(screen.getByRole('columnheader', { name: 'Monday' }), { pointerType: 'mouse' });
  frame();
  expect(screen.queryByText('Tip for 2026-11-03')).toBeNull();
  fireEvent.pointerOver(day, { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-03')).not.toBeNull();
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  frame();
  expect(screen.queryByText('Tip for 2026-11-03')).toBeNull();
});

test('the tooltip goes over an empty leading cell and over a row', () => {
  const { container } = render(
    <CalendarGrid
      rows={[[null, cell('2026-11-03'), cell('2026-11-04'), null, null, null, null]]}
      selected="2026-11-03"
      onSelect={() => undefined}
      busy={false}
      label="November 2026"
      tooltip={(date) => ({ date, lines: [`Tip for ${date}`] })}
    />,
  );
  const day = screen.getByRole('gridcell', { name: 'Day 2026-11-03' });
  const empty = container.querySelector('[role=gridcell]:not([data-date])');
  if (empty === null) throw new Error('no empty cell');
  fireEvent.pointerOver(day, { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-03')).not.toBeNull();
  fireEvent.pointerOver(empty, { pointerType: 'mouse' });
  frame();
  expect(screen.queryByText('Tip for 2026-11-03')).toBeNull();
  fireEvent.pointerOver(day, { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getAllByRole('row')[1] as Element, { pointerType: 'mouse' });
  frame();
  expect(screen.queryByText('Tip for 2026-11-03')).toBeNull();
});

test('leaving the grid hides the tooltip', () => {
  setup();
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-04' }), { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-04')).not.toBeNull();
  fireEvent.pointerLeave(screen.getByRole('grid'), { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-04')).toBeNull();
});

test('crossing the gap into the next day never removes the tooltip; resting on the gap clears it after the frame', () => {
  setup();
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }), { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-03')).not.toBeNull();
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-04' }), { pointerType: 'mouse' });
  frame();
  expect(screen.queryByText('Tip for 2026-11-03')).toBeNull();
  expect(screen.queryByText('Tip for 2026-11-04')).not.toBeNull();
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-04')).not.toBeNull();
  frame();
  expect(screen.queryByText('Tip for 2026-11-04')).toBeNull();
});

test('leaving the grid clears at once, and unmounting cancels a pending clear', () => {
  setup();
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }), { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  fireEvent.pointerLeave(screen.getByRole('grid'), { pointerType: 'mouse' });
  expect(screen.queryByText('Tip for 2026-11-03')).toBeNull();
  cleanup();
  setup();
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }), { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  expect(jest.getTimerCount()).toBeGreaterThan(0);
  cleanup();
  expect(jest.getTimerCount()).toBe(0);
});
