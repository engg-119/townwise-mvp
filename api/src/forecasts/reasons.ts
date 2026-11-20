// The words for a forecast day's reasons (spec 14.4): made in code from the reason's kind, the day's weekday and the
// public town calendar (spec 13.1), never read from the run file, so a partner's group or customer name can never
// reach a label, an owner or Anthropic through a forecast. A ref names a calendar entry by its id or its group; one
// that names nothing on that day is dropped at import and reads as the kind's plain label. A note's reason (spec 14.5)
// is worded from the note's kind, guest count and hours, never its detail; a business rule's (D31) from its schedule,
// never the rule's text. A schedule's summary on the rules page is worded here too. A run reason's effect, from the
// model or the location's history, is made in effects.ts. Pure.
import { termEntries, termStateOn, type TermDay, type TermEntry } from '../people-in-town/term.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import { townCalendarCovers, townEvents, type TownEvent, type TownEventSource } from '../town-calendar.ts';
import type { RuleSchedule, RuleSeason } from '../stores/business-rules.ts';
import type { NoteRecord } from '../stores/notes.ts';
import type { NoteOutcome, ScheduledRule } from './adjust.ts';
import type { ReasonEffect, ReasonEffectOf } from './effects.ts';
import type { ReasonKind } from './file.ts';

export interface ReasonView {
  kind: ReasonKind | 'note' | 'rule';
  label: string;
  /** The reason's effect in percent, only where the run recorded one; null on a note's or a rule's reason. */
  effectPct: number | null;
  /**
   * From the town's today on, whether the reason usually brings more or fewer guests (effects.ts): the model's where
   * the run recorded effectPct, else the location's own history. Null on a day before today, on a note's or a rule's
   * reason (its outcome says what it did), for a kind history can't speak to, and below the history's minimums.
   */
  effect: ReasonEffect | null;
  /** [] on a note's or a rule's reason. */
  sources: TownEventSource[];
  /** Set on kind 'note' only: the note, its guest count and what it did to the day. */
  note: { id: string; guests: number | null; outcome: NoteOutcome } | null;
  /** Set on kind 'rule' only: the business rule, its schedule's guest count and what it did to the day. */
  rule: { id: string; guests: number | null; outcome: NoteOutcome } | null;
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

/** A town's term entries, over every year its calendar covers. */
export function townTermEntries(townId: string | null): TermEntry[] {
  const covers = townCalendarCovers(townId);
  return covers === null ? [] : termEntries(townEvents(townId, covers));
}

/**
 * The calendar of a town, day by day: one read of its term entries (or the caller's, from townTermEntries), then each
 * day's events and term state.
 */
export function townCalendarOf(townId: string | null, entries: readonly TermEntry[] = townTermEntries(townId)): (date: string) => DayCalendar {
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

function labeled(entry: TownEvent): { label: string; sources: TownEventSource[] } {
  return { label: entry.title, sources: distinctSources([entry]) };
}

/**
 * The calendar entry a term, event or holiday reason names on its day: its ref's entry (by id, or by a group with one
 * entry that day), or for a holiday the day's only holiday; null otherwise. Its label and its effect both read it.
 */
export function namedEntry(kind: ReasonKind, ref: string | null, calendar: DayCalendar): TownEvent | null {
  if (kind !== 'term' && kind !== 'event' && kind !== 'holiday') return null;
  const named = resolveRef(ref, calendar.events);
  if (named !== null || kind !== 'holiday') return named;
  const holidays = calendar.events.filter((event) => event.kind === 'holiday');
  return holidays.length === 1 ? (holidays[0] ?? null) : null;
}

function wordsFor(kind: ReasonKind, ref: string | null, date: string, calendar: DayCalendar): { label: string; sources: TownEventSource[] } {
  if (kind === 'weekday') return { label: WEEKDAY_NAME[weekdayOf(date)], sources: [] };
  const named = namedEntry(kind, ref, calendar);
  if (named !== null) return labeled(named);
  if (kind === 'term' && calendar.term.state !== 'unknown' && calendar.term.label !== null) {
    return { label: calendar.term.label, sources: distinctSources(calendar.term.events) };
  }
  return { label: PLAIN[kind], sources: [] };
}

/** A run reason's recorded effect for choosing between two with one label: its size, and none below any. */
function effectSize(view: ReasonView): number {
  return view.effectPct === null ? -1 : Math.abs(view.effectPct);
}

/**
 * D49: one run reason per label on a day, the label compared in lower case with each run of white space one space: the
 * one with the larger recorded effect (else the first) stands where the first did, with both reasons' sources, so Why
 * never says "Veterans Day" twice. Note and rule reasons never come here (reader.ts adds them), so they never merge.
 */
function onePerLabel(views: readonly ReasonView[]): ReasonView[] {
  const kept: ReasonView[] = [];
  const at = new Map<string, number>();
  for (const view of views) {
    const key = view.label.toLowerCase().replace(/\s+/g, ' ').trim();
    const index = at.get(key);
    const earlier = index === undefined ? undefined : kept[index];
    if (index === undefined || earlier === undefined) {
      at.set(key, kept.length);
      kept.push(view);
      continue;
    }
    const [winner, other] = effectSize(view) > effectSize(earlier) ? [view, earlier] : [earlier, view];
    const sources = new Map([...winner.sources, ...other.sources].map((source) => [source.url, source] as const));
    kept[index] = { ...winner, sources: [...sources.values()] };
  }
  return kept;
}

/**
 * A day's reasons in words, in the run's order, one per label (onePerLabel), each with its effect when `effectOf` is
 * given (a day from today on).
 */
export function reasonViews(
  date: string,
  reasons: readonly { kind: ReasonKind; ref: string | null; effectPct: number | null }[],
  calendar: DayCalendar,
  effectOf?: ReasonEffectOf,
): ReasonView[] {
  return onePerLabel(reasons.map((reason) => ({
    kind: reason.kind, effectPct: reason.effectPct, effect: effectOf?.(date, reason, calendar) ?? null,
    ...wordsFor(reason.kind, reason.ref, date, calendar), note: null, rule: null,
  })));
}

/** A local 'HH:MM' in words: '18:30' is "6:30 pm", '18:00' is "6 pm", '12:00' is "noon" and '00:00' is "midnight". */
export function clockWords(time: string): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  if (minutes === 0 && hours === 12) return 'noon';
  if (minutes === 0 && hours === 0) return 'midnight';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(hour)}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`} ${hours < 12 ? 'am' : 'pm'}`;
}

const NOTE_NOUN: Readonly<Record<NoteRecord['kind'], string>> = {
  closure: 'closure', private_event: 'private event', opening: 'opening', other: 'note',
};

function noteLabel(note: NoteRecord): string {
  if (note.kind === 'closure') return 'Your closure';
  // D67. [CONFIRM: the words "The guest count was wrong (sales were right)", "Your note: guest count marked wrong" and
  // "Guest count marked wrong"]
  if (note.effect === 'wrong_guest_count') return 'Your note: guest count marked wrong';
  const guests = note.expectedGuests === null ? '' : `, ${String(note.expectedGuests)} ${note.expectedGuests === 1 ? 'guest' : 'guests'}`;
  if (note.effect === 'closed') return note.kind === 'private_event' ? `Your private buyout${guests}` : 'Your note: closed';
  const hours = note.startTime === null || note.endTime === null ? '' : `, ${clockWords(note.startTime)} to ${clockWords(note.endTime)}`;
  return `Your ${NOTE_NOUN[note.kind]}${guests}${hours}`;
}

/** A note's reason on a forecast day, worded from its kind, guest count and hours, never its detail. */
export function noteReasonView(note: NoteRecord, outcome: NoteOutcome): ReasonView {
  return {
    kind: 'note', label: noteLabel(note), effectPct: null, effect: null, sources: [], note: { id: note.id, guests: note.expectedGuests, outcome }, rule: null,
  };
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' in words, "Jan 5, 2027", as the client's formatDate puts it. */
export function dateWords(date: string): string {
  const [year = '', month = '', day = ''] = date.split('-');
  return `${SHORT_MONTHS[Number(month) - 1] ?? ''} ${String(Number(day))}, ${year}`;
}

/** Plural weekday names by the API's number (0 is Sunday). */
const WEEKDAY_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** "Mondays", "Saturdays and Sundays", "Tuesdays, Wednesdays and Thursdays", Monday first; null for every day. */
export function weekdayList(weekdays: readonly number[] | null): string | null {
  if (weekdays === null || weekdays.length >= 7) return null;
  const names = MONDAY_FIRST.filter((day) => weekdays.includes(day)).map((day) => WEEKDAY_PLURAL[day] ?? '');
  return names.length === 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

const KIND_WORDS: Readonly<Record<RuleSchedule['kind'], string>> = {
  closure: 'Closure', private_event: 'Private event', opening: 'Opening', other: 'Other',
};
const EFFECT_WORDS: Readonly<Record<RuleSchedule['effect'], string>> = {
  closed: 'closed', more_guests: 'more guests than usual', fewer_guests: 'fewer guests than usual', unknown: 'effect not known',
  // A note's only (D67): the rules routes refuse it, so no schedule says this.
  wrong_guest_count: 'guest count marked wrong',
};

function guestWords(guests: number): string {
  return `${String(guests)} ${guests === 1 ? 'guest' : 'guests'}`;
}

/**
 * What a schedule does, from its kind, effect and guest count, as the forecast read applies it (adjust.ts): "Closed",
 * "Private buyout, 70 guests", "Adds 40 guests", or its kind and effect ("Opening, fewer guests than usual, about 20 guests").
 */
function scheduleWhat(schedule: RuleSchedule): string {
  const { kind, effect, expectedGuests } = schedule;
  if (kind === 'closure' || (effect === 'closed' && kind !== 'private_event')) return 'Closed';
  if (kind === 'private_event' && effect === 'closed') return expectedGuests === null ? 'Private buyout' : `Private buyout, ${guestWords(expectedGuests)}`;
  if (kind === 'private_event' && effect === 'more_guests' && expectedGuests !== null) return `Adds ${guestWords(expectedGuests)}`;
  return `${KIND_WORDS[kind]}, ${EFFECT_WORDS[effect]}${expectedGuests === null ? '' : `, about ${guestWords(expectedGuests)}`}`;
}

function hoursWords(schedule: Pick<RuleSchedule, 'startTime' | 'endTime'>): string {
  return schedule.startTime === null || schedule.endTime === null ? '' : `, ${clockWords(schedule.startTime)} to ${clockWords(schedule.endTime)}`;
}

/** 'MM-DD' in words: "Jan 1". */
export function monthDayWords(monthDay: string): string {
  const [month = '', day = ''] = monthDay.split('-');
  return `${SHORT_MONTHS[Number(month) - 1] ?? ''} ${String(Number(day))}`;
}

/** A yearly season (D46) and its weekdays: "Jan 1 to Mar 31 every year", "on Mondays, Dec 20 to Jan 5 every year". */
function seasonWords(season: RuleSeason, days: string | null): string {
  const span = `${monthDayWords(season.from)} to ${monthDayWords(season.to)} every year`;
  return days === null ? span : `on ${days}, ${span}`;
}

/**
 * A rule's schedule in plain words, built from its fields only (the rules page's "Changes the forecast" line and the
 * business_rules block TownwiseAI reads): what it does, its weekdays, its dates and its hours. "Closed on Mondays from
 * Jan 5, 2027", "Adds 40 guests on Fridays from Jan 2, 2026, 6 pm to 9 pm", "Closed on Dec 24, 2026". A yearly season
 * (D46): "Closed Jan 1 to Mar 31 every year, from Nov 17, 2026".
 */
export function scheduleSummary(schedule: RuleSchedule): string {
  const { startDate, endDate } = schedule;
  const days = weekdayList(schedule.weekdays);
  const season = schedule.season ?? null;
  if (season !== null) return `${scheduleWhat(schedule)} ${seasonWords(season, days)}, from ${dateWords(startDate)}${hoursWords(schedule)}`;
  const oneDay = endDate === startDate;
  const dates = endDate === null ? `from ${dateWords(startDate)}`
    : oneDay ? `on ${dateWords(startDate)}` : `from ${dateWords(startDate)} to ${dateWords(endDate)}`;
  const which = days !== null ? `on ${days} ${dates}` : oneDay ? dates : `every day ${dates}`;
  return `${scheduleWhat(schedule)} ${which}${hoursWords(schedule)}`;
}

/** A rule's reason on a forecast day: "Your rule: closed on Mondays", worded from its schedule (no dates), never its text. */
export function ruleReasonView(rule: ScheduledRule, outcome: NoteOutcome): ReasonView {
  const { schedule } = rule;
  const what = scheduleWhat(schedule);
  const days = weekdayList(schedule.weekdays);
  const season = schedule.season ?? null;
  const which = season !== null ? ` ${seasonWords(season, days)}` : days === null ? '' : ` on ${days}`;
  return {
    kind: 'rule',
    label: `Your rule: ${what.charAt(0).toLowerCase()}${what.slice(1)}${which}${hoursWords(schedule)}`,
    effectPct: null,
    effect: null,
    sources: [],
    note: null,
    rule: { id: rule.id, guests: schedule.expectedGuests, outcome },
  };
}

/** At import: a ref is kept only when it names a calendar entry on its day; otherwise nothing of it is stored. */
export function storedRef(ref: string | null, events: readonly TownEvent[]): string | null {
  return resolveRef(ref, events) === null ? null : ref;
}
