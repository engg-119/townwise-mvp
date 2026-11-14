import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';

import { CalendarWeek } from '../../../src/portal/calendar/CalendarWeek.web';
import { buildWeek, gridHeight, weekLabel, weekOf } from '../../../src/portal/calendar/grid';
import { ALL_FILTERS, monthBounds, type CalendarInput, type ImportedEvent } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { note, townEvent } from '../analytics/fakes';
import { ruleOf } from '../rules/fakes';
import { forecastDay, forecastOf } from './fakes';

// The Calendar's week view on web (P28, spec 16.3): from 641px a grid named by the week with one row of 7 day columns,
// each the click target and the roving tab stop, labeled as its month cell and described by its card list; its head
// (the day, the status word, the figure and the range); its cards in order with their hours; the keys; a box at least
// as tall as the month grid; and the tooltip over a head only. At 640px and below the same week as an agenda of 7
// rows. Today is Wed, Nov 11, 2026. Synthetic figures and made-up titles only.

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  if (width !== 1280) setWidth(1280);
});

const TODAY = '2026-11-11';
const SATURDAY = '2026-11-21';
const BOUNDS = monthBounds(TODAY);

function imported(title: string, startTime: string | null, endTime: string | null): ImportedEvent {
  return { uid: title, title, startDate: SATURDAY, endDate: SATURDAY, startTime, endTime };
}

const PATIO = ruleOf('r1', 'Patio closes at 8 pm', {
  schedule: { kind: 'other', startDate: '2026-11-01', endDate: null, weekdays: [6], effect: 'fewer_guests', expectedGuests: null, startTime: null, endTime: null },
  scheduleSummary: 'Saturdays from Nov 1, 2026',
});

function input(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, month: '2026-11',
    forecast: forecastOf([forecastDay({ date: SATURDAY })]) as ForecastWindow,
    salesDays: [],
    events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })],
    notes: [
      note({ startDate: SATURDAY, expectedGuests: 70, startTime: '18:00', endTime: '21:00' }),
      note({ startDate: SATURDAY, kind: 'other' }),
    ],
    rules: [PATIO],
    imported: [imported('Wine delivery', '09:00', '10:00')],
    filters: ALL_FILTERS,
    ...fields,
  };
}

interface Options { reads?: CalendarInput; selected?: string; month?: string; busy?: boolean; onSelect?: jest.Mock }

function renderWeek(options: Options = {}): { onSelect: jest.Mock; grid: HTMLElement } {
  const reads = options.reads ?? input();
  const selected = options.selected ?? SATURDAY;
  const month = options.month ?? reads.month;
  const onSelect = options.onSelect ?? jest.fn();
  const label = weekLabel(weekOf(selected)[0] ?? selected);
  render(
    <CalendarWeek
      days={buildWeek(selected, month, reads, BOUNDS)}
      selected={selected}
      month={month}
      bounds={BOUNDS}
      onSelect={onSelect}
      busy={options.busy ?? false}
      label={label}
      tooltip={(date) => ({ date, lines: [`Tip for ${date}`] })}
    />,
  );
  return { onSelect, grid: screen.getByRole('grid', { name: label }) };
}

/** The week with its selection in state, as the page keeps it. */
function Selecting(props: { start: string }): React.JSX.Element {
  const [selected, setSelected] = useState(props.start);
  return (
    <CalendarWeek
      days={buildWeek(selected, '2026-11', input(), BOUNDS)}
      selected={selected}
      month="2026-11"
      bounds={BOUNDS}
      onSelect={(date) => { setSelected(date); }}
      busy={false}
      label={weekLabel(weekOf(selected)[0] ?? selected)}
      tooltip={() => null}
    />
  );
}

function cell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`);
  if (found === null) throw new Error(`no column for ${date}`);
  return found;
}

function head(date: string): HTMLElement {
  const found = cell(date).querySelector<HTMLElement>('[data-head]');
  if (found === null) throw new Error(`no head for ${date}`);
  return found;
}

function description(element: HTMLElement): HTMLElement | null {
  const id = element.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id);
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

function cardTexts(date: string): string[] {
  return within(cell(date)).queryAllByRole('listitem').map((item) => item.textContent);
}

/** jsdom has no PointerEvent, so `pointerType` is set on a plain one. */
function pointerOver(element: Element, pointerType: 'mouse' | 'touch'): void {
  const event = new MouseEvent('pointerover', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(element, event);
}

describe('the day columns at 1280', () => {
  test('a grid named by the week, with one row of 7 columns and one tab stop', () => {
    const { grid } = renderWeek();
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(1);
    const columns = within(at(rows, 0)).getAllByRole('gridcell');
    expect(columns.map((column) => column.getAttribute('data-date'))).toEqual(weekOf(SATURDAY));
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(cell(SATURDAY).getAttribute('tabindex')).toBe('0');
    expect(cell(SATURDAY).getAttribute('aria-selected')).toBe('true');
  });

  test('each column is labeled as its month cell and described by its card list, hours included', () => {
    renderWeek();
    const days = buildWeek(SATURDAY, '2026-11', input(), BOUNDS);
    for (const day of days) {
      if (day.kind !== 'day') throw new Error('an inert day in November');
      expect(cell(day.date).getAttribute('aria-label')).toBe(day.label);
    }
    const list = description(cell(SATURDAY));
    expect(list?.getAttribute('role')).toBe('list');
    expect(cell(SATURDAY).contains(list)).toBe(true);
    expect(list?.textContent).toContain('6 pm to 9 pm');
    expect(list?.textContent).toContain('Private event, 70');
    // The head is not named: the column's label says the same.
    expect(head(SATURDAY).hasAttribute('aria-label')).toBe(false);
  });

  test('Saturday’s head: the day, the figure and the range', () => {
    renderWeek();
    expect(head(SATURDAY).textContent).toContain('Sat 21');
    expect(head(SATURDAY).textContent).toContain('212');
    expect(head(SATURDAY).textContent).toContain('180 to 240');
    // A month's 1st names its month.
    cleanup();
    renderWeek({ selected: '2026-12-01', month: '2026-12', reads: input({ month: '2026-12' }) });
    expect(head('2026-12-01').textContent).toContain('Tue Dec 1');
    expect(head('2026-11-30').textContent).toContain('Mon 30');
  });

  test('today’s column has a Today tag', () => {
    renderWeek({ selected: TODAY });
    expect(within(head(TODAY)).getByText('Today')).toBeTruthy();
    expect(within(head('2026-11-12')).queryByText('Today')).toBeNull();
  });

  test('the cards, all day first and then by time, each with its hours, title and kind words', () => {
    renderWeek();
    expect(cardTexts(SATURDAY)).toEqual([
      'Dartmouth home football Town event',
      'Other Your note',
      'Patio closes at 8 pm Saturdays from Nov 1, 2026',
      '9 am to 10 am Wine delivery Your calendar',
      '6 pm to 9 pm Private event, 70 Your note',
    ]);
    // Cards are not focusable; the panel keeps the actions.
    expect(cell(SATURDAY).querySelectorAll('[tabindex]:not([data-date])')).toHaveLength(0);
  });

  test('a rule card is the rule’s text over its schedule summary', () => {
    renderWeek();
    const card = within(cell(SATURDAY)).getAllByRole('listitem').find((item) => item.textContent.startsWith('Patio'));
    expect(card?.children[0]?.textContent).toBe('Patio closes at 8 pm');
    expect(card?.children[1]?.textContent).toBe('Saturdays from Nov 1, 2026');
  });

  test('ArrowRight from Sunday selects the next Monday, ArrowDown a week on; the moved-to column takes focus without scrolling', () => {
    const { onSelect } = renderWeek({ selected: '2026-11-22' });
    fireEvent.keyDown(cell('2026-11-22'), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-23', true, null);
    fireEvent.keyDown(cell('2026-11-22'), { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-29', true, null);
    // PageDown steps from the day's own month.
    fireEvent.keyDown(cell('2026-11-22'), { key: 'PageDown' });
    expect(onSelect).toHaveBeenLastCalledWith('2026-12-22', true, '2026-12');
    cleanup();
    const focus = jest.spyOn(HTMLElement.prototype, 'focus');
    render(<Selecting start="2026-11-18" />);
    fireEvent.keyDown(cell('2026-11-18'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cell('2026-11-19'));
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(document.querySelectorAll('[role="grid"] [tabindex="0"]')).toHaveLength(1);
  });

  test('PageDown from a leading day steps from the day’s own month, not the grid’s', () => {
    // The week view hides the grid's month: Oct 28 in November's grid goes to Nov 28 (the month grid's keys give Dec 28).
    const { onSelect } = renderWeek({ selected: '2026-10-28', month: '2026-11' });
    fireEvent.keyDown(cell('2026-10-28'), { key: 'PageDown' });
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-28', true, '2026-11');
  });

  test('Ctrl+Home goes to the week’s Monday, not the month’s 1st', () => {
    const { onSelect } = renderWeek({ selected: '2026-11-18' });
    fireEvent.keyDown(cell('2026-11-18'), { key: 'Home', ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-16', true, null);
  });

  test('a click anywhere in a column, a card included, selects its day; Enter selects the focused one', () => {
    const { onSelect } = renderWeek();
    fireEvent.click(cell('2026-11-17'));
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-17');
    fireEvent.click(at(within(cell(SATURDAY)).getAllByRole('listitem'), 0));
    expect(onSelect).toHaveBeenLastCalledWith(SATURDAY);
    fireEvent.keyDown(cell('2026-11-19'), { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-19');
  });

  test('the box is at least as tall as the month grid, and aria-busy while busy', () => {
    const { grid } = renderWeek({ busy: true });
    expect(grid.style.minHeight).toBe(`${String(gridHeight(1280))}px`);
    expect(grid.getAttribute('aria-busy')).toBe('true');
  });

  test('a mouse over a column head shows the tooltip; over a card, or by touch, nothing', () => {
    renderWeek();
    pointerOver(at(within(cell(SATURDAY)).getAllByRole('listitem'), 0), 'mouse');
    expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
    pointerOver(head(SATURDAY), 'touch');
    expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
    pointerOver(head(SATURDAY), 'mouse');
    expect(screen.getByTestId('calendar-tooltip').textContent).toContain(`Tip for ${SATURDAY}`);
  });
});

describe('inert and pending columns', () => {
  test('the last week of the 25 months: Dec 1 to 5, 2027 are inert, and ArrowRight from Nov 30, 2027 is consumed', () => {
    const onSelect = jest.fn();
    const { grid } = renderWeek({ reads: input({ month: '2027-11', events: [townEvent({ start: '2027-12-03', title: 'Tree lighting' })] }), selected: '2027-11-30', month: '2027-11', onSelect });
    expect(grid.getAttribute('aria-label')).toBe('Nov 29 to Dec 5, 2027');
    const inert = within(grid).getAllByRole('gridcell').filter((column) => column.getAttribute('aria-disabled') === 'true');
    expect(inert.map((column) => column.getAttribute('aria-label'))).toEqual(
      ['Wed, Dec 1, 2027', 'Thu, Dec 2, 2027', 'Fri, Dec 3, 2027', 'Sat, Dec 4, 2027', 'Sun, Dec 5, 2027'].map((date) => `${date}. Outside the months the calendar shows.`),
    );
    for (const column of inert) {
      expect(column.hasAttribute('data-date')).toBe(false);
      expect(column.hasAttribute('tabindex')).toBe(false);
      expect(within(column).queryAllByRole('listitem')).toHaveLength(0);
    }
    expect(grid.textContent).not.toContain('Tree lighting');
    expect(fireEvent.keyDown(cell('2027-11-30'), { key: 'ArrowRight' })).toBe(false);
    fireEvent.click(at(inert, 0));
    pointerOver(at(inert, 0), 'mouse');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  });

  test('a pending column is its head line only, labeled as loading, with no description and no tooltip, and keeps the tab stop', () => {
    // November's reads cover Oct 26 to Dec 6; the week of Dec 7 waits for December's.
    const { grid } = renderWeek({ reads: input({ events: [townEvent({ start: '2026-12-08', title: 'Craft fair' })] }), selected: '2026-12-08', month: '2026-12' });
    expect(cell('2026-12-08').getAttribute('aria-label')).toBe('Tue, Dec 8, 2026. Loading.');
    expect(cell('2026-12-08').textContent).toBe('Tue 8');
    expect(cell('2026-12-08').hasAttribute('aria-describedby')).toBe(false);
    expect(within(cell('2026-12-08')).queryAllByRole('list')).toHaveLength(0);
    expect(cell('2026-12-08').getAttribute('tabindex')).toBe('0');
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(grid.textContent).not.toContain('Craft fair');
    pointerOver(at([...cell('2026-12-08').children], 0), 'mouse');
    expect(screen.queryByTestId('calendar-tooltip')).toBeNull();
  });
});

describe('the agenda at 640px and below', () => {
  test('at 600 a grid named by the week with 7 rows of one gridcell each, labeled and described as the columns are', () => {
    setWidth(600);
    const { grid, onSelect } = renderWeek();
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(within(row).getAllByRole('gridcell')).toHaveLength(1);
    const days = buildWeek(SATURDAY, '2026-11', input(), BOUNDS);
    expect(rows.map((row) => within(row).getByRole('gridcell').getAttribute('aria-label'))).toEqual(days.map((day) => day.label));
    expect(description(cell(SATURDAY))?.textContent).toContain('6 pm to 9 pm');
    expect(cardTexts(SATURDAY)).toHaveLength(5);
    expect(head(SATURDAY).textContent).toContain('180 to 240');
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    // Its height follows what it holds.
    expect(grid.style.minHeight).toBe('');
    // Each row is a day, so Up and Down move one.
    fireEvent.keyDown(cell(SATURDAY), { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-22', true, null);
    fireEvent.keyDown(cell(SATURDAY), { key: 'ArrowUp' });
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-20', true, null);
  });

  test('from 641 the columns again', () => {
    setWidth(641);
    const { grid } = renderWeek();
    expect(within(grid).getAllByRole('row')).toHaveLength(1);
    expect(grid.style.minHeight).toBe(`${String(gridHeight(641))}px`);
  });
});
