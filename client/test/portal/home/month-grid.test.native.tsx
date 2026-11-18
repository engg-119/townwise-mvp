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
