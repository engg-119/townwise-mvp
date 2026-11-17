// What staff (and, from Task 8, TownwiseAI) read of a calibration: its state, the gate's words and a summary of its
// scorecard as percentages and counts only (spec D7: no guest figure outside view-as). Pure.
import type { CalibrationFailure, CalibrationRecord, CalibrationRequester, CalibrationStatus } from '../stores/calibrations.ts';
import { GATE_REASONS, gateWords, type GateReason } from './gate.ts';
import { scorecardSchema, type Metrics } from './scorecard.ts';
import { FAILURE_WORDS } from './service.ts';

export interface CalibrationSummary {
  /**
   * Held-out weeks compared with the current forecast, or backtest weeks with an 80% range with no current forecast to
   * compare: the weeks the gate judged, as calibration.finished's heldOutWeeks counts them.
   */
  weeks: number;
  weeklyWapePct: number;
  /** The current forecast's on the same weeks; null with nothing compared. */
  championWeeklyWapePct: number | null;
  /** Weeks inside the 80% range, of the weeks that had one. */
  coverage: { inside: number; weeks: number };
  weekdayBiasPct: number;
  championWeekdayBiasPct: number | null;
}

export interface CalibrationView {
  id: string;
  locationId: string;
  status: CalibrationStatus;
  failure: CalibrationFailure | null;
  failureWords: string | null;
  via: CalibrationRequester['via'];
  requestedByRole: CalibrationRequester['role'];
  regimeStart: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  runId: string | null;
  chargedUsd: number;
  gate: { published: boolean; reason: string; words: string | null } | null;
  summary: CalibrationSummary | null;
}

/** A fraction as a percentage with one decimal. */
function pct(value: number): number {
  return Math.round(value * 1000) / 10;
}

function isGateReason(reason: string): reason is GateReason {
  return (GATE_REASONS as readonly string[]).includes(reason);
}

function summaryOf(scorecardJson: string | null): CalibrationSummary | null {
  if (scorecardJson === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(scorecardJson);
  } catch {
    return null;
  }
  const parsed = scorecardSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { backtest, comparison } = parsed.data;
  const of = (weeks: number, metrics: Metrics, champion: Metrics | null): CalibrationSummary => ({
    weeks,
    weeklyWapePct: pct(metrics.weeklyWape),
    championWeeklyWapePct: champion === null ? null : pct(champion.weeklyWape),
    coverage: { inside: metrics.coverage80.inside, weeks: metrics.coverage80.weeks },
    weekdayBiasPct: pct(metrics.weekdayBiasMeanAbs),
    championWeekdayBiasPct: champion === null ? null : pct(champion.weekdayBiasMeanAbs),
  });
  return comparison === null
    ? of(backtest.weeksWithRange, backtest.metrics, null)
    : of(comparison.weeks, comparison.challenger, comparison.champion);
}

export function calibrationView(record: CalibrationRecord): CalibrationView {
  const summary = summaryOf(record.scorecardJson);
  return {
    id: record.id,
    locationId: record.locationId,
    status: record.status,
    failure: record.failure,
    failureWords: record.failure === null ? null : FAILURE_WORDS[record.failure],
    via: record.requestedBy.via,
    requestedByRole: record.requestedBy.role,
    regimeStart: record.regimeStart,
    requestedAt: record.requestedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    runId: record.runId,
    chargedUsd: record.chargedMicroUsd / 1_000_000,
    gate: record.gate === null ? null : {
      published: record.gate.published,
      reason: record.gate.reason,
      words: isGateReason(record.gate.reason) ? gateWords(record.gate.reason, summary?.championWeeklyWapePct === null) : null,
    },
    summary,
  };
}
