import { act, cleanup, render, screen, within } from '@testing-library/react';

import type { MonthCell } from '../../../src/portal/analytics/week';
import { MonthGrid } from '../../../src/portal/home/MonthGrid.web';

// Home's month grid prints a cell's status word from week.ts monthStatusWord, so a near-empty past day (spec D32)
// reads "Likely closed", not "Closed", as the Calendar and the heatmap name it.

// jsdom's document is 0px wide; each test sets the page's width.
let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  setWidth(1280);
});

function cell(date: string, status: MonthCell['status'], likelyClosed = false): MonthCell {
  return { date, event: false, note: false, inWeek: false, isToday: false, figure: null, status, likelyClosed, noteGuests: 0, label: `Day ${date}` };
}

test('a likely-closed day says Likely closed; a closed day Closed; a booked day Booked', () => {
  render(
    <MonthGrid
      rows={[[cell('2026-11-02', 'closed', true), cell('2026-11-03', 'closed'), cell('2026-11-04', 'booked'), cell('2026-11-05', null), null, null, null]]}
      selected="2026-11-05"
      onSelect={() => undefined}
      onPreview={() => undefined}
      onOpen={() => undefined}
      tooltip={() => null}
      label="November 2026"
    />,
  );
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-02' }).textContent).toContain('Likely closed');
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }).textContent).toContain('Closed');
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-03' }).textContent).not.toContain('Likely');
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-04' }).textContent).toContain('Booked');
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-05' }).textContent).not.toMatch(/Closed|Booked/);
});

function renderRow(cells: (MonthCell | null)[]): void {
  render(
    <MonthGrid
      rows={[cells]}
      selected="2026-11-05"
      onSelect={() => undefined}
      onPreview={() => undefined}
      onOpen={() => undefined}
      tooltip={() => null}
      label="November 2026"
    />,
  );
}

test('at 375px the status takes its own line under the day, sized to its cell, so “Likely closed” wraps between its words', () => {
  setWidth(375);
  renderRow([cell('2026-11-02', 'closed', true), cell('2026-11-03', 'booked'), null, null, null, null, null]);
  const day = screen.getByRole('gridcell', { name: 'Day 2026-11-02' });
  const status = within(day).getByText('Likely closed');
  // Its own line, a child of the cell under the row with the day's number (which holds the number alone).
  expect(status.parentElement).toBe(day);
  expect(day.firstElementChild?.textContent).toBe('2');
  // A phone's cell is as wide as its column and 52px tall at least, room for the status's two lines.
  expect(day.style.minHeight).toBe('52px');
  // The status's type shrinks with its cell (the cell is its container), so a 6-letter word fits: 0.6em a letter in
  // Geist Mono, 3.6em for “LIKELY”, never larger than 10px.
  const css = Array.from(document.querySelectorAll('style'), (style) => style.textContent).join('\n');
  expect(css).toContain('.tw-mg [data-date]{container-type:inline-size}');
  expect(css).toContain('.tw-mg .tw-mg-status{font-size:10px;font-size:min(10px, calc(100cqi / 3.7))}');
  expect(status.classList.contains('tw-mg-status')).toBe(true);
  expect(status.style.fontSize).toBe('');
  expect(within(screen.getByRole('gridcell', { name: 'Day 2026-11-03' })).getByText('Booked').classList.contains('tw-mg-status')).toBe(true);
});

test('an outlook day (D52) says Outlook over its middle figure, at 1280 and at 375', () => {
  const outlook: MonthCell = { ...cell('2026-11-20', 'outlook'), figure: { value: 212, kind: 'forecast', text: '212' } };
  for (const next of [1280, 375]) {
    setWidth(next);
    renderRow([outlook, cell('2026-11-21', null), null, null, null, null, null]);
    const shown = screen.getByRole('gridcell', { name: 'Day 2026-11-20' });
    expect(shown.textContent).toContain('Outlook');
    expect(shown.textContent).toContain('212');
    expect(screen.getByRole('gridcell', { name: 'Day 2026-11-21' }).textContent).not.toContain('Outlook');
    cleanup();
  }
});
