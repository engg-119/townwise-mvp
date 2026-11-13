// "Your history by term state" (spec 13.2): how this location's own open regular days ran in each term state and
// weekday. It is the honest answer to how the town moves this location's demand while no forecast exists. Pure.
//
// The day classes are the client's (client/src/portal/analytics/days.ts), ported here and pinned by the
// shared fixture test/fixtures/day-classes.json (client copy: client/test/portal/analytics/day-classes.json). A change
// to one side needs the other and the fixture. Closed includes likely closed (../closed-days.ts, spec D32), and a note
// covering a day beats a rule schedule there. `today` is the town's today: a day on or after it is never likely closed,
// and only before it does a day's real guests beat a rule's closure. With no today, every day counts as past.
import { closureOf, typicalByDate, type Closure } from '../closed-days.ts';
import type { NoteContent } from '../stores/notes.ts';
import type { SalesDay } from '../stores/sales-days.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import type { TownEvent } from '../town-calendar.ts';
import { TERM_STATES, type TermState } from './term.ts';

export type DayClass = 'closed' | 'noted' | 'holiday' | 'event' | 'regular';

/** A cell needs this many days, or its mean is null. */
export const MIN_CELL_DAYS = 3;

export interface HistoryCell { state: TermState; weekday: Weekday; days: number; mean: number | null }

export interface YourHistory {
  /** guests when any stored day has guests, else netSales. */
  metric: 'guests' | 'netSales';
  /** Known term states only, in TERM_STATES order, Monday first. `mean` is whole guests, or whole US dollars. */
  cells: HistoryCell[];
  /** The first and last day counted, or null when none was. */
  first: string | null;
  last: string | null;
}

type ClassNote = Pick<NoteContent, 'kind' | 'startDate' | 'endDate' | 'weekdays' | 'effect'>;
/** A business rule's schedule (D31): a note's kind, dates, weekdays and effect, with `endDate` null for no end. */
export type ClassRule = Pick<NoteContent, 'kind' | 'startDate' | 'weekdays' | 'effect'> & { readonly endDate: string | null };
type ClassEvent = Pick<TownEvent, 'start' | 'end' | 'kind'>;

function covers(note: ClassNote | ClassRule, date: string): boolean {
  if (date < note.startDate || (note.endDate !== null && date > note.endDate)) return false;
  return note.weekdays === null || note.weekdays.includes(new Date(`${date}T00:00:00.000Z`).getUTCDay());
}

/**
 * Whether the day is closed or likely closed (spec D32), from the notes and rule schedules covering it, its weekday's
 * typical guests and the town's `today` (null: the day is past).
 */
export function closureOfDay(
  date: string, day: Pick<SalesDay, 'guests' | 'netSalesCents'> | undefined, notes: readonly ClassNote[], typical: number | null,
  rules: readonly ClassRule[] = [], today: string | null = null,
): Closure | null {
  return closureOf(day, typical, notes.filter((note) => covers(note, date)), {
    rules: rules.filter((rule) => covers(rule, date)), past: today === null || date < today,
  });
}

/**
 * The first that applies: closed (closureOfDay: a covering closure note or a rule closure that holds, an all-zero row,
 * or likely closed given its weekday's `typical` guests), noted (a covering note that does not close it), holiday,
 * event, regular. Term and season entries never make a day irregular. With `typical` null, likely closed never applies.
 */
export function classOfDay(
  date: string, day: Pick<SalesDay, 'guests' | 'netSalesCents'> | undefined, notes: readonly ClassNote[], events: readonly ClassEvent[],
  typical: number | null = null, rules: readonly ClassRule[] = [], today: string | null = null,
): DayClass {
  const covering = notes.filter((note) => covers(note, date));
  const on = events.filter((event) => event.start <= date && date <= event.end);
  // A rule schedule only closes a day or says it was open (D32); it never makes a day noted, as it is no note.
  if (closureOfDay(date, day, covering, typical, rules, today) !== null) return 'closed';
  if (covering.length > 0) return 'noted';
  if (on.some((event) => event.kind === 'holiday')) return 'holiday';
  if (on.some((event) => event.kind === 'event')) return 'event';
  return 'regular';
}

const WEEK: readonly Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Every stored open regular day whose term state is known, by term state and weekday. `today`: as classOfDay's. */
export function yourHistory(
  days: readonly SalesDay[], notes: readonly ClassNote[], events: readonly ClassEvent[], termStateOf: (date: string) => TermState,
  rules: readonly ClassRule[] = [], today: string | null = null,
): YourHistory {
  const metric = days.some((day) => day.guests !== null) ? 'guests' : 'netSales';
  const typical = typicalByDate(days);
  const sums = new Map<string, { days: number; total: number }>();
  let first: string | null = null;
  let last: string | null = null;
  for (const day of days) {
    const value = metric === 'guests' ? day.guests : day.netSalesCents;
    if (value === null) continue;
    const state = termStateOf(day.date);
    if (state === 'unknown' || classOfDay(day.date, day, notes, events, typical.get(day.date) ?? null, rules, today) !== 'regular') continue;
    const key = `${state}|${weekdayOf(day.date)}`;
    const sum = sums.get(key) ?? { days: 0, total: 0 };
    sums.set(key, { days: sum.days + 1, total: sum.total + value });
    if (first === null || day.date < first) first = day.date;
    if (last === null || day.date > last) last = day.date;
  }
  const cells = TERM_STATES.flatMap((state) => WEEK.flatMap((weekday): HistoryCell[] => {
    const sum = sums.get(`${state}|${weekday}`);
    if (sum === undefined) return [];
    const mean = sum.total / sum.days / (metric === 'guests' ? 1 : 100);
    return [{ state, weekday, days: sum.days, mean: sum.days < MIN_CELL_DAYS ? null : Math.round(mean) }];
  }));
  return { metric, cells, first, last };
}
