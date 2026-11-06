// tw_forecast_runs and tw_forecasts (spec 6.20, 6.21, 14.4): one run per imported forecast run file, and one row per
// day or week of a run. A run is `importing` while its rows are written, `draft` once all are, `published` when
// staff publish it and `withdrawn` when they take it back; only published runs reach owners, view-as and TownwiseAI
// (forecasts/reader.ts). No transactions: the run is upserted on its file's hash, rows are upserted on their unique
// key, and the run moves to draft only when every row is there, so a retry of an import completes it. Rows hold
// outputs only (numbers, status, reason kinds, calendar refs, effects); labels are made in code. Both schemas are
// strict: 'throw' and rows are built field by field. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { DayStatus, ForecastRunFile, ReasonKind } from '../forecasts/file.ts';

export const FORECAST_RUNS_COLLECTION = 'tw_forecast_runs';
export const FORECASTS_COLLECTION = 'tw_forecasts';

export type RunStatus = 'importing' | 'draft' | 'published' | 'withdrawn';
export const RUN_STATUSES: readonly RunStatus[] = ['importing', 'draft', 'published', 'withdrawn'];

type Backtest = NonNullable<ForecastRunFile['backtest']>;

interface RunFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  metric: 'guests';
  model: ForecastRunFile['model'];
  trainingSource: ForecastRunFile['trainingSource'];
  trainedFrom: string;
  dataThrough: string;
  madeAt: string;
  frozen: { files: { name: string; sha256: string }[] } | null;
  interval: { level: number; widened: boolean };
  backtest: Backtest | null;
  range: { from: string; to: string };
  dayCount: number;
  weekCount: number;
  fileSha256: string;
  status: RunStatus;
  importedBy: string | null;
  publishedBy: string | null;
  importedAt: Date;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
}

export interface ReasonFields { kind: ReasonKind; ref: string | null; effectPct: number | null }

interface RowFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  runId: Types.ObjectId;
  span: 'day' | 'week';
  from: string;
  /** Equal to `from` for a day. */
  to: string;
  /** A day's status; null for a week. */
  status: DayStatus | null;
  low: number | null;
  mid: number | null;
  high: number | null;
  baseline: number | null;
  /** A week's open days; null for a day. */
  openDays: number | null;
  reasons: ReasonFields[];
}

const sub = { _id: false, strict: 'throw' } as const;

function runSchema(): Schema<RunFields> {
  const model = new Schema({ family: { type: String, required: true }, version: { type: String, required: true }, notebookCommit: { type: String, required: true } }, sub);
  const file = new Schema({ name: { type: String, required: true }, sha256: { type: String, required: true } }, sub);
  const range = new Schema({ below: { type: Number, required: true }, above: { type: Number, required: true } }, sub);
  const backtest = new Schema({
    from: { type: String, required: true }, to: { type: String, required: true }, weeks: { type: Number, required: true },
    weeklyTypicalErrorPct: { type: Number, required: true }, weeksOver20Pct: { type: Number, required: true },
    weeklyRangePct: { type: range, default: null },
  }, sub);
  const schema = new Schema<RunFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    metric: { type: String, required: true, enum: ['guests'] },
    model: { type: model, required: true },
    trainingSource: { type: String, required: true },
    trainedFrom: { type: String, required: true },
    dataThrough: { type: String, required: true },
    madeAt: { type: String, required: true },
    frozen: { type: new Schema({ files: { type: [file], required: true } }, sub), default: null },
    interval: { type: new Schema({ level: { type: Number, required: true }, widened: { type: Boolean, required: true } }, sub), required: true },
    backtest: { type: backtest, default: null },
    range: { type: new Schema({ from: { type: String, required: true }, to: { type: String, required: true } }, sub), required: true },
    dayCount: { type: Number, required: true },
    weekCount: { type: Number, required: true },
    fileSha256: { type: String, required: true },
    status: { type: String, required: true, enum: RUN_STATUSES },
    importedBy: { type: String, default: null },
    publishedBy: { type: String, default: null },
    importedAt: { type: Date, required: true },
    publishedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
  }, { strict: 'throw', versionKey: false, read: 'primary', minimize: false });
  schema.index({ orgId: 1, locationId: 1, fileSha256: 1 }, { unique: true });
  schema.index({ orgId: 1, locationId: 1, status: 1, dataThrough: -1 });
  schema.index({ orgId: 1, importedAt: -1 });
  return schema;
}

function rowSchema(): Schema<RowFields> {
  const reason = new Schema({ kind: { type: String, required: true }, ref: { type: String, default: null }, effectPct: { type: Number, default: null } }, sub);
  const schema = new Schema<RowFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    runId: { type: Schema.Types.ObjectId, required: true },
    span: { type: String, required: true, enum: ['day', 'week'] },
    from: { type: String, required: true },
    to: { type: String, required: true },
    status: { type: String, default: null },
    low: { type: Number, default: null },
    mid: { type: Number, default: null },
    high: { type: Number, default: null },
    baseline: { type: Number, default: null },
    openDays: { type: Number, default: null },
    reasons: { type: [reason], required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary', minimize: false });
  schema.index({ orgId: 1, locationId: 1, runId: 1, span: 1, from: 1 }, { unique: true });
  schema.index({ orgId: 1, locationId: 1, span: 1, from: 1 });
  schema.index({ orgId: 1, runId: 1 });
  return schema;
}

/** Registers TwForecastRun (tw_forecast_runs) on first call. */
export function forecastRunModel(connection: Connection): Model<RunFields> {
  const existing = connection.models.TwForecastRun as Model<RunFields> | undefined;
  return existing ?? connection.model<RunFields>('TwForecastRun', runSchema(), FORECAST_RUNS_COLLECTION);
}

/** Registers TwForecast (tw_forecasts) on first call. */
export function forecastModel(connection: Connection): Model<RowFields> {
  const existing = connection.models.TwForecast as Model<RowFields> | undefined;
  return existing ?? connection.model<RowFields>('TwForecast', rowSchema(), FORECASTS_COLLECTION);
}

export interface ForecastRunRecord {
  readonly id: string;
  readonly locationId: string;
  readonly metric: 'guests';
  readonly model: ForecastRunFile['model'];
  readonly trainingSource: ForecastRunFile['trainingSource'];
  readonly trainedFrom: string;
  readonly dataThrough: string;
  readonly madeAt: string;
  readonly frozen: boolean;
  readonly interval: { level: 0.8; widened: boolean };
  readonly backtest: Backtest | null;
  readonly range: { from: string; to: string };
  readonly dayCount: number;
  readonly weekCount: number;
  readonly status: RunStatus;
  readonly importedBy: string | null;
  readonly importedAt: Date;
  readonly publishedAt: Date | null;
  readonly withdrawnAt: Date | null;
}

export interface ForecastRow {
  readonly runId: string;
  readonly span: 'day' | 'week';
  readonly from: string;
  readonly to: string;
  readonly status: DayStatus | null;
  readonly low: number | null;
  readonly mid: number | null;
  readonly high: number | null;
  readonly baseline: number | null;
  readonly openDays: number | null;
  readonly reasons: readonly ReasonFields[];
}

/** A row to write, as the import builds it from the file. */
export type ForecastRowInput = Omit<ForecastRow, 'runId'>;

/** What the import writes on a new run. */
export interface RunInput {
  readonly id: string;
  readonly file: ForecastRunFile;
  readonly fileSha256: string;
  readonly importedBy: string;
  readonly now: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ForecastStore {
  /** The run of this file for the location, if one was imported. */
  findByFile(scope: OrgScope, locationId: string, fileSha256: string): Promise<ForecastRunRecord | null>;
  /**
   * Inserts the run as `importing` with the input's id, or finds the one this file already made (a retry, or the
   * winner of two concurrent imports). `inserted` says which.
   */
  upsertRun(scope: OrgScope, locationId: string, input: RunInput): Promise<{ run: ForecastRunRecord; inserted: boolean }>;
  /** Upserts the rows on their unique key without changing any that exist, so a retry writes only the missing ones. */
  writeRows(scope: OrgScope, locationId: string, runId: string, rows: readonly ForecastRowInput[]): Promise<void>;
  countRows(scope: OrgScope, runId: string): Promise<number>;
  /** Compare-and-set: moves the run from one of `from` to `to`, with the time and staff id that go with it. */
  setStatus(scope: OrgScope, runId: string, change: { from: readonly RunStatus[]; to: RunStatus; at: Date; by: string | null }): Promise<boolean>;
  find(scope: OrgScope, runId: string): Promise<ForecastRunRecord | null>;
  /** Newest import first, at most `limit`. */
  list(scope: OrgScope, limit: number): Promise<ForecastRunRecord[]>;
  /** The location's published runs, newest `dataThrough` first (then newest published). */
  published(scope: OrgScope, locationId: string): Promise<ForecastRunRecord[]>;
  /** Rows of these runs of the location that overlap [from, to], or all of them when no range is given. */
  rows(scope: OrgScope, locationId: string, runIds: readonly string[], range?: { from: string; to: string }): Promise<ForecastRow[]>;
  /** The run's rows, then the run, so a retry finishes. False when the run was not there. */
  remove(scope: OrgScope, runId: string): Promise<boolean>;
  /** Location deletion and deleting its sales data (spec 10.7). Resolves the number of runs deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number of runs deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type RunDoc = RunFields & { _id: Types.ObjectId };
type RowDoc = RowFields & { _id: Types.ObjectId };

function toRun(doc: RunDoc): ForecastRunRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    metric: doc.metric,
    model: { family: doc.model.family, version: doc.model.version, notebookCommit: doc.model.notebookCommit },
    trainingSource: doc.trainingSource,
    trainedFrom: doc.trainedFrom,
    dataThrough: doc.dataThrough,
    madeAt: doc.madeAt,
    frozen: doc.frozen !== null,
    interval: { level: 0.8, widened: doc.interval.widened },
    backtest: doc.backtest === null ? null : {
      from: doc.backtest.from, to: doc.backtest.to, weeks: doc.backtest.weeks,
      weeklyTypicalErrorPct: doc.backtest.weeklyTypicalErrorPct, weeksOver20Pct: doc.backtest.weeksOver20Pct,
      weeklyRangePct: doc.backtest.weeklyRangePct === null ? null : { below: doc.backtest.weeklyRangePct.below, above: doc.backtest.weeklyRangePct.above },
    },
    range: { from: doc.range.from, to: doc.range.to },
    dayCount: doc.dayCount,
    weekCount: doc.weekCount,
    status: doc.status,
    importedBy: doc.importedBy,
    importedAt: doc.importedAt,
    publishedAt: doc.publishedAt,
    withdrawnAt: doc.withdrawnAt,
  };
}

function toRow(doc: RowDoc): ForecastRow {
  return {
    runId: doc.runId.toHexString(), span: doc.span, from: doc.from, to: doc.to, status: doc.status, low: doc.low, mid: doc.mid,
    high: doc.high, baseline: doc.baseline, openDays: doc.openDays,
    reasons: doc.reasons.map((reason) => ({ kind: reason.kind, ref: reason.ref, effectPct: reason.effectPct })),
  };
}

/** The run's stored fields besides its key (organization, location, file hash) and status, field by field from the file. */
function runFields(input: RunInput): Omit<RunFields, 'orgId' | 'locationId' | 'fileSha256' | 'status'> {
  const { file } = input;
  const first = file.days.reduce((min, day) => (day.date < min ? day.date : min), file.days[0]?.date ?? '');
  const last = file.days.reduce((max, day) => (day.date > max ? day.date : max), first);
  const { backtest } = file;
  return {
    metric: file.metric,
    model: { family: file.model.family, version: file.model.version, notebookCommit: file.model.notebookCommit },
    trainingSource: file.trainingSource,
    trainedFrom: file.trainedFrom,
    dataThrough: file.dataThrough,
    madeAt: file.madeAt,
    frozen: file.frozen === null ? null : { files: file.frozen.files.map((each) => ({ name: each.name, sha256: each.sha256 })) },
    interval: { level: file.interval.level, widened: file.interval.widened },
    backtest: backtest === null ? null : {
      from: backtest.from, to: backtest.to, weeks: backtest.weeks, weeklyTypicalErrorPct: backtest.weeklyTypicalErrorPct,
      weeksOver20Pct: backtest.weeksOver20Pct,
      weeklyRangePct: backtest.weeklyRangePct === null ? null : { below: backtest.weeklyRangePct.below, above: backtest.weeklyRangePct.above },
    },
    range: { from: first, to: last },
    dayCount: file.days.length,
    weekCount: file.weeks.length,
    importedBy: input.importedBy,
    publishedBy: null,
    importedAt: input.now,
    publishedAt: null,
    withdrawnAt: null,
  };
}

const STATUS_TIME: Partial<Record<RunStatus, 'publishedAt' | 'withdrawnAt'>> = { published: 'publishedAt', withdrawn: 'withdrawnAt' };

export function createForecastStore(connection: Connection): ForecastStore {
  const Run = forecastRunModel(connection);
  const Row = forecastModel(connection);
  const org = (scope: OrgScope) => ({ orgId: new Types.ObjectId(scope.orgId) });
  const ofRun = (scope: OrgScope, runId: string) => ({ ...org(scope), _id: new Types.ObjectId(runId) });

  return {
    async findByFile(scope, locationId, fileSha256) {
      const doc = await Run.findOne({ ...org(scope), locationId: new Types.ObjectId(locationId), fileSha256 }).lean();
      return doc === null ? null : toRun(doc);
    },
    async upsertRun(scope, locationId, input) {
      const key = { ...org(scope), locationId: new Types.ObjectId(locationId), fileSha256: input.fileSha256 };
      try {
        const doc = await Run.findOneAndUpdate(
          key,
          { $setOnInsert: { _id: new Types.ObjectId(input.id), ...runFields(input), status: 'importing' } },
          { upsert: true, returnDocument: 'after' },
        ).lean();
        // The id is set only on insert, so a run with another id was there already.
        return { run: toRun(doc), inserted: doc._id.toHexString() === input.id };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // Two imports of the same file raced; the other one made the run.
        const winner = await Run.findOne(key).lean();
        if (winner === null) throw err;
        return { run: toRun(winner), inserted: false };
      }
    },
    async writeRows(scope, locationId, runId, rows) {
      if (rows.length === 0) return;
      const base = { ...org(scope), locationId: new Types.ObjectId(locationId), runId: new Types.ObjectId(runId) };
      await Row.bulkWrite(rows.map((row) => ({
        updateOne: {
          filter: { ...base, span: row.span, from: row.from },
          update: {
            $setOnInsert: {
              to: row.to, status: row.status, low: row.low, mid: row.mid, high: row.high, baseline: row.baseline,
              openDays: row.openDays, reasons: row.reasons.map((reason) => ({ kind: reason.kind, ref: reason.ref, effectPct: reason.effectPct })),
            },
          },
          upsert: true,
        },
      })), { ordered: false });
    },
    countRows(scope, runId) {
      return Row.countDocuments({ ...org(scope), runId: new Types.ObjectId(runId) });
    },
    async setStatus(scope, runId, change) {
      const set: Partial<RunFields> = { status: change.to };
      const time = STATUS_TIME[change.to];
      if (time !== undefined) set[time] = change.at;
      if (change.to === 'published') set.publishedBy = change.by;
      const result = await Run.updateOne({ ...ofRun(scope, runId), status: trusted({ $in: [...change.from] }) }, { $set: set });
      return result.modifiedCount === 1;
    },
    async find(scope, runId) {
      const doc = await Run.findOne(ofRun(scope, runId)).lean();
      return doc === null ? null : toRun(doc);
    },
    async list(scope, limit) {
      const docs = await Run.find(org(scope)).sort({ importedAt: -1, _id: -1 }).limit(limit).lean();
      return docs.map(toRun);
    },
    async published(scope, locationId) {
      const docs = await Run.find({ ...org(scope), locationId: new Types.ObjectId(locationId), status: 'published' })
        .sort({ dataThrough: -1, publishedAt: -1, _id: -1 })
        .lean();
      return docs.map(toRun);
    },
    async rows(scope, locationId, runIds, range) {
      if (runIds.length === 0) return [];
      const filter: Record<string, unknown> = {
        ...org(scope), locationId: new Types.ObjectId(locationId), runId: trusted({ $in: runIds.map((id) => new Types.ObjectId(id)) }),
      };
      if (range !== undefined) {
        filter.from = trusted({ $lte: range.to });
        filter.to = trusted({ $gte: range.from });
      }
      const docs = await Row.find(filter).sort({ from: 1, span: 1 }).lean();
      return docs.map(toRow);
    },
    async remove(scope, runId) {
      await Row.deleteMany({ ...org(scope), runId: new Types.ObjectId(runId) });
      return (await Run.deleteOne(ofRun(scope, runId))).deletedCount === 1;
    },
    async removeForLocation(scope, locationId) {
      const location = { ...org(scope), locationId: new Types.ObjectId(locationId) };
      await Row.deleteMany(location);
      return (await Run.deleteMany(location)).deletedCount;
    },
    async removeForOrg(scope) {
      await Row.deleteMany(org(scope));
      return (await Run.deleteMany(org(scope))).deletedCount;
    },
  };
}
