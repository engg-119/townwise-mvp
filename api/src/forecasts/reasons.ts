// The words for a forecast day's reasons (spec 14.4): made in code from the reason's kind, the day's weekday and the
// public town calendar (spec 13.1), never read from the run file, so a partner's group or customer name can never
// reach a label, an owner or Anthropic through a forecast. A ref names a calendar entry by its id or its group; one
// that names nothing on that day is dropped at import and reads as the kind's plain label. Pure.
import { termEntries, termStateOn, type TermDay } from '../people-in-town/term.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import { townCalendarCovers, townEvents, type TownEvent, type TownEventSource } from '../town-calendar.ts';
import type { ReasonKind } from './file.ts';

export interface ReasonView {
  kind: ReasonKind;
  label: string;
  /** The reason's effect in percent, only where the run recorded one. */
  effectPct: number | null;
  sources: TownEventSource[];
}

export interface DayCalendar {
  /** The town calendar's entries on the day, holidays included. */
  readonly events: readonly TownEvent[];
  readonly term: TermDay;
}

const WEEKDAY_NAME: Readonly<Record<Weekday, string>> = {
  Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
};

const PLAIN: Readonly<Record<ReasonKind, string>> = {
  weekday: 'Weekday', term: 'Term', event: 'Town event', holiday: 'Holiday', level: 'Your recent level', closure: 'Closed',
  booking: 'Private event booked',
};

/** The calendar of a town, day by day: one read of its term entries, then each day's events and term state. */
export function townCalendarOf(townId: string | null): (date: string) => DayCalendar {
  const covers = townCalendarCovers(townId);
  const entries = covers === null ? [] : termEntries(townEvents(townId, covers));
  return (date) => ({ events: townEvents(townId, { from: date, to: date }), term: termStateOn(date, entries) });
}

/** The calendar entry a ref names on this day: by id, else by group when exactly one entry of the day has it. */
export function resolveRef(ref: string | null, events: readonly TownEvent[]): TownEvent | null {
  if (ref === null) return null;
  const byId = events.find((event) => event.id === ref);
  if (byId !== undefined) return byId;
  const byGroup = events.filter((event) => event.group === ref);
  return byGroup.length === 1 ? (byGroup[0] ?? null) : null;
}

function distinctSources(events: readonly TownEvent[]): TownEventSource[] {
  const seen = new Map<string, TownEventSource>();
  for (const source of events.flatMap((event) => event.sources)) {
    if (!seen.has(source.url)) seen.set(source.url, { label: source.label, url: source.url });
  }
  return [...seen.values()];
}

function labelled(entry: TownEvent): { label: string; sources: TownEventSource[] } {
  return { label: entry.title, sources: distinctSources([entry]) };
}

function wordsFor(kind: ReasonKind, ref: string | null, date: string, calendar: DayCalendar): { label: string; sources: TownEventSource[] } {
  if (kind === 'weekday') return { label: WEEKDAY_NAME[weekdayOf(date)], sources: [] };
  if (kind !== 'term' && kind !== 'event' && kind !== 'holiday') return { label: PLAIN[kind], sources: [] };
  const named = resolveRef(ref, calendar.events);
  if (named !== null) return labelled(named);
  if (kind === 'holiday') {
    const holidays = calendar.events.filter((event) => event.kind === 'holiday');
    const [only] = holidays;
    if (holidays.length === 1 && only !== undefined) return labelled(only);
  }
  if (kind === 'term' && calendar.term.state !== 'unknown' && calendar.term.label !== null) {
    return { label: calendar.term.label, sources: distinctSources(calendar.term.events) };
  }
  return { label: PLAIN[kind], sources: [] };
}

/** A day's reasons in words, in the run's order. */
export function reasonViews(
  date: string,
  reasons: readonly { kind: ReasonKind; ref: string | null; effectPct: number | null }[],
  calendar: DayCalendar,
): ReasonView[] {
  return reasons.map((reason) => ({ kind: reason.kind, effectPct: reason.effectPct, ...wordsFor(reason.kind, reason.ref, date, calendar) }));
}

/** At import: a ref is kept only when it names a calendar entry on its day; otherwise nothing of it is stored. */
export function storedRef(ref: string | null, events: readonly TownEvent[]): string | null {
  return resolveRef(ref, events) === null ? null : ref;
}
