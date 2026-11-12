// tw_uploads (spec 6.6): one record per sales upload, with counts and dates only. It holds no file name (file names
// can contain people's names), no column names, no row count and no figures.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { AiSource } from './files.ts';

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
  /**
   * Days a member's upload, or a TownwiseAI read's (anyone's, spec 11A.9: it only adds), left unchanged because they
   * already had data; always 0 for an org admin's own.
   */
  kept: number;
  firstDate: string;
  lastDate: string;
  hasGuests: boolean;
  hasNetSales: boolean;
  /** True on an upload Townwise staff made during setup (D23), with their user id as `uploadedBy`; absent otherwise. */
  byStaff?: boolean;
  /**
   * D28: when the upload was turned off, and by whom. Absent means on; never stored as null, so the partial index holds
   * only turned-off uploads. Its days stay stored, and every sales read leaves them out (stores/sales-days.ts).
   */
  disabledAt?: Date;
  disabledBy?: string;
  /**
   * Spec 11A.9: an upload TownwiseAI wrote from the daily totals of a file someone let it read, and that file (Your data
   * lists it as `townwise_ai`). Absent otherwise.
   */
  source?: { via: 'ai_file'; fileId: Types.ObjectId };
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
    disabledAt: { type: Date },
    disabledBy: { type: String },
    source: {
      type: new Schema({
        via: { type: String, required: true, enum: ['ai_file'] }, fileId: { type: Schema.Types.ObjectId, required: true },
      }, { _id: false, strict: 'throw' }),
    },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, uploadedAt: -1 });
  // D28: the turned-off uploads, which every sales read looks up first.
  schema.index({ orgId: 1, disabledAt: 1 }, { partialFilterExpression: { disabledAt: { $type: 'date' } } });
  return schema;
}

/** Registers TwUpload (tw_uploads) on first call. */
export function uploadModel(connection: Connection): Model<UploadFields> {
  const existing = connection.models.TwUpload as Model<UploadFields> | undefined;
  return existing ?? connection.model<UploadFields>('TwUpload', uploadSchema(), UPLOADS_COLLECTION);
}

export interface UploadRecord {
  readonly id: string;
  readonly locationId: string;
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
  /** D28: null while the upload is on. */
  readonly disabledAt: Date | null;
  readonly disabledBy: string | null;
  /** Spec 11A.9: written by TownwiseAI from this file's daily totals; null for any other upload. */
  readonly source: AiSource | null;
}

export interface UploadCounts { readonly inserted: number; readonly replaced: number; readonly kept: number }

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface UploadStore {
  /** The newest applied upload's time per location id. */
  lastUploadByLocation(scope: OrgScope): Promise<Map<string, Date>>;
  /**
   * Spec 11.4 step 1: the record, as `applying`, before any day is written. `id`, when given, is the id a staff event
   * written before it already names (or a TownwiseAI read's plan); `byStaff` marks staff setup's (D23), and `source` one
   * TownwiseAI wrote from a file (spec 11A.9).
   */
  start(scope: OrgScope, locationId: string, input: {
    id?: string; uploadedBy: string; uploadedAt: Date; dayCount: number; firstDate: string; lastDate: string;
    hasGuests: boolean; hasNetSales: boolean; byStaff?: boolean; source?: AiSource;
  }): Promise<UploadRecord>;
  /** Spec 11.4 step 3. */
  finish(scope: OrgScope, uploadId: string, counts: UploadCounts): Promise<void>;
  /** Newest first. */
  recent(scope: OrgScope, locationId: string, limit: number): Promise<UploadRecord[]>;
  /** The location's uploads among `ids`, newest first; an id with no record is left out. */
  byIds(scope: OrgScope, locationId: string, ids: readonly string[]): Promise<UploadRecord[]>;
  /** The location's upload, or null (another location's or organization's answers null too). */
  get(scope: OrgScope, locationId: string, uploadId: string): Promise<UploadRecord | null>;
  /**
   * D28: turns the location's upload off (sets `disabledAt` and `disabledBy`) or on (unsets both), in one update.
   * Resolves the record after it, or null when there is no such upload at the location.
   */
  setEnabled(scope: OrgScope, locationId: string, uploadId: string, input: { enabled: boolean; by: string; at: Date }): Promise<UploadRecord | null>;
  /**
   * D28, Your data: the uploads at the location (or across the organization, for null), newest first by (uploadedAt, id),
   * each strictly before `before` in that order.
   */
  page(scope: OrgScope, input: { locationId: string | null; before: { at: Date; id: string } | null; limit: number }): Promise<UploadRecord[]>;
  /** D28: deletes the location's upload record. False when there was none. */
  remove(scope: OrgScope, locationId: string, uploadId: string): Promise<boolean>;
  /** Spec 11A.9: the location's uploads TownwiseAI wrote from `fileId` (an undo deletes them). */
  fromAiRead(scope: OrgScope, locationId: string, fileId: string): Promise<UploadRecord[]>;
  /** Resolves the number of records deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

function toUpload(doc: UploadFields & { _id: Types.ObjectId }): UploadRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
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
    disabledAt: doc.disabledAt ?? null,
    disabledBy: doc.disabledBy ?? null,
    source: doc.source === undefined ? null : { via: 'ai_file', fileId: doc.source.fileId.toHexString() },
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
        ...(input.source === undefined ? {} : { source: { via: 'ai_file', fileId: new Types.ObjectId(input.source.fileId) } }),
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
    async get(scope, locationId, uploadId) {
      const doc = await Upload.findOne({ _id: uploadId, orgId: scope.orgId, locationId }).lean();
      return doc === null ? null : toUpload(doc);
    },
    async setEnabled(scope, locationId, uploadId, input) {
      const doc = await Upload.findOneAndUpdate(
        { _id: uploadId, orgId: scope.orgId, locationId },
        input.enabled ? { $unset: { disabledAt: 1, disabledBy: 1 } } : { $set: { disabledAt: input.at, disabledBy: input.by } },
        { returnDocument: 'after' },
      ).lean();
      return doc === null ? null : toUpload(doc);
    },
    async page(scope, input) {
      const filter: Record<string, unknown> = { orgId: scope.orgId };
      if (input.locationId !== null) filter.locationId = input.locationId;
      if (input.before !== null) {
        filter.$or = [
          { uploadedAt: trusted({ $lt: input.before.at }) },
          { uploadedAt: input.before.at, _id: trusted({ $lt: input.before.id }) },
        ];
      }
      const docs = await Upload.find(filter).sort({ uploadedAt: -1, _id: -1 }).limit(input.limit).lean();
      return docs.map(toUpload);
    },
    async remove(scope, locationId, uploadId) {
      return (await Upload.deleteOne({ _id: uploadId, orgId: scope.orgId, locationId })).deletedCount === 1;
    },
    async fromAiRead(scope, locationId, fileId) {
      const docs = await Upload.find({ orgId: scope.orgId, locationId, 'source.fileId': new Types.ObjectId(fileId) }).lean();
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
