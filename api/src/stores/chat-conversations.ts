// tw_chat_conversations (docs/portal/tuning-chat.md section 5): one person's tuning chat about one location. Each
// stored message is one Anthropic API message param, kept as the JSON the model sent or received, so every block
// (thinking blocks included) goes back to the API exactly as it came. History is append-only: a finished turn is one
// $push, and nothing here edits or drops an earlier message. Message text never reaches a log from here.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const CHAT_CONVERSATIONS_COLLECTION = 'tw_chat_conversations';

/** One API message param as JSON, and when it was produced. */
export interface StoredMessage {
  readonly at: Date;
  readonly param: string;
  /** The tree node the message belongs to (src/chat/tree.ts); absent on messages written before trees. */
  readonly nodeId?: string;
  /** The node's parent (null for a first message); read from the node's first message. */
  readonly parentId?: string | null;
}

export interface LiveTurn {
  readonly turnId: string;
  readonly startedAt: Date;
}

interface ConversationFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  userId: string;
  title: string;
  messages: StoredMessage[];
  activeLeafId: string | null;
  turnCount: number;
  liveTurn: LiveTurn | null;
  createdAt: Date;
  updatedAt: Date;
}

function conversationSchema(): Schema<ConversationFields> {
  const message = new Schema<StoredMessage>({
    at: { type: Date, required: true },
    param: { type: String, required: true },
    nodeId: { type: String },
    parentId: { type: String, default: undefined },
  }, { _id: false, strict: true });
  const liveTurn = new Schema<LiveTurn>({
    turnId: { type: String, required: true },
    startedAt: { type: Date, required: true },
  }, { _id: false, strict: true });
  const schema = new Schema<ConversationFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    title: { type: String, required: true },
    messages: { type: [message], default: [] },
    activeLeafId: { type: String, default: null },
    turnCount: { type: Number, required: true },
    liveTurn: { type: liveTurn, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, userId: 1, updatedAt: -1 });
  return schema;
}

/** Registers TwChatConversation (tw_chat_conversations) on first call. */
export function chatConversationModel(connection: Connection): Model<ConversationFields> {
  const existing = connection.models.TwChatConversation as Model<ConversationFields> | undefined;
  return existing ?? connection.model<ConversationFields>('TwChatConversation', conversationSchema(), CHAT_CONVERSATIONS_COLLECTION);
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: Date;
  readonly turnCount: number;
}

export interface ConversationRecord extends ConversationSummary {
  readonly messages: readonly StoredMessage[];
  readonly activeLeafId: string | null;
  readonly liveTurn: LiveTurn | null;
}

/** Whose conversation: every lookup matches the organization, the location and the author. */
export interface ConversationOwner {
  readonly locationId: string;
  readonly userId: string;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ChatConversationStore {
  /** The author's conversations about this location, newest `updatedAt` first, without their messages. */
  list(scope: OrgScope, owner: ConversationOwner, limit: number): Promise<ConversationSummary[]>;
  /** The author's conversation about this location, else null (anyone else's, or another location's, included). */
  find(scope: OrgScope, owner: ConversationOwner, conversationId: string): Promise<ConversationRecord | null>;
  /** A new conversation with no messages, claimed for its first turn. Resolves its id. */
  create(scope: OrgScope, owner: ConversationOwner, input: { title: string; turnId: string; now: Date }): Promise<string>;
  /**
   * Claims the conversation for a turn when it has no live turn, or one that started before `staleBefore`.
   * Resolves the claimed conversation, or null when it is gone or another turn holds it.
   */
  claim(scope: OrgScope, owner: ConversationOwner, conversationId: string, input: { turnId: string; now: Date; staleBefore: Date }):
    Promise<ConversationRecord | null>;
  /**
   * Appends a finished turn's messages and clears the claim, in one update, only while `turnId` still holds the
   * claim. False when it does not (the turn was taken over, or the conversation deleted).
   */
  finish(scope: OrgScope, conversationId: string, turnId: string, input: { messages: readonly StoredMessage[]; now: Date }): Promise<boolean>;
  /** Drops a failed turn's claim; a conversation that never finished a turn is deleted instead. */
  release(scope: OrgScope, conversationId: string, turnId: string): Promise<void>;
  remove(scope: OrgScope, owner: ConversationOwner, conversationId: string): Promise<boolean>;
  /** Every conversation about this location, whoever wrote it. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type ConversationDoc = ConversationFields & { _id: Types.ObjectId };

function toSummary(doc: Pick<ConversationDoc, '_id' | 'title' | 'updatedAt' | 'turnCount'>): ConversationSummary {
  return { id: doc._id.toHexString(), title: doc.title, updatedAt: doc.updatedAt, turnCount: doc.turnCount };
}

function toStored(message: StoredMessage): StoredMessage {
  return {
    at: message.at, param: message.param,
    ...(message.nodeId === undefined ? {} : { nodeId: message.nodeId }),
    ...(message.parentId === undefined ? {} : { parentId: message.parentId }),
  };
}

function toRecord(doc: ConversationDoc): ConversationRecord {
  return {
    ...toSummary(doc),
    messages: doc.messages.map(toStored),
    activeLeafId: doc.activeLeafId ?? null,
    liveTurn: doc.liveTurn === null ? null : { turnId: doc.liveTurn.turnId, startedAt: doc.liveTurn.startedAt },
  };
}

export function createChatConversationStore(connection: Connection): ChatConversationStore {
  const Conversation = chatConversationModel(connection);
  const ownedBy = (scope: OrgScope, owner: ConversationOwner) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(owner.locationId), userId: owner.userId,
  });
  const claimedBy = (scope: OrgScope, conversationId: string, turnId: string) => ({
    _id: new Types.ObjectId(conversationId), orgId: new Types.ObjectId(scope.orgId), 'liveTurn.turnId': turnId,
  });
  return {
    async list(scope, owner, limit) {
      const docs = await Conversation.find(ownedBy(scope, owner), { title: 1, updatedAt: 1, turnCount: 1 })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(limit)
        .lean();
      return docs.map(toSummary);
    },
    async find(scope, owner, conversationId) {
      const doc = await Conversation.findOne({ _id: new Types.ObjectId(conversationId), ...ownedBy(scope, owner) }).lean();
      return doc === null ? null : toRecord(doc);
    },
    async create(scope, owner, input) {
      const doc = await Conversation.create({
        ...ownedBy(scope, owner), title: input.title, messages: [], turnCount: 0,
        liveTurn: { turnId: input.turnId, startedAt: input.now }, createdAt: input.now, updatedAt: input.now,
      });
      return doc._id.toHexString();
    },
    async claim(scope, owner, conversationId, input) {
      const doc = await Conversation.findOneAndUpdate(
        {
          _id: new Types.ObjectId(conversationId), ...ownedBy(scope, owner),
          $or: [{ liveTurn: null }, { 'liveTurn.startedAt': trusted({ $lt: input.staleBefore }) }],
        },
        { $set: { liveTurn: { turnId: input.turnId, startedAt: input.now } } },
        { returnDocument: 'after' },
      ).lean();
      return doc === null ? null : toRecord(doc);
    },
    async finish(scope, conversationId, turnId, input) {
      const result = await Conversation.updateOne(claimedBy(scope, conversationId, turnId), {
        $push: { messages: { $each: input.messages.map(toStored) } },
        $inc: { turnCount: 1 },
        $set: { liveTurn: null, updatedAt: input.now },
      });
      return result.matchedCount === 1;
    },
    async release(scope, conversationId, turnId) {
      const removed = await Conversation.deleteOne({ ...claimedBy(scope, conversationId, turnId), turnCount: 0 });
      if (removed.deletedCount === 1) return;
      await Conversation.updateOne(claimedBy(scope, conversationId, turnId), { $set: { liveTurn: null } });
    },
    async remove(scope, owner, conversationId) {
      const result = await Conversation.deleteOne({ _id: new Types.ObjectId(conversationId), ...ownedBy(scope, owner) });
      return result.deletedCount === 1;
    },
    async removeForLocation(scope, locationId) {
      const result = await Conversation.deleteMany({
        orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
      });
      return result.deletedCount;
    },
    async removeForOrg(scope) {
      return (await Conversation.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
