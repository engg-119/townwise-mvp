// tw_agent_changes (spec 6.31, D59, openspec change auto-apply-agent-reads design decisions 5, 6 and 10): the ledger of
// each change TownwiseAI saved at a location, written only through agent/apply.ts (and its undo). A row is inserted
// `applying` under the change's planned target id and a dedupe key that is unique per location in every status, so the
// same fact from two sources is written once and a change someone undid is never made again; the target is then written
// under that id, and the row set `applied` with the target's `updatedAt`. Undo moves it `applied` to `undoing` to
// `undone`, or to `adopted` once a person changed the target since. Every change of status is a compare-and-set (no
// transactions, D17). Ids, dates, codes and counts only, apart from `why`: no function here logs, and nothing copies a
// why into an audit event or a log line.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { NoteKind } from './notes.ts';

export const AGENT_CHANGES_COLLECTION = 'tw_agent_changes';

/**
 * What TownwiseAI may do (design decision 6). `booking.label` (slice 2) is one row per file calendar sorted on import: its
 * target is the calendar, and it covers every label that sort set. `rule.add` (slice 3) is a closure or hours rule the
 * weekly pass or the sales history was sure of.
 */
export type AgentChangeAction = 'note.add' | 'item.add' | 'sales_days.add' | 'rule.add' | 'booking.label';
/**
 * Where the change came from: `file` (slice 1), `calendar` (slice 2), and (slice 3) `weekly` (the weekly pass's notes,
 * rules and spotted calendar events) and `sales` (a closed weekday the sales history shows, D46). `chat` is slice 4's.
 */
export type AgentSourceKind = 'file' | 'calendar' | 'weekly' | 'sales' | 'chat';
export const AGENT_SOURCE_KINDS: readonly AgentSourceKind[] = ['file', 'calendar', 'weekly', 'sales', 'chat'];
export type AgentChangeStatus = 'applying' | 'applied' | 'undoing' | 'undone' | 'adopted';
export type AgentConfidence = 'high' | 'medium' | 'low';

/** At most this many characters of why (design decision 5). */
export const MAX_WHY_CHARS = 200;

export const AGENT_CHANGE_ACTIONS: readonly AgentChangeAction[] = ['note.add', 'item.add', 'sales_days.add', 'rule.add', 'booking.label'];

interface ChangeFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  sourceKind: AgentSourceKind;
  /** The file (or later the calendar or conversation) it came from; null when none. */
  sourceId: string | null;
  action: AgentChangeAction;
  /** The note, item or upload it added, under the id planned before any write. */
  targetId: Types.ObjectId;
  dedupeKey: string;
  confidence: AgentConfidence;
  /** TownwiseAI's short why, at most 200 characters; null when it gave none. Shown only in the log. */
  why: string | null;
  /** The person the source belongs to (the file's adder); null once that person is deleted. */
  onBehalfOf: string | null;
  status: AgentChangeStatus;
  /** The target's `updatedAt` when applied: undo removes it only while it is unchanged. Null while applying. */
  targetUpdatedAt: Date | null;
  /** The dates the change covers (a note's), for the activity's words; null for an item. */
  startDate: string | null;
  endDate: string | null;
  /** A note's kind (slice 3: a rule schedule's), for the activity's words; absent otherwise. */
  noteKind?: NoteKind;
  /** Slice 3: the weekdays a note or rule covers (0 is Sunday), for the activity's words; absent for every day. */
  weekdays?: number[];
  /** How many records the change added, for the activity's words (a calendar sort's labels); absent otherwise. */
  count?: number;
  appliedAt: Date;
  statusAt: Date;
  /** Who last changed the status (a member's user id, or `townwise_ai`); null once that person is deleted. */
  statusBy: string | null;
}

function changeSchema(): Schema<ChangeFields> {
  const schema = new Schema<ChangeFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    sourceKind: { type: String, required: true, enum: AGENT_SOURCE_KINDS },
    sourceId: { type: String, default: null },
    action: { type: String, required: true, enum: AGENT_CHANGE_ACTIONS },
    targetId: { type: Schema.Types.ObjectId, required: true },
    dedupeKey: { type: String, required: true, maxlength: 128 },
    confidence: { type: String, required: true, enum: ['high', 'medium', 'low'] },
    why: { type: String, default: null, maxlength: MAX_WHY_CHARS },
    onBehalfOf: { type: String, default: null },
    status: { type: String, required: true, enum: ['applying', 'applied', 'undoing', 'undone', 'adopted'] },
    targetUpdatedAt: { type: Date, default: null },
    startDate: { type: String, default: null },
    endDate: { type: String, default: null },
    noteKind: { type: String, enum: ['closure', 'private_event', 'opening', 'other'] },
    weekdays: { type: [{ type: Number, min: 0, max: 6 }], default: undefined },
    count: { type: Number, min: 0 },
    appliedAt: { type: Date, required: true },
    statusAt: { type: Date, required: true },
    statusBy: { type: String, default: null },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
  // One change per fact at a location, in every status, so an undone one is never made again (design decision 5).
  schema.index({ orgId: 1, locationId: 1, dedupeKey: 1 }, { unique: true });
  // The activity and the log: a location's changes, newest first.
  schema.index({ orgId: 1, locationId: 1, appliedAt: -1, _id: -1 });
  // A file's undo finds its rows.
  schema.index({ orgId: 1, locationId: 1, sourceKind: 1, sourceId: 1 });
  return schema;
}

/** Registers TwAgentChange (tw_agent_changes) on first call. */
export function agentChangeModel(connection: Connection): Model<ChangeFields> {
  const existing = connection.models.TwAgentChange as Model<ChangeFields> | undefined;
  return existing ?? connection.model<ChangeFields>('TwAgentChange', changeSchema(), AGENT_CHANGES_COLLECTION);
}

export interface AgentChangeRecord {
  readonly id: string;
  readonly locationId: string;
  readonly sourceKind: AgentSourceKind;
  readonly sourceId: string | null;
  readonly action: AgentChangeAction;
  readonly targetId: string;
  readonly dedupeKey: string;
  readonly confidence: AgentConfidence;
  readonly why: string | null;
  readonly onBehalfOf: string | null;
  readonly status: AgentChangeStatus;
  readonly targetUpdatedAt: Date | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly noteKind: NoteKind | null;
  /** Slice 3: the weekdays a note or rule covers, sorted; null for every day (and for an older row). */
  readonly weekdays: readonly number[] | null;
  readonly count: number | null;
  readonly appliedAt: Date;
  readonly statusAt: Date;
  readonly statusBy: string | null;
}

/** A change to insert as `applying`. */
export interface NewAgentChange {
  readonly id: string;
  readonly locationId: string;
  readonly sourceKind: AgentSourceKind;
  readonly sourceId: string | null;
  readonly action: AgentChangeAction;
  readonly targetId: string;
  readonly dedupeKey: string;
  readonly confidence: AgentConfidence;
  readonly why: string | null;
  readonly onBehalfOf: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly noteKind?: NoteKind;
  readonly weekdays?: readonly number[];
  readonly count?: number;
  readonly now: Date;
}

/** A page of the log: the changes, and the `before` of the next older page (null when there is none). */
export interface AgentChangePage {
  readonly changes: AgentChangeRecord[];
  readonly next: { readonly at: Date; readonly id: string } | null;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface AgentChangeStore {
  /**
   * Inserts the change as `applying`. When the location already holds its dedupe key, answers the row holding it with
   * `created: false` (the same planned target is an earlier attempt of this change; another is a duplicate).
   */
  insertApplying(scope: OrgScope, input: NewAgentChange): Promise<{ readonly record: AgentChangeRecord; readonly created: boolean }>;
  /** `applying` to `applied` with the target's updatedAt, by compare-and-set. False when another call did it first. */
  markApplied(scope: OrgScope, locationId: string, id: string, input: { targetUpdatedAt: Date; now: Date }): Promise<boolean>;
  /**
   * Slice 2: a row still `applying` gets what its writer actually wrote (a calendar sort's label count and the dates of
   * its buyouts and parties), by compare-and-set, before it is marked applied. False when it was no longer `applying`.
   */
  setWritten(scope: OrgScope, locationId: string, id: string, input: { count: number; startDate: string | null; endDate: string | null }): Promise<boolean>;
  /** Deletes a row still `applying` whose target was never written (nothing to add after all). */
  removeApplying(scope: OrgScope, locationId: string, id: string): Promise<boolean>;
  /** `applied` to `undoing`, by compare-and-set; the row after, or null when it was not `applied`. */
  markUndoing(scope: OrgScope, locationId: string, id: string, input: { by: string; now: Date }): Promise<AgentChangeRecord | null>;
  /** `undoing` to `undone`, by compare-and-set. */
  markUndone(scope: OrgScope, locationId: string, id: string, input: { by: string; now: Date }): Promise<boolean>;
  /** `undoing` or `applied` to `adopted` (a person changed the target since), by compare-and-set. */
  markAdopted(scope: OrgScope, locationId: string, id: string, input: { now: Date }): Promise<boolean>;
  /**
   * A file's own undo (D34): every row from that file not yet undone or adopted is set `undone`. Resolves how many.
   */
  markSourceUndone(scope: OrgScope, locationId: string, source: { kind: AgentSourceKind; id: string }, input: { by: string; now: Date }): Promise<number>;
  find(scope: OrgScope, locationId: string, id: string): Promise<AgentChangeRecord | null>;
  /** D59 slice 2: every change from one source (a calendar's labels and notes, for its Undo), oldest first. */
  listBySource(scope: OrgScope, locationId: string, source: { kind: AgentSourceKind; id: string }): Promise<AgentChangeRecord[]>;
  findByKey(scope: OrgScope, locationId: string, dedupeKey: string): Promise<AgentChangeRecord | null>;
  /**
   * D59 slice 3: how many changes of `action` the location has with appliedAt at or after `since`, in any status (an undone
   * rule still counts toward the week's 2).
   */
  countSince(scope: OrgScope, locationId: string, input: { action: AgentChangeAction; since: Date }): Promise<number>;
  /** D59 slice 3: the location's changes still `applying` whose status was set at or before `before`, oldest first. */
  listApplying(scope: OrgScope, locationId: string, input: { before: Date }): Promise<AgentChangeRecord[]>;
  /** The location's changes newest first, `limit` a page, older than `before` when given. */
  page(scope: OrgScope, locationId: string, input: { before?: { at: Date; id: string }; limit: number }): Promise<AgentChangePage>;
  /** Deleting a location (D44). Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion (spec 10.7). Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

type ChangeDoc = ChangeFields & { _id: Types.ObjectId };

function toChange(doc: ChangeDoc): AgentChangeRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    sourceKind: doc.sourceKind,
    sourceId: doc.sourceId,
    action: doc.action,
    targetId: doc.targetId.toHexString(),
    dedupeKey: doc.dedupeKey,
    confidence: doc.confidence,
    why: doc.why,
    onBehalfOf: doc.onBehalfOf,
    status: doc.status,
    targetUpdatedAt: doc.targetUpdatedAt,
    startDate: doc.startDate,
    endDate: doc.endDate,
    noteKind: doc.noteKind ?? null,
    weekdays: doc.weekdays ?? null,
    count: doc.count ?? null,
    appliedAt: doc.appliedAt,
    statusAt: doc.statusAt,
    statusBy: doc.statusBy,
  };
}

export function createAgentChangeStore(connection: Connection): AgentChangeStore {
  const Change = agentChangeModel(connection);
  const of = (scope: OrgScope, locationId: string) => ({ orgId: new Types.ObjectId(scope.orgId), locationId: new Types.ObjectId(locationId) });
  const one = (scope: OrgScope, locationId: string, id: string) => ({ ...of(scope, locationId), _id: new Types.ObjectId(id) });
  const after = { returnDocument: 'after' } as const;
  return {
    async insertApplying(scope, input) {
      try {
        const doc = await Change.create({
          _id: new Types.ObjectId(input.id), ...of(scope, input.locationId), sourceKind: input.sourceKind, sourceId: input.sourceId,
          action: input.action, targetId: new Types.ObjectId(input.targetId), dedupeKey: input.dedupeKey, confidence: input.confidence,
          why: input.why, onBehalfOf: input.onBehalfOf, status: 'applying', targetUpdatedAt: null, startDate: input.startDate,
          endDate: input.endDate, ...(input.noteKind === undefined ? {} : { noteKind: input.noteKind }),
          ...(input.weekdays === undefined ? {} : { weekdays: [...input.weekdays] }),
          ...(input.count === undefined ? {} : { count: input.count }), appliedAt: input.now,
          statusAt: input.now, statusBy: 'townwise_ai',
        });
        return { record: toChange(doc.toObject<ChangeDoc>()), created: true };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const held = await Change.findOne({ ...of(scope, input.locationId), dedupeKey: input.dedupeKey }).lean()
          ?? await Change.findOne(one(scope, input.locationId, input.id)).lean();
        if (held === null) throw err;
        return { record: toChange(held), created: false };
      }
    },
    async markApplied(scope, locationId, id, input) {
      const result = await Change.updateOne(
        { ...one(scope, locationId, id), status: 'applying' },
        { $set: { status: 'applied', targetUpdatedAt: input.targetUpdatedAt, statusAt: input.now, statusBy: 'townwise_ai' } },
      );
      return result.modifiedCount === 1;
    },
    async setWritten(scope, locationId, id, input) {
      const result = await Change.updateOne(
        { ...one(scope, locationId, id), status: 'applying' },
        { $set: { count: input.count, startDate: input.startDate, endDate: input.endDate } },
      );
      return result.matchedCount === 1;
    },
    async removeApplying(scope, locationId, id) {
      return (await Change.deleteOne({ ...one(scope, locationId, id), status: 'applying' })).deletedCount === 1;
    },
    async markUndoing(scope, locationId, id, input) {
      const doc = await Change.findOneAndUpdate(
        { ...one(scope, locationId, id), status: 'applied' }, { $set: { status: 'undoing', statusAt: input.now, statusBy: input.by } }, after,
      ).lean();
      return doc === null ? null : toChange(doc);
    },
    async markUndone(scope, locationId, id, input) {
      const result = await Change.updateOne(
        { ...one(scope, locationId, id), status: 'undoing' }, { $set: { status: 'undone', statusAt: input.now, statusBy: input.by } },
      );
      return result.modifiedCount === 1;
    },
    async markAdopted(scope, locationId, id, input) {
      const result = await Change.updateOne(
        { ...one(scope, locationId, id), status: trusted({ $in: ['applied', 'undoing'] }) }, { $set: { status: 'adopted', statusAt: input.now } },
      );
      return result.modifiedCount === 1;
    },
    async markSourceUndone(scope, locationId, source, input) {
      const result = await Change.updateMany(
        { ...of(scope, locationId), sourceKind: source.kind, sourceId: source.id, status: trusted({ $in: ['applying', 'applied', 'undoing'] }) },
        { $set: { status: 'undone', statusAt: input.now, statusBy: input.by } },
      );
      return result.modifiedCount;
    },
    async find(scope, locationId, id) {
      const doc = await Change.findOne(one(scope, locationId, id)).lean();
      return doc === null ? null : toChange(doc);
    },
    async listBySource(scope, locationId, source) {
      const docs = await Change.find({ ...of(scope, locationId), sourceKind: source.kind, sourceId: source.id }).sort({ appliedAt: 1, _id: 1 }).lean();
      return docs.map(toChange);
    },
    async findByKey(scope, locationId, dedupeKey) {
      const doc = await Change.findOne({ ...of(scope, locationId), dedupeKey }).lean();
      return doc === null ? null : toChange(doc);
    },
    countSince(scope, locationId, input) {
      return Change.countDocuments({ ...of(scope, locationId), action: input.action, appliedAt: trusted({ $gte: input.since }) });
    },
    async listApplying(scope, locationId, input) {
      const docs = await Change.find({ ...of(scope, locationId), status: 'applying', statusAt: trusted({ $lte: input.before }) })
        .sort({ appliedAt: 1, _id: 1 }).lean();
      return docs.map(toChange);
    },
    async page(scope, locationId, input) {
      const before = input.before;
      const filter = before === undefined ? of(scope, locationId) : {
        ...of(scope, locationId),
        $or: [{ appliedAt: trusted({ $lt: before.at }) }, { appliedAt: before.at, _id: trusted({ $lt: new Types.ObjectId(before.id) }) }],
      };
      const docs = await Change.find(filter).sort({ appliedAt: -1, _id: -1 }).limit(input.limit + 1).lean();
      const changes = docs.slice(0, input.limit).map(toChange);
      const last = changes.at(-1);
      return { changes, next: docs.length > input.limit && last !== undefined ? { at: last.appliedAt, id: last.id } : null };
    },
    async removeForLocation(scope, locationId) {
      return (await Change.deleteMany(of(scope, locationId))).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Change.deleteMany({ orgId: new Types.ObjectId(scope.orgId) })).deletedCount;
    },
  };
}
