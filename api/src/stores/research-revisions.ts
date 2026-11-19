// tw_research_revisions (D66, spec 6.41, design decision 11): a location's hand edits of researched events, append-only.
// A revision edits, hides or restores one researched event (`t-<hex>` a town row, `l-<hex>` a location row) at one
// location, or reverts an earlier revision (TownwiseAI's Undo); each is based on the revision before it (`'base'` for
// the first), and the unique `(orgId, locationId, eventId, basedOn)` allows one child of each, so a lost race fails on
// the index (409 `changed_since`) and nothing is ever overwritten. A revision changes only its own location's calendar:
// never another location's, nor the shared town row. Its text (a title, a `where`) is a member's and is never sent to
// Anthropic: under src/research/ only read.ts and revisions.ts import this file (test/isolation.test.ts).
// Tenant store: every function takes the OrgScope first and filters on its orgId. `by.userId` is null once that person
// is deleted (stores/cross-tenant.ts deletePersonRecords). Nothing here logs.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { insertUnlessDuplicate } from './research-shared.ts';

export const RESEARCH_REVISIONS_COLLECTION = 'tw_research_revisions';

export const REVISION_OPS = ['edit', 'hide', 'restore', 'revert'] as const;
export type RevisionOp = typeof REVISION_OPS[number];

/** The values an edit sets over the state before it; absent fields keep theirs. */
export interface RevisionFields {
  readonly title?: string;
  readonly start?: string;
  readonly end?: string;
  readonly weekdays?: readonly number[] | null;
  readonly startTime?: string | null;
  readonly where?: string | null;
}

/** A person's revision (the route, or the Apply tap of a proposal), or TownwiseAI's correction in chat (decision 12). */
export type RevisionBy =
  | { readonly kind: 'person'; readonly userId: string | null }
  | { readonly kind: 'chat'; readonly conversationId: string; readonly changeId: string };

interface RevisionDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  eventId: string;
  op: RevisionOp;
  fields: { title?: string; start?: string; end?: string; weekdays?: number[] | null; startTime?: string | null; where?: string | null } | null;
  reverts: Types.ObjectId | null;
  /** `'base'`, or the hex id of the revision this one follows. */
  basedOn: string;
  by: { kind: 'person' | 'chat'; userId?: string | null; conversationId?: Types.ObjectId; changeId?: Types.ObjectId };
  createdAt: Date;
}

const sub = { _id: false, strict: 'throw' } as const;

function revisionSchema(): Schema<RevisionDoc> {
  const fields = new Schema({
    title: { type: String },
    start: { type: String },
    end: { type: String },
    weekdays: { type: [Number], default: undefined },
    startTime: { type: String },
    where: { type: String },
  }, sub);
  const by = new Schema({
    kind: { type: String, required: true, enum: ['person', 'chat'] },
    userId: { type: String },
    conversationId: { type: Schema.Types.ObjectId },
    changeId: { type: Schema.Types.ObjectId },
  }, sub);
  const schema = new Schema<RevisionDoc>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    eventId: { type: String, required: true },
    op: { type: String, required: true, enum: REVISION_OPS },
    fields: { type: fields, default: null },
    reverts: { type: Schema.Types.ObjectId, default: null },
    basedOn: { type: String, required: true },
    by: { type: by, required: true },
    createdAt: { type: Date, required: true },
  }, { strict: 'throw', versionKey: false, read: 'primary', minimize: false });
  schema.index({ orgId: 1, locationId: 1, eventId: 1, basedOn: 1 }, { unique: true });
  schema.index({ orgId: 1, locationId: 1, createdAt: 1 });
  return schema;
}

/** Registers TwResearchRevision (tw_research_revisions) on first call. */
export function researchRevisionModel(connection: Connection): Model<RevisionDoc> {
  const existing = connection.models.TwResearchRevision as Model<RevisionDoc> | undefined;
  return existing ?? connection.model<RevisionDoc>('TwResearchRevision', revisionSchema(), RESEARCH_REVISIONS_COLLECTION);
}

export interface RevisionRecord {
  readonly id: string;
  readonly locationId: string;
  readonly eventId: string;
  readonly op: RevisionOp;
  readonly fields: RevisionFields | null;
  readonly reverts: string | null;
  readonly basedOn: string;
  readonly by: RevisionBy;
  readonly createdAt: Date;
}

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ResearchRevisionStore {
  /**
   * Appends a revision (under `id` when given: TownwiseAI's correction plans its revision's id, agent/apply.ts). Null
   * when `basedOn` already has a child (the unique index): the caller answers 409 `changed_since`. Null too when a
   * revision with the planned `id` exists (a retried apply), which the caller tells apart with `find`.
   */
  append(scope: OrgScope, input: {
    id?: string; locationId: string; eventId: string; op: RevisionOp; fields: RevisionFields | null; reverts: string | null;
    basedOn: string; by: RevisionBy; now: Date;
  }): Promise<RevisionRecord | null>;
  find(scope: OrgScope, locationId: string, id: string): Promise<RevisionRecord | null>;
  /** The location's revisions, oldest first. */
  list(scope: OrgScope, locationId: string): Promise<RevisionRecord[]>;
  /** How many the location holds (at most 1,000, decision 11). */
  count(scope: OrgScope, locationId: string): Promise<number>;
  /**
   * A place or town change (decision 9): deletes the location's revisions of its own (`l-`) events not in
   * `locationEventIds` (hex ids of the events left), and of every town (`t-`) event when `townRows` (the town changed,
   * so those rows are another town's). Resolves the number deleted.
   */
  removeStale(scope: OrgScope, locationId: string, input: { locationEventIds: readonly string[]; townRows: boolean }): Promise<number>;
  /** Location deletion. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion. Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

function toFields(doc: NonNullable<RevisionDoc['fields']>): RevisionFields {
  return {
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    ...(doc.start !== undefined ? { start: doc.start } : {}),
    ...(doc.end !== undefined ? { end: doc.end } : {}),
    ...(doc.weekdays !== undefined ? { weekdays: doc.weekdays === null ? null : [...doc.weekdays] } : {}),
    ...(doc.startTime !== undefined ? { startTime: doc.startTime } : {}),
    ...(doc.where !== undefined ? { where: doc.where } : {}),
  };
}

function toRevision(doc: RevisionDoc): RevisionRecord {
  const by: RevisionBy = doc.by.kind === 'person'
    ? { kind: 'person', userId: doc.by.userId ?? null }
    : { kind: 'chat', conversationId: doc.by.conversationId?.toHexString() ?? '', changeId: doc.by.changeId?.toHexString() ?? '' };
  return {
    id: doc._id.toHexString(), locationId: doc.locationId.toHexString(), eventId: doc.eventId, op: doc.op,
    fields: doc.fields === null ? null : toFields(doc.fields), reverts: doc.reverts === null ? null : doc.reverts.toHexString(),
    basedOn: doc.basedOn, by, createdAt: doc.createdAt,
  };
}

export function createResearchRevisionStore(connection: Connection): ResearchRevisionStore {
  const Revision = researchRevisionModel(connection);
  const oid = (value: string) => new Types.ObjectId(value);
  const org = (scope: OrgScope) => ({ orgId: oid(scope.orgId) });
  const at = (scope: OrgScope, locationId: string) => ({ ...org(scope), locationId: oid(locationId) });
  return {
    async append(scope, input) {
      const by = input.by.kind === 'person'
        ? { kind: 'person', userId: input.by.userId }
        : { kind: 'chat', conversationId: oid(input.by.conversationId), changeId: oid(input.by.changeId) };
      const doc = await insertUnlessDuplicate(Revision, {
        ...(input.id !== undefined ? { _id: oid(input.id) } : {}),
        ...at(scope, input.locationId), eventId: input.eventId, op: input.op,
        fields: input.fields === null ? null : { ...input.fields, ...(input.fields.weekdays != null ? { weekdays: [...input.fields.weekdays] } : {}) },
        reverts: input.reverts === null ? null : oid(input.reverts), basedOn: input.basedOn, by, createdAt: input.now,
      });
      return doc === null ? null : toRevision(doc);
    },
    async find(scope, locationId, id) {
      const doc = await Revision.findOne({ ...at(scope, locationId), _id: oid(id) }).lean();
      return doc === null ? null : toRevision(doc);
    },
    async list(scope, locationId) {
      return (await Revision.find(at(scope, locationId)).sort({ createdAt: 1, _id: 1 }).lean()).map(toRevision);
    },
    count: (scope, locationId) => Revision.countDocuments(at(scope, locationId)),
    async removeStale(scope, locationId, input) {
      const keep = input.locationEventIds.map((id) => `l-${id}`);
      const stale = [
        { eventId: trusted({ $regex: '^l-', $nin: keep }) },
        ...(input.townRows ? [{ eventId: trusted({ $regex: '^t-' }) }] : []),
      ];
      return (await Revision.deleteMany({ ...at(scope, locationId), $or: stale })).deletedCount;
    },
    async removeForLocation(scope, locationId) {
      return (await Revision.deleteMany(at(scope, locationId))).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Revision.deleteMany(org(scope))).deletedCount;
    },
  };
}
