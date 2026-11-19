// What an owner's pages read of a calibration (D65, lab/owner-outcome.ts), without Docker: every gate reason and
// failure maps to one owner reason, the outcome follows what happened to the run (staff publishing a held run,
// withdrawing a passed one first, a run that is gone), a live calibration past its 20 minutes reads as a failed run,
// and who started it reads from the stored causes or the requester's role, whatever the `via`. Synthetic records.
import { describe, expect, it } from 'vitest';

import { GATE_REASONS, type GateReason } from '../src/lab/gate.ts';
import { ownerCausesOf, ownerOutcomeOf, runningAt, type OwnerReason } from '../src/lab/owner-outcome.ts';
import { CALIBRATION_FAILURES, type CalibrationFailure } from '../src/stores/calibrations.ts';
import type { RunState } from '../src/stores/forecasts.ts';
import { calibrationRecord as record } from './helpers/calibration-record.ts';

const REQUESTED = new Date('2026-11-23T08:10:00.000Z');
const FINISHED = new Date('2026-11-23T08:16:00.000Z');
const LATER = new Date('2026-11-24T12:00:00.000Z');
const minutes = (count: number): Date => new Date(REQUESTED.getTime() + count * 60_000);

const PUBLISHED: RunState = { status: 'published', publishedAt: FINISHED, publishedBy: null };
const DRAFT: RunState = { status: 'draft', publishedAt: null, publishedBy: null };

const HELD_REASONS: Readonly<Record<Exclude<GateReason, 'published' | 'refreshed' | 'engine_switched'>, OwnerReason>> = {
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

const FAILURES: Readonly<Record<CalibrationFailure, OwnerReason>> = {
  start_failed: 'failed', timeout: 'failed', job_failed: 'failed', invalid_result: 'failed', not_enough_history: 'needs_more_history',
};

describe('ownerOutcomeOf', () => {
  it('a gate that held the draft keeps the current forecast, each reason mapped', () => {
    for (const [reason, owner] of Object.entries(HELD_REASONS)) {
      expect(ownerOutcomeOf(record({ runId: 'r1', gate: { published: false, reason } }), DRAFT, LATER))
        .toEqual({ outcome: 'kept', reason: owner, finishedAt: FINISHED });
    }
  });

  it('a gate that published the draft reads published, for each published reason', () => {
    for (const reason of ['published', 'refreshed', 'engine_switched']) {
      expect(ownerOutcomeOf(record({ runId: 'r1', gate: { published: true, reason } }), PUBLISHED, LATER))
        .toEqual({ outcome: 'published', reason: 'published', finishedAt: FINISHED });
    }
  });

  it('maps every gate reason the gate can record', () => {
    expect([...GATE_REASONS].sort()).toEqual([...Object.keys(HELD_REASONS), 'published', 'refreshed', 'engine_switched'].sort());
  });

  it('a failed calibration did not run, each failure mapped', () => {
    expect([...CALIBRATION_FAILURES].sort()).toEqual(Object.keys(FAILURES).sort());
    for (const [failure, owner] of Object.entries(FAILURES)) {
      expect(ownerOutcomeOf(record({ status: 'failed', failure: failure as CalibrationFailure }), null, LATER))
        .toEqual({ outcome: 'not_run', reason: owner, finishedAt: FINISHED });
    }
  });

  it('a succeeded calibration with no gate (its file matched a run Townwise had) was not judged', () => {
    expect(ownerOutcomeOf(record({ runId: 'r1', gate: null }), PUBLISHED, LATER))
      .toEqual({ outcome: 'kept', reason: 'not_judged', finishedAt: FINISHED });
  });

  it('a gate that published, with the run withdrawn first or gone, reads staff_withdrew', () => {
    const passed = record({ runId: 'r1', gate: { published: true, reason: 'published' } });
    expect(ownerOutcomeOf(passed, { status: 'withdrawn', publishedAt: null, publishedBy: null }, LATER))
      .toEqual({ outcome: 'kept', reason: 'staff_withdrew', finishedAt: FINISHED });
    expect(ownerOutcomeOf(passed, null, LATER)).toEqual({ outcome: 'kept', reason: 'staff_withdrew', finishedAt: FINISHED });
  });

  it('a published run withdrawn later still reads published (it keeps its publishedAt)', () => {
    const passed = record({ runId: 'r1', gate: { published: true, reason: 'published' } });
    expect(ownerOutcomeOf(passed, { status: 'withdrawn', publishedAt: FINISHED, publishedBy: null }, LATER)?.outcome).toBe('published');
  });

  it('a gate that held the run, which staff published later, reads published_by_staff', () => {
    const held = record({ runId: 'r1', gate: { published: false, reason: 'jump_held' } });
    expect(ownerOutcomeOf(held, { status: 'published', publishedAt: LATER, publishedBy: 'staff-0001' }, LATER))
      .toEqual({ outcome: 'published', reason: 'published_by_staff', finishedAt: FINISHED });
  });

  it('a gate that held the run, with the run gone, keeps its gate reason', () => {
    expect(ownerOutcomeOf(record({ runId: 'r1', gate: { published: false, reason: 'not_better' } }), null, LATER)?.reason)
      .toBe('not_more_accurate');
  });

  it('a live calibration is running at 19 minutes and a failed run at 21, dated its request plus 20 minutes', () => {
    for (const status of ['queued', 'running'] as const) {
      const live = record({ status, finishedAt: null });
      expect(runningAt(live, minutes(19))).toBe(true);
      expect(ownerOutcomeOf(live, null, minutes(19))).toBeNull();
      expect(runningAt(live, minutes(21))).toBe(false);
      expect(ownerOutcomeOf(live, null, minutes(21))).toEqual({ outcome: 'not_run', reason: 'failed', finishedAt: minutes(20) });
      expect(runningAt(live, minutes(20))).toBe(false);
    }
    expect(runningAt(record(), minutes(1))).toBe(false);
  });
});

describe('ownerCausesOf', () => {
  it('a system start reads its stored causes', () => {
    const system = { userId: null, role: 'system', via: 'scheduled' } as const;
    expect(ownerCausesOf(record({ requestedBy: system, causes: ['weekly'] }))).toEqual(['weekly']);
    expect(ownerCausesOf(record({ requestedBy: system, causes: ['sales', 'person_change'] }))).toEqual(['sales', 'person_change']);
  });

  it('an older system start with none reads unknown', () => {
    expect(ownerCausesOf(record({ requestedBy: { userId: null, role: 'system', via: 'scheduled' } }))).toEqual(['unknown']);
  });

  it('a person’s start reads from the role whatever the via: an org admin asked, staff started it', () => {
    for (const via of ['chat', 'console', 'file'] as const) {
      expect(ownerCausesOf(record({ requestedBy: { userId: 'admin-0001', role: 'org_admin', via } }))).toEqual(['asked']);
      expect(ownerCausesOf(record({ requestedBy: { userId: 'staff-0001', role: 'superadmin', via } }))).toEqual(['staff']);
    }
  });
});
