// tw_town_research_runs, tw_town_research_threads, tw_town_events and tw_town_entities (D66, spec 6.32 to 6.35): what
// research found for a town of the twelve, shared by every restaurant there. A town run is one week's research of one
// town (`key` `w:{Monday}`), split into threads that lanes claim with a lease; `liveSubject` equals the town while the
// run is queued, running or merging and then goes, under a unique partial index, so a town has one live run and a
// second insert of it answers null ("already running"), as stores/calibrations.ts's `liveLocation` does. The run's merge
// (research/merge.ts) is the only writer of the town's events and entities.
// It holds no organization's data, so it is not a tenant store and takes no OrgScope (like stores/forecast-schedule.ts):
// `townKey` is a TownId of the twelve, and a town run records no trigger and no requester, so nothing an organization
// did (creating a location, pressing Research now) shows in a shared row (design decision 9). Every move is a
// compare-and-set (no transactions). Nothing here logs.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { ThreadId } from '../research/threads.ts';
import type { EntityType, SourceRef } from '../research/verify.ts';
import type { TownId } from '../towns.ts';
import {
  allThreadsEnded, clearEndedFound, entityFields, eventDocOf, eventFields, eventUpdateOf, insertUnlessDuplicate, newRunDoc, newThreadDoc,
  REPORTED_RUN_STATUSES, runFields, runMoves, SCHEMA_OPTIONS, threadFields, threadMoves, toEntityBase, toEventBase, toRunBase,
  toThreadBase, type EntityDoc, type EntityRecordBase, type EventDoc, type EventInsertBase, type EventRecordBase,
  type EventUpdate, type RunDoc, type RunEnd, type RunRecordBase, type ThreadDoc, type ThreadEnd,
  type ThreadRecordBase, type ThreadTallyWrite,
} from './research-shared.ts';

export const TOWN_RESEARCH_RUNS_COLLECTION = 'tw_town_research_runs';
export const TOWN_RESEARCH_THREADS_COLLECTION = 'tw_town_research_threads';
export const TOWN_EVENTS_COLLECTION = 'tw_town_events';
export const TOWN_ENTITIES_COLLECTION = 'tw_town_entities';

type TownRunDoc = RunDoc & { townKey: TownId; liveSubject?: string; mergeOwner: string | null; mergeUntil: Date | null };
type TownThreadDoc = ThreadDoc & { townKey: TownId };
/** Staff suppressed a row wrong for everyone (api/scripts/research-suppress.ts); a merge never clears it. */
export interface Suppression { readonly at: Date; readonly code: string }
type TownEventDoc = EventDoc & { townKey: TownId; suppressed: Suppression | null };
type TownEntityDoc = EntityDoc & { townKey: TownId };

function townRunSchema(): Schema<TownRunDoc> {
  const schema = new Schema<TownRunDoc>({
    townKey: { type: String, required: true },
    ...runFields(),
    liveSubject: { type: String },
  }, SCHEMA_OPTIONS);
  schema.index({ townKey: 1, key: 1 }, { unique: true });
  schema.index({ liveSubject: 1 }, { unique: true, partialFilterExpression: { liveSubject: { $type: 'string' } } });
  schema.index({ townKey: 1, createdAt: -1 });
  schema.index({ status: 1, createdAt: 1 });
  return schema;
}

function townThreadSchema(): Schema<TownThreadDoc> {
  const schema = new Schema<TownThreadDoc>({ townKey: { type: String, required: true }, ...threadFields() }, SCHEMA_OPTIONS);
  schema.index({ runId: 1, thread: 1 }, { unique: true });
  schema.index({ status: 1, notBefore: 1 });
  schema.index({ status: 1, leaseUntil: 1 });
  return schema;
}

function townEventSchema(): Schema<TownEventDoc> {
  const suppressed = new Schema<Suppression>({ at: { type: Date, required: true }, code: { type: String, required: true } }, { _id: false, strict: 'throw' });
  const schema = new Schema<TownEventDoc>({
    townKey: { type: String, required: true },
    ...eventFields(),
    suppressed: { type: suppressed, default: null },
  }, SCHEMA_OPTIONS);
  schema.index({ townKey: 1, start: 1 });
  schema.index({ townKey: 1, end: 1 });
  return schema;
}

function townEntitySchema(): Schema<TownEntityDoc> {
  const schema = new Schema<TownEntityDoc>({ townKey: { type: String, required: true }, ...entityFields() }, SCHEMA_OPTIONS);
  schema.index({ townKey: 1, type: 1, nameKey: 1 }, { unique: true });
  return schema;
}

/** Registers TwTownResearchRun (tw_town_research_runs) on first call. */
export function townResearchRunModel(connection: Connection): Model<TownRunDoc> {
  const existing = connection.models.TwTownResearchRun as Model<TownRunDoc> | undefined;
  return existing ?? connection.model<TownRunDoc>('TwTownResearchRun', townRunSchema(), TOWN_RESEARCH_RUNS_COLLECTION);
}

/** Registers TwTownResearchThread (tw_town_research_threads) on first call. */
export function townResearchThreadModel(connection: Connection): Model<TownThreadDoc> {
  const existing = connection.models.TwTownResearchThread as Model<TownThreadDoc> | undefined;
  return existing ?? connection.model<TownThreadDoc>('TwTownResearchThread', townThreadSchema(), TOWN_RESEARCH_THREADS_COLLECTION);
}

/** Registers TwTownEvent (tw_town_events) on first call. */
export function townEventModel(connection: Connection): Model<TownEventDoc> {
  const existing = connection.models.TwTownEvent as Model<TownEventDoc> | undefined;
  return existing ?? connection.model<TownEventDoc>('TwTownEvent', townEventSchema(), TOWN_EVENTS_COLLECTION);
}

/** Registers TwTownEntity (tw_town_entities) on first call. */
export function townEntityModel(connection: Connection): Model<TownEntityDoc> {
  const existing = connection.models.TwTownEntity as Model<TownEntityDoc> | undefined;
  return existing ?? connection.model<TownEntityDoc>('TwTownEntity', townEntitySchema(), TOWN_ENTITIES_COLLECTION);
}

export interface TownRunRecord extends RunRecordBase { readonly townKey: TownId }
export interface TownThreadRecord extends ThreadRecordBase { readonly townKey: TownId }
export interface TownEventRecord extends EventRecordBase { readonly townKey: TownId; readonly suppressed: Suppression | null }
export interface TownEntityRecord extends EntityRecordBase { readonly townKey: TownId }

export interface TownResearchStore {
  /**
   * Inserts a queued run holding the town's live slot. Null when the town already has a live run or a run of this
   * `key` (both unique indexes), which every insert path reads as "already running" (design decision 2).
   */
  insertRun(input: { townKey: TownId; key: string; threads: readonly ThreadId[]; now: Date }): Promise<TownRunRecord | null>;
  findRun(id: string): Promise<TownRunRecord | null>;
  /** The town's newest run, by creation (the planner's 6-day rule). */
  lastRun(townKey: TownId): Promise<TownRunRecord | null>;
  /** The town's live (queued, running or merging) run, if any. */
  liveRun(townKey: TownId): Promise<TownRunRecord | null>;
  /** The town's latest merged (`done` or `partial`) run: what a prompt's `known` rows were found again by (decision 4). */
  lastFinishedRun(townKey: TownId): Promise<TownRunRecord | null>;
  /** The town's runs ended `done`, `partial`, `failed` or `budget`, newest first, at most `limit` (TownwiseAI's activity). */
  reportedRuns(townKey: TownId, limit: number): Promise<TownRunRecord[]>;
  /** Inserts the run's thread rows that are missing (unique `(runId, thread)`); resolves how many it inserted. */
  insertThreads(run: { id: string; townKey: TownId }, threads: readonly { thread: ThreadId; notBefore: Date }[], now: Date): Promise<number>;
  threadsOf(runId: string): Promise<TownThreadRecord[]>;
  /** queued → running. */
  markRunRunning(id: string, now: Date): Promise<boolean>;
  /**
   * running → merging for `owner` once every thread of the run is terminal, or a stale merging run (its merge lease
   * passed) taken over. The lane that settles the last thread and the planner's sweep both ask; one wins (decision 8).
   */
  claimMerge(input: { runId: string; owner: string; now: Date; leaseMs: number }): Promise<boolean>;
  /**
   * The planner's merge sweep (decision 2): ids of `running` runs, and `merging` runs whose merge lease passed by `now`,
   * oldest first, at most 50. claimMerge decides which of them are ready.
   */
  mergeableRuns(now: Date): Promise<string[]>;
  /** Ends a live run and frees the town's slot; with `mergeOwner`, only while that merge still holds it. */
  finishRun(id: string, end: RunEnd, mergeOwner?: string): Promise<boolean>;
  /** Renews `owner`'s merge lease; false once the run ended or another merge took it over (runMoves.holdMerge). */
  holdMerge(id: string, input: { owner: string; now: Date; leaseMs: number }): Promise<boolean>;
  /** Clears `found` on the run's threads once merged (counts and drops kept). */
  clearFound(runId: string): Promise<void>;
  /** Claims the queued town thread due first, counting the attempt. */
  claimThread(input: { owner: string; now: Date; leaseMs: number }): Promise<TownThreadRecord | null>;
  reserveThread(id: string, owner: string, input: { reservedMicroUsd: number; month: string }): Promise<boolean>;
  heartbeat(id: string, owner: string, input: ThreadTallyWrite & { now: Date; leaseMs: number }): Promise<boolean>;
  finishThread(id: string, owner: string, end: ThreadEnd): Promise<boolean>;
  requeueThread(id: string, owner: string, input: ThreadTallyWrite & { notBefore: Date; code: string | null }): Promise<boolean>;
  /**
   * Puts a claimed thread back with its attempt not counted (a shutdown before any call, threadMoves.release), due at
   * `notBefore` when given (a reservation waiting for another's in flight).
   */
  releaseThread(id: string, owner: string, notBefore?: Date): Promise<boolean>;
  /** Whether a running town thread other than `id` holds a reservation now (any town: they share the month's cap). */
  othersReserving(id: string): Promise<boolean>;
  /** Running threads whose lease passed by `now` (a dead replica's), ids only. */
  staleThreads(now: Date): Promise<string[]>;
  reclaimThread(id: string, input: { now: Date; next: { status: 'queued'; notBefore: Date } | { status: 'failed'; code: string } }): Promise<TownThreadRecord | null>;
  /** The town's stored events, suppressed ones included (the merge reads them; every reader leaves those out). */
  events(townKey: TownId): Promise<TownEventRecord[]>;
  insertEvent(townKey: TownId, input: EventInsertBase): Promise<TownEventRecord>;
  /** A merge's update of a stored row: never its title, dates or suppression. */
  updateEvent(townKey: TownId, id: string, update: EventUpdate): Promise<boolean>;
  entities(townKey: TownId): Promise<TownEntityRecord[]>;
  /** Inserts the entity or refreshes its name, sources and last seen; resolves its id. */
  upsertEntity(townKey: TownId, input: { type: EntityType; name: string; nameKey: string; sources: readonly SourceRef[]; now: Date }): Promise<string>;
  /**
   * A merge's retention (decision 8 step 6): events that ended before `endedBefore` (a day), entities last seen before
   * `unseenBefore` that no event names, and ended runs and their threads created before `createdBefore`; and `found`
   * cleared on the threads of any ended run (clearEndedFound). Resolves the number deleted.
   */
  removeOld(townKey: TownId, input: { endedBefore: string; unseenBefore: Date; createdBefore: Date }): Promise<number>;
  /**
   * Staff suppression (design decision 9, scripts/research-suppress.ts): marks a town row `suppressed { at, code }`, so
   * every read and every prompt leaves it out and a merge never clears it. False when the town holds no such row.
   */
  suppress(townKey: TownId, eventId: string, input: { at: Date; code: string }): Promise<boolean>;
}

function toTownRun(doc: TownRunDoc): TownRunRecord {
  return { ...toRunBase(doc), townKey: doc.townKey };
}

function toTownThread(doc: TownThreadDoc): TownThreadRecord {
  return { ...toThreadBase(doc), townKey: doc.townKey };
}

function toTownEvent(doc: TownEventDoc): TownEventRecord {
  return {
    ...toEventBase(doc), townKey: doc.townKey,
    suppressed: doc.suppressed === null ? null : { at: doc.suppressed.at, code: doc.suppressed.code },
  };
}

export function createTownResearchStore(connection: Connection): TownResearchStore {
  const Run = townResearchRunModel(connection);
  const Thread = townResearchThreadModel(connection);
  const Event = townEventModel(connection);
  const Entity = townEntityModel(connection);
  const threads = Thread as unknown as Model<ThreadDoc>;
  const runs = Run as unknown as Model<RunDoc>;
  const id = (value: string) => new Types.ObjectId(value);
  return {
    async insertRun(input) {
      const doc = await insertUnlessDuplicate(Run, { townKey: input.townKey, ...newRunDoc(input), liveSubject: input.townKey });
      return doc === null ? null : toTownRun(doc);
    },
    async findRun(runId) {
      const doc = await Run.findById(id(runId)).lean();
      return doc === null ? null : toTownRun(doc);
    },
    async lastRun(townKey) {
      const doc = await Run.findOne({ townKey }).sort({ createdAt: -1, _id: -1 }).lean();
      return doc === null ? null : toTownRun(doc);
    },
    async liveRun(townKey) {
      const doc = await Run.findOne({ liveSubject: townKey }).lean();
      return doc === null ? null : toTownRun(doc);
    },
    async lastFinishedRun(townKey) {
      const doc = await Run.findOne({ townKey, status: trusted({ $in: ['done', 'partial'] }) }).sort({ finishedAt: -1, _id: -1 }).lean();
      return doc === null ? null : toTownRun(doc);
    },
    async reportedRuns(townKey, limit) {
      const docs = await Run.find({ townKey, status: trusted({ $in: [...REPORTED_RUN_STATUSES] }) }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
      return docs.map(toTownRun);
    },
    async insertThreads(run, list, now) {
      let inserted = 0;
      for (const each of list) {
        const doc = await insertUnlessDuplicate(Thread, { townKey: run.townKey, ...newThreadDoc({ runId: run.id, thread: each.thread, notBefore: each.notBefore, now }) });
        if (doc !== null) inserted += 1;
      }
      return inserted;
    },
    async threadsOf(runId) {
      return (await Thread.find({ runId: id(runId) }).sort({ _id: 1 }).lean()).map(toTownThread);
    },
    markRunRunning: (runId, now) => runMoves.markRunning(runs, {}, runId, now),
    async claimMerge(input) {
      const run = await Run.findById(id(input.runId), { threads: 1 }).lean();
      if (run === null || !await allThreadsEnded(threads, {}, run._id, run.threads.length)) return false;
      const set = { $set: { status: 'merging', mergeOwner: input.owner, mergeUntil: new Date(input.now.getTime() + input.leaseMs) } };
      if ((await Run.updateOne({ _id: id(input.runId), status: 'running' }, set)).modifiedCount === 1) return true;
      return (await Run.updateOne({ _id: id(input.runId), status: 'merging', mergeUntil: trusted({ $lte: input.now }) }, set)).modifiedCount === 1;
    },
    async mergeableRuns(now) {
      const docs = await Run.find(
        { $or: [{ status: 'running' as const }, { status: 'merging' as const, mergeUntil: trusted({ $lte: now }) }] }, { _id: 1 },
      ).sort({ createdAt: 1, _id: 1 }).limit(50).lean();
      return docs.map((doc) => doc._id.toHexString());
    },
    finishRun: (runId, end, mergeOwner) => runMoves.finish(runs, {}, runId, end, mergeOwner),
    holdMerge: (runId, input) => runMoves.holdMerge(runs, {}, runId, input),
    async clearFound(runId) {
      await Thread.updateMany({ runId: id(runId) }, { $set: { found: null } });
    },
    async claimThread(input) {
      const doc = await threadMoves.claim(threads, {}, input);
      return doc === null ? null : toTownThread(doc as TownThreadDoc);
    },
    reserveThread: (threadId, owner, input) => threadMoves.reserve(threads, {}, threadId, owner, input),
    heartbeat: (threadId, owner, input) => threadMoves.heartbeat(threads, {}, threadId, owner, input),
    finishThread: (threadId, owner, end) => threadMoves.finish(threads, {}, threadId, owner, end),
    requeueThread: (threadId, owner, input) => threadMoves.requeue(threads, {}, threadId, owner, input),
    releaseThread: (threadId, owner, notBefore) => threadMoves.release(threads, {}, threadId, owner, notBefore),
    async othersReserving(threadId) {
      const other = { _id: trusted({ $ne: id(threadId) }), status: 'running' as const, reservedMicroUsd: trusted({ $gt: 0 }) };
      return await Thread.exists(other) !== null;
    },
    async staleThreads(now) {
      const docs = await Thread.find({ status: 'running', leaseUntil: trusted({ $lte: now }) }, { _id: 1 }).lean();
      return docs.map((doc) => doc._id.toHexString());
    },
    async reclaimThread(threadId, input) {
      const doc = await threadMoves.reclaim(threads, {}, threadId, input);
      return doc === null ? null : toTownThread(doc as TownThreadDoc);
    },
    async events(townKey) {
      return (await Event.find({ townKey }).sort({ start: 1, _id: 1 }).lean()).map(toTownEvent);
    },
    async insertEvent(townKey, input) {
      const doc = await Event.create({ townKey, ...eventDocOf(input), suppressed: null });
      return toTownEvent(doc.toObject());
    },
    async updateEvent(townKey, eventId, update) {
      return (await Event.updateOne({ _id: id(eventId), townKey }, { $set: eventUpdateOf(update) })).matchedCount === 1;
    },
    async entities(townKey) {
      return (await Entity.find({ townKey }).sort({ _id: 1 }).lean()).map((doc) => ({ ...toEntityBase(doc), townKey: doc.townKey }));
    },
    async upsertEntity(townKey, input) {
      const doc = await Entity.findOneAndUpdate(
        { townKey, type: input.type, nameKey: input.nameKey },
        { $set: { name: input.name, sources: input.sources.map((s) => ({ label: s.label, url: s.url })), lastSeenAt: input.now } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      return doc._id.toHexString();
    },
    async removeOld(townKey, input) {
      let deleted = (await Event.deleteMany({ townKey, end: trusted({ $lt: input.endedBefore }) })).deletedCount;
      const named = [...await Event.distinct('venueId', { townKey }), ...await Event.distinct('hostId', { townKey })];
      deleted += (await Entity.deleteMany({ townKey, lastSeenAt: trusted({ $lt: input.unseenBefore }), _id: trusted({ $nin: named }) })).deletedCount;
      const old = await Run.find({ townKey, createdAt: trusted({ $lt: input.createdBefore }), liveSubject: trusted({ $exists: false }) }, { _id: 1 }).lean();
      if (old.length > 0) {
        const ids = old.map((doc) => doc._id);
        deleted += (await Thread.deleteMany({ townKey, runId: trusted({ $in: ids }) })).deletedCount;
        deleted += (await Run.deleteMany({ townKey, _id: trusted({ $in: ids }) })).deletedCount;
      }
      await clearEndedFound(runs, threads, { townKey });
      return deleted;
    },
    async suppress(townKey, eventId, input) {
      return (await Event.updateOne({ _id: id(eventId), townKey }, { $set: { suppressed: { at: input.at, code: input.code } } })).matchedCount === 1;
    },
  };
}
