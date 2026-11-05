// tw_chat_live_turns (docs/portal/tuning-chat.md, "Built"): at most one live tuning chat turn per person per
// organization, whatever the conversation or location. One document per { orgId, userId } under a unique index, so of
// two concurrent claims only one can win. A turn claims it with its server turn id and releases it by that id on every
// exit; a claim older than the stale limit may be taken over.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

interface LiveTurnFields {
  orgId: Types.ObjectId;
  userId: string;
  turnId: string;
  startedAt: Date;
}

function liveTurnSchema(): Schema<LiveTurnFields> {
  const schema = new Schema<LiveTurnFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    turnId: { type: String, required: true },
    startedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, userId: 1 }, { unique: true });
  return schema;
}

/** Registers TwChatLiveTurn (tw_chat_live_turns) on first call. */
export function chatLiveTurnModel(connection: Connection): Model<LiveTurnFields> {
  const existing = connection.models.TwChatLiveTurn as Model<LiveTurnFields> | undefined;
  return existing ?? connection.model<LiveTurnFields>('TwChatLiveTurn', liveTurnSchema(), 'tw_chat_live_turns');
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ChatLiveTurnStore {
  /**
   * Claims the person's one live turn for `turnId`. True when they had none, or only one that started before
   * `staleBefore` (taken over); false while another turn holds it.
   */
  claim(scope: OrgScope, userId: string, input: { turnId: string; now: Date; staleBefore: Date }): Promise<boolean>;
  /** Drops the claim while `turnId` still holds it; a claim another turn took over stays. */
  release(scope: OrgScope, userId: string, turnId: string): Promise<void>;
}

export function createChatLiveTurnStore(connection: Connection): ChatLiveTurnStore {
  const LiveTurn = chatLiveTurnModel(connection);
  const heldBy = (scope: OrgScope, userId: string) => ({ orgId: new Types.ObjectId(scope.orgId), userId });
  return {
    async claim(scope, userId, input) {
      try {
        // The filter matches only a stale claim, which is taken over; with no claim at all the upsert inserts one. A
        // live claim matches nothing, so the insert fails on the unique index, as the second of two first claims does.
        await LiveTurn.updateOne(
          { ...heldBy(scope, userId), startedAt: trusted({ $lt: input.staleBefore }) },
          { $set: { turnId: input.turnId, startedAt: input.now } },
          { upsert: true },
        );
        return true;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },
    async release(scope, userId, turnId) {
      await LiveTurn.deleteOne({ ...heldBy(scope, userId), turnId });
    },
  };
}
