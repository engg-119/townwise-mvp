// tw_files (spec 6.11): one row per stored file. `name` is the original file name, sanitized; it is shown to the
// organization only and is never logged, audited, sent to a model, or put in a blob name or a URL. Blob names come
// from the ids here (files/blobs.ts). Reports hold header names, row numbers, dates and counts, never a data cell
// other than the location value the person chose. Nothing here logs.
import { Schema, trusted, Types, type Connection, type Model } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { Role } from '../access/resolve.ts';
import type { RuleSchedule } from './business-rules.ts';

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

/**
 * Reading with TownwiseAI (spec 11A.9, D34), opted into per file: `queued` until a reader claims it, `reading` under the
 * claim's lease, then `done`, `failed` (`refused`, `answer_too_long` or `internal`) or `skipped` (a reason code).
 * `undone` is set when the person undoes what the read did. Failed, skipped and undone reads may be asked for again.
 */
export type AiReadStatus = 'queued' | 'reading' | 'done' | 'failed' | 'skipped' | 'undone';

/** What TownwiseAI found a file to be. Types only: the answer's schema is files/extract/reader-prompt.ts. */
export type AiFileKind = 'sales' | 'calendar' | 'inventory' | 'menu' | 'staffing' | 'other';
export type AiEventKind = 'closure' | 'private_event' | 'opening' | 'other';
export type AiEventEffect = 'closed' | 'more' | 'fewer' | 'unknown';

/** A dated event the file states, as TownwiseAI read it (validated and capped, files/extract/reader-prompt.ts). */
export interface AiReadEvent {
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly kind: AiEventKind;
  readonly effect: AiEventEffect;
  readonly expectedGuests: number | null;
  readonly detail: string;
}

/** A daily total the file states per day; `netSales` in dollars, as the file has it. */
export interface AiReadDay { readonly date: string; readonly guests: number | null; readonly netSales: number | null }

/**
 * The model's answer after validation (files/extract/reader-prompt.ts): every list capped, malformed entries dropped,
 * email addresses and phone numbers replaced. The free text (`summary`, `facts`, `events`, `days`) is cleared when the
 * original is deleted, and `days` (with `daysBorneOut`) once the actions have used them; `kind`, `confidence`,
 * `daysCut` and the counts stay.
 */
export interface AiReadResult {
  readonly kind: AiFileKind;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly summary: string;
  readonly facts: readonly string[];
  readonly events: readonly AiReadEvent[];
  /** At most 1,500, newest first. */
  readonly days: readonly AiReadDay[];
  /** The file states daily totals for more dates than `days` holds (the newest 1,500 were kept). */
  readonly daysCut: boolean;
  /** How many events and days the answer gave, after validation. */
  readonly eventCount: number;
  readonly dayCount: number;
  /**
   * The places in `days` of the days the file's own text bears out (files/ai-verify.ts), checked when the answer was
   * saved, so a retry needs no second read of the original; null when the file has no text (a picture).
   */
  readonly daysBorneOut: readonly number[] | null;
  /**
   * D46: the closed patterns the file states, as closure schedules (files/extract/reader-prompt.ts), at most 5; no words
   * of the file. Absent on an answer saved before them, which reads as none.
   */
  readonly closedPatterns?: readonly RuleSchedule[];
}

/**
 * What a TownwiseAI read made (spec 11A.9: a note, a sales upload, or a summary item), on that record: the file it was
 * read from. The same shape on tw_notes, tw_uploads and tw_files.
 */
export interface AiSource { readonly via: 'ai_file'; readonly fileId: string }

/** The ids a read's actions write under, saved before any of them, so a retry writes under the same ones. */
export interface AiActionPlan {
  /** One per event of the answer, in its order. */
  readonly noteIds: readonly string[];
  readonly uploadId: string;
  readonly itemId: string;
  readonly calibrationId: string;
}

/** Why the read wrote no days. `already_had_days`: every verified day was already stored (AI days never replace one). */
export type AiDaysReason =
  | 'not_sales' | 'no_days' | 'file_wrote_days' | 'picture' | 'not_high_confidence' | 'days_not_verified' | 'already_had_days';
/** Why the read kept no summary item. */
export type AiItemReason = 'no_summary' | 'storage_full' | 'daily_upload_limit';
/**
 * The model update after a read: `started` (with the calibration's id), `not_needed` (no note or day was written),
 * `not_admin` (the person who asked is not an org admin), or the lab's refusal (lab/service.ts StartRefusal, renamed),
 * or `org_not_active`.
 */
export type AiCalibrationStatus =
  | 'started' | 'not_needed' | 'not_admin' | 'lab_unavailable' | 'not_enough_history' | 'regime' | 'budget_spent'
  | 'in_progress' | 'daily_limit' | 'org_not_active' | 'start_failed';
export interface AiCalibration { readonly status: AiCalibrationStatus; readonly id: string | null }

/** What a read's actions did, recorded once every write is done. */
export interface AiActionsOutcome {
  /**
   * The notes it created (ids), and the events it did not make a note of, by why: an existing note says the same, the
   * location's 1,000 notes, the notes route would refuse it, or the closed-note guard (a closed span over 14 days, or
   * past 31 closed days a read).
   */
  readonly notes: readonly string[];
  readonly notesSkipped: { readonly duplicate: number; readonly cap: number; readonly invalid: number; readonly guard: number };
  /** The upload it wrote days through, and the days that upload held once written; null and 0 with a reason otherwise. */
  readonly uploadId: string | null;
  readonly daysWritten: number;
  /** Verified days left out because the location already had a day on that date (AI days only add). */
  readonly daysAlreadyHad: number;
  readonly daysReason: AiDaysReason | null;
  /** The summary item it kept, or null with a reason. */
  readonly itemId: string | null;
  readonly itemReason: AiItemReason | null;
  readonly calibration: AiCalibration;
}

/** S2: the plan (saved first), and the outcome (null until every write is done). */
export interface AiReadActions { readonly plan: AiActionPlan; readonly outcome: AiActionsOutcome | null }

/** The `ai` subdocument, absent until someone asks TownwiseAI to read the file. */
export interface FileAiRead {
  readonly status: AiReadStatus;
  /** Who asked, their role then, and whether they were Townwise staff open as admin (D25), with that grant's id. */
  readonly requestedBy: string;
  readonly requestedByRole: Role;
  readonly requestedByStaff: boolean;
  readonly requestedGrantId: string | null;
  readonly requestedAt: Date;
  /** Claims so far; also the claim's token: every write under a claim matches the count it set. */
  readonly attempts: number;
  readonly leaseUntil: Date | null;
  /** A queued read put back after an attempt stopped is not claimed before this (backoff); null otherwise. */
  readonly notBefore: Date | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** Why a read failed or was skipped, as a code; null otherwise. */
  readonly reason: string | null;
  /** The text sent was cut at the cap (the prompt said so). */
  readonly partial: boolean;
  /** What the model calls of this read cost, in micro-dollars. */
  readonly costMicroUsd: number;
  /** Saved before anything acts on it, so a retry acts on the same answer; null until the model answered. */
  readonly result: AiReadResult | null;
  /**
   * What acting on the answer planned and did; null before, and once undone. A plan whose outcome is null means the
   * actions began and did not finish (the read then failed or was skipped): what they wrote can still be undone.
   */
  readonly actions: AiReadActions | null;
  /** While an undo runs: it removes what the read made, then marks the read `undone`. */
  readonly undoing: boolean;
}

/** As stored: `actions` and `notBefore` may be absent, and `undoing` is absent unless set. */
type StoredAiRead = Omit<FileAiRead, 'actions' | 'undoing' | 'notBefore'> & {
  actions?: AiReadActions | null; undoing?: boolean; notBefore?: Date | null;
};

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
  /** D28, editing an item: while a replace puts another file in this item's place, that file's id. Absent otherwise. */
  replacedBy?: Types.ObjectId;
  /** When `replacedBy` was set; absent with it (and on claims from before the field, which count as stale). */
  replacedAt?: Date;
  /** On a file that took an item's place: that item's id, when and by whom (`editedByStaff` while open as admin). */
  replaces?: Types.ObjectId;
  editedAt?: Date;
  editedBy?: string;
  editedByStaff?: boolean;
  /** Reading with TownwiseAI (spec 11A.9); absent until asked for, never stored as null. */
  ai?: StoredAiRead;
  /** On the summary item a TownwiseAI read kept: the file it was read from. Absent otherwise. */
  source?: { via: 'ai_file'; fileId: Types.ObjectId };
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
    replacedBy: { type: Schema.Types.ObjectId },
    replacedAt: { type: Date },
    replaces: { type: Schema.Types.ObjectId },
    editedAt: { type: Date },
    editedBy: { type: String },
    editedByStaff: { type: Boolean },
    ai: { type: Schema.Types.Mixed },
    source: {
      type: new Schema({
        via: { type: String, required: true, enum: ['ai_file'] }, fileId: { type: Schema.Types.ObjectId, required: true },
      }, { _id: false, strict: 'throw' }),
    },
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
  // The TownwiseAI reader's claim across organizations (stores/cross-tenant.ts): oldest request first. Sparse, so the
  // files nobody opted in are not in it.
  schema.index({ 'ai.status': 1, 'ai.requestedAt': 1 }, { sparse: true });
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
  readonly disabledBy: string | null;
  readonly addedVia: 'townwise_ai' | null;
  /** D28: the file taking this item's place while a replace runs, or null. */
  readonly replacedBy: string | null;
  /** When that claim was made, or null (none, or one from before the field). */
  readonly replacedAt: Date | null;
  /** D28: the item this file took the place of, and when and by whom it was edited; null (false) if never edited. */
  readonly replaces: string | null;
  readonly editedAt: Date | null;
  readonly editedBy: string | null;
  /** Edited by Townwise staff open as admin (D25): reads "Townwise staff". */
  readonly editedByStaff: boolean;
  /** Reading with TownwiseAI (spec 11A.9), or null when nobody asked. */
  readonly ai: FileAiRead | null;
  /** A summary item TownwiseAI kept from a read: the file it was read from; null for anything else. */
  readonly source: AiSource | null;
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
    disabledBy: doc.disabledBy ?? null,
    addedVia: doc.addedVia ?? null,
    replacedBy: doc.replacedBy === undefined ? null : doc.replacedBy.toHexString(),
    replacedAt: doc.replacedAt ?? null,
    replaces: doc.replaces === undefined ? null : doc.replaces.toHexString(),
    editedAt: doc.editedAt ?? null,
    editedBy: doc.editedBy ?? null,
    editedByStaff: doc.editedByStaff === true,
    ai: doc.ai === undefined ? null : { ...doc.ai, actions: doc.ai.actions ?? null, undoing: doc.ai.undoing === true, notBefore: doc.ai.notBefore ?? null },
    source: doc.source === undefined ? null : { via: 'ai_file', fileId: doc.source.fileId.toHexString() },
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

/** Files TownwiseAI may be asked to read: finished, so nothing else is still reading or writing them. */
const AI_READABLE: FileStatus[] = ['read', 'kept', 'failed'];
/** Reads that may be asked for again. */
const AI_ASK_AGAIN: AiReadStatus[] = ['failed', 'skipped', 'undone'];
/** Reads that ended, whose actions (when they began) can be undone. */
const AI_ENDED: AiReadStatus[] = ['done', 'failed', 'skipped'];

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
  /**
   * D28: renames the location's reference item while it is kept with its original stored and no edit is being saved
   * over it: no claim, or a stale one (no `replacedAt`, or one before `staleBefore`; files/items.ts, replaceClaimLive).
   * Null when it no longer is one (deleted, or its original deleted meanwhile, which gives it its kind's label as its
   * name) or an edit is being saved.
   */
  rename(scope: OrgScope, locationId: string, fileId: string, name: string, staleBefore: Date): Promise<FileRecord | null>;
  /**
   * D28, step 1 of replacing an item: compare-and-set `replacedBy` from absent (or already `byId`, a retry) to `byId`,
   * with `replacedAt` set to `at`, while the file is a reference item kept with its original stored. Resolves the
   * record after it, or null.
   */
  claimReplace(scope: OrgScope, locationId: string, fileId: string, byId: string, at: Date): Promise<FileRecord | null>;
  /**
   * Undoes claimReplace when `byId` could not take the item's place, or frees a stale claim: unsets `replacedBy` and
   * `replacedAt` only while `replacedBy` is `byId`.
   */
  releaseReplace(scope: OrgScope, fileId: string, byId: string): Promise<void>;
  /**
   * D28, step 2: the file takes `from`'s place. It gets who added `from`, their role, when, how it arrived, its grant
   * and whether it is off, with `replaces`, `editedAt`, `editedBy` and `editedByStaff`. Compare-and-set: the file is a
   * kept reference file at the location with its original stored, not being replaced itself, and replaces nothing yet
   * (or `from`, a retry). Resolves the record after it, or null.
   */
  takePlace(scope: OrgScope, locationId: string, fileId: string, input: { from: FileRecord; at: Date; by: string; byStaff: boolean }): Promise<FileRecord | null>;
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
    /** A TownwiseAI read's summary item (spec 11A.9): the file it was read from. */
    source?: AiSource;
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
   * sheet names in the report when `sheets` is given. What a TownwiseAI read kept of the file's content goes too: its
   * answer's summary, facts, events and days (the kind and counts stay).
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

  /**
   * Reading with TownwiseAI (spec 11A.9): compare-and-set a fresh `ai`, `queued`, on the location's file while it is
   * finished (read, kept or failed) with its original, and has no read or a failed, skipped or undone one. The record
   * after, or null when it no longer qualifies (deleted, its original deleted, or another request won).
   */
  requestAiRead(scope: OrgScope, locationId: string, fileId: string, input: {
    by: string; role: Role; byStaff: boolean; grantId: string | null; at: Date;
  }): Promise<FileRecord | null>;
  /** The reader's heartbeat: a later `leaseUntil` while the read is `reading` under claim `attempt`. False once it is not. */
  renewAiLease(scope: OrgScope, fileId: string, attempt: number, until: Date): Promise<boolean>;
  /**
   * The model's validated answer, saved under claim `attempt` before anything acts on it, with `partial` and the call's
   * cost added, while the original is still stored. False when the claim is no longer this one (a takeover, or the file
   * deleted) or the original was deleted meanwhile (a purge).
   */
  saveAiResult(scope: OrgScope, fileId: string, attempt: number, input: {
    result: AiReadResult; partial: boolean; costMicroUsd: number;
  }): Promise<boolean>;
  /**
   * Ends the read under claim `attempt`: done, failed or skipped, with its reason, the lease dropped, and a cost to add
   * (a refused call is charged). False when the claim is no longer this one.
   */
  finishAiRead(scope: OrgScope, fileId: string, attempt: number, input: {
    status: 'done' | 'failed' | 'skipped'; reason: string | null; at: Date; partial?: boolean; costMicroUsd?: number;
  }): Promise<boolean>;
  /**
   * An attempt that stopped (an error, a failed call): back to `queued`, the attempt counted, not to be claimed before
   * `notBefore`. False when not held.
   */
  releaseAiRead(scope: OrgScope, fileId: string, attempt: number, notBefore: Date): Promise<boolean>;
  /** How many of the organization's reads are queued or reading (the 10 a time cap). */
  aiReadsInFlight(scope: OrgScope): Promise<number>;
  /**
   * S2, before any action writes: compare-and-set the plan's ids on `ai.actions` (outcome null) while the read is held
   * under claim `attempt` and has no plan yet. The record after; when a plan was already saved (an earlier attempt's)
   * and the read is still held, the record as it is, so the retry writes under those ids. Null once the read is no
   * longer held (the file deleted, being deleted, or the claim taken over).
   */
  planAiActions(scope: OrgScope, fileId: string, attempt: number, plan: AiActionPlan): Promise<FileRecord | null>;
  /**
   * S2, after every action: what they did, on the plan, while the read is held under claim `attempt`; the answer's
   * days, used now, are dropped (its counts stay).
   */
  recordAiActions(scope: OrgScope, fileId: string, attempt: number, outcome: AiActionsOutcome): Promise<boolean>;
  /**
   * Undo, step 1: compare-and-set `ai.undoing` on the location's file while its read ended (done, failed or skipped)
   * with a plan (a retry finds it set already and goes on). The record after, or null when the read did not end with a
   * plan (or the file is gone or going).
   */
  markAiUndoing(scope: OrgScope, locationId: string, fileId: string): Promise<FileRecord | null>;
  /**
   * Undo, last step: the read becomes `undone`, and its actions and its answer are cleared, while it ended and is
   * undoing.
   */
  finishAiUndo(scope: OrgScope, locationId: string, fileId: string): Promise<boolean>;
  /** The organization's files among `ids`, leaving out files being deleted (any location). */
  byIds(scope: OrgScope, ids: readonly string[]): Promise<FileRecord[]>;
  /** The location's summary items a TownwiseAI read of `fileId` kept, being deleted or not (an undo resumes them). */
  fromAiRead(scope: OrgScope, locationId: string, fileId: string): Promise<FileRecord[]>;
  /** The organization's summary items TownwiseAI reads of any of `fileIds` kept, being deleted or not (a staff purge). */
  fromAiReads(scope: OrgScope, fileIds: readonly string[]): Promise<FileRecord[]>;
}

export function createFileStore(connection: Connection): FileStore {
  const File = fileModel(connection);
  const org = (scope: OrgScope): Types.ObjectId => new Types.ObjectId(scope.orgId);
  const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
  const after = { returnDocument: 'after' } as const;
  /** A read held under claim `attempt`: `reading`, with the attempt count that claim set, on a file not being deleted. */
  const heldAiRead = (scope: OrgScope, fileId: string, attempt: number): Record<string, unknown> => ({
    _id: oid(fileId), orgId: org(scope), status: trusted({ $ne: 'deleting' }), 'ai.status': 'reading', 'ai.attempts': attempt,
  });
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
    async rename(scope, locationId, fileId, name, staleBefore) {
      const doc = await File.findOneAndUpdate(
        {
          _id: oid(fileId), orgId: org(scope), locationId: oid(locationId), purpose: 'reference', status: 'kept', rawDeletedAt: null,
          // No live claim: none, one with no time, or a stale one.
          $or: [{ replacedBy: null }, { replacedAt: null }, { replacedAt: trusted({ $lt: staleBefore }) }],
        },
        { $set: { name } },
        after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async claimReplace(scope, locationId, fileId, byId, at) {
      const doc = await File.findOneAndUpdate(
        {
          _id: oid(fileId), orgId: org(scope), locationId: oid(locationId), purpose: 'reference', status: 'kept', rawDeletedAt: null,
          replacedBy: trusted({ $in: [null, oid(byId)] }),
        },
        { $set: { replacedBy: oid(byId), replacedAt: at } },
        after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async releaseReplace(scope, fileId, byId) {
      await File.updateOne({ _id: oid(fileId), orgId: org(scope), replacedBy: oid(byId) }, { $unset: { replacedBy: 1, replacedAt: 1 } });
    },
    async takePlace(scope, locationId, fileId, input) {
      const { from } = input;
      const set: Record<string, unknown> = {
        uploadedBy: from.uploadedBy, uploaderRole: from.uploaderRole, uploadedAt: from.uploadedAt,
        replaces: oid(from.id), editedAt: input.at, editedBy: input.by,
      };
      const unset: Record<string, 1> = {};
      // The optional fields are absent when unset, never stored as null or false.
      const carry = (field: string, value: unknown): void => {
        if (value === null || value === false) unset[field] = 1;
        else set[field] = value;
      };
      carry('byStaff', from.byStaff);
      carry('openAsAdminGrantId', from.openAsAdminGrantId);
      carry('addedVia', from.addedVia);
      // An edit of a TownwiseAI read's summary item stays that read's, so undoing the read removes it too.
      carry('source', from.source === null ? null : { via: 'ai_file', fileId: oid(from.source.fileId) });
      carry('disabledAt', from.disabledAt);
      carry('disabledBy', from.disabledAt === null ? null : from.disabledBy);
      carry('editedByStaff', input.byStaff);
      const doc = await File.findOneAndUpdate(
        {
          _id: oid(fileId), orgId: org(scope), locationId: oid(locationId), purpose: 'reference', status: 'kept', rawDeletedAt: null,
          replacedBy: null, replaces: trusted({ $in: [null, oid(from.id)] }),
        },
        Object.keys(unset).length === 0 ? { $set: set } : { $set: set, $unset: unset },
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
          ...(input.source === undefined ? {} : { source: { via: 'ai_file', fileId: oid(input.source.fileId) } }),
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
      // What TownwiseAI read in it goes with it: the answer's free text, keeping its kind and counts (spec 11A.9).
      await File.updateOne(
        { _id: oid(fileId), orgId: org(scope), 'ai.result': trusted({ $type: 'object' }) },
        { $set: { 'ai.result.summary': '', 'ai.result.facts': [], 'ai.result.events': [], 'ai.result.days': [], 'ai.result.daysBorneOut': [] } },
      );
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
    async requestAiRead(scope, locationId, fileId, input) {
      const ai: StoredAiRead = {
        status: 'queued', requestedBy: input.by, requestedByRole: input.role, requestedByStaff: input.byStaff,
        requestedGrantId: input.grantId, requestedAt: input.at, attempts: 0, leaseUntil: null, notBefore: null, startedAt: null, finishedAt: null,
        reason: null, partial: false, costMicroUsd: 0, result: null, actions: null,
      };
      const doc = await File.findOneAndUpdate(
        {
          _id: oid(fileId), orgId: org(scope), locationId: oid(locationId), status: trusted({ $in: AI_READABLE }), rawDeletedAt: null,
          $or: [{ ai: null }, { 'ai.status': trusted({ $in: AI_ASK_AGAIN }) }],
        },
        { $set: { ai } },
        after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async renewAiLease(scope, fileId, attempt, until) {
      const result = await File.updateOne(heldAiRead(scope, fileId, attempt), { $set: { 'ai.leaseUntil': until } });
      return result.matchedCount === 1;
    },
    async saveAiResult(scope, fileId, attempt, input) {
      const result = await File.updateOne({ ...heldAiRead(scope, fileId, attempt), rawDeletedAt: null }, {
        $set: { 'ai.result': input.result, 'ai.partial': input.partial }, $inc: { 'ai.costMicroUsd': input.costMicroUsd },
      });
      return result.matchedCount === 1;
    },
    async finishAiRead(scope, fileId, attempt, input) {
      const set: Record<string, unknown> = { 'ai.status': input.status, 'ai.reason': input.reason, 'ai.finishedAt': input.at, 'ai.leaseUntil': null };
      if (input.partial !== undefined) set['ai.partial'] = input.partial;
      const update: Record<string, unknown> = { $set: set };
      if (input.costMicroUsd !== undefined && input.costMicroUsd > 0) update.$inc = { 'ai.costMicroUsd': input.costMicroUsd };
      const result = await File.updateOne(heldAiRead(scope, fileId, attempt), update);
      return result.matchedCount === 1;
    },
    async releaseAiRead(scope, fileId, attempt, notBefore) {
      const result = await File.updateOne(heldAiRead(scope, fileId, attempt), { $set: { 'ai.status': 'queued', 'ai.leaseUntil': null, 'ai.notBefore': notBefore } });
      return result.matchedCount === 1;
    },
    async aiReadsInFlight(scope) {
      return File.countDocuments({ orgId: org(scope), 'ai.status': trusted({ $in: ['queued', 'reading'] }) });
    },
    async planAiActions(scope, fileId, attempt, plan) {
      const actions: AiReadActions = { plan, outcome: null };
      const doc = await File.findOneAndUpdate({ ...heldAiRead(scope, fileId, attempt), 'ai.actions': null }, { $set: { 'ai.actions': actions } }, after).lean();
      if (doc !== null) return toFile(doc);
      const held = await File.findOne(heldAiRead(scope, fileId, attempt)).lean();
      return held === null ? null : toFile(held);
    },
    async recordAiActions(scope, fileId, attempt, outcome) {
      const result = await File.updateOne(
        { ...heldAiRead(scope, fileId, attempt), 'ai.actions': trusted({ $type: 'object' }), 'ai.result': trusted({ $type: 'object' }) },
        { $set: { 'ai.actions.outcome': outcome, 'ai.result.days': [], 'ai.result.daysBorneOut': [] } },
      );
      return result.matchedCount === 1;
    },
    async markAiUndoing(scope, locationId, fileId) {
      const doc = await File.findOneAndUpdate(
        {
          _id: oid(fileId), orgId: org(scope), locationId: oid(locationId), status: trusted({ $ne: 'deleting' }),
          'ai.status': trusted({ $in: AI_ENDED }), 'ai.actions': trusted({ $type: 'object' }),
        },
        { $set: { 'ai.undoing': true } },
        after,
      ).lean();
      return doc === null ? null : toFile(doc);
    },
    async finishAiUndo(scope, locationId, fileId) {
      const result = await File.updateOne(
        { _id: oid(fileId), orgId: org(scope), locationId: oid(locationId), 'ai.status': trusted({ $in: AI_ENDED }), 'ai.undoing': true },
        { $set: { 'ai.status': 'undone', 'ai.actions': null, 'ai.result': null }, $unset: { 'ai.undoing': 1 } },
      );
      return result.matchedCount === 1;
    },
    async byIds(scope, ids) {
      if (ids.length === 0) return [];
      const docs = await File.find({ orgId: org(scope), _id: trusted({ $in: ids.map(oid) }), status: trusted({ $ne: 'deleting' }) }).lean();
      return docs.map(toFile);
    },
    async fromAiRead(scope, locationId, fileId) {
      const docs = await File.find({ orgId: org(scope), locationId: oid(locationId), 'source.fileId': oid(fileId) }).lean();
      return docs.map(toFile);
    },
    async fromAiReads(scope, fileIds) {
      if (fileIds.length === 0) return [];
      const docs = await File.find({ orgId: org(scope), 'source.fileId': trusted({ $in: fileIds.map(oid) }) }).lean();
      return docs.map(toFile);
    },
  };
}

