import { formatCount, plural } from '../format';
import type { TownEvent } from '../analytics/api';
import { closureOf, likelyClosedWords, noteCovers, TYPICAL_LOOKBACK_DAYS, typicalGuests } from '../analytics/days';
import { mondayOf, weekDates } from '../analytics/week';
import { MONTH_NAMES, shortDate } from '../analytics/words';
import { appliedOf, guestsFromWords, yoursDid, type ForecastDay, type ForecastReason, type ForecastWindow, type ReasonEffect } from '../estimates/api';
import type { Note, SalesDay } from '../locations/api';
import { addDays, isCalendarDate, monthRange } from '../locations/dates';
import { KIND_LABEL } from '../locations/noteRules';
import type { Rule } from '../rules/api';

// The Calendar's pure model (P27, spec 16.3): the month as week rows with each day's figure,
// status, chips, corner marks and screen-reader label; the selected day's panel (its forecast, the reasons, and what
// is on the calendar); the hover tooltip's lines; the filters; and the 25 months the page can show. Every figure
// from today on is the published forecast's own, as the API's read leaves it after the location's notes (spec
// 14.5): this file never adds a note's guests, so the rule lives once, in api/src/forecasts/adjust.ts. A day before
// today shows its stored guests, never a forecast, or “Likely closed” when they were under a tenth of its weekday's
// typical guests (spec D32, analytics/days.ts). Forecast figures are rounded here, the middle figure to the nearest
// guest and a range's low down and high up (spec 14.4, as TownwiseAI's get_forecast); the range always goes with the
// middle figure in the label, the tooltip and the panel ([CONFIRM] in spec 14.2), and the "8 in 10" sentence only
// with the model's own range, since a range a note moved is no longer the model's 80% one. Business rules with a
// schedule (D31) change the forecast as notes do, in the API's read: their reasons show like a note's, guests they add
// are named as theirs, and the panel lists the rules covering the day (no filter hides them; they are edited on Rules).
// Why (spec 14.4, P27): the owner's notes and rules first, then the run's reasons by the size of their effect, each
// saying in words whether it usually brings more or fewer guests (the API's effect, from the model or the location's
// own history), then those with none; a direction mark goes before the words but never stands alone. On the calendar
// leaves out a holiday, event or term Why already names. The tooltip and Home's day detail take the same order in
// short words (reasonShortLines).

/** The filter chips, in toolbar order. `imported` ("Your calendar") shows only after an import. */
export const FILTER_KEYS = ['holidays', 'events', 'terms', 'notes', 'imported'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Readonly<Record<FilterKey, boolean>>;
export const FILTER_LABEL: Readonly<Record<FilterKey, string>> = {
  holidays: 'Holidays', events: 'Town events', terms: 'Term dates', notes: 'Your notes', imported: 'Your calendar',
};
export const ALL_FILTERS: Filters = { holidays: true, events: true, terms: true, notes: true, imported: true };

/** An event from the owner's own calendar file, kept in the page's memory only (spec 17). */
export interface ImportedEvent {
  uid: string;
  title: string;
  startDate: string;
  endDate: string;
  /**
   * Local 'HH:MM', only when the event starts and ends on the same day, or ends by 06:00 the next morning (ics.ts), when
   * endTime is before startTime.
   */
  startTime: string | null;
  endTime: string | null;
}

/** The owner's calendar file as the page holds it: its name, its events and how many repeating events it left out. */
export interface ImportedCalendar {
  fileName: string;
  events: ImportedEvent[];
  skipped: number;
}

export interface CalendarInput {
  today: string;
  /** 'YYYY-MM'. */
  month: string;
  /** The month's forecast read; null while it loads or when it failed. */
  forecast: ForecastWindow | null;
  /** The stored days of the month's past part, and of the 8 weeks before the month that likely closed reads (pastRange). */
  salesDays: readonly SalesDay[];
  events: readonly TownEvent[];
  notes: readonly Note[];
  /** The location's business rules (D31); Home passes none. */
  rules?: readonly Rule[];
  imported: readonly ImportedEvent[];
  filters: Filters;
}

/** Holidays, town events, and term and season periods ("Term dates"). */
export function filterOf(event: Pick<TownEvent, 'kind'>): FilterKey {
  if (event.kind === 'holiday') return 'holidays';
  if (event.kind === 'event') return 'events';
  return 'terms';
}

/** Term and season periods span weeks or months, so they mark no cell; the day panel lists them. */
function marksCell(event: Pick<TownEvent, 'kind'>): boolean {
  return event.kind === 'holiday' || event.kind === 'event';
}

function eventsOn(date: string, input: CalendarInput): TownEvent[] {
  return input.events.filter((event) => event.start <= date && date <= event.end && input.filters[filterOf(event)]);
}

function notesOn(date: string, input: CalendarInput): Note[] {
  return input.filters.notes ? input.notes.filter((note) => noteCovers(note, date)) : [];
}

/** The rules whose schedule covers the day, oldest first. */
function rulesOn(date: string, input: CalendarInput): Rule[] {
  return (input.rules ?? []).filter((rule) => rule.schedule !== null && rule.schedule !== undefined && noteCovers(rule.schedule, date));
}

function importedOn(date: string, input: CalendarInput): ImportedEvent[] {
  return input.filters.imported ? input.imported.filter((event) => event.startDate <= date && date <= event.endDate) : [];
}

function forecastDayOf(date: string, input: CalendarInput): ForecastDay | null {
  return input.forecast?.days.find((day) => day.date === date) ?? null;
}

function storedGuests(date: string, input: CalendarInput): number | null {
  return input.salesDays.find((day) => day.date === date)?.guests ?? null;
}

/**
 * A past day's stored guests when it was likely closed (spec D32), else null. Every note and rule schedule covering the
 * day counts, whatever the filters show: one with more or fewer guests says the day was open.
 */
function likelyClosedGuests(date: string, input: CalendarInput): number | null {
  const day = input.salesDays.find((each) => each.date === date);
  if (day === undefined || day.guests === null) return null;
  const typical = typicalGuests(date, (other) => input.salesDays.find((each) => each.date === other)?.guests);
  const covering = [...input.notes.filter((note) => noteCovers(note, date)), ...rulesOn(date, input).flatMap((rule) => (rule.schedule ? [rule.schedule] : []))];
  return closureOf({ ...day, typicalGuests: typical }, covering) === 'likely_closed' ? day.guests : null;
}

function whole(value: number): string {
  return formatCount(Math.round(value));
}

/** “180 to 240”: a range's low rounded down and its high up (spec 14.4). */
function rangeWords(low: number, high: number): string {
  return `${formatCount(Math.floor(low))} to ${formatCount(Math.ceil(high))}`;
}

/** A note in a cell's chip: “Private event, 70”, “Private buyout”, “Closure”. */
export function noteChip(note: Pick<Note, 'kind' | 'effect' | 'expectedGuests'>): string {
  const kind = note.kind === 'private_event' && note.effect === 'closed' ? 'Private buyout' : KIND_LABEL[note.kind];
  return note.expectedGuests === null ? kind : `${kind}, ${formatCount(note.expectedGuests)}`;
}


// Cells

export interface CellFigure {
  value: number;
  /** forecast: the published day's middle figure; actual: stored guests; booked: a buyout's party. */
  kind: 'forecast' | 'actual' | 'booked';
}

export interface CalendarCell {
  date: string;
  isToday: boolean;
  /** In today's week, which the grid outlines. */
  inWeek: boolean;
  /** From today on, a day the forecast has closed or booked; before today, a likely-closed day (spec D32). */
  status: 'closed' | 'booked' | 'likely_closed' | null;
  figure: CellFigure | null;
  /** Guests the location's notes add to a forecast figure (“+70”); 0 when none. */
  noteGuests: number;
  /** The first two entries of the day: holidays and town events, then notes, then imported events. */
  chips: string[];
  /** Entries past the chips. */
  more: number;
  marks: { event: boolean; note: boolean; imported: boolean };
  /** What a screen reader hears: everything the cell shows, in words. */
  label: string;
}

const MAX_CHIPS = 2;

interface FigureOf { status: CalendarCell['status']; figure: CellFigure | null; noteGuests: number; words: string | null }

function bookedWords(day: ForecastDay): string {
  if (!yoursDid(day, 'booked')) return 'Booked for a private event';
  return day.noteGuests > 0 ? `Booked: a private buyout, ${plural(day.noteGuests, 'guest', 'guests')}` : 'Booked: a private buyout';
}

function figureOf(date: string, input: CalendarInput): FigureOf {
  if (date < input.today) {
    const likely = likelyClosedGuests(date, input);
    if (likely !== null) return { status: 'likely_closed', figure: null, noteGuests: 0, words: `${likelyClosedWords(plural(likely, 'guest', 'guests'))}.` };
    const guests = storedGuests(date, input);
    return { status: null, figure: guests === null ? null : { value: guests, kind: 'actual' }, noteGuests: 0, words: guests === null ? null : `${plural(guests, 'guest', 'guests')}.` };
  }
  const day = forecastDayOf(date, input);
  if (day === null) return { status: null, figure: null, noteGuests: 0, words: null };
  if (day.status === 'closed') return { status: 'closed', figure: null, noteGuests: 0, words: 'Closed.' };
  if (day.status === 'booked') {
    const figure: CellFigure | null = day.noteGuests > 0 ? { value: day.noteGuests, kind: 'booked' } : null;
    return { status: 'booked', figure, noteGuests: 0, words: `${bookedWords(day)}.` };
  }
  if (day.mid === null || day.low === null || day.high === null) return { status: null, figure: null, noteGuests: 0, words: null };
  const words = [
    `Forecast about ${plural(Math.round(day.mid), 'guest', 'guests')}, ${rangeWords(day.low, day.high)}.`,
    day.noteGuests > 0 ? `Includes ${plural(day.noteGuests, 'guest', 'guests')} from ${guestsFromWords(day)}.` : null,
  ].filter((part) => part !== null).join(' ');
  return { status: null, figure: { value: Math.round(day.mid), kind: 'forecast' }, noteGuests: day.noteGuests, words };
}

function cellOf(date: string, input: CalendarInput, week: { from: string; to: string }): CalendarCell {
  const events = eventsOn(date, input).filter(marksCell);
  const notes = notesOn(date, input);
  const imported = importedOn(date, input);
  const entries = [...events.map((event) => event.title), ...notes.map(noteChip), ...imported.map((event) => event.title)];
  const found = figureOf(date, input);
  const isToday = date === input.today;
  const label = [
    `${shortDate(date)}.`,
    isToday ? 'Today.' : null,
    found.words,
    ...events.map((event) => `${event.title}.`),
    notes.length === 0 ? null : `${plural(notes.length, 'note', 'notes')}.`,
    ...imported.map((event) => `From your calendar: ${event.title}.`),
  ].filter((part) => part !== null).join(' ');
  return {
    date,
    isToday,
    inWeek: date >= week.from && date <= week.to,
    status: found.status,
    figure: found.figure,
    noteGuests: found.noteGuests,
    chips: entries.slice(0, MAX_CHIPS),
    more: Math.max(0, entries.length - MAX_CHIPS),
    marks: { event: events.length > 0, note: notes.length > 0, imported: imported.length > 0 },
    label,
  };
}

/** The month as week rows, Monday first; null where a row's day is in another month. */
export function calendarMonth(input: CalendarInput): (CalendarCell | null)[][] {
  const { from, to } = monthRange(input.month);
  const monday = mondayOf(input.today);
  const week = { from: monday, to: addDays(monday, 6) };
  const rows: (CalendarCell | null)[][] = [];
  for (let start = mondayOf(from); start <= to; start = addDays(start, 7)) {
    rows.push(weekDates(start).map((date) => (date < from || date > to ? null : cellOf(date, input, week))));
  }
  return rows;
}

/** The cell's sizes (spec 16.3 P27): taller cells and bigger figures as the screen widens. */
export function cellSizes(width: number): { minHeight: number; figure: number; chips: boolean } {
  if (width >= 1024) return { minHeight: 96, figure: 22, chips: true };
  if (width > 640) return { minHeight: 64, figure: 18, chips: false };
  return { minHeight: 52, figure: 15, chips: false };
}

/** The word under a figure: stored guests read "guests", a buyout's party "booked". */
export function captionOf(cell: CalendarCell): string | null {
  if (cell.figure?.kind === 'actual') return 'guests';
  if (cell.figure?.kind === 'booked') return 'booked';
  return null;
}

export function statusWord(status: CalendarCell['status']): string | null {
  switch (status) {
    case 'closed': return 'Closed';
    case 'booked': return 'Booked';
    case 'likely_closed': return 'Likely closed';
    case null: return null;
  }
}

// The day panel

/** What the Forecast part of the panel shows. */
export type ForecastPart =
  | {
    kind: 'open'; low: number; mid: number; high: number; noteGuests: number;
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
    kind: 'past'; actual: number | null; likelyClosed: boolean; model: { low: number; high: number } | null; modelClosed: boolean;
    inRange: boolean | null;
  }
  /** unavailable: the forecast read is loading or failed. */
  | { kind: 'none'; why: 'no_published_forecast' | 'not_covered' | 'unavailable' };

/** Before an effect's words: more guests, fewer, or about the same. */
export type EffectMark = '▲' | '▼' | '=';

export interface ReasonLine {
  key: string;
  label: string;
  /**
   * What the reason does to the day: a note's or a rule's outcome (“Adds 70 guests”), a run reason's effect
   * (“Usually about 35% more guests than your average day”), NO_HISTORY, or null (a day before today, or a kind the
   * history can't speak to, such as “Your recent level”).
   */
  detail: string | null;
  /** ▲, ▼ or = before an effect's words; null otherwise. Never the only sign: the words say the same. */
  mark: EffectMark | null;
  sources: readonly { label: string; url: string }[];
}

export interface CalendarDayView {
  date: string;
  /** “Today, Wed, Nov 11” or “Sat, Nov 21, 2026”. */
  heading: string;
  forecast: ForecastPart;
  /** Notes and rules (in the API's order), then the run's reasons by the size of their effect, then those with none. */
  reasons: ReasonLine[];
  /** Note reasons the API left out past its first 6. */
  moreNotes: number;
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
    const model = low !== null && high !== null ? { low, high } : null;
    return {
      kind: 'past', actual: storedGuests(date, input) ?? day?.actual ?? null, likelyClosed: likelyClosedGuests(date, input) !== null, model,
      modelClosed: day?.model.status === 'closed', inRange: day?.inRange ?? null,
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
    kind: 'open', low: day.low, mid: day.mid, high: day.high, noteGuests: day.noteGuests, from: guestsFromWords(day), model,
    modelClosed: day.model.status === 'closed',
  };
}

/** A note reason's outcome in words; null for an outcome this client doesn't know. */
export function reasonOutcomeWords(outcome: string, guests: number | null): string | null {
  switch (outcome) {
    case 'added': return `Adds ${plural(guests ?? 0, 'guest', 'guests')}`;
    case 'booked': return 'Books the day';
    case 'closed': return 'Closes the day';
    case 'already_in_forecast': return 'Already in this forecast';
    case 'no_guest_count': return 'No guest count, so the forecast is unchanged';
    case 'not_counted': return 'Townwise only counts guests for private events so far';
    case 'day_closed': return 'The day is closed';
    case 'day_booked': return 'The day is booked';
    case 'past_day': return 'This day has passed';
    default: return null;
  }
}

/**
 * The panel's notice after a save (spec 16.3 P27): what the saved note did to the selected day, from the note's reason
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

const MARK: Readonly<Record<ReasonEffect['direction'], EffectMark>> = { more: '▲', fewer: '▼', same: '=' };

/** A reason's effect as the panel uses it: the API's, from today on only (a past day keeps the model's reasons as made). */
function effectOf(reason: ForecastReason, past: boolean): ReasonEffect | null {
  return past || appliedOf(reason) !== null ? null : reason.effect ?? null;
}

/**
 * An effect in words: “Usually about 35% more guests than your average day”, “Last time, about 70% fewer guests than
 * the same weekday in the weeks around it” (one past occurrence is what happened, not what usually does), “Usually about
 * as many guests as your average day”, or the model's own, “Townwise’s model: about 10% more guests”.
 */
function effectWords(kind: string, effect: ReasonEffect): string {
  if (effect.basis === 'model') {
    return effect.direction === 'same' ? 'Townwise’s model: about the same number of guests' : `Townwise’s model: about ${String(effect.pct)}% ${effect.direction} guests`;
  }
  const lead = effect.days === 1 ? 'Last time,' : 'Usually';
  const against = AGAINST.get(kind);
  if (effect.direction === 'same') return against === undefined ? `${lead} about the same number of guests` : `${lead} about as many guests as ${against}`;
  return `${lead} about ${String(effect.pct)}% ${effect.direction} guests${against === undefined ? '' : ` than ${against}`}`;
}

/** Notes and rules first, in the API's order (what you changed); then the run's reasons, biggest effect first; then the rest. */
function inOrder(reasons: readonly ForecastReason[], past: boolean): { reason: ForecastReason; index: number }[] {
  const indexed = reasons.map((reason, index) => ({ reason, index }));
  const sized = indexed.filter(({ reason }) => effectOf(reason, past) !== null)
    .sort((a, b) => (effectOf(b.reason, past)?.pct ?? 0) - (effectOf(a.reason, past)?.pct ?? 0));
  return [
    ...indexed.filter(({ reason }) => appliedOf(reason) !== null), ...sized,
    ...indexed.filter(({ reason }) => appliedOf(reason) === null && effectOf(reason, past) === null),
  ];
}

function reasonLines(day: ForecastDay | null, past: boolean): ReasonLine[] {
  if (day === null) return [];
  return inOrder(day.reasons, past).map(({ reason, index }): ReasonLine => {
    const applied = appliedOf(reason);
    const effect = effectOf(reason, past);
    const line = { key: `${String(index)}:${reason.kind}`, label: reason.label, sources: reason.sources };
    if (applied !== null) return { ...line, detail: reasonOutcomeWords(applied.outcome, applied.guests), mark: null };
    if (effect !== null) return { ...line, detail: effectWords(reason.kind, effect), mark: MARK[effect.direction] };
    return { ...line, detail: !past && AGAINST.has(reason.kind) ? NO_HISTORY : null, mark: null };
  });
}

/** An effect in a few words, after its reason's label: “usually more guests”, “fewer guests last time”, “about the same in Townwise’s model”. */
function shortEffect(effect: ReasonEffect): string {
  const what = effect.direction === 'same' ? 'about the same' : `${effect.direction} guests`;
  if (effect.basis === 'model') return `${what} in Townwise’s model`;
  return effect.days === 1 ? `${what} last time` : `usually ${what}`;
}

/**
 * A forecast day's reasons in the panel's order as short lines, “Saturday: usually more guests”; a note's, a rule's or
 * one with no effect is its label alone. The tooltip and Home's day detail show the first few. `past`: a day before today.
 */
export function reasonShortLines(day: Pick<ForecastDay, 'reasons'>, past: boolean): string[] {
  return inOrder(day.reasons, past).map(({ reason }) => {
    const effect = effectOf(reason, past);
    return effect === null ? reason.label : `${reason.label}: ${shortEffect(effect)}`;
  });
}

export function dayView(date: string, input: CalendarInput): CalendarDayView {
  const day = forecastDayOf(date, input);
  const short = shortDate(date);
  // A holiday, town event or term the run's reasons name is in Why with its sources, so On the calendar doesn't repeat it.
  const inWhy = new Set((day?.reasons ?? []).filter((reason) => appliedOf(reason) === null).map((reason) => reason.label));
  const listed = eventsOn(date, input);
  const events = listed.filter((event) => !inWhy.has(event.title));
  return {
    date,
    heading: date === input.today ? `Today, ${short.replace(/, \d{4}$/, '')}` : short,
    forecast: forecastPart(date, input),
    reasons: reasonLines(day, date < input.today),
    moreNotes: day?.moreNotes ?? 0,
    events,
    shownInWhy: listed.length - events.length,
    notes: notesOn(date, input),
    rules: rulesOn(date, input),
    imported: importedOn(date, input),
  };
}

/** “your rules” as the start of a sentence: “Your rules”. */
function sentence(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export interface ForecastWords {
  /** The day's headline figure: “About **212** guests”, or the actual “**138** guests”. */
  figure: { before: string; value: string; after: string } | null;
  lines: string[];
}

/** The Forecast part's words. `locationName` is the shown name (shownLocationName). */
export function forecastWords(part: ForecastPart, locationName: string): ForecastWords {
  switch (part.kind) {
    case 'open': {
      const figure = { before: 'About', value: whole(part.mid), after: 'guests' };
      if (part.modelClosed) {
        return { figure, lines: [`Townwise’s model expects you closed. ${sentence(part.from)} open the day with ${plural(part.noteGuests, 'guest', 'guests')}.`] };
      }
      const likely = `Likely ${rangeWords(part.low, part.high)}.`;
      if (part.model === null) return { figure, lines: [`${likely} About 8 in 10 days land in the range.`] };
      return {
        figure,
        lines: [
          likely,
          `Townwise’s model: ${rangeWords(part.model.low, part.model.high)}. About 8 in 10 days land in that range. ${sentence(part.from)} add ${plural(part.noteGuests, 'guest', 'guests')}.`,
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
      const figure = part.actual === null ? null : { before: '', value: whole(part.actual), after: part.actual === 1 ? 'guest' : 'guests' };
      const lines = part.actual === null ? ['No guests stored for this day.'] : [];
      if (part.modelClosed) lines.push('Townwise’s model expected you closed.');
      else if (part.model !== null) {
        const range = `Townwise’s model forecast ${rangeWords(part.model.low, part.model.high)}`;
        lines.push(part.inRange === null ? `${range}.` : `${range}, and the day landed ${part.inRange ? 'in that range' : 'outside it'}.`);
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

/** The hover tooltip: the day's figure and range, the notes' guests, and the top three reasons in short words (or entries). */
export function tooltipLines(date: string, input: CalendarInput): TooltipLines | null {
  const day = forecastDayOf(date, input);
  const lines: string[] = [];
  if (date < input.today) {
    const guests = storedGuests(date, input);
    const likely = likelyClosedGuests(date, input);
    if (likely !== null) lines.push(likelyClosedWords(plural(likely, 'guest', 'guests')));
    else if (guests !== null) lines.push(plural(guests, 'guest', 'guests'));
  } else if (day !== null) {
    if (day.status === 'closed') lines.push('Closed');
    else if (day.status === 'booked') lines.push(bookedWords(day));
    else if (day.mid !== null && day.low !== null && day.high !== null) {
      lines.push(`About ${plural(Math.round(day.mid), 'guest', 'guests')} (${rangeWords(day.low, day.high)})`);
      if (day.noteGuests > 0) lines.push(`Includes ${plural(day.noteGuests, 'guest', 'guests')} from ${guestsFromWords(day)}`);
    }
  }
  const reasons = day === null ? [] : reasonShortLines(day, date < input.today);
  const entries = reasons.length > 0 ? reasons : [
    ...eventsOn(date, input).filter(marksCell).map((event) => event.title),
    ...notesOn(date, input).map(noteChip),
    ...importedOn(date, input).map((event) => event.title),
  ];
  lines.push(...entries.slice(0, TOOLTIP_REASONS));
  return lines.length === 0 ? null : { date: shortDate(date), lines };
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

/**
 * What GET .../sales/days reads for `month`: its days before today, from the 8 weeks before it, whose same weekdays
 * give each day's typical guests (spec D32); null when no day of the month is past.
 */
export function pastRange(month: string, today: string): { from: string; to: string } | null {
  const { from, to } = monthRange(month);
  const yesterday = addDays(today, -1);
  const end = to < yesterday ? to : yesterday;
  return from > end ? null : { from: addDays(from, -TYPICAL_LOOKBACK_DAYS), to: end };
}
