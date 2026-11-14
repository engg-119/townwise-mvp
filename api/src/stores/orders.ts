// tw_order_decisions and tw_order_rules (Orders): what an owner changed on a line, and a rule they confirmed.
// A decision survives deleting the location's sales. It goes when the location or the organization goes.
// A turned-off rule stays, so the same reason is not proposed again.
// tw_order_cards: what the author did with each order change or rule TownwiseAI proposed in their conversation. A
// card goes with its conversation, and with the person who owned it (stores/cross-tenant.ts deletePersonRecords). A
// change card is claimed (`saving`) before its edit is stored, with the id that edit takes, so two saves of one card
// store one edit, and a retry after a failure in between completes it.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';

export const ORDER_DECISIONS_COLLECTION = 'tw_order_decisions';
export const ORDER_RULES_COLLECTION = 'tw_order_rules';
export const ORDER_CARDS_COLLECTION = 'tw_order_cards';

export interface DecisionRecord {
  readonly id: string;
  readonly itemId: string;
  readonly delivery: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly recommended: number;
  readonly quantity: number;
  readonly unit: string;
  readonly reason: string;
  readonly createdAt: Date;
}

export interface RuleRecord {
  readonly id: string;
  readonly itemId: string;
  readonly delta: number;
  readonly unit: string;
  readonly situation: string;
  readonly off: boolean;
  readonly createdAt: Date;
}

export type OrderCardKind = 'change' | 'rule';
/** `saving`: a change card's save claimed it and its edit may not be stored yet; the card still reads as open. */
export type OrderCardStatus = 'saving' | 'saved' | 'dismissed';

export interface OrderCardRecord {
  readonly proposalId: string;
  readonly kind: OrderCardKind;
  readonly status: OrderCardStatus;
  /** The id the change card's edit is stored under. */
  readonly decisionId: string;
}

interface DecisionFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  itemId: string;
  delivery: string;
  windowStart: string;
  windowEnd: string;
  recommended: number;
  quantity: number;
  unit: string;
  reason: string;
  createdAt: Date;
}

interface RuleFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  itemId: string;
  delta: number;
  unit: string;
  situation: string;
  off: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface CardFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  proposalId: string;
  kind: OrderCardKind;
  status: OrderCardStatus;
  decisionId: Types.ObjectId;
  createdAt: Date;
}

function decisionSchema(): Schema<DecisionFields> {
  const schema = new Schema<DecisionFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    itemId: { type: String, required: true },
    delivery: { type: String, required: true },
    windowStart: { type: String, required: true },
    windowEnd: { type: String, required: true },
    recommended: { type: Number, required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    reason: { type: String, required: true },
    createdAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  // The board reads the edits of its deliveries (today or later); a rule reads an item's latest edit.
  schema.index({ orgId: 1, locationId: 1, delivery: 1 });
  schema.index({ orgId: 1, locationId: 1, itemId: 1, createdAt: -1 });
  return schema;
}

function ruleSchema(): Schema<RuleFields> {
  const schema = new Schema<RuleFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    itemId: { type: String, required: true },
    delta: { type: Number, required: true },
    unit: { type: String, required: true },
    situation: { type: String, required: true },
    off: { type: Boolean, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, locationId: 1, itemId: 1, situation: 1 }, { unique: true });
  return schema;
}

function cardSchema(): Schema<CardFields> {
  const schema = new Schema<CardFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    proposalId: { type: String, required: true },
    kind: { type: String, required: true, enum: ['change', 'rule'] },
    status: { type: String, required: true, enum: ['saving', 'saved', 'dismissed'] },
    decisionId: { type: Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, required: true },
  }, { strict: true, versionKey: false, read: 'primary' });
  schema.index({ orgId: 1, conversationId: 1, proposalId: 1 }, { unique: true });
  // Location deletion removes a location's cards without scanning the organization's.
  schema.index({ orgId: 1, locationId: 1 });
  return schema;
}

function decisionModel(connection: Connection): Model<DecisionFields> {
  const existing = connection.models.TwOrderDecision as Model<DecisionFields> | undefined;
  return existing ?? connection.model<DecisionFields>('TwOrderDecision', decisionSchema(), ORDER_DECISIONS_COLLECTION);
}

function ruleModel(connection: Connection): Model<RuleFields> {
  const existing = connection.models.TwOrderRule as Model<RuleFields> | undefined;
  return existing ?? connection.model<RuleFields>('TwOrderRule', ruleSchema(), ORDER_RULES_COLLECTION);
}

/** Registers TwOrderCard (tw_order_cards) on first call. */
export function orderCardModel(connection: Connection): Model<CardFields> {
  const existing = connection.models.TwOrderCard as Model<CardFields> | undefined;
  return existing ?? connection.model<CardFields>('TwOrderCard', cardSchema(), ORDER_CARDS_COLLECTION);
}

type DecisionDoc = DecisionFields & { _id: Types.ObjectId };
type RuleDoc = RuleFields & { _id: Types.ObjectId };

function toDecision(doc: DecisionDoc): DecisionRecord {
  return {
    id: doc._id.toHexString(),
    itemId: doc.itemId,
    delivery: doc.delivery,
    windowStart: doc.windowStart,
    windowEnd: doc.windowEnd,
    recommended: doc.recommended,
    quantity: doc.quantity,
    unit: doc.unit,
    reason: doc.reason,
    createdAt: doc.createdAt,
  };
}

function toRule(doc: RuleDoc): RuleRecord {
  return {
    id: doc._id.toHexString(),
    itemId: doc.itemId,
    delta: doc.delta,
    unit: doc.unit,
    situation: doc.situation,
    off: doc.off,
    createdAt: doc.createdAt,
  };
}

export interface DecisionInput {
  /** The id to store it under (a change card's), so storing it twice stores it once. A new id when absent. */
  readonly id?: string;
  readonly itemId: string;
  readonly delivery: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly recommended: number;
  readonly quantity: number;
  readonly unit: string;
  readonly reason: string;
  readonly now: Date;
}

export interface RuleInput {
  readonly itemId: string;
  readonly delta: number;
  readonly unit: string;
  readonly situation: string;
  readonly now: Date;
}

export interface OrderCardKey {
  readonly conversationId: string;
  readonly proposalId: string;
}

export interface OrderStore {
  /** The edits for deliveries on or after `since`, newest first. */
  listDecisions(scope: OrgScope, locationId: string, since: string): Promise<DecisionRecord[]>;
  /** With an `id` already stored (a change card saved twice), the stored decision. */
  addDecision(scope: OrgScope, locationId: string, input: DecisionInput): Promise<DecisionRecord>;
  /** The newest decision for the item, or null. */
  latestDecision(scope: OrgScope, locationId: string, itemId: string): Promise<DecisionRecord | null>;
  listRules(scope: OrgScope, locationId: string): Promise<RuleRecord[]>;
  findRule(scope: OrgScope, locationId: string, itemId: string, situation: string): Promise<RuleRecord | null>;
  /**
   * Inserts the rule, or returns the one already stored for this item and situation, one saved meanwhile included.
   * `created` is true only for the call that inserted it.
   */
  addRule(scope: OrgScope, locationId: string, input: RuleInput): Promise<{ rule: RuleRecord; created: boolean }>;
  /** Marks the rule off. False when it is not this location's. */
  turnOff(scope: OrgScope, locationId: string, ruleId: string, now: Date): Promise<boolean>;
  findCard(scope: OrgScope, key: OrderCardKey): Promise<OrderCardRecord | null>;
  /**
   * Records the card as saved or set aside. A saved card is never overwritten; it is returned as stored. `changed` is
   * true only when this call moved the card to `status`.
   */
  setCard(
    scope: OrgScope, locationId: string, key: OrderCardKey, input: { kind: OrderCardKind; status: 'saved' | 'dismissed'; now: Date },
  ): Promise<{ card: OrderCardRecord; changed: boolean }>;
  /**
   * Claims a change card for a save: moves it to `saving` unless it is saved, and resolves the id its edit is stored
   * under (the same for every claim of the card). Null when the card is saved.
   */
  claimChange(scope: OrgScope, locationId: string, key: OrderCardKey, now: Date): Promise<string | null>;
  /** The conversation's cards, when it is deleted. Resolves the number deleted. */
  removeForConversation(scope: OrgScope, conversationId: string): Promise<number>;
  removeForLocation(scope: OrgScope, locationId: string): Promise<void>;
  removeForOrg(scope: OrgScope): Promise<void>;
}

export function createOrderStore(connection: Connection): OrderStore {
  const Decision = decisionModel(connection);
  const Rule = ruleModel(connection);
  const Card = orderCardModel(connection);
  const place = (scope: OrgScope, locationId: string) => ({
    orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId),
  });
  const cardKey = (scope: OrgScope, key: OrderCardKey) => ({
    orgId: new Types.ObjectId(scope.orgId), conversationId: new Types.ObjectId(key.conversationId), proposalId: key.proposalId,
  });
  const toCard = (doc: CardFields): OrderCardRecord => ({
    proposalId: doc.proposalId, kind: doc.kind, status: doc.status, decisionId: doc.decisionId.toHexString(),
  });
  /**
   * As stores/chat-proposals.ts does: moves a card that is not saved to `status`, inserting it with `decisionId` when
   * there is none. The filter skips a saved card, so the upsert then fails on the unique index instead of overwriting
   * it; the first of two concurrent inserts fails the same way, so a duplicate is tried once more, and then matches the
   * row the other made. Resolves the card as it was before (null when this call inserted it), or 'saved'.
   */
  const moveUnlessSaved = async (
    scope: OrgScope, locationId: string, key: OrderCardKey,
    input: { kind: OrderCardKind; status: OrderCardStatus; now: Date }, decisionId: Types.ObjectId,
  ): Promise<CardFields | null | 'saved'> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await Card.findOneAndUpdate(
          { ...cardKey(scope, key), status: trusted({ $ne: 'saved' }) },
          {
            $set: { status: input.status },
            $setOnInsert: { locationId: new Types.ObjectId(locationId), kind: input.kind, decisionId, createdAt: input.now },
          },
          { upsert: true, returnDocument: 'before' },
        ).lean();
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    return 'saved';
  };
  return {
    async listDecisions(scope, locationId, since) {
      const docs = await Decision.find({ ...place(scope, locationId), delivery: trusted({ $gte: since }) }).sort({ createdAt: -1, _id: -1 }).lean();
      return docs.map(toDecision);
    },
    async addDecision(scope, locationId, input) {
      const { id, now, ...fields } = input;
      const _id = id === undefined ? new Types.ObjectId() : new Types.ObjectId(id);
      try {
        return toDecision(await Decision.create({ ...place(scope, locationId), ...fields, _id, createdAt: now }));
      } catch (err) {
        // Stored already under this id: a second save of the same card. Its first edit stands.
        if (id === undefined || !isDuplicateKeyError(err)) throw err;
        const stored = await Decision.findOne({ ...place(scope, locationId), _id }).lean();
        if (stored === null) throw err;
        return toDecision(stored);
      }
    },
    async latestDecision(scope, locationId, itemId) {
      const doc = await Decision.findOne({ ...place(scope, locationId), itemId }).sort({ createdAt: -1, _id: -1 }).lean();
      return doc === null ? null : toDecision(doc);
    },
    async listRules(scope, locationId) {
      const docs = await Rule.find(place(scope, locationId)).sort({ createdAt: -1, _id: -1 }).lean();
      return docs.map(toRule);
    },
    async findRule(scope, locationId, itemId, situation) {
      const doc = await Rule.findOne({ ...place(scope, locationId), itemId, situation }).lean();
      return doc === null ? null : toRule(doc);
    },
    async addRule(scope, locationId, input) {
      const where = { ...place(scope, locationId), itemId: input.itemId, situation: input.situation };
      const existing = await Rule.findOne(where).lean();
      if (existing !== null) return { rule: toRule(existing), created: false };
      try {
        const doc = await Rule.create({ ...place(scope, locationId), ...input, off: false, createdAt: input.now, updatedAt: input.now });
        return { rule: toRule(doc), created: true };
      } catch (err) {
        // A second save of the same rule inserted it first: the unique index refuses this one, and its rule is the answer.
        if (!isDuplicateKeyError(err)) throw err;
        const raced = await Rule.findOne(where).lean();
        if (raced === null) throw err;
        return { rule: toRule(raced), created: false };
      }
    },
    async turnOff(scope, locationId, ruleId, now) {
      if (!Types.ObjectId.isValid(ruleId)) return false;
      const doc = await Rule.findOneAndUpdate(
        { ...place(scope, locationId), _id: new Types.ObjectId(ruleId) },
        { $set: { off: true, updatedAt: now } },
      ).lean();
      return doc !== null;
    },
    async findCard(scope, key) {
      const doc = await Card.findOne(cardKey(scope, key)).lean();
      return doc === null ? null : toCard(doc);
    },
    async setCard(scope, locationId, key, input) {
      const minted = new Types.ObjectId();
      const before = await moveUnlessSaved(scope, locationId, key, input, minted);
      if (before === 'saved') {
        const saved = await Card.findOne(cardKey(scope, key)).lean();
        if (saved === null) throw new Error('a saved order card was not found');
        return { card: toCard(saved), changed: false };
      }
      const decisionId = (before?.decisionId ?? minted).toHexString();
      return {
        card: { proposalId: key.proposalId, kind: before?.kind ?? input.kind, status: input.status, decisionId },
        changed: before?.status !== input.status,
      };
    },
    async claimChange(scope, locationId, key, now) {
      const minted = new Types.ObjectId();
      const before = await moveUnlessSaved(scope, locationId, key, { kind: 'change', status: 'saving', now }, minted);
      // Every claim of the card gets the id its first insert minted.
      return before === 'saved' ? null : (before?.decisionId ?? minted).toHexString();
    },
    async removeForConversation(scope, conversationId) {
      const result = await Card.deleteMany({
        orgId: new Types.ObjectId(scope.orgId), conversationId: new Types.ObjectId(conversationId),
      });
      return result.deletedCount;
    },
    async removeForLocation(scope, locationId) {
      const where = place(scope, locationId);
      await Decision.deleteMany(where);
      await Rule.deleteMany(where);
      await Card.deleteMany(where);
    },
    async removeForOrg(scope) {
      const where = { orgId: new Types.ObjectId(scope.orgId) };
      await Decision.deleteMany(where);
      await Rule.deleteMany(where);
      await Card.deleteMany(where);
    },
  };
}
