// tw_forecast_weeks (D42, spec 6.26): one row per location per week the weekly refresh considered it, unique on
// { orgId, locationId, week } so a week starts a location's calibration at most once. `week` is the Monday in the town's
// time zone. A start writes `starting` before it launches, then `started` with the calibration's id, or `start_failed`;
// a skip writes its reason (`unchanged`, `not_enough_history`, `cap_reached`). Every change is a compare-and-set from
// `starting` (no transactions, D17), so a pass that dies between the insert and the start leaves a row the next pass
// resolves (lab/schedule.ts). The weekly cap and the stale rows are counted across organizations in
// stores/cross-tenant.ts. Ids, dates and codes only; nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const FORECAST_WEEKS_COLLECTION = 'tw_forecast_weeks';

export type ForecastWeekStatus = 'starting' | 'started' | 'start_failed' | 'unchanged' | 'not_enough_history' | 'cap_reached';
export const FORECAST_WEEK_STATUSES: readonly ForecastWeekStatus[] = [
  'starting', 'started', 'start_failed', 'unchanged', 'not_enough_history', 'cap_reached',
];
/** The rows the weekly cap counts: the starts of the week, made or in flight. */
export const COUNTED_WEEK_STATUSES: readonly ForecastWeekStatus[] = ['starting', 'started'];

export interface ForecastWeekFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  /** The Monday, YYYY-MM-DD, in the town's time zone. */
  week: string;
  status: ForecastWeekStatus;
  calibrationId: string | null;
  /** The fingerprint the pass compared (lab/input.ts labInputFingerprint); null where it never got that far. */
  dataSha256: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function forecastWeekSchema(): Schema<ForecastWeekFields> {
  const schema = new Schema<ForecastWeekFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    week: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, required: true, enum: FORECAST_WEEK_STATUSES },
    calibrationId: { type: String, default: null },
    dataSha256: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, week: 1 }, { unique: true });
  schema.index({ week: 1, status: 1 });
  schema.index({ status: 1, createdAt: 1 });
  return schema;
}

/** Registers TwForecastWeek (tw_forecast_weeks) on first call. */
export function forecastWeekModel(connection: Connection): Model<ForecastWeekFields> {
  const existing = connection.models.TwForecastWeek as Model<ForecastWeekFields> | undefined;
  return existing ?? connection.model<ForecastWeekFields>('TwForecastWeek', forecastWeekSchema(), FORECAST_WEEKS_COLLECTION);
}

export interface ForecastWeekRecord {
  readonly id: string;
  readonly locationId: string;
  readonly week: string;
  readonly status: ForecastWeekStatus;
  readonly calibrationId: string | null;
  readonly dataSha256: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ForecastWeekStore {
  /** Inserts the location's row for the week; false when the week already has one (unique index). */
  insert(scope: OrgScope, input: {
    locationId: string; week: string; status: ForecastWeekStatus; dataSha256: string | null; now: Date;
  }): Promise<boolean>;
  find(scope: OrgScope, locationId: string, week: string): Promise<ForecastWeekRecord | null>;
  /** Compare-and-set from `starting` to `started` (with the calibration's id) or `start_failed`. */
  resolve(scope: OrgScope, id: string, outcome: { status: 'started'; calibrationId: string } | { status: 'start_failed' }, now: Date): Promise<boolean>;
  /** Removes a `starting` row whose start never happened because another calibration held the location. */
  removeStarting(scope: OrgScope, id: string): Promise<boolean>;
  /** The newest row of each location of the organization, from `sinceWeek` on (the staff console). */
  latestByLocation(scope: OrgScope, sinceWeek: string): Promise<ForecastWeekRecord[]>;
  /** Location deletion. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion. Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type ForecastWeekDoc = ForecastWeekFields & { _id: Types.ObjectId };

function toWeek(doc: ForecastWeekDoc): ForecastWeekRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    week: doc.week,
    status: doc.status,
    calibrationId: doc.calibrationId,
    dataSha256: doc.dataSha256,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createForecastWeekStore(connection: Connection): ForecastWeekStore {
  const Week = forecastWeekModel(connection);
  const org = (scope: OrgScope) => ({ orgId: new Types.ObjectId(scope.orgId) });
  const ofId = (scope: OrgScope, id: string) => ({ ...org(scope), _id: new Types.ObjectId(id) });
  return {
    async insert(scope, input) {
      try {
        await Week.create({
          ...org(scope), locationId: new Types.ObjectId(input.locationId), week: input.week, status: input.status,
          calibrationId: null, dataSha256: input.dataSha256, createdAt: input.now, updatedAt: input.now,
        });
        return true;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },
    async find(scope, locationId, week) {
      const doc = await Week.findOne({ ...org(scope), locationId: new Types.ObjectId(locationId), week }).lean();
      return doc === null ? null : toWeek(doc);
    },
    async resolve(scope, id, outcome, now) {
      const result = await Week.updateOne(
        { ...ofId(scope, id), status: 'starting' },
        { $set: { status: outcome.status, calibrationId: outcome.status === 'started' ? outcome.calibrationId : null, updatedAt: now } },
      );
      return result.modifiedCount === 1;
    },
    async removeStarting(scope, id) {
      return (await Week.deleteOne({ ...ofId(scope, id), status: 'starting' })).deletedCount === 1;
    },
    async latestByLocation(scope, sinceWeek) {
      const docs = await Week.find({ ...org(scope), week: trusted({ $gte: sinceWeek }) }).sort({ week: -1, _id: -1 }).lean();
      const latest = new Map<string, ForecastWeekRecord>();
      for (const doc of docs) {
        const record = toWeek(doc);
        if (!latest.has(record.locationId)) latest.set(record.locationId, record);
      }
      return [...latest.values()];
    },
    async removeForLocation(scope, locationId) {
      return (await Week.deleteMany({ ...org(scope), locationId: new Types.ObjectId(locationId) })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Week.deleteMany(org(scope))).deletedCount;
    },
  };
}
