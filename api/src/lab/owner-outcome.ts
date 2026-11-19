// What a calibration did, in the codes an owner's pages word (D65, openspec change forecast-training-status, design
// decisions 6 and 7). The staff words (GATE_WORDS, FAILURE_WORDS) say what staff can do about a draft; an owner needs
// to know whether their forecast changed and why. So the outcome comes from what happened to the run, not only the
// gate: a run the gate held that staff published later is published, and one the gate passed that staff withdrew
// first was never used. Every gate reason and failure maps to one owner reason through an exhaustive Record, so a new
// gate reason fails typecheck until it is mapped. A live calibration past its 20 minutes reads as a failed run here,
// with no write (expireStale still fails it on the next start, staff read or pass), so a GET stays a read (7.3).
// Codes and dates only: no guest figure, no accuracy (design decision 8). Pure: nothing here reads, writes or logs.
import type { CalibrationFailure, CalibrationRecord } from '../stores/calibrations.ts';
import type { RunState } from '../stores/forecasts.ts';
import type { Cause } from './causes.ts';
import type { GateReason } from './gate.ts';
import { CALIBRATION_TIMEOUT_MS } from './service.ts';

/** `published`: the run is (or was) the forecast; `kept`: it finished and was not used; `not_run`: it failed. */
export type OwnerOutcome = 'published' | 'kept' | 'not_run';

export type OwnerReason =
  | 'published' | 'published_by_staff' | 'not_more_accurate' | 'not_beat_average' | 'failed_checks' | 'held_for_review'
  | 'too_soon' | 'needs_more_history' | 'forecasts_off' | 'newer_forecast' | 'staff_withdrew' | 'not_judged' | 'failed';

/** A system start's stored causes, or, with none, who asked: `asked` an org admin, `staff` Townwise staff, `unknown` an older system start. */
export type OwnerCause = Cause | 'asked' | 'staff' | 'unknown';

export interface OwnerResult {
  readonly outcome: OwnerOutcome;
  readonly reason: OwnerReason;
  /** When it finished; a live one past its 20 minutes, its `requestedAt` plus 20 minutes. */
  readonly finishedAt: Date;
}

const GATE_OWNER_REASONS: Readonly<Record<GateReason, OwnerReason>> = {
  published: 'published',
  refreshed: 'published',
  engine_switched: 'published',
  forecasts_off: 'forecasts_off',
  champion_changed: 'newer_forecast',
  too_few_weeks: 'too_soon',
  not_better: 'not_more_accurate',
  refresh_worse: 'not_more_accurate',
  coverage_out_of_band: 'failed_checks',
  weekday_bias_worse: 'failed_checks',
  biased: 'failed_checks',
  not_enough_history: 'needs_more_history',
  model_not_run: 'needs_more_history',
  baseline_not_beaten: 'not_beat_average',
  jump_held: 'held_for_review',
};

const FAILURE_OWNER_REASONS: Readonly<Record<CalibrationFailure, OwnerReason>> = {
  start_failed: 'failed',
  timeout: 'failed',
  job_failed: 'failed',
  invalid_result: 'failed',
  not_enough_history: 'needs_more_history',
};

/** Whether the calibration is queued or running and still inside its 20 minutes at `now`: the location is updating. */
export function runningAt(record: CalibrationRecord, now: Date): boolean {
  return (record.status === 'queued' || record.status === 'running')
    && now.getTime() < record.requestedAt.getTime() + CALIBRATION_TIMEOUT_MS;
}

/**
 * The calibration's owner outcome at `now`, or null while it is still running (inside its 20 minutes). `run` is the
 * state of its run (`runId`), or null when it has none or the run is gone.
 */
export function ownerOutcomeOf(record: CalibrationRecord, run: RunState | null, now: Date): OwnerResult | null {
  if (record.status === 'queued' || record.status === 'running') {
    if (runningAt(record, now)) return null;
    return { outcome: 'not_run', reason: 'failed', finishedAt: new Date(record.requestedAt.getTime() + CALIBRATION_TIMEOUT_MS) };
  }
  const finishedAt = record.finishedAt ?? record.requestedAt;
  if (record.status === 'failed') {
    return { outcome: 'not_run', reason: record.failure === null ? 'failed' : FAILURE_OWNER_REASONS[record.failure], finishedAt };
  }
  const { gate } = record;
  // The run was not this calibration's draft (the same file as a run Townwise already had), so nothing judged it.
  if (gate === null) return { outcome: 'kept', reason: 'not_judged', finishedAt };
  if (run !== null && run.publishedAt !== null) {
    return { outcome: 'published', reason: !gate.published && run.publishedBy !== null ? 'published_by_staff' : 'published', finishedAt };
  }
  // The gate passed it, but staff withdrew or deleted the draft before its publish.
  if (gate.published) return { outcome: 'kept', reason: 'staff_withdrew', finishedAt };
  return { outcome: 'kept', reason: GATE_OWNER_REASONS[gate.reason as GateReason], finishedAt };
}

/**
 * Whether a calibration with run `runId` that finished at `finishedAt` made the location's first forecast: no run other
 * than its own had been published by then. `first` is forecasts.firstPublished's answer (withdrawn runs included), so a
 * location whose published runs were all withdrawn or lapsed is not on its first. The history and Home's `lastRun` read it.
 */
export function firstForecastOf(first: { runId: string; publishedAt: Date } | null, runId: string | null, finishedAt: Date): boolean {
  return first === null || first.runId === runId || first.publishedAt > finishedAt;
}

/**
 * What started the calibration: a system start's stored causes; else who asked, read from `requestedBy.role` whatever
 * the `via`, so a staff start through chat or a file read with the organization open as admin reads `staff`, never the
 * team's; an older system start with none reads `unknown`.
 */
export function ownerCausesOf(record: CalibrationRecord): OwnerCause[] {
  if (record.causes.length > 0) return [...record.causes];
  if (record.requestedBy.role === 'superadmin') return ['staff'];
  if (record.requestedBy.role === 'org_admin') return ['asked'];
  return ['unknown'];
}
