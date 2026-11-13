import { formatCount, plural } from '../format';
import type { TownEvent } from '../analytics/api';
import { noteCovers } from '../analytics/days';
import { mondayOf, weekDates } from '../analytics/week';
import { MONTH_NAMES, shortDate, signedPercent } from '../analytics/words';
import type { ForecastDay, ForecastWindow } from '../estimates/api';
import type { Note, SalesDay } from '../locations/api';
import { addDays, isCalendarDate, monthRange } from '../locations/dates';
import { KIND_LABEL } from '../locations/noteRules';

// The Calendar's pure model (P27, spec 16.3): the month as week rows with each day's figure,
// status, chips, corner marks and screen-reader label; the selected day's panel (its forecast, the reasons, and what
// is on the calendar); the hover tooltip's lines; the filters; and the 25 months the page can show. Every figure
// from today on is the published forecast's own, as the API's read leaves it after the location's notes (spec
// 14.5): this file never adds a note's guests, so the rule lives once, in api/src/forecasts/adjust.ts. A day before
// today shows its stored guests, never a forecast. Forecast figures are rounded here, the middle figure to the nearest
// guest and a range's low down and high up (spec 14.4, as TownwiseAI's get_forecast); the range always goes with the
// middle figure in the label, the tooltip and the panel ([CONFIRM] in spec 14.2), and the "8 in 10" sentence only
// with the model's own range, since a range a note moved is no longer the model's 80% one.

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
  /** The stored days of the month's past part. */
  salesDays: readonly SalesDay[];
  events: readonly TownEvent[];
  notes: readonly Note[];
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

function importedOn(date: string, input: CalendarInput): ImportedEvent[] {
  return input.filters.imported ? input.imported.filter((event) => event.startDate <= date && date <= event.endDate) : [];
}

function forecastDayOf(date: string, input: CalendarInput): ForecastDay | null {
  return input.forecast?.days.find((day) => day.date === date) ?? null;
}

function storedGuests(date: string, input: CalendarInput): number | null {
  return input.salesDays.find((day) => day.date === date)?.guests ?? null;
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

/** Whether a note reason with this outcome is on the day. */
function noteDid(day: ForecastDay, outcome: string): boolean {
  return day.reasons.some((reason) => reason.note?.outcome === outcome);
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
  /** From today on, a day the forecast has closed or booked. */
  status: 'closed' | 'booked' | null;
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
  if (!noteDid(day, 'booked')) return 'Booked for a private event';
  return day.noteGuests > 0 ? `Booked: a private buyout, ${plural(day.noteGuests, 'guest', 'guests')}` : 'Booked: a private buyout';
}

function figureOf(date: string, input: CalendarInput): FigureOf {
  if (date < input.today) {
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
    day.noteGuests > 0 ? `Includes ${plural(day.noteGuests, 'guest', 'guests')} from your notes.` : null,
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
  return status === 'closed' ? 'Closed' : status === 'booked' ? 'Booked' : null;
}

// The day panel

/** What the Forecast part of the panel shows. */
export type ForecastPart =
  | {
    kind: 'open'; low: number; mid: number; high: number; noteGuests: number;
    /** The model's own range when notes changed the day; null otherwise. */
    model: { low: number; high: number } | null;
    /** The model expected the day closed and the notes' private events opened it, with only their guests. */
    modelClosed: boolean;
  }
  | { kind: 'booked'; guests: number; byNote: boolean }
  | { kind: 'closed'; byNote: boolean }
  /** Before today: the stored guests, and the run's own range and verdict when one covered the day. */
  | { kind: 'past'; actual: number | null; model: { low: number; high: number } | null; modelClosed: boolean; inRange: boolean | null }
  /** unavailable: the forecast read is loading or failed. */
  | { kind: 'none'; why: 'no_published_forecast' | 'not_covered' | 'unavailable' };

export interface ReasonLine {
  key: string;
  label: string;
  /** A note's outcome in words, or a run reason's effect (“+12%”). */
  detail: string | null;
  sources: readonly { label: string; url: string }[];
}

export interface CalendarDayView {
  date: string;
  /** “Today, Wed, Nov 11” or “Sat, Nov 21, 2026”. */
  heading: string;
  forecast: ForecastPart;
  /** The API's order: notes that changed the day, the run's reasons, then the other notes. */
  reasons: ReasonLine[];
  /** Note reasons the API left out past its first 6. */
  moreNotes: number;
  /** Holidays, town events and term periods on the day, as the filters allow. */
  events: TownEvent[];
  notes: Note[];
  imported: ImportedEvent[];
}

function forecastPart(date: string, input: CalendarInput): ForecastPart {
  const day = forecastDayOf(date, input);
  if (date < input.today) {
    const low = day?.model.low ?? null;
    const high = day?.model.high ?? null;
    const model = low !== null && high !== null ? { low, high } : null;
    return { kind: 'past', actual: storedGuests(date, input) ?? day?.actual ?? null, model, modelClosed: day?.model.status === 'closed', inRange: day?.inRange ?? null };
  }
  if (input.forecast === null) return { kind: 'none', why: 'unavailable' };
  if (!input.forecast.available) return { kind: 'none', why: input.forecast.reason ?? 'not_covered' };
  if (day === null) return { kind: 'none', why: 'not_covered' };
  if (day.status === 'closed') return { kind: 'closed', byNote: noteDid(day, 'closed') };
  if (day.status === 'booked') return { kind: 'booked', guests: day.noteGuests, byNote: noteDid(day, 'booked') };
  if (day.low === null || day.mid === null || day.high === null) return { kind: 'none', why: 'not_covered' };
  const model = day.noteGuests > 0 && day.model.low !== null && day.model.high !== null ? { low: day.model.low, high: day.model.high } : null;
  return { kind: 'open', low: day.low, mid: day.mid, high: day.high, noteGuests: day.noteGuests, model, modelClosed: day.model.status === 'closed' };
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

function reasonLines(day: ForecastDay | null): ReasonLine[] {
  if (day === null) return [];
  return day.reasons.map((reason, index) => ({
    key: `${String(index)}:${reason.kind}`,
    label: reason.label,
    detail: reason.note !== null
      ? reasonOutcomeWords(reason.note.outcome, reason.note.guests)
      : reason.effectPct === null ? null : signedPercent(reason.effectPct / 100),
    sources: reason.sources,
  }));
}

export function dayView(date: string, input: CalendarInput): CalendarDayView {
  const day = forecastDayOf(date, input);
  const short = shortDate(date);
  return {
    date,
    heading: date === input.today ? `Today, ${short.replace(/, \d{4}$/, '')}` : short,
    forecast: forecastPart(date, input),
    reasons: reasonLines(day),
    moreNotes: day?.moreNotes ?? 0,
    events: eventsOn(date, input),
    notes: notesOn(date, input),
    imported: importedOn(date, input),
  };
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
        return { figure, lines: [`Townwise’s model expects you closed. Your notes open the day with ${plural(part.noteGuests, 'guest', 'guests')}.`] };
      }
      const likely = `Likely ${rangeWords(part.low, part.high)}.`;
      if (part.model === null) return { figure, lines: [`${likely} About 8 in 10 days land in the range.`] };
      return {
        figure,
        lines: [
          likely,
          `Townwise’s model: ${rangeWords(part.model.low, part.model.high)}. About 8 in 10 days land in that range. Your notes add ${plural(part.noteGuests, 'guest', 'guests')}.`,
        ],
      };
    }
    case 'booked': {
      const what = part.byNote
        ? (part.guests > 0 ? `Booked: a private buyout, ${plural(part.guests, 'guest', 'guests')}.` : 'Booked: a private buyout.')
        : 'Booked for a private event.';
      return { figure: null, lines: [`${what} No walk-in forecast.`] };
    }
    case 'closed':
      return { figure: null, lines: ['Closed.', part.byNote ? 'From your closure note.' : 'Townwise’s model expects you closed.'] };
    case 'past': {
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

/** The hover tooltip: the day's figure and range, the notes' guests, and up to three reasons (or entries). */
export function tooltipLines(date: string, input: CalendarInput): TooltipLines | null {
  const day = forecastDayOf(date, input);
  const lines: string[] = [];
  if (date < input.today) {
    const guests = storedGuests(date, input);
    if (guests !== null) lines.push(plural(guests, 'guest', 'guests'));
  } else if (day !== null) {
    if (day.status === 'closed') lines.push('Closed');
    else if (day.status === 'booked') lines.push(bookedWords(day));
    else if (day.mid !== null && day.low !== null && day.high !== null) {
      lines.push(`About ${plural(Math.round(day.mid), 'guest', 'guests')} (${rangeWords(day.low, day.high)})`);
      if (day.noteGuests > 0) lines.push(`Includes ${plural(day.noteGuests, 'guest', 'guests')} from your notes`);
    }
  }
  const reasons = day === null ? [] : day.reasons.map((reason) => reason.label);
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

/** The days of `month` before today, for GET .../sales/days; null when none are. */
export function pastRange(month: string, today: string): { from: string; to: string } | null {
  const { from, to } = monthRange(month);
  const yesterday = addDays(today, -1);
  const end = to < yesterday ? to : yesterday;
  return from > end ? null : { from, to: end };
}
