// The forecast lab's input (schema townwise.lab-input/1): what the job fetches from the callback, built here from one
// location's stored days, its notes and scheduled business rules, the town calendar and the current published run. Outputs
// only the facts the model reads: guests per day, the term and week of term, town event groups, and three flags from the
// notes and rules. Never a note's detail, a rule's text, a calendar entry's title, a holiday (the lab computes holidays
// from the dates) or any name. labInputOf is pure; buildLabInput reads the stores under the calibration's scope. Nothing
// here logs.
import { z } from 'zod';

import type { OrgScope } from '../access/policy.ts';
import { isClosure, noteCovers } from '../agent/questions.ts';
import type { TownwiseContext } from '../app.ts';
import { closureOf, typicalByDate } from '../closed-days.ts';
import { daysBetween, isoDate, utcDay } from '../dates.ts';
import { scheduledRules, type ScheduledRule } from '../forecasts/adjust.ts';
import { eachDay } from '../forecasts/file.ts';
import { termEntries } from '../people-in-town/term.ts';
import type { CalibrationRecord } from '../stores/calibrations.ts';
import type { ForecastRow, ForecastRunRecord } from '../stores/forecasts.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord } from '../stores/notes.ts';
import type { SalesDay } from '../stores/sales-days.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { townEvents } from '../town-calendar.ts';

export const LAB_INPUT_SCHEMA = 'townwise.lab-input/1';
/** Days the lab forecasts after the last day with guests (the run's window). */
export const HORIZON_DAYS = 182;
/** The event a calendar entry with no group stands for. */
export const ONE_OFF = 'one_off';
/** A calendar group, as a run file's reason refs allow it. */
const GROUP = /^[a-z0-9][a-z0-9:-]{0,119}$/;
/** How far before the first day the calendar is read, so a term already under way has its first day of classes. */
const TERM_LOOKBACK_DAYS = 180;

const count = z.number().min(0);

const labDaySchema = z.strictObject({
  date: isoDate,
  guests: count.nullable(),
  term: z.enum(['fall', 'winter', 'spring', 'summer', 'interim']),
  weekOfTerm: z.number().int().min(-1),
  events: z.array(z.union([z.literal(ONE_OFF), z.string().regex(GROUP)])),
  closed: z.boolean(),
  privateEvent: z.boolean(),
  booked: z.boolean(),
});

const championSchema = z.strictObject({
  runId: z.string().min(1),
  dataThrough: isoDate,
  days: z.array(z.strictObject({
    date: isoDate,
    status: z.enum(['open', 'closed', 'booked']),
    low: count.nullable(),
    mid: count.nullable(),
    high: count.nullable(),
  })),
  weeks: z.array(z.strictObject({
    from: isoDate, to: isoDate, openDays: z.number().int().min(0).max(7), low: count, mid: count, high: count,
  })),
});

/**
 * The Contracts shape (plan, "LabInput"); the lab's schema.validate_input checks the same on its side, and
 * lab-input.test.ts's golden (modeling/lab/tests/golden/api-input.json) holds the two together.
 */
export const labInputSchema = z.strictObject({
  schema: z.literal(LAB_INPUT_SCHEMA),
  calibrationId: z.string().regex(/^[0-9a-f]{24}$/),
  metric: z.literal('guests'),
  today: isoDate,
  dataThrough: isoDate,
  horizonDays: z.literal(HORIZON_DAYS),
  regimeStart: isoDate.nullable(),
  days: z.array(labDaySchema).min(1),
  champion: championSchema.nullable(),
}).refine((input) => input.dataThrough <= input.today, { path: ['today'], message: 'dataThrough is after today' });

export type LabInput = z.infer<typeof labInputSchema>;
export type LabDay = LabInput['days'][number];
type LabChampion = z.infer<typeof championSchema>;

function plusDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

/**
 * The first and the last day with guests above zero on or before `today` (the town's date), or null with none: the lab
 * trains on no other span. A day after today (an upload may run a day ahead of the town's clock) is not history yet.
 */
export function guestSpan(days: readonly SalesDay[], today: string): { first: string; last: string } | null {
  let first: string | null = null;
  let last: string | null = null;
  for (const day of days) {
    if (day.guests === null || day.guests <= 0 || day.date > today) continue;
    if (first === null || day.date < first) first = day.date;
    if (last === null || day.date > last) last = day.date;
  }
  return first === null || last === null ? null : { first, last };
}

/**
 * The term and week of term of every day in `dates`, as the notebook builds them (section 1): a term runs from its
 * first day of classes to the end of its finals (or of its classes when its finals are unknown), and the week counts
 * whole weeks from the first day of classes. Any other day is interim, week -1.
 */
function termsOf(townId: string | null, dates: readonly string[]): Map<string, { term: LabDay['term']; weekOfTerm: number }> {
  const out = new Map<string, { term: LabDay['term']; weekOfTerm: number }>();
  const [from] = dates;
  const to = dates.at(-1);
  if (from === undefined || to === undefined) return out;
  const entries = termEntries(townEvents(townId, { from: plusDays(from, -TERM_LOOKBACK_DAYS), to }));
  const classes = entries.filter((entry) => entry.part === 'classes');
  classes.forEach((entry, index) => {
    const next = classes[index + 1];
    const finals = entries.filter((other) => other.part === 'finals' && other.season === entry.season && other.start >= entry.start
      && (next === undefined || other.start < next.start));
    const end = finals.reduce((max, other) => (other.end > max ? other.end : max), entry.end);
    for (const date of dates) {
      if (date >= entry.start && date <= end) out.set(date, { term: entry.season, weekOfTerm: Math.floor(daysBetween(entry.start, date) / 7) });
    }
  });
  return out;
}

/** The sorted town event groups covering each day; an event with no group is one_off. Holidays and terms are not events. */
function eventsOf(townId: string | null, from: string, to: string): Map<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const event of townEvents(townId, { from, to })) {
    if (event.scope !== 'town' || event.kind === 'term') continue;
    const group = event.group ?? ONE_OFF;
    if (group !== ONE_OFF && !GROUP.test(group)) continue;
    for (const date of eachDay(event.start > from ? event.start : from, event.end < to ? event.end : to)) {
      const set = groups.get(date) ?? new Set<string>();
      set.add(group);
      groups.set(date, set);
    }
  }
  return new Map([...groups].map(([date, set]) => [date, [...set].sort()]));
}

function championOf(champion: { run: ForecastRunRecord; rows: readonly ForecastRow[] }): LabChampion {
  const days: LabChampion['days'] = [];
  const weeks: LabChampion['weeks'] = [];
  for (const row of champion.rows) {
    if (row.span === 'day' && row.status !== null) {
      days.push({ date: row.from, status: row.status, low: row.low, mid: row.mid, high: row.high });
    } else if (row.span === 'week' && row.openDays !== null && row.low !== null && row.mid !== null && row.high !== null) {
      weeks.push({ from: row.from, to: row.to, openDays: row.openDays, low: row.low, mid: row.mid, high: row.high });
    }
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  weeks.sort((a, b) => (a.from < b.from ? -1 : 1));
  return { runId: champion.run.id, dataThrough: champion.run.dataThrough, days, weeks };
}

/** A note or a rule's schedule, as the flags read it. */
type Flagged = Pick<NoteRecord, 'kind' | 'startDate' | 'weekdays' | 'effect' | 'expectedGuests'> & { readonly endDate: string | null };

/** A private event the forecast read applies itself (adjust.ts): a buyout books the day, a counted party adds its guests. */
function countedOnRead(note: Flagged): boolean {
  return note.effect === 'closed' || (note.effect === 'more_guests' && note.expectedGuests !== null);
}

/**
 * The input for `calibration`, or null when the location has no day with guests by `today`. Days run from the first day
 * with guests to the last one on or before today (dataThrough) plus 182 days, with no gaps; guests are null after
 * dataThrough and on days with no row.
 * Notes, on history days (to dataThrough, for training): a private event sets privateEvent, and with effect closed also
 * booked (a buyout); any other closure note, or note with effect closed, sets closed. After dataThrough the forecast read
 * applies closures, buyouts and private events with more guests and a guest count itself (forecasts/adjust.ts, spec
 * 14.5), so closed and booked are false and those private events don't set privateEvent: a run never bakes in a status
 * or a lift that editing or deleting the note could not undo, and never counts a party twice. Closures the model learns
 * (weekdays, holidays) still come from the lab.
 * A business rule's schedule (D31) sets the flags exactly as a note with the same fields does, on history and future
 * days alike, and its more or fewer guests say a near-empty day was open as a note's do.
 * A likely-closed history day (spec D32, ../closed-days.ts: guests under a tenth of its weekday's typical guests, and no
 * note saying more or fewer guests) is closed with null guests. The lab trains only on days with guests that are not
 * closed, and its closed_weekdays and closed_holidays read guests, not the flag, so a null count is what makes them
 * treat the day as one without guests, as they already treat an all-zero day (guests 0).
 */
export function labInputOf(args: {
  calibration: Pick<CalibrationRecord, 'id' | 'regimeStart'>;
  location: Pick<LocationRecord, 'town'>;
  days: readonly SalesDay[];
  notes: readonly NoteRecord[];
  /** The location's business rules with a schedule. */
  rules: readonly ScheduledRule[];
  today: string;
  champion: { run: ForecastRunRecord; rows: readonly ForecastRow[] } | null;
}): LabInput | null {
  const span = guestSpan(args.days, args.today);
  if (span === null) return null;
  const last = plusDays(span.last, HORIZON_DAYS);
  const dates = eachDay(span.first, last);
  const { townId } = args.location.town;
  const rows = new Map(args.days.map((day) => [day.date, day]));
  const typical = typicalByDate(args.days);
  const terms = termsOf(townId, dates);
  const events = eventsOf(townId, span.first, last);
  const flagged: Flagged[] = [...args.notes, ...args.rules.map((rule) => rule.schedule)];
  const privateEvents = flagged.filter((note) => note.kind === 'private_event');
  const closures = flagged.filter((note) => note.kind !== 'private_event' && isClosure(note));
  const days = dates.map((date): LabDay => {
    const term = terms.get(date) ?? { term: 'interim', weekOfTerm: -1 };
    const privates = privateEvents.filter((note) => noteCovers(note, date));
    const history = date <= span.last;
    const lifted = history ? privates : privates.filter((note) => !countedOnRead(note));
    const row = rows.get(date);
    const likelyClosed = history
      && closureOf(row, typical.get(date) ?? null, flagged.filter((note) => noteCovers(note, date))) === 'likely_closed';
    return {
      date,
      guests: history && !likelyClosed ? row?.guests ?? null : null,
      term: term.term,
      weekOfTerm: term.weekOfTerm,
      events: events.get(date) ?? [],
      closed: likelyClosed || (history && closures.some((note) => noteCovers(note, date))),
      privateEvent: lifted.length > 0,
      booked: history && privates.some((note) => note.effect === 'closed'),
    };
  });
  return {
    schema: LAB_INPUT_SCHEMA,
    calibrationId: args.calibration.id,
    metric: 'guests',
    today: args.today,
    dataThrough: span.last,
    horizonDays: HORIZON_DAYS,
    regimeStart: args.calibration.regimeStart,
    days,
    champion: args.champion === null ? null : championOf(args.champion),
  };
}

/**
 * The input for a live calibration, read under its organization's scope: the location's stored days, notes and
 * scheduled business rules, the town's local date, and the run that was current when it started. Null when the location
 * or its history is gone.
 */
export async function buildLabInput(ctx: TownwiseContext, scope: OrgScope, calibration: CalibrationRecord): Promise<LabInput | null> {
  const { stores } = ctx;
  const location = await stores.locations.find(scope, calibration.locationId);
  if (location === null) return null;
  const coverage = await stores.salesDays.coverage(scope, location.id);
  if (coverage.firstDate === null || coverage.lastDate === null) return null;
  const [days, notes, scheduled] = await Promise.all([
    stores.salesDays.days(scope, location.id, { from: coverage.firstDate, to: coverage.lastDate }),
    stores.notes.list(scope, location.id),
    stores.businessRules.scheduled(scope, location.id),
  ]);
  const run = calibration.championRunId === null ? null : await stores.forecasts.find(scope, calibration.championRunId);
  const champion = run === null ? null : { run, rows: await stores.forecasts.rows(scope, location.id, [run.id]) };
  const today = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
  return labInputOf({ calibration, location, days, notes, rules: scheduledRules(scheduled), today, champion });
}
