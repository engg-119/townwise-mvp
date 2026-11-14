import type { Note } from '../locations/api';
import { addDays } from '../locations/dates';
import type { RuleSchedule } from '../rules/api';
import type { TownEvent } from './api';
import type { DayRecord } from './history';
import { weekdayOf } from './words';

// Day classification, shared by Home and Analytics (home.md 4.3) and ported to the server for "your history by
// town state" (model.md 3.5, pinned by the day-classes.json parity fixture). The rules:
// - A note covers a day when the day is in its range and its weekdays are null or include the day's weekday.
// - A day is closed when a covering note is a closure (`isClosure`: a closure note, or any note whose effect is
//   `closed`), or its stored row is all zero (guests 0 with net sales 0 or none, or no guests with net sales 0). A day
//   with no row is no data, never closed.
// - A day is also closed, and likely closed (spec D32, the API's api/src/closed-days.ts), when it is before the town's
//   today, its guests are under a tenth of its weekday's typical guests and no covering note says more or fewer
//   guests. A day on or after today is never likely closed, since today's upload may be partial: the context's
//   `today`; a context without one treats every day as past. The typical guests are the median over the open days
//   (guests above 0) among the 8 same weekdays before it; with fewer than 3, there are none. decodeHistory gives each
//   day its typicalGuests; a record without them is never likely closed.
//   A business rule's schedule (D31) is the context's `rules`. Its more or fewer guests say a near-empty day was open
//   as a note's do; its closure or buyout closes the day, except that a covering note that decides the day (a closure,
//   an opening, a private event, or more or fewer guests) sets it aside, and before today a rule's closure holds only
//   on a day with no guests or guests under the likely-closed line: real recorded guests beat a standing rule. A rule
//   never makes a day noted, and a context without rules (Home's, today) behaves as before.
// - A day is noted when a covering note does not close it (a private event, an opening or other, unless closed).
// - Holiday and event days are those with a `holiday` or an `event` on the calendar. Term and season periods span
//   months, so they are context only: they never make a day irregular and are never a driver, even with a `group`.
// - The class takes the first that applies: closed, noted, holiday, event, regular.

export type DayClass = 'closed' | 'noted' | 'holiday' | 'event' | 'regular';

export interface DayContext {
  notesByDate: ReadonlyMap<string, readonly Note[]>;
  eventsByDate: ReadonlyMap<string, readonly TownEvent[]>;
  /** The location's rule schedules (D31), which can close a day or say a near-empty day was open; none when absent. */
  rules?: readonly RuleScheduleLike[];
  /** The town's today: a day on or after it is never likely closed (D32). Absent: every day counts as past. */
  today?: string;
}

/** What a day class reads of a rule's schedule; one without a kind is no closure unless its effect is closed. */
export type RuleScheduleLike = Pick<RuleSchedule, 'startDate' | 'endDate' | 'weekdays' | 'effect'> & { kind?: RuleSchedule['kind'] };

/** The schedules of the rules that have one, for `dayContext`. */
export function ruleSchedules(rules: readonly { schedule?: RuleScheduleLike | null | undefined }[]): RuleScheduleLike[] {
  return rules.flatMap((rule) => (rule.schedule === null || rule.schedule === undefined ? [] : [rule.schedule]));
}

export interface DayFlags {
  /** Closed by a note or an all-zero row, or likely closed. */
  closed: boolean;
  /** Closed only because its guests were near zero for its weekday (spec D32). */
  likelyClosed: boolean;
  noted: boolean;
  holiday: boolean;
  event: boolean;
}

const NONE: readonly never[] = [];

/** Whether a note covers the date; a business rule's schedule (D31) too, whose `endDate` null means no end. */
export function noteCovers(note: Pick<Note, 'startDate' | 'weekdays'> & { endDate: string | null }, date: string): boolean {
  if (date < note.startDate || (note.endDate !== null && date > note.endDate)) return false;
  return note.weekdays === null || note.weekdays.includes(weekdayOf(date));
}

export function notesOn(date: string, notes: readonly Note[]): Note[] {
  return notes.filter((note) => noteCovers(note, date));
}

export function eventsOn(date: string, events: readonly TownEvent[]): TownEvent[] {
  return events.filter((event) => event.start <= date && date <= event.end);
}

function push<T>(map: Map<string, T[]>, date: string, item: T): void {
  const list = map.get(date);
  if (list === undefined) map.set(date, [item]);
  else list.push(item);
}

/** Notes and events indexed by each day they cover, in the order given, with the rule schedules and the town's today. */
export function dayContext(
  notes: readonly Note[], events: readonly TownEvent[], rules: readonly RuleScheduleLike[] = NONE, today?: string,
): DayContext {
  const notesByDate = new Map<string, Note[]>();
  for (const note of notes) {
    for (let date = note.startDate; date <= note.endDate; date = addDays(date, 1)) {
      if (noteCovers(note, date)) push(notesByDate, date, note);
    }
  }
  const eventsByDate = new Map<string, TownEvent[]>();
  for (const event of events) {
    for (let date = event.start; date <= event.end; date = addDays(date, 1)) push(eventsByDate, date, event);
  }
  return { notesByDate, eventsByDate, rules, ...(today === undefined ? {} : { today }) };
}

export const EMPTY_CONTEXT: DayContext = { notesByDate: new Map(), eventsByDate: new Map() };

export function notesOf(context: DayContext, date: string): readonly Note[] {
  return context.notesByDate.get(date) ?? NONE;
}

export function eventsOf(context: DayContext, date: string): readonly TownEvent[] {
  return context.eventsByDate.get(date) ?? NONE;
}

/** A stored row whose values are all zero: the restaurant was open to no one. */
export function isAllZero(day: Pick<DayRecord, 'guests' | 'netSalesCents'>): boolean {
  if (day.guests === 0) return day.netSalesCents === 0 || day.netSalesCents === null;
  return day.guests === null && day.netSalesCents === 0;
}

// Likely closed (spec D32). The three values await the team's confirmation there, and are the API's.
/** A day is likely closed under this share of its weekday's typical guests. */
export const LIKELY_CLOSED_SHARE = 0.1;
/** The typical guests read this many same weekdays before the day. */
export const TYPICAL_WEEKS = 8;
/** The fewest open same weekdays the typical guests need. */
export const TYPICAL_MIN_DAYS = 3;
/** How far before a day its typical guests read: its 8 same weekdays. */
export const TYPICAL_LOOKBACK_DAYS = 7 * TYPICAL_WEEKS;

/**
 * The median guests over the open days (guests above 0) among the 8 same weekdays before `date`, the mean of the
 * middle two for an even count; null with fewer than 3. `guestsOn` gives a date's stored guests (undefined with no row).
 */
export function typicalGuests(date: string, guestsOn: (date: string) => number | null | undefined): number | null {
  const open: number[] = [];
  for (let week = 1; week <= TYPICAL_WEEKS; week += 1) {
    const guests = guestsOn(addDays(date, -7 * week));
    if (guests !== null && guests !== undefined && guests > 0) open.push(guests);
  }
  if (open.length < TYPICAL_MIN_DAYS) return null;
  open.sort((a, b) => a - b);
  const middle = Math.floor(open.length / 2);
  const upper = open[middle] ?? 0;
  return open.length % 2 === 1 ? upper : ((open[middle - 1] ?? 0) + upper) / 2;
}

type StoredDay = Pick<DayRecord, 'guests' | 'netSalesCents' | 'typicalGuests'>;
type Entry = Pick<Note, 'effect'> & { kind?: Note['kind'] };

/** A closure note, or any note or schedule whose effect is closed (a buyout too): the forecast's and the lab's rule. */
export function isClosure(entry: Entry): boolean {
  return entry.kind === 'closure' || entry.effect === 'closed';
}

const isBuyout = (entry: Entry): boolean => entry.kind === 'private_event' && entry.effect === 'closed';
const saysGuests = (entry: Entry): boolean => entry.effect === 'more_guests' || entry.effect === 'fewer_guests';
/** A note that says the day was open: an opening, a private event, or more or fewer guests, unless it closes it. */
const saysOpen = (entry: Entry): boolean => !isClosure(entry) && (entry.kind === 'opening' || entry.kind === 'private_event' || saysGuests(entry));

/** Missing guests (no row, no guest count or 0), or guests under a tenth of the typical guests. */
function fewOrNoGuests(day: StoredDay | undefined): boolean {
  if (day === undefined || day.guests === null || day.guests === 0) return true;
  const typical = day.typicalGuests ?? null;
  return typical !== null && day.guests / typical < LIKELY_CLOSED_SHARE;
}

/**
 * Whether a day is closed or likely closed, from its stored row (with its typical guests), the notes covering it and
 * the rule schedules covering it (`rules`, none by default); null when it is open or has no row. `past`: the day is
 * before the town's today (true by default); a day that is not is never likely closed. Closed comes first, so a day
 * closed by a note, a rule or an all-zero row is never "likely". A note that decides the day sets aside the rules'
 * closures and buyouts, and before today a rule's closure holds only on a day with few or no guests.
 */
export function closureOf(
  day: StoredDay | undefined, notes: readonly Entry[], { rules = NONE, past = true }: { rules?: readonly Entry[]; past?: boolean } = {},
): 'closed' | 'likely_closed' | null {
  if (notes.some(isClosure)) return 'closed';
  const decided = notes.some((note) => isClosure(note) || saysOpen(note));
  if (!decided && rules.some((rule) => isClosure(rule) && (!past || isBuyout(rule) || fewOrNoGuests(day)))) return 'closed';
  if (day === undefined) return null;
  if (isAllZero(day)) return 'closed';
  const typical = day.typicalGuests ?? null;
  if (!past || day.guests === null || typical === null) return null;
  if (notes.some(saysGuests) || rules.some(saysGuests)) return null;
  // A division, not guests < typical * 0.1, so exactly a tenth is never under it by a rounding error.
  return day.guests / typical < LIKELY_CLOSED_SHARE ? 'likely_closed' : null;
}

/** “Likely closed (1 guest recorded)”: `recorded` is the day's stored figure in words. */
export function likelyClosedWords(recorded: string): string {
  return `Likely closed (${recorded} recorded)`;
}

export function dayFlags(date: string, day: DayRecord | undefined, context: DayContext): DayFlags {
  const notes = notesOf(context, date);
  const events = eventsOf(context, date);
  const rules = (context.rules ?? NONE).filter((rule) => noteCovers(rule, date));
  const closure = closureOf(day, notes, { rules, past: context.today === undefined || date < context.today });
  return {
    closed: closure !== null,
    likelyClosed: closure === 'likely_closed',
    noted: notes.some((note) => !isClosure(note)),
    holiday: events.some((event) => event.kind === 'holiday'),
    event: events.some((event) => event.kind === 'event'),
  };
}

export function isClosed(date: string, day: DayRecord | undefined, context: DayContext): boolean {
  return dayFlags(date, day, context).closed;
}

export function classOfFlags(flags: DayFlags): DayClass {
  if (flags.closed) return 'closed';
  if (flags.noted) return 'noted';
  if (flags.holiday) return 'holiday';
  if (flags.event) return 'event';
  return 'regular';
}

export function classOf(date: string, day: DayRecord | undefined, context: DayContext): DayClass {
  return classOfFlags(dayFlags(date, day, context));
}

/**
 * Closed days from `first` to `last` in the given years, counting closure notes on days with no row, so a closure
 * the export skipped still counts. Nothing after `last` is counted.
 */
export function closedDaysBetween(
  first: string, last: string, years: ReadonlySet<number>, byDate: ReadonlyMap<string, DayRecord>, context: DayContext,
): number {
  let closed = 0;
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (years.has(Number(date.slice(0, 4))) && dayFlags(date, byDate.get(date), context).closed) closed += 1;
  }
  return closed;
}
