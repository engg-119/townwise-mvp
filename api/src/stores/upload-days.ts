// tw_upload_days (spec 6.19): bytes each organization has started uploading per UTC day, so the daily cap holds across
// replicas and people. One document per { orgId, day }, reserved by a conditional $inc. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

interface UploadDayFields {
  orgId: Types.ObjectId;
  /** YYYY-MM-DD, UTC. */
  day: string;
  bytes: number;
  updatedAt: Date;
}

function uploadDaySchema(): Schema<UploadDayFields> {
  const schema = new Schema<UploadDayFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    bytes: { type: Number, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, day: 1 }, { unique: true });
  return schema;
}

/** Registers TwUploadDay (tw_upload_days) on first call. */
export function uploadDayModel(connection: Connection): Model<UploadDayFields> {
  const existing = connection.models.TwUploadDay as Model<UploadDayFields> | undefined;
  return existing ?? connection.model<UploadDayFields>('TwUploadDay', uploadDaySchema(), 'tw_upload_days');
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface UploadDayStore {
  /** Bytes reserved so far today. */
  used(scope: OrgScope, day: string): Promise<number>;
  /** Reserves `bytes` unless the day would pass `cap`. False when it would. */
  reserve(scope: OrgScope, day: string, bytes: number, cap: number, now: Date): Promise<boolean>;
  /** Gives back a canceled upload's bytes (same UTC day only). */
  refund(scope: OrgScope, day: string, bytes: number, now: Date): Promise<void>;
  /** Organization deletion (spec 10.7). */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createUploadDayStore(connection: Connection): UploadDayStore {
  const UploadDay = uploadDayModel(connection);
  const key = (scope: OrgScope, day: string) => ({ orgId: new Types.ObjectId(scope.orgId), day });
  return {
    async used(scope, day) {
      return (await UploadDay.findOne(key(scope, day)).lean())?.bytes ?? 0;
    },
    async reserve(scope, day, bytes, cap, now) {
      try {
        await UploadDay.updateOne(key(scope, day), { $setOnInsert: { bytes: 0, updatedAt: now } }, { upsert: true });
      } catch (err) {
        // Two first uploads of the day raced on the unique index; the other one created the document.
        if (!isDuplicateKeyError(err)) throw err;
      }
      const result = await UploadDay.updateOne(
        { ...key(scope, day), bytes: trusted({ $lte: cap - bytes }) },
        { $inc: { bytes }, $set: { updatedAt: now } },
      );
      return result.matchedCount === 1;
    },
    async removeForOrg(scope) {
      return (await UploadDay.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
    async refund(scope, day, bytes, now) {
      await UploadDay.updateOne({ ...key(scope, day), bytes: trusted({ $gte: bytes }) }, { $inc: { bytes: -bytes }, $set: { updatedAt: now } });
    },
  };
}
