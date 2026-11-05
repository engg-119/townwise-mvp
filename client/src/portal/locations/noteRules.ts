import { EFFECT_LABEL, KIND_LABEL } from '../../chat/format';
import { formatCount, formatDate } from '../format';
import type { Note, NoteEffect, NoteInput, NoteKind } from './api';
import { daysBetween, EARLIEST_DATE, isCalendarDate, plusYears, utcToday } from './dates';

// The note form (C6) and the notes lists (spec 12, P14). The form checks the same rules as the API's
// readNoteContent (api/src/handlers/notes.ts), so a 400 means a client bug: the start date from 2010-01-01 to
// today plus two years, the end on or after it and at most 366 days later, unique weekdays, expected guests a whole
// number from 1 to 20,000 and none when closed, details up to 280 characters and required for Other.

export { EFFECT_LABEL, KIND_LABEL };

export const MAX_DETAIL = 280;
const MAX_SPAN_DAYS = 366;
const MAX_GUESTS = 20_000;

/** Each kind sets the form's default effect; the owner can change it (spec 12). */
export const DEFAULT_EFFECT: Readonly<Record<NoteKind, NoteEffect>> = {
  closure: 'closed',
  private_event: 'more_guests',
  opening: 'unknown',
  other: 'unknown',
};

/** The weekday buttons, Monday first as the mockup has them; the value is the API's (0 is Sunday). */
export const WEEKDAYS: readonly { value: number; short: string; plural: string }[] = [
  { value: 1, short: 'Mon', plural: 'Mondays' },
  { value: 2, short: 'Tue', plural: 'Tuesdays' },
  { value: 3, short: 'Wed', plural: 'Wednesdays' },
  { value: 4, short: 'Thu', plural: 'Thursdays' },
  { value: 5, short: 'Fri', plural: 'Fridays' },
  { value: 6, short: 'Sat', plural: 'Saturdays' },
  { value: 0, short: 'Sun', plural: 'Sundays' },
];

export const NOTE_COPY = {
  start: 'Enter the start date.',
  date: 'Enter a date as YYYY-MM-DD, for example 2026-03-02.',
  endBefore: 'The end date is before the start date.',
  range: 'Pick a range of a year or less.',
  guests: 'Enter a whole number from 1 to 20,000.',
  detailOther: 'Add details for an Other note.',
  detailLong: `Keep the details to ${String(MAX_DETAIL)} characters or fewer.`,
  saveFailed: 'Couldn’t save the note. Try again.',
  limit: 'This location has 1,000 notes. Delete old ones to add more.',
  detailHelp: 'Describe the event, not the guests. Leave out names. Up to 280 characters.',
} as const;

/** “Pick a start date from Jan 1, 2010 to {today plus two years}.” */
export function startRangeCopy(today: string): string {
  return `Pick a start date from ${formatDate(EARLIEST_DATE)} to ${formatDate(plusYears(today, 2))}.`;
}

/** What the form holds while it is edited. An empty end date means one day. */
export interface NoteDraft {
  kind: NoteKind;
  startDate: string;
  endDate: string;
  weekdays: readonly number[];
  effect: NoteEffect;
  expectedGuests: string;
  detail: string;
}

export interface NoteMessages { startDate?: string; endDate?: string; expectedGuests?: string; detail?: string }

export function emptyDraft(kind: NoteKind = 'closure'): NoteDraft {
  return { kind, startDate: '', endDate: '', weekdays: [], effect: DEFAULT_EFFECT[kind], expectedGuests: '', detail: '' };
}

export function draftOf(note: Note): NoteDraft {
  return {
    kind: note.kind,
    startDate: note.startDate,
    endDate: note.endDate === note.startDate ? '' : note.endDate,
    weekdays: note.weekdays ?? [],
    effect: note.effect,
    expectedGuests: note.expectedGuests === null ? '' : String(note.expectedGuests),
    detail: note.detail ?? '',
  };
}

function guestsOf(text: string): number | null | 'invalid' {
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^\d+$/.test(cleaned)) return 'invalid';
  const value = Number(cleaned);
  return value >= 1 && value <= MAX_GUESTS ? value : 'invalid';
}

/** The API's NoteInput, or the field messages that stop the form. `today` is the server's day (UTC). */
export function checkNote(draft: NoteDraft, today: string = utcToday()): { input: NoteInput } | { messages: NoteMessages } {
  const messages: NoteMessages = {};
  const start = draft.startDate.trim();
  const typedEnd = draft.endDate.trim();
  const end = typedEnd === '' ? start : typedEnd;
  if (start === '') messages.startDate = NOTE_COPY.start;
  else if (!isCalendarDate(start)) messages.startDate = NOTE_COPY.date;
  else if (start < EARLIEST_DATE || start > plusYears(today, 2)) messages.startDate = startRangeCopy(today);
  if (typedEnd !== '' && !isCalendarDate(typedEnd)) messages.endDate = NOTE_COPY.date;
  else if (messages.startDate === undefined && end < start) messages.endDate = NOTE_COPY.endBefore;
  else if (messages.startDate === undefined && daysBetween(start, end) > MAX_SPAN_DAYS) messages.endDate = NOTE_COPY.range;
  const guests = draft.effect === 'closed' ? null : guestsOf(draft.expectedGuests);
  if (guests === 'invalid') messages.expectedGuests = NOTE_COPY.guests;
  const detail = draft.detail.trim();
  if (detail.length > MAX_DETAIL) messages.detail = NOTE_COPY.detailLong;
  else if (draft.kind === 'other' && detail === '') messages.detail = NOTE_COPY.detailOther;
  if (guests === 'invalid' || Object.keys(messages).length > 0) return { messages };
  const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
  return {
    input: {
      kind: draft.kind,
      startDate: start,
      endDate: end,
      weekdays: weekdays.length === 0 ? null : weekdays,
      effect: draft.effect,
      expectedGuests: guests,
      detail: detail === '' ? null : detail,
    },
  };
}

/** “Mondays only”, “Saturdays and Sundays only”, Monday first; null for every day. */
export function weekdaysLine(weekdays: readonly number[] | null): string | null {
  if (weekdays === null || weekdays.length === 0 || weekdays.length >= 7) return null;
  const names = WEEKDAYS.filter((day) => weekdays.includes(day.value)).map((day) => day.plural);
  const list = names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
  return `${list} only`;
}

/** “Mar 2, 2026 to Mar 9, 2026”, or the one day. */
export function datesLine(note: Pick<Note, 'startDate' | 'endDate'>): string {
  return note.startDate === note.endDate ? formatDate(note.startDate) : `${formatDate(note.startDate)} to ${formatDate(note.endDate)}`;
}

export function guestsLine(expectedGuests: number | null): string | null {
  return expectedGuests === null ? null : `About ${formatCount(expectedGuests)} guests`;
}

/** “Coming up” (ending today or later) and “Past”, each in the API's order (by start date). */
export function splitNotes(notes: readonly Note[], today: string): { comingUp: Note[]; past: Note[] } {
  return {
    comingUp: notes.filter((note) => note.endDate >= today),
    past: notes.filter((note) => note.endDate < today),
  };
}

/** The API's order: start date, then when it was added. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
