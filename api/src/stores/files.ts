// tw_files (spec 6.11): one row per stored file. `name` is the original file name, sanitized; it is shown to the
// organization only and is never logged, audited, sent to a model, or put in a blob name or a URL. Blob names come
// from the ids here (files/blobs.ts). Reports hold header names, row numbers, dates and counts, never a data cell
// other than the location value the person chose. Nothing here logs.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { Role } from '../access/resolve.ts';

export const FILES_COLLECTION = 'tw_files';

export const FILE_KINDS = ['text', 'xlsx', 'xls', 'pdf', 'docx', 'doc', 'zip', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_STATUSES = ['uploading', 'stored', 'queued', 'reading', 'waiting', 'read', 'kept', 'failed', 'deleting'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** `history` is read for days of sales; `reference` is kept as it is (any file, or pasted text). */
export const FILE_PURPOSES = ['history', 'reference'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/** One received chunk: its byte count and SHA-256 (hex). */
export interface ChunkRecord { readonly bytes: number; readonly sha256: string }

/** While `uploading` (spec 6.11). `head` is the first 8 KiB, base64, for telling the kind at complete. */
export interface UploadSession {
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly chunks: readonly (ChunkRecord | null)[];
  readonly head: string | null;
  readonly expiresAt: Date;
}

export type ProgressUnit = 'bytes' | 'pages' | 'days';

/** While `reading`. */
export interface FileProgress {
  readonly phase: 'unpacking' | 'reading' | 'writing';
  readonly done: number;
  readonly total: number | null;
  readonly unit: ProgressUnit;
  readonly phaseStartedAt: Date;
  readonly updatedAt: Date;
}

/** What a read file added (spec 6.11). */
export interface FileResult {
  readonly dayCount: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly guestsDayCount: number;
  readonly netSalesDayCount: number;
  readonly inserted: number;
  readonly replaced: number;
  readonly kept: number;
  readonly closedDates: readonly string[];
  readonly missingDays: number;
  readonly uploadId: string;
}

/** A ZIP's entry counts, once its entries are listed. */
export interface EntryCounts { readonly total: number; readonly used: number; readonly kept: number }

/**
 * The person's answers to this file's questions, per sheet index ("0" for a text file), or per family of a ZIP's tables
 * (`family:<signature>`).
 */
export interface SheetAnswers {
  readonly dateColumn?: number;
  readonly dateOrder?: 'month_first' | 'day_first';
  /** The location column's value that is this location. */
  readonly locationValue?: string;
  readonly rowMode?: 'day' | 'check' | 'item';
  /** A column index, or null for "none". */
  readonly guests?: number | null;
  readonly netSales?: number | null;
}
export type FileAnswers = Readonly<Record<string, SheetAnswers>>;

/** One AI column step answer, as the reader saves it (column indexes only); null when the model could not tell. */
export interface SavedColumnChoice {
  readonly guests: number | null;
  readonly netSales: number | null;
  readonly confidence: 'high' | 'low';
}
/** The AI column step's answers for a file, by a hash of the redacted profile each was asked about. */
export type FileColumnChoices = Readonly<Record<string, SavedColumnChoice | null>>;

interface FileFields {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  importId: Types.ObjectId | null;
  purpose: FilePurpose;
  uploadedBy: string;
  uploaderRole: Role;
  byStaff?: boolean;
  /** The open-as-admin grant it was stored under (D25), so the reader's sales.uploaded carries it too. */
  openAsAdminGrantId?: string;
  uploadedAt: Date;
  name: string;
  kind: FileKind;
  sizeBytes: number;
  fingerprint: string | null;
  upload: UploadSession | null;
  status: FileStatus;
  outcome: string | null;
  progress: FileProgress | null;
  readStartedAt: Date | null;
  readMs: number | null;
  answers: FileAnswers;
  uploadId: Types.ObjectId | null;
  result: FileResult | null;
  report: Record<string, unknown> | null;
  cleanBytes: number | null;
  rawDeletedAt: Date | null;
  attempts: number;
  /** Absent on rows written before ZIPs were read, as are the two counters. */
  entries?: EntryCounts | null;
  modelCalls?: number;
  costMicroUsd?: number;
  /** Absent on rows written before the reader saved the AI step's answers. */
  aiChoices?: FileColumnChoices;
  /** A staff purge found the file busy: its original goes as soon as the reader is done with it. */
  purgeRaw?: boolean;
  /** Set while the item is turned off (reference items), by the person who did it. Absent means on, never stored as null. */
  disabledAt?: Date;
  disabledBy?: string;
  /** Set when TownwiseAI kept the item for the person. */
  addedVia?: 'townwise_ai';
}

function fileSchema(): Schema<FileFields> {
  const schema = new Schema<FileFields>({
    orgId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, required: true },
    importId: { type: Schema.Types.ObjectId, default: null },
    purpose: { type: String, required: true, enum: FILE_PURPOSES },
    uploadedBy: { type: String, required: true },
    uploaderRole: { type: String, required: true, enum: ['org_admin', 'member'] },
    byStaff: { type: Boolean },
    openAsAdminGrantId: { type: String },
    uploadedAt: { type: Date, required: true },
    name: { type: String, required: true },
    kind: { type: String, required: true, enum: FILE_KINDS },
    sizeBytes: { type: Number, required: true },
    fingerprint: { type: String, default: null },
    upload: { type: Schema.Types.Mixed, default: null },
    status: { type: String, required: true, enum: FILE_STATUSES },
    outcome: { type: String, default: null },
    progress: { type: Schema.Types.Mixed, default: null },
    readStartedAt: { type: Date, default: null },
    readMs: { type: Number, default: null },
    answers: { type: Schema.Types.Mixed, default: () => ({}) },
    uploadId: { type: Schema.Types.ObjectId, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    report: { type: Schema.Types.Mixed, default: null },
    cleanBytes: { type: Number, default: null },
    rawDeletedAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    entries: { type: Schema.Types.Mixed, default: null },
    modelCalls: { type: Number, required: true, default: 0 },
    costMicroUsd: { type: Number, required: true, default: 0 },
    aiChoices: { type: Schema.Types.Mixed, default: () => ({}) },
    purgeRaw: { type: Boolean },
    disabledAt: { type: Date },
    disabledBy: { type: String },
    addedVia: { type: String, enum: ['townwise_ai'] },
  }, { strict: 'throw', versionKey: false, read: 'primary', minimize: false });
  schema.index({ orgId: 1, locationId: 1, uploadedAt: -1 });
  schema.index({ orgId: 1, importId: 1, uploadedAt: 1 });
  schema.index({ orgId: 1, locationId: 1, fingerprint: 1 });
  schema.index({ status: 1, 'upload.expiresAt': 1 });
  // The daily sweep across organizations (stores/cross-tenant.ts): originals past retention, and flagged purges.
  schema.index({ status: 1, uploadedAt: 1 });
  schema.index({ purgeRaw: 1 }, { sparse: true });
  // D28: the file each upload on Your data was read from.
  schema.index({ orgId: 1, uploadId: 1 }, { partialFilterExpression: { uploadId: { $type: 'objectId' } } });
  return schema;
}

/** Registers TwFile (tw_files) on first call. */
export function fileModel(connection: Connection): Model<FileFields> {
  const existing = connection.models.TwFile as Model<FileFields> | undefined;
  return existing ?? connection.model<FileFields>('TwFile', fileSchema(), FILES_COLLECTION);
}

export interface FileRecord {
  readonly id: string;
  readonly locationId: string;
  readonly importId: string | null;
  readonly purpose: FilePurpose;
  readonly uploadedBy: string;
  readonly uploaderRole: Role;
  /** Uploaded by Townwise staff in open as admin (D25); shown as "Townwise staff", never the staff email. */
  readonly byStaff: boolean;
  /** The open-as-admin grant it was stored under (D25); null otherwise, and on files from before the field. */
  readonly openAsAdminGrantId: string | null;
  readonly uploadedAt: Date;
  readonly name: string;
  readonly kind: FileKind;
  readonly sizeBytes: number;
  readonly fingerprint: string | null;
  readonly upload: UploadSession | null;
  readonly status: FileStatus;
  readonly outcome: string | null;
  readonly progress: FileProgress | null;
  readonly readStartedAt: Date | null;
  readonly readMs: number | null;
  readonly answers: FileAnswers;
  readonly uploadId: string | null;
  readonly result: FileResult | null;
  readonly report: Record<string, unknown> | null;
  readonly cleanBytes: number | null;
  readonly rawDeletedAt: Date | null;
  readonly attempts: number;
  readonly entries: EntryCounts | null;
  /** The AI column step's calls for this file, and their cost in micro-dollars. */
  readonly modelCalls: number;
  readonly costMicroUsd: number;
  /** Its answers, so a re-read (after a later question, or a retry) asks the model nothing it already answered. */
  readonly aiChoices: FileColumnChoices;
  readonly purgeRaw: boolean;
  /** When the item was turned off, or null. */
  readonly disabledAt: Date | null;
  readonly addedVia: 'townwise_ai' | null;
}

function toFile(doc: FileFields & { _id: Types.ObjectId }): FileRecord {
  return {
    id: doc._id.toHexString(),
    locationId: doc.locationId.toHexString(),
    importId: doc.importId === null ? null : doc.importId.toHexString(),
    purpose: doc.purpose,
    uploadedBy: doc.uploadedBy,
    uploaderRole: doc.uploaderRole,
    byStaff: doc.byStaff === true,
    openAsAdminGrantId: doc.openAsAdminGrantId ?? null,
    uploadedAt: doc.uploadedAt,
    name: doc.name,
    kind: doc.kind,
    sizeBytes: doc.sizeBytes,
    fingerprint: doc.fingerprint,
    upload: doc.upload,
    status: doc.status,
    outcome: doc.outcome,
    progress: doc.progress,
    readStartedAt: doc.readStartedAt,
    readMs: doc.readMs,
    answers: doc.answers,
    uploadId: doc.uploadId === null ? null : doc.uploadId.toHexString(),
    result: doc.result,
    report: doc.report,
    cleanBytes: doc.cleanBytes,
    rawDeletedAt: doc.rawDeletedAt,
    attempts: doc.attempts,
    entries: doc.entries ?? null,
    modelCalls: doc.modelCalls ?? 0,
    costMicroUsd: doc.costMicroUsd ?? 0,
    aiChoices: doc.aiChoices ?? {},
    purgeRaw: doc.purgeRaw === true,
    disabledAt: doc.disabledAt ?? null,
    addedVia: doc.addedVia ?? null,
  };
}

export interface NewFile {
  /** Null for a reference item: it belongs to no import. */
  readonly importId: string | null;
  readonly purpose: FilePurpose;
  readonly addedVia?: 'townwise_ai';
  readonly uploadedBy: string;
  readonly uploaderRole: Role;
  readonly byStaff?: boolean;
  readonly openAsAdminGrantId?: string;
  readonly uploadedAt: Date;
  readonly name: string;
  readonly kind: FileKind;
  readonly sizeBytes: number;
  readonly chunkSize: number;
  readonly expiresAt: Date;
}

/** What the reader takes in a started import (nextToRead). */
const READABLE: FileStatus[] = ['queued', 'reading', 'stored'];

/** Tenant store: every function takes the OrgScope first and filters on its orgId. */
export interface FileStore {
  create(scope: OrgScope, locationId: string, input: NewFile): Promise<FileRecord>;
  get(scope: OrgScope, locationId: string, fileId: string): Promise<FileRecord | null>;
  /** Newest first. Other people's unfinished uploads are left out. */
  list(scope: OrgScope, locationId: string, input: { viewerId: string; before: string | null; limit: number }): Promise<FileRecord[]>;
  /**
   * D28, Your data: the files that wrote no days (`uploadId` null) at the location (or across the organization, for
   * null), newest first by (uploadedAt, id), each strictly before `before` in that order. Files being deleted and other
   * people's unfinished uploads are left out.
   */
  page(scope: OrgScope, input: {
    locationId: string | null; viewerId: string; before: { at: Date; id: string } | null; limit: number;
  }): Promise<FileRecord[]>;
  /** D28: the files that wrote days for any of `uploadIds`, newest first. Files being deleted are left out. */
  byUploadIds(scope: OrgScope, uploadIds: readonly string[]): Promise<FileRecord[]>;
  /**
   * D28: turns the location's file off (sets `disabledAt` and `disabledBy`) or on (unsets both), in one update. Resolves
   * the record after it, or null when there is no such file at the location.
   */
  setEnabled(scope: OrgScope, locationId: string, fileId: string, input: { enabled: boolean; by: string; at: Date }): Promise<FileRecord | null>;
  /** Upload order. */
  inImport(scope: OrgScope, importId: string): Promise<FileRecord[]>;
  /** Live files only: an upload session past its expiry is abandoned and counts toward no cap. */
  counts(scope: OrgScope, locationId: string, importId: string | null, now: Date): Promise<{ inImport: number; uploading: number; inLocation: number }>;
  /** Bytes of originals not yet deleted, across the organization, leaving out expired upload sessions. */
  storedBytes(scope: OrgScope, now: Date): Promise<number>;
  /** Records a received chunk while the file is uploading; null when it no longer is. */
  recordChunk(scope: OrgScope, fileId: string, index: number, chunk: ChunkRecord, head: string | null): Promise<FileRecord | null>;
  /** Compare-and-set from uploading: the session ends, the kind and fingerprint are set. Null when another call won. */
  finishUpload(
    scope: OrgScope, fileId: string, input: { fingerprint: string; kind: FileKind; status: 'stored' | 'queued' | 'kept'; outcome?: string },
  ): Promise<FileRecord | null>;
  /**
   * A text reference item with its bytes already stored: kept, outcome `reference`, with no upload session. `'exists'`
   * when a row with this id is already there (a retried save).
   */
  insertStored(scope: OrgScope, locationId: string, input: {
    id: string; uploadedBy: string; uploaderRole: Role; uploadedAt: Date; name: string; sizeBytes: number; fingerprint: string;
    addedVia: 'townwise_ai' | null;
    /** D25: kept by staff open as admin under this grant; the row is then `byStaff` too. */
    openAsAdminGrantId?: string;
  }): Promise<FileRecord | 'exists'>;
  /**
   * Another live file of the location with this purpose and fingerprint: a copy kept for reference never blocks the same
   * bytes uploaded as sales history, nor the other way round.
   */
  duplicateOf(scope: OrgScope, locationId: string, purpose: FilePurpose, fingerprint: string, exceptId: string): Promise<string | null>;
  /** Every stored file of the import becomes queued. Resolves the number changed. */
  queueStored(scope: OrgScope, importId: string): Promise<number>;
  /** Compare-and-set one file from `from` to `to`. */
  move(scope: OrgScope, fileId: string, from: readonly FileStatus[], to: FileStatus): Promise<FileRecord | null>;
  /** Moves a file into another import, as stored (a drop that landed after its import finished). */
  reassign(scope: OrgScope, fileId: string, importId: string): Promise<void>;
  remove(scope: OrgScope, fileId: string): Promise<boolean>;
  /**
   * The original is gone: the name becomes the kind's label (it can itself name a person), and so do a workbook's
   * sheet names in the report when `sheets` is given.
   */
  rawDeleted(scope: OrgScope, fileId: string, at: Date, label: string, sheets?: readonly Record<string, unknown>[]): Promise<void>;
  /** Any file row at the location, or in the organization (a location with files has data). */
  hasAny(scope: OrgScope, locationId: string | null): Promise<boolean>;
  /** Files still uploading, at one location or across the organization (to discard their staged chunks). */
  uploading(scope: OrgScope, locationId: string | null): Promise<FileRecord[]>;
  /**
   * Files whose original is still stored, at one location or across the organization; only those with `purpose` when
   * it is given (the owner's "delete every original" keeps reference items, D28; the staff purge takes every purpose).
   */
  originals(scope: OrgScope, locationId: string | null, purpose?: FilePurpose): Promise<FileRecord[]>;
  /** A staff purge found the file uploading or being read: its original goes once that ends. */
  flagPurge(scope: OrgScope, fileId: string): Promise<void>;
  /**
   * A file not read yet (stored, queued or waiting) whose original is about to be deleted: kept, with `outcome`, so no
   * reader claims it. The record as it was, or null when it had moved on (claimed by a reader, or deleted).
   */
  keepUnread(scope: OrgScope, fileId: string, outcome: string): Promise<FileRecord | null>;
  removeForLocation(scope: OrgScope, locationId: string): Promise<number>;
  removeForOrg(scope: OrgScope): Promise<number>;

  /**
   * The reader's next file in a started import: queued, reading (a previous attempt that stopped), or stored. A stored
   * file in a started import is one whose move to queued has not landed yet (start and queueStored, or a late drop, are
   * separate writes), so the reader takes it rather than finish the import past it.
   */
  nextToRead(scope: OrgScope, importId: string): Promise<FileRecord | null>;
  /** Marks the file reading and counts the attempt. Null when it was deleted or moved meanwhile. */
  startReading(scope: OrgScope, fileId: string, now: Date): Promise<FileRecord | null>;
  setProgress(scope: OrgScope, fileId: string, progress: FileProgress): Promise<void>;
  setUploadId(scope: OrgScope, fileId: string, uploadId: string): Promise<void>;
  /** One AI column step call for the file, what it cost and, when the model answered, its answer under `saved.key`. */
  addModelCall(scope: OrgScope, fileId: string, costMicroUsd: number, saved?: { key: string; choice: SavedColumnChoice | null }): Promise<void>;
  /** The reader's last word on a file: read, kept, failed or waiting (a question). */
  settle(scope: OrgScope, fileId: string, input: {
    status: 'read' | 'kept' | 'failed' | 'waiting' | 'queued';
    outcome: string | null;
    result?: FileResult | null;
    report?: Record<string, unknown> | null;
    cleanBytes?: number | null;
    readMs?: number | null;
    entries?: EntryCounts | null;
  }): Promise<boolean>;
  /** "Not sure": the waiting file is kept, unread, with this outcome. False when it was no longer waiting. */
  keepWaiting(scope: OrgScope, fileId: string, outcome: string): Promise<boolean>;
  /**
   * An answer: merged into the answers under `key` (a sheet index, or a ZIP family's key), and the file goes back to the
   * queue. False when it was no longer waiting.
   */
  answer(scope: OrgScope, fileId: string, key: string, answers: SheetAnswers): Promise<boolean>;
}

export function createFileStore(connection: Connection): FileStore {
  const File = fileModel(connection);
  const org = (scope: OrgScope): Types.ObjectId => new Types.ObjectId(scope.orgId);
  const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
  const after = { returnDocument: 'after' } as const;
  return {
    async create(scope, locationId, input) {
      const doc = await File.create({
        orgId: org(scope), locationId: oid(locationId), importId: input.importId === null ? null : oid(input.importId), purpose: input.purpose,
        uploadedBy: input.uploadedBy, uploaderRole: input.uploaderRole, ...(input.byStaff === true ? { byStaff: true } : {}),
        ...(input.openAsAdminGrantId === undefined ? {} : { openAsAdminGrantId: input.openAsAdminGrantId }),
        uploadedAt: input.uploadedAt, name: input.name,
        kind: input.kind, sizeBytes: input.sizeBytes, fingerprint: null, status: 'uploading',
        upload: {
          chunkSize: input.chunkSize,
          chunkCount: Math.ceil(input.sizeBytes / input.chunkSize),
          chunks: Array.from({ length: Math.ceil(input.sizeBytes / input.chunkSize) }, () => null),
          head: null,
          expiresAt: input.expiresAt,
        },
        answers: {}, attempts: 0,
        ...(input.addedVia === undefined ? {} : { addedVia: input.addedVia }),
      });
      return toFile(doc.toObject());
    },
    async get(scope, locationId, fileId) {
      const doc = await File.findOne({ _id: oid(fileId), orgId: org(scope), locationId: oid(locationId) }).lean();
      return doc === null ? null : toFile(doc);
    },
    async list(scope, locationId, input) {
      const filter: Record<string, unknown> = {
        orgId: org(scope), locationId: oid(locationId), status: trusted({ $ne: 'deleting' }),
        $or: [{ status: trusted({ $ne: 'uploading' }) }, { uploadedBy: input.viewerId }],
      };
      if (input.before !== null) filter._id = trusted({ $lt: oid(input.before) });
      const docs = await File.find(filter).sort({ _id: -1 }).limit(input.limit).lean();
      return docs.map(toFile);
    },
    async page(scope, input) {
      const and: Record<string, unknown>[] = [{ $or: [{ status: trusted({ $ne: 'uploading' }) }, { uploadedBy: input.viewerId }] }];
      if (input.before !== null) {
        and.push({
          $or: [
            { uploadedAt: trusted({ $lt: input.before.at }) },
            { uploadedAt: input.before.at, _id: trusted({ $lt: oid(input.before.id) }) },
          ],
        });
      }
      const filter: Record<string, unknown> = { orgId: org(scope), uploadId: null, status: trusted({ $ne: 'deleting' }), $and: and };
      if (input.locationId !== null) filter.locationId = oid(input.locationId);
      const docs = await File.find(filter).sort({ uploadedAt: -1, _id: -1 }).limit(input.limit).lean();
      return docs.map(toFile);
    },
    async byUploadIds(scope, uploadIds) {
      if (uploadIds.length === 0) return [];
      const docs = await File.find({
        orgId: org(scope), uploadId: trusted({ $in: uploadIds.map(oid), $type: 'objectId' }), status: trusted({ $ne: 'deleting' }),
      }).sort({ uploadedAt: -1, _id: -1 }).lean();
      return docs.map(toFile);
    },
    async setEnabled(scope, locationId, fileId, input) {
      const doc = await File.findOneAndUpdate(
        { _id: oid(fileId), orgId: org(scope), locationId: oid(locationId), status: trusted({ $ne: 'deleting' }) },
        input.enabled ? { $unset: { disabledAt: 1, disabledBy: 1 } } : { $set: { disabledAt: input.at, disabledBy: input.by } },
        after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async inImport(scope, importId) {
      const docs = await File.find({ orgId: org(scope), importId: oid(importId), status: trusted({ $ne: 'deleting' }) })
        .sort({ uploadedAt: 1, _id: 1 }).lean();
      return docs.map(toFile);
    },
    async counts(scope, locationId, importId, now) {
      const live = (): Record<string, unknown> => ({
        orgId: org(scope), status: trusted({ $ne: 'deleting' as const }),
        $nor: [{ status: 'uploading', 'upload.expiresAt': trusted({ $lte: now }) }],
      });
      const [inImport, uploading, inLocation] = await Promise.all([
        importId === null ? 0 : File.countDocuments({ ...live(), importId: oid(importId) }),
        File.countDocuments({ orgId: org(scope), locationId: oid(locationId), status: 'uploading', 'upload.expiresAt': trusted({ $gt: now }) }),
        File.countDocuments({ ...live(), locationId: oid(locationId) }),
      ]);
      return { inImport, uploading, inLocation };
    },
    async storedBytes(scope, now) {
      const rows = await connection.collection(FILES_COLLECTION).aggregate<{ bytes: number }>([
        { $match: { orgId: org(scope), rawDeletedAt: null, $nor: [{ status: 'uploading', 'upload.expiresAt': { $lte: now } }] } },
        { $group: { _id: null, bytes: { $sum: '$sizeBytes' } } },
      ]).toArray();
      return rows[0]?.bytes ?? 0;
    },
    async recordChunk(scope, fileId, index, chunk, head) {
      const set: Record<string, unknown> = { [`upload.chunks.${String(index)}`]: { bytes: chunk.bytes, sha256: chunk.sha256 } };
      if (head !== null) set['upload.head'] = head;
      const doc = await File.findOneAndUpdate({ _id: oid(fileId), orgId: org(scope), status: 'uploading' }, { $set: set }, after).lean();
      return doc === null ? null : toFile(doc);
    },
    async finishUpload(scope, fileId, input) {
      const doc = await File.findOneAndUpdate(
        { _id: oid(fileId), orgId: org(scope), status: 'uploading' },
        { $set: { status: input.status, fingerprint: input.fingerprint, kind: input.kind, upload: null, ...(input.outcome === undefined ? {} : { outcome: input.outcome }) } },
        after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async insertStored(scope, locationId, input) {
      try {
        const doc = await File.create({
          _id: oid(input.id), orgId: org(scope), locationId: oid(locationId), importId: null, purpose: 'reference',
          uploadedBy: input.uploadedBy, uploaderRole: input.uploaderRole, uploadedAt: input.uploadedAt, name: input.name,
          ...(input.openAsAdminGrantId === undefined ? {} : { byStaff: true, openAsAdminGrantId: input.openAsAdminGrantId }),
          kind: 'text', sizeBytes: input.sizeBytes, fingerprint: input.fingerprint, upload: null, status: 'kept', outcome: 'reference',
          answers: {}, attempts: 0,
          ...(input.addedVia === null ? {} : { addedVia: input.addedVia }),
        });
        return toFile(doc.toObject());
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 11000) return 'exists';
        throw err;
      }
    },
    async duplicateOf(scope, locationId, purpose, fingerprint, exceptId) {
      const doc = await File.findOne({
        orgId: org(scope), locationId: oid(locationId), purpose, fingerprint, _id: trusted({ $ne: oid(exceptId) }),
        status: trusted({ $nin: ['uploading', 'deleting'] }),
      }).lean();
      return doc === null ? null : doc._id.toHexString();
    },
    async queueStored(scope, importId) {
      return (await File.updateMany({ orgId: org(scope), importId: oid(importId), status: 'stored' }, { $set: { status: 'queued' } })).modifiedCount;
    },
    async move(scope, fileId, from, to) {
      const doc = await File.findOneAndUpdate(
        { _id: oid(fileId), orgId: org(scope), status: trusted({ $in: [...from] }) }, { $set: { status: to } }, after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async reassign(scope, fileId, importId) {
      await File.updateOne({ _id: oid(fileId), orgId: org(scope) }, { $set: { importId: oid(importId), status: 'stored' } });
    },
    async remove(scope, fileId) {
      return (await File.deleteOne({ _id: oid(fileId), orgId: org(scope) })).deletedCount === 1;
    },
    async rawDeleted(scope, fileId, at, label, sheets) {
      const set: Record<string, unknown> = { rawDeletedAt: at, name: label };
      if (sheets !== undefined) set['report.sheets'] = sheets;
      await File.updateOne({ _id: oid(fileId), orgId: org(scope) }, { $set: set, $unset: { purgeRaw: '' } });
    },
    async hasAny(scope, locationId) {
      const filter: Record<string, unknown> = { orgId: org(scope) };
      if (locationId !== null) filter.locationId = oid(locationId);
      return (await File.exists(filter)) !== null;
    },
    async uploading(scope, locationId) {
      const filter: Record<string, unknown> = { orgId: org(scope), status: 'uploading' };
      if (locationId !== null) filter.locationId = oid(locationId);
      return (await File.find(filter).lean()).map(toFile);
    },
    async originals(scope, locationId, purpose) {
      const filter: Record<string, unknown> = { orgId: org(scope), rawDeletedAt: null, status: trusted({ $nin: ['uploading', 'deleting'] }) };
      if (locationId !== null) filter.locationId = oid(locationId);
      if (purpose !== undefined) filter.purpose = purpose;
      return (await File.find(filter).sort({ uploadedAt: 1 }).lean()).map(toFile);
    },
    async flagPurge(scope, fileId) {
      await File.updateOne({ _id: oid(fileId), orgId: org(scope), rawDeletedAt: null }, { $set: { purgeRaw: true } });
    },
    async keepUnread(scope, fileId, outcome) {
      const doc = await File.findOneAndUpdate(
        { _id: oid(fileId), orgId: org(scope), status: trusted({ $in: ['stored', 'queued', 'waiting'] }) },
        { $set: { status: 'kept', outcome, progress: null } },
        { returnDocument: 'before' },
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async removeForLocation(scope, locationId) {
      return (await File.deleteMany({ orgId: org(scope), locationId: oid(locationId) })).deletedCount;
    },
    async removeForOrg(scope) {
      return (await File.deleteMany({ orgId: org(scope) })).deletedCount;
    },
    async nextToRead(scope, importId) {
      const doc = await File.findOne({ orgId: org(scope), importId: oid(importId), status: trusted({ $in: READABLE }) })
        .sort({ uploadedAt: 1, _id: 1 }).lean();
      return doc === null ? null : toFile(doc);
    },
    async startReading(scope, fileId, now) {
      const doc = await File.findOneAndUpdate(
        { _id: oid(fileId), orgId: org(scope), status: trusted({ $in: READABLE }) },
        { $set: { status: 'reading', readStartedAt: now, progress: null }, $inc: { attempts: 1 } },
        after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async setProgress(scope, fileId, progress) {
      await File.updateOne({ _id: oid(fileId), orgId: org(scope), status: 'reading' }, { $set: { progress } });
    },
    async setUploadId(scope, fileId, uploadId) {
      await File.updateOne({ _id: oid(fileId), orgId: org(scope) }, { $set: { uploadId: oid(uploadId) } });
    },
    async addModelCall(scope, fileId, costMicroUsd, saved) {
      const update: Record<string, unknown> = { $inc: { modelCalls: 1, costMicroUsd } };
      if (saved !== undefined) update.$set = { [`aiChoices.${saved.key}`]: saved.choice };
      await File.updateOne({ _id: oid(fileId), orgId: org(scope) }, update);
    },
    async settle(scope, fileId, input) {
      const set: Record<string, unknown> = { status: input.status, outcome: input.outcome, progress: null };
      if (input.result !== undefined) set.result = input.result;
      if (input.report !== undefined) set.report = input.report;
      if (input.cleanBytes !== undefined) set.cleanBytes = input.cleanBytes;
      if (input.readMs !== undefined) set.readMs = input.readMs;
      if (input.entries !== undefined) set.entries = input.entries;
      const result = await File.updateOne({ _id: oid(fileId), orgId: org(scope), status: 'reading' }, { $set: set });
      return result.matchedCount === 1;
    },
    async keepWaiting(scope, fileId, outcome) {
      const result = await File.updateOne({ _id: oid(fileId), orgId: org(scope), status: 'waiting' }, { $set: { status: 'kept', outcome } });
      return result.matchedCount === 1;
    },
    async answer(scope, fileId, key, answers) {
      const set: Record<string, unknown> = { status: 'queued', attempts: 0 };
      for (const [field, value] of Object.entries(answers)) set[`answers.${key}.${field}`] = value;
      const result = await File.updateOne({ _id: oid(fileId), orgId: org(scope), status: 'waiting' }, { $set: set });
      return result.matchedCount === 1;
    },
  };
}
