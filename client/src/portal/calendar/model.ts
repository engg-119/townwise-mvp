import { formatCount, formatDate, plural } from '../format';
import type { TownEvent } from '../analytics/api';
import { mondayOf, weekDates } from '../analytics/cells';
import { closureOf, likelyClosedWords, noteCovers, typicalGuests } from '../analytics/days';
import { metricText, MONTH_NAMES, shortDate, type Metric } from '../analytics/words';
import { appliedOf, guestsFromWords, yoursDid, type ForecastDay, type ForecastReason, type ForecastWindow, type ReasonEffect } from '../estimates/api';
import type { Note, SalesDay } from '../locations/api';
import { addDays, isCalendarDate, monthRange } from '../locations/dates';
import type { Rule } from '../rules/api';
import { compactEntries, dayEntries, filterOf, fitLines, noteChip, notNamed, type DayEntry } from './entries';
import type { DateRange } from './grid';

export { filterOf, noteChip };

// The Calendar's pure model (P28, spec 16.3): the month as week rows with each day's figure,
// status, chips, corner marks and screen-reader label; the selected day's panel (its forecast, the reasons, and what
// is on the calendar); the hover tooltip's lines; the filters; and the 25 months the page can show. Every figure
// from today on is the published forecast's own, as the API's read leaves it after the location's notes (spec
// 14.5): this file never adds a note's guests, so the rule lives once, in api/src/forecasts/adjust.ts. A day before
// today shows its stored guests, or “Likely closed” when they were under a tenth of its weekday's typical guests (spec
// D32, analytics/days.ts); with none stored, the forecast made for it, captioned “forecast”. Data wins over a forecast
// and every day shows something: “No data” or “No forecast” once the forecast read answered (figureOf). Forecast figures are rounded here, the middle figure to the nearest
// guest and a range's low down and high up (spec 14.4, as TownwiseAI's get_forecast); the range always goes with the
// middle figure in the label, the tooltip and the panel ([CONFIRM] in spec 14.2), and the "8 in 10" sentence only
// with the model's own range, since a range a note moved is no longer the model's 80% one. Business rules with a
// schedule (D31) change the forecast as notes do, in the API's read: their reasons show like a note's, guests they add
// are named as theirs, and the panel lists the rules covering the day (no filter hides them; they are edited on Rules).
// Why (spec 14.4, P28): each reason has a signed size in percent (reasonSize: a run reason's effect, the API's, from the
// model or the location's own history; a note's or a rule's outcome held against the model's middle figure), and Why
// runs from the largest rise to the largest fall, the reasons at 0 or with no size between (inOrder). Each says in
// words what it does to guests, after a ▲, ▼ or = colored by its size's grade (the theme's effect ramp), so the mark
// never stands alone. A day before today has no sizes and keeps the read's order. On the calendar leaves out a holiday,
// event or term Why already names. The tooltip and Home's day detail take the three largest either way, in Why's order
// and short words (shortReasons).
// An outlook day (D52: after its run's forecast tier, more than 3 months after the run was made or 6 months after its
// last sales) shows its middle figure marked "Outlook", says "Outlook about ..." in its label and tooltip, heads its
// panel part "Outlook" and never claims 8 in 10, since no location's outlook has had that measured; a key line under the grid says what an
// outlook is whenever a shown day is one (outlookKey). [CONFIRM: the outlook's words on the Calendar, Home and
// TownwiseAI's visuals: a cell's middle figure marked "Outlook", its range in the day panel, and no "8 in 10" claim
// for an outlook day]

/** The filter chips, in toolbar order. `imported` ("Your calendar") shows only when the location has a calendar. */
export const FILTER_KEYS = ['holidays', 'events', 'terms', 'notes', 'imported'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Readonly<Record<FilterKey, boolean>>;
export const FILTER_LABEL: Readonly<Record<FilterKey, string>> = {
  holidays: 'Holidays', events: 'Town events', terms: 'Term dates', notes: 'Your notes', imported: 'Your calendar',
};
export const ALL_FILTERS: Filters = { holidays: true, events: true, terms: true, notes: true, imported: true };

/**
 * An event from one of the location's own calendars, as the API keeps it (spec 17, D33; GET .../owner-calendars/events).
 * A UID can repeat across calendars (the same export imported twice), so `{calendarId}:{uid}` is what keys one.
 */
export interface ImportedEvent {
  calendarId: string;
  /** Its calendar's name, which the events read always carries (“Google calendar” under view-as, D39). */
  calendar?: string | undefined;
  uid: string;
  title: string;
  startDate: string;
  endDate: string;
  /**
   * The town's 'HH:MM', only when the event starts and ends on the same day, or ends by 06:00 the next morning
   * (api/src/calendar/ics.ts), when endTime is before startTime.
   */
  startTime: string | null;
  endTime: string | null;
}

export interface CalendarInput {
  today: string;
  /** The range the reads were made for (grid.ts readRangeFor): the days they cover, which lag the shown ones while a new range reads. */
  covered: DateRange;
  /** The range's forecast read; null while it loads or when it failed. */
  forecast: ForecastWindow | null;
  /** The stored days of the range's past part, and of the 8 weeks before it that likely closed reads (grid.ts pastRangeFor). */
  salesDays: readonly SalesDay[];
  events: readonly TownEvent[];
  notes: readonly Note[];
  /** The location's business rules (D31); Home passes the same rules for its tooltip. */
  rules?: readonly Rule[];
  /** The range's stored events from the location's own calendars; none when their read failed. */
  imported: readonly ImportedEvent[];
  filters: Filters;
}


/** The day's holidays, town events and term periods as the filters allow, including those the day's Why names. */
export function eventsOn(date: string, input: CalendarInput): TownEvent[] {
  return input.events.filter((event) => event.start <= date && date <= event.end && input.filters[filterOf(event)]);
}

/** The rules whose schedule covers the day, oldest first. */
function rulesOn(date: string, input: CalendarInput): Rule[] {
  return (input.rules ?? []).filter((rule) => rule.schedule !== null && rule.schedule !== undefined && noteCovers(rule.schedule, date));
}

function forecastDayOf(date: string, input: CalendarInput): ForecastDay | null {
  return input.forecast?.days.find((day) => day.date === date) ?? null;
}

function storedGuests(date: string, input: CalendarInput): number | null {
  return input.salesDays.find((day) => day.date === date)?.guests ?? null;
}

/** A stored day's figure in `metric`: its guests, or its net sales in cents (Home, for a location with no stored guests). */
function storedValue(date: string, input: CalendarInput, metric: Metric): number | null {
  if (metric === 'guests') return storedGuests(date, input);
  return input.salesDays.find((day) => day.date === date)?.netSalesCents ?? null;
}

/**
 * A past day's stored guests when it was likely closed (spec D32), else null. Every note and rule schedule covering the
 * day counts, whatever the filters show: one with more or fewer guests says the day was open. Notes and rules go to
 * the shared check apart, so a note that decides the day sets a rule aside (D31), and a day on or after the town's
 * today is never likely closed.
 */
function likelyClosedGuests(date: string, input: CalendarInput): number | null {
  const day = input.salesDays.find((each) => each.date === date);
  if (day === undefined || day.guests === null) return null;
  const typical = typicalGuests(date, (other) => input.salesDays.find((each) => each.date === other)?.guests);
  const notes = input.notes.filter((note) => noteCovers(note, date));
  const rules = rulesOn(date, input).flatMap((rule) => (rule.schedule ? [rule.schedule] : []));
  return closureOf({ ...day, typicalGuests: typical }, notes, { rules, past: date < input.today }) === 'likely_closed' ? day.guests : null;
}

function whole(value: number): string {
  return formatCount(Math.round(value));
}

/** “180 to 240”: a range's low rounded down and its high up (spec 14.4). */
export function rangeWords(low: number, high: number): string {
  return `${formatCount(Math.floor(low))} to ${formatCount(Math.ceil(high))}`;
}


// Cells

export interface CellFigure {
  value: number;
  /**
   * forecast: the published day's middle figure; actual: stored guests; booked: a buyout's party; past_forecast: a day
   * before today with no stored guests, the run's middle figure for it.
   */
  kind: 'forecast' | 'actual' | 'booked' | 'past_forecast';
}

export interface CalendarCell {
  date: string;
  isToday: boolean;
  /** In today's week, which the grid outlines. */
  inWeek: boolean;
  /**
   * A day the forecast has closed or booked (before today, only when no guests were stored); before today, a
   * likely-closed day (spec D32); no_data, a day before today with neither stored guests nor a forecast; no_forecast,
   * from today on, a day the answered forecast read doesn't cover; outlook, from today on, an open day in its run's
   * outlook (D52), which keeps its figure.
   */
  status: 'closed' | 'booked' | 'likely_closed' | 'no_data' | 'no_forecast' | 'outlook' | null;
  figure: CellFigure | null;
  /** Guests the location's notes add to a forecast figure (“+70”); 0 when none. */
  noteGuests: number;
  /**
   * The first three of the day's compact entries (entries.ts: notes, rules, holidays and town events, imported events,
   * each title once across sources; grid.ts entryLines).
   */
  chips: string[];
  /** Entries past the chips. */
  more: number;
  /** event: a holiday or town event; note: one of yours, a note or a business rule; imported: from the location's calendars. */
  marks: { event: boolean; note: boolean; imported: boolean };
  /** What a screen reader hears: everything the cell shows, in words. */
  label: string;
}

const MAX_CHIPS = 3;

export interface FigureOf { status: CalendarCell['status']; figure: CellFigure | null; noteGuests: number; words: string | null }

function bookedWords(day: ForecastDay): string {
  if (!yoursDid(day, 'booked')) return 'Booked for a private event';
  return day.noteGuests > 0 ? `Booked: a private buyout, ${plural(day.noteGuests, 'guest', 'guests')}` : 'Booked: a private buyout';
}

const NO_FIGURE: FigureOf = { status: null, figure: null, noteGuests: 0, words: null };

// Actual or forecast (D49, design decision 10, owner 2026-11-18): every surface that shows a day's figure marks a
// forecast and leaves an actual plain, from these, so a future day and a past day with only the run's figure look the
// same. [CONFIRM: a forecast's figure is lighter with a leading "~" and the word "forecast"; an actual is a plain solid
// figure] The "~" is text, so the mark never rests on color alone and fits a phone cell where no word does.

export type FigureSource = 'actual' | 'forecast';

/** Stored data is the actual; a published day's figure, a past day's run figure and a buyout's expected party are forecasts. */
export function figureSource(figure: Pick<CellFigure, 'kind'>): FigureSource {
  return figure.kind === 'actual' ? 'actual' : 'forecast';
}

/** A figure as printed: “~82” for a forecast, “94” for an actual. */
export function markedFigure(text: string, figure: Pick<CellFigure, 'kind'>): string {
  return figureSource(figure) === 'forecast' ? `~${text}` : text;
}

/** The figure's theme color: an actual solid `white`, a forecast the lighter `text2`. */
export function figureTone(figure: Pick<CellFigure, 'kind'>): 'white' | 'text2' {
  return figureSource(figure) === 'forecast' ? 'text2' : 'white';
}

/** The word a surface prints beside a forecast's figure where it has room; an actual has none. */
export const FORECAST_TAG = 'forecast';

/** Each grid's key: its two entries, shown with a sample figure each (“94”, “~82”). */
export const FIGURE_KEY = { actual: 'Actual guests', forecast: 'Forecast' } as const;

/** What a screen reader hears for a figure, and the tooltip's words: “82 guests, forecast”, “94 guests, actual”. */
export function figureLabel(value: number, figure: Pick<CellFigure, 'kind'>, metric: Metric = 'guests'): string {
  if (figureSource(figure) === 'forecast') return `${plural(value, 'guest', 'guests')}, forecast`;
  return metric === 'guests' ? `${metricText(value, metric)}, actual` : `${metricText(value, metric)} in net sales, actual`;
}

/**
 * A day's figure: its stored data first, else the forecast made for it, else a word saying there is neither (owner
 * request, 2026-11-17: data wins over a forecast, and every day shows something). Before today that is the stored
 * guests or “Likely closed”, else the run's own figures for the day (the API leaves a past day as the run made it,
 * adjust.ts), else “No data”; from today on, the published forecast, else “No forecast”. The words wait for the
 * forecast read: while it loads or after it failed, a day with no data shows nothing rather than a word that may be wrong.
 * `metric` is Home's (D49, design decision 9): with net sales, a past day's stored value is its net sales in cents; the
 * fallbacks are the same guest figures, and likely closed stays guest-based. The Calendar always shows guests.
 */
export function figureOf(date: string, input: CalendarInput, metric: Metric = 'guests'): FigureOf {
  const day = forecastDayOf(date, input);
  if (date < input.today) {
    const likely = likelyClosedGuests(date, input);
    if (likely !== null) return { status: 'likely_closed', figure: null, noteGuests: 0, words: `${likelyClosedWords(plural(likely, 'guest', 'guests'))}.` };
    const stored = storedValue(date, input, metric);
    if (stored !== null) return { ...NO_FIGURE, figure: { value: stored, kind: 'actual' }, words: `${figureLabel(stored, { kind: 'actual' }, metric)}.` };
    if (day === null) return input.forecast === null ? NO_FIGURE : { ...NO_FIGURE, status: 'no_data', words: 'No data.' };
    if (day.status === 'closed') return { ...NO_FIGURE, status: 'closed', words: 'No data. Forecast closed.' };
    if (day.status === 'booked') return { ...NO_FIGURE, status: 'booked', words: `No data. ${bookedWords(day)}.` };
    if (day.mid === null || day.low === null || day.high === null) return { ...NO_FIGURE, status: 'no_data', words: 'No data.' };
    return {
      ...NO_FIGURE, figure: { value: Math.round(day.mid), kind: 'past_forecast' },
      words: `No data. ${figureLabel(Math.round(day.mid), { kind: 'past_forecast' })}, likely ${rangeWords(day.low, day.high)}.`,
    };
  }
  if (day === null) return input.forecast === null ? NO_FIGURE : { ...NO_FIGURE, status: 'no_forecast', words: 'No forecast.' };
  if (day.status === 'closed') return { status: 'closed', figure: null, noteGuests: 0, words: 'Closed.' };
  if (day.status === 'booked') {
    const figure: CellFigure | null = day.noteGuests > 0 ? { value: day.noteGuests, kind: 'booked' } : null;
    // A buyout's party is an expected count, so it is a forecast (decision 10).
    return { status: 'booked', figure, noteGuests: 0, words: `${bookedWords(day)}${figure === null ? '' : ', forecast'}.` };
  }
  if (day.mid === null || day.low === null || day.high === null) return { ...NO_FIGURE, status: 'no_forecast', words: 'No forecast.' };
  const words = [
    // An outlook day (D52) says so before its figure: “Outlook: 82 guests, forecast, likely 70 to 95.”
    `${day.outlook ? 'Outlook: ' : ''}${figureLabel(Math.round(day.mid), { kind: 'forecast' })}, likely ${rangeWords(day.low, day.high)}.`,
    day.noteGuests > 0 ? `Includes ${plural(day.noteGuests, 'guest', 'guests')} from ${guestsFromWords(day)}.` : null,
  ].filter((part) => part !== null).join(' ');
  return { status: day.outlook ? 'outlook' : null, figure: { value: Math.round(day.mid), kind: 'forecast' }, noteGuests: day.noteGuests, words };
}

function withStop(words: string): string {
  return /[.!?]$/.test(words) ? words : `${words}.`;
}

/** An entry as a screen reader hears it in a cell's label: its words, an imported event after “From your calendar”. */
export function entryLabel(entry: Pick<DayEntry, 'kind' | 'words'>): string {
  return withStop(entry.kind === 'imported' ? `From your calendar: ${entry.words}` : entry.words);
}

/**
 * One day's cell from the reads in `input`, whichever range they were made for; today's week comes from `input.today`.
 * Home's month grid builds its cells here too, in its own metric (figureOf).
 */
export function dayCell(date: string, input: CalendarInput, metric: Metric = 'guests'): CalendarCell {
  const monday = mondayOf(input.today);
  const all = dayEntries(date, input);
  const entries = compactEntries(all).map((entry) => entry.words);
  const found = figureOf(date, input, metric);
  const isToday = date === input.today;
  // The label says the status and every entry, with no dedupe.
  const label = [
    `${shortDate(date)}.`,
    isToday ? 'Today.' : null,
    found.words,
    ...all.map(entryLabel),
  ].filter((part) => part !== null).join(' ');
  return {
    date,
    isToday,
    inWeek: date >= monday && date <= addDays(monday, 6),
    status: found.status,
    figure: found.figure,
    noteGuests: found.noteGuests,
    chips: entries.slice(0, MAX_CHIPS),
    more: Math.max(0, entries.length - MAX_CHIPS),
    marks: {
      event: all.some((entry) => entry.kind === 'holiday' || entry.kind === 'event'),
      note: all.some((entry) => entry.kind === 'note' || entry.kind === 'rule'),
      imported: all.some((entry) => entry.kind === 'imported'),
    },
    label,
  };
}

/** The month ('YYYY-MM') as week rows, Monday first; null where a row's day is in another month. */
export function calendarMonth(month: string, input: CalendarInput): (CalendarCell | null)[][] {
  const { from, to } = monthRange(month);
  const rows: (CalendarCell | null)[][] = [];
  for (let start = mondayOf(from); start <= to; start = addDays(start, 7)) {
    rows.push(weekDates(start).map((date) => (date < from || date > to ? null : dayCell(date, input))));
  }
  return rows;
}

/** The word beside a figure: “forecast” for every forecast, past or future, booked or open; none for an actual (decision 10). */
export function captionOf(cell: Pick<CalendarCell, 'figure'>): string | null {
  return cell.figure === null || figureSource(cell.figure) === 'actual' ? null : FORECAST_TAG;
}

export function statusWord(status: CalendarCell['status']): string | null {
  switch (status) {
    case 'closed': return 'Closed';
    case 'booked': return 'Booked';
    case 'likely_closed': return 'Likely closed';
    case 'no_data': return 'No data';
    case 'no_forecast': return 'No forecast';
    case 'outlook': return 'Outlook';
    case null: return null;
  }
}

/**
 * Whether a cell shows its status word in its figure's place: every status but an outlook day's, which keeps its figure
 * (D52), and, from 641px, a booked day's, which says so in its top row over its party.
 */
export function statusTakesFigure(status: CalendarCell['status'], phone: boolean): boolean {
  if (status === null || status === 'outlook') return false;
  return phone || status !== 'booked';
}

/** The word in a cell's top row from 641px: a booked or outlook day's status word, else its figure's caption. */
export function topRightOf(cell: Pick<CalendarCell, 'status' | 'figure'>): string | null {
  return cell.status === 'booked' || cell.status === 'outlook' ? statusWord(cell.status) : captionOf(cell);
}

/** The key line under the grid when a shown day is an outlook day (D52). */
export const OUTLOOK_KEY = 'Days more than 3 months after Townwise’s forecast was made, or 6 months after the sales it learned from, show its outlook: a wider range that firms up as the weeks pass and your new sales come in.';

/** OUTLOOK_KEY when any of the shown cells is an outlook day; null otherwise. */
export function outlookKey(cells: readonly Pick<CalendarCell, 'status'>[]): string | null {
  return cells.some((cell) => cell.status === 'outlook') ? OUTLOOK_KEY : null;
}

// The day panel

/** What the Forecast part of the panel shows. */
export type ForecastPart =
  | {
    kind: 'open'; low: number; mid: number; high: number; noteGuests: number;
    /** An outlook day (D52): its part is headed “Outlook” and makes no 8 in 10 claim. */
    outlook: boolean;
    /** Whose those guests are: “your notes”, “your rules” or “your notes and rules”. */
    from: string;
    /** The model's own range when notes changed the day; null otherwise. */
    model: { low: number; high: number } | null;
    /** The model expected the day closed and the notes' private events opened it, with only their guests. */
    modelClosed: boolean;
  }
  /** `buyout`: a note's or a rule's buyout booked it, not the model. */
  | { kind: 'booked'; guests: number; buyout: boolean }
  /** `by`: what closed the day, a closure note, a business rule, or the model (null). */
  | { kind: 'closed'; by: 'note' | 'rule' | null }
  /**
   * Before today: the stored guests, whether they were so few the day was likely closed (spec D32), and the run's own
   * range and verdict when one covered the day.
   */
  | {
    kind: 'past'; actual: number | null; likelyClosed: boolean; model: { low: number; mid: number | null; high: number } | null; modelClosed: boolean;
    /** How the forecast did (forecastCheck); null otherwise. */
    check: ForecastCheck | null;
    /** The run may have read a note or rule written on or after the day, so it isn't compared with it (D49 as amended). */
    laterNote: boolean;
  }
  /** unavailable: the forecast read is loading or failed. */
  | { kind: 'none'; why: 'no_published_forecast' | 'not_covered' | 'unavailable' };

/** Before an effect's words: more guests, fewer, or about the same. */
export type EffectMark = '▲' | '▼' | '=';

/** A mark's color step by its size: 10 to 15% is 1, 20 to 35% 2, 40% and over 3 (theme effectUp1 to effectDown3). */
export type EffectGrade = 'up1' | 'up2' | 'up3' | 'down1' | 'down2' | 'down3';

export interface ReasonLine {
  key: string;
  label: string;
  /**
   * What the reason does to the day: a note's or a rule's outcome (“Adds 70 guests”), a run reason's effect
   * (“Usually about 35% more guests than your average day”), NO_HISTORY, or null (a day before today, or a kind the
   * history can't speak to, such as “Your recent level”).
   */
  detail: string | null;
  /**
   * ▲ for a size above 0 and ▼ below it, a note's or a rule's included; = for a run reason about the same; null at 0
   * otherwise, with no size or before today. Never the only sign: the words say the same.
   */
  mark: EffectMark | null;
  /** The ▲'s or ▼'s color step; null for =, and with no mark. */
  grade: EffectGrade | null;
  sources: readonly { label: string; url: string }[];
}

export interface CalendarDayView {
  date: string;
  /** “Today, Wed, Nov 11” or “Sat, Nov 21, 2026”. */
  heading: string;
  forecast: ForecastPart;
  /**
   * From the largest rise to the largest fall by their size (reasonSize, inOrder), the reasons at 0 or with none
   * between; a day before today's in the read's order.
   */
  reasons: ReasonLine[];
  /** Note reasons the API left out past its first 6. */
  moreNotes: number;
  /** Rule reasons the API left out past its first 6 (D31). */
  moreRules: number;
  /** Holidays, town events and term periods on the day, as the filters allow, less those Why already names. */
  events: TownEvent[];
  /** The day's holidays, town events and term periods left out of `events` because Why names them. */
  shownInWhy: number;
  notes: Note[];
  /** The business rules whose schedule covers the day (D31), whatever the filters. */
  rules: Rule[];
  imported: ImportedEvent[];
}

function forecastPart(date: string, input: CalendarInput): ForecastPart {
  const day = forecastDayOf(date, input);
  if (date < input.today) {
    const low = day?.model.low ?? null;
    const high = day?.model.high ?? null;
    const model = low !== null && high !== null ? { low, mid: day?.model.mid ?? null, high } : null;
    return {
      kind: 'past', actual: storedGuests(date, input) ?? day?.actual ?? null, likelyClosed: likelyClosedGuests(date, input) !== null, model,
      modelClosed: day?.model.status === 'closed', check: forecastCheck(day, input.today, input.forecast?.runs), laterNote: day?.laterNote === true,
    };
  }
  if (input.forecast === null) return { kind: 'none', why: 'unavailable' };
  if (!input.forecast.available) return { kind: 'none', why: input.forecast.reason ?? 'not_covered' };
  if (day === null) return { kind: 'none', why: 'not_covered' };
  if (day.status === 'closed') {
    const by = day.reasons.some((reason) => reason.note?.outcome === 'closed') ? 'note'
      : day.reasons.some((reason) => reason.rule?.outcome === 'closed') ? 'rule' : null;
    return { kind: 'closed', by };
  }
  if (day.status === 'booked') return { kind: 'booked', guests: day.noteGuests, buyout: yoursDid(day, 'booked') };
  if (day.low === null || day.mid === null || day.high === null) return { kind: 'none', why: 'not_covered' };
  const model = day.noteGuests > 0 && day.model.low !== null && day.model.high !== null ? { low: day.model.low, high: day.model.high } : null;
  return {
    kind: 'open', low: day.low, mid: day.mid, high: day.high, noteGuests: day.noteGuests, outlook: day.outlook, from: guestsFromWords(day), model,
    modelClosed: day.model.status === 'closed',
  };
}

/**
 * A note reason's outcome in words; null for an outcome this client doesn't know. `size` is the reason's (reasonSize):
 * a buyout's other than 0 says how its party compares with Townwise's model, since its mark's direction must be in the
 * words too.
 */
export function reasonOutcomeWords(outcome: string, guests: number | null, size = 0, of: 'note' | 'rule' = 'rule'): string | null {
  switch (outcome) {
    case 'added': return `Adds ${plural(guests ?? 0, 'guest', 'guests')}`;
    case 'booked': return size === 0 ? 'Books the day' : `Books the day: about ${String(Math.abs(size))}% ${size > 0 ? 'more' : 'fewer'} guests than Townwise’s model`;
    case 'closed': return 'Closes the day';
    case 'already_in_forecast': return 'Already in this forecast';
    case 'no_guest_count': return 'No guest count, so the forecast is unchanged';
    case 'not_counted': return 'Townwise only counts guests for private events so far';
    case 'day_closed': return 'The day is closed';
    case 'day_booked': return 'The day is booked';
    case 'past_day': return 'This day has passed';
    // A rule's closure or buyout on a day a note decides: the note wins (D31). D59: a TownwiseAI note on a day a note your
    // team made decides is set aside the same way.
    case 'overridden': return of === 'note' ? 'A note your team made on this day sets this TownwiseAI note aside' : 'A note on this day sets this rule aside';
    default: return null;
  }
}

/**
 * The panel's notice after a save (spec 16.3 P28): what the saved note did to the selected day, from the note's reason
 * in the forecast read again. “Saved.” when the day has no forecast, the note isn't among its reasons (moved to other
 * days, or past the six) or the outcome is one this client doesn't know. The page shows “Saved.” until that read answers.
 */
export function savedNotice(date: string, input: CalendarInput, noteId: string): string {
  const reason = forecastDayOf(date, input)?.reasons.find((each) => each.note?.id === noteId)?.note ?? null;
  const day = shortDate(date).replace(/, \d{4}$/, '');
  switch (reason?.outcome) {
    case 'added': return `Saved. The forecast for ${day} now includes its ${plural(reason.guests ?? 0, 'guest', 'guests')}.`;
    case 'booked': return `Saved. The forecast for ${day} now shows the day booked.`;
    case 'closed': return `Saved. The forecast for ${day} now shows the day closed.`;
    case 'already_in_forecast': return `Saved. The forecast for ${day} already includes this event.`;
    case 'no_guest_count': return 'Saved. Add a guest count to change the forecast.';
    case 'not_counted': return 'Saved. Townwise only counts guests for private events so far, so the forecast is unchanged.';
    case 'day_closed': return 'Saved. The day is closed, so the forecast is unchanged.';
    case 'day_booked': return 'Saved. The day is booked, so the forecast is unchanged.';
    case 'past_day': return 'Saved. This day has passed, so its forecast stays as it was made.';
    default: return 'Saved.';
  }
}

/** A run reason with no effect from today on, of a kind the location's history could speak to. */
export const NO_HISTORY = 'Not enough of your history to say yet';

/**
 * The run reason kinds the location's history speaks to, and what each is held against (api/src/forecasts/effects.ts).
 * A Map, so a kind named like an Object.prototype key ("constructor") reads as none.
 */
const AGAINST: ReadonlyMap<string, string> = new Map([
  ['weekday', 'your average day'],
  ['term', 'the same weekday at other times of the year'],
  ['holiday', 'the same weekday in the weeks around it'],
  ['event', 'the same weekday without it'],
]);

/** A reason's effect as the panel uses it: the API's, from today on only (a past day keeps the model's reasons as made). */
function effectOf(reason: ForecastReason, past: boolean): ReasonEffect | null {
  return past || appliedOf(reason) !== null ? null : reason.effect ?? null;
}

/**
 * An effect in words: “Usually about 35% more guests than your average day (210)”, “Last time, about 70% fewer guests
 * than the same weekday in the weeks around it” (one past occurrence is what happened, not what usually does), “Usually
 * about as many guests as your average day (1,210)”, or the model's own, “Townwise’s model: about 10% more guests”. The
 * average day's guests follow “your average day” only, and only when the API sent them.
 */
function effectWords(kind: string, effect: ReasonEffect): string {
  if (effect.basis === 'model') {
    return effect.direction === 'same' ? 'Townwise’s model: about the same number of guests' : `Townwise’s model: about ${String(effect.pct)}% ${effect.direction} guests`;
  }
  const lead = effect.days === 1 ? 'Last time,' : 'Usually';
  const named = AGAINST.get(kind);
  const against = named === undefined || kind !== 'weekday' || typeof effect.averageGuests !== 'number'
    ? named : `${named} (${formatCount(effect.averageGuests)})`;
  if (effect.direction === 'same') return against === undefined ? `${lead} about the same number of guests` : `${lead} about as many guests as ${against}`;
  return `${lead} about ${String(effect.pct)}% ${effect.direction} guests${against === undefined ? '' : ` than ${against}`}`;
}

/** A size in percent rounded to the nearest 5, as the API rounds an effect's; 0 at 5 or less either way, about the same. */
function stepped(pct: number): number {
  const size = Math.round(Math.abs(pct) / 5) * 5;
  return size <= 5 ? 0 : Math.sign(pct) * size;
}

/**
 * A reason's signed size in percent, from today on (forecast-why, “Each reason has a signed size”). A run reason with an
 * effect: +pct more, -pct fewer, 0 about the same. A note's or a rule's outcome, against the model's middle figure for
 * the day: `added` is its guests as a share of it, or +100 when the model has none (a day the model expected closed
 * that the note opened); `closed` is -100; `booked` is the party against it, +100 × (party ÷ middle - 1), or 0 without
 * either; any other outcome is 0. Both rounded as the API rounds an effect, so a note's 10 guests on a middle of 200 is
 * 0, not +5, and every size other than 0 is at least 10 either way. Null for a run reason with no effect, and for every
 * reason of a day before today.
 */
export function reasonSize(reason: ForecastReason, day: Pick<ForecastDay, 'model'>, past: boolean): number | null {
  if (past) return null;
  const applied = appliedOf(reason);
  if (applied === null) {
    const effect = effectOf(reason, past);
    if (effect === null) return null;
    return effect.direction === 'more' ? effect.pct : effect.direction === 'fewer' ? -effect.pct : 0;
  }
  const middle = day.model.mid !== null && day.model.mid > 0 ? day.model.mid : null;
  switch (applied.outcome) {
    case 'added': return middle === null ? 100 : stepped((100 * (applied.guests ?? 0)) / middle);
    case 'closed': return -100;
    // One division, so an exact half step stays exact: 100 × (215 ÷ 200 - 1) is 7.4999... in floating point, not 7.5.
    case 'booked': return middle === null || applied.guests === null ? 0 : stepped((100 * (applied.guests - middle)) / middle);
    default: return 0;
  }
}

/** A size's mark and grade: ▲ or ▼ graded by its size; = for a run reason at 0 (`run`); none otherwise. */
function markOf(size: number | null, run: boolean): { mark: EffectMark | null; grade: EffectGrade | null } {
  if (size === null || size === 0) return { mark: size === 0 && run ? '=' : null, grade: null };
  const big = Math.abs(size);
  if (size > 0) return { mark: '▲', grade: big < 20 ? 'up1' : big < 40 ? 'up2' : 'up3' };
  return { mark: '▼', grade: big < 20 ? 'down1' : big < 40 ? 'down2' : 'down3' };
}

interface Sized { reason: ForecastReason; index: number; size: number | null }

/**
 * Why's order (forecast-why, “Why runs from most positive to most negative”): the sizes above 0, largest first; then
 * the run's reasons about the same, the notes' and rules' at 0, and the run's with no effect, each group in the read's
 * order; then the sizes below 0, the smallest fall first. At an equal size either way notes and rules go first, then
 * the read's order. A day before today has no sizes, so it keeps the read's order.
 */
function inOrder(day: Pick<ForecastDay, 'reasons' | 'model'>, past: boolean): Sized[] {
  const sized = day.reasons.map((reason, index) => ({ reason, index, size: reasonSize(reason, day, past) }));
  const yours = (each: Sized): number => (appliedOf(each.reason) === null ? 0 : 1);
  const byEffect = (a: Sized, b: Sized): number => (b.size ?? 0) - (a.size ?? 0) || yours(b) - yours(a) || a.index - b.index;
  return [
    ...sized.filter((each) => (each.size ?? 0) > 0).sort(byEffect),
    ...sized.filter((each) => each.size === 0 && yours(each) === 0),
    ...sized.filter((each) => each.size === 0 && yours(each) === 1),
    ...sized.filter((each) => each.size === null),
    ...sized.filter((each) => (each.size ?? 0) < 0).sort(byEffect),
  ];
}

/**
 * Why's lines. A note reason's label stays made in code, with its note's title after it as the person's own words
 * (D30 as D49 amends it), joined by the reason's note id against `notes`.
 */
function reasonLines(day: ForecastDay | null, past: boolean, notes: readonly Note[]): ReasonLine[] {
  if (day === null) return [];
  return inOrder(day, past).map(({ reason, index, size }): ReasonLine => {
    const applied = appliedOf(reason);
    const effect = effectOf(reason, past);
    const title = noteTitleOf(reason, notes);
    const label = title === null ? reason.label : `${reason.label}: ${title}`;
    const line = { key: `${String(index)}:${reason.kind}`, label, sources: reason.sources, ...markOf(size, applied === null) };
    if (applied !== null) return { ...line, detail: reasonOutcomeWords(applied.outcome, applied.guests, size ?? 0, reason.note == null ? 'rule' : 'note') };
    if (effect !== null) return { ...line, detail: effectWords(reason.kind, effect) };
    return { ...line, detail: !past && AGAINST.has(reason.kind) ? NO_HISTORY : null };
  });
}

/** An effect in a few words, after its reason's label: “usually more guests”, “fewer guests last time”, “about the same in Townwise’s model”. */
function shortEffect(effect: ReasonEffect): string {
  const what = effect.direction === 'same' ? 'about the same' : `${effect.direction} guests`;
  if (effect.basis === 'model') return `${what} in Townwise’s model`;
  return effect.days === 1 ? `${what} last time` : `usually ${what}`;
}

/** A reason in short words, for the tooltip and Home's day detail. */
export interface ShortReason {
  reason: ForecastReason;
  /** “Saturday: usually more guests”; a note's, a rule's or one with no effect is its label alone. */
  line: string;
  /** Why's mark and grade before a line whose words say the direction; null before a label alone, which doesn't. */
  mark: EffectMark | null;
  grade: EffectGrade | null;
}

/**
 * A forecast day's `count` reasons with the largest size either way (ties, and those with no size, in Why's order),
 * shown in Why's order, so a large fall is never dropped for small rises. `past`: a day before today, whose reasons
 * have no size, so its first `count` in the read's order.
 */
export function shortReasons(day: Pick<ForecastDay, 'reasons' | 'model'>, past: boolean, count: number): ShortReason[] {
  const ordered = inOrder(day, past);
  const kept = new Set([...ordered].sort((a, b) => Math.abs(b.size ?? 0) - Math.abs(a.size ?? 0)).slice(0, count));
  return ordered.filter((each) => kept.has(each)).map(({ reason, size }) => {
    const effect = effectOf(reason, past);
    if (effect === null) return { reason, line: reason.label, mark: null, grade: null };
    return { reason, line: `${reason.label}: ${shortEffect(effect)}`, ...markOf(size, true) };
  });
}

/** The lines of shortReasons: “Saturday: usually more guests”, or a reason's label alone. */
export function reasonShortLines(day: Pick<ForecastDay, 'reasons' | 'model'>, past: boolean, count: number): string[] {
  return shortReasons(day, past, count).map((each) => each.line);
}

export function dayView(date: string, input: CalendarInput): CalendarDayView {
  const day = forecastDayOf(date, input);
  const short = shortDate(date);
  // Every entry, with its source and no dedupe (entries.ts), periods included.
  const all = dayEntries(date, input, { periods: true });
  // A holiday, town event or term the run's reasons name is in Why with its sources, so On the calendar doesn't repeat it.
  const inWhy = new Set((day?.reasons ?? []).filter((reason) => appliedOf(reason) === null).map((reason) => reason.label));
  const listed = all.flatMap((entry) => ('event' in entry ? [entry.event] : []));
  const events = listed.filter((event) => !inWhy.has(event.title));
  return {
    date,
    heading: date === input.today ? `Today, ${short.replace(/, \d{4}$/, '')}` : short,
    forecast: forecastPart(date, input),
    reasons: reasonLines(day, date < input.today, input.notes),
    moreNotes: day?.moreNotes ?? 0,
    moreRules: day?.moreRules ?? 0,
    events,
    shownInWhy: listed.length - events.length,
    notes: all.flatMap((entry) => (entry.kind === 'note' ? [entry.note] : [])),
    rules: all.flatMap((entry) => (entry.kind === 'rule' ? [entry.rule] : [])),
    imported: all.flatMap((entry) => (entry.kind === 'imported' ? [entry.imported] : [])),
  };
}

/** “your rules” as the start of a sentence: “Your rules”. */
function sentence(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export interface ForecastWords {
  /** The day's headline figure: “About **212** guests”, or the actual “**138** guests”; `source` marks it (decision 10). */
  figure: { before: string; value: string; after: string; source: FigureSource } | null;
  lines: string[];
}

/** An outlook day's sentence in place of the 8 in 10 one (D52). */
export const OUTLOOK_RANGE = 'This day is more than 3 months after this forecast was made, or 6 months after the sales it learned from, so its range is wider.';

/**
 * The Forecast part's heading: “Actual guests” for a past day with stored guests (UI review S2), “Outlook” for an
 * outlook day (D52), “Forecast” otherwise.
 */
export function forecastLabel(part: ForecastPart): 'Forecast' | 'Outlook' | typeof FIGURE_KEY.actual {
  if (part.kind === 'past' && part.actual !== null) return FIGURE_KEY.actual;
  return part.kind === 'open' && part.outlook ? 'Outlook' : 'Forecast';
}

/** The Forecast part's words. `locationName` is the shown name (shownLocationName). */
export function forecastWords(part: ForecastPart, locationName: string): ForecastWords {
  switch (part.kind) {
    case 'open': {
      const figure = { before: 'About', value: whole(part.mid), after: 'guests', source: 'forecast' as const };
      if (part.modelClosed) {
        return { figure, lines: [`Townwise’s model expects you closed. ${sentence(part.from)} open the day with ${plural(part.noteGuests, 'guest', 'guests')}.`] };
      }
      const likely = `Likely ${rangeWords(part.low, part.high)}.`;
      // An outlook day's range has had no 8 in 10 measured live, so it says why it is wider instead (D52).
      const claim = part.outlook ? OUTLOOK_RANGE : 'About 8 in 10 days land in the range.';
      if (part.model === null) return { figure, lines: [`${likely} ${claim}`] };
      const modelClaim = part.outlook ? '' : ' About 8 in 10 days land in that range.';
      return {
        figure,
        lines: [
          part.outlook ? `${likely} ${OUTLOOK_RANGE}` : likely,
          `Townwise’s model: ${rangeWords(part.model.low, part.model.high)}.${modelClaim} ${sentence(part.from)} add ${plural(part.noteGuests, 'guest', 'guests')}.`,
        ],
      };
    }
    case 'booked': {
      const what = part.buyout
        ? (part.guests > 0 ? `Booked: a private buyout, ${plural(part.guests, 'guest', 'guests')}.` : 'Booked: a private buyout.')
        : 'Booked for a private event.';
      return { figure: null, lines: [`${what} No walk-in forecast.`] };
    }
    case 'closed': {
      const why = part.by === 'note' ? 'From your closure note.' : part.by === 'rule' ? 'From your business rule.' : 'Townwise’s model expects you closed.';
      return { figure: null, lines: ['Closed.', why] };
    }
    case 'past': {
      if (part.likelyClosed && part.actual !== null) {
        const lines = [`${likelyClosedWords(plural(part.actual, 'guest', 'guests'))}.`];
        if (part.model !== null) lines.push(`Townwise’s model forecast ${rangeWords(part.model.low, part.model.high)}.`);
        return { figure: null, lines };
      }
      // With no stored guests the run's figure shows as a forecast, as the cell shows it (figureOf).
      const runMid = part.model?.mid ?? null;
      const figure = part.actual !== null ? { before: '', value: whole(part.actual), after: part.actual === 1 ? 'guest' : 'guests', source: 'actual' as const }
        : runMid !== null && !part.modelClosed ? { before: 'About', value: whole(runMid), after: Math.round(runMid) === 1 ? 'guest' : 'guests', source: 'forecast' as const }
          : null;
      const lines = part.actual === null ? ['No guests stored for this day.'] : [];
      if (part.modelClosed) lines.push('Townwise’s model expected you closed.');
      else if (part.check !== null) lines.push(`${checkWords(part.check)}.`);
      else if (part.model !== null) {
        const range = rangeWords(part.model.low, part.model.high);
        lines.push(part.laterNote && part.actual !== null
          ? `Townwise’s model forecast ${range}, but it may have used a note or rule written on or after this day, so it isn’t scored.`
          : `Townwise’s model forecast ${range}.`);
      }
      return { figure, lines };
    }
    case 'none': {
      const why = part.why === 'no_published_forecast'
        ? `Townwise hasn’t published a forecast for ${locationName} yet.`
        : part.why === 'not_covered' ? 'The published forecast doesn’t cover this day.' : null;
      return { figure: null, lines: why === null ? ['No forecast for this day.'] : ['No forecast for this day.', why] };
    }
  }
}

// The tooltip

export interface TooltipLines { date: string; lines: string[] }

const TOOLTIP_REASONS = 3;
const TOOLTIP_ENTRIES = 3;

/**
 * The title of the note a note reason comes from (D49), joined by its id against the notes already read; null for a
 * run's or a rule's reason, an untitled note, or a note this read doesn't hold. Shown after the reason's label, never
 * in its place (D30).
 */
export function noteTitleOf(reason: Pick<ForecastReason, 'note'>, notes: readonly Pick<Note, 'id' | 'title'>[]): string | null {
  const id = reason.note?.id;
  if (id === undefined) return null;
  return notes.find((note) => note.id === id)?.title ?? null;
}

/**
 * The hover tooltip: the day's figure and range, the notes' guests, the three reasons with the largest effect either
 * way in short words (shortReasons), a note reason followed by its note's title as the person's own words (D30 as D49
 * amends it, joined by the reason's note id), then the day's compact entries no shown reason names (entries.ts
 * notNamed), three, or the first two and “+N more”. A day's status never hides an entry.
 */
export function tooltipLines(date: string, input: CalendarInput): TooltipLines | null {
  const day = forecastDayOf(date, input);
  const lines: string[] = [];
  if (date < input.today) {
    const guests = storedGuests(date, input);
    const likely = likelyClosedGuests(date, input);
    if (likely !== null) lines.push(likelyClosedWords(plural(likely, 'guest', 'guests')));
    else if (guests !== null) {
      lines.push(figureLabel(guests, { kind: 'actual' }));
      const check = forecastCheck(day, input.today, input.forecast?.runs);
      if (check !== null) lines.push(checkWords(check));
    }
    // No stored guests: the forecast made for the day, as the cell shows it (figureOf).
    else if (day === null) {
      if (input.forecast !== null) lines.push('No data');
    } else if (day.status === 'closed') lines.push('No data. Forecast closed');
    else if (day.status === 'booked') lines.push(`No data. ${bookedWords(day)}`);
    else if (day.mid !== null && day.low !== null && day.high !== null) {
      lines.push(`No data. ${figureLabel(Math.round(day.mid), { kind: 'past_forecast' })} (likely ${rangeWords(day.low, day.high)})`);
    } else lines.push('No data');
  } else if (day === null) {
    if (input.forecast !== null) lines.push('No forecast');
  } else {
    if (day.status === 'closed') lines.push('Closed');
    else if (day.status === 'booked') lines.push(day.noteGuests > 0 ? `${bookedWords(day)}, forecast` : bookedWords(day));
    else if (day.mid !== null && day.low !== null && day.high !== null) {
      const figure = `${figureLabel(Math.round(day.mid), { kind: 'forecast' })} (likely ${rangeWords(day.low, day.high)})`;
      lines.push(day.outlook ? `Outlook: ${figure}` : figure);
      if (day.noteGuests > 0) lines.push(`Includes ${plural(day.noteGuests, 'guest', 'guests')} from ${guestsFromWords(day)}`);
    }
  }
  const reasons = day === null ? [] : shortReasons(day, date < input.today, TOOLTIP_REASONS);
  const names: string[] = [];
  // A note or rule whose reason is shown is already named, whatever its words.
  const shownIds = new Set<string>();
  for (const { reason, line } of reasons) {
    const title = noteTitleOf(reason, input.notes);
    names.push(reason.label, ...(title === null ? [] : [title]));
    for (const id of [reason.note?.id, reason.rule?.id]) if (id !== undefined) shownIds.add(id);
    lines.push(title === null ? line : `${line}: ${title}`);
  }
  const unnamed = notNamed(compactEntries(dayEntries(date, input)), names, shownIds);
  const entries = fitLines(unnamed.map((entry) => entry.words), TOOLTIP_ENTRIES);
  lines.push(...entries.lines, ...(entries.more === null ? [] : [entries.more]));
  return lines.length === 0 ? null : { date: shortDate(date), lines };
}

// How the forecast did (D49, design decision 11, owner 2026-11-18; amended the same day)

/**
 * A past day's forecast against what happened, from the run's own figures. `dataThrough` is the run's last day of sales
 * when the run was made after the day (it never saw the day's sales, so it is compared all the same), else null.
 */
export interface ForecastCheck {
  mid: number; low: number; high: number; actual: number; verdict: 'inside' | 'above' | 'below'; dataThrough: string | null;
}

/** The day's run was made after the day (its made-at day is later); a run made on the day, before service, is not. */
function madeAfterDay(day: Pick<ForecastDay, 'date' | 'madeAt'>): boolean {
  return day.madeAt !== undefined && day.madeAt > day.date;
}

/**
 * How a past day's forecast did, only when the read scored the day (open in the model, not closed or likely closed,
 * with stored guests, and no note or rule written on or after it that its run may have read; api/src/forecasts/score.ts)
 * and says whether it landed in range; null otherwise. The run's own figures, which are the day's before today. `runs`
 * are the read's, for the data end of a run made after the day.
 */
export function forecastCheck(
  day: ForecastDay | null | undefined, today: string, runs: readonly Pick<ForecastWindow['runs'][number], 'id' | 'dataThrough'>[] = [],
): ForecastCheck | null {
  if (day === null || day === undefined || day.date >= today || day.scored !== true || day.inRange === null || day.actual === null) return null;
  const { low, mid, high } = day.model;
  if (low === null || mid === null || high === null) return null;
  const verdict = day.inRange ? 'inside' : day.actual > high ? 'above' : 'below';
  const dataThrough = madeAfterDay(day) ? runs.find((run) => run.id === day.runId)?.dataThrough ?? null : null;
  return { mid, low, high, actual: day.actual, verdict, dataThrough };
}

/**
 * “Forecast was about 82 (likely 70 to 95); 94 guests came: inside the range”, or for a run made after the day
 * “Forecast from sales through Oct 21, 2026: about 82 (likely 70 to 95); 94 guests came: inside the range”.
 */
export function checkWords(check: ForecastCheck): string {
  const forecast = check.dataThrough === null ? 'Forecast was about' : `Forecast from sales through ${formatDate(check.dataThrough)}: about`;
  return `${forecast} ${whole(check.mid)} (likely ${rangeWords(check.low, check.high)}); ${plural(check.actual, 'guest', 'guests')} came: ${check.verdict} the range`;
}

/** The words after a count of days in range, on the month line, the model card and Last week. */
export const INSIDE_RANGE = 'inside the forecast range';

/** “5 of 6 days inside the forecast range”. */
export function insideWords(inside: number, days: number): string {
  return `${formatCount(inside)} of ${plural(days, 'day', 'days')} ${INSIDE_RANGE}`;
}

/**
 * The month's line: how many of its passed days with a comparison (forecastCheck) landed inside the forecast range.
 * “So far this month: …” for today's month, “In October: …” for an earlier one; for a month that has begun with none,
 * that none can be compared yet. Null for a later month, and while the read loads, failed or has nothing published.
 */
export function monthCheckLine(month: string, input: CalendarInput): string | null {
  const thisMonth = input.today.slice(0, 7);
  if (input.forecast === null || !input.forecast.available || month > thisMonth) return null;
  const checks = input.forecast.days.filter((day) => day.date.startsWith(month)).flatMap((day) => {
    const check = forecastCheck(day, input.today, input.forecast?.runs);
    return check === null ? [] : [check];
  });
  const current = month === thisMonth;
  if (checks.length === 0) {
    if (current && input.today.endsWith('-01')) return null;
    return current ? 'No day this month can be compared with its forecast yet.'
      : `No day in ${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? ''} could be compared with its forecast.`;
  }
  const words = insideWords(checks.filter((check) => check.verdict === 'inside').length, checks.length);
  return current ? `So far this month: ${words}.` : `In ${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? ''}: ${words}.`;
}

/**
 * A past day's forecast in Home's day detail, in the Calendar's words: how it did (forecastCheck), or with no stored
 * data the run's figure for it, as a forecast (figureOf); none from today on or with neither.
 */
export function pastForecastLines(date: string, input: CalendarInput): string[] {
  if (date >= input.today) return [];
  const check = forecastCheck(forecastDayOf(date, input), input.today, input.forecast?.runs);
  if (check !== null) return [`${checkWords(check)}.`];
  const found = figureOf(date, input);
  return found.figure?.kind === 'past_forecast' && found.words !== null ? [found.words] : [];
}

// Months

const MONTHS_EACH_WAY = 12;

function addMonths(month: string, count: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The months the page shows: 12 before today's to 12 after it, which keeps every read inside the API's 400 days. */
export function monthBounds(today: string): { first: string; last: string; lastDay: string } {
  const month = today.slice(0, 7);
  const last = addMonths(month, MONTHS_EACH_WAY);
  return { first: addMonths(month, -MONTHS_EACH_WAY), last, lastDay: monthRange(last).to };
}

/** The month before or after `month`. */
export function stepMonth(month: string, step: -1 | 1): string {
  return addMonths(month, step);
}

/** `?day=`, when it is a real date inside the bounds; today otherwise. */
export function selectedDay(param: string | undefined, today: string): string {
  if (param === undefined || !isCalendarDate(param)) return today;
  const bounds = monthBounds(today);
  return param >= `${bounds.first}-01` && param <= bounds.lastDay ? param : today;
}

/** “November 2026”. */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? ''} ${month.slice(0, 4)}`;
}
