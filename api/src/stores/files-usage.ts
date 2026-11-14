// tw_files_usage (spec 6.13): what the AI column step of the file reader (spec 11A) and reading with TownwiseAI (spec
// 11A.9) have cost each organization per calendar month (UTC), in whole micro-dollars, apart from the tuning chat's
// (tw_chat_usage) so neither budget eats the other's. One document per { orgId, month }, only ever $inc'd: a TownwiseAI
// read reserves its most it can cost before its call and is corrected to what the call cost after it.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

interface FilesUsageFields {
  orgId: Types.ObjectId;
  /** YYYY-MM, UTC. */
  month: string;
  costMicroUsd: number;
  updatedAt: Date;
}

function filesUsageSchema(): Schema<FilesUsageFields> {
  const schema = new Schema<FilesUsageFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    month: { type: String, required: true },
    costMicroUsd: { type: Number, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, month: 1 }, { unique: true });
  return schema;
}

/** Registers TwFilesUsage (tw_files_usage) on first call. */
export function filesUsageModel(connection: Connection): Model<FilesUsageFields> {
  const existing = connection.models.TwFilesUsage as Model<FilesUsageFields> | undefined;
  return existing ?? connection.model<FilesUsageFields>('TwFilesUsage', filesUsageSchema(), 'tw_files_usage');
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface FilesUsageStore {
  /** The month's cost so far; 0 when nothing was spent. */
  costMicroUsd(scope: OrgScope, month: string): Promise<number>;
  /** Adds a cost to the month (a negative one corrects a reservation), creating its document on first use. */
  add(scope: OrgScope, month: string, costMicroUsd: number, now: Date): Promise<void>;
  /**
   * Adds `costMicroUsd` to the month in one compare-and-set only while the month stays within `budgetMicroUsd` with it
   * (concurrent reservations cannot pass the budget together). False, adding nothing, when it would pass.
   */
  reserve(scope: OrgScope, month: string, costMicroUsd: number, budgetMicroUsd: number, now: Date): Promise<boolean>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createFilesUsageStore(connection: Connection): FilesUsageStore {
  const Usage = filesUsageModel(connection);
  return {
    async costMicroUsd(scope, month) {
      const doc = await Usage.findOne({ orgId: new Types.ObjectId(scope.orgId), month }).lean();
      return doc?.costMicroUsd ?? 0;
    },
    async add(scope, month, costMicroUsd, now) {
      const filter = { orgId: new Types.ObjectId(scope.orgId), month };
      const update = { $inc: { costMicroUsd }, $set: { updatedAt: now } };
      try {
        await Usage.updateOne(filter, update, { upsert: true });
      } catch (err) {
        // Two first costs of a month raced on the unique index; the other one created the document.
        if (!isDuplicateKeyError(err)) throw err;
        await Usage.updateOne(filter, update);
      }
    },
    async reserve(scope, month, costMicroUsd, budgetMicroUsd, now) {
      const key = { orgId: new Types.ObjectId(scope.orgId), month };
      const fits = { ...key, costMicroUsd: trusted({ $lte: budgetMicroUsd - costMicroUsd }) };
      const update = { $inc: { costMicroUsd }, $set: { updatedAt: now } };
      if ((await Usage.updateOne(fits, update)).matchedCount === 1) return true;
      if (costMicroUsd > budgetMicroUsd) return false;
      try {
        // The month's first cost: its document does not exist yet (or is over the budget, which the index answers).
        await Usage.create({ ...key, costMicroUsd, updatedAt: now });
        return true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        return (await Usage.updateOne(fits, update)).matchedCount === 1;
      }
    },
    async removeForOrg(scope) {
      return (await Usage.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
