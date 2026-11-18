import { Dimensions } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import type { MonthCell } from '../../../src/portal/analytics/week';
import { MonthGrid } from '../../../src/portal/home/MonthGrid';

// Home's month grid on native: a narrow cell's status (“Likely closed”, spec D32) shrinks to fit its two lines rather
// than breaking a word across lines.

function cell(date: string, status: MonthCell['status'], fields: Partial<MonthCell> = {}): MonthCell {
  return {
    date, isToday: false, inWeek: false, status, figure: null, figureText: null, caption: null, noteGuests: 0, chips: [], more: 0,
    marks: { event: false, note: false, imported: false }, label: `Day ${date}`, ...fields,
  };
}

test('a cell’s status keeps its words whole: at most two lines, its type shrinking to fit the cell', async () => {
  await render(
    <MonthGrid
      rows={[[cell('2026-11-02', 'likely_closed'), cell('2026-11-03', 'closed'), null, null, null, null, null]]}
      selected="2026-11-05"
      onSelect={() => undefined}
      onPreview={() => undefined}
      onOpen={() => undefined}
      tooltip={() => null}
      label="November 2026"
    />,
  );
  for (const words of ['Likely closed', 'Closed']) {
    const status = screen.getByText(words);
    expect(status.props.numberOfLines).toBe(2);
    expect(status.props.adjustsFontSizeToFit).toBe(true);
  }
});

// D49: on native too, cells at least 88px wide list two entry lines, else the corner marks.
test('a wide grid lists the entry lines; a narrow one shows none, and the label names them all', async () => {
  const busy = cell('2026-11-11', null, {
    chips: ['Holiday party', 'Veterans Day'], more: 0, marks: { event: true, note: true, imported: false }, label: 'Wed, Nov 11. Holiday party. Veterans Day.',
  });
  const props = {
    rows: [[busy, null, null, null, null, null, null]], selected: '2026-11-11', onSelect: () => undefined, onPreview: () => undefined,
    onOpen: () => undefined, tooltip: () => null, label: 'November 2026',
  };
  const { rerender } = await render(<MonthGrid {...props} wide />);
  expect(screen.getByText('Holiday party')).toBeTruthy();
  expect(screen.getByText('Veterans Day')).toBeTruthy();
  await rerender(<MonthGrid {...props} />);
  expect(screen.queryByText('Holiday party')).toBeNull();
  expect(screen.getByLabelText('Wed, Nov 11. Holiday party. Veterans Day.')).toBeTruthy();
});

test('an outlook day (D52) shows Outlook and its middle figure', async () => {
  const outlook: MonthCell = { ...cell('2026-11-20', 'outlook'), figure: { value: 212, kind: 'forecast' }, figureText: '~212', caption: 'forecast' };
  await render(
    <MonthGrid
      rows={[[outlook, null, null, null, null, null, null]]}
      selected="2026-11-20"
      onSelect={() => undefined}
      onPreview={() => undefined}
      onOpen={() => undefined}
      tooltip={() => null}
      label="November 2026"
    />,
  );
  expect(screen.getByText('Outlook')).toBeTruthy();
  expect(screen.getByText('~212')).toBeTruthy();
});

// UI review B1 and S4 on native: a wide cell's status and caption sit by the day and "+40" by the figure, so two entry
// lines fit in 96px; a phone's narrow cell drops "forecast", which is wider than the cell.
test('a wide cell puts Booked by the day and +40 by the figure, keeping to its line budget', async () => {
  const buyout = cell('2026-11-25', 'booked', {
    figure: { value: 70, kind: 'booked' }, figureText: '~70', caption: 'forecast', chips: ['Holiday party', 'Closed Wednesdays in December'],
  });
  const busy = cell('2026-11-21', null, {
    figure: { value: 334, kind: 'forecast' }, figureText: '~334', caption: 'forecast', noteGuests: 40,
    chips: ['Alumni reception', 'Home football game', 'Veterans Day'], more: 1,
  });
  await render(
    <MonthGrid
      rows={[[buyout, busy, null, null, null, null, null]]}
      wide
      selected="2026-11-25"
      onSelect={() => undefined}
      onPreview={() => undefined}
      onOpen={() => undefined}
      tooltip={() => null}
      label="November 2026"
    />,
  );
  // Each in the same row as the day number, or the figure: rows of their own, not the cell.
  const rowOf = (text: string): unknown => screen.getByText(text).parent;
  expect(rowOf('Booked')).toBe(rowOf('25'));
  expect(rowOf('25')).not.toBe(screen.getByRole('button', { name: 'Day 2026-11-25' }));
  expect(rowOf('+40')).toBe(rowOf('~334'));
  expect(rowOf('forecast')).toBe(rowOf('21'));
  expect(rowOf('forecast')).not.toBe(rowOf('~334'));
  expect(screen.getByText('Holiday party')).toBeTruthy();
  expect(screen.getByText('Closed Wednesdays in December')).toBeTruthy();
  expect(screen.getByText('Alumni reception')).toBeTruthy();
  expect(screen.getByText('+3 more')).toBeTruthy();
  expect(screen.queryByText('Home football game')).toBeNull();
});

test('a phone’s narrow cell drops “forecast”; a wider one keeps it', async () => {
  const forecast = cell('2026-11-20', null, { figure: { value: 104, kind: 'forecast' }, figureText: '~104', caption: 'forecast' });
  const props = {
    rows: [[forecast, null, null, null, null, null, null]], selected: '2026-11-20', onSelect: () => undefined, onPreview: () => undefined,
    onOpen: () => undefined, tooltip: () => null, label: 'November 2026',
  };
  const spy = jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 375, height: 800, scale: 2, fontScale: 1 });
  try {
    const { unmount } = await render(<MonthGrid {...props} />);
    expect(screen.getByText('~104')).toBeTruthy();
    expect(screen.queryByText('forecast')).toBeNull();
    await unmount();
  } finally {
    spy.mockRestore();
  }
  await render(<MonthGrid {...props} />);
  expect(screen.getByText('forecast')).toBeTruthy();
});
