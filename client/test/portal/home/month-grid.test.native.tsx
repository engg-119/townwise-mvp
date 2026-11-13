import { render, screen } from '@testing-library/react-native';

import type { MonthCell } from '../../../src/portal/analytics/week';
import { MonthGrid } from '../../../src/portal/home/MonthGrid';

// Home's month grid on native: a narrow cell's status (“Likely closed”, spec D32) shrinks to fit its two lines rather
// than breaking a word across lines.

function cell(date: string, status: MonthCell['status'], likelyClosed = false): MonthCell {
  return { date, event: false, note: false, inWeek: false, isToday: false, figure: null, status, likelyClosed, noteGuests: 0, label: `Day ${date}` };
}

test('a cell’s status keeps its words whole: at most two lines, its type shrinking to fit the cell', async () => {
  await render(
    <MonthGrid
      rows={[[cell('2026-11-02', 'closed', true), cell('2026-11-03', 'closed'), null, null, null, null, null]]}
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
