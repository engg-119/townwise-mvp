// tw_uploads (spec 6.6): one record per sales upload, with counts and dates only. It holds no file name (file names
// can contain people's names), no column names, no row count and no figures.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const UPLOADS_COLLECTION = 'tw_uploads';

export interface UploadFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  uploadedBy: string;
  uploadedAt: Date;
  /** `applying` until every day is written; a crash leaves it, and the Sales data tab says so. */
  status: 'applying' | 'applied';
  dayCount: number;
  inserted: number;
  replaced: number;
  /** Days a member's upload left unchanged because they already had data; always 0 for an org admin's. */
  kept: number;
  firstDate: string;
  lastDate: string;
  hasGuests: boolean;
  hasNetSales: boolean;
  /** True on an upload Townwise staff made during setup (D23), with their user id as `uploadedBy`; absent otherwise. */
  byStaff?: boolean;
}

function uploadSchema(): Schema<UploadFields> {
  const schema = new Schema<UploadFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    uploadedBy: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
    status: { type: String, required: true, enum: ['applying', 'applied'] },
    dayCount: { type: Number, required: true },
    inserted: { type: Number, required: true },
    replaced: { type: Number, required: true },
    kept: { type: Number, required: true },
    firstDate: { type: String, required: true },
    lastDate: { type: String, required: true },
    hasGuests: { type: Boolean, required: true },
    hasNetSales: { type: Boolean, required: true },
    byStaff: { type: Boolean },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, uploadedAt: -1 });
  return schema;
}

/** Registers TwUpload (tw_uploads) on first call. */
export function uploadModel(connection: Connection): Model<UploadFields> {
  const existing = connection.models.TwUpload as Model<UploadFields> | undefined;
  return existing ?? connection.model<UploadFields>('TwUpload', uploadSchema(), UPLOADS_COLLECTION);
}

export interface UploadRecord {
  readonly id: string;
  readonly uploadedBy: string;
  readonly uploadedAt: Date;
  readonly status: 'applying' | 'applied';
  readonly dayCount: number;
  readonly inserted: number;
  readonly replaced: number;
  readonly kept: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly hasGuests: boolean;
  readonly hasNetSales: boolean;
  /** Staff setup's (D23): every view names the uploader "Townwise staff". */
  readonly byStaff: boolean;
}

export interface UploadCounts { readonly inserted: number; readonly replaced: number; readonly kept: number }

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface UploadStore {
  /** The newest applied upload's time per location id. */
  lastUploadByLocation(scope: OrgScope): Promise<Map<string, Date>>;
  /**
   * Spec 11.4 step 1: the record, as `applying`, before any day is written. `id`, when given, is the id a staff event
   * written before it already names; `byStaff` marks staff setup's (D23).
   */
  start(scope: OrgScope, locationId: string, input: {
    id?: string; uploadedBy: string; uploadedAt: Date; dayCount: number; firstDate: string; lastDate: string;
    hasGuests: boolean; hasNetSales: boolean; byStaff?: boolean;
  }): Promise<UploadRecord>;
  /** Spec 11.4 step 3. */
  finish(scope: OrgScope, uploadId: string, counts: UploadCounts): Promise<void>;
  /** Newest first. */
  recent(scope: OrgScope, locationId: string, limit: number): Promise<UploadRecord[]>;
  /** The location's uploads among `ids`, newest first; an id with no record is left out. */
  byIds(scope: OrgScope, locationId: string, ids: readonly string[]): Promise<UploadRecord[]>;
  /** Resolves the number of records deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

function toUpload(doc: UploadFields & { _id: Types.ObjectId }): UploadRecord {
  return {
    id: doc._id.toHexString(),
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
    status: doc.status,
    dayCount: doc.dayCount,
    inserted: doc.inserted,
    replaced: doc.replaced,
    kept: doc.kept,
    firstDate: doc.firstDate,
    lastDate: doc.lastDate,
    hasGuests: doc.hasGuests,
    hasNetSales: doc.hasNetSales,
    byStaff: doc.byStaff === true,
  };
}

export function createUploadStore(connection: Connection): UploadStore {
  const Upload = uploadModel(connection);
  return {
    async lastUploadByLocation(scope) {
      const rows = await connection.collection(UPLOADS_COLLECTION).aggregate<{ _id: Types.ObjectId; last: Date }>([
        { $match: { orgId: new Types.ObjectId(scope.orgId), status: 'applied' } },
        { $group: { _id: '$locationId', last: { $max: '$uploadedAt' } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row.last]));
    },
    async start(scope, locationId, input) {
      const doc = await Upload.create({
        ...(input.id === undefined ? {} : { _id: new Types.ObjectId(input.id) }),
        orgId: scope.orgId, locationId, uploadedBy: input.uploadedBy, uploadedAt: input.uploadedAt, status: 'applying',
        dayCount: input.dayCount, inserted: 0, replaced: 0, kept: 0, firstDate: input.firstDate, lastDate: input.lastDate,
        hasGuests: input.hasGuests, hasNetSales: input.hasNetSales, ...(input.byStaff === true ? { byStaff: true } : {}),
      });
      return toUpload(doc.toObject());
    },
    async finish(scope, uploadId, counts) {
      await Upload.updateOne(
        { _id: uploadId, orgId: scope.orgId },
        { $set: { status: 'applied', inserted: counts.inserted, replaced: counts.replaced, kept: counts.kept } },
      );
    },
    async recent(scope, locationId, limit) {
      const docs = await Upload.find({ orgId: scope.orgId, locationId }).sort({ uploadedAt: -1, _id: -1 }).limit(limit).lean();
      return docs.map(toUpload);
    },
    async byIds(scope, locationId, ids) {
      if (ids.length === 0) return [];
      const docs = await Upload.find({ orgId: scope.orgId, locationId, _id: trusted({ $in: [...ids] }) }).sort({ uploadedAt: -1, _id: -1 }).lean();
      return docs.map(toUpload);
    },
    async removeForLocation(scope, locationId) {
      return (await Upload.deleteMany({ orgId: scope.orgId, locationId })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Upload.deleteMany({ orgId: scope.orgId })).deletedCount;
    },
  };
}
