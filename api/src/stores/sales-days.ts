// tw_sales_days (spec 6.5, 11.4): one row per location per business day, holding only the guest count and net
// sales. The schema is strict: 'throw', and the write path builds each row field by field, so nothing else can be
// stored. Nothing here logs.
//
// D28, the read rule: coverage, coverageByLocation, months, days and history leave out the days whose upload (the one
// that last wrote the day) is turned off, with no fallback to an earlier upload's values, which no longer exist.
// hasAny, hasAnyForOrg, apply and the deletes see every day.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { uploadModel } from './uploads.ts';

export const SALES_DAYS_COLLECTION = 'tw_sales_days';

/** A day with guests or net sales (spec 10.1 Coverage). */
export const HAS_VALUE = { $or: [{ guests: { $ne: null } }, { netSalesCents: { $ne: null } }] };
/**
 * HAS_VALUE for a model's find filters, which are sanitized and would drop its operators: each operator copied and
 * marked trusted(), so the two cannot drift.
 */
const HAS_VALUE_FILTER = {
  $or: HAS_VALUE.$or.map((clause) => Object.fromEntries(Object.entries(clause).map(([field, op]) => [field, trusted({ ...op })]))),
};

export interface SalesDayFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  date: string;
  guests: number | null;
  netSalesCents: number | null;
  /** The upload that last wrote this day. */
  uploadId: Types.ObjectId;
  updatedAt: Date;
}

function salesDaySchema(): Schema<SalesDayFields> {
  // No defaults: an upsert's insert holds exactly the filter's three keys, _id and the four written fields.
  const schema = new Schema<SalesDayFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    guests: { type: Number },
    netSalesCents: { type: Number },
    uploadId: { type: Schema.Types.ObjectId, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, date: 1 }, { unique: true });
  // D28: the days an upload still holds (Your data's "in use" count, and deleting one upload).
  schema.index({ orgId: 1, uploadId: 1 });
  return schema;
}

/** Registers TwSalesDay (tw_sales_days) on first call. */
export function salesDayModel(connection: Connection): Model<SalesDayFields> {
  const existing = connection.models.TwSalesDay as Model<SalesDayFields> | undefined;
  return existing ?? connection.model<SalesDayFields>('TwSalesDay', salesDaySchema(), SALES_DAYS_COLLECTION);
}

/** Spec 10.1. */
export interface SalesDay { date: string; guests: number | null; netSalesCents: number | null }

/** A stored day with the upload that last wrote it (spec 10.10, the history route). */
export interface SalesDayWithUpload extends SalesDay { uploadId: string }

/** Spec 10.1. */
export interface Coverage {
  dayCount: number;
  guestsDayCount: number;
  netSalesDayCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Days between first and last with no row. */
  missingDays: number;
}

export const NO_COVERAGE: Coverage = {
  dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0,
};

/** Spec 10.4: sums run over the days that have a value; a month with no guest counts has guests null. */
export interface SalesMonth { month: string; dayCount: number; guests: number | null; netSalesCents: number | null }

const DAY_MS = 24 * 60 * 60 * 1000;

interface CoverageRow {
  _id: Types.ObjectId;
  days: number;
  guestsDays: number;
  netSalesDays: number;
  first: string;
  last: string;
}

interface MonthRow { _id: string; days: number; guestsDays: number; guests: number; netSalesDays: number; netSales: number }

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface SalesDayStore {
  /**
   * Coverage per location id, for the locations that have any day with a value, except the days a turned-off upload
   * holds (D28).
   */
  coverageByLocation(scope: OrgScope): Promise<Map<string, Coverage>>;
  /** The location's coverage, except the days a turned-off upload holds (D28). */
  coverage(scope: OrgScope, locationId: string): Promise<Coverage>;
  /** Oldest month first, except the days a turned-off upload holds (D28). */
  months(scope: OrgScope, locationId: string): Promise<SalesMonth[]>;
  /** The days from `from` to `to`, inclusive, oldest first, except the days a turned-off upload holds (D28). */
  days(scope: OrgScope, locationId: string, range: { from: string; to: string }): Promise<SalesDay[]>;
  /**
   * Every stored day of the location, oldest first, each with the upload that last wrote it, except the days a
   * turned-off upload holds (D28).
   */
  history(scope: OrgScope, locationId: string): Promise<SalesDayWithUpload[]>;
  /** D28: whether a turned-off upload holds any day at the location (so an empty read may be uploads turned off, not no history). */
  holdsOffDays(scope: OrgScope, locationId: string): Promise<boolean>;
  /** D28: per location id, how many days turned-off uploads hold; a location with none is left out. A count only. */
  offDayCountByLocation(scope: OrgScope): Promise<Map<string, number>>;
  /** D28: the dates from `from` to `to`, inclusive, whose day a turned-off upload holds, oldest first. */
  disabledDates(scope: OrgScope, locationId: string, range: { from: string; to: string }): Promise<string[]>;
  /**
   * Spec 11.4 step 2: one unordered bulkWrite of upserts keyed by { orgId, locationId, date }. `replace` sets each
   * day in full, nulls included; otherwise each day is written only if it does not exist yet. `matched` counts the
   * days that already existed.
   */
  apply(scope: OrgScope, locationId: string, input: {
    uploadId: string; days: readonly SalesDay[]; replace: boolean; now: Date;
  }): Promise<{ inserted: number; matched: number }>;
  hasAny(scope: OrgScope, locationId: string): Promise<boolean>;
  /** Whether any location of the organization has a day with a value (the welcome's “ready to set up”). */
  hasAnyForOrg(scope: OrgScope): Promise<boolean>;
  /**
   * D28: how many stored days each of `uploadIds` still holds (it last wrote them), turned off or not, by upload id. An
   * upload that holds none is left out.
   */
  ownedDayCounts(scope: OrgScope, uploadIds: readonly string[]): Promise<Map<string, number>>;
  /** D28: deletes the days the upload still holds at the location. Resolves the number deleted. */
  removeForUpload(scope: OrgScope, locationId: string, uploadId: string): Promise<number>;
  /** Resolves the number of days deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createSalesDayStore(connection: Connection): SalesDayStore {
  const SalesDay = salesDayModel(connection);
  const Upload = uploadModel(connection);

  /** The ids of the organization's turned-off uploads, at the location when one is given (D28). */
  async function offIds(scope: OrgScope, locationId: string | null): Promise<Types.ObjectId[]> {
    const docs = await Upload.find({
      orgId: scope.orgId, ...(locationId === null ? {} : { locationId }), disabledAt: trusted({ $type: 'date' }),
    }, { _id: 1 }).lean();
    return docs.map((doc) => doc._id);
  }

  /** The read rule's clause for an aggregate's $match: empty when nothing is turned off. */
  const onlyOn = (ids: readonly Types.ObjectId[]) => (ids.length === 0 ? {} : { uploadId: { $nin: [...ids] } });
  /** The same clause for a model's find filter, marked trusted() as HAS_VALUE_FILTER is. */
  const onlyOnFilter = (ids: readonly Types.ObjectId[]) => (ids.length === 0 ? {} : { uploadId: trusted({ $nin: [...ids] }) });

  async function coverageRows(scope: OrgScope, locationId: string | null): Promise<Map<string, Coverage>> {
    const match = locationId === null ? { orgId: new Types.ObjectId(scope.orgId) } : ofLocation(scope, locationId);
    const ids = await offIds(scope, locationId);
    const rows = await connection.collection(SALES_DAYS_COLLECTION).aggregate<CoverageRow>([
      { $match: { ...match, ...HAS_VALUE, ...onlyOn(ids) } },
      {
        $group: {
          _id: '$locationId',
          days: { $sum: 1 },
          guestsDays: { $sum: { $cond: [{ $gt: ['$guests', null] }, 1, 0] } },
          netSalesDays: { $sum: { $cond: [{ $gt: ['$netSalesCents', null] }, 1, 0] } },
          first: { $min: '$date' },
          last: { $max: '$date' },
        },
      },
    ]).toArray();
    return new Map(rows.map((row) => {
      const span = (Date.parse(row.last) - Date.parse(row.first)) / DAY_MS + 1;
      return [row._id.toHexString(), {
        dayCount: row.days,
        guestsDayCount: row.guestsDays,
        netSalesDayCount: row.netSalesDays,
        firstDate: row.first,
        lastDate: row.last,
        missingDays: span - row.days,
      }];
    }));
  }

  const ofLocation = (scope: OrgScope, locationId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
  });

  return {
    coverageByLocation(scope) {
      return coverageRows(scope, null);
    },
    async coverage(scope, locationId) {
      return (await coverageRows(scope, locationId)).get(locationId) ?? NO_COVERAGE;
    },
    async months(scope, locationId) {
      const ids = await offIds(scope, locationId);
      const rows = await connection.collection(SALES_DAYS_COLLECTION).aggregate<MonthRow>([
        { $match: { ...ofLocation(scope, locationId), ...HAS_VALUE, ...onlyOn(ids) } },
        {
          $group: {
            _id: { $substrBytes: ['$date', 0, 7] },
            days: { $sum: 1 },
            guestsDays: { $sum: { $cond: [{ $gt: ['$guests', null] }, 1, 0] } },
            guests: { $sum: '$guests' },
            netSalesDays: { $sum: { $cond: [{ $gt: ['$netSalesCents', null] }, 1, 0] } },
            netSales: { $sum: '$netSalesCents' },
          },
        },
        { $sort: { _id: 1 } },
      ]).toArray();
      return rows.map((row) => ({
        month: row._id,
        dayCount: row.days,
        guests: row.guestsDays === 0 ? null : row.guests,
        netSalesCents: row.netSalesDays === 0 ? null : row.netSales,
      }));
    },
    async days(scope, locationId, range) {
      const ids = await offIds(scope, locationId);
      const docs = await SalesDay
        .find({ ...ofLocation(scope, locationId), date: trusted({ $gte: range.from, $lte: range.to }), ...onlyOnFilter(ids) })
        .sort({ date: 1 })
        .lean();
      return docs.map((doc) => ({ date: doc.date, guests: doc.guests ?? null, netSalesCents: doc.netSalesCents ?? null }));
    },
    async history(scope, locationId) {
      const ids = await offIds(scope, locationId);
      const docs = await SalesDay
        .find({ ...ofLocation(scope, locationId), ...onlyOnFilter(ids) }, { _id: 0, date: 1, guests: 1, netSalesCents: 1, uploadId: 1 })
        .sort({ date: 1 })
        .lean();
      return docs.map((doc) => ({
        date: doc.date, guests: doc.guests ?? null, netSalesCents: doc.netSalesCents ?? null, uploadId: doc.uploadId.toHexString(),
      }));
    },
    async offDayCountByLocation(scope) {
      const ids = await offIds(scope, null);
      if (ids.length === 0) return new Map();
      const rows = await connection.collection(SALES_DAYS_COLLECTION).aggregate<{ _id: Types.ObjectId; days: number }>([
        { $match: { orgId: new Types.ObjectId(scope.orgId), uploadId: { $in: ids } } },
        { $group: { _id: '$locationId', days: { $sum: 1 } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row.days]));
    },
    async holdsOffDays(scope, locationId) {
      const ids = await offIds(scope, locationId);
      if (ids.length === 0) return false;
      return (await SalesDay.exists({ ...ofLocation(scope, locationId), uploadId: trusted({ $in: ids }) })) !== null;
    },
    async disabledDates(scope, locationId, range) {
      const ids = await offIds(scope, locationId);
      if (ids.length === 0) return [];
      const docs = await SalesDay
        .find({
          ...ofLocation(scope, locationId), date: trusted({ $gte: range.from, $lte: range.to }), uploadId: trusted({ $in: ids }),
        }, { _id: 0, date: 1 })
        .sort({ date: 1 })
        .lean();
      return docs.map((doc) => doc.date);
    },
    async apply(scope, locationId, input) {
      const key = ofLocation(scope, locationId);
      const uploadId = new Types.ObjectId(input.uploadId);
      const result = await SalesDay.bulkWrite(input.days.map((day) => {
        const fields = { guests: day.guests, netSalesCents: day.netSalesCents, uploadId, updatedAt: input.now };
        return {
          updateOne: {
            filter: { ...key, date: day.date },
            update: input.replace ? { $set: fields } : { $setOnInsert: fields },
            upsert: true,
          },
        };
      }), { ordered: false });
      return { inserted: result.upsertedCount, matched: result.matchedCount };
    },
    async hasAny(scope, locationId) {
      return (await SalesDay.exists(ofLocation(scope, locationId))) !== null;
    },
    async hasAnyForOrg(scope) {
      return (await SalesDay.exists({ orgId: new Types.ObjectId(scope.orgId), ...HAS_VALUE_FILTER })) !== null;
    },
    async ownedDayCounts(scope, uploadIds) {
      if (uploadIds.length === 0) return new Map();
      const rows = await connection.collection(SALES_DAYS_COLLECTION).aggregate<{ _id: Types.ObjectId; days: number }>([
        { $match: { orgId: new Types.ObjectId(scope.orgId), uploadId: { $in: uploadIds.map((id) => new Types.ObjectId(id)) } } },
        { $group: { _id: '$uploadId', days: { $sum: 1 } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row.days]));
    },
    async removeForUpload(scope, locationId, uploadId) {
      return (await SalesDay.deleteMany({ ...ofLocation(scope, locationId), uploadId: new Types.ObjectId(uploadId) })).deletedCount;
    },
    async removeForLocation(scope, locationId) {
      return (await SalesDay.deleteMany(ofLocation(scope, locationId))).deletedCount;
    },
    async removeForOrg(scope) {
      return (await SalesDay.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
