import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { MonthGrid } from '../../../src/portal/home/MonthGrid.web';
import type { MonthCell } from '../../../src/portal/analytics/week';

// Home's month grid: a pointer over no day (a gap, the weekday row, an empty cell) clears the tooltip and restores the
// selection exactly as leaving the grid does.

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { cleanup(); jest.useRealTimers(); });

/** Lets the frame the clear waits for run. */
function frame(): void { act(() => { jest.runOnlyPendingTimers(); }); }

function cell(date: string): MonthCell {
  return {
    date, isToday: false, inWeek: false, status: null, figure: null, figureText: null, caption: null, noteGuests: 0, chips: [], more: 0,
    marks: { event: false, note: false, imported: false }, label: `Day ${date}`,
  };
}

function setup(onPreview: (date: string | null) => void): void {
  render(
    <MonthGrid
      rows={[[null, cell('2026-11-03'), cell('2026-11-04'), null, null, null, null]]}
      selected="2026-11-03"
      onSelect={() => undefined}
      onPreview={onPreview}
      onOpen={() => undefined}
      tooltip={(date) => ({ date, lines: [`Tip for ${date}`] })}
      label="November 2026"
    />,
  );
}

test('the tooltip and the preview go when the pointer moves onto the weekday row', () => {
  const onPreview = jest.fn();
  setup(onPreview);
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-04' }), { pointerType: 'mouse' });
  expect(onPreview).toHaveBeenLastCalledWith('2026-11-04');
  expect(screen.queryByText('Tip for 2026-11-04')).not.toBeNull();
  fireEvent.pointerOver(screen.getByRole('columnheader', { name: 'Monday' }), { pointerType: 'mouse' });
  frame();
  expect(onPreview).toHaveBeenLastCalledWith(null);
  expect(screen.queryByText('Tip for 2026-11-04')).toBeNull();
  // Back over the same day previews it again.
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-04' }), { pointerType: 'mouse' });
  expect(onPreview).toHaveBeenLastCalledWith('2026-11-04');
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  frame();
  expect(onPreview).toHaveBeenLastCalledWith(null);
  expect(screen.queryByText('Tip for 2026-11-04')).toBeNull();
});

test('the tooltip and the preview go over an empty leading cell and over a row', () => {
  const onPreview = jest.fn();
  const { container } = render(
    <MonthGrid
      rows={[[null, cell('2026-11-03'), cell('2026-11-04'), null, null, null, null]]}
      selected="2026-11-03"
      onSelect={() => undefined}
      onPreview={onPreview}
      onOpen={() => undefined}
      tooltip={(date) => ({ date, lines: [`Tip for ${date}`] })}
      label="November 2026"
    />,
  );
  const day = screen.getByRole('gridcell', { name: 'Day 2026-11-04' });
  const empty = container.querySelector('[role=gridcell]:not([data-date])');
  if (empty === null) throw new Error('no empty cell');
  for (const target of [empty, screen.getAllByRole('row')[1] as Element]) {
    fireEvent.pointerOver(day, { pointerType: 'mouse' });
    expect(screen.queryByText('Tip for 2026-11-04')).not.toBeNull();
    fireEvent.pointerOver(target, { pointerType: 'mouse' });
    frame();
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText('Tip for 2026-11-04')).toBeNull();
  }
});

test('a pointer over a gap with nothing previewed does not call onPreview', () => {
  const onPreview = jest.fn();
  setup(onPreview);
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  frame();
  expect(onPreview).not.toHaveBeenCalled();
});

test('crossing the gap into the next day never calls onPreview(null); resting on the gap does after the frame', () => {
  const onPreview = jest.fn();
  setup(onPreview);
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }), { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-04' }), { pointerType: 'mouse' });
  frame();
  expect(onPreview.mock.calls).toEqual([['2026-11-03'], ['2026-11-04']]);
  expect(screen.queryByText('Tip for 2026-11-04')).not.toBeNull();
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  expect(onPreview).toHaveBeenLastCalledWith('2026-11-04');
  frame();
  expect(onPreview).toHaveBeenLastCalledWith(null);
});

test('leaving the grid clears at once, and unmounting cancels a pending clear', () => {
  const onPreview = jest.fn();
  setup(onPreview);
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }), { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  fireEvent.pointerLeave(screen.getByRole('grid'), { pointerType: 'mouse' });
  expect(onPreview).toHaveBeenLastCalledWith(null);
  cleanup();
  onPreview.mockClear();
  setup(onPreview);
  fireEvent.pointerOver(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }), { pointerType: 'mouse' });
  fireEvent.pointerOver(screen.getByRole('grid'), { pointerType: 'mouse' });
  cleanup();
  frame();
  expect(onPreview).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
