import { addDays, isCalendarDate } from '../locations/dates';
import type { ImportedEvent } from './model';

// The owner's calendar file (P27, spec 16.3 and 17), parsed in the browser: an exported .ics file
// (RFC 5545) as the single events the Calendar shows under "Your calendar". Pure, and nothing here leaves the page.
// Folded lines are unfolded; each VEVENT's UID, SUMMARY (unescaped), DTSTART and DTEND are read, and lines inside
// its VALARMs are not the event's. A date-only event ends the day before its DTEND (which is exclusive), and one
// with no DTEND is one day. A local or TZID time is the wall time it says; a UTC ("Z") time is the device's local
// time, as Home uses the device's date. Hours are kept only when the event starts and ends on the same date (an end
// at midnight closes the day before, with no hours). A repeating event (RRULE or RDATE) is counted, not imported, and
// its moved instances (RECURRENCE-ID) go with it; a cancelled event is left out. Events within 400 days of today
// are kept, at most 2,000, the first by start. [CONFIRM: 1 MB and 2,000 events for a calendar file]

/** At most this many events are kept from one file. */
export const MAX_IMPORTED = 2_000;
/** Events are kept from this many days before today to this many after, the API's longest read. */
const WINDOW_DAYS = 400;

export type IcsResult = { events: ImportedEvent[]; skippedRepeating: number } | { error: 'not_calendar' };

interface Moment {
  date: string;
  /** 'HH:MM'; null for a date-only value. */
  time: string | null;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** The property's name and value: the name ends at the first ';' or ':', the value starts after the first ':' outside quotes. */
function propertyOf(line: string): { name: string; value: string } | null {
  const nameEnd = line.search(/[;:]/);
  if (nameEnd <= 0) return null;
  let quoted = false;
  for (let index = nameEnd; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) return { name: line.slice(0, nameEnd).toUpperCase(), value: line.slice(index + 1) };
  }
  return null;
}

function momentOf(value: string | undefined): Moment | null {
  const match = DATE_TIME.exec(value?.trim() ?? '');
  if (match === null) return null;
  const [, year = '', month = '', day = '', hour, minute, second, utc] = match;
  if (hour === undefined || minute === undefined || second === undefined) {
    const date = `${year}-${month}-${day}`;
    return isCalendarDate(date) ? { date, time: null } : null;
  }
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  if (utc === 'Z') {
    const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    if (Number.isNaN(at.getTime())) return null;
    return { date: `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`, time: `${two(at.getHours())}:${two(at.getMinutes())}` };
  }
  const date = `${year}-${month}-${day}`;
  return isCalendarDate(date) ? { date, time: `${hour}:${minute}` } : null;
}

/** SUMMARY's text: "\," "\;" "\\" and "\n" unescaped, on one line. */
function titleOf(value: string | undefined): string {
  const text = (value ?? '').replace(/\\([\\;,nN])/g, (_match, char: string) => (char === 'n' || char === 'N' ? '\n' : char));
  return text.replace(/\s+/g, ' ').trim() || 'Untitled event';
}

function spanOf(start: Moment, end: Moment | null): Pick<ImportedEvent, 'startDate' | 'endDate' | 'startTime' | 'endTime'> {
  let endDate = end?.date ?? start.date;
  let endTime = end?.time ?? null;
  // A date-only end is exclusive, and an end at midnight closes the day before.
  if (endDate > start.date && (endTime === null || endTime === '00:00')) {
    endDate = addDays(endDate, -1);
    endTime = null;
  }
  if (endDate < start.date) endDate = start.date;
  const timed = start.time !== null && endTime !== null && endDate === start.date && start.time < endTime;
  return { startDate: start.date, endDate, startTime: timed ? start.time : null, endTime: timed ? endTime : null };
}

function startKey(event: ImportedEvent): string {
  return `${event.startDate} ${event.startTime ?? ''}`;
}

/** The file's single events within 400 days of `today`, by start, at most 2,000, or not_calendar. */
export function parseIcs(text: string, today: string): IcsResult {
  const lines = text.replace(/^\uFEFF/, '').replace(/(?:\r\n|\r|\n)[ \t]/g, '').split(/\r\n|\r|\n/);
  const stack: string[] = [];
  let calendar = false;
  let fields: Map<string, string> | null = null;
  let seen = 0;
  let skippedRepeating = 0;
  const uids = new Set<string>();
  const events: ImportedEvent[] = [];

  const finish = (props: Map<string, string>): void => {
    seen += 1;
    if (props.has('RRULE') || props.has('RDATE')) { skippedRepeating += 1; return; }
    if (props.has('RECURRENCE-ID') || props.get('STATUS')?.trim().toUpperCase() === 'CANCELLED') return;
    const start = momentOf(props.get('DTSTART'));
    if (start === null) return;
    const given = props.get('UID')?.trim() ?? '';
    let uid = given === '' ? `event-${String(seen)}` : given;
    if (uids.has(uid)) uid = `${uid}#${String(seen)}`;
    uids.add(uid);
    events.push({ uid, title: titleOf(props.get('SUMMARY')), ...spanOf(start, momentOf(props.get('DTEND'))) });
  };

  for (const line of lines) {
    const property = propertyOf(line);
    if (property === null) continue;
    const value = property.value.trim().toUpperCase();
    if (property.name === 'BEGIN') {
      if (value === 'VCALENDAR') calendar = true;
      if (value === 'VEVENT') fields = new Map();
      stack.push(value);
    } else if (property.name === 'END') {
      if (stack.at(-1) === 'VEVENT' && fields !== null) finish(fields);
      if (stack.at(-1) === 'VEVENT') fields = null;
      stack.pop();
    } else if (stack.at(-1) === 'VEVENT' && fields !== null && !fields.has(property.name)) {
      fields.set(property.name, property.value);
    }
  }
  if (!calendar) return { error: 'not_calendar' };

  const first = addDays(today, -WINDOW_DAYS);
  const last = addDays(today, WINDOW_DAYS);
  const kept = events
    .filter((event) => event.endDate >= first && event.startDate <= last)
    .sort((a, b) => (startKey(a) < startKey(b) ? -1 : startKey(a) > startKey(b) ? 1 : 0))
    .slice(0, MAX_IMPORTED);
  return { events: kept, skippedRepeating };
}
