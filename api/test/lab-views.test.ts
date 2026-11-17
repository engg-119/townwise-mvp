// What staff read of a calibration (lab/views.ts), without Docker: the requester as stored, so the console words a
// person's start and the weekly refresh's (D42, "Started by Townwise (weekly)") apart, and a gate reason the API has no
// words for yet reads with none. Synthetic records.
import { describe, expect, it } from 'vitest';

import { GATE_WORDS } from '../src/lab/gate.ts';
import { calibrationView } from '../src/lab/views.ts';
import type { CalibrationRecord } from '../src/stores/calibrations.ts';

function record(fields: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return {
    id: 'c1', locationId: 'l1', requestedBy: { userId: 'admin-0001', role: 'org_admin', via: 'chat' }, regimeStart: null,
    status: 'succeeded', championRunId: null, dataThrough: '2026-11-15', inputSha256: null, dataSha256: null, imageDigest: null, codeVersion: null,
    runId: null, scorecardJson: null, gate: null, failure: null, chargedMicroUsd: 100_000,
    requestedAt: new Date('2026-11-23T08:10:00.000Z'), startedAt: null, finishedAt: null, ...fields,
  };
}

describe('calibrationView', () => {
  it('shows a system requester as the weekly refresh: role system, via scheduled, charged nothing', () => {
    const view = calibrationView(record({ requestedBy: { userId: null, role: 'system', via: 'scheduled' }, chargedMicroUsd: 0 }));
    expect([view.requestedByRole, view.via, view.chargedUsd]).toEqual(['system', 'scheduled', 0]);
    expect(JSON.stringify(view)).not.toContain('userId');
  });

  it('keeps a person’s requester as before', () => {
    const view = calibrationView(record());
    expect([view.requestedByRole, view.via, view.chargedUsd]).toEqual(['org_admin', 'chat', 0.1]);
  });

  it('gives a gate reason it has no words for no words, never a failure', () => {
    const view = calibrationView(record({ gate: { published: false, reason: 'a_later_reason' } }));
    expect(view.gate).toEqual({ published: false, reason: 'a_later_reason', words: null });
    // D42's reasons have their words since phase 3a
    expect(calibrationView(record({ gate: { published: false, reason: 'jump_held' } })).gate?.words).toBe(GATE_WORDS.jump_held);
  });
});
