// The ForecastReader port (spec 14.4): a location's published forecast for a range of days, and its newest published
// run for the model card. Only published runs are read, so a draft, an unfinished import or a withdrawn run never
// reaches an owner, view-as or TownwiseAI. For each date it uses the newest published run whose model saw no sales on
// or after that date (dataThrough before it), so no forecast is ever shown for a day its model saw; of those, a day
// takes the newest made by it before a newer one made after it (D49). A past day is compared with its run, whenever the
// run was made, unless the run may have read a private event note or rule written once the day began (D49 as amended
// 2026-11-18: laterNote). Weeks come only
// from a run that supplied every day of the week; they are the run's own week rows, never sums of days. Past days
// carry the stored guests and whether they landed in the range. Live accuracy is scored per run, over the passed days
// that run supplied, so one run is never credited with another's hits and misses; a closed or likely-closed day (spec
// D32, ../closed-days.ts) is a closure, not a miss, and is left out. Numbers are raw, as stored; callers round for
// display. From the town's today on, the location's notes and its business rules with a schedule (D31) adjust each
// day on read (adjust.ts); past days and run rows stay as the model made them. A week's low, mid and high shift by
// each of its days' adjusted middle less the model's (a newly closed or booked day takes its model middle off, notes'
// and rules' guests add; never below 0), and its openDays by the days opened less the days closed; a week is left out
// only when a changed day has no model middle to take off. From today on, each run reason also says whether it
// usually brings more or fewer guests (effects.ts), from the same reads: the stored days, read once, reach back over
// the 52 weeks the effects need when the range reaches today and over the 8 weeks before the first scored day that
// likely closed reads, and one read of the notes and rules marks the closed days for the effects and the accuracy. The
// town calendar's term entries are made once for the labels and the effects. A read also scores its own days, each
// against the run chosen for it, as the window's accuracy (D42). A day after the forecast tier of the run chosen for it
// is an outlook day (D52, tiers.ts), and so is a week holding one; an outlook day is never scored. Each date's run is
// chosen from run metadata when the run has no gap in its days (every lab run) and from rows for a run with gaps (an
// imported file may skip days), so rows are read only for the runs chosen (D52 decision 11, about 52 year-long weekly
// runs a year): over the read's days and a week either side, and each run the read's days use over its own past days,
// for its live accuracy; the model card's, the newest run's over its days. It logs nothing and stores nothing.
import type { OrgScope } from '../access/policy.ts';
import { noteCovers } from '../agent/questions.ts';
import { closureOf, trustedGuestDays, TYPICAL_LOOKBACK_DAYS, typicalByDate } from '../closed-days.ts';
import { daysBetween, utcDay } from '../dates.ts';
import type { BusinessRuleStore } from '../stores/business-rules.ts';
import type { ForecastRow, ForecastRunRecord, ForecastStore } from '../stores/forecasts.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord, NoteStore } from '../stores/notes.ts';
import type { SalesDayStore } from '../stores/sales-days.ts';
import { weekdayOf, type Weekday } from '../time-zones.ts';
import {
  adjustDay, flagsAfterData, orderedReasons, ownerBeatsAgent, scheduledRules, type AdjustedDay, type ModelDay, type ScheduledRule,
} from './adjust.ts';
import { effectHistory, reasonEffects } from './effects.ts';
import { eachDay, type DayStatus } from './file.ts';
import { noteReasonView, reasonViews, ruleReasonView, townCalendarOf, townTermEntries, type ReasonView } from './reasons.ts';
import {
  inRangeOf, liveAccuracy, madeAfter, sawDay, scoredDay, weekActual, writtenForRun, type LiveAccuracy, type ScoredDay,
} from './score.ts';
import { isOutlook } from './tiers.ts';

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
  /**
   * Made after the day (its made-at day is later; a run made on the day, the lab's 03:00 run, is not). Such a run never
   * saw the day's sales (its data ends before the day) and is still compared with it (D49 as amended 2026-11-18); the
   * Calendar says it came from sales through the run's dataThrough.
   */
  madeAfterDay: boolean;
  /**
   * A day before today whose run may have read a private event note or business rule covering it (adjust.ts
   * flagsAfterData, the lab input's privateEvent flag) last written on or after the day, by the time the run was made
   * (score.ts writtenForRun): what was learned after the day could have shaped the figure, so `inRange` is null and the
   * day is not scored (D49 as amended).
   */
  laterNote: boolean;
  /** The stored guests for a day before today; null otherwise. */
  actual: number | null;
  /**
   * The actual within the model's [low, high]; null when either is missing, the model did not forecast the day open, or
   * the run could have known how the day went (score.ts late: laterNote).
   */
  inRange: boolean | null;
  /**
   * Counted in the window's accuracy (score.ts scoredDay): open in the model, not closed or likely closed, not an
   * outlook day, with guests, and not laterNote.
   */
  scored: boolean;
  /** After the forecast tier of the run chosen for the day (D52, tiers.ts): its outlook. Derived, never stored. */
  outlook: boolean;
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
  /** Any of its days is an outlook day (D52). */
  outlook: boolean;
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

/** The rows a read loaded and the day each date uses. */
interface Choice { readonly rows: ForecastRow[]; readonly chosen: Map<string, Chosen> }

/** Whether the run supplies every date of its range, as every lab run does (a run file never repeats a date, file.ts). */
function gapFree(run: ForecastRunRecord): boolean {
  return run.dayCount === daysBetween(run.range.from, run.range.to) + 1;
}

/**
 * The run each date uses, from the published runs whose data ends before it and that supply it (runs come newest
 * first), a gap-free run by its range and a run with gaps by its day rows in `gappyRows`: the newest made by the day,
 * else the newest (D49, owner 2026-11-18: a run made in time is the forecast the owner could have read, so a run made
 * later never takes a past day from one; it fills a day no such run has, and is compared with it all the same, as it
 * never saw the day's sales: D49 as amended). From today on every run was made by the day, so this is the newest.
 */
function runChooser(runs: readonly ForecastRunRecord[], gappyRows: readonly ForecastRow[]): (date: string) => ForecastRunRecord | undefined {
  const supplied = new Set(gappyRows.filter((row) => row.span === 'day').map((row) => `${row.runId}|${row.from}`));
  const full = new Map(runs.map((run) => [run.id, gapFree(run)]));
  return (date) => {
    const usable = runs.filter((run) => run.dataThrough < date
      && (full.get(run.id) === true ? run.range.from <= date && date <= run.range.to : supplied.has(`${run.id}|${date}`)));
    return usable.find((run) => !madeAfter(run, date)) ?? usable[0];
  };
}

/**
 * Each date's chosen run with its day row from `rows` (deduplicated, then in the store's order, by `from` then `span`, so
 * weeks read from several reads come in date order), dates in order; a date with no row is left out.
 */
function choiceOf(picks: ReadonlyMap<string, ForecastRunRecord>, rows: readonly ForecastRow[]): Choice {
  const unique = [...new Map(rows.map((row) => [`${row.runId}|${row.span}|${row.from}`, row])).values()]
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.span < b.span ? -1 : a.span > b.span ? 1 : 0));
  const dayRow = new Map(unique.filter((row) => row.span === 'day').map((row) => [`${row.runId}|${row.from}`, row]));
  const chosen = new Map<string, Chosen>();
  for (const date of [...picks.keys()].sort()) {
    const run = picks.get(date);
    const row = run === undefined ? undefined : dayRow.get(`${run.id}|${date}`);
    if (run !== undefined && row !== undefined) chosen.set(date, { run, row });
  }
  return { rows: unique, chosen };
}

/** `date` moved by `days`. */
function shifted(date: string, days: number): string {
  return utcDay(new Date(`${date}T00:00:00.000Z`), days);
}

/**
 * The days a window read's choices are made over (D42): the days from 6 before `range` to 6 after it (its days and the
 * weeks holding them), and every day to yesterday of each run reaching into those, so each run used keeps its live
 * accuracy over all its own past days. Every run's rows over these days choose each date exactly as all of their rows
 * would; since D52 only a run with gaps has its rows read over all of them.
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
   * yesterday; the notes once, over the stored days, the chosen days before today and `reach.notes`; the scheduled rules
   * once. None are read when no run supplies a day. A stored day whose guest count a note marks wrong (D67) reads with
   * no guest count.
   */
  async function load(
    scope: OrgScope, locationId: string, today: string,
    reach: {
      historyFrom?: string; notes?: { from: string; to: string };
      /** The rows the answer needs and the day each date uses, from the published runs. */
      choose: (runs: readonly ForecastRunRecord[]) => Promise<Choice>;
    },
  ) {
    const runs = await forecasts.published(scope, locationId);
    const { rows, chosen } = await reach.choose(runs);
    const dates = [...chosen.keys()].sort();
    const [first] = dates;
    const yesterday = utcDay(new Date(`${today}T00:00:00.000Z`), -1);
    const from = first === undefined ? undefined : firstOf([utcDay(new Date(`${first}T00:00:00.000Z`), -TYPICAL_LOOKBACK_DAYS), reach.historyFrom]);
    const readsDays = from !== undefined && from <= yesterday;
    // The notes the scored days need (the chosen days to yesterday), the caller's, and every stored day's (D67: a note
    // marking a guest count wrong anywhere in the stored range).
    const notesFrom = firstOf([readsDays ? from : undefined, first, reach.notes?.from]);
    const notesTo = lastOf([readsDays ? yesterday : undefined, dates.filter((date) => date <= yesterday).at(-1), reach.notes?.to]);
    const [storedRows, noted, scheduled] = await Promise.all([
      readsDays ? salesDays.days(scope, locationId, { from, to: yesterday }) : [],
      first === undefined || notesFrom === undefined || notesTo === undefined ? [] : notes.overlapping(scope, locationId, { from: notesFrom, to: notesTo }),
      first === undefined ? [] : businessRules.scheduled(scope, locationId),
    ]);
    const rules = scheduledRules(scheduled);
    // D67: a day whose guest count is marked wrong has no actual, feeds no typical guests and no effect, and is never
    // likely closed: it reads as a day with sales and no guest count.
    const stored = trustedGuestDays(storedRows, noted);
    const notesOn = (date: string): NoteRecord[] => noted.filter((note) => noteCovers(note, date));
    const rulesOn = (date: string): ScheduledRule[] => rules.filter((rule) => noteCovers(rule.schedule, date));
    const actuals = new Map<string, number>();
    for (const day of stored) {
      if (day.guests !== null) actuals.set(day.date, day.guests);
    }
    const storedOn = new Map(stored.map((day) => [day.date, day]));
    const typical = typicalByDate(stored);
    /**
     * The notes covering a day the lab input reads: D59, a person's note that decides it sets TownwiseAI's aside
     * (adjust.ts ownerBeatsAgent), as labInputOf does.
     */
    const keptOn = (date: string): NoteRecord[] => ownerBeatsAgent(notesOn(date)).kept;
    /** A past day that was closed or likely closed (D32): a closure, not a miss. */
    const closedOn = (date: string): boolean => date < today && closureOf(
      storedOn.get(date), typical.get(date) ?? null, keptOn(date), { rules: rulesOn(date).map((rule) => rule.schedule), past: true },
    ) !== null;
    /**
     * A past day whose run may have read a private event note or rule, covering it and last written once the day began
     * (D49 as amended): the lab input flags one on a day after the run's data (adjust.ts flagsAfterData).
     */
    const laterNoteOn = (date: string, run: ForecastRunRecord): boolean => date < today && (
      keptOn(date).some((note) => flagsAfterData(note) && writtenForRun(run, date, note.updatedAt))
      || scheduled.some((rule) => rule.schedule !== null && noteCovers(rule.schedule, date) && flagsAfterData(rule.schedule)
        && writtenForRun(run, date, rule.updatedAt)));
    const scored = (date: string, { run, row }: Chosen): ScoredDay => ({
      date, status: row.status ?? 'open', low: row.low, mid: row.mid, high: row.high, actual: actuals.get(date) ?? null, closed: closedOn(date),
      late: sawDay(run, date) || laterNoteOn(date, run),
      outlook: isOutlook(date, run),
    });
    const daysOf = new Map<string, ScoredDay[]>();
    for (const [date, pick] of chosen) daysOf.set(pick.run.id, [...(daysOf.get(pick.run.id) ?? []), scored(date, pick)]);
    const liveOf = (runId: string): LiveAccuracy | null => liveAccuracy(daysOf.get(runId) ?? []);
    return { runs, rows, chosen, actuals, scored, liveOf, stored, notesOn, rulesOn, laterNoteOn };
  }

  /**
   * A window read's rows and choices (D52 decision 11): each date of windowRows' days is chosen as chooseDays chose from
   * every run's rows there, with only the runs with gaps read over all of them; then rows are read for the runs chosen,
   * over the read's days and a week either side, and for each run the read's days use, over its own past days.
   */
  async function chooseWindow(
    scope: OrgScope, locationId: string, runs: readonly ForecastRunRecord[], range: { from: string; to: string }, today: string,
  ): Promise<Choice> {
    if (runs.length === 0) return { rows: [], chosen: new Map() };
    const gappy = runs.filter((run) => !gapFree(run)).map((run) => run.id);
    const gappyRows = gappy.length === 0 ? [] : await forecasts.rows(scope, locationId, gappy, windowRows(runs, range, today));
    const runFor = runChooser(runs, gappyRows);
    const around = { from: shifted(range.from, -6), to: shifted(range.to, 6) };
    const picks = new Map<string, ForecastRunRecord>();
    for (const date of eachDay(around.from, around.to)) {
      const run = runFor(date);
      if (run !== undefined) picks.set(date, run);
    }
    const inWindow = new Set(picks.values());
    const used = new Set(eachDay(range.from, range.to).flatMap((date) => picks.get(date) ?? []));
    const yesterday = shifted(today, -1);
    const pastDates: string[] = [];
    const pastRuns = new Set<ForecastRunRecord>();
    for (const run of used) {
      const to = run.range.to < yesterday ? run.range.to : yesterday;
      if (run.range.from > to) continue;
      for (const date of eachDay(run.range.from, to)) {
        if (picks.has(date) || runFor(date) !== run) continue;
        picks.set(date, run);
        pastDates.push(date);
        pastRuns.add(run);
      }
    }
    const fullIds = (chosenRuns: Iterable<ForecastRunRecord>): string[] => [...chosenRuns].filter(gapFree).map((run) => run.id);
    const windowIds = fullIds(inWindow);
    const pastIds = fullIds(pastRuns);
    const pastFrom = firstOf(pastDates);
    const pastTo = lastOf(pastDates);
    const [windowRead, pastRead] = await Promise.all([
      windowIds.length === 0 ? [] : forecasts.rows(scope, locationId, windowIds, around),
      pastIds.length === 0 || pastFrom === undefined || pastTo === undefined ? [] : forecasts.rows(scope, locationId, pastIds, { from: pastFrom, to: pastTo }),
    ]);
    return choiceOf(picks, [...gappyRows, ...windowRead, ...pastRead]);
  }

  /** The model card's rows and choices: the newest run's own days, every one of which it supplies (no run is newer). */
  async function chooseNewest(scope: OrgScope, locationId: string, runs: readonly ForecastRunRecord[]): Promise<Choice> {
    const [newest] = runs;
    if (newest === undefined) return { rows: [], chosen: new Map() };
    const rows = await forecasts.rows(scope, locationId, [newest.id], newest.range);
    const runFor = runChooser(runs, rows);
    const picks = new Map<string, ForecastRunRecord>();
    for (const row of rows) {
      if (row.span === 'day' && runFor(row.from) === newest) picks.set(row.from, newest);
    }
    return choiceOf(picks, rows);
  }

  return {
    async window(scope, location, range, today) {
      // Effects are for days from today on, so a range wholly in the past reads no history for them.
      const history = range.to >= today ? effectHistory(today) : null;
      // One read of the notes, over the scored days, the range, a week reaching 6 days past either end and the effects' history.
      const at = (date: string, days: number): string => utcDay(new Date(`${date}T00:00:00.000Z`), days);
      const { runs, rows, chosen, actuals, scored, liveOf, stored, notesOn, rulesOn, laterNoteOn } = await load(scope, location.id, today, {
        ...(history === null ? {} : { historyFrom: history.readFrom }),
        notes: { from: firstOf([at(range.from, -6), history?.from]) ?? range.from, to: at(range.to, 6) },
        choose: (published) => chooseWindow(scope, location.id, published, range, today),
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
          runId: run.id, madeAt: run.madeAt, madeAfterDay: madeAfter(run, date), laterNote: laterNoteOn(date, run),
          // A run that could have known how the day went is never compared with it (D49 as amended).
          actual, inRange: model.status === 'open' && score.late !== true ? inRangeOf(actual, row.low, row.high) : null, scored: scoredDay(score),
          outlook: score.outlook === true,
        });
      }
      const weeks: ForecastWeekView[] = weekRows.flatMap((row): ForecastWeekView[] => {
        const weekDates = eachDay(row.from, row.to);
        const picks = weekDates.map((date) => chosen.get(date));
        if (picks.some((pick) => pick?.run.id !== row.runId)) return [];
        const run = picks[0]?.run;
        if (run === undefined || row.low === null || row.mid === null || row.high === null) return [];
        const weekScored = picks.flatMap((pick, index) => (pick === undefined ? [] : [scored(weekDates[index] ?? '', pick)]));
        const actual = weekActual(weekScored);
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
          // A week holding a day its run could have known is not compared (D49 as amended).
          inRange: weekScored.some((day) => day.late === true) ? null : inRangeOf(actual, row.low, row.high), noteGuests,
          outlook: weekDates.some((date) => isOutlook(date, run)),
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
      const { runs, liveOf } = await load(scope, locationId, today, { choose: (published) => chooseNewest(scope, locationId, published) });
      const [newest] = runs;
      return newest === undefined ? null : { run: runView(newest), live: liveOf(newest.id) };
    },
  };
}
