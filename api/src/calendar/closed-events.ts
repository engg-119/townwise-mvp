// Calendar events that plainly say the business is closed (D59 slice 5, openspec change auto-apply-agent-reads design
// decision 16): what lets a calendar answer TownwiseAI's open closure questions and suggestions with no model call
// (calendar/answers.ts). An event counts when it is keyed (so a note can follow it, D53), all day (a timed "Closed" is
// part of a day), its dates make a closure note under Section 12's rules, and its title plainly says closed: folded
// (accents dropped, lower case, apostrophes dropped, every other mark a space), with no `?` and no digit, its words an
// optional few naming the business ("we are", "were", "restaurant", "cafe", "shop", "store", "business"), then
// "closed", then nothing that names part of a day or of the place, a booking, doubt or opening. Pure; the title is read
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

/** Words that make a "closed" title not plain: part of a day or of the place, a booking, doubt, or opening. */
const NOT_PLAIN = new Set([
  // Part of a day.
  'early', 'late', 'until', 'till', 'til', 'from', 'at', 'after', 'before', 'noon', 'midnight', 'am', 'pm', 'morning', 'afternoon',
  'evening', 'night', 'lunch', 'dinner', 'brunch', 'breakfast', 'hours', 'hour', 'half', 'partial', 'partially', 'part',
  // Part of the place.
  'kitchen', 'bar', 'patio', 'deck', 'dining', 'room', 'upstairs', 'downstairs', 'takeout', 'delivery',
  // A booking.
  'private', 'party', 'event', 'buyout', 'booked', 'booking', 'public', 'wedding', 'rehearsal', 'reception',
  // Doubt.
  'maybe', 'tentative', 'tentatively', 'possibly', 'probably', 'tbd', 'if', 'unless', 'except', 'but', 'not',
  // Opening.
  'open', 'opens', 'opening', 'reopen', 'reopens', 'reopening',
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
  return rest[0] === 'closed' && !rest.slice(1).some((word) => NOT_PLAIN.has(word));
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
