import { EFFECT_LABEL, KIND_LABEL } from '../../chat/format';
import { formatCount, formatDate } from '../format';
import type { Note, NoteEffect, NoteInput, NoteKind } from './api';
import { daysBetween, EARLIEST_DATE, isCalendarDate, plusYears, utcToday } from './dates';

// The note form (C6) and the notes lists (spec 12, P14). The form checks the same rules as the API's
// readNoteContent (api/src/handlers/notes.ts), so a 400 means a client bug: the start date from 2010-01-01 to
// today plus two years, the end on or after it and at most 366 days later, unique weekdays, expected guests a whole
// number from 1 to 20,000 and none when closed except on a buyout (a private event, closed, where they are the
// party's size), details up to 280 characters, an event name (D49) of one line up to 120 characters (NFC, no control or
// format character, each run of white space one space), an event name or details for Other, and hours (local 24-hour
// 'HH:MM') both set or both empty, the start before the end, and none on a closure.

export { EFFECT_LABEL, KIND_LABEL };

export const MAX_DETAIL = 280;
/** An event name's limit in code points, as the API counts it (D49). */
export const MAX_TITLE = 120;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const MAX_SPAN_DAYS = 366;
const MAX_GUESTS = 20_000;
/** Local wall-clock time, 24-hour 'HH:MM', as the API takes it. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  detailOther: 'Add an event name or details for an Other note.',
  titleLong: `Keep the event name to ${String(MAX_TITLE)} characters or fewer.`,
  titleHidden: 'Remove the line breaks, tabs or hidden characters from the event name.',
  titleHelp: 'Name the event, not the guests.',
  detailLong: `Keep the details to ${String(MAX_DETAIL)} characters or fewer.`,
  saveFailed: 'Couldn’t save the note. Try again.',
  limit: 'This location has 1,000 notes. Delete old ones to add more.',
  detailHelp: 'Describe the event, not the guests. Leave out names. Up to 280 characters.',
  time: 'Enter a time as HH:MM, for example 18:30.',
  timeOrder: 'The end time is before the start time.',
  timePair: 'Enter both times, or neither.',
  /** A note TownwiseAI made from a file (D34): under its author on Notes, and in its edit form. */
  fromAiFile: 'From a file TownwiseAI read',
  fromAiFileEdit: 'Undoing that file’s read removes this note, even after an edit.',
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
  /** The event's name (D49); empty for none. */
  title: string;
  /** 'HH:MM' or empty; both empty means all day. */
  startTime: string;
  endTime: string;
}

export interface NoteMessages {
  startDate?: string; endDate?: string; expectedGuests?: string; detail?: string; title?: string; startTime?: string; endTime?: string;
}

export function emptyDraft(kind: NoteKind = 'closure'): NoteDraft {
  return {
    kind, startDate: '', endDate: '', weekdays: [], effect: DEFAULT_EFFECT[kind], expectedGuests: '', detail: '', title: '', startTime: '', endTime: '',
  };
}

export function draftOf(note: Note): NoteDraft {
  return draftOfContent(note);
}

/** The form's draft of a note's content: a saved note, or one TownwiseAI proposed (its card's Edit first; it has no hours). */
export function draftOfContent(content: NoteInput): NoteDraft {
  return {
    kind: content.kind,
    startDate: content.startDate,
    endDate: content.endDate === content.startDate ? '' : content.endDate,
    weekdays: content.weekdays ?? [],
    effect: content.effect,
    expectedGuests: content.expectedGuests === null ? '' : String(content.expectedGuests),
    detail: content.detail ?? '',
    title: content.title ?? '',
    startTime: content.startTime ?? '',
    endTime: content.endTime ?? '',
  };
}

/**
 * The form's draft of a note made from an event in one of the location's own calendars (spec 16.3 P28): a private
 * event, more guests, the event's dates and, for a timed one-day event, its hours. An event running past midnight to
 * 06:00 is its start day's only (api/src/calendar/ics.ts), and its hours are left out, since a note's end comes after
 * its start. The detail and the event name start empty, and the title is never copied (D33): calendar titles often
 * name customers, and a Google event's is never shown to staff (D39).
 */
export function draftOfImported(event: { startDate: string; endDate: string; startTime: string | null; endTime: string | null }): NoteDraft {
  const { startTime, endTime } = event;
  const timed = startTime !== null && endTime !== null && startTime < endTime;
  return {
    ...emptyDraft('private_event'),
    startDate: event.startDate,
    endDate: event.endDate === event.startDate ? '' : event.endDate,
    startTime: timed ? startTime : '',
    endTime: timed ? endTime : '',
  };
}

function guestsOf(text: string): number | null | 'invalid' {
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  if (!/^\d+$/.test(cleaned)) return 'invalid';
  const value = Number(cleaned);
  return value >= 1 && value <= MAX_GUESTS ? value : 'invalid';
}

/** A buyout: a private event that closes the day to walk-ins. Its expected guests are the party's size. */
function isBuyout(draft: Pick<NoteDraft, 'kind' | 'effect'>): boolean {
  return draft.kind === 'private_event' && draft.effect === 'closed';
}

/** The hours, or none on a closure (the form hides them there, so anything typed before is dropped). */
function hoursOf(draft: NoteDraft, messages: NoteMessages): { startTime: string | null; endTime: string | null } {
  if (draft.kind === 'closure') return { startTime: null, endTime: null };
  const start = draft.startTime.trim();
  const end = draft.endTime.trim();
  if (start !== '' && !CLOCK_TIME.test(start)) messages.startTime = NOTE_COPY.time;
  if (end !== '' && !CLOCK_TIME.test(end)) messages.endTime = NOTE_COPY.time;
  if (start === '' && end !== '') messages.startTime = NOTE_COPY.timePair;
  else if (end === '' && start !== '') messages.endTime = NOTE_COPY.timePair;
  // 'HH:MM' strings order as the times do; an event ends by midnight on its own day.
  else if (messages.startTime === undefined && messages.endTime === undefined && start !== '' && end <= start) messages.endTime = NOTE_COPY.timeOrder;
  return { startTime: start === '' ? null : start, endTime: end === '' ? null : end };
}

/**
 * A business rule's schedule as the API takes it (spec 10.16, D31): a note's fields but its detail, with `endDate` null
 * for no end.
 */
export interface ScheduleInput extends Omit<NoteInput, 'detail' | 'title' | 'endDate' | 'startTime' | 'endTime'> {
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
}

/**
 * The fields a note and a rule's schedule share, checked with the API's rules (its validDays), or null with the
 * messages that stop the form. An empty end date is one day for a note, no end for a schedule (`openEnd`).
 */
function checkFields(draft: NoteDraft, today: string, openEnd: boolean, messages: NoteMessages): ScheduleInput | null {
  const start = draft.startDate.trim();
  const typedEnd = draft.endDate.trim();
  const end = typedEnd === '' ? (openEnd ? null : start) : typedEnd;
  if (start === '') messages.startDate = NOTE_COPY.start;
  else if (!isCalendarDate(start)) messages.startDate = NOTE_COPY.date;
  else if (start < EARLIEST_DATE || start > plusYears(today, 2)) messages.startDate = startRangeCopy(today);
  if (typedEnd !== '' && !isCalendarDate(typedEnd)) messages.endDate = NOTE_COPY.date;
  else if (messages.startDate === undefined && end !== null && end < start) messages.endDate = NOTE_COPY.endBefore;
  else if (messages.startDate === undefined && end !== null && daysBetween(start, end) > MAX_SPAN_DAYS) messages.endDate = NOTE_COPY.range;
  const guests = draft.effect === 'closed' && !isBuyout(draft) ? null : guestsOf(draft.expectedGuests);
  if (guests === 'invalid') messages.expectedGuests = NOTE_COPY.guests;
  const hours = hoursOf(draft, messages);
  if (guests === 'invalid' || Object.keys(messages).length > 0) return null;
  const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
  return {
    kind: draft.kind,
    startDate: start,
    endDate: end,
    weekdays: weekdays.length === 0 ? null : weekdays,
    effect: draft.effect,
    expectedGuests: guests,
    startTime: hours.startTime,
    endTime: hours.endTime,
  };
}

/** The API's NoteInput, or the field messages that stop the form. `today` is the server's day (UTC). */
export function checkNote(draft: NoteDraft, today: string = utcToday()): { input: NoteInput } | { messages: NoteMessages } {
  const messages: NoteMessages = {};
  const detail = draft.detail.trim();
  const typed = draft.title.normalize('NFC');
  const title = typed.replace(/\s+/gu, ' ').trim();
  if (CONTROL_OR_FORMAT.test(typed)) messages.title = NOTE_COPY.titleHidden;
  else if (Array.from(title).length > MAX_TITLE) messages.title = NOTE_COPY.titleLong;
  if (detail.length > MAX_DETAIL) messages.detail = NOTE_COPY.detailLong;
  else if (draft.kind === 'other' && detail === '' && title === '') messages.detail = NOTE_COPY.detailOther;
  const fields = checkFields(draft, today, false, messages);
  if (fields === null || Object.keys(messages).length > 0) return { messages };
  return {
    input: { ...fields, endDate: fields.endDate ?? fields.startDate, detail: detail === '' ? null : detail, title: title === '' ? null : title },
  };
}

/**
 * A rule's schedule, or the field messages that stop the form: the note's checks but the detail, which a schedule never
 * has or needs, and an empty end date for no end. `today` is the server's day (UTC).
 */
export function checkSchedule(draft: NoteDraft, today: string = utcToday()): { input: ScheduleInput } | { messages: NoteMessages } {
  const messages: NoteMessages = {};
  const fields = checkFields(draft, today, true, messages);
  return fields === null ? { messages } : { input: fields };
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

/** A local 'HH:MM' in words, as the API's reasons put it: '18:30' is “6:30 pm”, '18:00' “6 pm”, '12:00' “noon”. */
export function clockWords(time: string): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  if (minutes === 0 && hours === 12) return 'noon';
  if (minutes === 0 && hours === 0) return 'midnight';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(hour)}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`} ${hours < 12 ? 'am' : 'pm'}`;
}

/** “6 pm to 9 pm”; null for all day (a note from an API before hours has neither). */
export function hoursLine(note: { startTime?: string | null | undefined; endTime?: string | null | undefined }): string | null {
  const startTime = note.startTime ?? null;
  const endTime = note.endTime ?? null;
  if (startTime === null || endTime === null) return null;
  return `${clockWords(startTime)} to ${clockWords(endTime)}`;
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
