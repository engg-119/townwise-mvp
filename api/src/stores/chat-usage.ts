// tw_chat_usage (docs/portal/tuning-chat.md section 5): what the tuning chat has cost each organization per calendar
// month (UTC), in whole micro-dollars. One document per { orgId, month }, only ever $inc'd.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

interface ChatUsageFields {
  orgId: Types.ObjectId;
  /** YYYY-MM, UTC. */
  month: string;
  costMicroUsd: number;
  updatedAt: Date;
}

function chatUsageSchema(): Schema<ChatUsageFields> {
  const schema = new Schema<ChatUsageFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    month: { type: String, required: true },
    costMicroUsd: { type: Number, required: true },
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
  /** Adds a cost to the month, creating its document on first use. */
  add(scope: OrgScope, month: string, costMicroUsd: number, now: Date): Promise<void>;
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
  };
}
