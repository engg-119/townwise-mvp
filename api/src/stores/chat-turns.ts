// tw_chat_turns (openspec change resumable-chat-turns, design decision 2): one record per TownwiseAI turn while it runs
// and for 15 minutes after it ends, so a reader that reattaches sees what the turn's stream showed. It holds the
// stream's own events, numbered from 1, never the raw API messages, so nothing a save elides (D28, D36, D39) is kept.
// Each write is a compare-and-set on the record still `running` (and an append also on the count stored), so a write
// that applied but reported an error is never doubled and a write to a settled or deleted record matches nothing. The
// events and the person's message are the same class of data as the conversation: never logged or audited from here.
import { Schema, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const CHAT_TURNS_COLLECTION = 'tw_chat_turns';

export type TurnState = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';
export type EndedTurnState = Exclude<TurnState, 'running'>;

/** One event the turn's stream sent, with its number: `type` is the SSE event name and `data` its JSON. */
export interface TurnRecordEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}

/** The person's message as they wrote it, for display while the turn runs: its text and its attachments' `f_` refs. */
export interface LiveTurnMessage {
  readonly text: string;
  readonly attachments: readonly string[];
}

/** What a turn's record starts with, once both live-turn claims are held. */
export interface NewChatTurn {
  readonly locationId: string;
  readonly conversationId: string;
  readonly userId: string;
  /** The claims' turn id. */
  readonly turnId: string;
  /** Null for a regenerate. */
  readonly userNodeId: string | null;
  readonly replyNodeId: string;
  /** Where the turn's first new node hangs, as the `conversation` event says. */
  readonly parentId: string | null;
  /** Null for a regenerate. */
  readonly message: LiveTurnMessage | null;
  readonly startedAt: Date;
  readonly leaseUntil: Date;
}

export interface ChatTurnRecord extends NewChatTurn {
  readonly state: TurnState;
  readonly stopRequested: boolean;
  readonly endedAt: Date | null;
  readonly eventCount: number;
  readonly events: readonly TurnRecordEvent[];
}

interface TurnFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: string;
  turnId: string;
  state: TurnState;
  leaseUntil: Date;
  stopRequested: boolean;
  startedAt: Date;
  endedAt: Date | null;
  userNodeId: string | null;
  replyNodeId: string;
  parentId: string | null;
  message: { text: string; attachments: string[] } | null;
  events: { seq: number; type: string; data: unknown }[];
  eventCount: number;
}

function turnSchema(): Schema<TurnFields> {
  const event = new Schema({
    seq: { type: Number, required: true },
    type: { type: String, required: true },
    data: { type: Schema.Types.Mixed },
  }, { _id: false, strict: true });
  const message = new Schema({
    text: { type: String, required: true },
    attachments: { type: [String], default: [] },
  }, { _id: false, strict: true });
  const schema = new Schema<TurnFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    turnId: { type: String, required: true },
    state: { type: String, enum: ['running', 'done', 'failed', 'stopped', 'interrupted'], required: true },
    leaseUntil: { type: Date, required: true },
    stopRequested: { type: Boolean, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    userNodeId: { type: String, default: null },
    replyNodeId: { type: String, required: true },
    parentId: { type: String, default: null },
    message: { type: message, default: null },
    events: { type: [event], default: [] },
    eventCount: { type: Number, required: true },
  }, { strict: true, versionKey: false, read: 'primary', minimize: false });
  schema.index({ orgId: 1, turnId: 1 }, { unique: true });
  schema.index({ orgId: 1, conversationId: 1 });
  schema.index({ orgId: 1, locationId: 1 });
  // Person deletion, across organizations (stores/cross-tenant.ts).
  schema.index({ userId: 1 });
  // The sweep: running records whose lease has passed.
  schema.index({ state: 1, leaseUntil: 1 });
  // The sweep: records 15 minutes after their turn ended.
  schema.index({ endedAt: 1 });
  return schema;
}

/** Registers TwChatTurn (tw_chat_turns) on first call. */
export function chatTurnModel(connection: Connection): Model<TurnFields> {
  const existing = connection.models.TwChatTurn as Model<TurnFields> | undefined;
  return existing ?? connection.model<TurnFields>('TwChatTurn', turnSchema(), CHAT_TURNS_COLLECTION);
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ChatTurnStore {
  /** A running record with no events. Rejects a second record for the same turn id in the organization. */
  insert(scope: OrgScope, turn: NewChatTurn): Promise<void>;
  /**
   * Appends `events` (numbered from `from + 1`) and renews the lease, only while the record is running and holds exactly
   * `from` events. False when it matched nothing: the record ended, was deleted, or already holds more (a write that
   * applied but reported an error; `progress` tells which).
   */
  append(scope: OrgScope, turnId: string, input: { from: number; events: readonly TurnRecordEvent[]; leaseUntil: Date }): Promise<boolean>;
  /** Renews the lease while the record is running. False when it ended or was deleted. */
  renew(scope: OrgScope, turnId: string, leaseUntil: Date): Promise<boolean>;
  /**
   * Appends the last events, the terminal one last, and sets the ended state, in one update, only while the record is
   * running and holds exactly `from` events. False when it matched nothing, as `append`.
   */
  end(scope: OrgScope, turnId: string, input: { from: number; events: readonly TurnRecordEvent[]; state: EndedTurnState; endedAt: Date }): Promise<boolean>;
  /** The record's state and how many events it holds, else null (deleted, or another organization's). */
  progress(scope: OrgScope, turnId: string): Promise<{ state: TurnState; eventCount: number } | null>;
  /**
   * Sets the stop flag on the author's running turn of this conversation. Resolves the record's state (`running` when
   * the flag is set, else the state it ended in), or null when it is not the author's turn of that conversation.
   */
  requestStop(scope: OrgScope, owner: { conversationId: string; userId: string }, turnId: string): Promise<TurnState | null>;
  /** True while the record is running with its stop flag set. */
  stopRequested(scope: OrgScope, turnId: string): Promise<boolean>;
  /**
   * The conversation's turn with only its events numbered above `after`, else null. Read whole (design "As built": no
   * `$slice` with a skip on DocumentDB), at most about 1 MB.
   */
  readAfter(scope: OrgScope, conversationId: string, turnId: string, after: number): Promise<ChatTurnRecord | null>;
  /** With its conversation. Resolves the number deleted. */
  removeForConversation(scope: OrgScope, conversationId: string): Promise<number>;
  /** With its location, whoever wrote it. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type TurnDoc = TurnFields & { _id: Types.ObjectId };

function toRecord(doc: TurnDoc, after: number): ChatTurnRecord {
  return {
    locationId: doc.locationId.toHexString(), conversationId: doc.conversationId.toHexString(), userId: doc.userId,
    turnId: doc.turnId, userNodeId: doc.userNodeId ?? null, replyNodeId: doc.replyNodeId, parentId: doc.parentId ?? null,
    message: doc.message === null ? null : { text: doc.message.text, attachments: [...doc.message.attachments] },
    startedAt: doc.startedAt, leaseUntil: doc.leaseUntil, state: doc.state, stopRequested: doc.stopRequested,
    endedAt: doc.endedAt ?? null, eventCount: doc.eventCount,
    events: doc.events.filter((event) => event.seq > after).map((event) => ({ seq: event.seq, type: event.type, data: event.data ?? {} })),
  };
}

export function createChatTurnStore(connection: Connection): ChatTurnStore {
  const Turn = chatTurnModel(connection);
  const org = (scope: OrgScope) => ({ orgId: new Types.ObjectId(scope.orgId) });
  const running = (scope: OrgScope, turnId: string) => ({ ...org(scope), turnId, state: 'running' as const });
  const pushed = (events: readonly TurnRecordEvent[]) => ({
    events: { $each: events.map((event) => ({ seq: event.seq, type: event.type, data: event.data })) },
  });
  return {
    async insert(scope, turn) {
      await Turn.create({
        ...org(scope), locationId: new Types.ObjectId(turn.locationId), conversationId: new Types.ObjectId(turn.conversationId),
        userId: turn.userId, turnId: turn.turnId, state: 'running', leaseUntil: turn.leaseUntil, stopRequested: false,
        startedAt: turn.startedAt, endedAt: null, userNodeId: turn.userNodeId, replyNodeId: turn.replyNodeId, parentId: turn.parentId,
        message: turn.message === null ? null : { text: turn.message.text, attachments: [...turn.message.attachments] },
        events: [], eventCount: 0,
      });
    },
    async append(scope, turnId, input) {
      const result = await Turn.updateOne({ ...running(scope, turnId), eventCount: input.from }, {
        $push: pushed(input.events),
        $set: { eventCount: input.from + input.events.length, leaseUntil: input.leaseUntil },
      });
      return result.matchedCount === 1;
    },
    async renew(scope, turnId, leaseUntil) {
      return (await Turn.updateOne(running(scope, turnId), { $set: { leaseUntil } })).matchedCount === 1;
    },
    async end(scope, turnId, input) {
      const result = await Turn.updateOne({ ...running(scope, turnId), eventCount: input.from }, {
        $push: pushed(input.events),
        $set: { eventCount: input.from + input.events.length, state: input.state, endedAt: input.endedAt },
      });
      return result.matchedCount === 1;
    },
    async progress(scope, turnId) {
      const doc = await Turn.findOne({ ...org(scope), turnId }, { state: 1, eventCount: 1 }).lean();
      return doc === null ? null : { state: doc.state, eventCount: doc.eventCount };
    },
    async requestStop(scope, owner, turnId) {
      const mine = {
        ...org(scope), turnId, conversationId: new Types.ObjectId(owner.conversationId), userId: owner.userId,
      };
      const set = await Turn.updateOne({ ...mine, state: 'running' }, { $set: { stopRequested: true } });
      if (set.matchedCount === 1) return 'running';
      const doc = await Turn.findOne(mine, { state: 1 }).lean();
      return doc?.state ?? null;
    },
    async stopRequested(scope, turnId) {
      const doc = await Turn.findOne(running(scope, turnId), { stopRequested: 1 }).lean();
      return doc?.stopRequested === true;
    },
    async readAfter(scope, conversationId, turnId, after) {
      const doc = await Turn.findOne({ ...org(scope), conversationId: new Types.ObjectId(conversationId), turnId }).lean();
      return doc === null ? null : toRecord(doc, after);
    },
    async removeForConversation(scope, conversationId) {
      return (await Turn.deleteMany({ ...org(scope), conversationId: new Types.ObjectId(conversationId) })).deletedCount;
    },
    async removeForLocation(scope, locationId) {
      return (await Turn.deleteMany({ ...org(scope), locationId: new Types.ObjectId(locationId) })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Turn.deleteMany(org(scope))).deletedCount;
    },
  };
}
