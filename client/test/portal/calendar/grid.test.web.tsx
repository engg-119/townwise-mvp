import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { CalendarGrid } from '../../../src/portal/calendar/CalendarGrid.web';
import { buildGrid, gridRange } from '../../../src/portal/calendar/grid';
import { ALL_FILTERS, monthBounds, monthLabel, type CalendarInput, type ImportedEvent } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { theme } from '../../../src/theme';
import { note, townEvent } from '../analytics/fakes';
import { forecastDay, forecastOf } from './fakes';

// The Calendar's month grid on web (P28, spec 16.3), rendered from buildGrid: always 42 days, each cell a fixed
// height by width, the days either side muted with their own data and selectable in place, up to three entry lines
// from 1024px, the status word where the figure goes, and the keys. Today is Wed, Nov 11, 2026. Synthetic figures and
// made-up titles only.

// jsdom's document is 0px wide, which is a phone to react-native-web.
let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  if (width !== 1280) setWidth(1280);
});

const TODAY = '2026-11-11';
const BOUNDS = monthBounds(TODAY);
const C = theme.color;

/** Saturdays Sep 19 to Oct 31 at 140 guests, then Nov 7 with 1: likely closed (spec D32). */
const SALES = [
  ...['2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'].map((date) => ({ date, guests: 140, netSalesCents: 280_000 })),
  { date: '2026-11-07', guests: 1, netSalesCents: 2_500 },
];

function imported(date: string, title: string): ImportedEvent {
  return { calendarId: 'c1', uid: `${date}-${title}`, title, startDate: date, endDate: date, startTime: null, endTime: null };
}

function input(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, covered: gridRange('2026-11', BOUNDS),
    forecast: forecastOf([
      forecastDay({ date: '2026-11-21', low: 250, mid: 282, high: 310, noteGuests: 70 }),
      forecastDay({
        date: '2026-11-14', status: 'booked', low: null, mid: null, high: null, noteGuests: 70,
        reasons: [{ kind: 'note', label: 'Your private buyout, 70 guests', effectPct: null, sources: [], note: { id: 'n2', guests: 70, outcome: 'booked' } }],
      }),
      forecastDay({ date: '2026-12-02', mid: 198 }),
    ]) as ForecastWindow,
    salesDays: SALES,
    events: [
      townEvent({ start: '2026-11-21', title: 'Dartmouth home football' }),
      townEvent({ start: '2026-11-22', title: 'Craft fair' }), townEvent({ start: '2026-11-22', title: 'Choir concert' }),
      townEvent({ start: '2026-12-03', title: 'Tree lighting' }),
    ],
    notes: [note({ startDate: '2026-11-21', expectedGuests: 70 }), note({ startDate: '2026-11-22', kind: 'other' })],
    imported: [imported('2026-11-21', 'Wine delivery'), imported('2026-11-22', 'Linen pickup')],
    filters: ALL_FILTERS,
    ...fields,
  };
}

function renderGrid(options: { reads?: CalendarInput; month?: string; selected?: string; onSelect?: jest.Mock } = {}): { onSelect: jest.Mock; grid: HTMLElement } {
  const reads = options.reads ?? input();
  const month = options.month ?? '2026-11';
  const onSelect = options.onSelect ?? jest.fn();
  render(
    <CalendarGrid
      rows={buildGrid(month, reads, monthBounds(reads.today))}
      selected={options.selected ?? reads.today}
      month={month}
      bounds={monthBounds(reads.today)}
      onSelect={onSelect}
      busy={false}
      label={monthLabel(month)}
      tooltip={(date) => ({ date, lines: [`Tip for ${date}`] })}
    />,
  );
  return { onSelect, grid: screen.getByRole('grid', { name: monthLabel(month) }) };
}

/** The grid with its selection in state, as the page keeps it. */
function Selecting(props: { start: string }): React.JSX.Element {
  const [selected, setSelected] = useState(props.start);
  const reads = input();
  return (
    <CalendarGrid
      rows={buildGrid('2026-11', reads, monthBounds(TODAY))}
      selected={selected}
      month="2026-11"
      bounds={monthBounds(TODAY)}
      onSelect={(date) => { setSelected(date); }}
      busy={false}
      label="November 2026"
      tooltip={() => null}
    />
  );
}

function cell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`);
  if (found === null) throw new Error(`no cell for ${date}`);
  return found;
}

/** The cell's rows, less its corner marks: the number row, the figure row and, from 1024px, the entry lines. */
function rowsOf(date: string): HTMLElement[] {
  return [...cell(date).children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.style.position !== 'absolute');
}

test('at 1280 the grid is 42 days, each 104px tall, with the days either side marked outside', () => {
  const { grid } = renderGrid();
  const cells = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"][data-date]')];
  expect(cells).toHaveLength(42);
  expect(cells.map((each) => each.style.height)).toEqual(Array.from({ length: 42 }, () => '104px'));
  expect(cells.every((each) => each.style.overflow === 'hidden')).toBe(true);
  const outside = cells.filter((each) => each.getAttribute('data-outside') === '1').map((each) => each.getAttribute('data-date'));
  expect(outside).toEqual([
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
    '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06',
  ]);
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  // An outside day shows its own data, muted: no raised fill but the 1px border outline, and its words in text3.
  expect(cell('2026-12-03').textContent).toContain('Tree lighting');
  expect(cell('2026-12-02').textContent).toContain('198');
  expect(cell('2026-12-03').style.backgroundColor).toBe('transparent');
  expect(cell('2026-12-03').style.borderColor).toBe(C.border);
  expect(rowsOf('2026-12-03')[0]?.firstElementChild?.getAttribute('style')).toContain(`color: ${C.text3}`);
  expect(cell('2026-11-20').style.backgroundColor).toBe(C.raised);
  // Its label starts with the full date.
  expect(cell('2026-12-03').getAttribute('aria-label')).toBe('Thu, Dec 3, 2026. No forecast. Tree lighting.');
});

test('a past day shows its data over its forecast, its forecast with no data, and “No data” with neither (owner request, 2026-11-17)', () => {
  const reads = input({
    forecast: forecastOf([
      forecastDay({ date: '2026-11-02', status: 'closed', low: null, mid: null, high: null }),
      forecastDay({ date: '2026-11-03', low: 80, mid: 90.4, high: 110 }),
      forecastDay({ date: '2026-10-31', low: 80, mid: 90, high: 110 }),
    ]) as ForecastWindow,
  });
  renderGrid({ reads });
  // Oct 31 has stored guests: they win over the run's 90.
  expect(cell('2026-10-31').textContent).toContain('140');
  expect(cell('2026-10-31').textContent).not.toContain('90');
  // Nov 3: no stored guests, so the run's figure, captioned “forecast”.
  expect(cell('2026-11-03').textContent).toContain('90');
  expect(cell('2026-11-03').textContent).toContain('forecast');
  // Nov 2: the run had it closed.
  expect(cell('2026-11-02').textContent).toContain('Closed');
  // Nov 4: neither.
  expect(cell('2026-11-04').textContent).toContain('No');
  expect(cell('2026-11-04').getAttribute('aria-label')).toBe('Wed, Nov 4, 2026. No data.');
});

test('clicking a trailing day selects it, and the selected outside day is outlined mint', () => {
  const { onSelect } = renderGrid();
  fireEvent.click(cell('2026-12-03'));
  expect(onSelect).toHaveBeenCalledWith('2026-12-03');
  cleanup();
  renderGrid({ selected: '2026-12-03' });
  expect(cell('2026-12-03').getAttribute('aria-selected')).toBe('true');
  expect(cell('2026-12-03').getAttribute('tabindex')).toBe('0');
  expect(cell('2026-12-03').style.borderColor).toBe(C.mint);
});

test('three entries show as three lines; four show the first two and “+2 more”', () => {
  renderGrid();
  const three = rowsOf('2026-11-21')[2];
  // Notes first (D49).
  expect([...(three?.children ?? [])].map((line) => line.textContent)).toEqual(['Private event, 70', 'Dartmouth home football', 'Wine delivery']);
  const four = rowsOf('2026-11-22')[2];
  expect([...(four?.children ?? [])].map((line) => line.textContent)).toEqual(['Other', 'Craft fair', '+2 more']);
  // The figure sits centered in the middle row with the notes' guests inline.
  expect(rowsOf('2026-11-21')[1]?.textContent).toBe('282+70');
});

test('a likely-closed day shows its status word where the figure goes, and no figure', () => {
  renderGrid();
  const middle = rowsOf('2026-11-07')[1];
  expect(middle?.textContent).toBe('Likely closed');
  expect(middle?.firstElementChild?.getAttribute('style')).toContain('text-transform: uppercase');
  expect(cell('2026-11-07').textContent).toBe('7Likely closed');
  // A booked day says so in its top row, over its party.
  expect(rowsOf('2026-11-14')[0]?.textContent).toBe('14Booked');
  expect(rowsOf('2026-11-14')[1]?.textContent).toBe('70');
  // A past figure says “guests” in the top row.
  expect(rowsOf('2026-10-31')[0]?.textContent).toBe('31guests');
});

test('today keeps its own number style in a trailing cell', () => {
  const today = '2026-11-03';
  renderGrid({ reads: input({ today, covered: gridRange('2026-10', monthBounds(today)) }), month: '2026-10', selected: '2026-10-15' });
  expect(cell(today).getAttribute('data-outside')).toBe('1');
  const number = rowsOf(today)[0]?.firstElementChild as HTMLElement | null;
  expect(number?.style.color).toBe(C.white);
  expect(number?.style.fontWeight).toBe('600');
  const other = rowsOf('2026-11-04')[0]?.firstElementChild as HTMLElement | null;
  expect(other?.style.color).toBe(C.text3);
});

function marks(date: string): number {
  return [...cell(date).children].filter((child) => child instanceof HTMLElement && child.style.position === 'absolute').length;
}

test('at 800 cells are 64px with corner marks and no entry lines', () => {
  setWidth(800);
  const { grid } = renderGrid();
  const cells = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"][data-date]')];
  expect(new Set(cells.map((each) => each.style.height))).toEqual(new Set(['64px']));
  expect(cell('2026-11-21').textContent).toBe('21282+70');
  expect(cell('2026-11-21').textContent).not.toContain('Dartmouth home football');
  expect(marks('2026-11-21')).toBe(3);
  // The status word takes two lines where the figure goes; a booked day keeps BOOKED in its top row.
  expect(rowsOf('2026-11-07')[1]?.textContent).toBe('Likely closed');
  expect(rowsOf('2026-11-14')[0]?.textContent).toBe('14Booked');
});

test('at 375 cells are 52px, every status takes the figure’s place, and “+70” and the caption leave the cell', () => {
  setWidth(375);
  const { grid } = renderGrid();
  const cells = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"][data-date]')];
  expect(new Set(cells.map((each) => each.style.height))).toEqual(new Set(['52px']));
  expect(rowsOf('2026-11-14').map((part) => part.textContent)).toEqual(['14', 'Booked']);
  expect(rowsOf('2026-11-07').map((part) => part.textContent)).toEqual(['7', 'Likely closed']);
  expect(rowsOf('2026-11-21').map((part) => part.textContent)).toEqual(['21', '282']);
  expect(rowsOf('2026-10-31').map((part) => part.textContent)).toEqual(['31', '140']);
  expect(grid.textContent).not.toContain('+70');
  expect(grid.textContent).not.toContain('guests');
  // The label still says it all.
  expect(cell('2026-11-21').getAttribute('aria-label')).toContain('Includes 70 guests from your notes.');
});

test('days outside the 25 months are inert: no data-date, aria-disabled, and click, keys and hover do nothing', () => {
  const onSelect = jest.fn();
  const { grid } = renderGrid({ reads: input({ covered: gridRange('2027-11', BOUNDS) }), month: '2027-11', selected: '2027-11-30', onSelect });
  const inert = screen.getByRole('gridcell', { name: 'Sun, Dec 5, 2027. Outside the months the calendar shows.' });
  expect(inert.getAttribute('aria-disabled')).toBe('true');
  expect(inert.hasAttribute('data-date')).toBe(false);
  expect(inert.hasAttribute('tabindex')).toBe(false);
  expect(inert.textContent).toBe('5');
  expect(grid.querySelectorAll('[role="gridcell"][aria-disabled="true"]')).toHaveLength(12);
  fireEvent.click(inert);
  fireEvent.keyDown(inert, { key: 'Enter' });
  fireEvent.pointerOver(inert, { pointerType: 'mouse' });
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.queryByText(/^Tip for/)).toBeNull();
});

test('a pending day shows only its number and says it is loading, and keeps its data-date', () => {
  renderGrid({ month: '2026-12', selected: '2026-12-07' });
  expect(cell('2026-12-12').textContent).toBe('12');
  expect(cell('2026-12-12').getAttribute('aria-label')).toBe('Sat, Dec 12, 2026. Loading.');
  expect(cell('2026-12-07').getAttribute('tabindex')).toBe('0');
  // November's reads cover Nov 30 to Dec 6, which show their data at once.
  expect(cell('2026-12-03').textContent).toContain('Tree lighting');
  expect(cell('2026-12-03').hasAttribute('data-outside')).toBe(false);
  expect(cell('2026-11-30').getAttribute('data-outside')).toBe('1');
});

test('an outside day shows the tooltip the page gives', () => {
  renderGrid();
  fireEvent.pointerOver(cell('2026-12-03'), { pointerType: 'mouse' });
  expect(screen.getByText('Tip for 2026-12-03')).toBeTruthy();
});

test('keys move across months: ArrowRight past the last row, and PageDown from the grid’s month', () => {
  const { onSelect } = renderGrid({ selected: '2026-12-06' });
  fireEvent.keyDown(cell('2026-12-06'), { key: 'ArrowRight' });
  expect(onSelect).toHaveBeenLastCalledWith('2026-12-07', true, null);
  // PageDown from a trailing day keeps the day and moves the grid.
  fireEvent.keyDown(cell('2026-12-06'), { key: 'PageDown' });
  expect(onSelect).toHaveBeenLastCalledWith('2026-12-06', true, '2026-12');
  cleanup();
  const again = renderGrid({ selected: '2026-11-03' });
  fireEvent.keyDown(cell('2026-11-03'), { key: 'PageDown' });
  expect(again.onSelect).toHaveBeenLastCalledWith('2026-12-03', true, '2026-12');
});

test('a key past the 25 months is consumed: its default is prevented and nothing is selected', () => {
  const { onSelect } = renderGrid({ reads: input({ covered: gridRange('2027-11', BOUNDS) }), month: '2027-11', selected: '2027-11-30' });
  expect(fireEvent.keyDown(cell('2027-11-30'), { key: 'ArrowRight' })).toBe(false);
  expect(fireEvent.keyDown(cell('2027-11-30'), { key: 'PageDown' })).toBe(false);
  expect(onSelect).not.toHaveBeenCalled();
  // A key the grid doesn't use goes on to the page.
  expect(fireEvent.keyDown(cell('2027-11-30'), { key: 'a' })).toBe(true);
});

test('after a key move the new cell has focus and is the one tab stop', () => {
  render(<Selecting start="2026-11-18" />);
  cell('2026-11-18').focus();
  fireEvent.keyDown(cell('2026-11-18'), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(cell('2026-11-19'));
  expect(document.querySelectorAll('[role="grid"] [tabindex="0"]')).toHaveLength(1);
  expect(cell('2026-11-19').getAttribute('tabindex')).toBe('0');
  fireEvent.keyDown(cell('2026-11-19'), { key: 'Home', ctrlKey: true });
  expect(document.activeElement).toBe(cell('2026-11-01'));
});
