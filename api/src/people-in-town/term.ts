// The term state of a day (spec 13.2), read from the town calendar's term entries (spec 13.1 convention: kind 'term',
// group '{townId}:classes:{season}' or '{townId}:finals:{season}'). Pure. Between terms is never an entry: it is
// derived, and only when both the finals before and the classes after are known.
import type { TownEvent } from '../town-calendar.ts';

export type TermState = 'in_session' | 'finals' | 'between_terms' | 'summer_session' | 'unknown';

export const TERM_STATES: readonly TermState[] = ['in_session', 'finals', 'between_terms', 'summer_session', 'unknown'];

export interface TermEntry {
  readonly part: 'classes' | 'finals';
  readonly season: 'fall' | 'winter' | 'spring' | 'summer';
  readonly start: string;
  readonly end: string;
  readonly event: TownEvent;
}

export interface TermDay {
  readonly state: TermState;
  /** 'Fall term classes', 'Between terms (from the term dates)'; null when unknown. */
  readonly label: string | null;
  /** The calendar entries the state rests on: one, or the finals and the classes around a break. */
  readonly events: readonly TownEvent[];
}

export const BETWEEN_TERMS_LABEL = 'Between terms (from the term dates)';

const UNKNOWN: TermDay = { state: 'unknown', label: null, events: [] };

const GROUP = /^[a-z0-9-]+:(classes|finals):(fall|winter|spring|summer)$/;

/** The town's term entries among `events`, sorted by start. */
export function termEntries(events: readonly TownEvent[]): TermEntry[] {
  return events.flatMap((event): TermEntry[] => {
    const match = event.kind === 'term' && event.group !== null ? GROUP.exec(event.group) : null;
    if (match === null) return [];
    const part = match[1] as TermEntry['part'];
    const season = match[2] as TermEntry['season'];
    return [{ part, season, start: event.start, end: event.end, event }];
  }).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/**
 * - in_session: a classes entry covers the day (summer_session for summer, when most of the college is away);
 * - finals: a finals entry covers it;
 * - between_terms: the last entry before the day is a finals entry and the next one after it is a classes entry;
 * - unknown: anything else, including the days between classes and finals and any day outside the researched span.
 */
export function termStateOn(date: string, entries: readonly TermEntry[]): TermDay {
  const covering = entries.find((entry) => entry.start <= date && date <= entry.end);
  if (covering !== undefined) {
    const state: TermState = covering.part === 'finals' ? 'finals' : covering.season === 'summer' ? 'summer_session' : 'in_session';
    return { state, label: covering.event.title, events: [covering.event] };
  }
  const before = entries.filter((entry) => entry.end < date).reduce<TermEntry | null>(
    (latest, entry) => (latest === null || entry.end > latest.end ? entry : latest), null,
  );
  const after = entries.find((entry) => entry.start > date);
  if (before?.part === 'finals' && after?.part === 'classes') {
    return { state: 'between_terms', label: BETWEEN_TERMS_LABEL, events: [before.event, after.event] };
  }
  return UNKNOWN;
}
