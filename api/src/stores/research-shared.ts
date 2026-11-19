// The shapes D66's research stores share (design decision 9): a run, its threads, a researched event and an entity
// look the same for a town (stores/research-towns.ts, no tenant) and for a location (stores/research-locations.ts,
// tenant), apart from the subject's own fields. This file holds those sub-schemas, record types and the thread and run
// moves both make, each a compare-and-set that a caller hands its own model and base filter (a town key, or an OrgScope's
// organization and location): it defines no model and reads no environment, and it never takes an OrgScope itself, so
// tenancy stays with the two stores that call it. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Model } from 'mongoose';

import { LOCATION_THREADS, TOWN_THREADS, type ThreadId } from '../research/threads.ts';
import {
  CONFIDENCES, ENTITY_DROP_REASONS, ENTITY_TYPES, EVENT_CATEGORIES, EVENT_DROP_REASONS, EVENT_KINDS, EVENT_STATUSES,
  type Confidence, type EntityDrops, type EntityType, type EventCategory, type EventDrops, type EventKind,
  type EventStatus, type Finding, type FoundEntity, type SourceRef,
} from '../research/verify.ts';

/** A run: `queued → running → merging → done | partial | failed | budget | off` (design decision 2). */
export const RUN_STATUSES = ['queued', 'running', 'merging', 'done', 'partial', 'failed', 'budget', 'off'] as const;
export type RunStatus = typeof RUN_STATUSES[number];
/** The statuses that hold the subject's one live slot (`liveSubject`). */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'merging'];
export type EndedRunStatus = Exclude<RunStatus, 'queued' | 'running' | 'merging'>;

/** A thread: `queued → running → recorded | empty | budget | failed`, with a code. */
export const THREAD_STATUSES = ['queued', 'running', 'recorded', 'empty', 'budget', 'failed'] as const;
export type ThreadStatus = typeof THREAD_STATUSES[number];
export const TERMINAL_THREAD_STATUSES: readonly ThreadStatus[] = ['recorded', 'empty', 'budget', 'failed'];
export type EndedThreadStatus = Exclude<ThreadStatus, 'queued' | 'running'>;

export const THREAD_IDS: readonly ThreadId[] = [...TOWN_THREADS, ...LOCATION_THREADS];

export interface RunCounts { readonly found: number; readonly added: number; readonly updated: number; readonly dropped: number }
export const NO_COUNTS: RunCounts = { found: 0, added: 0, updated: 0, dropped: 0 };

/** What a recorded thread found, kept for the merge and cleared once the run is merged (decision 8 step 6). */
export interface StoredFound { readonly events: readonly Finding[]; readonly entities: readonly FoundEntity[] }
export interface StoredDrops { readonly events: EventDrops; readonly entities: EntityDrops }

const sub = { _id: false, strict: 'throw' } as const;

function sourceSchema(): Schema<SourceRef> {
  return new Schema<SourceRef>({ label: { type: String, required: true }, url: { type: String, required: true } }, sub);
}

function countsSchema(reasons: readonly string[]): Schema {
  return new Schema(Object.fromEntries(reasons.map((reason) => [reason, { type: Number, required: true }])), sub);
}

function foundSchema(): Schema<StoredFound> {
  const event = new Schema<Finding>({
    title: { type: String, required: true },
    kind: { type: String, required: true, enum: EVENT_KINDS },
    category: { type: String, required: true, enum: EVENT_CATEGORIES },
    start: { type: String, required: true },
    end: { type: String, required: true },
    weekdays: { type: [Number], default: null },
    startTime: { type: String, default: null },
    status: { type: String, required: true, enum: EVENT_STATUSES },
    venueRef: { type: String, default: null },
    hostRef: { type: String, default: null },
    competitor: { type: Number, default: null },
    sources: { type: [sourceSchema()], required: true },
    grounded: { type: Boolean, required: true },
    codeConfidence: { type: String, required: true, enum: CONFIDENCES },
    confidence: { type: String, required: true, enum: CONFIDENCES },
  }, sub);
  const entity = new Schema<FoundEntity>({
    ref: { type: String, required: true },
    type: { type: String, required: true, enum: ENTITY_TYPES },
    name: { type: String, required: true },
    sources: { type: [sourceSchema()], required: true },
  }, sub);
  return new Schema<StoredFound>({ events: { type: [event], required: true }, entities: { type: [entity], required: true } }, sub);
}

/** A run's fields both subjects share; `liveSubject` is added by each store with its own type. */
export function runFields(): Record<string, unknown> {
  const counts = new Schema<RunCounts>({
    found: { type: Number, required: true }, added: { type: Number, required: true },
    updated: { type: Number, required: true }, dropped: { type: Number, required: true },
  }, sub);
  return {
    key: { type: String, required: true },
    status: { type: String, required: true, enum: RUN_STATUSES },
    /** Why an `off` or `failed` run ended (`location_gone`, `place_changed`, ...), else null. */
    code: { type: String, default: null },
    /** The thread ids planned, so a plan that crashed between the run and its threads is completed (decision 2). */
    threads: { type: [{ type: String, enum: THREAD_IDS }], required: true },
    counts: { type: counts, required: true },
    costMicroUsd: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    mergeOwner: { type: String, default: null },
    mergeUntil: { type: Date, default: null },
  };
}

/** A thread's fields both subjects share. */
export function threadFields(): Record<string, unknown> {
  return {
    runId: { type: Schema.Types.ObjectId, required: true },
    thread: { type: String, required: true, enum: THREAD_IDS },
    status: { type: String, required: true, enum: THREAD_STATUSES },
    code: { type: String, default: null },
    attempts: { type: Number, required: true },
    notBefore: { type: Date, required: true },
    owner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    reservedMicroUsd: { type: Number, required: true },
    spentMicroUsd: { type: Number, required: true },
    /** The month (YYYY-MM, UTC) its reservation was made in, so it settles there; null before one. */
    month: { type: String, default: null },
    found: { type: foundSchema(), default: null },
    drops: { type: new Schema({ events: { type: countsSchema(EVENT_DROP_REASONS), required: true }, entities: { type: countsSchema(ENTITY_DROP_REASONS), required: true } }, sub), default: null },
    searches: { type: Number, required: true },
    fetches: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
  };
}

/** A researched event's fields both subjects share. */
export function eventFields(): Record<string, unknown> {
  return {
    title: { type: String, required: true },
    titleKey: { type: String, required: true },
    kind: { type: String, required: true, enum: EVENT_KINDS },
    category: { type: String, required: true, enum: EVENT_CATEGORIES },
    start: { type: String, required: true },
    end: { type: String, required: true },
    weekdays: { type: [Number], default: null },
    startTime: { type: String, default: null },
    status: { type: String, required: true, enum: EVENT_STATUSES },
    venueId: { type: Schema.Types.ObjectId, default: null },
    hostId: { type: Schema.Types.ObjectId, default: null },
    confidence: { type: String, required: true, enum: CONFIDENCES },
    sources: { type: [sourceSchema()], required: true },
    firstRunId: { type: Schema.Types.ObjectId, required: true },
    lastRunId: { type: Schema.Types.ObjectId, required: true },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    seenCount: { type: Number, required: true },
  };
}

/** An entity's fields both subjects share. */
export function entityFields(): Record<string, unknown> {
  return {
    type: { type: String, required: true, enum: ENTITY_TYPES },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    sources: { type: [sourceSchema()], required: true },
    lastSeenAt: { type: Date, required: true },
  };
}

export const SCHEMA_OPTIONS = { strict: 'throw', versionKey: false, read: 'primary', minimize: false } as const;

// ---- Records --------------------------------------------------------------------------------------------------------

export interface RunRecordBase {
  readonly id: string;
  readonly key: string;
  readonly status: RunStatus;
  readonly code: string | null;
  readonly threads: readonly ThreadId[];
  readonly counts: RunCounts;
  readonly costMicroUsd: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface ThreadRecordBase {
  readonly id: string;
  readonly runId: string;
  readonly thread: ThreadId;
  readonly status: ThreadStatus;
  readonly code: string | null;
  readonly attempts: number;
  readonly notBefore: Date;
  readonly owner: string | null;
  readonly leaseUntil: Date | null;
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly month: string | null;
  readonly found: StoredFound | null;
  readonly drops: StoredDrops | null;
  readonly searches: number;
  readonly fetches: number;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface EventRecordBase {
  readonly id: string;
  readonly title: string;
  readonly titleKey: string;
  readonly kind: EventKind;
  readonly category: EventCategory;
  readonly start: string;
  readonly end: string;
  readonly weekdays: readonly number[] | null;
  readonly startTime: string | null;
  readonly status: EventStatus;
  readonly venueId: string | null;
  readonly hostId: string | null;
  readonly confidence: Confidence;
  readonly sources: readonly SourceRef[];
  readonly firstRunId: string;
  readonly lastRunId: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly seenCount: number;
}

export interface EntityRecordBase {
  readonly id: string;
  readonly type: EntityType;
  readonly name: string;
  readonly nameKey: string;
  readonly sources: readonly SourceRef[];
  readonly lastSeenAt: Date;
}

/** What a merge inserts: an event's own values (ids as hex strings). */
export type EventInsertBase = Omit<EventRecordBase, 'id'>;

/** What a merge changes on a stored row (decision 8 step 5): never its title or dates. */
export interface EventUpdate {
  readonly lastRunId: string;
  readonly lastSeenAt: Date;
  readonly seenCount: number;
  readonly sources: readonly SourceRef[];
  readonly confidence: Confidence;
  readonly status: EventStatus;
}

type Id = Types.ObjectId;
const hex = (id: Id | null | undefined): string | null => (id == null ? null : id.toHexString());
const oid = (id: string | null): Id | null => (id === null ? null : new Types.ObjectId(id));
const sources = (list: readonly SourceRef[]): SourceRef[] => list.map((source) => ({ label: source.label, url: source.url }));

export interface RunDoc {
  _id: Id; key: string; status: RunStatus; code: string | null; threads: ThreadId[]; counts: RunCounts;
  costMicroUsd: number; createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
}

export function toRunBase(doc: RunDoc): RunRecordBase {
  return {
    id: doc._id.toHexString(), key: doc.key, status: doc.status, code: doc.code ?? null, threads: [...doc.threads],
    counts: { found: doc.counts.found, added: doc.counts.added, updated: doc.counts.updated, dropped: doc.counts.dropped },
    costMicroUsd: doc.costMicroUsd, createdAt: doc.createdAt, startedAt: doc.startedAt, finishedAt: doc.finishedAt,
  };
}

export interface ThreadDoc {
  _id: Id; runId: Id; thread: ThreadId; status: ThreadStatus; code: string | null; attempts: number; notBefore: Date;
  owner: string | null; leaseUntil: Date | null; reservedMicroUsd: number; spentMicroUsd: number; month: string | null;
  found: StoredFound | null; drops: StoredDrops | null; searches: number; fetches: number; createdAt: Date;
  finishedAt: Date | null;
}

export function toThreadBase(doc: ThreadDoc): ThreadRecordBase {
  return {
    id: doc._id.toHexString(), runId: doc.runId.toHexString(), thread: doc.thread, status: doc.status, code: doc.code,
    attempts: doc.attempts, notBefore: doc.notBefore, owner: doc.owner, leaseUntil: doc.leaseUntil,
    reservedMicroUsd: doc.reservedMicroUsd, spentMicroUsd: doc.spentMicroUsd, month: doc.month,
    found: doc.found, drops: doc.drops, searches: doc.searches, fetches: doc.fetches, createdAt: doc.createdAt,
    finishedAt: doc.finishedAt,
  };
}

export interface EventDoc {
  _id: Id; title: string; titleKey: string; kind: EventKind; category: EventCategory; start: string; end: string;
  weekdays: number[] | null; startTime: string | null; status: EventStatus; venueId: Id | null; hostId: Id | null;
  confidence: Confidence; sources: SourceRef[]; firstRunId: Id; lastRunId: Id; firstSeenAt: Date; lastSeenAt: Date;
  seenCount: number;
}

export function toEventBase(doc: EventDoc): EventRecordBase {
  return {
    id: doc._id.toHexString(), title: doc.title, titleKey: doc.titleKey, kind: doc.kind, category: doc.category,
    start: doc.start, end: doc.end, weekdays: doc.weekdays === null ? null : [...doc.weekdays], startTime: doc.startTime,
    status: doc.status, venueId: hex(doc.venueId), hostId: hex(doc.hostId), confidence: doc.confidence,
    sources: sources(doc.sources), firstRunId: doc.firstRunId.toHexString(), lastRunId: doc.lastRunId.toHexString(),
    firstSeenAt: doc.firstSeenAt, lastSeenAt: doc.lastSeenAt, seenCount: doc.seenCount,
  };
}

export function eventDocOf(input: EventInsertBase): Record<string, unknown> {
  return {
    title: input.title, titleKey: input.titleKey, kind: input.kind, category: input.category, start: input.start,
    end: input.end, weekdays: input.weekdays === null ? null : [...input.weekdays], startTime: input.startTime,
    status: input.status, venueId: oid(input.venueId), hostId: oid(input.hostId), confidence: input.confidence,
    sources: sources(input.sources), firstRunId: new Types.ObjectId(input.firstRunId),
    lastRunId: new Types.ObjectId(input.lastRunId), firstSeenAt: input.firstSeenAt, lastSeenAt: input.lastSeenAt,
    seenCount: input.seenCount,
  };
}

export function eventUpdateOf(update: EventUpdate): Record<string, unknown> {
  return {
    lastRunId: new Types.ObjectId(update.lastRunId), lastSeenAt: update.lastSeenAt, seenCount: update.seenCount,
    sources: sources(update.sources), confidence: update.confidence, status: update.status,
  };
}

export interface EntityDoc { _id: Id; type: EntityType; name: string; nameKey: string; sources: SourceRef[]; lastSeenAt: Date }

export function toEntityBase(doc: EntityDoc): EntityRecordBase {
  return { id: doc._id.toHexString(), type: doc.type, name: doc.name, nameKey: doc.nameKey, sources: sources(doc.sources), lastSeenAt: doc.lastSeenAt };
}

// ---- Moves both stores make -------------------------------------------------------------------------------------------

type Filter = Record<string, unknown>;

/** Inserts a document; null on a duplicate key (a unique key or the one-live-run index already holds it). */
export async function insertUnlessDuplicate<T>(model: Model<T>, doc: Filter): Promise<(T & { _id: Id }) | null> {
  try {
    const [created] = await model.insertMany([doc as T]);
    return created === undefined ? null : created.toObject() as T & { _id: Id };
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
}

/** A thread row's first values. */
export function newThreadDoc(input: { runId: string; thread: ThreadId; notBefore: Date; now: Date }): Filter {
  return {
    runId: new Types.ObjectId(input.runId), thread: input.thread, status: 'queued', code: null, attempts: 0,
    notBefore: input.notBefore, owner: null, leaseUntil: null, reservedMicroUsd: 0, spentMicroUsd: 0, month: null,
    found: null, drops: null, searches: 0, fetches: 0, createdAt: input.now, finishedAt: null,
  };
}

/** A new run's first values, apart from its subject. */
export function newRunDoc(input: { key: string; threads: readonly ThreadId[]; now: Date }): Filter {
  return {
    key: input.key, status: 'queued', code: null, threads: [...input.threads], counts: { ...NO_COUNTS }, costMicroUsd: 0,
    createdAt: input.now, startedAt: null, finishedAt: null, mergeOwner: null, mergeUntil: null,
  };
}

/** The tally a heartbeat writes. */
export interface ThreadTallyWrite { readonly spentMicroUsd: number; readonly searches: number; readonly fetches: number }

export interface ThreadEnd extends ThreadTallyWrite {
  readonly status: EndedThreadStatus;
  readonly code: string | null;
  readonly found: StoredFound | null;
  readonly drops: StoredDrops | null;
  readonly now: Date;
}

export const threadMoves = {
  /** Claims a queued thread due by `now` (oldest `notBefore` first) for `owner`, counting the attempt. */
  async claim(model: Model<ThreadDoc>, base: Filter, input: { owner: string; now: Date; leaseMs: number }): Promise<ThreadDoc | null> {
    return model.findOneAndUpdate(
      { ...base, status: 'queued', notBefore: trusted({ $lte: input.now }) },
      { $set: { status: 'running', owner: input.owner, leaseUntil: new Date(input.now.getTime() + input.leaseMs) }, $inc: { attempts: 1 } },
      { sort: { notBefore: 1, _id: 1 }, returnDocument: 'after' },
    ).lean<ThreadDoc>();
  },
  /** Records the reservation and its month on `owner`'s running thread. */
  async reserve(model: Model<ThreadDoc>, base: Filter, id: string, owner: string, input: { reservedMicroUsd: number; month: string }): Promise<boolean> {
    const result = await model.updateOne(
      { ...base, _id: new Types.ObjectId(id), status: 'running', owner },
      { $set: { reservedMicroUsd: input.reservedMicroUsd, month: input.month } },
    );
    return result.matchedCount === 1;
  },
  /** Extends the lease and writes the tally, while `owner` still runs it; a miss tells the lane to abort (decision 6). */
  async heartbeat(model: Model<ThreadDoc>, base: Filter, id: string, owner: string, input: ThreadTallyWrite & { now: Date; leaseMs: number }): Promise<boolean> {
    const result = await model.updateOne(
      { ...base, _id: new Types.ObjectId(id), status: 'running', owner },
      {
        $set: {
          leaseUntil: new Date(input.now.getTime() + input.leaseMs), spentMicroUsd: input.spentMicroUsd,
          searches: input.searches, fetches: input.fetches,
        },
      },
    );
    return result.matchedCount === 1;
  },
  /** Ends `owner`'s running thread. */
  async finish(model: Model<ThreadDoc>, base: Filter, id: string, owner: string, end: ThreadEnd): Promise<boolean> {
    const result = await model.updateOne(
      { ...base, _id: new Types.ObjectId(id), status: 'running', owner },
      {
        $set: {
          status: end.status, code: end.code, found: end.found, drops: end.drops, spentMicroUsd: end.spentMicroUsd,
          searches: end.searches, fetches: end.fetches, owner: null, leaseUntil: null, finishedAt: end.now,
        },
      },
    );
    return result.modifiedCount === 1;
  },
  /** Puts `owner`'s running thread back in the queue until `notBefore` (a retry, or a graceful shutdown). */
  async requeue(model: Model<ThreadDoc>, base: Filter, id: string, owner: string, input: ThreadTallyWrite & { notBefore: Date; code: string | null }): Promise<boolean> {
    const result = await model.updateOne(
      { ...base, _id: new Types.ObjectId(id), status: 'running', owner },
      {
        $set: {
          status: 'queued', code: input.code, owner: null, leaseUntil: null, notBefore: input.notBefore,
          spentMicroUsd: input.spentMicroUsd, searches: input.searches, fetches: input.fetches,
        },
      },
    );
    return result.modifiedCount === 1;
  },
  /**
   * Takes back a running thread whose lease passed (a dead replica's), queued again or ended, and answers it as it was,
   * so the caller settles its last written tally (decision 6). Null when it was not stale by then.
   */
  async reclaim(model: Model<ThreadDoc>, base: Filter, id: string, input: { now: Date; next: { status: 'queued'; notBefore: Date } | { status: 'failed'; code: string } }): Promise<ThreadDoc | null> {
    const set = input.next.status === 'queued'
      ? { status: 'queued', owner: null, leaseUntil: null, notBefore: input.next.notBefore }
      : { status: 'failed', code: input.next.code, owner: null, leaseUntil: null, finishedAt: input.now };
    return model.findOneAndUpdate(
      { ...base, _id: new Types.ObjectId(id), status: 'running', leaseUntil: trusted({ $lte: input.now }) },
      { $set: set },
      { returnDocument: 'before' },
    ).lean<ThreadDoc>();
  },
};

export interface RunEnd {
  readonly status: EndedRunStatus;
  readonly code: string | null;
  readonly counts: RunCounts;
  readonly costMicroUsd: number;
  readonly now: Date;
}

export const runMoves = {
  /** queued → running, when its first thread is claimed. */
  async markRunning(model: Model<RunDoc>, base: Filter, id: string, now: Date): Promise<boolean> {
    const result = await model.updateOne({ ...base, _id: new Types.ObjectId(id), status: 'queued' }, { $set: { status: 'running', startedAt: now } });
    return result.modifiedCount === 1;
  },
  /** Ends a live run and frees its subject's slot. False when it had already ended. */
  async finish(model: Model<RunDoc>, base: Filter, id: string, end: RunEnd): Promise<boolean> {
    const result = await model.updateOne(
      { ...base, _id: new Types.ObjectId(id), status: trusted({ $in: [...LIVE_RUN_STATUSES] }) },
      {
        $set: {
          status: end.status, code: end.code, counts: { ...end.counts }, costMicroUsd: end.costMicroUsd, finishedAt: end.now,
          mergeOwner: null, mergeUntil: null,
        },
        $unset: { liveSubject: '' },
      },
    );
    return result.modifiedCount === 1;
  },
};

/** Ids as ObjectIds, for an `$in`. */
export function objectIds(ids: readonly string[]): Id[] {
  return ids.map((id) => new Types.ObjectId(id));
}
