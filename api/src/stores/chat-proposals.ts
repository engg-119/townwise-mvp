// tw_chat_proposals (spec 6.16, docs/portal/tuning-chat.md section 2): what the author did with each note TownwiseAI
// proposed in their conversation, keyed by the propose_note call's id. No row means the proposal is still open. A
// save claims the row (`saving`), writes the note with the row's `noteId`, then marks it `saved`, so a retry or a
// second tab finishes the same note instead of making another (handlers/chat-proposals.ts). Every row gets its
// `noteId` when it is inserted, a dismissed one too. Holds no note content.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const CHAT_PROPOSALS_COLLECTION = 'tw_chat_proposals';

export type ProposalStatus = 'saving' | 'saved' | 'dismissed';

interface ProposalFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: string;
  proposalId: string;
  status: ProposalStatus;
  noteId: Types.ObjectId;
  edited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function proposalSchema(): Schema<ProposalFields> {
  const schema = new Schema<ProposalFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    proposalId: { type: String, required: true },
    status: { type: String, required: true, enum: ['saving', 'saved', 'dismissed'] },
    noteId: { type: Schema.Types.ObjectId, required: true },
    edited: { type: Boolean, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, conversationId: 1, proposalId: 1 }, { unique: true });
  schema.index({ orgId: 1, locationId: 1 });
  return schema;
}

/** Registers TwChatProposal (tw_chat_proposals) on first call. */
export function chatProposalModel(connection: Connection): Model<ProposalFields> {
  const existing = connection.models.TwChatProposal as Model<ProposalFields> | undefined;
  return existing ?? connection.model<ProposalFields>('TwChatProposal', proposalSchema(), CHAT_PROPOSALS_COLLECTION);
}

export interface ProposalRecord {
  readonly proposalId: string;
  readonly status: ProposalStatus;
  readonly noteId: string;
  readonly edited: boolean;
}

/** One proposal: the conversation it was made in and its propose_note call's id. */
export interface ProposalKey {
  readonly conversationId: string;
  readonly proposalId: string;
}

/** Who made the conversation, for a row's first insert. */
export interface ProposalOwner {
  readonly locationId: string;
  readonly userId: string;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ChatProposalStore {
  /** Every row of the conversation. */
  list(scope: OrgScope, conversationId: string): Promise<ProposalRecord[]>;
  find(scope: OrgScope, key: ProposalKey): Promise<ProposalRecord | null>;
  /**
   * Claims the proposal for a save: inserts it as `saving`, or moves a `saving` or `dismissed` row to `saving`,
   * keeping its `noteId`. Null when it is already saved.
   */
  claimSave(scope: OrgScope, key: ProposalKey, input: ProposalOwner & { edited: boolean; now: Date }): Promise<ProposalRecord | null>;
  /** `saving` to `saved`. */
  markSaved(scope: OrgScope, key: ProposalKey, now: Date): Promise<void>;
  /** Sets the proposal aside, unless it is saved. Resolves the row either way. */
  dismiss(scope: OrgScope, key: ProposalKey, input: ProposalOwner & { now: Date }): Promise<ProposalRecord>;
  /** Resolves the number deleted. */
  removeForConversation(scope: OrgScope, conversationId: string): Promise<number>;
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type ProposalDoc = ProposalFields & { _id: Types.ObjectId };

function toRecord(doc: ProposalDoc): ProposalRecord {
  return { proposalId: doc.proposalId, status: doc.status, noteId: doc.noteId.toHexString(), edited: doc.edited };
}

export function createChatProposalStore(connection: Connection): ChatProposalStore {
  const Proposal = chatProposalModel(connection);
  const keyOf = (scope: OrgScope, key: ProposalKey) => ({
    orgId: new Types.ObjectId(scope.orgId), conversationId: new Types.ObjectId(key.conversationId), proposalId: key.proposalId,
  });
  const inserted = (owner: ProposalOwner, now: Date) => ({
    locationId: new Types.ObjectId(owner.locationId), userId: owner.userId, noteId: new Types.ObjectId(), createdAt: now,
  });
  /**
   * Moves a row that is not saved to `status`, inserting it when there is none. Null when it is saved: the filter then
   * matches nothing, so the insert fails on the unique index. The first of two concurrent inserts fails the same way,
   * so a duplicate is tried once more, and then matches the row the other made.
   */
  const moveUnlessSaved = async (
    scope: OrgScope, key: ProposalKey, update: { status: ProposalStatus; edited?: boolean }, owner: ProposalOwner, now: Date,
  ): Promise<ProposalRecord | null> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const doc = await Proposal.findOneAndUpdate(
          { ...keyOf(scope, key), status: trusted({ $ne: 'saved' }) },
          {
            $set: { ...update, updatedAt: now },
            $setOnInsert: { ...inserted(owner, now), ...(update.edited === undefined ? { edited: false } : {}) },
          },
          { upsert: true, returnDocument: 'after' },
        ).lean();
        return toRecord(doc);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        if (attempt === 1) return null;
      }
    }
  };
  return {
    async list(scope, conversationId) {
      const docs = await Proposal.find({
        orgId: new Types.ObjectId(scope.orgId), conversationId: new Types.ObjectId(conversationId),
      }).lean();
      return docs.map(toRecord);
    },
    async find(scope, key) {
      const doc = await Proposal.findOne(keyOf(scope, key)).lean();
      return doc === null ? null : toRecord(doc);
    },
    claimSave(scope, key, input) {
      return moveUnlessSaved(scope, key, { status: 'saving', edited: input.edited }, input, input.now);
    },
    async markSaved(scope, key, now) {
      await Proposal.updateOne({ ...keyOf(scope, key), status: 'saving' }, { $set: { status: 'saved', updatedAt: now } });
    },
    async dismiss(scope, key, input) {
      const moved = await moveUnlessSaved(scope, key, { status: 'dismissed' }, input, input.now);
      if (moved !== null) return moved;
      const saved = await Proposal.findOne(keyOf(scope, key)).lean();
      if (saved === null) throw new Error('a saved proposal was not found');
      return toRecord(saved);
    },
    async removeForConversation(scope, conversationId) {
      const result = await Proposal.deleteMany({
        orgId: new Types.ObjectId(scope.orgId), conversationId: new Types.ObjectId(conversationId),
      });
      return result.deletedCount;
    },
    async removeForLocation(scope, locationId) {
      const result = await Proposal.deleteMany({
        orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
      });
      return result.deletedCount;
    },
    async removeForOrg(scope) {
      return (await Proposal.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
