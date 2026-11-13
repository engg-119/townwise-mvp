// The ForecastReader port (spec 14.4): a location's published forecast for a range of days, and its newest published
// run for the model card. Only published runs are read, so a draft, an unfinished import or a withdrawn run never
// reaches an owner, view-as or TownwiseAI. For each date it uses the newest published run whose model saw no sales on
// or after that date (dataThrough before it), so no forecast is ever shown for a day its model saw. Weeks come only
// from a run that supplied every day of the week; they are the run's own week rows, never sums of days. Past days
// carry the stored guests and whether they landed in the range. Live accuracy is scored per run, over the passed days
// that run supplied, so one run is never credited with another's hits and misses. Numbers are raw, as stored; callers
// round for display. From the town's today on, the location's notes and its business rules with a schedule (D31) adjust
// each day on read (adjust.ts); past days, accuracy and run rows stay as the model made them. A week a note changed a day's status in is left out; any other
// week shifts by the guests notes add on its open days. It logs nothing and stores nothing.
import type { OrgScope } from '../access/policy.ts';
import { noteCovers } from '../agent/questions.ts';
import { daysBetween, utcDay } from '../dates.ts';
import type { BusinessRuleStore } from '../stores/business-rules.ts';
import type { ForecastRow, ForecastRunRecord, ForecastStore } from '../stores/forecasts.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteStore } from '../stores/notes.ts';
import type { SalesDayStore } from '../stores/sales-days.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import { adjustDay, orderedReasons, scheduledRules, type AdjustedDay, type ModelDay } from './adjust.ts';
import { eachDay, type DayStatus } from './file.ts';
import { noteReasonView, reasonViews, ruleReasonView, townCalendarOf, type ReasonView } from './reasons.ts';
import { inRangeOf, liveAccuracy, weekActual, type LiveAccuracy, type ScoredDay } from './score.ts';

/** A forecast read covers at most this many days, both ends included. */
export const MAX_FORECAST_RANGE_DAYS = 31;

export interface ForecastRunView {
  id: string;
  metric: 'guests';
  model: { family: string; version: string; label: string };
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
  /** Rules and notes that changed the day, then the run's reasons, then the other rules and notes (at most 6 notes in all). */
  reasons: ReasonView[];
  /** The run's own status and figures, equal to the day's when no note or rule changed it. */
  model: ModelDay;
  /** Guests the notes and rules add to an open day, or a buyout's party on a booked day; 0 when none. */
  noteGuests: number;
  /** Note reasons past the first 6; they still count in the figures. */
  moreNotes: number;
  runId: string;
  /** The run's made-at date. */
  madeAt: string;
  /** Made on or after the day, still without seeing its sales (its model's data ends before it). */
  madeAfterDay: boolean;
  /** The stored guests for a day before today; null otherwise. */
  actual: number | null;
  /** The actual within the model's [low, high]; null when either is missing or the model did not forecast the day open. */
  inRange: boolean | null;
}

export interface ForecastWeekView {
  from: string;
  to: string;
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

export interface ForecastWindow {
  /** False when no published run covers any day of the range. */
  available: boolean;
  reason: 'no_published_forecast' | 'not_covered' | null;
  /** The runs the days came from, newest first, each with its own live accuracy. */
  runs: ForecastWindowRun[];
  days: ForecastDayView[];
  weeks: ForecastWeekView[];
  notCovered: { from: string; to: string }[];
}

export interface ForecastReader {
  /** `range`: inclusive YYYY-MM-DD days, at most 31 (callers check). `today`: the first day with no actual yet. */
  window(scope: OrgScope, location: LocationRecord, range: { from: string; to: string }, today: string): Promise<ForecastWindow>;
  /** The newest published run (by dataThrough) and its own live accuracy, for the model card; null when none is published. */
  latest(scope: OrgScope, locationId: string, today: string): Promise<{ run: ForecastRunView; live: LiveAccuracy | null } | null>;
}

export function runView(run: ForecastRunRecord): ForecastRunView {
  return {
    id: run.id,
    metric: run.metric,
    model: { family: run.model.family, version: run.model.version, label: `Townwise demand model ${run.model.version}` },
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

/** The day each date uses: from the newest published run whose data ends before it (runs come newest first). */
function chooseDays(runs: readonly ForecastRunRecord[], rows: readonly ForecastRow[]): Map<string, Chosen> {
  const byRunDate = new Map(rows.filter((row) => row.span === 'day').map((row) => [`${row.runId}|${row.from}`, row]));
  const dates = [...new Set(rows.filter((row) => row.span === 'day').map((row) => row.from))].sort();
  const chosen = new Map<string, Chosen>();
  for (const date of dates) {
    for (const run of runs) {
      if (run.dataThrough >= date) continue;
      const row = byRunDate.get(`${run.id}|${date}`);
      if (row === undefined) continue;
      chosen.set(date, { run, row });
      break;
    }
  }
  return chosen;
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

  /** Every published run, every chosen day with its actual (before today), and each run's live accuracy over its own days. */
  async function load(scope: OrgScope, locationId: string, today: string) {
    const runs = await forecasts.published(scope, locationId);
    const rows = await forecasts.rows(scope, locationId, runs.map((run) => run.id));
    const chosen = chooseDays(runs, rows);
    const [first] = [...chosen.keys()].sort();
    const yesterday = utcDay(new Date(`${today}T00:00:00.000Z`), -1);
    const actuals = new Map<string, number>();
    if (first !== undefined && first <= yesterday) {
      for (const day of await salesDays.days(scope, locationId, { from: first, to: yesterday })) {
        if (day.guests !== null) actuals.set(day.date, day.guests);
      }
    }
    const scored = (date: string, row: ForecastRow): ScoredDay => ({
      date, status: row.status ?? 'open', low: row.low, mid: row.mid, high: row.high, actual: actuals.get(date) ?? null,
    });
    const daysOf = new Map<string, ScoredDay[]>();
    for (const [date, { run, row }] of chosen) daysOf.set(run.id, [...(daysOf.get(run.id) ?? []), scored(date, row)]);
    const liveOf = (runId: string): LiveAccuracy | null => liveAccuracy(daysOf.get(runId) ?? []);
    return { runs, rows, chosen, actuals, scored, liveOf };
  }

  return {
    async window(scope, location, range, today) {
      const { runs, rows, chosen, actuals, scored, liveOf } = await load(scope, location.id, today);
      const dates = eachDay(range.from, range.to);
      if (runs.length === 0) {
        return { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], notCovered: spans(dates) };
      }
      const calendarOn = townCalendarOf(location.town.townId);
      const weekRows = rows.filter((row) => row.span === 'week' && row.from <= range.to && row.to >= range.from);
      // One read of the notes, over the range and every week reaching past it, and one of the scheduled rules (at most 30).
      const [noted, scheduled] = await Promise.all([
        notes.overlapping(scope, location.id, {
          from: [range.from, ...weekRows.map((row) => row.from)].sort()[0] ?? range.from,
          to: [range.to, ...weekRows.map((row) => row.to)].sort().at(-1) ?? range.to,
        }),
        businessRules.scheduled(scope, location.id),
      ]);
      const rules = scheduledRules(scheduled);
      const modelOf = (row: ForecastRow): ModelDay => ({ status: row.status ?? 'open', low: row.low, mid: row.mid, high: row.high });
      const adjusted = (date: string, row: ForecastRow): AdjustedDay => adjustDay(
        date, today, modelOf(row), row.reasons, noted.filter((note) => noteCovers(note, date)),
        rules.filter((rule) => noteCovers(rule.schedule, date)),
      );
      const days: ForecastDayView[] = [];
      for (const date of dates) {
        const pick = chosen.get(date);
        if (pick === undefined) continue;
        const { run, row } = pick;
        const model = modelOf(row);
        const day = adjusted(date, row);
        const { reasons, moreNotes } = orderedReasons(
          day, reasonViews(date, row.reasons, calendarOn(date)),
          (entry) => ('note' in entry ? noteReasonView(entry.note, entry.outcome) : ruleReasonView(entry.rule, entry.outcome)),
        );
        const actual = actuals.get(date) ?? null;
        days.push({
          date, weekday: weekdayOf(date), status: day.status, low: day.low, mid: day.mid, high: day.high,
          baseline: day.status === model.status ? row.baseline : null, reasons, model, noteGuests: day.noteGuests, moreNotes,
          runId: run.id, madeAt: run.madeAt, madeAfterDay: run.madeAt >= date,
          actual, inRange: model.status === 'open' ? inRangeOf(actual, row.low, row.high) : null,
        });
      }
      const weeks: ForecastWeekView[] = weekRows.flatMap((row): ForecastWeekView[] => {
        const weekDates = eachDay(row.from, row.to);
        const picks = weekDates.map((date) => chosen.get(date));
        if (picks.some((pick) => pick?.run.id !== row.runId)) return [];
        const run = picks[0]?.run;
        if (run === undefined || row.low === null || row.mid === null || row.high === null) return [];
        const actual = weekActual(picks.flatMap((pick, index) => (pick === undefined ? [] : [scored(weekDates[index] ?? '', pick.row)])));
        // The run's week can't be re-summed honestly once a note or rule changes a day's status, and the reader never sums days.
        const noteDays = picks.flatMap((pick, index) => (pick === undefined ? [] : [{ model: pick.row.status ?? 'open', day: adjusted(weekDates[index] ?? '', pick.row) }]));
        if (noteDays.some(({ model, day }) => day.status !== model)) return [];
        const noteGuests = noteDays.reduce((sum, { day }) => sum + (day.status === 'open' ? day.noteGuests : 0), 0);
        return [{
          from: row.from, to: row.to, openDays: row.openDays ?? 0, low: row.low + noteGuests, mid: row.mid + noteGuests,
          high: row.high + noteGuests, runId: run.id, madeAt: run.madeAt, actual, inRange: inRangeOf(actual, row.low, row.high), noteGuests,
        }];
      });
      const used = new Set(days.map((day) => day.runId));
      return {
        available: days.length > 0,
        reason: days.length > 0 ? null : 'not_covered',
        runs: runs.filter((run) => used.has(run.id)).map((run) => ({ ...runView(run), live: liveOf(run.id) })),
        days,
        weeks,
        notCovered: spans(dates.filter((date) => !chosen.has(date))),
      };
    },
    async latest(scope, locationId, today) {
      const { runs, liveOf } = await load(scope, locationId, today);
      const [newest] = runs;
      return newest === undefined ? null : { run: runView(newest), live: liveOf(newest.id) };
    },
  };
}
