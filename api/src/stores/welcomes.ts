// tw_welcomes (spec 6.15): that a person was shown the welcome statement in an organization, and when. A display
// marker, not an action, so it has no audit event. Deleted with the organization and with the person.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const WELCOMES_COLLECTION = 'tw_welcomes';

interface WelcomeFields {
  orgId: Types.ObjectId;
  /** The kit user id, a string as in tw_access_requests and tw_chat_conversations. */
  userId: string;
  seenAt: Date;
}

function welcomeSchema(): Schema<WelcomeFields> {
  const schema = new Schema<WelcomeFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    seenAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, userId: 1 }, { unique: true });
  return schema;
}

/** Registers TwWelcome (tw_welcomes) on first call. */
export function welcomeModel(connection: Connection): Model<WelcomeFields> {
  const existing = connection.models.TwWelcome as Model<WelcomeFields> | undefined;
  return existing ?? connection.model<WelcomeFields>('TwWelcome', welcomeSchema(), WELCOMES_COLLECTION);
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface WelcomeStore {
  has(scope: OrgScope, userId: string): Promise<boolean>;
  /** An upsert with $setOnInsert, so a retry or a race keeps the first time (no transactions on DocumentDB). */
  record(scope: OrgScope, userId: string, now: Date): Promise<void>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

export function createWelcomeStore(connection: Connection): WelcomeStore {
  const Welcome = welcomeModel(connection);
  return {
    async has(scope, userId) {
      return (await Welcome.exists({ orgId: new Types.ObjectId(scope.orgId), userId })) !== null;
    },
    async record(scope, userId, now) {
      const filter = { orgId: new Types.ObjectId(scope.orgId), userId };
      try {
        await Welcome.updateOne(filter, { $setOnInsert: { seenAt: now } }, { upsert: true });
      } catch (err) {
        // Two first records raced on the unique index; the other one wrote the same marker.
        if (!isDuplicateKeyError(err)) throw err;
      }
    },
    async removeForOrg(scope) {
      return (await Welcome.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}

