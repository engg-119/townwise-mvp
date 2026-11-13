// Closed and likely-closed days (spec D32), from a location's own stored days and notes. Pure.
//
// A day is closed when a covering note's effect is closed, or its stored row is all zero (guests 0 with net sales 0
// or none, or no guests with net sales 0). It is likely closed when its guests are under a tenth of its weekday's
// typical guests and no covering note says it was open (an effect of more or fewer guests): the restaurant was most
// likely shut, and the guests a staff meal or a stray check, not a very slow day. The typical guests are the median
// over the open days (guests above 0) among the 8 same weekdays before the day, so the line scales with the
// restaurant; with fewer than 3 such days there is none and only the closed rule applies.
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

type Effect = Pick<NoteContent, 'effect'>;
type StoredDay = Pick<SalesDay, 'guests' | 'netSalesCents'>;

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
 * Whether a day is closed or likely closed, from its stored row, its typical guests and the notes covering it; null
 * when it is open or has no row. Closed comes first, so a day closed by a note or an all-zero row is never "likely".
 */
export function closureOf(day: StoredDay | undefined, typical: number | null, covering: readonly Effect[]): Closure | null {
  if (covering.some((note) => note.effect === 'closed')) return 'closed';
  if (day === undefined) return null;
  if (isAllZero(day)) return 'closed';
  if (day.guests === null || typical === null) return null;
  if (covering.some((note) => note.effect === 'more_guests' || note.effect === 'fewer_guests')) return null;
  // A division, not guests < typical * 0.1, so exactly a tenth is never under it by a rounding error.
  return day.guests / typical < LIKELY_CLOSED_SHARE ? 'likely_closed' : null;
}
