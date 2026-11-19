// The forecast lab's input (schema townwise.lab-input/3, D42 and D52): what the job fetches from the callback, built here from one
// location's stored days, its notes and scheduled business rules, the town calendar and the current published run. Outputs
// only the facts the lab reads: guests per day, the term and week of term, town event groups, three flags from the notes
// and rules, the town calendar's entries (id, group, kind, dates and confidence, which the baseline engine reads its
// holidays and events from) and the current run's engine and recorded weekday bias. Never a note's detail, a rule's text, a calendar entry's title,
// URL or source, or any name. labInputOf is pure; buildLabInput reads the stores under the calibration's scope. The lab
// accepts version 3 only (D52: 400 future days and termsThrough), so the two move together. Nothing here logs. D58
// (learn-from-calendar-bookings): the flags
// also read the confirmed booking labels of the location's file calendars, on history days only, as dates and label
// (never a title or uid), with no change to the schema, the lab or LAB_MODEL_VERSION.
import { z } from 'zod';

import type { OrgScope } from '../access/policy.ts';
import { noteCovers } from '../agent/questions.ts';
import type { TownwiseContext } from '../app.ts';
import { closingRules, closureOf, isClosure, trustedGuestDays, typicalByDate } from '../closed-days.ts';
import { daysBetween, isoDate, utcDay } from '../dates.ts';
import { flagsAfterData, ownerBeatsAgent, scheduledRules, type ScheduledRule } from '../forecasts/adjust.ts';
import { canonicalSha256, eachDay } from '../forecasts/file.ts';
import { engineOf } from '../forecasts/reader.ts';
import { termEntries } from '../people-in-town/term.ts';
import type { CalibrationRecord } from '../stores/calibrations.ts';
import type { ForecastRow, ForecastRunRecord } from '../stores/forecasts.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord } from '../stores/notes.ts';
import type { ConfirmedBooking } from '../stores/owner-calendars.ts';
import type { SalesDay } from '../stores/sales-days.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { townCalendarCovers, townEvents } from '../town-calendar.ts';
import { scorecardSchema, type Metrics } from './scorecard.ts';

export const LAB_INPUT_SCHEMA = 'townwise.lab-input/3';
/**
 * The lab's model version (modeling/lab/townwise_lab/version.py's MODEL_VERSION; lab-contract.test.ts holds the two
 * equal). The weekly refresh's fingerprint includes it (D42), so a bump refits every location once.
 */
export const LAB_MODEL_VERSION = 'v11';
/**
 * Days the input carries after the last day with guests (D52): the furthest a run reaches, its outlook capped at 400
 * days after the last day of sales (the lab's forecast.HORIZON_DAYS).
 */
export const HORIZON_DAYS = 400;
/** The event a calendar entry with no group stands for. */
export const ONE_OFF = 'one_off';
/** A calendar group, as a run file's reason refs allow it. */
const GROUP = /^[a-z0-9][a-z0-9:-]{0,119}$/;
/** A calendar entry's id ('us:thanksgiving:2026', 'hanover-nh:2026-11-17:fall-term-classes-end'), as the lab allows it. */
const ENTRY_ID = /^[a-z0-9][a-z0-9:-]{0,199}$/;
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

/** A town calendar entry as the lab reads it: never its title, URL or source label. */
const calendarEntrySchema = z.strictObject({
  id: z.string().regex(ENTRY_ID),
  group: z.string().regex(GROUP).nullable(),
  kind: z.enum(['event', 'holiday', 'term', 'season']),
  start: isoDate,
  end: isoDate,
  confidence: z.enum(['high', 'medium', 'low']).nullable(),
});

const championSchema = z.strictObject({
  runId: z.string().min(1),
  /** The engine that made the current run (D42): the lab keeps it unless the other is 0.5 points better. */
  engine: z.enum(['model', 'baseline']),
  /**
   * The current run's recorded backtest weekdayBiasMeanAbs (its calibration's scorecard), null for an imported run or
   * one whose scorecard is gone: the gate holds a model draft more than GATE.weekdayBiasAllowance over it
   * (weekday_bias_worse), so the lab switches to the model only within it.
   */
  recordedWeekdayBiasMeanAbs: z.number().min(0).nullable(),
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
  /** The last day of the town's last researched term entry, classes or finals, or null with none (D52). */
  termsThrough: isoDate.nullable(),
  regimeStart: isoDate.nullable(),
  days: z.array(labDaySchema).min(1),
  calendar: z.array(calendarEntrySchema),
  champion: championSchema.nullable(),
}).refine((input) => input.dataThrough <= input.today, { path: ['today'], message: 'dataThrough is after today' });

export type LabInput = z.infer<typeof labInputSchema>;

/** The input's keys the fingerprint leaves out: the calibration's own id, its date and the run it is compared with. */
const NOT_FINGERPRINTED: ReadonlySet<string> = new Set(['calibrationId', 'today', 'champion']);

/**
 * The fingerprint the weekly refresh compares (D42, `dataSha256`): the sha256 of the canonical JSON of the input
 * without calibrationId, today and champion (so its schema version, days, flags from notes and rules, calendar and
 * pattern change date), together with the lab's model version, so a change to the lab's model refits every location once.
 */
export function labInputFingerprint(input: LabInput, modelVersion: string = LAB_MODEL_VERSION): string {
  const data = Object.fromEntries(Object.entries(input).filter(([key]) => !NOT_FINGERPRINTED.has(key)));
  return canonicalSha256({ modelVersion, input: data });
}
export type LabDay = LabInput['days'][number];
type LabChampion = z.infer<typeof championSchema>;
type LabCalendarEntry = z.infer<typeof calendarEntrySchema>;

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

/**
 * The last day of the town's last researched term entry, classes or finals, over all its years, or null for a town with
 * none (D52 decision 8): the model reads a day no term covers as a break, so its outlook stops there.
 */
export function termsThroughOf(townId: string | null): string | null {
  const covers = townCalendarCovers(townId);
  if (covers === null) return null;
  return termEntries(townEvents(townId, covers)).reduce<string | null>((last, entry) => (last === null || entry.end > last ? entry.end : last), null);
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

/**
 * Every town calendar entry overlapping `from` to `to` (holidays, terms, seasons and events, in townEvents' order), as
 * ids, groups, kinds, dates and confidence only. An id or group the lab's pattern would refuse is left out.
 */
function calendarOf(townId: string | null, from: string, to: string): LabCalendarEntry[] {
  return townEvents(townId, { from, to })
    .filter((event) => ENTRY_ID.test(event.id) && (event.group === null || GROUP.test(event.group)))
    .map((event) => ({ id: event.id, group: event.group, kind: event.kind, start: event.start, end: event.end, confidence: event.confidence }));
}

/** The current run as the input names it: its rows and its recorded backtest's weekday bias (null without one). */
interface ChampionArgs { run: ForecastRunRecord; rows: readonly ForecastRow[]; recordedWeekdayBiasMeanAbs: number | null }

function championOf(champion: ChampionArgs): LabChampion {
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
  return {
    runId: champion.run.id, engine: engineOf(champion.run.model.family), recordedWeekdayBiasMeanAbs: champion.recordedWeekdayBiasMeanAbs,
    dataThrough: champion.run.dataThrough, days, weeks,
  };
}

/** A note or a rule's schedule, as the flags read it. */
type Flagged = Pick<NoteRecord, 'kind' | 'startDate' | 'weekdays' | 'effect' | 'expectedGuests'> & { readonly endDate: string | null };

/** A counted party: a private event with more guests and a guest count, whose guests the forecast read adds (adjust.ts). */
function isParty(note: Flagged): boolean {
  return note.kind === 'private_event' && note.effect === 'more_guests' && note.expectedGuests !== null;
}

/**
 * The input for `calibration`, or null when the location has no day with guests by `today`. Days run from the first day
 * with guests to the last one on or before today (dataThrough) plus 400 days (D52), with no gaps; guests are null after
 * dataThrough and on days with no row. termsThrough is the town's last researched term day (termsThroughOf).
 * Notes, on history days (to dataThrough, for training): a private event sets privateEvent, and with effect closed also
 * booked (a buyout); any other closure note, or note with effect closed, sets closed. A counted party (a private event
 * with more guests and a guest count) is the exception: the forecast read adds its guests on every day it covers, so on
 * a history day it sets no privateEvent and the day's guests go out less its guest count (never below 0). Training then
 * sees the day's base demand and the read adds the party back, so a recurring party ("40 more guests every Friday") is
 * never counted twice through a privateEvent flag collinear with its weekday. [CONFIRM: on a history day a counted
 * party's guests are taken off the day's guests and set no privateEvent] After dataThrough the forecast read applies
 * closures, buyouts and counted parties itself (forecasts/adjust.ts, spec 14.5), so closed and booked are false and
 * those private events don't set privateEvent: a run never bakes in a status or a lift that editing or deleting the
 * note could not undo, and never counts a party twice. Closures the model learns (weekdays, holidays) still come from
 * the lab.
 * A business rule's schedule (D31) sets the flags as a note with the same fields does, on history and future days
 * alike, and its more or fewer guests say a near-empty day was open as a note's do, but its closure and buyout hold
 * only as ../closed-days.ts says: never over a covering note that decides the day (a one-day opening or party note
 * beats a standing rule), and on a history day before today a closure only when the day had no guests or guests under
 * the likely-closed line, so real recorded guests are never dropped from training by a standing rule.
 * A likely-closed history day (spec D32, ../closed-days.ts: before today, guests under a tenth of its weekday's typical
 * guests, and no note or schedule saying more or fewer guests) is closed with null guests; today's row, which may be
 * partial, never is. The lab trains only on days with guests that are not closed, and its closed_weekdays and
 * closed_holidays read guests, not the flag, so a null count is what makes them treat the day as one without guests, as
 * they already treat an all-zero day (guests 0).
 * A history day whose guest count a note marks wrong (D67, ../closed-days.ts trustedGuestDays) goes out with null guests
 * and not closed, so the lab never trains on it, and its count is in no typical guests; dataThrough still reads the
 * stored days, so a marked last day stays dataThrough and its run still saw that day's upload.
 * Confirmed booking labels (D58, `bookings`: a confirmed file calendar's buyout and party events, dates and label only),
 * on a history day only and only where no private-event or closure note covers the day (the note decides, so a counted
 * party is never counted twice): a buyout sets booked, so training drops the day, and a party sets privateEvent. They
 * never change closed, the likely-closed test, a rule's closure or the guests sent, so a machine-sorted label never
 * reopens a closed day or keeps a near-empty day's guests. After dataThrough they set nothing: an upcoming booking reaches
 * the forecast as the linked note confirming made, which editing can undo. [CONFIRM: a confirmed buyout label books a past
 * day and a party label marks it a private event, unless a note on the day decides] [CONFIRM: labels never change a day's
 * closed or likely-closed status or its guests]
 * Owner beats agent (D59): on any day, a note a person made that decides the day sets aside every TownwiseAI note
 * covering it (forecasts/adjust.ts ownerBeatsAgent) before the flags are read. [CONFIRM: a note a person made beats a
 * TownwiseAI note on the same day]
 */
export function labInputOf(args: {
  calibration: Pick<CalibrationRecord, 'id' | 'regimeStart'>;
  location: Pick<LocationRecord, 'town'>;
  days: readonly SalesDay[];
  notes: readonly NoteRecord[];
  /** The location's business rules with a schedule. */
  rules: readonly ScheduledRule[];
  today: string;
  champion: ChampionArgs | null;
  /** D58: the confirmed buyouts and parties of the location's file calendars; none when left out. */
  bookings?: readonly ConfirmedBooking[];
}): LabInput | null {
  const span = guestSpan(args.days, args.today);
  if (span === null) return null;
  const last = plusDays(span.last, HORIZON_DAYS);
  const dates = eachDay(span.first, last);
  const { townId } = args.location.town;
  // D67: a day whose guest count is marked wrong goes out with no guest count, and its count feeds no typical guests;
  // the span reads the stored days, so a marked last day stays dataThrough.
  const trusted = trustedGuestDays(args.days, args.notes);
  const rows = new Map(trusted.map((day) => [day.date, day]));
  const typical = typicalByDate(trusted);
  const terms = termsOf(townId, dates);
  const events = eventsOf(townId, span.first, last);
  const schedules: Flagged[] = args.rules.map((rule) => rule.schedule);
  const bookings = args.bookings ?? [];
  const days = dates.map((date): LabDay => {
    const term = terms.get(date) ?? { term: 'interim', weekOfTerm: -1 };
    const history = date <= span.last;
    const past = date < args.today;
    const row = rows.get(date);
    const typicalOn = typical.get(date) ?? null;
    // D59: a person's note that decides the day sets aside TownwiseAI's notes on it, as the forecast read does.
    const notes: Flagged[] = ownerBeatsAgent(args.notes.filter((note) => noteCovers(note, date))).kept;
    const rules = schedules.filter((schedule) => noteCovers(schedule, date));
    // A rule's closure or buyout only where it holds (closed-days.ts); its other fields always count.
    const holding = closingRules(rules, notes, row, typicalOn, past);
    const covering = [...notes, ...rules.filter((rule) => !isClosure(rule) || holding.includes(rule))];
    const privates = covering.filter((entry) => entry.kind === 'private_event');
    // After dataThrough, flagsAfterData (adjust.ts) is the one rule, which the forecast read also asks of a past day (D49).
    const lifted = privates.filter((entry) => (history ? !isParty(entry) : flagsAfterData(entry)));
    const party = history ? privates.filter(isParty).reduce((sum, entry) => sum + (entry.expectedGuests ?? 0), 0) : 0;
    const likelyClosed = history && closureOf(row, typicalOn, notes, { rules, past }) === 'likely_closed';
    const guests = history && !likelyClosed ? row?.guests ?? null : null;
    // D58: a confirmed label, on a history day no private-event or closure note decides.
    const labels = history && !notes.some((note) => note.kind === 'private_event' || isClosure(note))
      ? bookings.filter((booking) => date >= booking.startDate && date <= booking.endDate) : [];
    return {
      date,
      guests: guests === null ? null : Math.max(0, guests - party),
      term: term.term,
      weekOfTerm: term.weekOfTerm,
      events: events.get(date) ?? [],
      closed: likelyClosed || (history && covering.some((entry) => entry.kind !== 'private_event' && isClosure(entry))),
      privateEvent: lifted.length > 0 || labels.some((label) => label.booking === 'party'),
      booked: history && (privates.some((entry) => entry.effect === 'closed') || labels.some((label) => label.booking === 'buyout')),
    };
  });
  return {
    schema: LAB_INPUT_SCHEMA,
    calibrationId: args.calibration.id,
    metric: 'guests',
    today: args.today,
    dataThrough: span.last,
    horizonDays: HORIZON_DAYS,
    termsThrough: termsThroughOf(townId),
    regimeStart: args.calibration.regimeStart,
    days,
    calendar: calendarOf(townId, span.first, last),
    champion: args.champion === null ? null : championOf(args.champion),
  };
}

/**
 * The input for a live calibration, read under its organization's scope: the location's stored days, notes and
 * scheduled business rules, the confirmed booking labels over its history (D58), the town's local date, and the run that
 * was current when it started. Null when the location
 * or its history is gone. The weekly refresh (D42) builds one for a calibration not yet started, with no champion, to
 * compare its fingerprint.
 */
export async function buildLabInput(
  ctx: Pick<TownwiseContext, 'stores' | 'now'>, scope: OrgScope,
  calibration: Pick<CalibrationRecord, 'id' | 'locationId' | 'regimeStart' | 'championRunId'>,
): Promise<LabInput | null> {
  const { stores } = ctx;
  const location = await stores.locations.find(scope, calibration.locationId);
  if (location === null) return null;
  const coverage = await stores.salesDays.coverage(scope, location.id);
  if (coverage.firstDate === null || coverage.lastDate === null) return null;
  const range = { from: coverage.firstDate, to: coverage.lastDate };
  const [days, notes, scheduled, bookings] = await Promise.all([
    stores.salesDays.days(scope, location.id, range),
    stores.notes.list(scope, location.id),
    stores.businessRules.scheduled(scope, location.id),
    stores.ownerCalendars.bookingsBetween(scope, location.id, range),
  ]);
  const run = calibration.championRunId === null ? null : await stores.forecasts.find(scope, calibration.championRunId);
  const champion = run === null ? null : {
    run, rows: await stores.forecasts.rows(scope, location.id, [run.id]),
    recordedWeekdayBiasMeanAbs: (await recordedBacktest(ctx, scope, run))?.weekdayBiasMeanAbs ?? null,
  };
  const today = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
  return labInputOf({ calibration, location, days, notes, rules: scheduledRules(scheduled), today, champion, bookings });
}

/**
 * A lab run's recorded backtest metrics: its calibration's scorecard, or null for an imported run or one now gone. The
 * gate judges a draft against them (service.ts), and the input names the weekday bias for the lab to judge the same way.
 */
export async function recordedBacktest(ctx: Pick<TownwiseContext, 'stores'>, scope: OrgScope, run: ForecastRunRecord): Promise<Metrics | null> {
  if (run.lab === null) return null;
  const json = (await ctx.stores.calibrations.find(scope, run.lab.calibrationId))?.scorecardJson ?? null;
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = scorecardSchema.safeParse(raw);
  return parsed.success ? parsed.data.backtest.metrics : null;
}
