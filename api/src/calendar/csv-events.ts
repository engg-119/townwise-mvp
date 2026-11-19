// A calendar exported as CSV (openspec change learn-from-calendar-bookings, D58, design decisions 2 and 3), read on the
// server in code, never by a model, with the .ics rules of calendar/ics.ts after the times are read. Pure; nothing here
// logs. One profile: a first record (after any byte-order mark, read by files/parse/csv.ts) holding the headers
// `event_id`, `title`, `start_at` and `end_at`, trimmed and in any case and order, other columns allowed. Each row is
// read for those four and, when present, `status` only: a `cancelled` row is left out, and the other columns
// (descriptions, locations, organizers, attendees, emails, attachments, colors, calendar ids, Google URLs) are never
// read, so none of them is kept. A value with an offset or `Z` is an instant, the town's wall date and time; one with no
// offset is the wall time it says [CONFIRM: a calendar CSV time with no offset is the town's wall time]; a bare
// YYYY-MM-DD is a date; the `timezone` column is not used. Then spanOf's dates and hours, titleOf's title (no
// unescaping) and FILE_WINDOW. A row whose start cannot be read is skipped and counted. Each row is a single event, a
// repeating series' instances included (the export lists each), so skippedRepeating is 0. The uid is the trimmed
// `event_id` (`event-{n}` for a blank one, `{id}#{n}` for a repeat), keyed as an .ics UID is (stated once, at most
// 1,024 characters).
// parseCalendarFile, the add's entry, picks the format: an .ics file (a BEGIN:VCALENDAR line) is parseIcs's, a CSV of
// this profile is parseCalendarCsv's, and anything else is not_calendar. It lives here, not in ics.ts, so the two
// files do not import each other.
import { CsvReader, detectDelimiter, parseCsv, stripBom } from '../files/parse/csv.ts';
import { isCalendarDate } from '../dates.ts';
import {
  FILE_WINDOW, keepWindow, MAX_KEY_CHARS, parseIcs, spanOf, titleOf, townClock,
  type IcsEvent, type IcsTown, type Moment, type TownClock,
} from './ics.ts';

/** The headers a calendar CSV must hold, as they are matched (trimmed, lower case). */
export const CALENDAR_CSV_HEADERS = ['event_id', 'title', 'start_at', 'end_at'] as const;

/** The columns a row is read for: the four, and `status` when the export has one. */
interface CsvColumns {
  readonly eventId: number;
  readonly title: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly status: number | null;
}

/** A calendar file read for an add: its events, the repeating ones not imported, the rows skipped, and its format. */
export type CalendarFileResult =
  | { readonly events: IcsEvent[]; readonly skippedRepeating: number; readonly skippedRows: number; readonly format: 'ics' | 'csv' }
  | { readonly error: 'not_calendar' };

function columnsOf(record: readonly string[]): CsvColumns | null {
  const names = record.map((name) => name.trim().toLowerCase());
  const at = (name: string): number => names.indexOf(name);
  const [eventId, title, startAt, endAt] = CALENDAR_CSV_HEADERS.map(at);
  if (eventId === undefined || title === undefined || startAt === undefined || endAt === undefined) return null;
  if (eventId < 0 || title < 0 || startAt < 0 || endAt < 0) return null;
  const status = at('status');
  return { eventId, title, startAt, endAt, status: status < 0 ? null : status };
}

/** Whether a header record is the calendar CSV profile's (D58): the file reader keeps such a file `calendar_export`. */
export function isCalendarCsvHeader(record: readonly string[]): boolean {
  return columnsOf(record) !== null;
}

/** Whether a text's first record is the calendar CSV profile's header: Read with TownwiseAI skips such a file (D58). */
export function isCalendarCsvText(text: string): boolean {
  const clean = stripBom(text);
  return isCalendarCsvHeader(new CsvReader(clean, detectDelimiter(clean)).next() ?? []);
}

/** YYYY-MM-DD, or that with a time ('T' or a space) to the minute, seconds and fractions allowed, then Z or ±HH:MM. */
const CSV_MOMENT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

function momentOf(value: string | undefined, clock: TownClock): Moment | null {
  const match = CSV_MOMENT.exec(value?.trim() ?? '');
  if (match === null) return null;
  const [, year = '', month = '', day = '', hour, minute, second = '00', zone] = match;
  const date = `${year}-${month}-${day}`;
  if (!isCalendarDate(date)) return null;
  if (hour === undefined || minute === undefined) return { date, time: null };
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone === undefined) return { date, time: `${hour}:${minute}` };
  const offset = zone.toUpperCase() === 'Z' ? 0 : offsetMinutes(zone);
  if (offset === null) return null;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - offset * 60_000;
  return Number.isNaN(at) ? null : clock(new Date(at));
}

/** '+05:30', '-0400': minutes east of UTC, or null past 14 hours. */
function offsetMinutes(zone: string): number | null {
  const digits = zone.slice(1).replace(':', '');
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
  if (Number(digits.slice(2)) > 59 || minutes > 14 * 60) return null;
  return zone.startsWith('-') ? -minutes : minutes;
}

/**
 * A calendar CSV's single events in FILE_WINDOW, by start, at most 2,000, with the rows skipped for an unreadable start;
 * not_calendar when its first record is not the profile's header.
 */
export function parseCalendarCsv(text: string, town: IcsTown): { events: IcsEvent[]; skippedRepeating: 0; skippedRows: number } | { error: 'not_calendar' } {
  const records = parseCsv(text);
  const columns = columnsOf(records[0] ?? []);
  if (columns === null) return { error: 'not_calendar' };
  const clock = townClock(town.timeZone);
  let skippedRows = 0;
  const uids = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const stated: string[] = [];
  const statedCount = new Map<string, number>();
  const drafts: Omit<IcsEvent, 'keyed'>[] = [];
  records.slice(1).forEach((record, index) => {
    if (record.every((field) => field.trim() === '')) return;
    if (columns.status !== null && record[columns.status]?.trim().toLowerCase() === 'cancelled') return;
    const start = momentOf(record[columns.startAt], clock);
    if (start === null) { skippedRows += 1; return; }
    const row = index + 1;
    const given = record[columns.eventId]?.trim() ?? '';
    const base = given === '' ? `event-${String(row)}` : given;
    // As parseIcs: a taken key gets the next free suffix, its search starting where the base's last one stopped.
    let uid = base;
    let suffix = Math.max(row, nextSuffix.get(base) ?? 0);
    for (; uids.has(uid); suffix += 1) uid = `${base}#${String(suffix)}`;
    if (uid !== base) nextSuffix.set(base, suffix);
    uids.add(uid);
    stated.push(given);
    if (given !== '') statedCount.set(given, (statedCount.get(given) ?? 0) + 1);
    drafts.push({ uid, title: titleOf(record[columns.title]), ...spanOf(start, momentOf(record[columns.endAt], clock)) });
  });
  const events = drafts.map((draft, index): IcsEvent => {
    const given = stated[index] ?? '';
    return { ...draft, keyed: given !== '' && draft.uid === given && statedCount.get(given) === 1 && given.length <= MAX_KEY_CHARS };
  });
  return { events: keepWindow(events, town.today, FILE_WINDOW), skippedRepeating: 0, skippedRows };
}

/** An imported calendar file, .ics or CSV, in FILE_WINDOW; anything else is not_calendar. */
export function parseCalendarFile(text: string, town: IcsTown): CalendarFileResult {
  const ics = parseIcs(text, town, FILE_WINDOW);
  if (!('error' in ics)) return { ...ics, skippedRows: 0, format: 'ics' };
  const csv = parseCalendarCsv(text, town);
  return 'error' in csv ? csv : { ...csv, format: 'csv' };
}
