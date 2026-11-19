// Stored files and imports (spec 10.11, 11A): chunked uploads, the file list, downloads, deletion, and the import a
// location's dropped files are read in. Every route answers 503 files_unavailable while stored files are off, and every
// location, file and import id from another organization answers 404 exactly like an unknown one, because each is
// loaded through the caller's OrgScope. File names travel only in JSON bodies (server-core logs URLs) and never reach a
// log line or an audit event: logs carry ids, kinds, sizes and counts.
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import { utcDay } from '../dates.ts';
import { queueAutoRead } from '../files/ai-auto.ts';
import { BlobMissingError, BlobUnavailableError, type BlobRef, type FileBlobs } from '../files/blobs.ts';
import { importEta, type ImportEta } from '../files/eta.ts';
import {
  CHUNK_BYTES, DAILY_UPLOAD_BYTES, FILES_PER_IMPORT, FILES_PER_LOCATION, MAX_CHUNKS, MAX_FILE_BYTES, RAW_PART_BYTES, RAW_RETENTION_DAYS,
  RECENT_IMPORT_MS, STORED_BYTES_PER_ORG, UPLOAD_SESSION_MS, UPLOADING_PER_LOCATION,
} from '../files/limits.ts';
import { familyKey } from '../files/parse/families.ts';
import { saveTextItem, TEXT_ITEM_MAX_CHARS, TEXT_ITEM_TITLE_MAX } from '../files/items.ts';
import { deleteOriginals, removeFile, renamedSheets } from '../files/remove.ts';
import { kindLabel, kindOfName, sanitizeName, sniff } from '../files/sniff.ts';
import { ChunkLengthError, createStreamGate, fingerprintOf, receiveChunk } from '../files/upload.ts';
import { authorEmail, TOWNWISE_STAFF } from '../people.ts';
import type { FileKind, FilePurpose, FileRecord, FileResult, FileStatus } from '../stores/files.ts';
import type { ImportQuestion, ImportRecord, ImportStatus } from '../stores/imports.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf, orgAdmin } from './team.ts';

/** Spec 10.11: what the client sees of a file. `deleting` is never shown. */
export interface FileView {
  id: string; importId: string | null; purpose: FilePurpose;
  name: string | null;
  kind: FileKind; sizeBytes: number; uploadedAt: string; uploadedByEmail: string;
  status: Exclude<FileStatus, 'deleting'>;
  outcome: string | null;
  upload: null | { chunkSize: number; chunkCount: number; receivedBytes: number; nextChunk: number | null; expiresAt: string };
  progress: null | { phase: 'unpacking' | 'reading' | 'writing'; done: number; total: number | null; unit: 'bytes' | 'pages' | 'days' };
  etaSeconds: number | null;
  queuePosition: number | null;
  entries: null | { total: number; used: number; kept: number };
  result: FileResult | null;
  hasClean: boolean;
  rawAvailable: boolean; rawExpiresAt: string | null;
  canDownloadRaw: boolean; canDownloadClean: boolean; canDelete: boolean; canDeleteRaw: boolean;
}

export interface EntryView {
  index: number; path: string | null; depth: 1 | 2; kind: FileKind; sizeBytes: number;
  status: 'used' | 'kept' | 'failed'; outcome: string | null; dayCount: number | null;
}

export interface QuestionView {
  id: string; fileId: string; fileName: string | null; sheet: number; kind: ImportQuestion['kind'];
  options: { id: string; label: string }[]; suggested: string | null; family: string | null;
}

export interface ImportView {
  id: string; locationId: string; status: ImportStatus;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  files: FileView[];
  found: {
    dayCount: number; firstDate: string | null; lastDate: string | null; guestsDayCount: number;
    netSalesDayCount: number; closedDates: string[]; missingDays: number;
  };
  progress: { filesTotal: number; filesDone: number; bytesTotal: number; bytesDone: number };
  etaSeconds: number | null;
  waitingForTurn: boolean;
  question: QuestionView | null;
  appliedVersion: number;
}

/** Spec 10.11: returned by create, so the client never hard-codes a cap. */
export interface UploadLimits {
  maxFileBytes: number; chunkSize: number; dailyBytesLeft: number; storedBytesLeft: number; filesLeftInImport: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_PAGE = 200;
const ENTRIES_PAGE = 200;
const DONE_STATUSES: readonly FileStatus[] = ['read', 'kept', 'failed'];

/** One counter per process: chunk streams on this replica (spec 11A, back-pressure). */
const chunkStreams = createStreamGate();

function filesOn(ctx: TownwiseContext): FileBlobs {
  if (ctx.files === null) throw new AppError(503, 'files_unavailable', 'Stored files are off');
  return ctx.files;
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** A refusal with detail fields beside the kit's { error, message }. */
function refuse(res: Response, status: number, error: string, message: string, detail: Record<string, unknown>): void {
  res.status(status).json({ error, message, ...detail });
}

function storageUnavailable(ctx: TownwiseContext, op: string, err: unknown): AppError {
  const errType = err instanceof BlobUnavailableError ? err.errType : err instanceof Error ? err.name : 'unknown';
  const status = err instanceof BlobUnavailableError ? err.status : null;
  ctx.logger.warn({ op, errType, status }, 'townwise.blob_failed');
  return new AppError(503, 'storage_unavailable', 'File storage is unavailable', { retryAfterSeconds: 5 });
}

/** Runs a blob call; a missing blob resolves `missing`, any other failure answers 503 storage_unavailable. */
async function blobCall<T>(ctx: TownwiseContext, op: string, run: () => Promise<T>, missing: () => T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BlobMissingError) return missing();
    throw storageUnavailable(ctx, op, err);
  }
}

function refOf(file: FileRecord): BlobRef {
  return { locationId: file.locationId, fileId: file.id };
}

export function isUploaderOrAdmin(member: MemberPrincipal, file: FileRecord): boolean {
  return member.role === 'org_admin' || member.userId === file.uploadedBy;
}

async function loadFile(ctx: TownwiseContext, scope: OrgScope, locationId: string, rawId: unknown): Promise<FileRecord> {
  const file = await ctx.stores.files.get(scope, locationId, parseInput(objectId, rawId));
  if (file === null || file.status === 'deleting') throw notFound();
  return file;
}

export function fileView(member: MemberPrincipal, file: FileRecord, email: string, eta: ImportEta | null): FileView {
  const viewAs = member.viewAs !== null;
  const mayManage = !viewAs && isUploaderOrAdmin(member, file);
  const rawAvailable = file.rawDeletedAt === null && file.status !== 'uploading';
  const session = file.upload;
  const received = session === null ? [] : session.chunks;
  const missing = received.findIndex((chunk) => chunk === null);
  const progress = file.status === 'reading' ? file.progress : null;
  return {
    id: file.id,
    importId: file.importId,
    purpose: file.purpose,
    name: viewAs ? null : file.name,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    uploadedAt: file.uploadedAt.toISOString(),
    uploadedByEmail: email,
    status: file.status === 'deleting' ? 'failed' : file.status,
    outcome: file.outcome,
    upload: file.status !== 'uploading' || session === null ? null : {
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
      receivedBytes: received.reduce((sum, chunk) => sum + (chunk?.bytes ?? 0), 0),
      nextChunk: missing === -1 ? null : missing,
      expiresAt: session.expiresAt.toISOString(),
    },
    progress: progress === null ? null : { phase: progress.phase, done: progress.done, total: progress.total, unit: progress.unit },
    etaSeconds: file.status === 'queued' || file.status === 'reading' ? eta?.files.get(file.id) ?? null : null,
    queuePosition: file.status === 'queued' ? eta?.positions.get(file.id) ?? null : null,
    entries: file.entries,
    result: file.result,
    hasClean: file.cleanBytes !== null,
    rawAvailable,
    rawExpiresAt: rawAvailable ? new Date(file.uploadedAt.getTime() + RAW_RETENTION_DAYS * DAY_MS).toISOString() : null,
    canDownloadRaw: mayManage && rawAvailable,
    canDownloadClean: !viewAs && file.cleanBytes !== null,
    canDelete: mayManage,
    canDeleteRaw: mayManage && rawAvailable && DONE_STATUSES.includes(file.status),
  };
}

/** The uploaders' emails, but for files staff uploaded in open as admin (those read "Townwise staff"). */
async function emailsOf(ctx: TownwiseContext, files: readonly FileRecord[]): Promise<Map<string, string>> {
  const ids = [...new Set(files.filter((file) => !file.byStaff).map((file) => file.uploadedBy))];
  return new Map(await Promise.all(ids.map(async (id): Promise<[string, string]> => [id, await authorEmail(ctx, id, false)])));
}

async function fileViews(ctx: TownwiseContext, member: MemberPrincipal, files: readonly FileRecord[], eta: ImportEta | null): Promise<FileView[]> {
  const emails = await emailsOf(ctx, files);
  return files.map((file) => fileView(member, file, file.byStaff ? TOWNWISE_STAFF : emails.get(file.uploadedBy) ?? '', eta));
}

function etaOf(ctx: TownwiseContext, record: ImportRecord, files: readonly FileRecord[]): ImportEta {
  return importEta({ ...record, files }, ctx.now());
}

async function importView(ctx: TownwiseContext, member: MemberPrincipal, record: ImportRecord): Promise<ImportView> {
  const { scope } = member;
  const files = await ctx.stores.files.inImport(scope, record.id);
  const eta = etaOf(ctx, record, files);
  const read = files.filter((file) => file.result !== null);
  const found = await ctx.stores.imports.found(scope, record.locationId, read.flatMap((file) => (file.result === null ? [] : [file.result.uploadId])));
  const closed = [...new Set(read.flatMap((file) => file.result?.closedDates ?? []))].sort().slice(0, 60);
  const done = files.filter((file) => DONE_STATUSES.includes(file.status));
  const question = record.question;
  const asked = question === null ? undefined : files.find((file) => file.id === question.fileId);
  return {
    id: record.id,
    locationId: record.locationId,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    files: await fileViews(ctx, member, files, eta),
    found: { ...found, closedDates: closed },
    progress: {
      filesTotal: files.length,
      filesDone: done.length,
      bytesTotal: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      bytesDone: done.reduce((sum, file) => sum + file.sizeBytes, 0),
    },
    etaSeconds: eta.etaSeconds,
    waitingForTurn: eta.waitingForTurn,
    question: question === null ? null : {
      id: question.id, fileId: question.fileId, sheet: question.sheet, kind: question.kind,
      fileName: member.viewAs !== null || asked === undefined ? null : asked.name,
      options: question.options.map((option) => ({ ...option })), suggested: question.suggested, family: question.familyLabel ?? null,
    },
    appliedVersion: record.appliedVersion,
  };
}

// ---- Uploads --------------------------------------------------------------------------------------------------

const createBody = z.strictObject({
  name: z.string().max(1024),
  sizeBytes: z.number().int().min(1),
  purpose: z.string().max(32),
});

/** POST /files: opens an upload session in the location's active import (spec 10.11). */
export async function createFile(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const body = parseInput(createBody, req.body);
  const name = sanitizeName(body.name);
  if (name === '') throw new AppError(400, 'invalid_request', 'Invalid request');
  if (body.purpose !== 'history' && body.purpose !== 'reference') throw new AppError(400, 'purpose_unavailable', 'That kind of upload is not available');
  const purpose: FilePurpose = body.purpose;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  if (body.sizeBytes > MAX_FILE_BYTES) {
    refuse(res, 413, 'file_too_large', 'The file is over the size limit', { maxBytes: MAX_FILE_BYTES });
    return;
  }
  // A reference item belongs to no import.
  const active = purpose === 'history' ? await ctx.stores.imports.active(scope, location.id) : null;
  const now = ctx.now();
  const counts = await ctx.stores.files.counts(scope, location.id, active?.id ?? null, now);
  if (counts.inImport >= FILES_PER_IMPORT) throw new AppError(409, 'import_full', 'This import has the most files it can take');
  if (counts.uploading >= UPLOADING_PER_LOCATION) throw new AppError(409, 'too_many_uploading', 'Too many files are uploading at once');
  const storedBytesLeft = Math.max(0, STORED_BYTES_PER_ORG - await ctx.stores.files.storedBytes(scope, now));
  if (counts.inLocation >= FILES_PER_LOCATION || body.sizeBytes > storedBytesLeft) {
    refuse(res, 409, 'storage_full', 'Your organization has stored the most it can', { storedBytesLeft });
    return;
  }
  const day = utcDay(now);
  if (!(await ctx.stores.uploadDays.reserve(scope, day, body.sizeBytes, DAILY_UPLOAD_BYTES, now))) {
    refuse(res, 409, 'daily_upload_limit', 'Your organization has uploaded the most it can today', {
      resetsAt: `${utcDay(now, 1)}T00:00:00.000Z`,
    });
    return;
  }
  const record = purpose === 'history' ? await ctx.stores.imports.joinOrCreate(scope, location.id, { userId: member.userId, now }) : null;
  const file = await ctx.stores.files.create(scope, location.id, {
    importId: record?.id ?? null, purpose, uploadedBy: member.userId, uploaderRole: member.role,
    ...(member.openAsAdmin !== null ? { byStaff: true, openAsAdminGrantId: member.openAsAdmin.grantId } : {}), uploadedAt: now, name,
    kind: kindOfName(name), sizeBytes: body.sizeBytes, chunkSize: CHUNK_BYTES, expiresAt: new Date(now.getTime() + UPLOAD_SESSION_MS),
  });
  const chunkCount = file.upload?.chunkCount ?? 0;
  ctx.logger.info({
    orgId: scope.orgId, locationId: location.id, fileId: file.id, importId: record?.id ?? null, sizeBytes: file.sizeBytes, chunkCount,
  }, 'townwise.file_upload_started');
  const dailyUsed = await ctx.stores.uploadDays.used(scope, day);
  res.status(201).json({
    file: fileView(member, file, file.byStaff ? TOWNWISE_STAFF : member.email, null),
    import: record === null ? null : { id: record.id, status: record.status },
    // D59: whether TownwiseAI reads files here on its own now, so the client sends its box's `aiAuto: true` on complete.
    autoRead: ctx.config.agentAuto && ctx.aiReads !== null && (await ctx.stores.orgs.findById(scope.orgId))?.agentAuto.on === true,
    limits: {
      maxFileBytes: MAX_FILE_BYTES,
      chunkSize: CHUNK_BYTES,
      dailyBytesLeft: Math.max(0, DAILY_UPLOAD_BYTES - dailyUsed),
      storedBytesLeft: Math.max(0, storedBytesLeft - body.sizeBytes),
      filesLeftInImport: Math.max(0, FILES_PER_IMPORT - counts.inImport - 1),
    } satisfies UploadLimits,
  });
}

const chunkIndex = z.coerce.number().int().min(0).max(49_999);

/** PUT /files/:fileId/chunks/:index: one chunk, streamed into storage (spec 11A, the chunk transport). */
export async function putChunk(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  try {
    await receive(ctx, req, res, principal);
  } catch (err) {
    // A refused chunk's body is never read: close the connection rather than drain up to 8 MiB.
    if (!res.headersSent) res.setHeader('Connection', 'close');
    throw err;
  }
}

async function receive(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const index = parseInput(chunkIndex, req.params.index);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  if (file.uploadedBy !== member.userId) throw new AppError(403, 'forbidden', 'Only the person uploading this file can send it');
  const session = file.upload;
  if (file.status !== 'uploading' || session === null) throw new AppError(409, 'file_not_uploading', 'This file is not uploading');
  if (ctx.now() >= session.expiresAt) throw new AppError(410, 'upload_expired', 'This upload ran out of time; drop the file again');
  if (index >= session.chunkCount || index >= MAX_CHUNKS) throw new AppError(400, 'invalid_request', 'Invalid request');
  const expected = index === session.chunkCount - 1 ? file.sizeBytes - index * session.chunkSize : session.chunkSize;
  const declared = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined || declared === undefined || Number(declared) !== expected) {
    throw new AppError(400, 'invalid_request', 'Invalid request');
  }
  if (!chunkStreams.enter()) {
    ctx.logger.info({ active: chunkStreams.active }, 'townwise.uploads_busy');
    throw new AppError(503, 'uploads_busy', 'Uploads are busy; try again shortly', { retryAfterSeconds: 2 });
  }
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  req.once('close', () => { if (!req.complete) abort(); });
  res.once('close', () => { if (!res.writableFinished) abort(); });
  let received;
  try {
    received = await receiveChunk(req, {
      length: expected,
      wantHead: index === 0,
      signal: controller.signal,
      stage: (stream, signal) => blobs.stageChunk(scope, refOf(file), index, stream, expected, signal),
    });
  } catch (err) {
    if (controller.signal.aborted) {
      // The client went away; nothing is recorded, and nobody is left to read an answer.
      if (!res.headersSent) res.status(400).end();
      return;
    }
    if (err instanceof ChunkLengthError) throw new AppError(400, 'invalid_request', 'Invalid request');
    throw storageUnavailable(ctx, 'stage_chunk', err);
  } finally {
    chunkStreams.leave();
  }
  const updated = await ctx.stores.files.recordChunk(scope, file.id, index, received, received.head === null ? null : received.head.toString('base64'));
  if (updated === null) throw new AppError(409, 'file_not_uploading', 'This file is not uploading');
  const chunks = updated.upload?.chunks ?? [];
  res.status(200).json({
    index,
    receivedBytes: chunks.reduce((sum, chunk) => sum + (chunk?.bytes ?? 0), 0),
    chunksReceived: chunks.filter((chunk) => chunk !== null).length,
  });
}

const completeBody = z.strictObject({ aiAuto: z.boolean().optional() });

/** POST /files/:fileId/complete: commits the chunks, tells the kind, and queues the file if its import started. */
export async function completeFile(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  // D59: `aiAuto: true` only when the person left the box checked as the upload finished; anything else keeps the file
  // from TownwiseAI's automatic reads, so an upload with no box (a chat attachment, an item's edit) or from an older
  // client is never read on its own.
  const body = parseInput(completeBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  if (file.uploadedBy !== member.userId) throw new AppError(403, 'forbidden', 'Only the person uploading this file can finish it');
  const session = file.upload;
  if (file.status !== 'uploading' || session === null || (file.purpose === 'history' && file.importId === null)) {
    throw new AppError(409, 'file_not_uploading', 'This file is not uploading');
  }
  const missing = session.chunks.flatMap((chunk, index) => (chunk === null ? [index] : []));
  const total = session.chunks.reduce((sum, chunk) => sum + (chunk?.bytes ?? 0), 0);
  if (missing.length > 0 || total !== file.sizeBytes) {
    refuse(res, 409, 'chunks_missing', 'Some of the file has not arrived', { missing: missing.slice(0, 50) });
    return;
  }
  const ref = refOf(file);
  await blobCall(ctx, 'commit', () => blobs.commitChunks(scope, ref, session.chunkCount), () => {
    throw storageUnavailable(ctx, 'commit', new BlobUnavailableError('BlockMissing', null));
  });
  const fingerprint = fingerprintOf(session.chunkSize, session.chunks.map((chunk) => chunk?.sha256 ?? ''));
  const { kind } = sniff(file.name, Buffer.from(session.head ?? '', 'base64'));
  const duplicate = await ctx.stores.files.duplicateOf(scope, location.id, file.purpose, fingerprint, file.id);
  if (duplicate !== null) {
    await blobCall(ctx, 'delete_raw', () => blobs.deleteRaw(scope, ref), () => undefined);
    await ctx.stores.files.remove(scope, file.id);
    if (file.importId !== null) {
      const remaining = await ctx.stores.files.inImport(scope, file.importId);
      await ctx.stores.imports.removeIfEmptyOpen(scope, file.importId, remaining.length);
    }
    refuse(res, 409, 'file_duplicate', 'You already added this file', { fileId: duplicate });
    return;
  }
  if (file.purpose === 'reference') {
    // Kept as it is: read by no one, in no import.
    const kept = await ctx.stores.files.finishUpload(scope, file.id, { fingerprint, kind, status: 'kept', outcome: 'reference', aiAuto: body.aiAuto === true });
    if (kept === null) throw new AppError(409, 'file_not_uploading', 'This file is not uploading');
    await recordUploaded(ctx, member, kept);
    // D59: TownwiseAI reads it on its own, unless its box was unchecked or either switch is off.
    if (await queueAutoRead({ stores: ctx.stores, logger: ctx.logger, now: ctx.now, on: ctx.config.agentAuto && ctx.aiReads !== null }, scope, kept)) {
      ctx.aiReads?.nudge();
    }
    res.status(200).json({ file: fileView(member, kept, kept.byStaff ? TOWNWISE_STAFF : member.email, null), import: null });
    return;
  }
  const before = await ctx.stores.imports.get(scope, location.id, file.importId ?? '');
  const stored = await ctx.stores.files.finishUpload(scope, file.id, {
    fingerprint, kind, status: before === null || before.status === 'open' ? 'stored' : 'queued', aiAuto: body.aiAuto === true,
  });
  if (stored === null) throw new AppError(409, 'file_not_uploading', 'This file is not uploading');
  const placed = await place(ctx, member, stored);
  await recordUploaded(ctx, member, placed.file);
  res.status(200).json({ file: fileView(member, placed.file, placed.file.byStaff ? TOWNWISE_STAFF : member.email, null), import: { id: placed.import.id, status: placed.import.status } });
}

/** The `file.uploaded` audit event and the `townwise.file_stored` log line: kind, size, purpose and route, never a name. */
async function recordUploaded(ctx: TownwiseContext, member: MemberPrincipal, file: FileRecord): Promise<void> {
  await recordAfter(ctx, {
    ...actorOf(member), at: ctx.now(), orgId: member.scope.orgId, action: 'file.uploaded',
    target: { type: 'file', id: file.id },
    details: {
      locationId: file.locationId, kind: file.kind, sizeBytes: file.sizeBytes, purpose: file.purpose,
      ...(file.addedVia === null ? {} : { via: file.addedVia }),
    },
  });
  ctx.logger.info({ fileId: file.id, kind: file.kind, sizeBytes: file.sizeBytes, purpose: file.purpose, durationMs: ctx.now().getTime() - file.uploadedAt.getTime() }, 'townwise.file_stored');
}

/**
 * The file just stored joins its import for good. `noteDrop` bumps the import after the file's status is set, so the
 * reader can never finish an import past it: a file stored while its import started is queued and bumped again, and
 * a file whose import finished meanwhile moves into the location's next import. That import starts at once only when
 * the file is its first (the person asked for the file to be read); an open import someone already dropped files into
 * waits for them to start it, with this file among its stored rows.
 */
async function place(ctx: TownwiseContext, member: MemberPrincipal, file: FileRecord): Promise<{ file: FileRecord; import: ImportRecord }> {
  const { scope } = member;
  let current = file;
  for (;;) {
    const now = ctx.now();
    const noted = await ctx.stores.imports.noteDrop(scope, current.importId ?? '', now);
    if (noted === null) {
      const next = await ctx.stores.imports.joinOrCreate(scope, current.locationId, { userId: member.userId, now });
      const first = next.status === 'open' && (await ctx.stores.files.inImport(scope, next.id)).length === 0;
      // Stored first, then started: the reader takes a stored file of a started import, and the loop queues it.
      await ctx.stores.files.reassign(scope, current.id, next.id);
      if (first) await ctx.stores.imports.start(scope, next.id, now);
      current = { ...current, importId: next.id, status: 'stored' };
      continue;
    }
    if (noted.status === 'open') return { file: current, import: noted };
    if (current.status === 'stored') {
      current = await ctx.stores.files.move(scope, current.id, ['stored'], 'queued') ?? { ...current, status: 'queued' };
      continue;
    }
    ctx.nudgeFiles();
    return { file: current, import: noted };
  }
}

// D59 slice 4: `aiAuto: true` only when the person left the box checked as they saved it, as on an upload's complete.
const textBody = z.strictObject({
  title: z.string().trim().min(1).max(TEXT_ITEM_TITLE_MAX),
  text: z.string().min(1).max(TEXT_ITEM_MAX_CHARS),
  aiAuto: z.boolean().optional(),
});

/**
 * Keeps text as a reference item added by `member` (files/items.ts), and records `file.uploaded` for a new one. A save
 * with an `id` the item already has answers it, unrecorded. Answers 409 storage_full or daily_upload_limit itself and
 * resolves null; a blob write that fails answers 503 storage_unavailable. Used by POST /data/text and by Keep on a
 * TownwiseAI proposal (handlers/chat-item-proposals.ts).
 */
export async function keepTextItem(
  ctx: TownwiseContext, res: Response, member: MemberPrincipal, blobs: FileBlobs, locationId: string,
  input: { id?: string; title: string; text: string; addedVia: 'townwise_ai' | null; aiAuto?: boolean },
): Promise<{ file: FileRecord; created: boolean } | null> {
  const { scope } = member;
  const now = ctx.now();
  // Only the blob write answers 503 storage_unavailable; a store failure takes the ordinary 500 path.
  const writer: Pick<FileBlobs, 'writeRaw'> = {
    writeRaw: (...args) => blobCall(ctx, 'write_raw', () => blobs.writeRaw(...args), () => {
      throw storageUnavailable(ctx, 'write_raw', new BlobUnavailableError('BlobMissing', null));
    }),
  };
  const saved = await saveTextItem(ctx.stores, writer, scope, locationId, {
    ...input, uploadedBy: member.userId, uploaderRole: member.role, now,
    ...(member.openAsAdmin === null ? {} : { openAsAdminGrantId: member.openAsAdmin.grantId }),
  });
  if (saved === 'storage_full') {
    const storedBytesLeft = Math.max(0, STORED_BYTES_PER_ORG - await ctx.stores.files.storedBytes(scope, now));
    refuse(res, 409, 'storage_full', 'Your organization has stored the most it can', { storedBytesLeft });
    return null;
  }
  if (saved === 'daily_upload_limit') {
    refuse(res, 409, 'daily_upload_limit', 'Your organization has uploaded the most it can today', {
      resetsAt: `${utcDay(now, 1)}T00:00:00.000Z`,
    });
    return null;
  }
  if (saved.created) await recordUploaded(ctx, member, saved.file);
  return saved;
}

/**
 * POST /data/text: pasted text kept as a reference item, a `.txt` file named from its title. D59 slice 4: with its box
 * checked (`aiAuto: true`), TownwiseAI reads it on its own as a stored file, while both switches are on.
 */
export async function addTextItem(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const member = memberOf(principal);
  const body = parseInput(textBody, req.body);
  const location = await loadLocation(ctx, member.scope, req.params.locationId);
  const saved = await keepTextItem(ctx, res, member, blobs, location.id, {
    title: body.title, text: body.text, addedVia: null, ...(body.aiAuto === true ? { aiAuto: true } : {}),
  });
  if (saved === null) return;
  if (saved.created && await queueAutoRead({ stores: ctx.stores, logger: ctx.logger, now: ctx.now, on: ctx.config.agentAuto && ctx.aiReads !== null }, member.scope, saved.file)) {
    ctx.aiReads?.nudge();
  }
  res.status(201).json({ file: fileView(member, saved.file, saved.file.byStaff ? TOWNWISE_STAFF : member.email, null) });
}

// ---- Reading the list ---------------------------------------------------------------------------------------------

const listQuery = z.object({ before: objectId.optional() });

/** GET /files?before=: newest first, 200 a page. Other people's unfinished uploads are left out. */
export async function listFiles(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const { before } = parseInput(listQuery, req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const [files, active] = await Promise.all([
    ctx.stores.files.list(scope, location.id, { viewerId: member.userId, before: before ?? null, limit: LIST_PAGE }),
    ctx.stores.imports.active(scope, location.id),
  ]);
  const eta = active === null ? null : etaOf(ctx, active, await ctx.stores.files.inImport(scope, active.id));
  res.status(200).json({ files: await fileViews(ctx, member, files, eta) });
}

/** GET /files/:fileId: the file and its report. */
export async function getFile(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  const record = file.importId === null ? null : await ctx.stores.imports.get(scope, location.id, file.importId);
  const eta = record === null ? null : etaOf(ctx, record, await ctx.stores.files.inImport(scope, record.id));
  const [view] = await fileViews(ctx, member, [file], eta);
  res.status(200).json({ file: view, report: file.report });
}

const entriesQuery = z.object({ after: z.coerce.number().int().min(0).max(1_000_000).optional() });

/** GET /files/:fileId/entries?after=: a ZIP's entries, 200 a page in archive order. Paths are null under view-as. */
export async function listEntries(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const { after } = parseInput(entriesQuery, req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  if (file.kind !== 'zip') throw new AppError(404, 'no_entries', 'This file is not an archive');
  const rows = await ctx.stores.fileEntries.page(scope, file.id, after ?? null, ENTRIES_PAGE + 1);
  const page = rows.slice(0, ENTRIES_PAGE);
  const entries: EntryView[] = page.map((row) => ({
    index: row.index, path: member.viewAs !== null ? null : row.path, depth: row.depth, kind: row.kind, sizeBytes: row.sizeBytes,
    status: row.status, outcome: row.outcome, dayCount: row.dayCount,
  }));
  res.status(200).json({ entries, next: rows.length > ENTRIES_PAGE ? page.at(-1)?.index ?? null : null });
}

// ---- Downloads ------------------------------------------------------------------------------------------------

function asciiName(name: string): string {
  // Only printable ASCII may go in the plain filename parameter.
  const ascii = name.normalize('NFKD').replace(/[^\u0020-\u007e]/g, '').replace(/["\\]/g, '').trim();
  return ascii === '' ? 'file' : ascii;
}

function setDownloadHeaders(res: Response, input: { type: string; length: number; name: string }): void {
  res.setHeader('Content-Type', input.type);
  res.setHeader('Content-Length', String(input.length));
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName(input.name)}"; filename*=UTF-8''${encodeURIComponent(input.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
}

/** Streams a blob to the response; a client that goes away stops the blob read. */
async function stream(ctx: TownwiseContext, res: Response, body: Readable, fileId: string, which: 'raw' | 'clean'): Promise<void> {
  try {
    await pipeline(body, res);
    ctx.logger.info({ fileId, which }, 'townwise.file_downloaded');
  } catch (err) {
    body.destroy();
    ctx.logger.info({ fileId, which, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.file_download_stopped');
  }
}

function noDownloadInViewAs(member: MemberPrincipal): void {
  if (member.viewAs !== null) throw new AppError(403, 'view_as_no_download', 'Files cannot be downloaded in view-as');
}

const partQuery = z.object({ part: z.coerce.number().int().min(0).max(1000).optional() });

/** GET /files/:fileId/raw?part=: the original, or one 32 MiB part of it. Uploader or org admin, never in view-as. */
export async function downloadRaw(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const { part } = parseInput(partQuery, req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  noDownloadInViewAs(member);
  if (!isUploaderOrAdmin(member, file)) throw new AppError(403, 'forbidden', 'Only the uploader or an org admin can download the original');
  if (file.status === 'uploading') throw new AppError(409, 'file_busy', 'This file is still uploading');
  if (file.rawDeletedAt !== null) throw new AppError(410, 'raw_expired', 'The original was deleted');
  const parts = Math.ceil(file.sizeBytes / RAW_PART_BYTES);
  if (part !== undefined && part >= parts) throw new AppError(400, 'invalid_request', 'Invalid request');
  const range = part === undefined ? undefined : { offset: part * RAW_PART_BYTES, count: Math.min(RAW_PART_BYTES, file.sizeBytes - part * RAW_PART_BYTES) };
  const body = await blobCall(ctx, 'open_raw', () => blobs.openRaw(scope, refOf(file), range), () => {
    throw new AppError(410, 'raw_expired', 'The original was deleted');
  });
  setDownloadHeaders(res, { type: 'application/octet-stream', length: range?.count ?? file.sizeBytes, name: file.name });
  res.status(200);
  await stream(ctx, res, body, file.id, 'raw');
}

function cleanName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}-townwise.csv`;
}

/** GET /files/:fileId/clean: the cleaned copy (date, guests, net sales). Members, never in view-as. */
export async function downloadClean(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  noDownloadInViewAs(member);
  const cleanBytes = file.cleanBytes;
  if (cleanBytes === null) throw new AppError(404, 'no_clean_file', 'This file has no cleaned copy');
  const body = await blobCall(ctx, 'open_clean', () => blobs.openClean(scope, refOf(file)), () => {
    throw new AppError(404, 'no_clean_file', 'This file has no cleaned copy');
  });
  setDownloadHeaders(res, { type: 'text/csv; charset=utf-8', length: cleanBytes, name: cleanName(file.name) });
  res.status(200);
  await stream(ctx, res, body, file.id, 'clean');
}

// ---- Deletion -------------------------------------------------------------------------------------------------

function mayManage(member: MemberPrincipal, file: FileRecord): void {
  if (!isUploaderOrAdmin(member, file)) throw new AppError(403, 'forbidden', 'Only the uploader or an org admin can do that');
}

/** DELETE /files/:fileId/raw: the original only; the cleaned copy, report and days stay, and the name goes. */
export async function deleteRaw(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  mayManage(member, file);
  // Only once the file is read, kept or failed: a file not yet read needs its original, and reading one whose original
  // its owner deleted would fail it as raw_missing, blaming Townwise for the person's own choice.
  if (!DONE_STATUSES.includes(file.status)) throw new AppError(409, 'file_busy', 'Townwise is still using this file');
  if (file.rawDeletedAt !== null) throw new AppError(410, 'raw_expired', 'The original was already deleted');
  await blobCall(ctx, 'delete_raw', () => blobs.deleteRaw(scope, refOf(file)), () => undefined);
  await ctx.stores.files.rawDeleted(scope, file.id, ctx.now(), kindLabel(file.kind), renamedSheets(file));
  await ctx.stores.fileEntries.clearPaths(scope, file.id);
  await recordAfter(ctx, {
    ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'file.raw_deleted',
    target: { type: 'file', id: file.id }, details: { locationId: location.id, kind: file.kind },
  });
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, count: 1, by: 'owner' }, 'townwise.originals_deleted');
  res.status(200).json({ deleted: true });
}

/**
 * removeFile for a route, shared with Your data (handlers/data.ts): a blob failure answers 503 storage_unavailable and a
 * file the reader has 409 file_busy. A canceled upload is logged, and a file that was waiting on a question nudges the
 * reader. No audit. `resume` is removeFile's (a replace's own removal).
 */
export async function removeWholeFile(
  ctx: TownwiseContext, blobs: FileBlobs, scope: OrgScope, file: FileRecord, opts: { resume?: boolean } = {},
): Promise<void> {
  const removed = await removeFile(ctx.stores, blobs, scope, file, ctx.now(), opts).catch((err: unknown) => {
    if (err instanceof BlobUnavailableError) throw storageUnavailable(ctx, 'delete_file', err);
    throw err;
  });
  if (removed === 'busy') throw new AppError(409, 'file_busy', 'Townwise is reading this file');
  if (file.status === 'uploading') {
    ctx.logger.info({ fileId: file.id, receivedBytes: (file.upload?.chunks ?? []).reduce((sum, chunk) => sum + (chunk?.bytes ?? 0), 0) }, 'townwise.file_upload_cancelled');
  } else if (file.status === 'waiting') {
    ctx.nudgeFiles();
  }
}

/**
 * DELETE /files/:fileId: the original, the cleaned copy and the report; the days it added stay. An unfinished upload
 * is canceled and its bytes given back. A file waiting on a question takes the question with it.
 */
export async function deleteFile(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const file = await loadFile(ctx, scope, location.id, req.params.fileId);
  mayManage(member, file);
  await removeWholeFile(ctx, blobs, scope, file);
  if (file.status !== 'uploading') {
    await recordAfter(ctx, {
      ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'file.deleted',
      target: { type: 'file', id: file.id }, details: { locationId: location.id, kind: file.kind, reason: 'owner' },
    });
  }
  ctx.logger.info({ fileId: file.id }, 'townwise.file_deleted');
  res.status(200).json({ deleted: true, daysKept: file.result?.dayCount ?? 0 });
}

/**
 * DELETE /originals (org admins): the owner's "delete every original" on Your data. Every sales file's original at the
 * location that Townwise is done with is deleted; the cleaned copies, reports and days stay. A file not yet read is
 * skipped and counted. Items kept for reference are left alone (D28): their original is the whole item.
 */
export async function deleteLocationOriginals(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const blobs = filesOn(ctx);
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const originals = await ctx.stores.files.originals(scope, location.id, 'history');
  const result = await deleteOriginals(ctx.stores, blobs, scope, originals, ctx.now());
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'files.raw_deleted_all',
    target: { type: 'location', id: location.id }, details: { locationId: location.id, count: result.deletedOriginals },
  });
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, count: result.deletedOriginals, by: 'owner' }, 'townwise.originals_deleted');
  res.status(200).json(result);
}

// ---- Imports --------------------------------------------------------------------------------------------------

async function loadImport(ctx: TownwiseContext, scope: OrgScope, locationId: string, rawId: unknown): Promise<ImportRecord> {
  const record = await ctx.stores.imports.get(scope, locationId, parseInput(objectId, rawId));
  if (record === null) throw notFound();
  return record;
}

/** GET /imports/current: the active import, or one finished in the last 24 hours, or null. */
export async function currentImport(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const record = await ctx.stores.imports.active(scope, location.id)
    ?? await ctx.stores.imports.recentDone(scope, location.id, new Date(ctx.now().getTime() - RECENT_IMPORT_MS));
  res.status(200).json({ import: record === null ? null : await importView(ctx, member, record) });
}

/** GET /imports/:importId. */
export async function getImport(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const location = await loadLocation(ctx, member.scope, req.params.locationId);
  const record = await loadImport(ctx, member.scope, location.id, req.params.importId);
  res.status(200).json({ import: await importView(ctx, member, record) });
}

/** POST /imports/:importId/start: "Read my history". Needs at least one stored file. */
export async function startImport(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  parseInput(z.strictObject({}), req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const record = await loadImport(ctx, scope, location.id, req.params.importId);
  if (record.status !== 'open') throw new AppError(409, 'import_not_open', 'This import already started');
  const files = await ctx.stores.files.inImport(scope, record.id);
  if (!files.some((file) => file.status === 'stored')) throw new AppError(409, 'import_empty', 'Add a file first');
  const started = await ctx.stores.imports.start(scope, record.id, ctx.now());
  if (started === null) throw new AppError(409, 'import_not_open', 'This import already started');
  await ctx.stores.files.queueStored(scope, record.id);
  ctx.nudgeFiles();
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, importId: record.id, files: files.length }, 'townwise.import_started');
  res.status(202).json({ import: await importView(ctx, member, started) });
}

const answerBody = z.strictObject({ questionId: z.string().max(64), choice: z.string().max(200) });

/** The answer's effect on the file's answers, or 'not_sure', or null when the choice is not one of the options. */
function answerOf(question: ImportQuestion, choice: string): Record<string, unknown> | 'not_sure' | null {
  if (choice === 'not_sure') return 'not_sure';
  const ids = new Set(question.options.map((option) => option.id));
  switch (question.kind) {
    case 'date_column':
      return ids.has(choice) ? { dateColumn: Number(choice.slice('col:'.length)) } : null;
    case 'date_order':
      return ids.has(choice) && (choice === 'month_first' || choice === 'day_first') ? { dateOrder: choice } : null;
    case 'location_value': {
      const option = question.options.find((candidate) => candidate.id === choice);
      return option === undefined ? null : { locationValue: option.label };
    }
    case 'row_mode':
      return ids.has(choice) && (choice === 'day' || choice === 'check' || choice === 'item') ? { rowMode: choice } : null;
    case 'columns': {
      const [guests, netSales, extra] = choice.split(',');
      if (extra !== undefined || guests === undefined || netSales === undefined) return null;
      if (!guests.startsWith('guests:') || !netSales.startsWith('netSales:') || !ids.has(guests) || !ids.has(netSales)) return null;
      const column = (id: string, prefix: string): number | null => (id === `${prefix}none` ? null : Number(id.slice(prefix.length)));
      const picked = { guests: column(guests, 'guests:'), netSales: column(netSales, 'netSales:') };
      return picked.guests === null && picked.netSales === null ? null : picked;
    }
  }
}

/** POST /imports/:importId/answer: the person's answer to the import's question; the file goes back to the queue. */
export async function answerImport(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  filesOn(ctx);
  const member = memberOf(principal);
  const { scope } = member;
  const body = parseInput(answerBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const record = await loadImport(ctx, scope, location.id, req.params.importId);
  const question = record.question;
  if (record.status !== 'waiting' || question?.id !== body.questionId) throw new AppError(409, 'question_stale', 'That question was already answered');
  const effect = answerOf(question, body.choice);
  if (effect === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  // The file moves first, while the import still waits and no reader can claim it: clearing the question first would
  // let a reader finish the import in between and leave the file waiting inside a done import. The file's move is the
  // compare-and-set, so a second answer to the same question finds it no longer waiting.
  const moved = effect === 'not_sure'
    ? await ctx.stores.files.keepWaiting(scope, question.fileId, 'needs_help')
    : await ctx.stores.files.answer(scope, question.fileId, question.family === undefined ? String(question.sheet) : familyKey(question.family), effect);
  if (!moved) throw new AppError(409, 'question_stale', 'That question was already answered');
  await ctx.stores.imports.clearQuestion(scope, record.id, question.id);
  ctx.nudgeFiles();
  ctx.logger.info({ importId: record.id, fileId: question.fileId, kind: question.kind }, 'townwise.file_answered');
  const updated = await ctx.stores.imports.get(scope, location.id, record.id);
  res.status(200).json({ import: await importView(ctx, member, updated ?? record) });
}
