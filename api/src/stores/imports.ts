// tw_imports (spec 6.12): a batch of files dropped for one location and read in upload order. One import per location
// is active at a time (a unique index on `activeLocation`, which only a done import lacks), so a location's files
// are never read concurrently. The worker's claim and lease live in stores/cross-tenant.ts. Nothing here logs.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import { HAS_VALUE, SALES_DAYS_COLLECTION } from './sales-days.ts';

export const IMPORTS_COLLECTION = 'tw_imports';

export type ImportStatus = 'open' | 'queued' | 'reading' | 'waiting' | 'done';
export type QuestionKind = 'date_column' | 'date_order' | 'location_value' | 'row_mode' | 'columns';

/** A question the reader asks about one file (spec 11A). Labels are header names, location values or enum ids. */
export interface ImportQuestion {
  readonly id: string;
  readonly fileId: string;
  /** The sheet the question is about; 0 for a text file. */
  readonly sheet: number;
  readonly kind: QuestionKind;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly suggested: string | null;
  /** For a ZIP: the family of tables asked about (its signature) and its label (its first header names). */
  readonly family?: string;
  readonly familyLabel?: string;
}

interface ImportFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  createdBy: string;
  createdAt: Date;
  lastDropAt: Date;
  status: ImportStatus;
  /** Equals locationId until the import is done; then unset. */
  activeLocation?: Types.ObjectId;
  startedAt: Date | null;
  finishedAt: Date | null;
  question: ImportQuestion | null;
  appliedVersion: number;
  /** Bumped by every file that completes into the import, so the reader never finishes past a late drop. */
  drops: number;
  lease: { owner: string; until: Date } | null;
  claimedAt: Date | null;
  /** Over this import's finished files, for the reading speed (spec 11A, ETA). */
  bytesRead: number;
  msRead: number;
}

function importSchema(): Schema<ImportFields> {
  const schema = new Schema<ImportFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
    lastDropAt: { type: Date, required: true },
    status: { type: String, required: true, enum: ['open', 'queued', 'reading', 'waiting', 'done'] },
    activeLocation: { type: Schema.Types.ObjectId },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    question: { type: Schema.Types.Mixed, default: null },
    appliedVersion: { type: Number, required: true, default: 0 },
    drops: { type: Number, required: true, default: 0 },
    lease: { type: Schema.Types.Mixed, default: null },
    claimedAt: { type: Date, default: null },
    bytesRead: { type: Number, required: true, default: 0 },
    msRead: { type: Number, required: true, default: 0 },
  }, { strict: 'throw', versionKey: false, read: 'primary', minimize: false });
  schema.index({ activeLocation: 1 }, { unique: true, partialFilterExpression: { activeLocation: { $type: 'objectId' } } });
  schema.index({ orgId: 1, locationId: 1, createdAt: -1 });
  schema.index({ status: 1, startedAt: 1 });
  return schema;
}

/** Registers TwImport (tw_imports) on first call. */
export function importModel(connection: Connection): Model<ImportFields> {
  const existing = connection.models.TwImport as Model<ImportFields> | undefined;
  return existing ?? connection.model<ImportFields>('TwImport', importSchema(), IMPORTS_COLLECTION);
}

export interface ImportRecord {
  readonly id: string;
  readonly locationId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly status: ImportStatus;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly question: ImportQuestion | null;
  readonly appliedVersion: number;
  readonly drops: number;
  readonly lease: { readonly owner: string; readonly until: Date } | null;
  readonly claimedAt: Date | null;
  readonly bytesRead: number;
  readonly msRead: number;
}

function toImport(doc: ImportFields & { _id: Types.ObjectId }): ImportRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    status: doc.status,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    question: doc.question,
    appliedVersion: doc.appliedVersion,
    drops: doc.drops,
    lease: doc.lease,
    claimedAt: doc.claimedAt,
    bytesRead: doc.bytesRead,
    msRead: doc.msRead,
  };
}

/** What an import's read files wrote: the days whose last writer is one of its uploads. */
export interface ImportFound {
  readonly dayCount: number;
  readonly guestsDayCount: number;
  readonly netSalesDayCount: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  readonly missingDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface ImportStore {
  /** The location's import that is not done, if any. */
  active(scope: OrgScope, locationId: string): Promise<ImportRecord | null>;
  /** The active import, creating an open one when none exists (two first drops race on the unique index). */
  joinOrCreate(scope: OrgScope, locationId: string, input: { userId: string; now: Date }): Promise<ImportRecord>;
  get(scope: OrgScope, locationId: string, importId: string): Promise<ImportRecord | null>;
  /** The newest done import finished at or after `since`. */
  recentDone(scope: OrgScope, locationId: string, since: Date): Promise<ImportRecord | null>;
  /**
   * A file completed into the import: bumps `drops` and `lastDropAt` unless the import is done. Resolves the import as it
   * is now, or null when it was done.
   */
  noteDrop(scope: OrgScope, importId: string, now: Date): Promise<ImportRecord | null>;
  /** open to queued. Null when it was not open. */
  start(scope: OrgScope, importId: string, now: Date): Promise<ImportRecord | null>;
  /** The reader paused on a question (and let go of its lease). */
  ask(scope: OrgScope, importId: string, question: ImportQuestion): Promise<void>;
  /** The question went away (answered, or its file deleted): back to the queue. False when `questionId` is stale. */
  clearQuestion(scope: OrgScope, importId: string, questionId: string): Promise<boolean>;
  /** A file's days were written: the Reading screen refetches when this changes. */
  applied(scope: OrgScope, importId: string): Promise<void>;
  /** A file finished reading, for the reading speed. */
  addThroughput(scope: OrgScope, importId: string, bytes: number, ms: number): Promise<void>;
  /** The worker that holds the lease extends it. False when it lost the lease. */
  extendLease(scope: OrgScope, importId: string, owner: string, until: Date): Promise<boolean>;
  /** The reader holds the lease but cannot read now (a suspended organization): queued, held back until `until`. */
  deferLease(scope: OrgScope, importId: string, owner: string, until: Date): Promise<void>;
  /** Done, unless another file completed into it since the reader looked (`drops` moved). */
  finish(scope: OrgScope, importId: string, input: { owner: string; drops: number; now: Date }): Promise<boolean>;
  /** Deletes one import (the sweeper's never-read drop, once its files are gone). */
  remove(scope: OrgScope, importId: string): Promise<void>;
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  removeForOrg(scope: OrgScope): Promise<number>;
  /** Deletes an open import with no files left. */
  removeIfEmptyOpen(scope: OrgScope, importId: string, fileCount: number): Promise<void>;
  /** ImportView.found: the days this import's uploads wrote, from tw_sales_days. */
  found(scope: OrgScope, locationId: string, uploadIds: readonly string[]): Promise<ImportFound>;
}

export function createImportStore(connection: Connection): ImportStore {
  const Import = importModel(connection);
  const org = (scope: OrgScope): Types.ObjectId => new Types.ObjectId(scope.orgId);
  const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
  const after = { returnDocument: 'after' } as const;
  const store: ImportStore = {
    async active(scope, locationId) {
      const doc = await Import.findOne({ orgId: org(scope), activeLocation: oid(locationId) }).lean();
      return doc === null ? null : toImport(doc);
    },
    async joinOrCreate(scope, locationId, input) {
      const existing = await store.active(scope, locationId);
      if (existing !== null) return existing;
      try {
        const doc = await Import.create({
          orgId: org(scope), locationId: oid(locationId), activeLocation: oid(locationId), createdBy: input.userId,
          createdAt: input.now, lastDropAt: input.now, status: 'open', startedAt: null, finishedAt: null, question: null,
          appliedVersion: 0, drops: 0, lease: null, claimedAt: null, bytesRead: 0, msRead: 0,
        });
        return toImport(doc.toObject());
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const winner = await store.active(scope, locationId);
        if (winner === null) throw err;
        return winner;
      }
    },
    async get(scope, locationId, importId) {
      const doc = await Import.findOne({ _id: oid(importId), orgId: org(scope), locationId: oid(locationId) }).lean();
      return doc === null ? null : toImport(doc);
    },
    async recentDone(scope, locationId, since) {
      const doc = await Import.findOne({ orgId: org(scope), locationId: oid(locationId), status: 'done', finishedAt: trusted({ $gte: since }) })
        .sort({ finishedAt: -1 }).lean();
      return doc === null ? null : toImport(doc);
    },
    async noteDrop(scope, importId, now) {
      const doc = await Import.findOneAndUpdate(
        { _id: oid(importId), orgId: org(scope), status: trusted({ $ne: 'done' as const }) },
        { $inc: { drops: 1 }, $set: { lastDropAt: now } },
        after,
      ).lean();
      return doc === null ? null : toImport(doc);
    },
    async start(scope, importId, now) {
      const doc = await Import.findOneAndUpdate(
        { _id: oid(importId), orgId: org(scope), status: 'open' }, { $set: { status: 'queued', startedAt: now } }, after,
      ).lean();
      return doc === null ? null : toImport(doc);
    },
    async ask(scope, importId, question) {
      await Import.updateOne({ _id: oid(importId), orgId: org(scope) }, { $set: { status: 'waiting', question, lease: null } });
    },
    async clearQuestion(scope, importId, questionId) {
      const result = await Import.updateOne(
        { _id: oid(importId), orgId: org(scope), status: 'waiting', 'question.id': questionId },
        { $set: { status: 'queued', question: null, claimedAt: null } },
      );
      return result.matchedCount === 1;
    },
    async applied(scope, importId) {
      await Import.updateOne({ _id: oid(importId), orgId: org(scope) }, { $inc: { appliedVersion: 1 } });
    },
    async addThroughput(scope, importId, bytes, ms) {
      await Import.updateOne({ _id: oid(importId), orgId: org(scope) }, { $inc: { bytesRead: bytes, msRead: ms } });
    },
    async extendLease(scope, importId, owner, until) {
      const result = await Import.updateOne(
        { _id: oid(importId), orgId: org(scope), status: 'reading', 'lease.owner': owner },
        { $set: { 'lease.until': until } },
      );
      return result.matchedCount === 1;
    },
    async deferLease(scope, importId, owner, until) {
      await Import.updateOne(
        { _id: oid(importId), orgId: org(scope), status: 'reading', 'lease.owner': owner },
        { $set: { status: 'queued', lease: { owner, until }, claimedAt: null } },
      );
    },
    async finish(scope, importId, input) {
      const result = await Import.updateOne(
        { _id: oid(importId), orgId: org(scope), status: 'reading', 'lease.owner': input.owner, drops: input.drops },
        { $set: { status: 'done', finishedAt: input.now, lease: null }, $unset: { activeLocation: '' } },
      );
      return result.matchedCount === 1;
    },
    async remove(scope, importId) {
      await Import.deleteOne({ _id: oid(importId), orgId: org(scope) });
    },
    async removeForLocation(scope, locationId) {
      return (await Import.deleteMany({ orgId: org(scope), locationId: oid(locationId) })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await Import.deleteMany({ orgId: org(scope) })).deletedCount;
    },
    async removeIfEmptyOpen(scope, importId, fileCount) {
      if (fileCount > 0) return;
      await Import.deleteOne({ _id: oid(importId), orgId: org(scope), status: 'open' });
    },
    async found(scope, locationId, uploadIds) {
      if (uploadIds.length === 0) {
        return { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 };
      }
      const rows = await connection.collection(SALES_DAYS_COLLECTION).aggregate<{
        days: number; guestsDays: number; netSalesDays: number; first: string; last: string;
      }>([
        { $match: { orgId: org(scope), locationId: oid(locationId), uploadId: { $in: uploadIds.map(oid) }, ...HAS_VALUE } },
        {
          $group: {
            _id: null,
            days: { $sum: 1 },
            guestsDays: { $sum: { $cond: [{ $gt: ['$guests', null] }, 1, 0] } },
            netSalesDays: { $sum: { $cond: [{ $gt: ['$netSalesCents', null] }, 1, 0] } },
            first: { $min: '$date' },
            last: { $max: '$date' },
          },
        },
      ]).toArray();
      const row = rows[0];
      if (row === undefined) {
        return { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 };
      }
      const span = (Date.parse(row.last) - Date.parse(row.first)) / DAY_MS + 1;
      return {
        dayCount: row.days, guestsDayCount: row.guestsDays, netSalesDayCount: row.netSalesDays,
        firstDate: row.first, lastDate: row.last, missingDays: span - row.days,
      };
    },
  };
  return store;
}
