// Closed and likely-closed days (spec D32), from a location's own stored days, notes and rule schedules. Pure.
//
// A day is closed when a covering note is a closure (a closure note, or any note whose effect is closed: isClosure, as
// the forecast and the lab read it), a covering rule schedule's closure or buyout holds (below), or its stored row is
// all zero (guests 0 with net sales 0 or none, or no guests with net sales 0). It is likely closed when it is before
// the town's today, its guests are under a tenth of its weekday's typical guests and no covering note or rule schedule
// says it was open (an effect of more or fewer guests): the restaurant was most likely shut, and the guests a staff meal
// or a stray check, not a very slow day. A day on or after today is never likely closed, since today's upload may be
// partial. The typical guests are the median over the open days (guests above 0) among the 8 same weekdays before the
// day, so the line scales with the restaurant; with fewer than 3 such days there is none and only the closed rule applies.
//
// Notes beat rule schedules (D31): a covering note that decides the day (a closure, a buyout, or one that says the day
// was open: an opening, a private event, or more or fewer guests) sets aside every covering rule's closure and buyout,
// so a one-day opening or party note opens a day a standing closure rule would close. Before today a rule's closure
// holds only when the day's guests are missing (no row, no guest count or 0) or under the likely-closed line: real
// recorded guests beat a standing rule, so they are never dropped from training. A rule's buyout and a closure note
// keep closing past days. [CONFIRM: a note covering a day beats a rule schedule's closure or buyout, and before today a
// rule's closure holds only on a day with no guests or guests under the likely-closed line]
//
// A note marking a day's guest count wrong (D67) is read before any of this: trustedGuestDays sets that day's guests to
// null, so it is a day with sales and no guest count, never likely closed and never in a neighbor's typical guests.
//
// The client mirrors this in client/src/portal/analytics/days.ts, pinned by the shared day-classes.json fixture
// (test/fixtures/day-classes.json and its client copy). A change to one side needs the other and the fixture.
import { utcDay } from './dates.ts';
import type { NoteContent } from './stores/notes.ts';
import type { SalesDay } from './stores/sales-days.ts';

// The three values await the team's confirmation (spec D32).
/** A day is likely closed under this share of its weekday's typical guests. */
export const LIKELY_CLOSED_SHARE = 0.1;
/** The typical guests read this many same weekdays before the day. */
export const TYPICAL_WEEKS = 8;
/** The fewest open same weekdays the typical guests need. */
export const TYPICAL_MIN_DAYS = 3;
/** How far before a day its typical guests read: its 8 same weekdays. */
export const TYPICAL_LOOKBACK_DAYS = 7 * TYPICAL_WEEKS;

export type Closure = 'closed' | 'likely_closed';

/** What the day classes read of a note or a rule's schedule. */
export type Entry = Pick<NoteContent, 'kind' | 'effect'>;
type StoredDay = Pick<SalesDay, 'guests' | 'netSalesCents'>;

/** A closure note, or any note or schedule whose effect is closed (a buyout too). */
export function isClosure(entry: Entry): boolean {
  return entry.kind === 'closure' || entry.effect === 'closed';
}

/**
 * A note marking a past day's guest count wrong (D67): its sales stand. It decides nothing about open, closed or booked
 * (it is in neither saysOpen nor notesDecide); trustedGuestDays reads the days it covers as having no guest count.
 */
export function isWrongGuestCount(entry: Pick<NoteContent, 'effect'>): boolean {
  return entry.effect === 'wrong_guest_count';
}

/** What trustedGuestDays reads of a note: its dates, weekdays and effect. */
export type CoverNote = Pick<NoteContent, 'startDate' | 'endDate' | 'weekdays' | 'effect'>;

function markCovers(note: CoverNote, date: string): boolean {
  if (date < note.startDate || date > note.endDate) return false;
  return note.weekdays === null || note.weekdays.includes(new Date(`${date}T00:00:00.000Z`).getUTCDay());
}

/**
 * The days with `guests` null on every date a wrong-guest-count note covers (D67), sales and every other field untouched;
 * the same array when no note has the effect. A marked day then reads everywhere Townwise trains, compares or analyzes
 * as a day whose upload had sales and no guest count. [CONFIRM: a day whose guest count is marked wrong reads as a day
 * with sales and no guest count wherever Townwise trains, compares or analyzes; its sales stand, and Your data, the
 * sales page and monthly totals still show the stored count]
 */
export function trustedGuestDays<D extends { readonly date: string; readonly guests: number | null }>(
  days: readonly D[], notes: readonly CoverNote[],
): readonly D[] {
  const marks = notes.filter(isWrongGuestCount);
  if (marks.length === 0) return days;
  return days.map((day) => (day.guests !== null && marks.some((note) => markCovers(note, day.date)) ? { ...day, guests: null } : day));
}

/** A private buyout: a private event whose effect is closed. */
export function isBuyout(entry: Entry): boolean {
  return entry.kind === 'private_event' && entry.effect === 'closed';
}

/** A note that says the day was open: an opening, a private event, or more or fewer guests, unless it closes the day. */
export function saysOpen(entry: Entry): boolean {
  return !isClosure(entry)
    && (entry.kind === 'opening' || entry.kind === 'private_event' || entry.effect === 'more_guests' || entry.effect === 'fewer_guests');
}

/** Whether the covering notes decide the day, setting aside every covering rule schedule's closure and buyout. */
export function notesDecide(notes: readonly Entry[]): boolean {
  return notes.some((note) => isClosure(note) || saysOpen(note));
}

/** More or fewer guests: a covering note or schedule saying a near-empty day was open, not likely closed. */
const saysGuests = (entry: Entry): boolean => entry.effect === 'more_guests' || entry.effect === 'fewer_guests';

/** A stored row whose values are all zero: the restaurant was open to no one. */
export function isAllZero(day: StoredDay): boolean {
  if (day.guests === 0) return day.netSalesCents === 0 || day.netSalesCents === null;
  return day.guests === null && day.netSalesCents === 0;
}

/**
 * The median guests over the open days (guests above 0) among the 8 same weekdays before `date`, the mean of the
 * middle two for an even count; null with fewer than 3. `guestsOn` gives a date's stored guests (undefined with no row).
 */
export function typicalGuests(date: string, guestsOn: (date: string) => number | null | undefined): number | null {
  const open: number[] = [];
  const at = new Date(`${date}T00:00:00.000Z`);
  for (let week = 1; week <= TYPICAL_WEEKS; week += 1) {
    const guests = guestsOn(utcDay(at, -7 * week));
    if (guests !== null && guests !== undefined && guests > 0) open.push(guests);
  }
  if (open.length < TYPICAL_MIN_DAYS) return null;
  open.sort((a, b) => a - b);
  const middle = Math.floor(open.length / 2);
  const upper = open[middle] ?? 0;
  return open.length % 2 === 1 ? upper : ((open[middle - 1] ?? 0) + upper) / 2;
}

/** Every day's typical guests, read from the same days. */
export function typicalByDate(days: readonly Pick<SalesDay, 'date' | 'guests'>[]): Map<string, number | null> {
  const guests = new Map(days.map((day) => [day.date, day.guests]));
  return new Map(days.map((day) => [day.date, typicalGuests(day.date, (date) => guests.get(date))]));
}

/**
 * Whether a day's guests are missing (no row, no guest count, or 0) or under a tenth of its weekday's typical guests:
 * before today, a covering rule's closure holds only then.
 */
export function fewOrNoGuests(day: StoredDay | undefined, typical: number | null): boolean {
  if (day === undefined || day.guests === null || day.guests === 0) return true;
  return typical !== null && day.guests / typical < LIKELY_CLOSED_SHARE;
}

/**
 * The covering rule schedules whose closure or buyout holds on the day (see the top): none when the notes decide it;
 * before today, a buyout always and a closure only on a day with few or no guests.
 */
export function closingRules<R extends Entry>(
  rules: readonly R[], notes: readonly Entry[], day: StoredDay | undefined, typical: number | null, past: boolean,
): R[] {
  if (notesDecide(notes)) return [];
  return rules.filter((rule) => isClosure(rule) && (!past || isBuyout(rule) || fewOrNoGuests(day, typical)));
}

/**
 * Whether a day is closed or likely closed, from its stored row, its typical guests, the notes covering it and the
 * rule schedules covering it (`rules`, none by default); null when it is open or has no row. `past`: the day is before
 * the town's today (true by default); a day that is not is never likely closed. Closed comes first, so a day closed by
 * a note, a rule or an all-zero row is never "likely".
 */
export function closureOf(
  day: StoredDay | undefined, typical: number | null, notes: readonly Entry[],
  { rules = [], past = true }: { rules?: readonly Entry[]; past?: boolean } = {},
): Closure | null {
  if (notes.some(isClosure) || closingRules(rules, notes, day, typical, past).length > 0) return 'closed';
  if (day === undefined) return null;
  if (isAllZero(day)) return 'closed';
  if (!past || day.guests === null || typical === null) return null;
  if (notes.some(saysGuests) || rules.some(saysGuests)) return null;
  // A division, not guests < typical * 0.1, so exactly a tenth is never under it by a rounding error.
  return day.guests / typical < LIKELY_CLOSED_SHARE ? 'likely_closed' : null;
}
