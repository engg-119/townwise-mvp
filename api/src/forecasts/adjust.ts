// Notes in the forecast (spec 14.5): how a location's saved notes adjust one published forecast day on read. Runs are
// never rewritten; the reader calls this on every read, so an edited or deleted note shows on the next one.
//
// - A day before the town's today keeps the model's figures, and every note on it is `past_day`, so actuals, inRange
//   and live accuracy stay comparable with what the model said.
// - Status starts from the model's. A closure (a closure note, or any note closed but a buyout) closes the day; a
//   buyout (a private event, closed) books it unless it is closed. Closed beats booked beats open. A closed or booked
//   day has no figures.
// - On a day that ends open, each private event with more guests and a guest count adds its guests to low, mid and
//   high, unless the run already gave the day a booking reason (the exporter's private-event days), so a party is never
//   counted twice.
// - noteGuests: the guests those private events add on an open day, or the buyouts' party on a booked day.
// - Every other note is listed with why it changed nothing. Pure: no store, no clock.
import { isClosure } from '../agent/questions.ts';
import type { NoteRecord } from '../stores/notes.ts';
import type { DayStatus, ReasonKind } from './file.ts';

/** A day lists at most this many note reasons; the rest are counted in moreNotes. */
export const MAX_NOTE_REASONS = 6;

export type NoteOutcome =
  | 'added' //               a private event, more guests, with a guest count: +N to low, mid and high
  | 'booked' //              a private event with effect closed (a buyout): status booked
  | 'closed' //              a closure, or another closed note: status closed
  | 'already_in_forecast' // a private event on a run day that already carries a 'booking' reason
  | 'no_guest_count' //      a private event (more guests) with no expected guests
  | 'not_counted' //         an opening, an other note, fewer guests or unknown: listed, never changes a number
  | 'day_closed' //          a private event on a day that is closed or booked anyway
  | 'past_day'; //           the day is before the town's today: the model's numbers stand

/** The outcomes that changed the day; their reasons come before the run's. */
const APPLIED: ReadonlySet<NoteOutcome> = new Set(['added', 'booked', 'closed']);

export interface ModelDay { status: DayStatus; low: number | null; mid: number | null; high: number | null }

export interface AdjustedNote { note: NoteRecord; outcome: NoteOutcome }

export interface AdjustedDay extends ModelDay {
  /** Guests the counted private events add (open day), or the buyouts' party (booked day); 0 when none. */
  noteGuests: number;
  /** Every covering note in reason order: the ones that changed the day, then the rest, each oldest first. */
  notes: AdjustedNote[];
}

const isBuyout = (note: NoteRecord): boolean => note.kind === 'private_event' && note.effect === 'closed';

/** `notes` are the ones covering `date` (noteCovers), oldest first. */
export function adjustDay(
  date: string, today: string, model: ModelDay, runReasons: readonly { kind: ReasonKind }[], notes: readonly NoteRecord[],
): AdjustedDay {
  if (date < today) return { ...model, noteGuests: 0, notes: notes.map((note) => ({ note, outcome: 'past_day' })) };
  const closes = (note: NoteRecord): boolean => isClosure(note) && !isBuyout(note);
  const status: DayStatus = model.status === 'closed' || notes.some(closes)
    ? 'closed'
    : model.status === 'booked' || notes.some(isBuyout) ? 'booked' : 'open';
  const counted = !runReasons.some((reason) => reason.kind === 'booking');
  const outcomeOf = (note: NoteRecord): NoteOutcome => {
    if (closes(note)) return 'closed';
    if (isBuyout(note)) return status === 'closed' ? 'day_closed' : 'booked';
    if (note.kind !== 'private_event') return 'not_counted';
    if (status !== 'open') return 'day_closed';
    if (note.effect !== 'more_guests') return 'not_counted';
    if (note.expectedGuests === null) return 'no_guest_count';
    return counted ? 'added' : 'already_in_forecast';
  };
  const all = notes.map((note): AdjustedNote => ({ note, outcome: outcomeOf(note) }));
  const ordered = [...all.filter((entry) => APPLIED.has(entry.outcome)), ...all.filter((entry) => !APPLIED.has(entry.outcome))];
  const noteGuests = all
    .filter((entry) => entry.outcome === 'added' || entry.outcome === 'booked')
    .reduce((sum, entry) => sum + (entry.note.expectedGuests ?? 0), 0);
  if (status !== 'open') return { status, low: null, mid: null, high: null, noteGuests, notes: ordered };
  const plus = (value: number | null): number | null => (value === null ? null : value + noteGuests);
  return { status, low: plus(model.low), mid: plus(model.mid), high: plus(model.high), noteGuests, notes: ordered };
}

/**
 * A day's reasons: the notes that changed it, then the run's own reasons in run order, then the other notes, with at
 * most MAX_NOTE_REASONS notes in all; moreNotes counts the notes left out (their guests still count in the figures).
 */
export function orderedReasons<R>(
  day: AdjustedDay, runReasons: readonly R[], noteReason: (entry: AdjustedNote) => R,
): { reasons: R[]; moreNotes: number } {
  const applied = day.notes.filter((entry) => APPLIED.has(entry.outcome)).slice(0, MAX_NOTE_REASONS);
  const rest = day.notes.filter((entry) => !APPLIED.has(entry.outcome)).slice(0, MAX_NOTE_REASONS - applied.length);
  return {
    reasons: [...applied.map(noteReason), ...runReasons, ...rest.map(noteReason)],
    moreNotes: day.notes.length - applied.length - rest.length,
  };
}
