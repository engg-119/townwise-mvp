// A forecast reason's effect (spec 14.4): whether it pushes a day's guests up or down, and by about how much. Where the
// run recorded an effect (effectPct) it is the model's. No run records one yet (the lab writes None, and its
// quantile-linear base plus xgboost doesn't estimate one per reason), so otherwise it is how this location's own stored
// days usually ran, worded "usually" by every reader, never a claim about why the model made its figure.
// [CONFIRM: a reason's effect is the model's when the run records one, else the location's own history, worded "usually"]
//
// The history is the 52 weeks before the town's today, read with the forecast's own read of the stored days (reader.ts),
// and every closed and likely-closed day (spec D32, ../closed-days.ts) is left out of both sides of every comparison:
// - weekday: that weekday's mean guests against the mean over every open day, with at least 8 of that weekday;
// - term: each day in the day's term state against the mean of the same weekday in the other known term states, with
//   at least 6 days on each side;
// - holiday: each past occurrence of the holiday (its calendar group) against the same weekday in the 4 weeks before
//   and after it, other holidays left out, with at least 1 occurrence;
// - event: each day with the event's calendar group against the mean of the same weekday without it, with at least 3
//   event days and 3 days without.
// "Against the same weekday" sums the days' guests over what those weekdays usually got, so a finals Saturday is held to
// Saturdays and a finals Tuesday to Tuesdays. The size is rounded to the nearest 5%, and 5% or less reads as about the
// same. Below a minimum, for any other kind, on a note's or a rule's reason (its outcome says what it did) and on a day
// before today, the effect is null. [CONFIRM: the history is the 52 weeks before today; a weekday needs 8 of its days,
// a term state 6 days in it and 6 same-weekday days outside it, a holiday 1 past occurrence, an event 3 days with it and
// 3 without; holidays compare with the same weekday 4 weeks either side; 5% steps, and 5% or less is about the same]
// Pure: computed on every read, stored nowhere and logged nowhere.
import { closureOf, TYPICAL_LOOKBACK_DAYS, typicalByDate, type Entry } from '../closed-days.ts';
import { utcDay } from '../dates.ts';
import { termStateOn, type TermEntry, type TermState } from '../people-in-town/term.ts';
import type { SalesDay } from '../stores/sales-days.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import { townEvents } from '../town-calendar.ts';
import type { ReasonKind } from './file.ts';
import { namedEntry, townTermEntries, type DayCalendar } from './reasons.ts';

export interface ReasonEffect {
  /** 'same' when the rounded size is 5% or less. */
  direction: 'more' | 'fewer' | 'same';
  /** The size in percent, rounded to the nearest 5; never negative (the direction says which way). */
  pct: number;
  /** 'model': the run recorded it; 'history': how this location's own days usually ran. */
  basis: 'model' | 'history';
  /** The history days it rests on (that weekday's, the term state's, the holiday's or the event's); null for the model's. */
  days: number | null;
}

/** The 52 weeks before today the effects read. */
export const HISTORY_WEEKS = 52;
export const WEEKDAY_MIN_DAYS = 8;
/** On each side. */
export const TERM_MIN_DAYS = 6;
export const HOLIDAY_MIN_DAYS = 1;
/** A holiday is compared with the same weekday this many weeks before and after it. */
export const HOLIDAY_AROUND_WEEKS = 4;
/** With the event, and without it. */
export const EVENT_MIN_DAYS = 3;
/** Sizes are rounded to this many percent; a size this big or smaller reads as about the same. */
export const PCT_STEP = 5;

const DAY = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

/**
 * The days the effects read, both ends included: the history (`from`, the 52 weeks before today, to `to`, yesterday),
 * and `readFrom`, the 8 weeks earlier still, whose same weekdays give the history's first days their typical guests.
 */
export function effectHistory(today: string): { from: string; to: string; readFrom: string } {
  const from = utcDay(DAY(today), -7 * HISTORY_WEEKS);
  return { from, to: utcDay(DAY(today), -1), readFrom: utcDay(DAY(from), -TYPICAL_LOOKBACK_DAYS) };
}

/** An effect from a signed percent: its size rounded to the nearest 5, and 'same' at 5 or less. */
export function effectFrom(pct: number, basis: ReasonEffect['basis'], days: number | null): ReasonEffect {
  const size = Math.round(Math.abs(pct) / PCT_STEP) * PCT_STEP;
  return { direction: size <= PCT_STEP ? 'same' : pct > 0 ? 'more' : 'fewer', pct: size, basis, days };
}

export interface EffectHistory {
  /** The town's today: the history ends the day before. */
  readonly today: string;
  readonly townId: string | null;
  /** The location's stored days from effectHistory(today).readFrom to yesterday (others are ignored). */
  readonly days: readonly SalesDay[];
  /**
   * The notes and the rule schedules covering a day: a closure says the day was closed (a rule's only when the day had
   * few or no guests, and never over a note that decides the day), more or fewer guests that it was open (D32).
   */
  readonly covering: (date: string) => { readonly notes: readonly Entry[]; readonly rules: readonly Entry[] };
  /** The town's term entries, when the caller already has them (townTermEntries). */
  readonly termEntries?: readonly TermEntry[];
}

export interface RunReason { readonly kind: ReasonKind; readonly ref: string | null; readonly effectPct: number | null }

/** A run reason's effect on `date` (a day from today on), given that day's calendar; null when there is nothing honest to say. */
export type ReasonEffectOf = (date: string, reason: RunReason, calendar: DayCalendar) => ReasonEffect | null;

interface OpenDay {
  readonly date: string;
  readonly guests: number;
  readonly weekday: Weekday;
  readonly state: TermState;
  /** The calendar groups of the holidays and town events covering the day. */
  readonly groups: ReadonlySet<string>;
  readonly holiday: boolean;
}

const sum = (days: readonly OpenDay[]): number => days.reduce((total, day) => total + day.guests, 0);

/** `actual` against `expected` guests as an effect from history; null when nothing was expected. */
function compared(actual: number, expected: number, days: number): ReasonEffect | null {
  return expected > 0 ? effectFrom(100 * (actual / expected - 1), 'history', days) : null;
}

/**
 * `inside` against the same weekday among `outside`: their guests over the mean of `outside`'s days of each one's
 * weekday. A day whose weekday `outside` lacks is left out; each side needs `min` days that count.
 */
function againstSameWeekday(inside: readonly OpenDay[], outside: readonly OpenDay[], min: number): ReasonEffect | null {
  const usual = new Map<Weekday, OpenDay[]>();
  for (const day of outside) usual.set(day.weekday, [...(usual.get(day.weekday) ?? []), day]);
  const kept = inside.filter((day) => usual.has(day.weekday));
  const weekdays = new Set(kept.map((day) => day.weekday));
  const baseline = outside.filter((day) => weekdays.has(day.weekday));
  if (kept.length < min || baseline.length < min) return null;
  const expected = kept.reduce((total, day) => {
    const same = usual.get(day.weekday) ?? [];
    return total + sum(same) / same.length;
  }, 0);
  return compared(sum(kept), expected, kept.length);
}

/**
 * The effects of a window's run reasons, from one history: its open days are classified once, and each kind's
 * comparison is made once per weekday, term state or calendar group, however many days of the window share it.
 */
export function reasonEffects(history: EffectHistory): ReasonEffectOf {
  const { from, to } = effectHistory(history.today);
  const typical = typicalByDate(history.days);
  const entries = history.termEntries ?? townTermEntries(history.townId);
  const events = townEvents(history.townId, { from, to }).filter((event) => event.kind === 'holiday' || event.kind === 'event');
  const open: OpenDay[] = [];
  for (const day of history.days) {
    if (day.date < from || day.date > to || day.guests === null) continue;
    const { notes, rules } = history.covering(day.date);
    if (closureOf(day, typical.get(day.date) ?? null, notes, { rules, past: true }) !== null) continue;
    const on = events.filter((event) => event.start <= day.date && day.date <= event.end);
    open.push({
      date: day.date, guests: day.guests, weekday: weekdayOf(day.date), state: termStateOn(day.date, entries).state,
      groups: new Set(on.flatMap((event) => (event.group === null ? [] : [event.group]))), holiday: on.some((event) => event.kind === 'holiday'),
    });
  }
  const byDate = new Map(open.map((day) => [day.date, day]));

  const weekday = (which: Weekday): ReasonEffect | null => {
    const same = open.filter((day) => day.weekday === which);
    if (same.length < WEEKDAY_MIN_DAYS) return null;
    return compared(sum(same) / same.length, sum(open) / open.length, same.length);
  };
  const term = (state: TermState): ReasonEffect | null => againstSameWeekday(
    open.filter((day) => day.state === state), open.filter((day) => day.state !== state && day.state !== 'unknown'), TERM_MIN_DAYS,
  );
  const event = (group: string): ReasonEffect | null => againstSameWeekday(
    open.filter((day) => day.groups.has(group)), open.filter((day) => !day.groups.has(group)), EVENT_MIN_DAYS,
  );
  const holiday = (group: string): ReasonEffect | null => {
    let actual = 0;
    let expected = 0;
    let kept = 0;
    for (const day of open.filter((each) => each.groups.has(group))) {
      const around: OpenDay[] = [];
      for (let week = -HOLIDAY_AROUND_WEEKS; week <= HOLIDAY_AROUND_WEEKS; week += 1) {
        const near = week === 0 ? undefined : byDate.get(utcDay(DAY(day.date), 7 * week));
        if (near !== undefined && !near.holiday) around.push(near);
      }
      if (around.length === 0) continue;
      actual += day.guests;
      expected += sum(around) / around.length;
      kept += 1;
    }
    return kept < HOLIDAY_MIN_DAYS ? null : compared(actual, expected, kept);
  };

  const made = new Map<string, ReasonEffect | null>();
  const once = (key: string, make: () => ReasonEffect | null): ReasonEffect | null => {
    if (!made.has(key)) made.set(key, make());
    return made.get(key) ?? null;
  };
  return (date, reason, calendar) => {
    if (reason.effectPct !== null) return effectFrom(reason.effectPct, 'model', null);
    switch (reason.kind) {
      case 'weekday': {
        const which = weekdayOf(date);
        return once(`weekday|${which}`, () => weekday(which));
      }
      case 'term': {
        const { state } = calendar.term;
        return state === 'unknown' ? null : once(`term|${state}`, () => term(state));
      }
      case 'event':
      case 'holiday': {
        const group = namedEntry(reason.kind, reason.ref, calendar)?.group ?? null;
        if (group === null) return null;
        return once(`${reason.kind}|${group}`, () => (reason.kind === 'event' ? event(group) : holiday(group)));
      }
      default:
        return null;
    }
  };
}
