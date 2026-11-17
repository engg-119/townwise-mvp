// The publish gate (G2): pure, so every threshold is one test. Every value but minHistoryDays (decided by the owner, 2026-11-10) is a [CONFIRM] in spec D27.
// Since D42 (14.6) one set of rules judges every draft, scheduled or started by a person: a first forecast by its
// engine's own checks, a refit of the current lab run's engine by its absolute checks and the streak's tolerance, an
// engine switch (which the lab decided on the same weeks) by its absolute checks (reason engine_switched), and a draft against an imported run on
// held-out weeks as before; then the jump guard, then G1. The new values are [CONFIRM]s in spec D42.
import { daysBetween, utcDay } from '../dates.ts';
import { engineOf } from '../forecasts/reader.ts';
import type { ForecastRow, ForecastRunRecord } from '../stores/forecasts.ts';
import type { Engine, LabScorecard, Scorecard } from './scorecard.ts';

export const GATE = {
  heldOutWeeksMin: 12,
  wapeMargin: 0.005,
  coverageMin: 0.65,
  coverageMax: 0.95,
  weekdayBiasAllowance: 0.02,
  /**
   * The history (first to last day with guests) that always gives 12 backtest weeks with an 80% range, so a calibration
   * started with it can be judged: the lab's first refit is at the month-end on or after the first day + 364 (up to 30
   * days later), its scored weeks start on the first Monday at least 28 days after that (up to 6 more), and a week's
   * range needs 8 earlier weeks that ended 28 days before it, so the 12th week with one is the 24th scored, ending 167
   * days after the first: 364 + 30 + 28 + 6 + 167. modeling/lab pins it (pipeline.MIN_HISTORY_DAYS and
   * test_min_history_days_always_gives_twelve_weeks_with_a_range); the API refuses a start with less.
   */
  minHistoryDays: 595,
  /** The baseline's minimum span (D42), for scheduled calibrations only: modeling/lab pins it (baseline.MIN_HISTORY_DAYS). */
  baselineMinHistoryDays: 230,
  currentHorizonDays: 28,
  /** A baseline draft's backtest weekly bias may be this far either way (D42). */
  baselineBiasMax: 0.05,
  /** A same-engine refit may be this much above the streak's best recorded backtest weekly WAPE (D42; a tie publishes). */
  refreshMargin: 0.005,
  /** The jump guard (D42): a draft whose middles over these days from today differ from the current run's by more is held. */
  jumpDays: 28,
  jumpMax: 0.25,
} as const;

/** Floating-point slack on a threshold a tie passes. */
const SLACK = 1e-12;

export const GATE_REASONS = [
  'published',
  'forecasts_off',
  'champion_changed',
  'too_few_weeks',
  'not_better',
  'coverage_out_of_band',
  'weekday_bias_worse',
  'not_enough_history',
  'baseline_not_beaten',
  'refreshed',
  'refresh_worse',
  'model_not_run',
  'biased',
  'jump_held',
  'engine_switched',
] as const;

export type GateReason = (typeof GATE_REASONS)[number];

/** The current run as the gate judges a draft against it. */
export interface CurrentRun {
  /** The engine that made it (its model family). */
  engine: Engine;
  /** Its calibration's recorded backtest; null for an imported run, or a lab run whose scorecard is gone. */
  recorded: { weeklyWape: number; weekdayBiasMeanAbs: number } | null;
  /** The lowest recorded backtest weekly WAPE in its streak (streakOf), or null without one. */
  streakBest: number | null;
}

export interface GateInput {
  forecastsOn: boolean;
  championAtStart: string | null;
  championNow: string | null;
  scorecard: LabScorecard;
  /** The run championAtStart names; null without one. */
  current: CurrentRun | null;
  /**
   * The jump guard's sums (jumpSums): against the current run, or, with none (it lapsed), the newest published run; null
   * with no published run at all.
   */
  jump: { draft: number; current: number } | null;
}

type Published = 'published' | 'refreshed' | 'engine_switched';
type Refusal = Exclude<GateReason, Published>;

export type GateDecision =
  | { publish: true; reason: Published }
  | { publish: false; reason: Refusal };

/**
 * The newest published run whose forecast reaches at least 28 days past `today`, or null. `published` is
 * ForecastStore.published()'s answer, newest dataThrough first and, within one, newest published first: of two runs with
 * the same dataThrough the first wins. A run of any other status is skipped.
 */
export function currentChampion(published: readonly ForecastRunRecord[], today: string): ForecastRunRecord | null {
  let best: ForecastRunRecord | null = null;
  for (const run of published) {
    if (run.status !== 'published' || daysBetween(today, run.range.to) < GATE.currentHorizonDays) continue;
    if (best === null || run.dataThrough > best.dataThrough) best = run;
  }
  return best;
}

function inBand(inside: number, weeks: number): boolean {
  if (weeks === 0) return false;
  const share = inside / weeks;
  return share >= GATE.coverageMin && share <= GATE.coverageMax;
}

const no = (reason: Refusal): GateDecision => ({ publish: false, reason });

/** Today's comparison on held-out weeks after the current run's dataThrough (10.15), for an imported current run. */
function heldOut(scorecard: LabScorecard): Refusal | null {
  const comparison = scorecard.comparison;
  if (comparison === null || comparison.weeks < GATE.heldOutWeeksMin) return 'too_few_weeks';
  const { champion, challenger } = comparison;
  // The 80% range is judged on the held-out weeks that have one (a past-only band), which can be fewer.
  if (challenger.coverage80.weeks < GATE.heldOutWeeksMin) return 'too_few_weeks';
  if (challenger.weeklyWape > champion.weeklyWape - GATE.wapeMargin) return 'not_better';
  if (!inBand(challenger.coverage80.inside, challenger.coverage80.weeks)) return 'coverage_out_of_band';
  if (challenger.weekdayBiasMeanAbs > champion.weekdayBiasMeanAbs + GATE.weekdayBiasAllowance + SLACK) return 'weekday_bias_worse';
  return null;
}

/** A first model forecast (10.15): 595 days and 12 weeks with a range, half a point under the weekday median, coverage. */
function firstModel(scorecard: LabScorecard): Refusal | null {
  const { backtest, history } = scorecard;
  if (history.spanDays < GATE.minHistoryDays || backtest.weeksWithRange < GATE.heldOutWeeksMin) return 'not_enough_history';
  if (backtest.metrics.weeklyWape > backtest.weekdayMedianWeeklyWape - GATE.wapeMargin) return 'baseline_not_beaten';
  if (!inBand(backtest.metrics.coverage80.inside, backtest.metrics.coverage80.weeks)) return 'coverage_out_of_band';
  return null;
}

/**
 * A draft's absolute checks (D42) on its backtest. The model: coverage 65% to 95% on 12 weeks with a range, weekday
 * bias no more than 2 points worse than `recordedBias` (the current run's recorded backtest, when there is one), and
 * half a point under the weekday median. The baseline: 12 weeks with a range, coverage, weekly bias within 5 points,
 * and lower than the weekday median (a tie fails).
 */
function absolute(scorecard: LabScorecard, recordedBias: number | null): Refusal | null {
  const { backtest } = scorecard;
  const { metrics } = backtest;
  if (backtest.weeksWithRange < GATE.heldOutWeeksMin) return 'too_few_weeks';
  if (!inBand(metrics.coverage80.inside, metrics.coverage80.weeks)) return 'coverage_out_of_band';
  if (scorecard.engine === 'baseline') {
    if (Math.abs(backtest.weeklyBias) > GATE.baselineBiasMax + SLACK) return 'biased';
    if (metrics.weeklyWape >= backtest.weekdayMedianWeeklyWape) return 'baseline_not_beaten';
    return null;
  }
  if (recordedBias !== null && metrics.weekdayBiasMeanAbs > recordedBias + GATE.weekdayBiasAllowance + SLACK) return 'weekday_bias_worse';
  if (metrics.weeklyWape > backtest.weekdayMedianWeeklyWape - GATE.wapeMargin) return 'baseline_not_beaten';
  return null;
}

/** Whether the draft's sum moves more than 25% either way from the current run's; no common open day is no jump. */
function jumped(jump: { draft: number; current: number }): boolean {
  return jump.current > 0 && Math.abs(jump.draft - jump.current) > GATE.jumpMax * jump.current + SLACK;
}

export function decideGate(input: GateInput): GateDecision {
  const { scorecard, forecastsOn, current } = input;
  if (input.championNow !== input.championAtStart) return no('champion_changed');
  let refusal: Refusal | null;
  let reason: Published = 'published';
  if (input.championAtStart === null) {
    refusal = scorecard.engine === 'model' ? firstModel(scorecard) : absolute(scorecard, null);
  } else if (current?.engine === 'model' && scorecard.engine === 'baseline' && scorecard.engines.model === null) {
    // A model run is never replaced by a baseline for want of data.
    refusal = 'model_not_run';
  } else if (current?.recorded == null) {
    refusal = heldOut(scorecard);
  } else if (current.engine === scorecard.engine) {
    refusal = absolute(scorecard, current.recorded.weekdayBiasMeanAbs);
    const best = current.streakBest ?? current.recorded.weeklyWape;
    if (refusal === null && scorecard.backtest.metrics.weeklyWape > best + GATE.refreshMargin + SLACK) refusal = 'refresh_worse';
    reason = 'refreshed';
  } else {
    // An engine switch: the lab's same-weeks WAPE comparison stands, so no second one against a recorded backtest; the
    // model's weekday bias is still held to the current run's record, which the lab checks too (pipeline.passes).
    refusal = absolute(scorecard, current.recorded.weekdayBiasMeanAbs);
    reason = 'engine_switched';
  }
  if (refusal !== null) return no(refusal);
  // With no current run the sums are against the newest published one, so a draft after a lapse is not published unseen.
  if (input.jump !== null && jumped(input.jump)) return no('jump_held');
  return forecastsOn ? { publish: true, reason } : no('forecasts_off');
}

/**
 * The current run's streak (D42): it and the published runs after it in `published` (ForecastStore.published()'s
 * order, newest first) that are lab runs of its engine and still reach 28 days past `today` (as the current run must),
 * up to the first one of another engine, imported or lapsed. Empty when the current run is not in the list or is
 * imported. Bounding it to runs still current keeps a best that has lapsed from holding every later refit (a ratchet):
 * after a lasting rise in backtest error, refits are held only while the run before it is current.
 */
export function streakOf(published: readonly ForecastRunRecord[], currentId: string, today: string): ForecastRunRecord[] {
  const start = published.findIndex((run) => run.id === currentId);
  const head = published[start];
  if (head?.lab == null) return [];
  const engine = engineOf(head.model.family);
  const streak: ForecastRunRecord[] = [];
  for (const run of published.slice(start)) {
    if (run.lab === null || engineOf(run.model.family) !== engine || daysBetween(today, run.range.to) < GATE.currentHorizonDays) break;
    streak.push(run);
  }
  return streak;
}

/**
 * The jump guard's sums (D42): the draft's and the current run's middles over the 28 days from `today` (the
 * calibration's), on the days both forecast open. `draft` is the draft's run file days, `current` the current run's rows.
 */
export function jumpSums(
  draft: readonly { date: string; status: string; mid: number | null }[], current: readonly ForecastRow[], today: string,
): { draft: number; current: number } {
  const last = utcDay(new Date(`${today}T00:00:00.000Z`), GATE.jumpDays - 1);
  const theirs = new Map<string, number>();
  for (const row of current) {
    if (row.span === 'day' && row.status === 'open' && row.mid !== null && row.from >= today && row.from <= last) theirs.set(row.from, row.mid);
  }
  const sums = { draft: 0, current: 0 };
  for (const day of draft) {
    const other = theirs.get(day.date);
    if (day.status !== 'open' || day.mid === null || other === undefined) continue;
    sums.draft += day.mid;
    sums.current += other;
  }
  return sums;
}

export const GATE_WORDS: Readonly<Record<GateReason, string>> = {
  published: 'Better than the current forecast on held-out weeks, so Townwise published it.',
  forecasts_off:
    'It passed every check, but forecasts aren’t switched on for this organization, so it stays a draft for Townwise staff to review.',
  champion_changed: 'The published forecast changed while it ran, so it stays a draft. Run it again to compare.',
  too_few_weeks:
    'Fewer than 12 weeks since the current forecast was made have complete sales and an 80% range from the new calibration, so there isn’t enough to compare. It stays a draft.',
  not_better:
    'It wasn’t clearly better than the current forecast on the same weeks (it needs at least half a point lower weekly error), so it stays a draft.',
  coverage_out_of_band: 'Its 80% ranges didn’t hold between 65% and 95% of held-out weeks, so it stays a draft.',
  weekday_bias_worse: 'It ran further off on some weekdays than the current forecast, so it stays a draft.',
  not_enough_history:
    'There isn’t enough history to check a first forecast on 12 held-out weeks, so it stays a draft.',
  baseline_not_beaten: 'It didn’t beat a simple weekday average on held-out weeks, so it stays a draft.',
  refreshed:
    'It passed every check and its backtest error stayed within half a point of the best recent forecast of its kind, so Townwise published it with the newest weeks.',
  refresh_worse:
    'Its backtest error was more than half a point above the best recent forecast of its kind, so it stays a draft and the current forecast stays.',
  model_not_run:
    'There wasn’t enough history for Townwise’s demand model this time, so the baseline made instead stays a draft and the current forecast stays.',
  biased: 'Its backtest weeks ran more than 5 points high or low overall, so it stays a draft.',
  jump_held:
    'Its next 28 days differ from the current forecast by more than 25%, so it stays a draft for Townwise staff to review.',
  engine_switched:
    'Townwise switched to its other engine: it was at least half a point better on the same held-out weeks, so Townwise published it.',
};

/** What a first forecast, with no published model to beat, beat: the weekday average on its own backtest weeks. */
const FIRST_PUBLISH_WORDS = 'Better than the weekday average on its backtest weeks, so Townwise published it.';

/** Each engine as an engine switch's words name it (D42, forecast-publish-policy). */
const ENGINE_WORDS: Readonly<Record<Engine, string>> = {
  model: 'its demand model',
  baseline: 'its baseline from your recent weeks and the town calendar',
};

/** What an engine switch (D42) chose: the engine a scorecard returned, and by how many points of weekly error it beat the other on the same weeks. */
export interface EngineSwitch { engine: Engine; points: number }

/**
 * The switch a scorecard records: the returned engine and its margin over the other on the same weeks, in points to one
 * decimal. Null without both engines' figures (a scorecard from before D42, or the model not run).
 */
export function engineSwitchOf(scorecard: Pick<Scorecard, 'engine' | 'engines'>): EngineSwitch | null {
  const { engine, engines } = scorecard;
  if (engine === undefined || engines?.model == null) return null;
  const [chosen, other] = engine === 'model' ? [engines.model, engines.baseline] : [engines.baseline, engines.model];
  return { engine, points: Math.round((other.weeklyWape - chosen.weeklyWape) * 1000) / 10 };
}

/**
 * The words for a reason; a published first forecast (no comparison with a current forecast) says what it actually beat,
 * and an engine switch which engine Townwise switched to and by how much, when `switched` (engineSwitchOf) says.
 */
export function gateWords(reason: GateReason, firstForecast: boolean, switched: EngineSwitch | null = null): string {
  if (reason === 'engine_switched' && switched !== null) {
    return `Townwise switched to ${ENGINE_WORDS[switched.engine]}: it was ${String(switched.points)} points better on the same held-out weeks, so Townwise published it.`;
  }
  return reason === 'published' && firstForecast ? FIRST_PUBLISH_WORDS : GATE_WORDS[reason];
}
