// tw_calibrations (forecast lab, spec 14.3): one document per calibration of one location's forecast model. A
// calibration is `queued` until the job starts, `running` while it fetches its input and posts its result, then
// `succeeded` or `failed`. `liveLocation` equals the location until the calibration finishes and then goes, under a
// unique partial index, so a location has one live calibration (the tw_imports.activeLocation pattern). The job holds a
// per-calibration bearer token; only its sha256 is stored, and `finish` removes it, so a finished calibration's token
// is dead (cross-tenant.ts findLabCallback). The token the job starts with fetches the input once: that fetch swaps it
// for a result token the API hands only to the job (recordInput). Every transition is a compare-and-set (no transactions), so a retried
// result completes the work once. Results are the scorecard as a JSON string (a chat-messages precedent), never read
// as a figure by anything that logs. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const CALIBRATIONS_COLLECTION = 'tw_calibrations';

export type CalibrationStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export const CALIBRATION_STATUSES: readonly CalibrationStatus[] = ['queued', 'running', 'succeeded', 'failed'];
/** Statuses of a live calibration: the ones that hold the location's slot and a usable token. */
export const LIVE_STATUSES: readonly CalibrationStatus[] = ['queued', 'running'];

export type CalibrationFailure = 'start_failed' | 'timeout' | 'job_failed' | 'not_enough_history' | 'invalid_result';
export const CALIBRATION_FAILURES: readonly CalibrationFailure[] = [
  'start_failed', 'timeout', 'job_failed', 'not_enough_history', 'invalid_result',
];

export interface CalibrationRequester {
  /** The person who asked; null once their records are deleted. */
  userId: string | null;
  role: 'org_admin' | 'superadmin';
  via: 'chat' | 'console';
}

export interface CalibrationGate { published: boolean; reason: string }

interface CalibrationFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  requestedBy: CalibrationRequester;
  regimeStart: string | null;
  status: CalibrationStatus;
  championRunId: string | null;
  dataThrough: string | null;
  inputSha256: string | null;
  imageDigest: string | null;
  codeVersion: string | null;
  runId: string | null;
  scorecardJson: string | null;
  gate: CalibrationGate | null;
  failure: CalibrationFailure | null;
  chargedMicroUsd: number;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Equals locationId while the calibration is live; unset once it finishes. */
  liveLocation?: Types.ObjectId;
  /** sha256 of the job's bearer token; unset once the calibration finishes. */
  tokenSha256?: string;
  tokenExpiresAt: Date;
}

const sub = { _id: false, strict: 'throw' } as const;

function calibrationSchema(): Schema<CalibrationFields> {
  const requestedBy = new Schema({
    userId: { type: String, default: null },
    role: { type: String, required: true, enum: ['org_admin', 'superadmin'] },
    via: { type: String, required: true, enum: ['chat', 'console'] },
  }, sub);
  const gate = new Schema({ published: { type: Boolean, required: true }, reason: { type: String, required: true } }, sub);
  const schema = new Schema<CalibrationFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    requestedBy: { type: requestedBy, required: true },
    regimeStart: { type: String, default: null },
    status: { type: String, required: true, enum: CALIBRATION_STATUSES },
    championRunId: { type: String, default: null },
    dataThrough: { type: String, default: null },
    inputSha256: { type: String, default: null },
    imageDigest: { type: String, default: null },
    codeVersion: { type: String, default: null },
    runId: { type: String, default: null },
    scorecardJson: { type: String, default: null },
    gate: { type: gate, default: null },
    failure: { type: String, default: null, enum: [...CALIBRATION_FAILURES, null] },
    chargedMicroUsd: { type: Number, required: true, default: 0 },
    requestedAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    liveLocation: { type: Schema.Types.ObjectId },
    tokenSha256: { type: String },
    tokenExpiresAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary', minimize: false });
  schema.index({ liveLocation: 1 }, { unique: true, partialFilterExpression: { liveLocation: { $type: 'objectId' } } });
  schema.index({ orgId: 1, requestedAt: -1 });
  schema.index({ orgId: 1, locationId: 1, requestedAt: -1 });
  schema.index({ _id: 1, tokenSha256: 1 });
  return schema;
}

/** Registers TwCalibration (tw_calibrations) on first call. */
export function calibrationModel(connection: Connection): Model<CalibrationFields> {
  const existing = connection.models.TwCalibration as Model<CalibrationFields> | undefined;
  return existing ?? connection.model<CalibrationFields>('TwCalibration', calibrationSchema(), CALIBRATIONS_COLLECTION);
}

export interface CalibrationRecord {
  readonly id: string;
  readonly locationId: string;
  readonly requestedBy: CalibrationRequester;
  readonly regimeStart: string | null;
  readonly status: CalibrationStatus;
  readonly championRunId: string | null;
  readonly dataThrough: string | null;
  readonly inputSha256: string | null;
  readonly imageDigest: string | null;
  readonly codeVersion: string | null;
  readonly runId: string | null;
  readonly scorecardJson: string | null;
  readonly gate: CalibrationGate | null;
  readonly failure: CalibrationFailure | null;
  readonly chargedMicroUsd: number;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export type CalibrationOutcome = { status: 'succeeded' } | { status: 'failed'; failure: CalibrationFailure };

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface CalibrationStore {
  /** Inserts a queued calibration holding the location's live slot; null when the slot is taken. */
  insertQueued(scope: OrgScope, input: {
    id: string; locationId: string; requestedBy: CalibrationRequester; regimeStart: string | null;
    championRunId: string | null; tokenSha256: string; tokenExpiresAt: Date; now: Date;
  }): Promise<CalibrationRecord | null>;
  find(scope: OrgScope, id: string): Promise<CalibrationRecord | null>;
  /** The location's live (queued or running) calibration, if any. */
  live(scope: OrgScope, locationId: string): Promise<CalibrationRecord | null>;
  /** Newest first, at most `limit`, for the organization or one of its locations. */
  list(scope: OrgScope, limit: number, locationId?: string): Promise<CalibrationRecord[]>;
  /** Compare-and-set queued to running. */
  markRunning(scope: OrgScope, id: string, input: { now: Date; imageDigest: string | null }): Promise<boolean>;
  /** Compare-and-set on running with no image recorded yet: the image the job runs, when it was running first. */
  recordImageDigest(scope: OrgScope, id: string, imageDigest: string): Promise<boolean>;
  /**
   * The job's one input fetch, by compare-and-set on running, the token it called with and no input recorded yet: the
   * hash of the input it is given and the last day it holds, and the token swapped for the result token (its sha256),
   * so the token the job was started with is dead from here on. False for any second fetch.
   */
  recordInput(scope: OrgScope, id: string, input: {
    tokenSha256: string; inputSha256: string; dataThrough: string; resultTokenSha256: string;
  }): Promise<boolean>;
  /** Compare-and-set on running with no run recorded yet: a run id, once set, is kept. */
  recordResult(scope: OrgScope, id: string, result: { runId: string; scorecardJson: string; codeVersion: string }): Promise<boolean>;
  /** Compare-and-set on running with no gate yet: the gate is set once. */
  recordGate(scope: OrgScope, id: string, gate: CalibrationGate): Promise<boolean>;
  setCharge(scope: OrgScope, id: string, chargedMicroUsd: number): Promise<boolean>;
  /** Compare-and-set from a live status; clears the live slot and the token. */
  finish(scope: OrgScope, id: string, outcome: CalibrationOutcome, now: Date): Promise<boolean>;
  /** Location deletion and deleting its sales data. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion. Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type CalibrationDoc = CalibrationFields & { _id: Types.ObjectId };

function toCalibration(doc: CalibrationDoc): CalibrationRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    requestedBy: { userId: doc.requestedBy.userId, role: doc.requestedBy.role, via: doc.requestedBy.via },
    regimeStart: doc.regimeStart,
    status: doc.status,
    championRunId: doc.championRunId,
    dataThrough: doc.dataThrough,
    inputSha256: doc.inputSha256,
    imageDigest: doc.imageDigest,
    codeVersion: doc.codeVersion,
    runId: doc.runId,
    scorecardJson: doc.scorecardJson,
    gate: doc.gate === null ? null : { published: doc.gate.published, reason: doc.gate.reason },
    failure: doc.failure,
    chargedMicroUsd: doc.chargedMicroUsd,
    requestedAt: doc.requestedAt,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
  };
}

export function createCalibrationStore(connection: Connection): CalibrationStore {
  const Calibration = calibrationModel(connection);
  const org = (scope: OrgScope) => ({ orgId: new Types.ObjectId(scope.orgId) });
  const ofId = (scope: OrgScope, id: string) => ({ ...org(scope), _id: new Types.ObjectId(id) });

  return {
    async insertQueued(scope, input) {
      try {
        const doc = await Calibration.create({
          _id: new Types.ObjectId(input.id),
          ...org(scope),
          locationId: new Types.ObjectId(input.locationId),
          requestedBy: { userId: input.requestedBy.userId, role: input.requestedBy.role, via: input.requestedBy.via },
          regimeStart: input.regimeStart,
          status: 'queued',
          championRunId: input.championRunId,
          requestedAt: input.now,
          liveLocation: new Types.ObjectId(input.locationId),
          tokenSha256: input.tokenSha256,
          tokenExpiresAt: input.tokenExpiresAt,
        });
        return toCalibration(doc.toObject());
      } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      }
    },
    async find(scope, id) {
      const doc = await Calibration.findOne(ofId(scope, id)).lean();
      return doc === null ? null : toCalibration(doc);
    },
    async live(scope, locationId) {
      const doc = await Calibration.findOne({ ...org(scope), liveLocation: new Types.ObjectId(locationId) }).lean();
      return doc === null ? null : toCalibration(doc);
    },
    async list(scope, limit, locationId) {
      const filter = locationId === undefined ? org(scope) : { ...org(scope), locationId: new Types.ObjectId(locationId) };
      const docs = await Calibration.find(filter).sort({ requestedAt: -1, _id: -1 }).limit(limit).lean();
      return docs.map(toCalibration);
    },
    async markRunning(scope, id, input) {
      const result = await Calibration.updateOne(
        { ...ofId(scope, id), status: 'queued' },
        { $set: { status: 'running', startedAt: input.now, imageDigest: input.imageDigest } },
      );
      return result.modifiedCount === 1;
    },
    async recordImageDigest(scope, id, imageDigest) {
      const result = await Calibration.updateOne({ ...ofId(scope, id), status: 'running', imageDigest: null }, { $set: { imageDigest } });
      return result.modifiedCount === 1;
    },
    async recordInput(scope, id, input) {
      const result = await Calibration.updateOne(
        { ...ofId(scope, id), status: 'running', tokenSha256: input.tokenSha256, inputSha256: null },
        { $set: { inputSha256: input.inputSha256, dataThrough: input.dataThrough, tokenSha256: input.resultTokenSha256 } },
      );
      return result.modifiedCount === 1;
    },
    async recordResult(scope, id, result) {
      const done = await Calibration.updateOne(
        { ...ofId(scope, id), status: 'running', runId: null },
        { $set: { runId: result.runId, scorecardJson: result.scorecardJson, codeVersion: result.codeVersion } },
      );
      return done.modifiedCount === 1;
    },
    async recordGate(scope, id, gate) {
      const result = await Calibration.updateOne(
        { ...ofId(scope, id), status: 'running', gate: null },
        { $set: { gate: { published: gate.published, reason: gate.reason } } },
      );
      return result.modifiedCount === 1;
    },
    async setCharge(scope, id, chargedMicroUsd) {
      const result = await Calibration.updateOne(ofId(scope, id), { $set: { chargedMicroUsd } });
      return result.matchedCount === 1;
    },
    async finish(scope, id, outcome, now) {
      const from: CalibrationStatus[] = outcome.status === 'succeeded' ? ['running'] : [...LIVE_STATUSES];
      const result = await Calibration.updateOne(
        { ...ofId(scope, id), status: trusted({ $in: from }) },
        {
          $set: { status: outcome.status, failure: outcome.status === 'failed' ? outcome.failure : null, finishedAt: now },
          $unset: { liveLocation: '', tokenSha256: '' },
        },
      );
      return result.modifiedCount === 1;
    },
    async removeForLocation(scope, locationId) {
      return (await Calibration.deleteMany({ ...org(scope), locationId: new Types.ObjectId(locationId) })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Calibration.deleteMany(org(scope))).deletedCount;
    },
  };
}
