import { TYPICAL_LOOKBACK_DAYS } from '../analytics/days';
import { mondayOf } from '../analytics/week';
import { shortDate } from '../analytics/words';
import { addDays, monthRange } from '../locations/dates';
import { dayCell, stepMonth, type CalendarCell, type CalendarInput, type monthBounds } from './model';

// The Calendar's grid (P28, spec 16.3), pure: the one place that says which dates a month view shows and what the page
// reads for them. A month is always 42 days in 6 rows, from the Monday on or before its 1st, so the grid never changes
// height; the days before the 1st and after the last day are the months either side, shown muted with their own data.
// Every date is a 'YYYY-MM-DD' string moved in UTC (locations/dates.ts), so a daylight saving change never shifts one.

/** Six weeks of seven days. */
export const GRID_DAYS = 42;

function firstOf(month: string): string {
  return mondayOf(`${month}-01`);
}

/** The month's 42 dates, Monday first. */
export function gridDays(month: string): string[] {
  const first = firstOf(month);
  return Array.from({ length: GRID_DAYS }, (_, index) => addDays(first, index));
}

/** Whether `date` is one of the month grid's 42 days. */
export function inGrid(month: string, date: string): boolean {
  const first = firstOf(month);
  return date >= first && date <= addDays(first, GRID_DAYS - 1);
}

// The shown month is the page's state, not the URL's: a day picked in a leading or trailing cell stays in its grid,
// and the grid moves only when the selected day leaves its 42 days (or on Previous, Next, Today, PageUp, PageDown).

/**
 * The month to show: `shown` while `selected` is one of its 42 days, else `fallback`, the selected day's own month by
 * default. The page passes the month its last render showed: when `?day=` hasn't changed but the kept month no longer
 * holds the day, the month was just set (Previous, Next, PageUp, PageDown) and the new `?day=` hasn't arrived, so that
 * render shows the last grid again rather than the day's own month, which can be neither grid (PageDown from Oct 28 in
 * November's grid would show October once).
 */
export function gridMonthFor(selected: string, shown: string, fallback = selected.slice(0, 7)): string {
  return inGrid(shown, selected) ? shown : fallback;
}

/**
 * The shown month to keep after a render. `seen` is the selected day the page saw last: only a render where it changed
 * moves the grid, since a newly set month and its new `?day=` can arrive in different renders (expo-router delivers
 * `setParams` through its navigation queue), and a render with the new month and the old day must not undo it.
 */
export function shownFor(shown: string, seen: string, selected: string): string {
  return selected === seen ? shown : gridMonthFor(selected, shown);
}

// Reads

/** The 25 months the page shows (model.ts monthBounds). */
export type MonthBounds = ReturnType<typeof monthBounds>;

export interface DateRange { from: string; to: string }

/**
 * What every read of the month's grid covers: its 42 days clamped to the first day of the first shown month and the last
 * day of the last, which keeps each read within 396 days of today, inside the API's 400. The town calendar, the forecast
 * (one request of at most 42 days) and any later read of a grid's days, such as stored calendar events, use this range.
 */
export function gridRange(month: string, bounds: MonthBounds): DateRange {
  const first = firstOf(month);
  const last = addDays(first, GRID_DAYS - 1);
  const start = `${bounds.first}-01`;
  return { from: first < start ? start : first, to: last > bounds.lastDay ? bounds.lastDay : last };
}

/**
 * What GET .../sales/days reads for a grid: its days before today, from the 8 weeks before its first day, whose same
 * weekdays give each day's typical guests (spec D32); null when no day of the range is past. At most 98 days.
 */
export function pastRangeFor(range: DateRange, today: string): DateRange | null {
  const yesterday = addDays(today, -1);
  const end = range.to < yesterday ? range.to : yesterday;
  return range.from > end ? null : { from: addDays(range.from, -TYPICAL_LOOKBACK_DAYS), to: end };
}

// Cells

/**
 * A month cell's fixed height, its figure's size and how many entry lines it shows (spec 16.3 P28), by window width
 * alone: a cell never grows with what it holds, so every month's grid is the same height.
 * [CONFIRM: 104px month cells with three entry lines]
 */
export function cellSize(width: number): { height: number; figure: number; lines: number } {
  if (width >= 1024) return { height: 104, figure: 22, lines: 3 };
  if (width > 640) return { height: 64, figure: 18, lines: 0 };
  return { height: 52, figure: 15, lines: 0 };
}

/** The weekday row (16px), then 6 rows, 3px apart. */
export const WEEKDAY_ROW = 16;
export const CELL_GAP = 3;

/** The month grid's height at `width`: 658px from 1024px, 418px from 641px, 346px below. */
export function gridHeight(width: number): number {
  return WEEKDAY_ROW + 6 * cellSize(width).height + 6 * CELL_GAP;
}

/** What a month cell's entry rows show: every entry when there are three or fewer, else the first two and “+N more”. */
export function entryLines(cell: Pick<CalendarCell, 'chips' | 'more'>): { lines: string[]; more: string | null } {
  if (cell.more === 0) return { lines: cell.chips, more: null };
  return { lines: cell.chips.slice(0, 2), more: `+${String(cell.more + cell.chips.length - 2)} more` };
}

/**
 * A day in the grid. `outside`: in the month before or after the grid's, shown muted with its own data. `pending`: the
 * kept reads don't cover it yet (a month change whose reads are in flight), so it shows its number only, still focusable.
 */
export interface DayCell extends CalendarCell { kind: 'day'; outside: boolean; pending: boolean }

/** A grid day outside the 25 months the page shows: its number only, never read, selected or hovered. */
export interface InertCell { kind: 'inert'; date: string; label: string }

export type GridSlot = DayCell | InertCell;

/** A grid's slot; a plain CalendarCell is an in-month day its reads cover. */
export function slotOf(cell: CalendarCell | GridSlot): GridSlot {
  return 'kind' in cell ? cell : { ...cell, kind: 'day', outside: false, pending: false };
}

function pendingCell(date: string, input: CalendarInput, outside: boolean): DayCell {
  const monday = mondayOf(input.today);
  return {
    kind: 'day', outside, pending: true, date, isToday: date === input.today, inWeek: date >= monday && date <= addDays(monday, 6),
    status: null, figure: null, noteGuests: 0, chips: [], more: 0, marks: { event: false, note: false, imported: false },
    label: `${shortDate(date)}. Loading.`,
  };
}

/**
 * The month's grid as 6 rows of 7 slots. The days `input`'s reads cover (gridRange of its own month, which lags the
 * grid's while a month change reads) show their data; the rest of the 25 months are pending; the days past them, inert.
 */
export function buildGrid(month: string, input: CalendarInput, bounds: MonthBounds): GridSlot[][] {
  const covered = gridRange(input.month, bounds);
  const start = `${bounds.first}-01`;
  const slots = gridDays(month).map((date): GridSlot => {
    if (date < start || date > bounds.lastDay) return { kind: 'inert', date, label: `${shortDate(date)}. Outside the months the calendar shows.` };
    const outside = date.slice(0, 7) !== month;
    if (date < covered.from || date > covered.to) return pendingCell(date, input, outside);
    return { ...dayCell(date, input), kind: 'day', outside, pending: false };
  });
  return Array.from({ length: 6 }, (_, row) => slots.slice(row * 7, row * 7 + 7));
}

// Keys

/** The day a key selects, and for PageUp and PageDown the month the grid then shows; null otherwise. */
export interface GridMove { date: string; month: string | null }

/**
 * The month grid's keys (spec 16.3 P28): Left and Right a day and Up and Down a week, across rows and months; Home and
 * End the row's Monday and Sunday; with Ctrl or Cmd, the grid month's first and last day; PageUp and PageDown the grid's
 * month before or after (as the APG date picker, from the grid's month, since the selected day can be a leading or
 * trailing one), on the same day number clamped to that month's length. A move whose target is outside the 25 months is
 * consumed, `{ date: from, month: null }`; Home and End clamp to them instead. Null for a key it doesn't handle.
 */
export function gridMove(from: string, key: string, ctrl: boolean, at: { layout: 'month'; month: string; bounds: MonthBounds }): GridMove | null {
  const start = `${at.bounds.first}-01`;
  const end = at.bounds.lastDay;
  const stay: GridMove = { date: from, month: null };
  const step = (days: number): GridMove => {
    const date = addDays(from, days);
    return date < start || date > end ? stay : { date, month: null };
  };
  const clamp = (date: string): GridMove => ({ date: date < start ? start : date > end ? end : date, month: null });
  const page = (by: -1 | 1): GridMove => {
    const month = stepMonth(at.month, by);
    if (month < at.bounds.first || month > at.bounds.last) return stay;
    const last = monthRange(month).to;
    const date = `${month}-${from.slice(8, 10)}`;
    return { date: date > last ? last : date, month };
  };
  switch (key) {
    case 'ArrowLeft': return step(-1);
    case 'ArrowRight': return step(1);
    case 'ArrowUp': return step(-7);
    case 'ArrowDown': return step(7);
    case 'Home': return clamp(ctrl ? `${at.month}-01` : mondayOf(from));
    case 'End': return clamp(ctrl ? monthRange(at.month).to : addDays(mondayOf(from), 6));
    case 'PageUp': return page(-1);
    case 'PageDown': return page(1);
    default: return null;
  }
}
