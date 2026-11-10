// The publish gate (G2): pure, so every threshold is one test. Every value is a [CONFIRM] in spec D27.
import { daysBetween } from '../dates.ts';
import type { ForecastRunRecord } from '../stores/forecasts.ts';
import type { Scorecard } from './scorecard.ts';

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
  currentHorizonDays: 28,
} as const;

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
] as const;

export type GateReason = (typeof GATE_REASONS)[number];

export interface GateInput {
  forecastsOn: boolean;
  championAtStart: string | null;
  championNow: string | null;
  scorecard: Scorecard;
}

export type GateDecision =
  | { publish: true; reason: 'published' }
  | { publish: false; reason: Exclude<GateReason, 'published'> };

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

const no = (reason: Exclude<GateReason, 'published'>): GateDecision => ({ publish: false, reason });

export function decideGate(input: GateInput): GateDecision {
  const { scorecard, forecastsOn } = input;
  const comparison = scorecard.comparison;
  if (input.championAtStart !== null) {
    if (input.championNow !== input.championAtStart) return no('champion_changed');
    if (comparison === null || comparison.weeks < GATE.heldOutWeeksMin) return no('too_few_weeks');
    const { champion, challenger } = comparison;
    // The 80% range is judged on the held-out weeks that have one (a past-only band), which can be fewer.
    if (challenger.coverage80.weeks < GATE.heldOutWeeksMin) return no('too_few_weeks');
    if (challenger.weeklyWape > champion.weeklyWape - GATE.wapeMargin) return no('not_better');
    if (!inBand(challenger.coverage80.inside, challenger.coverage80.weeks)) return no('coverage_out_of_band');
    if (challenger.weekdayBiasMeanAbs > champion.weekdayBiasMeanAbs + GATE.weekdayBiasAllowance + 1e-12) {
      return no('weekday_bias_worse');
    }
  } else {
    if (input.championNow !== null) return no('champion_changed');
    const { backtest, history } = scorecard;
    if (history.spanDays < GATE.minHistoryDays || backtest.weeksWithRange < GATE.heldOutWeeksMin) {
      return no('not_enough_history');
    }
    if (backtest.metrics.weeklyWape > backtest.weekdayMedianWeeklyWape - GATE.wapeMargin) return no('baseline_not_beaten');
    if (!inBand(backtest.metrics.coverage80.inside, backtest.metrics.coverage80.weeks)) return no('coverage_out_of_band');
  }
  return forecastsOn ? { publish: true, reason: 'published' } : no('forecasts_off');
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
};

/** What a first forecast, with no published model to beat, beat: the weekday average on its own backtest weeks. */
const FIRST_PUBLISH_WORDS = 'Better than the weekday average on its backtest weeks, so Townwise published it.';

/** The words for a reason; a published first forecast (no comparison with a current forecast) says what it actually beat. */
export function gateWords(reason: GateReason, firstForecast: boolean): string {
  return reason === 'published' && firstForecast ? FIRST_PUBLISH_WORDS : GATE_WORDS[reason];
}
