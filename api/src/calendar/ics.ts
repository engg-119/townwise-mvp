// The owner's calendar as its single events (openspec change connect-owner-calendar: the owner-calendar spec and
// design decision 3): an exported .ics file (RFC 5545), imported or fetched from a subscription link, parsed on the
// server with the rules and limits the Calendar page's browser parser used. Pure; the town's today and time zone come
// from the caller (time-zones.ts), and nothing here logs.
// Folded lines are unfolded; each VEVENT's UID, SUMMARY (unescaped), DTSTART and DTEND are read, and lines inside its
// VALARMs are not the event's. A date-only event ends the day before its DTEND (which is exclusive), and one with no
// DTEND is one day. A local or TZID time is the wall time it says; a UTC ("Z") time is the wall time in the location's
// town, as TownwiseAI's today is the town's. Hours are kept only when the event starts and ends on the same date (an
// end at midnight closes the day before, with no hours), or when it ends by 06:00 the next morning: such a late night
// is its start day's alone, its end time before its start. A repeating event (RRULE or RDATE) is counted, not imported,
// and its moved instances (RECURRENCE-ID) go with it; a canceled event is left out. A link keeps events within 400 days
// of the town's today, at most 2,000, the first by start; an imported file (parseCalendarFile in csv-events.ts, either
// format, openspec change learn-from-calendar-bookings design decision 4) keeps 1,096 days back to 400 ahead, its
// upcoming events first (FILE_WINDOW). An event keeps its UID, its title (cut at 200 characters),
// its dates and its hours, nothing else: DESCRIPTION, LOCATION, ATTENDEE and ORGANIZER are never read. The callers cap
// the file at 1 MB. [CONFIRM: 1 MB and 2,000 events for a calendar file]
// An event is keyed (openspec change calendar-event-suggestions, design decision 1) when its stored UID is the one the
// file stated, stated by no other event the file keeps, and at most 1,024 characters: only such a key survives a
// refresh, so only such an event is ever linked to a note. A made-up `event-{n}` and a suffixed `{UID}#{n}` are
// numbered by position and are never keyed.
// Google calendars (openspec change connect-google-calendar, design decision 7) share these rules through the exports
// townClock, spanOf, titleOf and keepWindow (calendar/google-events.ts): the same town clock, dates, hours, title cut,
// 400-day window and 2,000 events, except that a Google calendar keeps the events ahead of the town's today first
// (keepWindow's aheadFirst), and its repeating events arrive from Google as single events.
import { isCalendarDate, utcDay } from '../dates.ts';

/** A calendar file, imported or fetched, is at most this many bytes (1 MB); its callers hold it to that. */
export const MAX_ICS_BYTES = 1024 * 1024;
/** At most this many events are kept from one calendar. */
export const MAX_EVENTS = 2_000;
/** Events are kept from this many days before the town's today to this many after, the longest read ahead. */
export const WINDOW_DAYS = 400;
/**
 * A calendar file, imported once and never re-read, keeps events from this many days before the town's today (D58).
 * [CONFIRM: a calendar file keeps 3 years of past events and its upcoming events first, at most 2,000]
 */
export const FILE_HISTORY_DAYS = 1_096;
/** A title is cut to this many characters. */
export const MAX_TITLE_CHARS = 200;
/** A stated UID longer than this is never keyed (a note's link holds at most this many characters). */
export const MAX_KEY_CHARS = 1_024;

/** One single event as Townwise keeps it. */
export interface IcsEvent {
  readonly uid: string;
  readonly title: string;
  readonly startDate: string;
  /** Inclusive. */
  readonly endDate: string;
  /**
   * The town's 'HH:MM', only when the event starts and ends on the same day, or ends by 06:00 the next morning, when
   * endTime is before startTime.
   */
  readonly startTime: string | null;
  readonly endTime: string | null;
  /** True when `uid` survives a refresh: a Google id, or a UID the file stated once, at most 1,024 characters. */
  readonly keyed: boolean;
}

export type IcsResult = { events: IcsEvent[]; skippedRepeating: number } | { error: 'not_calendar' };

/** Which events a calendar keeps: `historyDays` back from the town's today (400 unless said), and `aheadFirst`. */
export interface KeepOptions {
  readonly aheadFirst?: boolean;
  readonly historyDays?: number;
}

/** An imported file's window (D58): 3 years back, upcoming events first. */
export const FILE_WINDOW = { aheadFirst: true, historyDays: FILE_HISTORY_DAYS } as const satisfies KeepOptions;

/** The location's town: its today (YYYY-MM-DD) and its IANA time zone. */
export interface IcsTown {
  readonly today: string;
  readonly timeZone: string;
}

/** A date and, for a timed value, its wall time. */
export interface Moment {
  date: string;
  /** 'HH:MM'; null for a date-only value. */
  time: string | null;
}

/** The town's wall date and time of an instant, or null for a date outside the years 1000 to 9999. */
export type TownClock = (at: Date) => Moment | null;

/** The only VEVENT properties read; every other one is passed over as the line is read. */
const READ = new Set(['UID', 'SUMMARY', 'DTSTART', 'DTEND', 'STATUS', 'RRULE', 'RDATE', 'RECURRENCE-ID']);

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/;

function plusDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

/** One formatter per parse: a file may hold thousands of UTC times. */
export function townClock(timeZone: string): TownClock {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (at) => {
    const parts = format.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((each) => each.type === type)?.value ?? '';
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    return isCalendarDate(date) ? { date, time: `${part('hour')}:${part('minute')}` } : null;
  };
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

function momentOf(value: string | undefined, clock: TownClock): Moment | null {
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
    return Number.isNaN(at.getTime()) ? null : clock(at);
  }
  const date = `${year}-${month}-${day}`;
  return isCalendarDate(date) ? { date, time: `${hour}:${minute}` } : null;
}

/** SUMMARY's text with "\," "\;" "\\" and "\n" unescaped. */
function unescaped(value: string | undefined): string {
  return (value ?? '').replace(/\\([\\;,nN])/g, (_match, char: string) => (char === 'n' || char === 'N' ? '\n' : char));
}

/**
 * A title from plain text: on one line, "Untitled event" when empty, cut at 200 characters (never half a pair). A
 * file's SUMMARY is unescaped first; a Google event's summary is plain text, so a backslash in it stays.
 */
export function titleOf(text: string | undefined): string {
  const title = (text ?? '').replace(/\s+/g, ' ').trim() || 'Untitled event';
  if (title.length <= MAX_TITLE_CHARS) return title;
  const cut = title.slice(0, MAX_TITLE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** An event that ends by this time the next morning is its start day's late night, not two days. [CONFIRM: 06:00 cutoff] */
const LATE_NIGHT_END = '06:00';

/** An event's dates and, by the rules above, its hours; with no end it is its start's day. */
export function spanOf(start: Moment, end: Moment | null): Pick<IcsEvent, 'startDate' | 'endDate' | 'startTime' | 'endTime'> {
  let endDate = end?.date ?? start.date;
  let endTime = end?.time ?? null;
  // A date-only end is exclusive, and an end at midnight closes the day before.
  if (endDate > start.date && (endTime === null || endTime === '00:00')) {
    endDate = plusDays(endDate, -1);
    endTime = null;
  }
  // Under a day long, ending by 06:00 the next morning (a party from 18:00 to 01:00): the start day's, with its hours.
  if (start.time !== null && endTime !== null && endDate === plusDays(start.date, 1) && endTime <= LATE_NIGHT_END && endTime < start.time) {
    return { startDate: start.date, endDate: start.date, startTime: start.time, endTime };
  }
  if (endDate < start.date) endDate = start.date;
  const timed = start.time !== null && endTime !== null && endDate === start.date && start.time < endTime;
  return { startDate: start.date, endDate, startTime: timed ? start.time : null, endTime: timed ? endTime : null };
}

function startKey(event: IcsEvent): string {
  return `${event.startDate} ${event.startTime ?? ''}`;
}

/**
 * The calendar's single events within 400 days of the town's today (or `keep`'s window), by start, at most 2,000, or
 * not_calendar.
 */
export function parseIcs(text: string, town: IcsTown, keep?: KeepOptions): IcsResult {
  const clock = townClock(town.timeZone);
  const lines = text.replace(/^\uFEFF/, '').replace(/(?:\r\n|\r|\n)[ \t]/g, '').split(/\r\n|\r|\n/);
  const stack: string[] = [];
  let calendar = false;
  let fields: Map<string, string> | null = null;
  let seen = 0;
  let skippedRepeating = 0;
  const uids = new Set<string>();
  /** Each clashing base's next suffix to try. */
  const nextSuffix = new Map<string, number>();
  /** Each event's stated UID ('' for none), by position in `drafts`. */
  const stated: string[] = [];
  /** How many kept events state each UID. */
  const statedCount = new Map<string, number>();
  const drafts: Omit<IcsEvent, 'keyed'>[] = [];

  const finish = (props: Map<string, string>): void => {
    seen += 1;
    if (props.has('RRULE') || props.has('RDATE')) { skippedRepeating += 1; return; }
    if (props.has('RECURRENCE-ID') || props.get('STATUS')?.trim().toUpperCase() === 'CANCELLED') return;
    const start = momentOf(props.get('DTSTART'), clock);
    if (start === null) return;
    const given = props.get('UID')?.trim() ?? '';
    const base = given === '' ? `event-${String(seen)}` : given;
    // A taken key, stated or made here, gets the next free suffix, so no two events share one. A base's search starts
    // where its last one stopped (every suffix before that is taken), so a file that states the suffixes ahead of its
    // clashes costs each one look in all, not one per clash.
    let uid = base;
    let suffix = Math.max(seen, nextSuffix.get(base) ?? 0);
    for (; uids.has(uid); suffix += 1) uid = `${base}#${String(suffix)}`;
    if (uid !== base) nextSuffix.set(base, suffix);
    uids.add(uid);
    stated.push(given);
    if (given !== '') statedCount.set(given, (statedCount.get(given) ?? 0) + 1);
    drafts.push({ uid, title: titleOf(unescaped(props.get('SUMMARY'))), ...spanOf(start, momentOf(props.get('DTEND'), clock)) });
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
    } else if (stack.at(-1) === 'VEVENT' && fields !== null && READ.has(property.name) && !fields.has(property.name)) {
      fields.set(property.name, property.value);
    }
  }
  if (!calendar) return { error: 'not_calendar' };
  const events = drafts.map((draft, index): IcsEvent => {
    const given = stated[index] ?? '';
    return { ...draft, keyed: given !== '' && draft.uid === given && statedCount.get(given) === 1 && given.length <= MAX_KEY_CHARS };
  });
  return { events: keepWindow(events, town.today, keep), skippedRepeating };
}

function byStart(a: IcsEvent, b: IcsEvent): number {
  return startKey(a) < startKey(b) ? -1 : startKey(a) > startKey(b) ? 1 : 0;
}

/**
 * The events ending at most `historyDays` (400 unless said) before `today` and starting at most 400 after it, by start
 * (a stable sort, so events that start together keep their order), at most 2,000: the first by start; or, with
 * `aheadFirst` (a Google calendar's, and an imported file's), the first 2,000 by start of those that end on or after
 * `today`, then as many of the earlier ones as still fit, the latest of them first.
 * [CONFIRM: a Google calendar keeps its next 2,000 events first, then earlier ones]
 */
export function keepWindow(events: readonly IcsEvent[], today: string, options?: KeepOptions): IcsEvent[] {
  const first = plusDays(today, -(options?.historyDays ?? WINDOW_DAYS));
  const last = plusDays(today, WINDOW_DAYS);
  const inWindow = events.filter((event) => event.endDate >= first && event.startDate <= last).sort(byStart);
  if (options?.aheadFirst !== true) return inWindow.slice(0, MAX_EVENTS);
  const ahead = inWindow.filter((event) => event.endDate >= today).slice(0, MAX_EVENTS);
  const before = inWindow.filter((event) => event.endDate < today);
  const room = Math.min(MAX_EVENTS - ahead.length, before.length);
  return [...before.slice(before.length - room), ...ahead].sort(byStart);
}
