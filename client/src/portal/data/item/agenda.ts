import { dayMonthRange } from '../../analytics/week';
import { shortDate } from '../../analytics/words';
import type { WeekCardKind } from '../../calendar/grid';
import { monthLabel, type ImportedEvent } from '../../calendar/model';
import { plural } from '../../format';
import type { NoteKind } from '../../locations/api';
import { hoursLine, KIND_LABEL } from '../../locations/noteRules';
import { calendarHref } from '../../routing';

// The calendar agenda of Your data (D49, calendar-detail), pure: a calendar's events (the `c_` page) or what
// TownwiseAI read from a calendar file (its P27's AI section), grouped by month in date order. Each event says its
// day or span, its hours when timed and its kind words, and links to its day on the Calendar; a file's event that
// became a note says "Note made" and links to it, any other "No note made". Titles are the person's or the file's
// words, shown as plain text; never a calendar's address.

export interface AgendaItem {
  key: string;
  /** The event's title; a file's event under view-as, whose title is withheld, its kind words. */
  title: string;
  startDate: string;
  /** “Wed, Nov 11, 2026” or “Nov 20 to 22, 2026”. */
  when: string;
  hours: string | null;
  /**
   * The kind words under the title, a file's event's kind (“Private buyout, 60 guests”); null for a calendar's event,
   * on a page that is that calendar's, and for a file's event whose title is withheld, which shows them as its title.
   */
  sub: string | null;
  /** The card's mark (calendar/grid.ts CARD_MARK). */
  kind: WeekCardKind;
  /** The day on the Calendar; null for a file's event that made no note. */
  href: string | null;
  /** A file's event: “Note made” or “No note made”; null for a calendar's. */
  status: string | null;
  /** What a screen reader hears for the row. */
  label: string;
}

export interface AgendaMonth { month: string; label: string; items: AgendaItem[] }

function whenOf(startDate: string, endDate: string): string {
  return startDate === endDate ? shortDate(startDate) : `${dayMonthRange(startDate, endDate)}, ${endDate.slice(0, 4)}`;
}

function labelOf(title: string, when: string, href: string | null): string {
  return href === null ? `${title}, ${when}.` : `${title}, ${when}. Opens the day on the Calendar.`;
}

/** An event of one of the location's calendars. */
export function calendarEventItem(locationId: string, event: ImportedEvent): AgendaItem {
  const when = whenOf(event.startDate, event.endDate);
  const href = calendarHref(locationId, event.startDate);
  return {
    key: `${event.calendarId}:${event.uid}`, title: event.title, startDate: event.startDate, when, hours: hoursLine(event), sub: null,
    kind: 'imported', href, status: null, label: labelOf(event.title, when, href),
  };
}

/** An event TownwiseAI read from a calendar file (the data item's `ai.events`, the single item's read only). */
export interface FileEvent {
  title: string | null;
  startDate: string;
  endDate: string;
  kind: NoteKind;
  effect: 'closed' | 'more' | 'fewer' | 'unknown';
  expectedGuests: number | null;
  noteId: string | null;
}

/** A file event's kind words: “Private buyout, 60 guests”, “Closure”, “Other”. */
function fileEventWords(event: FileEvent): string {
  const kind = event.kind === 'private_event' && event.effect === 'closed' ? 'Private buyout' : KIND_LABEL[event.kind];
  return event.expectedGuests === null ? kind : `${kind}, ${plural(event.expectedGuests, 'guest', 'guests')}`;
}

export function fileEventItem(locationId: string, event: FileEvent, index: number): AgendaItem {
  const when = whenOf(event.startDate, event.endDate);
  const made = event.noteId !== null;
  const href = made ? calendarHref(locationId, event.startDate) : null;
  const sub = fileEventWords(event);
  const title = event.title ?? sub;
  return {
    key: `event:${String(index)}`, title, startDate: event.startDate, when, hours: null, sub: event.title === null ? null : sub, kind: 'note', href,
    status: made ? 'Note made' : 'No note made', label: `${labelOf(title, when, href)} ${made ? 'Note made.' : 'No note made.'}`,
  };
}

/**
 * The items by month, in date order; a month with none is left out (the `c_` page says it is empty). The `c_` page reads
 * one month (`shown`, "YYYY-MM"), so an event that began before it, and runs into it, lists under that month.
 */
export function agendaMonths(items: readonly AgendaItem[], shown?: string): AgendaMonth[] {
  const months = new Map<string, AgendaItem[]>();
  for (const item of [...items].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const start = item.startDate.slice(0, 7);
    const month = shown !== undefined && start < shown ? shown : start;
    months.set(month, [...(months.get(month) ?? []), item]);
  }
  return [...months].map(([month, list]) => ({ month, label: monthLabel(month), items: list }));
}

/**
 * A file calendar keeps its events from 3 years back (D58, 1,096 days), so its page's Earlier goes back 36 months, not
 * the Calendar's 12; Later stops where the Calendar's does.
 */
export const FILE_MONTHS_BACK = 36;

/** The month `count` months before `month` ("YYYY-MM"). */
export function monthsBefore(month: string, count: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 - count;
  return `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** “No events in November 2026.” */
export function emptyMonthLine(month: string): string {
  return `No events in ${monthLabel(month)}.`;
}
