// The ForecastReader port (spec 14.4): a location's published forecast for a range of days, and its newest published
// run for the model card. Only published runs are read, so a draft, an unfinished import or a withdrawn run never
// reaches an owner, view-as or TownwiseAI. For each date it uses the newest published run whose model saw no sales on
// or after that date (dataThrough before it), so no forecast is ever shown for a day its model saw; of those, a day
// takes the newest made by it before a newer one made after it (D49), and is compared only with a run made by it. Weeks come only
// from a run that supplied every day of the week; they are the run's own week rows, never sums of days. Past days
// carry the stored guests and whether they landed in the range. Live accuracy is scored per run, over the passed days
// that run supplied, so one run is never credited with another's hits and misses; a closed or likely-closed day (spec
// D32, ../closed-days.ts) is a closure, not a miss, and is left out. [CONFIRM: live accuracy leaves out closed and
// likely-closed days] Numbers are raw, as stored; callers round for display. From the town's today on, the location's
// notes and its business rules with a schedule (D31) adjust each day on read (adjust.ts); past days and run rows stay
// as the model made them. A week's low, mid and high shift by each of its days' adjusted middle less the model's (a
// newly closed or booked day takes its model middle off, notes' and rules' guests add; never below 0), and its openDays
// by the days opened less the days closed; a week is left out only when a changed day has no model middle to take off.
// [CONFIRM: a week's range shifted by its days' note and rule changes] From today on, each run reason also says whether
// it usually brings more or fewer guests (effects.ts), from the same reads: the stored days, read once, reach back over
// the 52 weeks the effects need when the range reaches today and over the 8 weeks before the first scored day that
// likely closed reads, and one read of the notes and rules marks the closed days for the effects and the accuracy. The
// town calendar's term entries are made once for the labels and the effects. A read also scores its own days, each
// against the run chosen for it, as the window's accuracy (D42). Rows are read by range (D42, about 52 weekly runs a
// year): every run's rows over the days the answer needs, which are the read's days and a week either side, and every
// past day of each run that could supply one of them, for its live accuracy; the model card's, over the newest run's
// days. It logs nothing and stores nothing.
import type { OrgScope } from '../access/policy.ts';
import { noteCovers } from '../agent/questions.ts';
import { closureOf, TYPICAL_LOOKBACK_DAYS, typicalByDate } from '../closed-days.ts';
import { daysBetween, utcDay } from '../dates.ts';
import type { BusinessRuleStore } from '../stores/business-rules.ts';
import type { ForecastRow, ForecastRunRecord, ForecastStore } from '../stores/forecasts.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord, NoteStore } from '../stores/notes.ts';
import type { SalesDayStore } from '../stores/sales-days.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import { adjustDay, orderedReasons, scheduledRules, type AdjustedDay, type ModelDay, type ScheduledRule } from './adjust.ts';
import { effectHistory, reasonEffects } from './effects.ts';
import { eachDay, type DayStatus } from './file.ts';
import { noteReasonView, reasonViews, ruleReasonView, townCalendarOf, townTermEntries, type ReasonView } from './reasons.ts';
import { inRangeOf, liveAccuracy, madeAfter, scoredDay, weekActual, type LiveAccuracy, type ScoredDay } from './score.ts';

/** A forecast read covers at most this many days, both ends included: today and the next 91 (D42), as people in town. */
export const MAX_FORECAST_RANGE_DAYS = 92;

/** Which engine made a run (D42): the lab's baseline for family seasonal_baseline, the trained model otherwise. */
export type ForecastEngine = 'model' | 'baseline';

export function engineOf(family: string): ForecastEngine {
  return family === 'seasonal_baseline' ? 'baseline' : 'model';
}

export interface ForecastRunView {
  id: string;
  metric: 'guests';
  model: { family: string; version: string; label: string };
  /** Derived from the family, never stored. */
  engine: ForecastEngine;
  trainingSource: ForecastRunRecord['trainingSource'];
  trainedFrom: string;
  dataThrough: string;
  madeAt: string;
  /** Registered in Townwise's research repository before its outcomes existed. */
  frozen: boolean;
  interval: { level: 0.8; widened: boolean };
  backtest: ForecastRunRecord['backtest'];
}

/** A run in a forecast read, with its own live accuracy. */
export interface ForecastWindowRun extends ForecastRunView {
  /** Over the passed days this run supplied (and no newer run did), misses included; null under 5 scored days. */
  live: LiveAccuracy | null;
}

export interface ForecastDayView {
  date: string;
  weekday: Weekday;
  /** The day as the location's notes and scheduled rules leave it (spec 14.5); `model` is the run's own. */
  status: DayStatus;
  low: number | null;
  mid: number | null;
  high: number | null;
  baseline: number | null;
  /**
   * Rules and notes that changed the day, then the run's reasons, then the other rules and notes (at most 6 rules and 6
   * notes). From today on a run reason carries its effect (effects.ts); before today every effect is null.
   */
  reasons: ReasonView[];
  /** The run's own status and figures, equal to the day's when no note or rule changed it. */
  model: ModelDay;
  /** Guests the notes and rules add to an open day, or a buyout's party on a booked day; 0 when none. */
  noteGuests: number;
  /** Note reasons past the first 6; they still count in the figures. */
  moreNotes: number;
  /** Rule reasons past the first 6; they still count in the figures. */
  moreRules: number;
  runId: string;
  /** The run's made-at date. */
  madeAt: string;
  /** Made on or after the day, still without seeing its sales (its model's data ends before it). */
  madeAfterDay: boolean;
  /** The stored guests for a day before today; null otherwise. */
  actual: number | null;
  /**
   * The actual within the model's [low, high]; null when either is missing, the model did not forecast the day open, or
   * the run was made after the day (D49).
   */
  inRange: boolean | null;
  /**
   * Counted in the window's accuracy (score.ts scoredDay): open in the model, not closed or likely closed, with guests,
   * from a run made by the day.
   */
  scored: boolean;
}

export interface ForecastWeekView {
  from: string;
  to: string;
  /** The run's open days, plus the days notes and rules opened, less the ones they closed or booked. */
  openDays: number;
  low: number;
  mid: number;
  high: number;
  runId: string;
  madeAt: string;
  /** The week's stored guests once every open day has them and none was booked; null otherwise. */
  actual: number | null;
  inRange: boolean | null;
  /** Guests notes and rules add on the week's open days, already in low, mid and high. */
  noteGuests: number;
}

/** The earliest and the latest of some YYYY-MM-DD dates, missing ones skipped; undefined with none. */
const firstOf = (dates: readonly (string | undefined)[]): string | undefined => dates.filter((date) => date !== undefined).sort()[0];
const lastOf = (dates: readonly (string | undefined)[]): string | undefined => dates.filter((date) => date !== undefined).sort().at(-1);

export interface ForecastWindow {
  /** False when no published run covers any day of the range. */
  available: boolean;
  reason: 'no_published_forecast' | 'not_covered' | null;
  /** The runs the days came from, newest first, each with its own live accuracy. */
  runs: ForecastWindowRun[];
  days: ForecastDayView[];
  weeks: ForecastWeekView[];
  /** Live accuracy over the read's own days, each from the run chosen for it; null under 5 scored days. */
  accuracy: LiveAccuracy | null;
  notCovered: { from: string; to: string }[];
}

export interface ForecastReader {
  /** `range`: inclusive YYYY-MM-DD days, at most 92 (callers check). `today`: the first day with no actual yet. */
  window(scope: OrgScope, location: LocationRecord, range: { from: string; to: string }, today: string): Promise<ForecastWindow>;
  /** The newest published run (by dataThrough) and its own live accuracy, for the model card; null when none is published. */
  latest(scope: OrgScope, locationId: string, today: string): Promise<{ run: ForecastRunView; live: LiveAccuracy | null } | null>;
}

function labelOf(model: ForecastRunRecord['model']): string {
  return engineOf(model.family) === 'baseline'
    ? 'Townwise\'s baseline from your recent weeks and the town calendar'
    : `Townwise demand model ${model.version}`;
}

export function runView(run: ForecastRunRecord): ForecastRunView {
  return {
    id: run.id,
    metric: run.metric,
    model: { family: run.model.family, version: run.model.version, label: labelOf(run.model) },
    engine: engineOf(run.model.family),
    trainingSource: run.trainingSource,
    trainedFrom: run.trainedFrom,
    dataThrough: run.dataThrough,
    madeAt: run.madeAt,
    frozen: run.frozen,
    interval: run.interval,
    backtest: run.backtest,
  };
}

interface Chosen { readonly run: ForecastRunRecord; readonly row: ForecastRow }

/**
 * The day each date uses, from the published runs whose data ends before it (runs come newest first): the newest made
 * by the day, else the newest (D49, owner 2026-11-18: only a forecast made before a day happened is compared with it,
 * so a run made later never takes a past day from one made in time; it only fills a day no such run has). From today
 * on every run was made by the day, so this is the newest.
 */
function chooseDays(runs: readonly ForecastRunRecord[], rows: readonly ForecastRow[]): Map<string, Chosen> {
  const byRunDate = new Map(rows.filter((row) => row.span === 'day').map((row) => [`${row.runId}|${row.from}`, row]));
  const dates = [...new Set(rows.filter((row) => row.span === 'day').map((row) => row.from))].sort();
  const chosen = new Map<string, Chosen>();
  for (const date of dates) {
    const usable = runs.flatMap((run) => {
      const row = run.dataThrough < date ? byRunDate.get(`${run.id}|${date}`) : undefined;
      return row === undefined ? [] : [{ run, row }];
    });
    const pick = usable.find(({ run }) => !madeAfter(run, date)) ?? usable[0];
    if (pick !== undefined) chosen.set(date, pick);
  }
  return chosen;
}

/** `date` moved by `days`. */
function shifted(date: string, days: number): string {
  return utcDay(new Date(`${date}T00:00:00.000Z`), days);
}

/**
 * The rows a window read needs (D42): the days from 6 before `range` to 6 after it (its days and the weeks holding
 * them), and every day to yesterday of each run reaching into those, so each run used keeps its live accuracy over all
 * its own past days. Every run's rows over these days choose each date exactly as all of their rows would.
 */
function windowRows(runs: readonly ForecastRunRecord[], range: { from: string; to: string }, today: string): { from: string; to: string } {
  const from = shifted(range.from, -6);
  const to = shifted(range.to, 6);
  const yesterday = shifted(today, -1);
  const reaching = runs.filter((run) => run.range.from <= to && run.range.to >= from);
  return {
    from: firstOf([from, ...reaching.map((run) => run.range.from)]) ?? from,
    to: lastOf([to, ...reaching.map((run) => (run.range.to < yesterday ? run.range.to : yesterday))]) ?? to,
  };
}

function spans(dates: readonly string[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const date of dates) {
    const last = out.at(-1);
    if (last !== undefined && daysBetween(last.to, date) === 1) last.to = date;
    else out.push({ from: date, to: date });
  }
  return out;
}

export function createForecastReader(deps: {
  stores: {
    forecasts: ForecastStore; salesDays: Pick<SalesDayStore, 'days'>; notes: Pick<NoteStore, 'overlapping'>;
    businessRules: Pick<BusinessRuleStore, 'scheduled'>;
  };
}): ForecastReader {
  const { forecasts, salesDays, notes, businessRules } = deps.stores;

  /**
   * Every published run, every chosen day with its actual (before today), and each run's live accuracy over its own
   * days, closed and likely-closed days left out. The stored days are read once, from 8 weeks before the first chosen
   * day (its typical guests, D32), or from `reach.historyFrom` when that is earlier (the reason effects' history), to
   * yesterday; the notes once, over the chosen days before today and `reach.notes`; the scheduled rules once. None are
   * read when no run supplies a day.
   */
  async function load(
    scope: OrgScope, locationId: string, today: string,
    reach: {
      historyFrom?: string; notes?: { from: string; to: string };
      /** The days whose rows the answer needs (windowRows), from the published runs. */
      rows: (runs: readonly ForecastRunRecord[]) => { from: string; to: string } | null;
    },
  ) {
    const runs = await forecasts.published(scope, locationId);
    const span = reach.rows(runs);
    const rows = span === null ? [] : await forecasts.rows(scope, locationId, runs.map((run) => run.id), span);
    const chosen = chooseDays(runs, rows);
    const dates = [...chosen.keys()].sort();
    const [first] = dates;
    const yesterday = utcDay(new Date(`${today}T00:00:00.000Z`), -1);
    const from = first === undefined ? undefined : firstOf([utcDay(new Date(`${first}T00:00:00.000Z`), -TYPICAL_LOOKBACK_DAYS), reach.historyFrom]);
    // The notes the scored days need (the chosen days to yesterday), and the caller's.
    const notesFrom = firstOf([first, reach.notes?.from]);
    const notesTo = lastOf([dates.filter((date) => date <= yesterday).at(-1), reach.notes?.to]);
    const [stored, noted, scheduled] = await Promise.all([
      from !== undefined && from <= yesterday ? salesDays.days(scope, locationId, { from, to: yesterday }) : [],
      first === undefined || notesFrom === undefined || notesTo === undefined ? [] : notes.overlapping(scope, locationId, { from: notesFrom, to: notesTo }),
      first === undefined ? [] : businessRules.scheduled(scope, locationId),
    ]);
    const rules = scheduledRules(scheduled);
    const notesOn = (date: string): NoteRecord[] => noted.filter((note) => noteCovers(note, date));
    const rulesOn = (date: string): ScheduledRule[] => rules.filter((rule) => noteCovers(rule.schedule, date));
    const actuals = new Map<string, number>();
    for (const day of stored) {
      if (day.guests !== null) actuals.set(day.date, day.guests);
    }
    const storedOn = new Map(stored.map((day) => [day.date, day]));
    const typical = typicalByDate(stored);
    /** A past day that was closed or likely closed (D32): a closure, not a miss. */
    const closedOn = (date: string): boolean => date < today && closureOf(
      storedOn.get(date), typical.get(date) ?? null, notesOn(date), { rules: rulesOn(date).map((rule) => rule.schedule), past: true },
    ) !== null;
    const scored = (date: string, { run, row }: Chosen): ScoredDay => ({
      date, status: row.status ?? 'open', low: row.low, mid: row.mid, high: row.high, actual: actuals.get(date) ?? null, closed: closedOn(date),
      late: madeAfter(run, date),
    });
    const daysOf = new Map<string, ScoredDay[]>();
    for (const [date, pick] of chosen) daysOf.set(pick.run.id, [...(daysOf.get(pick.run.id) ?? []), scored(date, pick)]);
    const liveOf = (runId: string): LiveAccuracy | null => liveAccuracy(daysOf.get(runId) ?? []);
    return { runs, rows, chosen, actuals, scored, liveOf, stored, notesOn, rulesOn };
  }

  return {
    async window(scope, location, range, today) {
      // Effects are for days from today on, so a range wholly in the past reads no history for them.
      const history = range.to >= today ? effectHistory(today) : null;
      // One read of the notes, over the scored days, the range, a week reaching 6 days past either end and the effects' history.
      const at = (date: string, days: number): string => utcDay(new Date(`${date}T00:00:00.000Z`), days);
      const { runs, rows, chosen, actuals, scored, liveOf, stored, notesOn, rulesOn } = await load(scope, location.id, today, {
        ...(history === null ? {} : { historyFrom: history.readFrom }),
        notes: { from: firstOf([at(range.from, -6), history?.from]) ?? range.from, to: at(range.to, 6) },
        rows: (published) => (published.length === 0 ? null : windowRows(published, range, today)),
      });
      const dates = eachDay(range.from, range.to);
      if (runs.length === 0) {
        return { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], accuracy: null, notCovered: spans(dates) };
      }
      const entries = townTermEntries(location.town.townId);
      const calendarOn = townCalendarOf(location.town.townId, entries);
      const weekRows = rows.filter((row) => row.span === 'week' && row.from <= range.to && row.to >= range.from);
      // A history day a closure note or a rule's closure that holds covers is closed; one with more or fewer guests was open (D32).
      const effectOf = history === null ? undefined : reasonEffects({
        today, townId: location.town.townId, days: stored, termEntries: entries,
        covering: (date) => ({ notes: notesOn(date), rules: rulesOn(date).map((rule) => rule.schedule) }),
      });
      const modelOf = (row: ForecastRow): ModelDay => ({ status: row.status ?? 'open', low: row.low, mid: row.mid, high: row.high });
      const adjusted = (date: string, row: ForecastRow): AdjustedDay => adjustDay(date, today, modelOf(row), row.reasons, notesOn(date), rulesOn(date));
      const days: ForecastDayView[] = [];
      const scoredDays: ScoredDay[] = [];
      for (const date of dates) {
        const pick = chosen.get(date);
        if (pick === undefined) continue;
        const { run, row } = pick;
        const model = modelOf(row);
        const day = adjusted(date, row);
        const { reasons, moreNotes, moreRules } = orderedReasons(
          day, reasonViews(date, row.reasons, calendarOn(date), date >= today ? effectOf : undefined),
          (entry) => ('note' in entry ? noteReasonView(entry.note, entry.outcome) : ruleReasonView(entry.rule, entry.outcome)),
        );
        const actual = actuals.get(date) ?? null;
        const score = scored(date, pick);
        scoredDays.push(score);
        days.push({
          date, weekday: weekdayOf(date), status: day.status, low: day.low, mid: day.mid, high: day.high,
          baseline: day.status === model.status ? row.baseline : null, reasons, model, noteGuests: day.noteGuests, moreNotes, moreRules,
          runId: run.id, madeAt: run.madeAt, madeAfterDay: run.madeAt >= date,
          // A run made after the day is never compared with it (D49).
          actual, inRange: model.status === 'open' && !madeAfter(run, date) ? inRangeOf(actual, row.low, row.high) : null, scored: scoredDay(score),
        });
      }
      const weeks: ForecastWeekView[] = weekRows.flatMap((row): ForecastWeekView[] => {
        const weekDates = eachDay(row.from, row.to);
        const picks = weekDates.map((date) => chosen.get(date));
        if (picks.some((pick) => pick?.run.id !== row.runId)) return [];
        const run = picks[0]?.run;
        if (run === undefined || row.low === null || row.mid === null || row.high === null) return [];
        const actual = weekActual(picks.flatMap((pick, index) => (pick === undefined ? [] : [scored(weekDates[index] ?? '', pick)])));
        // The run's own week shifts by each day's adjusted middle less the model's: a day the model closed or booked adds
        // nothing to the run's week, so only a model-open day with no middle can't be taken off, and leaves the week out.
        const changes = picks.flatMap((pick, index) => (pick === undefined ? [] : [{ model: modelOf(pick.row), day: adjusted(weekDates[index] ?? '', pick.row) }]));
        const changed = ({ model, day }: (typeof changes)[number]): boolean => day.status !== model.status || day.mid !== model.mid;
        if (changes.some((change) => changed(change) && change.model.status === 'open' && change.model.mid === null)) return [];
        const shift = changes.reduce((sum, { model, day }) => sum + (day.mid ?? 0) - (model.status === 'open' ? model.mid ?? 0 : 0), 0);
        const opened = changes.filter(({ model, day }) => model.status !== 'open' && day.status === 'open').length;
        const closed = changes.filter(({ model, day }) => model.status === 'open' && day.status !== 'open').length;
        const noteGuests = changes.reduce((sum, { day }) => sum + (day.status === 'open' ? day.noteGuests : 0), 0);
        const shifted = (value: number): number => Math.max(0, value + shift);
        return [{
          from: row.from, to: row.to, openDays: Math.max(0, (row.openDays ?? 0) + opened - closed), low: shifted(row.low), mid: shifted(row.mid),
          high: shifted(row.high), runId: run.id, madeAt: run.madeAt, actual,
          // A week is compared only with a run made by its first day (D49).
          inRange: madeAfter(run, row.from) ? null : inRangeOf(actual, row.low, row.high), noteGuests,
        }];
      });
      const used = new Set(days.map((day) => day.runId));
      return {
        available: days.length > 0,
        reason: days.length > 0 ? null : 'not_covered',
        runs: runs.filter((run) => used.has(run.id)).map((run) => ({ ...runView(run), live: liveOf(run.id) })),
        days,
        weeks,
        accuracy: liveAccuracy(scoredDays),
        notCovered: spans(dates.filter((date) => !chosen.has(date))),
      };
    },
    async latest(scope, locationId, today) {
      // The newest run supplies every one of its own days, so its rows' days are all its live accuracy needs.
      const { runs, liveOf } = await load(scope, locationId, today, { rows: (published) => published[0]?.range ?? null });
      const [newest] = runs;
      return newest === undefined ? null : { run: runView(newest), live: liveOf(newest.id) };
    },
  };
}
