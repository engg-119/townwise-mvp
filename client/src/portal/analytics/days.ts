import type { Note } from '../locations/api';
import { addDays } from '../locations/dates';
import type { TownEvent } from './api';
import type { DayRecord } from './history';
import { weekdayOf } from './words';

// Day classification, shared by Home and Analytics (home.md 4.3) and ported to the server for "your history by
// town state" (model.md 3.5, pinned by the day-classes.json parity fixture). The rules:
// - A note covers a day when the day is in its range and its weekdays are null or include the day's weekday.
// - A day is closed when a covering note's effect is `closed`, or its stored row is all zero (guests 0 with net
//   sales 0 or none, or no guests with net sales 0). A day with no row is no data, never closed.
// - A day is noted when a covering note does not close it (a private event, an opening, other, or a closure note
//   with another effect).
// - Holiday and event days are those with a `holiday` or an `event` on the calendar. Term and season periods span
//   months, so they are context only and never make a day irregular.
// - The class takes the first that applies: closed, noted, holiday, event, regular.

export type DayClass = 'closed' | 'noted' | 'holiday' | 'event' | 'regular';

export interface DayContext {
  notesByDate: ReadonlyMap<string, readonly Note[]>;
  eventsByDate: ReadonlyMap<string, readonly TownEvent[]>;
}

export interface DayFlags {
  closed: boolean;
  noted: boolean;
  holiday: boolean;
  event: boolean;
}

const NONE: readonly never[] = [];

export function noteCovers(note: Pick<Note, 'startDate' | 'endDate' | 'weekdays'>, date: string): boolean {
  if (date < note.startDate || date > note.endDate) return false;
  return note.weekdays === null || note.weekdays.includes(weekdayOf(date));
}

export function notesOn(date: string, notes: readonly Note[]): Note[] {
  return notes.filter((note) => noteCovers(note, date));
}

export function eventsOn(date: string, events: readonly TownEvent[]): TownEvent[] {
  return events.filter((event) => event.start <= date && date <= event.end);
}

function push<T>(map: Map<string, T[]>, date: string, item: T): void {
  const list = map.get(date);
  if (list === undefined) map.set(date, [item]);
  else list.push(item);
}

/** Notes and events indexed by each day they cover, in the order given. */
export function dayContext(notes: readonly Note[], events: readonly TownEvent[]): DayContext {
  const notesByDate = new Map<string, Note[]>();
  for (const note of notes) {
    for (let date = note.startDate; date <= note.endDate; date = addDays(date, 1)) {
      if (noteCovers(note, date)) push(notesByDate, date, note);
    }
  }
  const eventsByDate = new Map<string, TownEvent[]>();
  for (const event of events) {
    for (let date = event.start; date <= event.end; date = addDays(date, 1)) push(eventsByDate, date, event);
  }
  return { notesByDate, eventsByDate };
}

export const EMPTY_CONTEXT: DayContext = { notesByDate: new Map(), eventsByDate: new Map() };

export function notesOf(context: DayContext, date: string): readonly Note[] {
  return context.notesByDate.get(date) ?? NONE;
}

export function eventsOf(context: DayContext, date: string): readonly TownEvent[] {
  return context.eventsByDate.get(date) ?? NONE;
}

/** A stored row whose values are all zero: the restaurant was open to no one. */
export function isAllZero(day: Pick<DayRecord, 'guests' | 'netSalesCents'>): boolean {
  if (day.guests === 0) return day.netSalesCents === 0 || day.netSalesCents === null;
  return day.guests === null && day.netSalesCents === 0;
}

export function dayFlags(date: string, day: DayRecord | undefined, context: DayContext): DayFlags {
  const notes = notesOf(context, date);
  const events = eventsOf(context, date);
  return {
    closed: notes.some((note) => note.effect === 'closed') || (day !== undefined && isAllZero(day)),
    noted: notes.some((note) => note.effect !== 'closed'),
    holiday: events.some((event) => event.kind === 'holiday'),
    event: events.some((event) => event.kind === 'event'),
  };
}

export function isClosed(date: string, day: DayRecord | undefined, context: DayContext): boolean {
  return dayFlags(date, day, context).closed;
}

export function classOfFlags(flags: DayFlags): DayClass {
  if (flags.closed) return 'closed';
  if (flags.noted) return 'noted';
  if (flags.holiday) return 'holiday';
  if (flags.event) return 'event';
  return 'regular';
}

export function classOf(date: string, day: DayRecord | undefined, context: DayContext): DayClass {
  return classOfFlags(dayFlags(date, day, context));
}

/**
 * Closed days from `first` to `last` in the given years, counting closure notes on days with no row, so a closure
 * the export skipped still counts. Nothing after `last` is counted.
 */
export function closedDaysBetween(
  first: string, last: string, years: ReadonlySet<number>, byDate: ReadonlyMap<string, DayRecord>, context: DayContext,
): number {
  let closed = 0;
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (years.has(Number(date.slice(0, 4))) && dayFlags(date, byDate.get(date), context).closed) closed += 1;
  }
  return closed;
}
