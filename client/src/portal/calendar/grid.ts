import type { TownEvent } from '../analytics/api';
import { TYPICAL_LOOKBACK_DAYS } from '../analytics/days';
import { dayMonthRange, EVENT_WORDS, mondayOf, weekDates } from '../analytics/week';
import { shortDate } from '../analytics/words';
import { formatDate } from '../format';
import { addDays, monthRange } from '../locations/dates';
import { hoursLine } from '../locations/noteRules';
import {
  dayCell, dayView, eventsOn, noteChip, rangeWords, stepMonth, type CalendarCell, type CalendarDayView, type CalendarInput, type monthBounds,
} from './model';

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

/** One day of the grid for `month`: inert past the 25 months, pending outside `covered`, else the day from `input`. */
function slotFor(date: string, month: string, input: CalendarInput, bounds: MonthBounds, covered: DateRange): GridSlot {
  if (date < `${bounds.first}-01` || date > bounds.lastDay) return { kind: 'inert', date, label: `${shortDate(date)}. Outside the months the calendar shows.` };
  const outside = date.slice(0, 7) !== month;
  if (date < covered.from || date > covered.to) return pendingCell(date, input, outside);
  return { ...dayCell(date, input), kind: 'day', outside, pending: false };
}

/**
 * The month's grid as 6 rows of 7 slots. The days `input`'s reads cover (gridRange of its own month, which lags the
 * grid's while a month change reads) show their data; the rest of the 25 months are pending; the days past them, inert.
 */
export function buildGrid(month: string, input: CalendarInput, bounds: MonthBounds): GridSlot[][] {
  const covered = gridRange(input.month, bounds);
  const slots = gridDays(month).map((date) => slotFor(date, month, input, bounds, covered));
  return Array.from({ length: 6 }, (_, row) => slots.slice(row * 7, row * 7 + 7));
}

/** What a week card is: a holiday, town event, term or season, a note, a business rule, or an imported event. */
export type WeekCardKind = TownEvent['kind'] | 'note' | 'rule' | 'imported';

/** One item of a day in the week view: every item gets a card, all-day ones first (weekCards). */
export interface WeekCard {
  key: string;
  kind: WeekCardKind;
  /** “9 am to 10 am” on a timed item; null all day. */
  hours: string | null;
  /** A note's chip words, a rule's text, an event's title, in full. */
  title: string;
  /** The kind words (“Town event”, “Federal holiday”, “Your note”, “Your calendar”, a rule's schedule summary), with a multi-day item's span. */
  sub: string;
}

/** A day of the week view: the month cell's words, its cards, and its head's range, or “No forecast” once the read answered without it. */
export interface WeekDay extends DayCell {
  cards: WeekCard[];
  /** “180 to 240” on an open forecast day, as the tooltip's parenthesis and the panel's “Likely 180 to 240” word it. */
  range: string | null;
  /** The forecast read answered and doesn't cover the day; false while it loads or after a failure. */
  noForecast: boolean;
}

export type WeekSlot = WeekDay | InertCell;

/** All-day cards in this order; then the timed ones by start time, end time and title. */
const ALL_DAY_ORDER: Readonly<Record<WeekCardKind, number>> = { holiday: 0, event: 1, note: 2, rule: 3, imported: 4, term: 5, season: 6 };

function withSpan(words: string, start: string, end: string | null): string {
  return end === null || end === start ? words : `${words}, ${dayMonthRange(start, end)}`;
}

interface Timed extends WeekCard { start: string; end: string }

/**
 * The day's cards. Events come from eventsOn, not the panel's list, which leaves out the holidays and town events Why
 * names: those are what move the forecast. Notes, rules (whatever the filters) and imported events are the panel's.
 */
function weekCards(date: string, input: CalendarInput, view: CalendarDayView): WeekCard[] {
  const timed = (card: WeekCard, times: { startTime?: string | null | undefined; endTime?: string | null | undefined }): WeekCard | Timed => {
    const hours = hoursLine(times);
    return hours === null ? card : { ...card, hours, start: times.startTime ?? '', end: times.endTime ?? '' };
  };
  const cards: (WeekCard | Timed)[] = [
    ...eventsOn(date, input).map((event, at): WeekCard => ({
      key: `event:${String(at)}:${event.id}`, kind: event.kind, hours: null, title: event.title,
      sub: withSpan(event.kind === 'holiday' && event.scope === 'national' ? 'Federal holiday' : EVENT_WORDS[event.kind], event.start, event.end),
    })),
    ...view.notes.map((note) => timed({ key: `note:${note.id}`, kind: 'note', hours: null, title: noteChip(note), sub: withSpan('Your note', note.startDate, note.endDate) }, note)),
    // A rule's end date may be null, so its schedule summary says when it runs rather than a span.
    ...view.rules.map((rule) => timed({ key: `rule:${rule.id}`, kind: 'rule', hours: null, title: rule.text, sub: rule.scheduleSummary ?? 'Your rule' }, rule.schedule ?? {})),
    ...view.imported.map((event, at) => timed({
      key: `imported:${String(at)}:${event.uid}`, kind: 'imported', hours: null, title: event.title, sub: withSpan('Your calendar', event.startDate, event.endDate),
    }, event)),
  ];
  const allDay = cards.filter((card) => !('start' in card)).sort((a, b) => ALL_DAY_ORDER[a.kind] - ALL_DAY_ORDER[b.kind]);
  const byTime = cards.filter((card): card is Timed => 'start' in card)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title));
  return [...allDay, ...byTime].map(({ key, kind, hours, title, sub }) => ({ key, kind, hours, title, sub }));
}

/** A card's 2px left rule, a theme token: a holiday or town event `white`, a note or rule `text2`, an imported event `mint`, a period `line`. */
export const CARD_MARK: Readonly<Record<WeekCardKind, 'white' | 'text2' | 'mint' | 'line'>> = {
  holiday: 'white', event: 'white', note: 'text2', rule: 'text2', imported: 'mint', term: 'line', season: 'line',
};

/** A term or season repeats on most days of its weeks, so its card is one line. */
export function periodCard(card: Pick<WeekCard, 'kind'>): boolean {
  return card.kind === 'term' || card.kind === 'season';
}

/** A day's head in the week view: “Mon 16”, or “Tue Dec 1” on a month's 1st. */
export function weekHead(date: string): string {
  const day = Number(date.slice(8, 10));
  return `${shortDate(date).slice(0, 3)} ${day === 1 ? formatDate(date).replace(/, \d{4}$/, '') : String(day)}`;
}

/** The head's last line: the range, “guests” under a past figure, “No forecast” once the read answered without it, or nothing. */
export function headLine(day: Pick<WeekDay, 'range' | 'figure' | 'noForecast'>): string | null {
  if (day.range !== null) return day.range;
  if (day.figure?.kind === 'actual') return 'guests';
  return day.noForecast ? 'No forecast' : null;
}

/**
 * The selected day's week, Monday to Sunday, as the shown grid's slots (it is always one of the grid's rows, so
 * `month` is the grid's), each day with its cards. Inert and pending days have none.
 */
export function buildWeek(selected: string, month: string, input: CalendarInput, bounds: MonthBounds): WeekSlot[] {
  const covered = gridRange(input.month, bounds);
  return weekOf(selected).map((date): WeekSlot => {
    const slot = slotFor(date, month, input, bounds, covered);
    if (slot.kind === 'inert') return slot;
    if (slot.pending) return { ...slot, cards: [], range: null, noForecast: false };
    const view = dayView(date, input);
    const { forecast } = view;
    return {
      ...slot, cards: weekCards(date, input, view), range: forecast.kind === 'open' ? rangeWords(forecast.low, forecast.high) : null,
      noForecast: forecast.kind === 'none' && forecast.why === 'not_covered',
    };
  });
}

// The week view (step 2): the selected day's week, always one of the shown grid's rows, so it reads nothing of its own.

/** The selected day's week, Monday to Sunday. */
export function weekOf(date: string): string[] {
  return weekDates(mondayOf(date));
}

/** “Nov 16 to 22, 2026”, “Nov 30 to Dec 6, 2026”, or across a new year “Dec 28, 2026 to Jan 3, 2027”. */
export function weekLabel(monday: string): string {
  const sunday = addDays(monday, 6);
  if (monday.slice(0, 4) !== sunday.slice(0, 4)) return `${formatDate(monday)} to ${formatDate(sunday)}`;
  return `${dayMonthRange(monday, sunday)}, ${sunday.slice(0, 4)}`;
}

/**
 * Previous week and Next week: the selected day 7 days back or forward, clamped to the 25 months; null (the button
 * disabled in place) when that week lies wholly outside them.
 */
export function stepWeek(selected: string, step: -1 | 1, bounds: MonthBounds): string | null {
  const start = `${bounds.first}-01`;
  const target = addDays(selected, 7 * step);
  const week = weekOf(target);
  if ((week[6] ?? target) < start || (week[0] ?? target) > bounds.lastDay) return null;
  return target < start ? start : target > bounds.lastDay ? bounds.lastDay : target;
}

// Keys

/** The day a key selects, and for PageUp and PageDown the month the grid then shows; null otherwise. */
export interface GridMove { date: string; month: string | null }

/** The month grid, the week view's day columns, or its agenda (a row per day: the web week view at 640px and below). */
export type GridLayout = 'month' | 'week' | 'agenda';

/**
 * The keys of the month grid and the week view (spec 16.3 P28): Left and Right a day, across rows, weeks and months; Up
 * and Down a week (a day in the agenda, whose rows are days); Home and End the row's (the week's) Monday and Sunday;
 * with Ctrl or Cmd, in the month grid the grid month's first and last day, in the week view the same as without;
 * PageUp and PageDown a month before or after (as the APG date picker), on the same day number clamped to that month's
 * length: in the month grid from the grid's month, since the selected day can be a leading or trailing one, and in the
 * week view, which hides the grid's month, from the selected day's own. A move whose target is outside the 25 months is
 * consumed, `{ date: from, month: null }`; Home and End clamp to them instead. Null for a key it doesn't handle.
 */
export function gridMove(from: string, key: string, ctrl: boolean, at: { layout: GridLayout; month: string; bounds: MonthBounds }): GridMove | null {
  const start = `${at.bounds.first}-01`;
  const end = at.bounds.lastDay;
  const stay: GridMove = { date: from, month: null };
  const step = (days: number): GridMove => {
    const date = addDays(from, days);
    return date < start || date > end ? stay : { date, month: null };
  };
  const clamp = (date: string): GridMove => ({ date: date < start ? start : date > end ? end : date, month: null });
  const monthKeys = at.layout === 'month';
  const page = (by: -1 | 1): GridMove => {
    const month = stepMonth(monthKeys ? at.month : from.slice(0, 7), by);
    if (month < at.bounds.first || month > at.bounds.last) return stay;
    const last = monthRange(month).to;
    const date = `${month}-${from.slice(8, 10)}`;
    return { date: date > last ? last : date, month };
  };
  const row = at.layout === 'agenda' ? 1 : 7;
  switch (key) {
    case 'ArrowLeft': return step(-1);
    case 'ArrowRight': return step(1);
    case 'ArrowUp': return step(-row);
    case 'ArrowDown': return step(row);
    case 'Home': return clamp(ctrl && monthKeys ? `${at.month}-01` : mondayOf(from));
    case 'End': return clamp(ctrl && monthKeys ? monthRange(at.month).to : addDays(mondayOf(from), 6));
    case 'PageUp': return page(-1);
    case 'PageDown': return page(1);
    default: return null;
  }
}
