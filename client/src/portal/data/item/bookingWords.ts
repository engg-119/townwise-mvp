import { ApiError } from '../../../api/client';
import type { BookingLabel, CalendarBookings } from '../../calendar/api';
import { monthLabel } from '../../calendar/model';
import { errorCopy, hasCode } from '../../errors';
import { formatCount, formatDate, plural } from '../../format';

// The Bookings section's words (D58, learn-from-calendar-bookings design decisions 7, 10, 11 and 15), pure: each
// label's name, the calendar's state, the counts, the words shown before Sort with TownwiseAI is pressed, what a sort,
// a label and Use for forecasts did, and the words for each refusal the bookings routes answer. A label's words name no
// customer; an event's title is the file's, shown as text. Approved by the owner on 2026-11-19.

/** A label, or none. */
export type BookingChoice = BookingLabel | 'none';

/** Each label's name in the counts and the label choice, in the order they show. */
export const BOOKING_NAMES: Readonly<Record<BookingChoice, string>> = {
  buyout: 'Buyout (takes the whole restaurant)',
  party: 'Party (alongside regular service)',
  own_event: 'Your own event',
  other: 'Not a booking',
  none: 'No label',
};

/** Each label's short name, in a result line and under an event. */
const SHORT_NAMES: Readonly<Record<BookingChoice, string>> = {
  buyout: 'Buyout', party: 'Party', own_event: 'Your own event', other: 'Not a booking', none: 'No label',
};

export const BOOKING_CHOICES: readonly BookingChoice[] = ['buyout', 'party', 'own_event', 'other', 'none'];

/** The filter's choices: every event, or one label's. */
export const FILTER_ALL = 'all';
export type BookingFilter = BookingChoice | typeof FILTER_ALL;

export const BOOKINGS = {
  heading: 'Bookings',
  sort: 'Sort with TownwiseAI',
  sorting: 'Sorting…',
  /** Shown before Sort with TownwiseAI is pressed, and describing it. */
  sortExplain: 'Sends this calendar’s event titles, dates and hours to Anthropic once, to sort them. Anthropic doesn’t train on them. Nothing changes until you press Use for forecasts.',
  /** For staff open as admin, in Sort's place (design decision 7: Sort sends customers' names to Anthropic). */
  staffNoSort: 'Sort with TownwiseAI isn’t available while setting up as Townwise staff.',
  confirm: 'Use for forecasts',
  confirming: 'Saving…',
  labelField: 'Label',
  filterField: 'Show',
  filterAll: 'All events',
  failedBatches: 'Some events weren’t labeled. Sort again to try them.',
  noneToSort: 'Every event already has a label.',
  noteKept: 'Its note is still on the Calendar.',
  noteMade: 'Made a note for it on the Calendar.',
  refitStarted: 'Townwise started learning from them now.',
  refitLater: 'The next weekly refresh will learn from them.',
} as const;

/** An event's label as a choice: none for an event with no label. */
export function choiceOf(booking: BookingLabel | null): BookingChoice {
  return booking ?? 'none';
}

export function shortName(choice: BookingChoice): string {
  return SHORT_NAMES[choice];
}

/** The filter's items for ui/Select: All events, then each label. */
export function filterItems(): { value: string; label: string }[] {
  return [{ value: FILTER_ALL, label: BOOKINGS.filterAll }, ...BOOKING_CHOICES.map((choice) => ({ value: choice, label: BOOKING_NAMES[choice] }))];
}

/** A label choice's items for ui/Select. */
export function choiceItems(): { value: string; label: string }[] {
  return BOOKING_CHOICES.map((choice) => ({ value: choice, label: BOOKING_NAMES[choice] }));
}

/** Where the calendar's labels stand: not sorted, sorted and not used yet, or used for forecasts since a date. */
export function bookingsStateLine(bookings: Pick<CalendarBookings, 'state' | 'confirmedAt'>): string {
  if (bookings.state === 'confirmed') {
    return bookings.confirmedAt === null ? 'Used for forecasts.' : `Used for forecasts since ${formatDate(bookings.confirmedAt)}.`;
  }
  if (bookings.state === 'sorted') return 'Sorted, not used for forecasts yet.';
  return 'Not sorted yet, and not used for forecasts.';
}

/** The counts, one row per label in BOOKING_CHOICES's order, for ui/DefinitionList. */
export function countRows(counts: CalendarBookings['counts']): { term: string; value: string }[] {
  const of = (choice: BookingChoice): number => (choice === 'none' ? counts.unlabeled : counts[choice]);
  return BOOKING_CHOICES.map((choice) => ({ term: BOOKING_NAMES[choice], value: plural(of(choice), 'event', 'events') }));
}

/** What a sort did: “TownwiseAI labeled 40 of 42 events.”, and the failed batches' words when any failed. */
export function sortedLines(result: { sent: number; labeled: number; batchesFailed: number }): string[] {
  const lines = [result.sent === 0 ? BOOKINGS.noneToSort : `TownwiseAI labeled ${formatCount(result.labeled)} of ${plural(result.sent, 'event', 'events')}.`];
  if (result.batchesFailed > 0) lines.push(BOOKINGS.failedBatches);
  return lines;
}

/** What a label change did: “Set Wine tasting to Party.”, with the note made or kept. */
export function labeledLine(title: string, choice: BookingChoice, result: { noteMade: boolean; noteKept: boolean }): string {
  const set = `Set ${title} to ${shortName(choice)}.`;
  if (result.noteMade) return `${set} ${BOOKINGS.noteMade}`;
  return result.noteKept ? `${set} ${BOOKINGS.noteKept}` : set;
}

/** What Use for forecasts did: the notes made, any left without one, and when Townwise learns from the labels. */
export function confirmedLines(result: { notesMade: number; notesLeft: number; calibration: { status: string } | null }): string[] {
  const lines = [`Made ${plural(result.notesMade, 'note', 'notes')} for upcoming bookings.`];
  if (result.notesLeft > 0) {
    lines.push(`${plural(result.notesLeft, 'more upcoming booking', 'more upcoming bookings')} got no note. Press Use for forecasts again.`);
  }
  lines.push(result.calibration?.status === 'started' ? BOOKINGS.refitStarted : BOOKINGS.refitLater);
  return lines;
}

/** The month's list with none of the filter's label: “No events labeled Party in November 2026.” */
export function emptyFilterLine(filter: BookingChoice, month: string): string {
  return filter === 'none' ? `No events without a label in ${monthLabel(month)}.` : `No events labeled ${shortName(filter)} in ${monthLabel(month)}.`;
}

/** “in 4 minutes”, “in 1 minute”, or “in a few minutes” without a wait. */
function inMinutes(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return 'in a few minutes';
  return `in ${plural(Math.max(1, Math.ceil(retryAfterSeconds / 60)), 'minute', 'minutes')}`;
}

/** The words for a refused sort, label or Use for forecasts. */
export function bookingsError(error: unknown): string {
  if (hasCode(error, 409, 'chat_budget_exhausted')) {
    return 'Your organization’s TownwiseAI budget for this month is spent, so TownwiseAI can’t sort this calendar until next month. You can still label events yourself.';
  }
  if (error instanceof ApiError && hasCode(error, 429, 'rate_limited')) {
    return `This calendar was sorted 3 times in the last hour. Try again ${inMinutes(error.retryAfterSeconds)}.`;
  }
  if (hasCode(error, 503, 'chat_unavailable')) return 'TownwiseAI isn’t available right now, so it can’t sort this calendar. You can still label events yourself.';
  if (hasCode(error, 403, 'open_as_admin_refused')) return BOOKINGS.staffNoSort;
  if (hasCode(error, 409, 'not_a_file_calendar')) return 'Only an imported calendar file has bookings to label.';
  if (hasCode(error, 404, 'not_found')) return 'This calendar or event isn’t here anymore. Reload the page.';
  return errorCopy(error);
}
