// tw_chat_usage (docs/portal/tuning-chat.md section 5): what the tuning chat has cost each organization per calendar
// month (UTC), in whole micro-dollars. One document per { orgId, month }, only ever $inc'd. The weekly suggestions
// pass (lab/suggestions.ts) reserves its most before its call and corrects it to what the call cost after.
// D66: location research spends the same month, and `researchMicroUsd` counts its part of `costMicroUsd` (absent until
// the month's first research), reserved and settled in the same compare-and-set, so an automatic run is held to its
// share and leaves its headroom (design decision 7) without a second document to race.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

interface ChatUsageFields {
  orgId: Types.ObjectId;
  /** YYYY-MM, UTC. */
  month: string;
  costMicroUsd: number;
  /** D66: location research's part of costMicroUsd; absent until the month's first research. */
  researchMicroUsd?: number;
  updatedAt: Date;
}

function chatUsageSchema(): Schema<ChatUsageFields> {
  const schema = new Schema<ChatUsageFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    month: { type: String, required: true },
    costMicroUsd: { type: Number, required: true },
    researchMicroUsd: { type: Number },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, month: 1 }, { unique: true });
  return schema;
}

/** Registers TwChatUsage (tw_chat_usage) on first call. */
export function chatUsageModel(connection: Connection): Model<ChatUsageFields> {
  const existing = connection.models.TwChatUsage as Model<ChatUsageFields> | undefined;
  return existing ?? connection.model<ChatUsageFields>('TwChatUsage', chatUsageSchema(), 'tw_chat_usage');
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ChatUsageStore {
  /** The month's cost so far; 0 when nothing was spent. */
  costMicroUsd(scope: OrgScope, month: string): Promise<number>;
  /** Adds a cost to the month (a negative one corrects a reservation), creating its document on first use. */
  add(scope: OrgScope, month: string, costMicroUsd: number, now: Date): Promise<void>;
  /**
   * Adds `costMicroUsd` to the month in one compare-and-set only while the month stays within `budgetMicroUsd` with it
   * (concurrent reservations cannot pass the budget together). False, adding nothing, when it would pass.
   */
  reserve(scope: OrgScope, month: string, costMicroUsd: number, budgetMicroUsd: number, now: Date): Promise<boolean>;
  /** D66: location research's part of the month so far; 0 when it spent nothing. */
  researchMicroUsd(scope: OrgScope, month: string): Promise<number>;
  /**
   * D66: reserves a research thread's ceiling, counted in both the month and its research part, in one compare-and-set.
   * Every thread stays within `budgetMicroUsd`; an automatic one (weekly or early, not Research now) also keeps the
   * research part within `automatic.shareMicroUsd` and leaves `automatic.headroomMicroUsd` of the budget unspent. False,
   * adding nothing, when it would pass any of them.
   */
  reserveResearch(scope: OrgScope, month: string, costMicroUsd: number, limits: {
    budgetMicroUsd: number; automatic: { shareMicroUsd: number; headroomMicroUsd: number } | null;
  }, now: Date): Promise<boolean>;
  /**
   * D66: adds a research cost to the month and its research part (a negative one settles a reservation). Only to a month
   * a reservation made: a deleted organization's month is not recreated.
   */
  addResearch(scope: OrgScope, month: string, costMicroUsd: number, now: Date): Promise<void>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createChatUsageStore(connection: Connection): ChatUsageStore {
  const Usage = chatUsageModel(connection);
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
    async researchMicroUsd(scope, month) {
      const doc = await Usage.findOne({ orgId: new Types.ObjectId(scope.orgId), month }).lean();
      return doc?.researchMicroUsd ?? 0;
    },
    async reserveResearch(scope, month, costMicroUsd, limits, now) {
      const key = { orgId: new Types.ObjectId(scope.orgId), month };
      const limit = limits.budgetMicroUsd - (limits.automatic?.headroomMicroUsd ?? 0);
      const share = limits.automatic?.shareMicroUsd ?? null;
      if (costMicroUsd > limit || (share !== null && costMicroUsd > share)) return false;
      const fits = {
        ...key, costMicroUsd: trusted({ $lte: limit - costMicroUsd }),
        // `$not` matches a month with no research yet too (the field is absent there).
        ...(share === null ? {} : { researchMicroUsd: trusted({ $not: { $gt: share - costMicroUsd } }) }),
      };
      const update = { $inc: { costMicroUsd, researchMicroUsd: costMicroUsd }, $set: { updatedAt: now } };
      if ((await Usage.updateOne(fits, update)).matchedCount === 1) return true;
      try {
        // The month's first cost: its document does not exist yet (or is over a limit, which the index answers).
        await Usage.create({ ...key, costMicroUsd, researchMicroUsd: costMicroUsd, updatedAt: now });
        return true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        return (await Usage.updateOne(fits, update)).matchedCount === 1;
      }
    },
    async addResearch(scope, month, costMicroUsd, now) {
      // Never an upsert: every settle follows a reservation that created the month's document, so a missing one was
      // deleted with its organization (handlers/deletion.ts), and a late lane's refund must not bring it back.
      await Usage.updateOne(
        { orgId: new Types.ObjectId(scope.orgId), month },
        { $inc: { costMicroUsd, researchMicroUsd: costMicroUsd }, $set: { updatedAt: now } },
      );
    },
    async removeForOrg(scope) {
      return (await Usage.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
