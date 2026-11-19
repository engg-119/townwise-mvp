// tw_location_research_runs, tw_location_research_threads, tw_location_events and tw_location_entities (D66, spec 6.37
// to 6.40): what research found for one location, its restaurant, its block and its competitors (and, for a town outside
// the twelve, its town). A location run is `weekly` (`w:{Monday}`), `early` (on creating the location or picking its
// place, `s:{id}`) or `press` (Research now, `p:{id}`), and records no person. `liveSubject` equals the location while the
// run is queued, running or merging and then goes, under a unique partial index led by the organization, so a location
// has one live run and a second insert answers null ("already running", design decision 2). Rows are stamped with the
// `placeId` and `town` the run was planned for, so a place or town change can drop the old ones and a reader skip them
// (decision 9). The run's merge (research/merge.ts) is the only writer of events and entities.
// Tenant store: every function takes the OrgScope first and filters on its orgId, and every index is led by `orgId`
// except the claim indexes `(status, createdAt)`, `(status, notBefore)` and `(status, leaseUntil)`, which serve only
// stores/cross-tenant.ts's claim and merge sweep, as the files collection's claim index does (spec 6.10 rule 1's
// exception). Deletion removes runs and threads first, so a live lane's heartbeat misses and its merge finds no run,
// then events and entities. Nothing here logs.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { LocationOrigin, ThreadId } from '../research/threads.ts';
import type { EntityType, SourceRef } from '../research/verify.ts';
import {
  entityFields, eventDocOf, eventFields, eventUpdateOf, insertUnlessDuplicate, newRunDoc, newThreadDoc, REPORTED_RUN_STATUSES,
  runFields, runMoves, SCHEMA_OPTIONS, threadFields, threadMoves, toEntityBase, toEventBase, toRunBase, toThreadBase,
  type EntityDoc, type EntityRecordBase, type EventDoc, type EventInsertBase, type EventRecordBase, type EventUpdate,
  type RunDoc, type RunEnd, type RunRecordBase, type ThreadDoc, type ThreadEnd, type ThreadRecordBase,
  type ThreadTallyWrite,
} from './research-shared.ts';

export const LOCATION_RESEARCH_RUNS_COLLECTION = 'tw_location_research_runs';
export const LOCATION_RESEARCH_THREADS_COLLECTION = 'tw_location_research_threads';
export const LOCATION_EVENTS_COLLECTION = 'tw_location_events';
export const LOCATION_ENTITIES_COLLECTION = 'tw_location_entities';

/** What started a location run; never a person's id (design decision 2). */
export const RUN_TRIGGERS = ['weekly', 'early', 'press'] as const;
export type RunTrigger = typeof RUN_TRIGGERS[number];
export const LOCATION_ORIGINS: readonly LocationOrigin[] = ['neighborhood', 'competitor', 'town_overview'];

type Id = Types.ObjectId;
interface Owned { orgId: Id; locationId: Id }
type LocationRunDoc = RunDoc & Owned & {
  trigger: RunTrigger; placeId: string | null; town: string; liveSubject?: Id; mergeOwner: string | null; mergeUntil: Date | null;
};
type LocationThreadDoc = ThreadDoc & Owned;
type LocationEventDoc = EventDoc & Owned & {
  placeId: string | null; town: string; origin: LocationOrigin; competitorEntityId: Id | null; competitorPlaceId: string | null;
};
type LocationEntityDoc = EntityDoc & Owned & { placeId: string | null; town: string; townEntityId: Id | null };

const owned = {
  orgId: { type: Schema.Types.ObjectId, required: true },
  locationId: { type: Schema.Types.ObjectId, required: true },
};
/** The place and town a row was planned for; a row with another stamp than the location's is stale (decision 9). */
const stamped = { placeId: { type: String, default: null }, town: { type: String, required: true } };

function locationRunSchema(): Schema<LocationRunDoc> {
  const schema = new Schema<LocationRunDoc>({
    ...owned,
    ...runFields(),
    trigger: { type: String, required: true, enum: RUN_TRIGGERS },
    ...stamped,
    liveSubject: { type: Schema.Types.ObjectId },
  }, SCHEMA_OPTIONS);
  schema.index({ orgId: 1, locationId: 1, key: 1 }, { unique: true });
  schema.index({ orgId: 1, liveSubject: 1 }, { unique: true, partialFilterExpression: { liveSubject: { $type: 'objectId' } } });
  schema.index({ orgId: 1, locationId: 1, createdAt: -1 });
  // The claim index: cross-tenant.ts's merge sweep only.
  schema.index({ status: 1, createdAt: 1 });
  return schema;
}

function locationThreadSchema(): Schema<LocationThreadDoc> {
  const schema = new Schema<LocationThreadDoc>({ ...owned, ...threadFields() }, SCHEMA_OPTIONS);
  schema.index({ orgId: 1, runId: 1, thread: 1 }, { unique: true });
  // The claim indexes: cross-tenant.ts's claim and stale sweep only.
  schema.index({ status: 1, notBefore: 1 });
  schema.index({ status: 1, leaseUntil: 1 });
  return schema;
}

function locationEventSchema(): Schema<LocationEventDoc> {
  const schema = new Schema<LocationEventDoc>({
    ...owned,
    ...stamped,
    ...eventFields(),
    origin: { type: String, required: true, enum: LOCATION_ORIGINS },
    competitorEntityId: { type: Schema.Types.ObjectId, default: null },
    competitorPlaceId: { type: String, default: null },
  }, SCHEMA_OPTIONS);
  schema.index({ orgId: 1, locationId: 1, start: 1 });
  schema.index({ orgId: 1, locationId: 1, end: 1 });
  return schema;
}

function locationEntitySchema(): Schema<LocationEntityDoc> {
  const schema = new Schema<LocationEntityDoc>({
    ...owned,
    ...stamped,
    ...entityFields(),
    townEntityId: { type: Schema.Types.ObjectId, default: null },
  }, SCHEMA_OPTIONS);
  schema.index({ orgId: 1, locationId: 1, type: 1, nameKey: 1 }, { unique: true });
  return schema;
}

/** Registers TwLocationResearchRun (tw_location_research_runs) on first call. */
export function locationResearchRunModel(connection: Connection): Model<LocationRunDoc> {
  const existing = connection.models.TwLocationResearchRun as Model<LocationRunDoc> | undefined;
  return existing ?? connection.model<LocationRunDoc>('TwLocationResearchRun', locationRunSchema(), LOCATION_RESEARCH_RUNS_COLLECTION);
}

/** Registers TwLocationResearchThread (tw_location_research_threads) on first call. */
export function locationResearchThreadModel(connection: Connection): Model<LocationThreadDoc> {
  const existing = connection.models.TwLocationResearchThread as Model<LocationThreadDoc> | undefined;
  return existing ?? connection.model<LocationThreadDoc>('TwLocationResearchThread', locationThreadSchema(), LOCATION_RESEARCH_THREADS_COLLECTION);
}

/** Registers TwLocationEvent (tw_location_events) on first call. */
export function locationEventModel(connection: Connection): Model<LocationEventDoc> {
  const existing = connection.models.TwLocationEvent as Model<LocationEventDoc> | undefined;
  return existing ?? connection.model<LocationEventDoc>('TwLocationEvent', locationEventSchema(), LOCATION_EVENTS_COLLECTION);
}

/** Registers TwLocationEntity (tw_location_entities) on first call. */
export function locationEntityModel(connection: Connection): Model<LocationEntityDoc> {
  const existing = connection.models.TwLocationEntity as Model<LocationEntityDoc> | undefined;
  return existing ?? connection.model<LocationEntityDoc>('TwLocationEntity', locationEntitySchema(), LOCATION_ENTITIES_COLLECTION);
}

interface Stamp { readonly placeId: string | null; readonly town: string }

export interface LocationRunRecord extends RunRecordBase, Stamp { readonly locationId: string; readonly trigger: RunTrigger }
export interface LocationThreadRecord extends ThreadRecordBase { readonly locationId: string }
export interface LocationEventRecord extends EventRecordBase, Stamp {
  readonly locationId: string;
  readonly origin: LocationOrigin;
  readonly competitorEntityId: string | null;
  readonly competitorPlaceId: string | null;
}
export interface LocationEntityRecord extends EntityRecordBase, Stamp { readonly locationId: string; readonly townEntityId: string | null }

export type LocationEventInsert = EventInsertBase & Stamp & {
  readonly origin: LocationOrigin; readonly competitorEntityId: string | null; readonly competitorPlaceId: string | null;
};

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface LocationResearchStore {
  /**
   * Inserts a queued run holding the location's live slot. Null when the location already has a live run or a run of
   * this `key` (both unique indexes), which every insert path reads as "already running" (design decision 2).
   */
  insertRun(scope: OrgScope, input: {
    locationId: string; key: string; trigger: RunTrigger; placeId: string | null; town: string; threads: readonly ThreadId[]; now: Date;
  }): Promise<LocationRunRecord | null>;
  findRun(scope: OrgScope, id: string): Promise<LocationRunRecord | null>;
  /** The location's newest run, by creation (the 6-day rule, Research now's 6 hours, the Town tab). */
  lastRun(scope: OrgScope, locationId: string): Promise<LocationRunRecord | null>;
  /** The location's live (queued, running or merging) run, if any. */
  liveRun(scope: OrgScope, locationId: string): Promise<LocationRunRecord | null>;
  /** The organization's live runs, at most one a location (GET /api/org's `researching`). */
  liveRuns(scope: OrgScope): Promise<LocationRunRecord[]>;
  /** The location's latest merged (`done` or `partial`) run: what a prompt's `known` rows were found again by (decision 4). */
  lastFinishedRun(scope: OrgScope, locationId: string): Promise<LocationRunRecord | null>;
  /** The location's runs ended `done`, `partial`, `failed` or `budget`, newest first, at most `limit` (TownwiseAI's activity). */
  reportedRuns(scope: OrgScope, locationId: string, limit: number): Promise<LocationRunRecord[]>;
  /** Inserts the run's thread rows that are missing (unique `(orgId, runId, thread)`); resolves how many it inserted. */
  insertThreads(scope: OrgScope, run: { id: string; locationId: string }, threads: readonly { thread: ThreadId; notBefore: Date }[], now: Date): Promise<number>;
  threadsOf(scope: OrgScope, runId: string): Promise<LocationThreadRecord[]>;
  markRunRunning(scope: OrgScope, id: string, now: Date): Promise<boolean>;
  finishRun(scope: OrgScope, id: string, end: RunEnd): Promise<boolean>;
  clearFound(scope: OrgScope, runId: string): Promise<void>;
  reserveThread(scope: OrgScope, id: string, owner: string, input: { reservedMicroUsd: number; month: string }): Promise<boolean>;
  heartbeat(scope: OrgScope, id: string, owner: string, input: ThreadTallyWrite & { now: Date; leaseMs: number }): Promise<boolean>;
  finishThread(scope: OrgScope, id: string, owner: string, end: ThreadEnd): Promise<boolean>;
  requeueThread(scope: OrgScope, id: string, owner: string, input: ThreadTallyWrite & { notBefore: Date; code: string | null }): Promise<boolean>;
  reclaimThread(scope: OrgScope, id: string, input: { now: Date; next: { status: 'queued'; notBefore: Date } | { status: 'failed'; code: string } }): Promise<LocationThreadRecord | null>;
  /** The location's stored events, every stamp included (the reader skips rows of another place or town). */
  events(scope: OrgScope, locationId: string): Promise<LocationEventRecord[]>;
  /** How many of the location's stored competitor rows each of `runIds` first found (TownwiseAI's activity), by run id. */
  competitorsAdded(scope: OrgScope, locationId: string, runIds: readonly string[]): Promise<Map<string, number>>;
  insertEvent(scope: OrgScope, locationId: string, input: LocationEventInsert): Promise<LocationEventRecord>;
  /** A merge's update of a stored row: never its title or dates. */
  updateEvent(scope: OrgScope, locationId: string, id: string, update: EventUpdate): Promise<boolean>;
  entities(scope: OrgScope, locationId: string): Promise<LocationEntityRecord[]>;
  /** Inserts the entity or refreshes it; resolves its id. */
  upsertEntity(scope: OrgScope, locationId: string, input: Stamp & {
    type: EntityType; name: string; nameKey: string; townEntityId: string | null; sources: readonly SourceRef[]; now: Date;
  }): Promise<string>;
  /**
   * A merge's retention (decision 8 step 6): the location's events that ended before `endedBefore` (a day), entities
   * last seen before `unseenBefore` that no event names, and ended runs and their threads created before
   * `createdBefore`. Resolves the number deleted.
   */
  removeOld(scope: OrgScope, locationId: string, input: { endedBefore: string; unseenBefore: Date; createdBefore: Date }): Promise<number>;
  /**
   * A place or town change (decision 9): ends the location's live run `off` with `code` and fails its open threads by
   * compare-and-set, so a lane's heartbeat misses and its merge finds the run ended. False when it had no live run.
   */
  endLive(scope: OrgScope, locationId: string, input: { code: string; now: Date }): Promise<boolean>;
  /**
   * A place or town change: deletes the location's events and entities stamped with another place or town. Resolves
   * the ids of the events left.
   */
  removeOtherStamps(scope: OrgScope, locationId: string, stamp: Stamp): Promise<string[]>;
  /** Location deletion: runs and threads first, then events and entities. Resolves the number deleted. */
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  /** Organization deletion, in the same order. Resolves the number deleted. */
  removeForOrg(scope: OrgScope): Promise<number>;
}

const hex = (id: Id | null): string | null => (id === null ? null : id.toHexString());

function toLocationRun(doc: LocationRunDoc): LocationRunRecord {
  return { ...toRunBase(doc), locationId: doc.locationId.toHexString(), trigger: doc.trigger, placeId: doc.placeId, town: doc.town };
}

function toLocationEvent(doc: LocationEventDoc): LocationEventRecord {
  return {
    ...toEventBase(doc), locationId: doc.locationId.toHexString(), placeId: doc.placeId, town: doc.town, origin: doc.origin,
    competitorEntityId: hex(doc.competitorEntityId), competitorPlaceId: doc.competitorPlaceId,
  };
}

export function createLocationResearchStore(connection: Connection): LocationResearchStore {
  const Run = locationResearchRunModel(connection);
  const Thread = locationResearchThreadModel(connection);
  const Event = locationEventModel(connection);
  const Entity = locationEntityModel(connection);
  const threads = Thread as unknown as Model<ThreadDoc>;
  const runs = Run as unknown as Model<RunDoc>;
  const oid = (value: string) => new Types.ObjectId(value);
  const org = (scope: OrgScope) => ({ orgId: oid(scope.orgId) });
  const at = (scope: OrgScope, locationId: string) => ({ ...org(scope), locationId: oid(locationId) });
  const toThread = (doc: LocationThreadDoc): LocationThreadRecord => ({ ...toThreadBase(doc), locationId: doc.locationId.toHexString() });
  return {
    async insertRun(scope, input) {
      const doc = await insertUnlessDuplicate(Run, {
        ...at(scope, input.locationId), ...newRunDoc(input), trigger: input.trigger, placeId: input.placeId, town: input.town,
        liveSubject: oid(input.locationId),
      });
      return doc === null ? null : toLocationRun(doc);
    },
    async findRun(scope, runId) {
      const doc = await Run.findOne({ ...org(scope), _id: oid(runId) }).lean();
      return doc === null ? null : toLocationRun(doc);
    },
    async lastRun(scope, locationId) {
      const doc = await Run.findOne(at(scope, locationId)).sort({ createdAt: -1, _id: -1 }).lean();
      return doc === null ? null : toLocationRun(doc);
    },
    async liveRun(scope, locationId) {
      const doc = await Run.findOne({ ...org(scope), liveSubject: oid(locationId) }).lean();
      return doc === null ? null : toLocationRun(doc);
    },
    async liveRuns(scope) {
      return (await Run.find({ ...org(scope), liveSubject: trusted({ $type: 'objectId' }) }).lean()).map(toLocationRun);
    },
    async lastFinishedRun(scope, locationId) {
      const doc = await Run.findOne({ ...at(scope, locationId), status: trusted({ $in: ['done', 'partial'] }) }).sort({ finishedAt: -1, _id: -1 }).lean();
      return doc === null ? null : toLocationRun(doc);
    },
    async reportedRuns(scope, locationId, limit) {
      const docs = await Run.find({ ...at(scope, locationId), status: trusted({ $in: [...REPORTED_RUN_STATUSES] }) })
        .sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
      return docs.map(toLocationRun);
    },
    async insertThreads(scope, run, list, now) {
      let inserted = 0;
      for (const each of list) {
        const doc = await insertUnlessDuplicate(Thread, {
          ...at(scope, run.locationId), ...newThreadDoc({ runId: run.id, thread: each.thread, notBefore: each.notBefore, now }),
        });
        if (doc !== null) inserted += 1;
      }
      return inserted;
    },
    async threadsOf(scope, runId) {
      return (await Thread.find({ ...org(scope), runId: oid(runId) }).sort({ _id: 1 }).lean()).map(toThread);
    },
    markRunRunning: (scope, runId, now) => runMoves.markRunning(runs, org(scope), runId, now),
    finishRun: (scope, runId, end) => runMoves.finish(runs, org(scope), runId, end),
    async clearFound(scope, runId) {
      await Thread.updateMany({ ...org(scope), runId: oid(runId) }, { $set: { found: null } });
    },
    reserveThread: (scope, threadId, owner, input) => threadMoves.reserve(threads, org(scope), threadId, owner, input),
    heartbeat: (scope, threadId, owner, input) => threadMoves.heartbeat(threads, org(scope), threadId, owner, input),
    finishThread: (scope, threadId, owner, end) => threadMoves.finish(threads, org(scope), threadId, owner, end),
    requeueThread: (scope, threadId, owner, input) => threadMoves.requeue(threads, org(scope), threadId, owner, input),
    async reclaimThread(scope, threadId, input) {
      const doc = await threadMoves.reclaim(threads, org(scope), threadId, input);
      return doc === null ? null : toThread(doc as LocationThreadDoc);
    },
    async events(scope, locationId) {
      return (await Event.find(at(scope, locationId)).sort({ start: 1, _id: 1 }).lean()).map(toLocationEvent);
    },
    async competitorsAdded(scope, locationId, runIds) {
      const counts = new Map<string, number>();
      if (runIds.length === 0) return counts;
      const docs = await Event.find(
        { ...at(scope, locationId), origin: 'competitor', firstRunId: trusted({ $in: runIds.map(oid) }) }, { firstRunId: 1 },
      ).lean();
      for (const doc of docs) {
        const runId = doc.firstRunId.toHexString();
        counts.set(runId, (counts.get(runId) ?? 0) + 1);
      }
      return counts;
    },
    async insertEvent(scope, locationId, input) {
      const doc = await Event.create({
        ...at(scope, locationId), placeId: input.placeId, town: input.town, ...eventDocOf(input), origin: input.origin,
        competitorEntityId: input.competitorEntityId === null ? null : oid(input.competitorEntityId),
        competitorPlaceId: input.competitorPlaceId,
      });
      return toLocationEvent(doc.toObject());
    },
    async updateEvent(scope, locationId, eventId, update) {
      return (await Event.updateOne({ ...at(scope, locationId), _id: oid(eventId) }, { $set: eventUpdateOf(update) })).matchedCount === 1;
    },
    async entities(scope, locationId) {
      return (await Entity.find(at(scope, locationId)).sort({ _id: 1 }).lean()).map((doc) => ({
        ...toEntityBase(doc), locationId: doc.locationId.toHexString(), placeId: doc.placeId, town: doc.town,
        townEntityId: hex(doc.townEntityId),
      }));
    },
    async upsertEntity(scope, locationId, input) {
      const doc = await Entity.findOneAndUpdate(
        { ...at(scope, locationId), type: input.type, nameKey: input.nameKey },
        {
          $set: {
            name: input.name, placeId: input.placeId, town: input.town,
            townEntityId: input.townEntityId === null ? null : oid(input.townEntityId),
            sources: input.sources.map((s) => ({ label: s.label, url: s.url })), lastSeenAt: input.now,
          },
        },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      return doc._id.toHexString();
    },
    async removeOld(scope, locationId, input) {
      const where = at(scope, locationId);
      let deleted = (await Event.deleteMany({ ...where, end: trusted({ $lt: input.endedBefore }) })).deletedCount;
      const named = [
        ...await Event.distinct('venueId', where), ...await Event.distinct('hostId', where), ...await Event.distinct('competitorEntityId', where),
      ];
      deleted += (await Entity.deleteMany({ ...where, lastSeenAt: trusted({ $lt: input.unseenBefore }), _id: trusted({ $nin: named }) })).deletedCount;
      const old = await Run.find({ ...where, createdAt: trusted({ $lt: input.createdBefore }), liveSubject: trusted({ $exists: false }) }, { _id: 1 }).lean();
      if (old.length > 0) {
        const ids = old.map((doc) => doc._id);
        deleted += (await Thread.deleteMany({ ...where, runId: trusted({ $in: ids }) })).deletedCount;
        deleted += (await Run.deleteMany({ ...where, _id: trusted({ $in: ids }) })).deletedCount;
      }
      return deleted;
    },
    async endLive(scope, locationId, input) {
      const live = await Run.findOne({ ...org(scope), liveSubject: oid(locationId) }, { _id: 1, costMicroUsd: 1, counts: 1 }).lean();
      if (live === null) return false;
      const ended = await runMoves.finish(runs, org(scope), live._id.toHexString(), {
        status: 'off', code: input.code, counts: live.counts, costMicroUsd: live.costMicroUsd, now: input.now,
      });
      await Thread.updateMany(
        { ...org(scope), runId: live._id, status: trusted({ $in: ['queued', 'running'] }) },
        { $set: { status: 'failed', code: input.code, owner: null, leaseUntil: null, finishedAt: input.now } },
      );
      return ended;
    },
    async removeOtherStamps(scope, locationId, stamp) {
      const other = { ...at(scope, locationId), $or: [{ placeId: trusted({ $ne: stamp.placeId }) }, { town: trusted({ $ne: stamp.town }) }] };
      await Event.deleteMany(other);
      await Entity.deleteMany(other);
      return (await Event.find(at(scope, locationId), { _id: 1 }).lean()).map((doc) => doc._id.toHexString());
    },
    async removeForLocation(scope, locationId) {
      let deleted = 0;
      for (const model of [Run, Thread, Event, Entity] as Model<unknown>[]) deleted += (await model.deleteMany(at(scope, locationId))).deletedCount;
      return deleted;
    },
    async removeForOrg(scope) {
      let deleted = 0;
      for (const model of [Run, Thread, Event, Entity] as Model<unknown>[]) deleted += (await model.deleteMany(org(scope))).deletedCount;
      return deleted;
    },
  };
}
