import { ApiError } from '../../api/client';
import { errorCopy, hasCode } from '../errors';
import { formatCount, formatDate, formatTime, plural } from '../format';
import type { OwnerCalendar } from './api';

// The "Your calendars" popover's words (P28; connect-owner-calendar design decision 11, connect-google-calendar design
// decision 15, learn-from-calendar-bookings design decisions 1 and 2: a file is an .ics or a calendar CSV), pure: a
// file's name, the words for every code phase 1 answers (api/src/handlers/owner-calendars.ts) and
// for a link's status, a row's lines, and the add-a-link form's checks, which hold the fields to the API's own limits (a
// trimmed name of 1 to 60 UTF-16 code units, a trimmed link of 1 to 2,048), so its 400 is only a fallback; the help
// and native's line, which name Google calendars only while the list answers them on; and the Google section's
// (google-calendar's "The Your calendars popover connects and picks Google calendars"): its explainer, waiting, loading
// and picker lines, the words for every code the Google routes and a Google add answer
// (api/src/handlers/google-calendars.ts), and a Google calendar's status. None of them repeats Google's own error
// description. Anything without words of its own gets errorCopy. The IcsImport and GoogleConnect siblings and
// YourCalendars.tsx import from here: a value one sibling exports would resolve to the .web file itself on web, so every
// value they share lives in this module. Pinned by test/portal/calendar/calendars.test.ts.

/** The API's `max(60)` on a calendar's name, counted as `String.length`. */
const MAX_LABEL = 60;
/** A location's most calendars, of every kind (D33). */
export const MAX_CALENDARS = 5;
/** The API's `max(2048)` on a link. */
const MAX_LINK = 2048;
/**
 * What an add of a file or link, and a Google connect, sends as `titlesNotice` when its screen showed the weekly words
 * (CALENDARS_COPY.weeklyReading, the explainer's second paragraph), the API's WEEKLY_TITLES_NOTICE
 * (api/src/calendar/titles-notice.ts): a calendar's titles go into the weekly call only when it was sent.
 */
export const WEEKLY_TITLES_NOTICE = 1;

export const CALENDARS_COPY = {
  tooLarge: 'This file is over 1 MB. Export a shorter range of your calendar, or a CSV with fewer columns.',
  notCalendar: 'That isn’t a calendar. Import an .ics file, or a CSV with event_id, title, start_at and end_at columns.',
  unreadable: 'Couldn’t read this file. Choose it again.',
  none: 'No calendars yet.',
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
  /**
   * Above "Import a calendar file" and "Add a link", said once for both (calendar-event-suggestions design decision 11:
   * an add from this popover sends `titlesNotice`, and a file's or link's titles go into the weekly call only when its
   * add did). [CONFIRM: the add screens' words on the weekly reading of titles] Its second sentence says a calendar file
   * is read when it is imported where TownwiseAI works on its own (D59 slice 2). [CONFIRM: the import screen's and the
   * titles switch's words on a calendar file sorted on import]
   */
  weeklyReading: 'Once a week TownwiseAI reads the titles, dates and hours of the next 3 months of events on a calendar you add here, with email addresses and phone numbers removed, to suggest notes for private events. Where TownwiseAI works on its own, it also reads the titles, dates and hours of every event in a calendar file when it is imported, past ones included, to label your bookings, and uses those labels for forecasts at once, with Undo. They reach Anthropic, which doesn’t train on them. An admin of your organization can turn off the weekly reading, or the sending of your calendars’ titles, on the TownwiseAI page.',
} as const;

const HELP_IMPORT = 'Import a calendar exported from Google Calendar, Outlook or Apple Calendar as an .ics file, or a calendar CSV with event_id, title, start_at and end_at columns, or add its iCal link, which Townwise reads again about every 6 hours.';
const HELP_GOOGLE = 'Or add a Google calendar by signing in with Google, which Townwise reads about every 6 hours, repeating events included.';
const HELP_KEPT = 'Townwise keeps each event’s title, dates and hours until you remove the calendar, and nothing else from it. From a CSV, Townwise keeps each event’s title, dates and hours and never reads its other columns. TownwiseAI reads the titles, so they can reach Anthropic when you ask about your bookings, and when a calendar file is sorted: by an org admin’s Sort with TownwiseAI, or on its own when the file is imported where TownwiseAI works on its own. Events change the forecast through notes made from them, and through a calendar file’s buyout and party labels once they are used for forecasts. To update a file, remove it and import the new export.';

/**
 * What the privacy page (app/(marketing)/privacy.tsx) says of kept calendars, in the popover's words, with the sentence
 * on Google calendars only while the list answers them on (`google.available`), so a release with them off says nothing
 * of them. It names a calendar file's sort, by a press (D58) or on import (D59 slice 2), and its labels' use for
 * forecasts, as the privacy page's Sorting bookings with TownwiseAI item does. [CONFIRM: the import screen's and the
 * titles switch's words on a calendar file sorted on import]
 */
export function helpText(google: boolean): string {
  return [HELP_IMPORT, google ? HELP_GOOGLE : null, HELP_KEPT].filter((part) => part !== null).join(' ');
}

/** Native's line in place of the import; while Google calendars are on it also points to the web for connecting one. */
export function nativeLine(google: boolean): string {
  return google
    ? 'To import a calendar file or connect a Google calendar, open Townwise on the web.'
    : 'To add events from your own calendar file, open Townwise on the web.';
}

/**
 * The explainer's paragraphs: what Townwise reads, who sees it, and how its access ends. The second also says the
 * weekly suggestions read the titles (calendar-event-suggestions design decision 11: a connect from this explainer
 * sends `titlesNotice`, and a Google calendar's titles go into the weekly call only when its connection's did).
 * [CONFIRM: the Google connect explainer's words on the weekly reading of titles]
 */
const EXPLAINER_PARAGRAPHS = [
  'Sign in with Google to pick calendars from your Google account. Townwise reads each event’s title, dates and hours, and nothing else, about every 6 hours, repeating events included.',
  'Everyone on your team can see these events. TownwiseAI reads their titles when you ask about your bookings, and once a week it reads the titles, dates and hours of the next 3 months of events, with email addresses and phone numbers removed, to suggest notes for private events. Either way, the titles reach Anthropic, which doesn’t train on them. An admin of your organization can turn off the weekly reading on the TownwiseAI page. Townwise staff never see these events’ titles on the Calendar. Under view-as, a recorded, read-only view shown to your organization’s admins, they can read your team’s TownwiseAI conversations, which may mention one.',
  'Removing your last Google calendar, or leaving your organization, ends Townwise’s access to your Google account. Google may warn that Townwise isn’t verified yet while Google reviews it.',
] as const;

/** The Google section's words (google-calendar's "The Your calendars popover connects and picks Google calendars"). */
export const GOOGLE_COPY = {
  add: 'Add a Google calendar',
  /** Before "Continue to Google", whose press is the person's agreement (the connect body's `agreed: true`). */
  explainer: EXPLAINER_PARAGRAPHS.join(' '),
  /** The explainer as the section shows it: the same words, with a blank line between its paragraphs. */
  explainerShown: EXPLAINER_PARAGRAPHS.join('\n\n'),
  continue: 'Continue to Google',
  /** In place of "Continue to Google" until Google's script has loaded. */
  loadingGoogle: 'Loading Google…',
  loadFailed: 'Google’s sign-in didn’t load. Try again.',
  waiting: 'Waiting for Google…',
  stopWaiting: 'Stop waiting',
  connecting: 'Connecting your Google account…',
  loadingChoices: 'Loading your Google calendars…',
  mainCalendar: 'Your main calendar',
  added: 'Added',
  shareLine: 'To add another Google account’s calendar, share it with this account in Google Calendar first.',
  popupBlocked: 'Your browser blocked Google’s window. Allow pop-ups for townwise.tech and try again.',
  /** Any other error Google answers the current press with, and an `unknown` error; never Google's own description. */
  notConnected: 'Google didn’t connect Townwise. Try again.',
  reconnect: 'Connect your Google account again to add calendars.',
  /** A Google calendar's row action, for the person who added it, while Google refuses Townwise's access. */
  reconnectAction: 'Reconnect',
  /**
   * A connect started from Reconnect worked, and Refresh now ran on each of the person's Google calendars here: alone
   * when one still couldn't be read (its row's words say why), with `reconnectedFresh` when every one was read, and
   * with `reconnectedLater` when a refresh was refused (too soon, Google busy), so the refresh loop reads it.
   */
  reconnected: 'Reconnected to Google.',
  reconnectedFresh: 'Reconnected to Google. Your Google calendars are up to date.',
  reconnectedLater: 'Reconnected to Google. Townwise reads your Google calendars again within 15 minutes.',
  /** Under the actions for staff, open as admin or under view-as, beside "Add a Google calendar" disabled in place. */
  staffLine: 'Members of this organization connect their own Google calendars. Staff can’t connect one.',
} as const;

/** The picker's first line. */
export function pickerLine(location: string): string {
  return `Choose the calendars to add to ${location}.`;
}

/** The picker's room: how many more calendars the location takes, or the limit's words when it takes none. */
export function roomLine(room: number): string {
  return room > 0 ? `This location can add ${formatCount(room)} more.` : CALENDARS_COPY.calendarLimit;
}

/** The picker's add button: "Add calendar" for one, "Add {n} calendars" for more, "Add calendars" with none checked. */
export function addGoogleLabel(checked: number): string {
  if (checked === 1) return 'Add calendar';
  return checked === 0 ? 'Add calendars' : `Add ${formatCount(checked)} calendars`;
}

/** A refused Google add's line in a batch, named by the calendar's name in the person's Google account. */
export function refusedLine(name: string, words: string): string {
  return `${name}: ${words}`;
}

/** The Google routes' and a Google add's refusals, by status and code. */
const GOOGLE_REFUSALS: readonly { status: number; code: string; words: string }[] = [
  { status: 503, code: 'google_calendar_unavailable', words: 'Google calendars aren’t available right now. You can still add a link or import a file.' },
  { status: 409, code: 'google_connect_again', words: 'Google didn’t give Townwise lasting access. Press Continue to Google again.' },
  { status: 400, code: 'google_code_invalid', words: 'Google’s sign-in expired. Try again.' },
  { status: 400, code: 'google_scope_missing', words: 'Townwise needs to see your calendars and their events. Try again and leave both boxes checked.' },
  {
    status: 409, code: 'google_other_account',
    words: 'Choose the Google account you sign in to Townwise with. To add another account’s calendar, share it with that account in Google Calendar first.',
  },
  { status: 409, code: 'google_reconnect', words: GOOGLE_COPY.reconnect },
  // A connection ended while the person was picking (the add's check after storing): connect again.
  { status: 409, code: 'google_not_connected', words: GOOGLE_COPY.reconnect },
  { status: 409, code: 'calendar_already_added', words: 'This calendar is already on this location.' },
  { status: 400, code: 'google_not_found', words: 'That calendar is no longer in your Google account.' },
  { status: 400, code: 'google_forbidden', words: 'Google won’t share that calendar’s events with Townwise.' },
  { status: 503, code: 'google_unavailable', words: 'Townwise couldn’t reach Google. Try again in a few minutes.' },
];

/**
 * The words for a refused connect, choices read or Google add; `calendar_limit` and a 429 (the account's adds that
 * fetch, the Google limiter or the writes limiter) are as for links.
 */
export function googleRefusal(error: unknown): string {
  if (hasCode(error, 409, 'calendar_limit')) return CALENDARS_COPY.calendarLimit;
  const found = GOOGLE_REFUSALS.find((refusal) => hasCode(error, refusal.status, refusal.code));
  return found?.words ?? errorCopy(error);
}

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

/**
 * Who can mend a Google calendar Google no longer lets Townwise read: the person who added it, with Reconnect beside it
 * (`here`, on web) or on the web (`web`, on native, which connects nowhere), someone else (`other`), who asks them, or
 * no one while Google calendars are off (`none`), when the popover names no Google option, as its help and native's
 * line don't.
 */
export type Reconnect = 'here' | 'web' | 'other' | 'none';

const REVOKED = 'Couldn’t refresh: Google no longer lets Townwise read this calendar.';
const REVOKED_WORDS: Readonly<Record<Reconnect, string>> = {
  here: `${REVOKED} Reconnect, or remove it.`,
  web: `${REVOKED} Reconnect on the web, or remove it.`,
  other: `${REVOKED} Ask whoever added it to reconnect, or remove it.`,
  none: `${REVOKED} You can remove it.`,
};

/** A Google calendar's status after a failed refresh, but `google_revoked` (REVOKED_WORDS); its last good events stay. */
const GOOGLE_STATUS_WORDS: Readonly<Record<string, string>> = {
  google_not_found: 'Couldn’t refresh: this Google calendar was deleted or is no longer shared with the account that added it.',
  google_forbidden: 'Couldn’t refresh: Google refused to share this calendar’s events.',
  google_rate_limited: 'Couldn’t refresh: Google was busy. Townwise tries again later.',
  google_unavailable: 'Couldn’t refresh: Townwise couldn’t reach Google.',
  key_mismatch: 'Townwise can’t open this Google connection any more. Remove the calendar and add it again.',
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
const UNKNOWN_CALENDAR_STATUS = 'Couldn’t refresh this calendar.';

/** At most `max` UTF-16 code units, one fewer when the last would open a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * A file's name as its calendar's: a final `.ics` or `.csv` off, trimmed, at most 60 code units, and “Calendar file”
 * when empty.
 */
export function labelOfFile(fileName: string): string {
  const label = cut(fileName.replace(/\.(?:ics|csv)$/i, '').trim(), MAX_LABEL).trim();
  return label === '' ? 'Calendar file' : label;
}

/**
 * The words for a refused import (`file`), link add (`link`) or Google add (`google`, googleRefusal's); `platform`
 * words the link-less API for native.
 */
export function addRefusal(error: unknown, kind: 'file' | 'link' | 'google', platform: 'web' | 'native'): string {
  if (hasCode(error, 409, 'calendar_limit')) return CALENDARS_COPY.calendarLimit;
  if (kind === 'google') return googleRefusal(error);
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
  if (hasCode(error, 503, 'google_calendar_unavailable')) return 'Google calendars aren’t available right now. This calendar’s events stay as they are.';
  if (hasCode(error, 503, 'google_unavailable')) return 'Townwise couldn’t reach Google. Try again in a few minutes.';
  if (hasCode(error, 404, 'not_found')) return CALENDARS_COPY.alreadyRemoved;
  return errorCopy(error);
}

/**
 * A refreshed calendar's status in words, by its kind: null for `ok`, a link's or a Google calendar's own words (for
 * `google_revoked`, by who can reconnect it), and generic words for a code the client doesn't know or a kind without
 * words of its own.
 */
export function statusWords(status: string, kind: string, reconnect: Reconnect = 'other'): string | null {
  if (status === 'ok') return null;
  if (kind === 'link') return STATUS_WORDS[status] ?? UNKNOWN_STATUS;
  if (kind === 'google') return status === 'google_revoked' ? REVOKED_WORDS[reconnect] : GOOGLE_STATUS_WORDS[status] ?? UNKNOWN_CALENDAR_STATUS;
  return UNKNOWN_CALENDAR_STATUS;
}

/** The repeating events a calendar counted and left out; null for none. */
function repeatingLine(skipped: number): string | null {
  if (skipped <= 0) return null;
  if (skipped === 1) return '1 repeating event wasn’t imported. Add it as a note with weekdays.';
  return `${formatCount(skipped)} repeating events weren’t imported. Add them as notes with weekdays.`;
}

export interface RowLines {
  /**
   * “File, 12 events”, “Link, calendar.google.com, 1 event”, “Google calendar, 40 events”, or for a kind the client
   * doesn't know “Calendar, 3 events”.
   */
  summary: string;
  repeating: string | null;
  /**
   * A link's or a Google calendar's last refresh that worked, “Updated Nov 14, 2026, 3:42 PM”; null for a file, a kind
   * the client doesn't know, or before one.
   */
  updated: string | null;
}

/** Whether a calendar of this kind is read again: "Refresh now", its status and its "Updated" time. */
export function refreshable(kind: string): boolean {
  return kind === 'link' || kind === 'google';
}

/** A calendar row's lines but its name and status (statusWords, which a link's or Google calendar's row shows before `updated`). */
export function rowLines(calendar: OwnerCalendar): RowLines {
  const events = plural(calendar.eventCount, 'event', 'events');
  const at = calendar.lastSuccessAt;
  const summary = calendar.kind === 'link'
    ? ['Link', calendar.host, events].filter((part) => part !== null).join(', ')
    : `${calendar.kind === 'file' ? 'File' : calendar.kind === 'google' ? 'Google calendar' : 'Calendar'}, ${events}`;
  return {
    summary,
    repeating: repeatingLine(calendar.skippedRepeating),
    updated: refreshable(calendar.kind) && at !== null ? `Updated ${formatDate(at)}, ${formatTime(at)}` : null,
  };
}

/** A calendar CSV's rows whose start couldn't be read (D58); null for none. */
function skippedLine(skippedRows: number): string | null {
  if (skippedRows <= 0) return null;
  return `Skipped ${plural(skippedRows, 'row', 'rows')} Townwise couldn’t read.`;
}

/** “Added Bookings: 3 events.”, the repeating events it left out, and a calendar CSV's rows it skipped. */
export function addedLines(calendar: OwnerCalendar, skippedRows = 0): string[] {
  const added = `Added ${calendar.label}: ${plural(calendar.eventCount, 'event', 'events')}.`;
  return [added, repeatingLine(calendar.skippedRepeating), skippedLine(skippedRows)].filter((line) => line !== null);
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
