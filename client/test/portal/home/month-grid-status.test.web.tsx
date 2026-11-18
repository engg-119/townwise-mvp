import { act, cleanup, render, screen, within } from '@testing-library/react';

import { WIDE_ROWS, type MonthCell } from '../../../src/portal/analytics/week';
import { MonthGrid } from '../../../src/portal/home/MonthGrid.web';

// Home's month grid prints a cell's status word with the Calendar's statusWord (D49: its cells are the Calendar's), so a
// near-empty past day (spec D32) reads "Likely closed", not "Closed", as the Calendar and the heatmap name it.

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

function cell(date: string, status: MonthCell['status'], fields: Partial<MonthCell> = {}): MonthCell {
  return {
    date, isToday: false, inWeek: false, status, figure: null, figureText: null, caption: null, noteGuests: 0, chips: [], more: 0,
    marks: { event: false, note: false, imported: false }, label: `Day ${date}`, ...fields,
  };
}

test('a likely-closed day says Likely closed; a closed day Closed; a booked day Booked', () => {
  render(
    <MonthGrid
      rows={[[cell('2026-11-02', 'likely_closed'), cell('2026-11-03', 'closed'), cell('2026-11-04', 'booked'), cell('2026-11-05', null), null, null, null]]}
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

function renderRow(cells: (MonthCell | null)[], wide = false): void {
  render(
    <MonthGrid
      rows={[cells]}
      wide={wide}
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
  renderRow([cell('2026-11-02', 'likely_closed'), cell('2026-11-03', 'booked'), null, null, null, null, null]);
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

// D49 (design decision 9): a grid whose cells are at least 88px wide lists up to two entry lines in 96px; a narrower one
// keeps the corner marks. Either way the label says everything, and a past day's run figure says "forecast".
const BUSY = cell('2026-11-11', null, {
  chips: ['Holiday party', 'Veterans Day', 'Wine dinner'], more: 0, marks: { event: true, note: true, imported: true },
  figure: { value: 140, kind: 'past_forecast' }, figureText: '140', caption: 'forecast',
});
const TWO = cell('2026-11-12', 'closed', { chips: ['Holiday party', 'Closed Thursdays'], marks: { event: false, note: true, imported: false } });

test('a wide grid lists two entry lines, or one and “+N more”, at 96px; a narrow one shows corner marks', () => {
  renderRow([BUSY, TWO, null, null, null, null, null], true);
  const busy = screen.getByRole('gridcell', { name: 'Day 2026-11-11' });
  expect(busy.textContent).toBe('11forecast140Holiday party+2 more');
  expect(busy.style.height).toBe('96px');
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-12' }).textContent).toBe('12ClosedHoliday partyClosed Thursdays');
  cleanup();
  renderRow([BUSY, TWO, null, null, null, null, null]);
  const narrow = screen.getByRole('gridcell', { name: 'Day 2026-11-11' });
  expect(narrow.textContent).toBe('11140forecast');
  // The three corner marks: town, yours, and the mint outline for an imported event.
  expect(narrow.querySelectorAll('span[aria-hidden="true"][style*="position: absolute"]')).toHaveLength(3);
  expect(narrow.style.minHeight).toBe('64px');
});

// UI review B1: the busiest cells cut off their last line. The top row holds the day and the status or caption, the
// figure row the figure and its "+40" (or the status in its place), each at a fixed height, so the entry lines get
// what is left of the 96px; jsdom lays nothing out, so the rows' heights are read from their styles.
test('a wide cell keeps every part inside its 96px: status and caption by the day, "+40" by the figure', () => {
  const buyout = cell('2026-11-25', 'booked', {
    figure: { value: 70, kind: 'booked' }, figureText: '~70', caption: 'forecast', chips: ['Holiday party', 'Closed Wednesdays in December'],
  });
  const busy = cell('2026-11-21', null, {
    figure: { value: 334, kind: 'forecast' }, figureText: '~334', caption: 'forecast', noteGuests: 40,
    chips: ['Alumni reception', 'Home football game', 'Veterans Day'], more: 1,
  });
  const closed = cell('2026-11-26', 'likely_closed', { chips: ['Thanksgiving Day'] });
  for (const next of [1440, 768]) {
    setWidth(next);
    renderRow([buyout, busy, closed, null, null, null, null], true);
    const rowsOf = (date: string): HTMLElement[] => [...screen.getByRole('gridcell', { name: `Day ${date}` }).children] as HTMLElement[];
    const [top, figure, entries, ...rest] = rowsOf('2026-11-25');
    expect(rest).toEqual([]);
    expect([top?.textContent, figure?.textContent, entries?.textContent]).toEqual(['25Booked', '~70', 'Holiday partyClosed Wednesdays in December']);
    expect([top?.style.height, figure?.style.height]).toEqual([`${String(WIDE_ROWS.top)}px`, `${String(WIDE_ROWS.figure)}px`]);
    for (const line of [...(entries?.children ?? [])] as HTMLElement[]) expect(line.style.lineHeight).toBe(`${String(WIDE_ROWS.entry)}px`);
    expect(rowsOf('2026-11-21').map((row) => row.textContent)).toEqual(['21forecast', '~334+40', 'Alumni reception+3 more']);
    expect(rowsOf('2026-11-26').map((row) => row.textContent)).toEqual(['26', 'Likely closed', 'Thanksgiving Day']);
    cleanup();
  }
});

// UI review S4: at phone width a narrow cell is about 42px, narrower than "forecast"; the "~" marks the forecast there.
test('a narrow cell drops “forecast” on a phone, and keeps it wider', () => {
  const forecast = cell('2026-11-20', null, { figure: { value: 104, kind: 'forecast' }, figureText: '~104', caption: 'forecast' });
  setWidth(375);
  renderRow([forecast, null, null, null, null, null, null]);
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-20' }).textContent).toBe('20~104');
  cleanup();
  setWidth(1280);
  renderRow([forecast, null, null, null, null, null, null]);
  expect(screen.getByRole('gridcell', { name: 'Day 2026-11-20' }).textContent).toBe('20~104forecast');
});

test('a footer sits under the key', () => {
  render(
    <MonthGrid
      rows={[[BUSY, null, null, null, null, null, null]]}
      selected="2026-11-11"
      onSelect={() => undefined}
      onPreview={() => undefined}
      onOpen={() => undefined}
      tooltip={() => null}
      label="November 2026"
      footer={<span>Open the calendar</span>}
    />,
  );
  const key = screen.getByText('Your calendar');
  expect(key.compareDocumentPosition(screen.getByText('Open the calendar')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('an outlook day (D52) says Outlook over its middle figure, at 1280 and at 375', () => {
  const outlook: MonthCell = { ...cell('2026-11-20', 'outlook'), figure: { value: 212, kind: 'forecast' }, figureText: '~212', caption: 'forecast' };
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
