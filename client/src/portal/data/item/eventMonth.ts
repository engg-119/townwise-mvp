import { dayMonthRange, mondayOf, weekDates } from '../../analytics/week';
import { shortDate } from '../../analytics/words';
import type { BookingLabel, OwnerCalendarEvent } from '../../calendar/api';
import type { TooltipLines } from '../../calendar/model';
import { plural } from '../../format';
import { addDays, monthRange } from '../../locations/dates';
import { clockWords, hoursLine } from '../../locations/noteRules';
import { shortName } from './bookingWords';

// A calendar's events as a month grid on its page in Your data (D62), pure: the month's weeks, Monday first, each day
// listing the events on it (an event spanning days on each of them) as cell lines, a start time on its first day and
// its title, which the cell cuts to one line, after its booking label's tag on a file calendar (D58). The day's label
// says them all in full, for screen readers, and the web tooltip's lines do too. Titles are the calendar's words,
// shown as text and never logged.

/** What the grid reads of an event: one of OwnerCalendarEvent's, with the label the page shows for it. */
export type MonthEvent = Pick<
  OwnerCalendarEvent, 'calendarId' | 'uid' | 'title' | 'startDate' | 'endDate' | 'startTime' | 'endTime' | 'booking' | 'bookingBy'
>;

/** One event on one day of the grid. */
export interface MonthEntry {
  key: string;
  /** “6 pm” on the event's first day when it is timed; null otherwise. */
  time: string | null;
  title: string;
  /** The booking label's tag (“Buyout”) on a file calendar's labeled event; null for none. */
  tag: string | null;
  /** The event in full words, for the day's label and its tooltip. */
  words: string;
}

export interface EventDay {
  date: string;
  isToday: boolean;
  entries: MonthEntry[];
  /** What a screen reader hears for the day: its date, today, and every event on it. */
  label: string;
}

/**
 * Each label's tag in a cell, short enough to leave room for the title. [CONFIRM: the cell tags' words (D62)]
 */
export const CELL_TAG: Readonly<Record<BookingLabel, string>> = {
  buyout: 'Buyout', party: 'Party', own_event: 'Own event', other: 'Not booking',
};

/** Entry lines a cell holds: all of them up to this many, else one fewer and “+n more”. */
export const CELL_LINES = 4;

/** All-day and continuing events first, then by start time, then by title; the same order on the day's list. */
function byDay(date: string): (a: MonthEvent, b: MonthEvent) => number {
  const timeOn = (event: MonthEvent): string => (event.startDate === date && event.startTime !== null ? event.startTime : '');
  return (a, b) => timeOn(a).localeCompare(timeOn(b)) || a.title.localeCompare(b.title) || a.uid.localeCompare(b.uid);
}

/** The events on `date` (an event spanning days is on each of them), in the day's order. */
export function eventsOnDay<T extends MonthEvent>(date: string, events: readonly T[]): T[] {
  return events.filter((event) => event.startDate <= date && event.endDate >= date).sort(byDay(date));
}

function entryOf(date: string, event: MonthEvent, labels: boolean): MonthEntry {
  const time = event.startDate === date && event.startTime !== null ? clockWords(event.startTime) : null;
  const tag = labels && event.booking !== null ? CELL_TAG[event.booking] : null;
  const hours = hoursLine(event);
  const span = event.startDate === event.endDate ? null : dayMonthRange(event.startDate, event.endDate);
  const label = labels && event.booking !== null
    ? `${shortName(event.booking)}${event.bookingBy === 'ai' ? ', suggested by TownwiseAI' : ''}`
    : null;
  const words = [event.title, hours, span, label].filter((part): part is string => part !== null).join(', ');
  return { key: `${event.calendarId}:${event.uid}`, time, title: event.title, tag, words };
}

function dayLabel(date: string, isToday: boolean, entries: readonly MonthEntry[]): string {
  const head = `${shortDate(date)}.${isToday ? ' Today.' : ''}`;
  if (entries.length === 0) return `${head} No events.`;
  return `${head} ${plural(entries.length, 'event', 'events')}: ${entries.map((entry) => entry.words).join('; ')}.`;
}

/**
 * The month (“YYYY-MM”) as week rows, Monday first; null where a row's day is in another month. `labels` is true on a
 * file calendar's page (it has a Bookings section), where a labeled event shows its tag.
 */
export function eventMonthRows(month: string, today: string, events: readonly MonthEvent[], labels: boolean): (EventDay | null)[][] {
  const { from, to } = monthRange(month);
  const rows: (EventDay | null)[][] = [];
  for (let start = mondayOf(from); start <= to; start = addDays(start, 7)) {
    rows.push(weekDates(start).map((date) => {
      if (date < from || date > to) return null;
      const entries = eventsOnDay(date, events).map((event) => entryOf(date, event, labels));
      const isToday = date === today;
      return { date, isToday, entries, label: dayLabel(date, isToday, entries) };
    }));
  }
  return rows;
}

/** A cell's lines: every entry up to CELL_LINES, else one fewer and “+n more” for the rest. */
export function cellLines(entries: readonly MonthEntry[]): { lines: MonthEntry[]; more: string | null } {
  if (entries.length <= CELL_LINES) return { lines: [...entries], more: null };
  const lines = entries.slice(0, CELL_LINES - 1);
  return { lines, more: `+${String(entries.length - lines.length)} more` };
}

/** The day the month opens on: today in today's month, else the month's first day with an event, else its 1st. */
export function defaultDay(month: string, today: string, rows: readonly (readonly (EventDay | null)[])[]): string {
  if (today.slice(0, 7) === month) return today;
  for (const row of rows) {
    for (const day of row) if (day !== null && day.entries.length > 0) return day.date;
  }
  return `${month}-01`;
}

/** The web hover tooltip: the date, then each event in full; null for a day with none. */
export function dayTooltip(day: Pick<EventDay, 'date' | 'entries'>): TooltipLines | null {
  if (day.entries.length === 0) return null;
  return { date: shortDate(day.date), lines: day.entries.map((entry) => entry.words) };
}

/** “No events on Sat, Nov 21, 2026.” */
export function emptyDayLine(date: string): string {
  return `No events on ${shortDate(date)}.`;
}
