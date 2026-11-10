import { z } from 'zod';

import { ApiError, download, upload, type ApiClient } from '../../api/client';

// Stored files and imports (spec 10.11; the storage2 design, sections 6.2 and 6.3), with the shapes of
// api/src/handlers/files.ts. Pages pass usePortal().api, which re-reads GET /api/me on the access errors of spec
// 4.3. File names travel only in JSON bodies, never in a path or query (server-core logs every URL).

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}`;
}

function filePath(locationId: string, fileId: string): `/${string}` {
  return `${locationPath(locationId)}/files/${encodeURIComponent(fileId)}`;
}

function importPath(locationId: string, importId: string): `/${string}` {
  return `${locationPath(locationId)}/imports/${encodeURIComponent(importId)}`;
}

export const FILE_KINDS = ['text', 'xlsx', 'xls', 'pdf', 'docx', 'doc', 'zip', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_STATUSES = ['uploading', 'stored', 'queued', 'reading', 'waiting', 'read', 'kept', 'failed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** Why a file was kept and not used (storage2 8.9). */
export const KEPT_CODES = [
  'old_excel', 'old_word', 'numbers', 'encrypted', 'image', 'type_not_read', 'not_a_table', 'pdf_no_table', 'pdf_scanned',
  'word_no_table', 'notes_not_read_yet', 'item_level', 'no_sales_columns', 'decimal_comma', 'needs_help', 'too_large_to_read',
  'no_header', 'no_dates', 'repeated_dates', 'too_many_days', 'too_many_locations', 'not_a_workbook', 'too_complex',
  'bad_encoding', 'zip_too_big', 'zip_bomb', 'zip_damaged', 'zip_empty', 'nothing_usable',
  // U3: a staff purge or the retention sweep deleted the original of a file not read yet (spec 11A.6).
  'raw_deleted',
  // D28: a file kept for reference, never read for sales.
  'reference',
] as const;
/** Our faults: the file is stored and we look into it. */
export const FAILED_CODES = ['internal', 'raw_missing'] as const;
export const OUTCOME_CODES = [...KEPT_CODES, ...FAILED_CODES] as const;
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

/** A ZIP entry's outcome: the kept codes, plus these. */
export const ENTRY_ONLY_CODES = ['system_file', 'nested_zip', 'zip_method', 'other_table_used'] as const;
export const ENTRY_OUTCOMES = [...KEPT_CODES, ...ENTRY_ONLY_CODES, 'internal'] as const;
export type EntryOutcome = (typeof ENTRY_OUTCOMES)[number];

/**
 * Outcome codes are read as strings: a code the server adds later is shown with the general sentence for its
 * status instead of failing the whole list (copy.ts).
 */
const outcomeSchema = z.string().nullable();

export const QUESTION_KINDS = ['date_column', 'date_order', 'location_value', 'row_mode', 'columns', 'sheet'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const fileViewSchema = z.object({
  id: z.string(),
  importId: z.string().nullable(),
  purpose: z.enum(['history', 'reference']),
  /** Null under view-as. */
  name: z.string().nullable(),
  kind: z.enum(FILE_KINDS),
  sizeBytes: z.number(),
  uploadedAt: z.string(),
  uploadedByEmail: z.string(),
  status: z.enum(FILE_STATUSES),
  outcome: outcomeSchema,
  upload: z.object({
    chunkSize: z.number(),
    chunkCount: z.number(),
    receivedBytes: z.number(),
    nextChunk: z.number().nullable(),
    expiresAt: z.string(),
  }).nullable(),
  progress: z.object({
    phase: z.enum(['unpacking', 'reading', 'writing']),
    done: z.number(),
    total: z.number().nullable(),
    unit: z.enum(['bytes', 'pages', 'days']),
  }).nullable(),
  /** Null means "Estimating". */
  etaSeconds: z.number().nullable(),
  queuePosition: z.number().nullable(),
  entries: z.object({ total: z.number(), used: z.number(), kept: z.number() }).nullable(),
  result: z.object({
    dayCount: z.number(),
    firstDate: z.string(),
    lastDate: z.string(),
    guestsDayCount: z.number(),
    netSalesDayCount: z.number(),
    inserted: z.number(),
    replaced: z.number(),
    kept: z.number(),
    closedDates: z.array(z.string()),
    missingDays: z.number(),
    uploadId: z.string(),
  }).nullable(),
  hasClean: z.boolean(),
  rawAvailable: z.boolean(),
  rawExpiresAt: z.string().nullable(),
  canDownloadRaw: z.boolean(),
  canDownloadClean: z.boolean(),
  canDelete: z.boolean(),
  canDeleteRaw: z.boolean(),
});
export type FileView = z.infer<typeof fileViewSchema>;

export const entryViewSchema = z.object({
  index: z.number(),
  /** Null under view-as. */
  path: z.string().nullable(),
  depth: z.union([z.literal(1), z.literal(2)]),
  kind: z.enum(FILE_KINDS),
  sizeBytes: z.number(),
  status: z.enum(['used', 'kept', 'failed']),
  outcome: outcomeSchema,
  dayCount: z.number().nullable(),
});
export type EntryView = z.infer<typeof entryViewSchema>;

export const questionViewSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  /** Null under view-as. */
  fileName: z.string().nullable(),
  kind: z.enum(QUESTION_KINDS),
  /** A header name, a location value, a sheet name, or an enum id the client words. */
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  /** The option the rules or the model leaned to, preselected. */
  suggested: z.string().nullable(),
  /** For a ZIP: the table's label (its first header names). */
  family: z.string().nullable(),
});
export type QuestionView = z.infer<typeof questionViewSchema>;

export const IMPORT_STATUSES = ['open', 'queued', 'reading', 'waiting', 'done'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const importViewSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  status: z.enum(IMPORT_STATUSES),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Upload order. */
  files: z.array(fileViewSchema),
  found: z.object({
    dayCount: z.number(),
    firstDate: z.string().nullable(),
    lastDate: z.string().nullable(),
    guestsDayCount: z.number(),
    netSalesDayCount: z.number(),
    closedDates: z.array(z.string()),
    missingDays: z.number(),
  }),
  progress: z.object({ filesTotal: z.number(), filesDone: z.number(), bytesTotal: z.number(), bytesDone: z.number() }),
  /** Null means "Estimating" (or done). */
  etaSeconds: z.number().nullable(),
  waitingForTurn: z.boolean(),
  question: questionViewSchema.nullable(),
  appliedVersion: z.number(),
});
export type ImportView = z.infer<typeof importViewSchema>;

/** Returned by create, so the client never hard-codes a cap. */
export const uploadLimitsSchema = z.object({
  maxFileBytes: z.number(),
  chunkSize: z.number(),
  dailyBytesLeft: z.number(),
  storedBytesLeft: z.number(),
  filesLeftInImport: z.number(),
});
export type UploadLimits = z.infer<typeof uploadLimitsSchema>;

const decider = z.enum(['rules', 'ai', 'you']).nullable();

/** A file's report: header names, row numbers, dates and counts, never a data cell (storage 7.7, storage2 8.7). */
export const reportSchema = z.object({
  sheets: z.array(z.object({ name: z.string(), used: z.boolean(), why: z.string() })),
  headerRow: z.number(),
  mapping: z.object({ date: z.string(), guests: z.string().nullable(), netSales: z.string().nullable(), location: z.string().nullable() }),
  decidedBy: z.object({ date: decider, guests: decider, netSales: decider, rowMode: decider, dateOrder: decider }),
  locationValue: z.string().nullable(),
  rowMode: z.enum(['day', 'check']),
  dateOrder: z.enum(['month_first', 'day_first']).nullable(),
  encoding: z.string().nullable(),
  rows: z.number(),
  days: z.number(),
  skipped: z.object({
    noDate: z.object({ count: z.number(), rows: z.array(z.number()) }),
    badNumber: z.object({ count: z.number(), rows: z.array(z.number()) }),
    otherLocation: z.number(),
  }),
  excluded: z.array(z.object({ date: z.string(), reason: z.string() })),
  overlap: z.object({ days: z.number(), replaced: z.boolean() }),
  closedDates: z.array(z.string()),
  missingDays: z.number(),
  families: z.array(z.object({
    label: z.array(z.string()),
    entries: z.number(),
    used: z.boolean(),
    rowMode: z.enum(['day', 'check']).nullable(),
    dayCount: z.number(),
    why: z.string(),
  })).optional(),
});
export type Report = z.infer<typeof reportSchema>;

const importRefSchema = z.object({ id: z.string(), status: z.enum(IMPORT_STATUSES) });
const createdSchema = z.object({ file: fileViewSchema, import: importRefSchema.nullable(), limits: uploadLimitsSchema });
const chunkSchema = z.object({ index: z.number(), receivedBytes: z.number(), chunksReceived: z.number() });
const completedSchema = z.object({ file: fileViewSchema, import: importRefSchema.nullable() });
const filesSchema = z.object({ files: z.array(fileViewSchema) });
const fileSchema = z.object({ file: fileViewSchema, report: reportSchema.nullable() });
const entriesSchema = z.object({ entries: z.array(entryViewSchema), next: z.number().nullable() });
const currentSchema = z.object({ import: importViewSchema.nullable() });
const oneImportSchema = z.object({ import: importViewSchema });
const removedSchema = z.object({ deleted: z.literal(true), daysKept: z.number() });
const removedRawSchema = z.object({ deleted: z.literal(true) });
const removedOriginalsSchema = z.object({ deletedOriginals: z.number(), skippedBusy: z.number() });

export type Created = z.infer<typeof createdSchema>;
export type Completed = z.infer<typeof completedSchema>;
export type ChunkReceipt = z.infer<typeof chunkSchema>;

/** `history` is read for sales; `reference` (D28) is kept as it is for the team and has no import. */
export type FilePurpose = 'history' | 'reference';

export function createUpload(
  api: ApiClient, locationId: string, input: { name: string; sizeBytes: number; purpose: FilePurpose },
): Promise<Created> {
  return api.json(`${locationPath(locationId)}/files`, createdSchema, { method: 'POST', body: input });
}

/** One chunk, `blob` exactly `chunkSize` bytes (the last one the remainder). Re-sending an index replaces it. */
export async function putChunk(
  api: ApiClient, locationId: string, fileId: string, index: number, blob: Blob,
  opts: { signal?: AbortSignal; onProgress?: (loaded: number) => void } = {},
): Promise<ChunkReceipt> {
  const res = await upload(api, `${filePath(locationId, fileId)}/chunks/${String(index)}`, blob, opts);
  let data: unknown;
  try {
    data = await res.json();
  } catch (error) {
    throw new ApiError('invalid_response', 'The server response was not valid.', { cause: error });
  }
  const parsed = chunkSchema.safeParse(data);
  if (!parsed.success) throw new ApiError('invalid_response', 'The server response was not valid.');
  return parsed.data;
}

export function completeUpload(api: ApiClient, locationId: string, fileId: string): Promise<Completed> {
  return api.json(`${filePath(locationId, fileId)}/complete`, completedSchema, { method: 'POST', body: {} });
}

/** The original, cleaned copy, report and entry list; the days it added stay (`daysKept`). Cancels an upload. */
export function removeFile(api: ApiClient, locationId: string, fileId: string): Promise<{ deleted: true; daysKept: number }> {
  return api.json(filePath(locationId, fileId), removedSchema, { method: 'DELETE' });
}

/** The original only: the cleaned copy, report, entry list and days stay. */
export function removeRaw(api: ApiClient, locationId: string, fileId: string): Promise<{ deleted: true }> {
  return api.json(`${filePath(locationId, fileId)}/raw`, removedRawSchema, { method: 'DELETE' });
}

/** Org admins: the original of every sales file at the location that isn't uploading or being read. Items kept for reference stay (D28). */
export function removeOriginals(api: ApiClient, locationId: string): Promise<{ deletedOriginals: number; skippedBusy: number }> {
  return api.json(`${locationPath(locationId)}/originals`, removedOriginalsSchema, { method: 'DELETE' });
}

/** Newest first, 200 a page; `before` is the last file id of the page before. */
export async function listFiles(api: ApiClient, locationId: string, opts: { before?: string } = {}): Promise<FileView[]> {
  const query = opts.before === undefined ? '' : `?before=${encodeURIComponent(opts.before)}`;
  const body = await api.json(`${locationPath(locationId)}/files${query}`, filesSchema);
  return body.files;
}

export function getFile(api: ApiClient, locationId: string, fileId: string): Promise<{ file: FileView; report: Report | null }> {
  return api.json(filePath(locationId, fileId), fileSchema);
}

/** A ZIP's entries, 200 a page in archive order; `next` is the `after` for the next page, null at the end. */
export function listEntries(
  api: ApiClient, locationId: string, fileId: string, opts: { after?: number } = {},
): Promise<{ entries: EntryView[]; next: number | null }> {
  const query = opts.after === undefined ? '' : `?after=${String(opts.after)}`;
  return api.json(`${filePath(locationId, fileId)}/entries${query}`, entriesSchema);
}

/** The active import, or one that finished in the last 24 hours; null when there is neither. */
export async function currentImport(api: ApiClient, locationId: string): Promise<ImportView | null> {
  const body = await api.json(`${locationPath(locationId)}/imports/current`, currentSchema);
  return body.import;
}

export async function getImport(api: ApiClient, locationId: string, importId: string): Promise<ImportView> {
  const body = await api.json(importPath(locationId, importId), oneImportSchema);
  return body.import;
}

/** "Read my history": 409 import_empty without a stored file. */
export async function startImport(api: ApiClient, locationId: string, importId: string): Promise<ImportView> {
  const body = await api.json(`${importPath(locationId, importId)}/start`, oneImportSchema, { method: 'POST', body: {} });
  return body.import;
}

/** 409 question_stale when the question changed meanwhile. */
export async function answerQuestion(
  api: ApiClient, locationId: string, importId: string, answer: { questionId: string; choice: string },
): Promise<ImportView> {
  const body = await api.json(`${importPath(locationId, importId)}/answer`, oneImportSchema, { method: 'POST', body: answer });
  return body.import;
}

/** Originals over this size come in parts, so no one response outlasts the API's 240-second ingress timeout. */
export const RAW_PART_BYTES = 32 * 1024 * 1024;
const PART_ATTEMPTS = 4;

function transient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && error.status >= 500);
}

async function withRetries<T>(run: () => Promise<T>, attempts: number): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !transient(error)) throw error;
    }
  }
}

/** The original, in 32 MiB parts when it is larger, each part retried up to 3 times. Web only (download.web.ts). */
export async function downloadRaw(api: ApiClient, locationId: string, file: Pick<FileView, 'id' | 'sizeBytes'>, opts: { signal?: AbortSignal } = {}): Promise<Blob> {
  const path = `${filePath(locationId, file.id)}/raw` as const;
  if (file.sizeBytes <= RAW_PART_BYTES) return withRetries(() => download(api, path, opts), PART_ATTEMPTS);
  const parts: Blob[] = [];
  const count = Math.ceil(file.sizeBytes / RAW_PART_BYTES);
  for (let part = 0; part < count; part += 1) {
    parts.push(await withRetries(() => download(api, `${path}?part=${String(part)}`, opts), PART_ATTEMPTS));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** The cleaned copy: `date,guests,net_sales`, one row per day. */
export function downloadClean(api: ApiClient, locationId: string, fileId: string, opts: { signal?: AbortSignal } = {}): Promise<Blob> {
  return withRetries(() => download(api, `${filePath(locationId, fileId)}/clean`, opts), PART_ATTEMPTS);
}
