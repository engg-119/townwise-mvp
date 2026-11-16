import { ApiError } from '../../api/client';
import { errorCopy, hasCode } from '../errors';
import { formatCount, formatDate, formatTime, plural } from '../format';
import type { OwnerCalendar } from './api';

// The "Your calendars" popover's words (P28; connect-owner-calendar design decision 11), pure: a file's name, the words
// for every code phase 1 answers (api/src/handlers/owner-calendars.ts) and for a link's status, a row's lines, and the
// add-a-link form's checks, which hold the fields to the API's own limits (a trimmed name of 1 to 60 UTF-16 code units,
// a trimmed link of 1 to 2,048), so its 400 is only a fallback. Anything without words of its own gets errorCopy. Both
// IcsImport siblings and YourCalendars.tsx import from here: a value one IcsImport sibling exports would resolve to the
// .web file itself on web, so every value they share lives in this module. Pinned by
// test/portal/calendar/calendars.test.ts.

/** The API's `max(60)` on a calendar's name, counted as `String.length`. */
const MAX_LABEL = 60;
/** The API's `max(2048)` on a link. */
const MAX_LINK = 2048;

export const CALENDARS_COPY = {
  /** What the privacy page (app/(marketing)/privacy.tsx) says of kept calendars, in the popover's words. */
  help: 'Import a calendar exported from Google Calendar, Outlook or Apple Calendar as an .ics file, or add its iCal link, which Townwise reads again about every 6 hours. Townwise keeps each event’s title, dates and hours until you remove the calendar, and nothing else from it. TownwiseAI reads the titles, so they can reach Anthropic when you ask about your bookings. Events change the forecast only through notes you make from them. To update a file, remove it and import the new export.',
  tooLarge: 'This file is over 1 MB. Export a shorter range of your calendar.',
  notCalendar: 'This doesn’t look like a calendar file (.ics).',
  unreadable: 'Couldn’t read this file. Choose it again.',
  none: 'No calendars yet.',
  nativeLine: 'To add events from your own calendar file, open Townwise on the web.',
  nameLabel: 'Name',
  nameHelper: 'Up to 60 characters, for example Bookings.',
  linkLabel: 'Calendar link',
  linkHelper: 'Its iCal address, starting with https:// or webcal://. In Google Calendar: Settings, then the calendar, then Secret address in iCal format.',
  nameEmpty: 'Enter a name for the calendar.',
  nameLong: 'Keep the name to 60 characters.',
  linkEmpty: 'Paste the calendar’s link.',
  linkLong: 'This link is too long. Copy it again from your calendar’s settings.',
  calendarLimit: 'This location has 5 calendars, the most it can hold. Remove one to add another.',
  alreadyRemoved: 'This calendar was already removed.',
} as const;

/** A link's add refused for what Townwise read from it (400). */
const LINK_REFUSALS: Readonly<Record<string, string>> = {
  bad_link: 'Paste a link that starts with https:// or webcal://.',
  blocked_address: 'Townwise doesn’t read calendars from that address. Use the link from your calendar’s settings.',
  unreachable: 'Couldn’t reach that link. Check it and try again.',
  timeout: 'That link took too long to answer. Try again in a few minutes.',
  too_large: 'That calendar is over 1 MB, more than Townwise reads.',
  http_error: 'That link answered with an error. Check it and try again.',
  not_calendar: 'That link doesn’t lead to a calendar. Use its iCal link, which often ends in .ics.',
};

/** A link's status after a failed refresh; its last good events stay. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  bad_link: 'Couldn’t refresh: the link now leads to an address that isn’t https.',
  blocked_address: 'Couldn’t refresh: the link now leads to an address Townwise doesn’t read.',
  unreachable: 'Couldn’t refresh: Townwise couldn’t reach the link.',
  timeout: 'Couldn’t refresh: the link took too long to answer.',
  too_large: 'Couldn’t refresh: the calendar is over 1 MB.',
  http_error: 'Couldn’t refresh: the link answered with an error.',
  not_calendar: 'Couldn’t refresh: the link no longer leads to a calendar.',
  key_mismatch: 'Townwise can’t open this link any more. Remove it and add the link again.',
};

const UNKNOWN_STATUS = 'Couldn’t refresh this link.';

/** At most `max` UTF-16 code units, one fewer when the last would open a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** A file's name as its calendar's: a final `.ics` off, trimmed, at most 60 code units, and “Calendar file” when empty. */
export function labelOfFile(fileName: string): string {
  const label = cut(fileName.replace(/\.ics$/i, '').trim(), MAX_LABEL).trim();
  return label === '' ? 'Calendar file' : label;
}

/** The words for a refused import (`file`) or link add (`link`); `platform` words the link-less API for native. */
export function addRefusal(error: unknown, kind: 'file' | 'link', platform: 'web' | 'native'): string {
  if (hasCode(error, 409, 'calendar_limit')) return CALENDARS_COPY.calendarLimit;
  if (kind === 'file') {
    if (hasCode(error, 400, 'too_large') || (error instanceof ApiError && error.kind === 'http' && error.status === 413)) return CALENDARS_COPY.tooLarge;
    if (hasCode(error, 400, 'not_calendar')) return CALENDARS_COPY.notCalendar;
  } else {
    if (hasCode(error, 503, 'calendar_links_unavailable')) {
      return platform === 'web'
        ? 'Calendar links aren’t available right now. You can still import a calendar file.'
        : 'Calendar links aren’t available right now. You can still import a calendar file on the web.';
    }
    const code = error instanceof ApiError && error.kind === 'http' && error.status === 400 ? error.code : null;
    const words = code === null ? undefined : LINK_REFUSALS[code];
    if (words !== undefined) return words;
  }
  // A 429, the account's link adds or the writes limiter, is errorCopy's tooManyAttempts.
  return errorCopy(error);
}

/** “in 4 minutes”, “in 1 minute”, or “in a few minutes” without a wait. */
function inMinutes(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return 'in a few minutes';
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `in ${plural(minutes, 'minute', 'minutes')}`;
}

/** The words for a refused "Refresh now". */
export function refreshRefusal(error: unknown): string {
  if (error instanceof ApiError && hasCode(error, 429, 'rate_limited')) {
    return `This calendar was refreshed a few minutes ago. Try again ${inMinutes(error.retryAfterSeconds)}.`;
  }
  if (hasCode(error, 503, 'calendar_links_unavailable')) return 'Calendar links aren’t available right now. This calendar’s events stay as they are.';
  if (hasCode(error, 404, 'not_found')) return CALENDARS_COPY.alreadyRemoved;
  return errorCopy(error);
}

/** A link's status in words: null for `ok`, generic words for a code the client doesn't know. */
export function statusWords(status: string): string | null {
  if (status === 'ok') return null;
  return STATUS_WORDS[status] ?? UNKNOWN_STATUS;
}

/** The repeating events a calendar counted and left out; null for none. */
function repeatingLine(skipped: number): string | null {
  if (skipped <= 0) return null;
  if (skipped === 1) return '1 repeating event wasn’t imported. Add it as a note with weekdays.';
  return `${formatCount(skipped)} repeating events weren’t imported. Add them as notes with weekdays.`;
}

export interface RowLines {
  /** “File, 12 events” or “Link, calendar.google.com, 1 event”. */
  summary: string;
  repeating: string | null;
  /** A link's last refresh that worked, “Updated Nov 14, 2026, 3:42 PM”; null for a file or before one. */
  updated: string | null;
}

/** A calendar row's lines but its name and status (statusWords, which a link's row shows before `updated`). */
export function rowLines(calendar: OwnerCalendar): RowLines {
  const events = plural(calendar.eventCount, 'event', 'events');
  const link = calendar.kind === 'link';
  const at = calendar.lastSuccessAt;
  return {
    summary: link ? ['Link', calendar.host, events].filter((part) => part !== null).join(', ') : `File, ${events}`,
    repeating: repeatingLine(calendar.skippedRepeating),
    updated: link && at !== null ? `Updated ${formatDate(at)}, ${formatTime(at)}` : null,
  };
}

/** “Added Bookings: 3 events.”, and the repeating events it left out. */
export function addedLines(calendar: OwnerCalendar): string[] {
  const repeating = repeatingLine(calendar.skippedRepeating);
  const added = `Added ${calendar.label}: ${plural(calendar.eventCount, 'event', 'events')}.`;
  return repeating === null ? [added] : [added, repeating];
}

export function refreshedLine(name: string): string {
  return `Refreshed ${name}.`;
}

export function removedLine(name: string): string {
  return `Removed ${name}.`;
}

/** The add-a-link form's field messages, empty when the API would take both fields. */
export function linkProblems(form: { name: string; link: string }): { name?: string; link?: string } {
  const problems: { name?: string; link?: string } = {};
  const name = form.name.trim();
  const link = form.link.trim();
  if (name === '') problems.name = CALENDARS_COPY.nameEmpty;
  else if (name.length > MAX_LABEL) problems.name = CALENDARS_COPY.nameLong;
  if (link === '') problems.link = CALENDARS_COPY.linkEmpty;
  else if (link.length > MAX_LINK) problems.link = CALENDARS_COPY.linkLong;
  return problems;
}
