// A synthetic calibration record for the pure tests of what owners read about runs (D65); the ids and days mean nothing.
import type { CalibrationRecord } from '../../src/stores/calibrations.ts';

/** A succeeded org admin's calibration requested at 2026-11-23 08:10 UTC, with no gate and no run, unless `fields` say otherwise. */
export function calibrationRecord(fields: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return {
    id: 'c1', locationId: 'l1', requestedBy: { userId: 'admin-0001', role: 'org_admin', via: 'chat' }, causes: [], regimeStart: null,
    status: 'succeeded', championRunId: null, dataThrough: '2026-11-15', termsThrough: null, inputSha256: null, dataSha256: null,
    dayCount: null, dataFrom: null, newDays: null, imageDigest: null, codeVersion: null, runId: null, scorecardJson: null, gate: null,
    failure: null, chargedMicroUsd: 100_000, requestedAt: new Date('2026-11-23T08:10:00.000Z'), startedAt: null,
    finishedAt: new Date('2026-11-23T08:16:00.000Z'), ...fields,
  };
}
