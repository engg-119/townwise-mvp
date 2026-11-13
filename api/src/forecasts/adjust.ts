// Notes in the forecast (spec 14.5): how a location's saved notes adjust one published forecast day on read. Runs are
// never rewritten; the reader calls this on every read, so an edited or deleted note shows on the next one.
//
// - A day before the town's today keeps the model's figures, and every note on it is `past_day`, so actuals, inRange
//   and live accuracy stay comparable with what the model said.
// - Status: a closure (a closure note, or any note closed but a buyout) closes the day, whatever the model said.
//   Otherwise a buyout (a private event, closed) books it, even a day the model closed. Otherwise the model's status
//   stands, except that a private event with more guests and a guest count opens a day the model closed (a learned
//   closure, such as a weekday). A closed or booked day has no figures. Marked for the team's confirmation in spec 14.5.
// - On a day that ends open, each private event with more guests and a guest count adds its guests to low, mid and
//   high, unless the run already gave the day a booking reason (the exporter's private-event days), so a party is never
//   counted twice. A day the model closed has no figures of its own, so one a party opened is low = mid = high = guests.
// - noteGuests: the guests those private events add on an open day, or the buyouts' party on a booked day.
// - Every other note is listed with why it changed nothing.
// - A business rule with a schedule (D31) is applied exactly as a note with the same fields is: its closure closes the
//   day, its buyout books it, its private event with a guest count adds its guests, and every outcome above holds for it.
//   Rules and notes on one day all apply together: guests add up, and a closure from either wins. Pure: no store, no clock.
import { isClosure } from '../agent/questions.ts';
import type { BusinessRuleRecord, RuleSchedule } from '../stores/business-rules.ts';
import type { NoteContent, NoteRecord } from '../stores/notes.ts';
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
  | 'day_closed' //          a private event on a day that stays closed
  | 'day_booked' //          a private event (not a buyout) on a day that is booked
  | 'past_day'; //           the day is before the town's today: the model's numbers stand

/** The outcomes that changed the day; their reasons come before the run's. */
const APPLIED: ReadonlySet<NoteOutcome> = new Set(['added', 'booked', 'closed']);

export interface ModelDay { status: DayStatus; low: number | null; mid: number | null; high: number | null }

export interface AdjustedNote { note: NoteRecord; outcome: NoteOutcome }

/** A business rule with a schedule (D31), as the forecast read applies it: its id and schedule, never its text. */
export interface ScheduledRule { readonly id: string; readonly schedule: RuleSchedule }

export interface AdjustedRule { rule: ScheduledRule; outcome: NoteOutcome }

/** The rules that carry a schedule, as their id and schedule only. */
export function scheduledRules(rules: readonly Pick<BusinessRuleRecord, 'id' | 'schedule'>[]): ScheduledRule[] {
  return rules.flatMap((rule) => (rule.schedule === null ? [] : [{ id: rule.id, schedule: rule.schedule }]));
}

export interface AdjustedDay extends ModelDay {
  /** Guests the counted private events of notes and rules add (open day), or the buyouts' party (booked day); 0 when none. */
  noteGuests: number;
  /** Every covering note in reason order: the ones that changed the day, then the rest, each oldest first. */
  notes: AdjustedNote[];
  /** Every covering rule, in the same order. */
  rules: AdjustedRule[];
}

/** What the adjustment reads of a note or a rule's schedule. */
type Effect = Pick<NoteContent, 'kind' | 'effect' | 'expectedGuests'>;

const isBuyout = (entry: Effect): boolean => entry.kind === 'private_event' && entry.effect === 'closed';
const isParty = (entry: Effect): boolean => entry.kind === 'private_event' && entry.effect === 'more_guests' && entry.expectedGuests !== null;
const closes = (entry: Effect): boolean => isClosure(entry) && !isBuyout(entry);
const applied = <T extends { outcome: NoteOutcome }>(entries: readonly T[]): T[] => entries.filter((entry) => APPLIED.has(entry.outcome));
const unapplied = <T extends { outcome: NoteOutcome }>(entries: readonly T[]): T[] => entries.filter((entry) => !APPLIED.has(entry.outcome));

/** `notes` and `rules` are the ones covering `date` (noteCovers), oldest first. */
export function adjustDay(
  date: string, today: string, model: ModelDay, runReasons: readonly { kind: ReasonKind }[], notes: readonly NoteRecord[],
  rules: readonly ScheduledRule[] = [],
): AdjustedDay {
  if (date < today) {
    return {
      ...model, noteGuests: 0,
      notes: notes.map((note) => ({ note, outcome: 'past_day' })),
      rules: rules.map((rule) => ({ rule, outcome: 'past_day' })),
    };
  }
  const effects: Effect[] = [...notes, ...rules.map((rule) => rule.schedule)];
  const closedByNote = effects.some(closes);
  const status: DayStatus = closedByNote ? 'closed'
    : effects.some(isBuyout) || model.status === 'booked' ? 'booked'
    : model.status === 'closed' && !effects.some(isParty) ? 'closed' : 'open';
  const opened = model.status === 'closed' && status === 'open';
  const counted = opened || !runReasons.some((reason) => reason.kind === 'booking');
  const outcomeOf = (entry: Effect): NoteOutcome => {
    if (closes(entry)) return 'closed';
    if (isBuyout(entry)) return status === 'closed' ? 'day_closed' : 'booked';
    if (entry.kind !== 'private_event') return 'not_counted';
    if (status === 'booked') return 'day_booked';
    // On a day only the model closed, a guest count would open it, so the note says so.
    if (entry.effect === 'more_guests' && entry.expectedGuests === null) return closedByNote ? 'day_closed' : 'no_guest_count';
    if (status === 'closed') return 'day_closed';
    if (entry.effect !== 'more_guests') return 'not_counted';
    return counted ? 'added' : 'already_in_forecast';
  };
  const allNotes = notes.map((note): AdjustedNote => ({ note, outcome: outcomeOf(note) }));
  const allRules = rules.map((rule): AdjustedRule => ({ rule, outcome: outcomeOf(rule.schedule) }));
  const ordered = {
    notes: [...applied(allNotes), ...unapplied(allNotes)],
    rules: [...applied(allRules), ...unapplied(allRules)],
  };
  const guestsOf = (outcome: NoteOutcome, entry: Effect): number => (outcome === 'added' || outcome === 'booked' ? entry.expectedGuests ?? 0 : 0);
  const noteGuests = allNotes.reduce((sum, entry) => sum + guestsOf(entry.outcome, entry.note), 0)
    + allRules.reduce((sum, entry) => sum + guestsOf(entry.outcome, entry.rule.schedule), 0);
  if (status !== 'open') return { status, low: null, mid: null, high: null, noteGuests, ...ordered };
  if (opened) return { status, low: noteGuests, mid: noteGuests, high: noteGuests, noteGuests, ...ordered };
  const plus = (value: number | null): number | null => (value === null ? null : value + noteGuests);
  return { status, low: plus(model.low), mid: plus(model.mid), high: plus(model.high), noteGuests, ...ordered };
}

/**
 * A day's reasons: the rules, then the notes, that changed it; the run's own reasons in run order; then the other rules
 * and notes. At most MAX_NOTE_REASONS notes in all, and moreNotes counts the notes left out (their guests still count in
 * the figures). Rules are never left out: a location has at most 30 (D31).
 */
export function orderedReasons<R>(
  day: AdjustedDay, runReasons: readonly R[], reasonOf: (entry: AdjustedNote | AdjustedRule) => R,
): { reasons: R[]; moreNotes: number } {
  const notesApplied = applied(day.notes).slice(0, MAX_NOTE_REASONS);
  const notesRest = unapplied(day.notes).slice(0, MAX_NOTE_REASONS - notesApplied.length);
  return {
    reasons: [
      ...applied(day.rules).map(reasonOf), ...notesApplied.map(reasonOf), ...runReasons,
      ...unapplied(day.rules).map(reasonOf), ...notesRest.map(reasonOf),
    ],
    moreNotes: day.notes.length - notesApplied.length - notesRest.length,
  };
}
