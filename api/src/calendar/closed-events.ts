// Calendar events that plainly say the business is closed (D59 slice 5, openspec change auto-apply-agent-reads design
// decision 16): what lets a calendar answer TownwiseAI's open closure questions and suggestions with no model call
// (calendar/answers.ts). An event counts when it is keyed (so a note can follow it, D53), all day (a timed "Closed" is
// part of a day), its dates make a closure note under Section 12's rules, and its title plainly says closed: folded
// (accents dropped, lower case, apostrophes dropped, every other mark a space), with no `?` and no digit, its words an
// optional few naming the business ("we are", "were", "restaurant", "cafe", "shop", "store", "business"), then
// "closed", then only words from a fixed list: a few joining words, a day or a time of year, a holiday, or a plain
// reason a whole business shuts (a vacation, repairs, the weather, a family emergency). Any other word after "closed"
// ("door", "session", "meeting", "catering", "road", "early", "kitchen", a name) makes the title not plain, so a
// closed-door meeting, a catered buyout or a part of a day never answers a closure question. Pure; the title is read
// here and never leaves: callers keep only ids and dates, and nothing logs. [CONFIRM: an all-day keyed calendar event
// whose title plainly says closed, by this word rule, answers a closure question]
import { readNoteContent } from '../handlers/notes.ts';
import { eachDay } from '../forecasts/file.ts';
import type { NoteContent } from '../stores/notes.ts';
import type { StoredEvent } from '../stores/owner-calendars.ts';

/** One of a location's calendar events, with its calendar's id. */
export type CalendarEvent = StoredEvent & { readonly calendarId: string };

/** Words naming the business that may come before "closed" ("we are" as two words; "we're" folds to "were"). */
const PREFIXES: readonly (readonly string[])[] = [['we', 'are'], ['were'], ['restaurant'], ['cafe'], ['shop'], ['store'], ['business']];

/**
 * The only words that may follow "closed" (anything else makes the title not plain). "to" counts only right after
 * "due" ("Closed due to snow"), so "Closed to walk-ins" and "Closed to the public" do not.
 */
const PLAIN_AFTER = new Set([
  // Joining words.
  'for', 'the', 'a', 'an', 'our', 'and', 'of', 'on', 'due', 'all',
  // Days and times of year.
  'day', 'days', 'today', 'tomorrow', 'week', 'weekend', 'weekends', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays', 'sundays', 'season', 'winter',
  'summer', 'spring', 'autumn', 'annual',
  // Holidays.
  'holiday', 'holidays', 'new', 'year', 'years', 'eve', 'christmas', 'xmas', 'thanksgiving', 'easter', 'memorial', 'labor',
  'independence', 'fourth', 'july', 'juneteenth', 'presidents', 'veterans', 'columbus', 'indigenous', 'peoples', 'mlk', 'martin',
  'luther', 'king', 'jr', 'good', 'halloween', 'hanukkah', 'chanukah', 'passover', 'rosh', 'hashanah', 'yom', 'kippur', 'boxing',
  'mothers', 'fathers', 'patriots',
  // Plain reasons a whole business shuts.
  'vacation', 'vacations', 'break', 'family', 'staff', 'training', 'renovation', 'renovations', 'renovating', 'remodel',
  'remodeling', 'repair', 'repairs', 'maintenance', 'construction', 'inventory', 'cleaning', 'weather', 'snow', 'storm', 'ice',
  'power', 'outage', 'emergency', 'funeral', 'bereavement', 'illness', 'sick',
]);

/** The title's words, folded; null when it holds a `?` or a digit. */
function wordsOf(title: string): string[] | null {
  if (/[?\d]/.test(title)) return null;
  const folded = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’‘`]/g, '').replace(/[^a-z]+/g, ' ').trim();
  return folded === '' ? [] : folded.split(' ');
}

/** Whether a title plainly says the business is closed (see the top). */
export function plainlyClosed(title: string): boolean {
  const words = wordsOf(title);
  if (words === null) return false;
  const prefix = PREFIXES.find((each) => each.every((word, i) => words[i] === word));
  const rest = words.slice(prefix?.length ?? 0);
  return rest[0] === 'closed' && rest.every((word, i) => i === 0 || PLAIN_AFTER.has(word) || (word === 'to' && rest[i - 1] === 'due'));
}

/** The closure note an event makes: its dates, all day, no title; null when Section 12's rules refuse it. */
export function closureNoteOfEvent(event: Pick<StoredEvent, 'startDate' | 'endDate'>, today: string): NoteContent | null {
  return readNoteContent({
    kind: 'closure', startDate: event.startDate, endDate: event.endDate, weekdays: null, effect: 'closed', expectedGuests: null,
    detail: null, title: null, startTime: null, endTime: null,
  }, today);
}

/** The events that plainly say closed: keyed, all day, a plainly closed title, and dates that make a closure note. */
export function closedEventsOf<E extends CalendarEvent>(events: readonly E[], today: string): E[] {
  return events.filter((event) => event.keyed && event.startTime === null && event.endTime === null && plainlyClosed(event.title)
    && closureNoteOfEvent(event, today) !== null);
}

/** Each day the events cover, in order, with the events covering it (in the order given). */
export function closedDaysOf<E extends Pick<StoredEvent, 'startDate' | 'endDate'>>(events: readonly E[]): Map<string, E[]> {
  const days = new Map<string, E[]>();
  for (const event of events) {
    for (const day of eachDay(event.startDate, event.endDate)) days.set(day, [...(days.get(day) ?? []), event]);
  }
  return new Map([...days.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
