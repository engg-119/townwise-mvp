import type { ResearchedEvent, TownEvent } from '../analytics/api';
import { noteCovers } from '../analytics/days';
import { formatCount } from '../format';
import type { Note } from '../locations/api';
import { KIND_LABEL } from '../locations/noteRules';
import { foundWords } from '../research/copy';
import type { Rule } from '../rules/api';
import type { Filters, FilterKey, ImportedEvent } from './model';

// Everything on a day (D49, calendar-shows-everything design decisions 1 and 4), pure: the one list every Calendar
// (P28) and Home (P11) surface reads, on web and native. The order is the owner's notes (in start order), the business
// rules whose schedule covers the day (oldest first, whatever the filters), the holidays then town events the filters
// allow, the imported calendar events (by start time), and the events town research found (D66, "Found by research", in
// the read's order); term and season periods come last, and only for the surfaces that list them. A day's status never removes an entry. Compact surfaces (the month cell, the tooltip, the
// week cards, Home's This week and month list) show a title once across sources (compactEntries); the day panel and
// Home's day detail list every entry with its source.

/** Holidays, town events, and term and season periods ("Term dates"). */
export function filterOf(event: Pick<TownEvent, 'kind'>): FilterKey {
  if (event.kind === 'holiday') return 'holidays';
  if (event.kind === 'event') return 'events';
  return 'terms';
}

/** A note in a cell's chip: “Private event, 70”, “Private buyout”, “Closure”. */
export function noteChip(note: Pick<Note, 'kind' | 'effect' | 'expectedGuests'>): string {
  const kind = note.kind === 'private_event' && note.effect === 'closed' ? 'Private buyout' : KIND_LABEL[note.kind];
  return note.expectedGuests === null ? kind : `${kind}, ${formatCount(note.expectedGuests)}`;
}

/** What a compact surface prints for a note: its event name (D49), else its kind words. */
export function noteWords(note: Pick<Note, 'kind' | 'effect' | 'expectedGuests' | 'title'>): string {
  return note.title ?? noteChip(note);
}

/** Lower case, each run of white space one space, trimmed (as api/src/files/ai-actions.ts folds a title). */
export function folded(words: string): string {
  return words.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Where an entry comes from: the notes, the rules, the town calendar, one of the location's calendars, or research. */
export type EntryGroup = 'notes' | 'rules' | 'town' | `calendar:${string}` | 'research';

/**
 * An entry's source link: a town event's sites, an imported event's calendar (its page in Your data, by the
 * calendar's own label), or the file a TownwiseAI note was made from (its item's ref). Null for a note the person
 * typed and a rule.
 */
export type EntrySource =
  | { kind: 'town'; sources: TownEvent['sources'] }
  | { kind: 'research'; sources: ResearchedEvent['sources'] }
  | { kind: 'calendar'; calendarId: string; calendar: string }
  | { kind: 'file'; ref: string }
  | null;

interface EntryBase {
  key: string;
  group: EntryGroup;
  /** What a compact surface prints: a note's title or kind words, a rule's text, a town entry's or imported event's title. */
  words: string;
  /** The name a compact surface folds to show it once; null for a note's kind words, made in code. */
  title: string | null;
  source: EntrySource;
}

export type DayEntry =
  | (EntryBase & { kind: 'note'; note: Note })
  | (EntryBase & { kind: 'rule'; rule: Rule })
  | (EntryBase & { kind: TownEvent['kind']; event: TownEvent })
  | (EntryBase & { kind: 'imported'; imported: ImportedEvent })
  | (EntryBase & { kind: 'researched'; researched: ResearchedEvent });

/** What a day's entries are read from: the location's notes, rules, town calendar and own calendars, and the filters. */
export interface DaySources {
  notes: readonly Note[];
  rules?: readonly Rule[] | undefined;
  events: readonly TownEvent[];
  imported: readonly ImportedEvent[];
  /** The events town research found (the calendar read's `found`, D66); none when absent or unavailable. */
  found?: readonly ResearchedEvent[] | null | undefined;
  filters: Filters;
}

/** Whether a found event is on `date`: inside its dates, and on one of its weekdays (0 Sunday to 6) when it has them. */
export function foundCovers(event: Pick<ResearchedEvent, 'start' | 'end' | 'weekdays'>, date: string): boolean {
  if (date < event.start || date > event.end) return false;
  return event.weekdays === null || event.weekdays.includes(new Date(`${date}T00:00:00.000Z`).getUTCDay());
}

const CALENDAR_FALLBACK = 'Your calendar';

function byStart<T>(items: readonly T[], date: (item: T) => string, time: (item: T) => string | null | undefined): T[] {
  // Array.prototype.sort is stable, so items that start together keep the read's order; all-day ones first.
  return [...items].sort((a, b) => date(a).localeCompare(date(b)) || (time(a) ?? '').localeCompare(time(b) ?? ''));
}

/**
 * The day's entries in the one order (see the top of this file). `periods`: also the term and season periods, last,
 * for the day panel, the week cards and Home's This week periods line.
 */
export function dayEntries(date: string, from: DaySources, options: { periods?: boolean } = {}): DayEntry[] {
  const notes = from.filters.notes ? byStart(from.notes.filter((note) => noteCovers(note, date)), (note) => note.startDate, (note) => note.startTime) : [];
  const rules = (from.rules ?? []).filter((rule) => rule.schedule !== null && rule.schedule !== undefined && noteCovers(rule.schedule, date));
  const town = from.events.filter((event) => event.start <= date && date <= event.end && from.filters[filterOf(event)]);
  const imported = from.filters.imported
    ? byStart(from.imported.filter((event) => event.startDate <= date && date <= event.endDate), () => '', (event) => event.startTime)
    : [];
  const found = from.filters.researched ? (from.found ?? []).filter((event) => foundCovers(event, date)) : [];
  const townEntry = (event: TownEvent, at: number): DayEntry => ({
    key: `event:${String(at)}:${event.id}`, kind: event.kind, group: 'town', words: event.title, title: event.title,
    source: { kind: 'town', sources: event.sources }, event,
  });
  const ref = (note: Note): EntrySource => (note.source?.ref ? { kind: 'file', ref: note.source.ref } : null);
  return [
    ...notes.map((note): DayEntry => ({
      key: `note:${note.id}`, kind: 'note', group: 'notes', words: noteWords({ ...note, title: note.title ?? null }), title: note.title ?? null,
      source: ref(note), note,
    })),
    ...rules.map((rule): DayEntry => ({ key: `rule:${rule.id}`, kind: 'rule', group: 'rules', words: rule.text, title: rule.text, source: null, rule })),
    ...town.map((event, at) => ({ event, at })).filter(({ event }) => event.kind === 'holiday').map(({ event, at }) => townEntry(event, at)),
    ...town.map((event, at) => ({ event, at })).filter(({ event }) => event.kind === 'event').map(({ event, at }) => townEntry(event, at)),
    ...imported.map((event): DayEntry => ({
      key: `imported:${event.calendarId}:${event.uid}`, kind: 'imported', group: `calendar:${event.calendarId}`, words: event.title, title: event.title,
      source: { kind: 'calendar', calendarId: event.calendarId, calendar: event.calendar ?? CALENDAR_FALLBACK }, imported: event,
    })),
    ...found.map((event): DayEntry => ({
      key: `found:${event.id}`, kind: 'researched', group: 'research', words: foundWords(event), title: event.title,
      source: { kind: 'research', sources: event.sources }, researched: event,
    })),
    ...(options.periods === true
      ? town.map((event, at) => ({ event, at })).filter(({ event }) => event.kind === 'term' || event.kind === 'season').map(({ event, at }) => townEntry(event, at))
      : []),
  ];
}

/**
 * The entries a compact surface shows: a later entry is left out when its folded title equals an earlier one's from
 * another source. Within one source nothing merges (two notes are two facts; two events of one calendar keep their own
 * hours), and kind words made in code never merge.
 */
export function compactEntries<T extends Pick<DayEntry, 'group' | 'title'>>(entries: readonly T[]): T[] {
  const seen = new Map<string, Set<string>>();
  return entries.filter((entry) => {
    if (entry.title === null) return true;
    const name = folded(entry.title);
    const groups = seen.get(name) ?? new Set<string>();
    const elsewhere = [...groups].some((group) => group !== entry.group);
    if (elsewhere) return false;
    seen.set(name, groups.add(entry.group));
    return true;
  });
}

/**
 * The entries the tooltip's reasons do not already name. A note or rule is left out only when its own reason is shown
 * (by id), so a second note with the same title is never hidden; any other entry when its folded words equal a shown
 * name (a reason's label or a note reason's title).
 */
export function notNamed(entries: readonly DayEntry[], names: readonly string[], shownIds: ReadonlySet<string>): DayEntry[] {
  const shown = new Set(names.map(folded));
  return entries.filter((entry) => {
    if (entry.kind === 'note') return !shownIds.has(entry.note.id);
    if (entry.kind === 'rule') return !shownIds.has(entry.rule.id);
    return !shown.has(folded(entry.words));
  });
}

/** A surface's lines at its limit: every line when they fit, else one fewer and “+N more” for the rest. */
export function fitLines(words: readonly string[], max: number): { lines: string[]; more: string | null } {
  if (words.length <= max) return { lines: [...words], more: null };
  const shown = Math.max(0, max - 1);
  return { lines: words.slice(0, shown), more: `+${String(words.length - shown)} more` };
}
