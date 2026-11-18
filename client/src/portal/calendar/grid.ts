import type { TownEvent } from '../analytics/api';
import { TYPICAL_LOOKBACK_DAYS } from '../analytics/days';
import { dayMonthRange, EVENT_WORDS, mondayOf } from '../analytics/week';
import { shortDate } from '../analytics/words';
import { formatDate } from '../format';
import { addDays, daysBetween, monthRange } from '../locations/dates';
import { hoursLine } from '../locations/noteRules';
import {
  captionOf, dayCell, dayView, eventsOn, noteChip, rangeWords, stepMonth, type CalendarCell, type CalendarDayView, type CalendarInput, type monthBounds,
} from './model';

// The Calendar's grid (P28, spec 16.3), pure: the one place that says which dates a month view and a week view show
// and what the page reads for them. A month is always 42 days in 6 rows, from the Monday on or before its 1st, so the
// grid never changes height; the days before the 1st and after the last day are the months either side, shown muted
// with their own data. A week is the 7-day block counted from today that holds the selected day, so it starts on any
// weekday. Every date is a 'YYYY-MM-DD' string moved in UTC (locations/dates.ts), so a daylight saving change never
// shifts one.

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
 * What a read of the month's grid covers: its 42 days clamped to the first day of the first shown month and the last
 * day of the last, which keeps each read within 396 days of today, inside the API's 400.
 */
export function gridRange(month: string, bounds: MonthBounds): DateRange {
  const first = firstOf(month);
  const last = addDays(first, GRID_DAYS - 1);
  const start = `${bounds.first}-01`;
  return { from: first < start ? start : first, to: last > bounds.lastDay ? bounds.lastDay : last };
}

/** A week's 7 days from `start`, clamped to the 25 months: the days of it the page can read. */
export function weekRange(start: string, bounds: MonthBounds): DateRange {
  const first = `${bounds.first}-01`;
  const last = addDays(start, 6);
  return { from: start < first ? first : start, to: last > bounds.lastDay ? bounds.lastDay : last };
}

/**
 * What every read of the page covers (the town calendar, the sales days through pastRangeFor, the stored calendar
 * events and the forecast, one request of at most 42 days each): the grid's range in the month view, and in the week
 * view too while the week's days inside the 25 months (weekRange, not its raw 7 days, which at the range's ends run past
 * the grid) lie inside it, so switching views reads nothing; else the week's own days, which run past the grid.
 */
export function readRangeFor(view: 'month' | 'week', month: string, weekStart: string, bounds: MonthBounds): DateRange {
  const grid = gridRange(month, bounds);
  if (view === 'month') return grid;
  const week = weekRange(weekStart, bounds);
  return week.from >= grid.from && week.to <= grid.to ? grid : week;
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
 * A day in the grid. `outside`: in the month before or after the grid's, shown muted with its own data (never in the
 * week view, which shows no month). `pending`: the kept reads don't cover it yet (a month or week change whose reads are
 * in flight), so it shows its number only, still focusable.
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
 * One day of the grid for `month` (null in the week view, where no day is outside): inert past the 25 months, pending
 * outside the range `input`'s reads cover, else the day from `input`.
 */
function slotFor(date: string, month: string | null, input: CalendarInput, bounds: MonthBounds): GridSlot {
  if (date < `${bounds.first}-01` || date > bounds.lastDay) return { kind: 'inert', date, label: `${shortDate(date)}. Outside the months the calendar shows.` };
  const outside = month !== null && date.slice(0, 7) !== month;
  if (date < input.covered.from || date > input.covered.to) return pendingCell(date, input, outside);
  return { ...dayCell(date, input), kind: 'day', outside, pending: false };
}

/**
 * The month's grid as 6 rows of 7 slots. The days `input`'s reads cover (`input.covered`, which lags the grid's range
 * while a month change reads) show their data; the rest of the 25 months are pending; the days past them, inert.
 */
export function buildGrid(month: string, input: CalendarInput, bounds: MonthBounds): GridSlot[][] {
  const slots = gridDays(month).map((date) => slotFor(date, month, input, bounds));
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

/** A day of the week view: the month cell's words, its cards, and its head's range. */
export interface WeekDay extends DayCell {
  cards: WeekCard[];
  /** “180 to 240” on an open forecast day, as the tooltip's parenthesis and the panel's “Likely 180 to 240” word it. */
  range: string | null;
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

/**
 * A term or season repeats on most days of its weeks, so its card is compact: its title and kind words on one run,
 * which wraps as every card's words do (refine-calendar-and-home design decision 3).
 */
export function periodCard(card: Pick<WeekCard, 'kind'>): boolean {
  return card.kind === 'term' || card.kind === 'season';
}

/**
 * A day's cards in short sentences, the words its web column's description reads: each card's hours when timed and
 * its title, then its kind words (“6 pm to 9 pm, Private event, 70. Your note.”); null with no cards. A native agenda
 * row is one accessible element, so its cards are heard only through this, as its hint.
 */
export function cardWords(cards: readonly WeekCard[]): string | null {
  if (cards.length === 0) return null;
  const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
  return cards.map((card) => `${sentence(card.hours === null ? card.title : `${card.hours}, ${card.title}`)} ${sentence(card.sub)}`).join(' ');
}

/** A day's head in the week view: “Mon 16”, or “Tue Dec 1” on a month's 1st. */
export function weekHead(date: string): string {
  const day = Number(date.slice(8, 10));
  return `${shortDate(date).slice(0, 3)} ${day === 1 ? formatDate(date).replace(/, \d{4}$/, '') : String(day)}`;
}

/**
 * The head's last line: the range, or the caption under a past figure (“guests”, or “forecast” on a day with no stored
 * guests), or nothing. A day the forecast read doesn't cover says so in its status word (“No forecast”).
 */
export function headLine(day: Pick<WeekDay, 'range' | 'figure'>): string | null {
  if (day.range !== null) return day.range;
  return day.figure?.kind === 'actual' || day.figure?.kind === 'past_forecast' ? captionOf(day) : null;
}

/**
 * The week the page shows (weekStartFor: the 7-day block from today that holds `selected`), each day with its cards.
 * The days `input`'s reads cover show their data, the rest of the 25 months are pending, the days past them inert;
 * inert and pending days have no cards.
 */
export function buildWeek(selected: string, today: string, input: CalendarInput, bounds: MonthBounds): WeekSlot[] {
  return weekDays(weekStartFor(selected, today)).map((date): WeekSlot => {
    const slot = slotFor(date, null, input, bounds);
    if (slot.kind === 'inert') return slot;
    if (slot.pending) return { ...slot, cards: [], range: null };
    const view = dayView(date, input);
    const { forecast } = view;
    return {
      ...slot, cards: weekCards(date, input, view), range: forecast.kind === 'open' ? rangeWords(forecast.low, forecast.high) : null,
    };
  });
}

// The week view: 7-day blocks counted from today, so with no `?day=` the week starts on today (refine-calendar-and-home
// design decision 4). The block shown is the one that holds the selected day, so a day click never moves the columns;
// it reads over the grid's range while it lies inside it, and its own days when it runs past (readRangeFor).

/** The first day of the 7-day block from today that holds `selected`: today plus 7 times the whole weeks between. */
export function weekStartFor(selected: string, today: string): string {
  return addDays(today, 7 * Math.floor(daysBetween(today, selected) / 7));
}

/** A week's 7 days from its first. */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** “Nov 15 to 21, 2026”, “Nov 29 to Dec 5, 2026”, or across a new year “Dec 27, 2026 to Jan 2, 2027”. */
export function weekLabel(start: string): string {
  const last = addDays(start, 6);
  if (start.slice(0, 4) !== last.slice(0, 4)) return `${formatDate(start)} to ${formatDate(last)}`;
  return `${dayMonthRange(start, last)}, ${last.slice(0, 4)}`;
}

/**
 * Previous week and Next week: the selected day 7 days back or forward, so a whole block, clamped to the 25 months;
 * null (the button disabled in place) when that block lies wholly outside them.
 */
export function stepWeek(selected: string, step: -1 | 1, bounds: MonthBounds, today: string): string | null {
  const start = `${bounds.first}-01`;
  const target = addDays(selected, 7 * step);
  const first = weekStartFor(target, today);
  if (addDays(first, 6) < start || first > bounds.lastDay) return null;
  return target < start ? start : target > bounds.lastDay ? bounds.lastDay : target;
}

// Keys

/** The day a key selects, and for PageUp and PageDown the month the grid then shows; null otherwise. */
export interface GridMove { date: string; month: string | null }

/** The month grid, the week view's day columns, or its agenda (a row per day: the web week view at 640px and below). */
export type GridLayout = 'month' | 'week' | 'agenda';

/** Where a key moves from: the month grid with the grid's month, or the week view with its block's first day. */
export type GridAt =
  | { layout: 'month'; month: string; bounds: MonthBounds }
  | { layout: 'week' | 'agenda'; weekStart: string; bounds: MonthBounds };

/**
 * The keys of the month grid and the week view (spec 16.3 P28): Left and Right a day, across rows, weeks, blocks and
 * months; Up and Down a week (a day in the agenda, whose rows are days); Home and End the row's Monday and Sunday in
 * the month grid and the block's first and last day in the week view; with Ctrl or Cmd, in the month grid the grid
 * month's first and last day, in the week view the same as without; PageUp and PageDown a month before or after (as
 * the APG date picker), on the same day number clamped to that month's length: in the month grid from the grid's
 * month, since the selected day can be a leading or trailing one, and in the week view, which hides the grid's month,
 * from the selected day's own. A move whose target is outside the 25 months is consumed, `{ date: from, month: null }`;
 * Home and End clamp to them instead. Null for a key it doesn't handle.
 */
export function gridMove(from: string, key: string, ctrl: boolean, at: GridAt): GridMove | null {
  const start = `${at.bounds.first}-01`;
  const end = at.bounds.lastDay;
  const stay: GridMove = { date: from, month: null };
  const step = (days: number): GridMove => {
    const date = addDays(from, days);
    return date < start || date > end ? stay : { date, month: null };
  };
  const clamp = (date: string): GridMove => ({ date: date < start ? start : date > end ? end : date, month: null });
  const page = (by: -1 | 1): GridMove => {
    const month = stepMonth(at.layout === 'month' ? at.month : from.slice(0, 7), by);
    if (month < at.bounds.first || month > at.bounds.last) return stay;
    const last = monthRange(month).to;
    const date = `${month}-${from.slice(8, 10)}`;
    return { date: date > last ? last : date, month };
  };
  // The first day Home goes to and End's 6 days on: the month grid's row (its grid month with Ctrl or Cmd), or the block.
  const home = at.layout !== 'month' ? at.weekStart : ctrl ? `${at.month}-01` : mondayOf(from);
  const row = at.layout === 'agenda' ? 1 : 7;
  switch (key) {
    case 'ArrowLeft': return step(-1);
    case 'ArrowRight': return step(1);
    case 'ArrowUp': return step(-row);
    case 'ArrowDown': return step(row);
    case 'Home': return clamp(home);
    case 'End': return clamp(at.layout === 'month' && ctrl ? monthRange(at.month).to : addDays(home, 6));
    case 'PageUp': return page(-1);
    case 'PageDown': return page(1);
    default: return null;
  }
}
