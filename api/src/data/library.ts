// Your data (D28): one list of everything a location received, newest first. An item is a sales upload (`u_<id>`), with
// the stored file it was read from when there is one, or a stored file that wrote no days (`f_<id>`): a reference item,
// or a sales file Townwise kept unread or is still reading. A stored file that wrote days shows once, as its upload.
// Records carry the file's name for the page; nothing here logs, and no name reaches a log line or an audit event.
import { AppError } from '@ckeith26/server-core';

import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import type { FileKind, FileRecord, FileStatus } from '../stores/files.ts';
import type { UploadRecord } from '../stores/uploads.ts';

export interface DataItemRef { readonly type: 'upload' | 'file'; readonly id: string }

const REF = /^(u|f)_([0-9a-f]{24})$/;

/** A ref from a path or a tool's input; anything else answers 400 invalid_request. */
export function parseRef(raw: unknown): DataItemRef {
  const match = typeof raw === 'string' ? REF.exec(raw) : null;
  if (match === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  return { type: match[1] === 'u' ? 'upload' : 'file', id: match[2] ?? '' };
}

export function refString(ref: DataItemRef): string {
  return `${ref.type === 'upload' ? 'u' : 'f'}_${ref.id}`;
}

/**
 * How an item arrived: a browser upload, a stored file, staff setup, or from TownwiseAI (kept from a conversation, or
 * an upload or summary item a TownwiseAI read of a file made, spec 11A.9).
 */
export type DataVia = 'browser' | 'file' | 'staff' | 'townwise_ai';

export type DataState = 'uploading' | 'reading' | 'waiting' | 'used' | 'kept' | 'failed' | 'not_finished';

export interface DataItemRecord {
  readonly ref: DataItemRef;
  readonly locationId: string;
  readonly via: DataVia;
  readonly kind: 'daily_totals' | FileKind;
  readonly addedAt: Date;
  readonly addedBy: string;
  readonly byStaff: boolean;
  readonly enabled: boolean;
  readonly state: DataState;
  readonly outcome: string | null;
  /** An upload's days: how many it sent, how many it still holds (it last wrote them), and its first and last date. */
  readonly days: { count: number; inUse: number; firstDate: string; lastDate: string } | null;
  readonly upload: UploadRecord | null;
  /** The stored file; for an upload, the file it was read from (null for a browser upload, and while files are off). */
  readonly file: FileRecord | null;
}

export const DATA_PAGE = 100;

/** A page's position: the last item's time and id, newest first. */
export interface DataCursor { readonly at: Date; readonly id: string }

/** A file's state on the list. `deleting` is never listed; it reads as failed, as in the file view. */
const FILE_STATES: Readonly<Record<FileStatus, DataState>> = {
  uploading: 'uploading', stored: 'reading', queued: 'reading', reading: 'reading', waiting: 'waiting', read: 'used', kept: 'kept',
  failed: 'failed', deleting: 'failed',
};

function fileState(file: FileRecord): DataState {
  return FILE_STATES[file.status];
}

function uploadItem(upload: UploadRecord, file: FileRecord | null, inUse: number): DataItemRecord {
  const busy = file === null ? null : fileState(file);
  let state: DataState = 'used';
  // A stored file's first write: its upload is still applying while the reader writes days, so it reads as reading.
  if (busy === 'reading' || busy === 'waiting') state = busy;
  else if (upload.status === 'applying') state = 'not_finished';
  return {
    ref: { type: 'upload', id: upload.id },
    locationId: upload.locationId,
    via: upload.source !== null ? 'townwise_ai' : upload.byStaff ? 'staff' : file === null ? 'browser' : 'file',
    kind: file?.kind ?? 'daily_totals',
    addedAt: upload.uploadedAt,
    addedBy: upload.uploadedBy,
    byStaff: upload.byStaff,
    enabled: upload.disabledAt === null,
    state,
    outcome: file?.outcome ?? null,
    days: { count: upload.dayCount, inUse, firstDate: upload.firstDate, lastDate: upload.lastDate },
    upload,
    file,
  };
}

function fileItem(file: FileRecord): DataItemRecord {
  return {
    ref: { type: 'file', id: file.id },
    locationId: file.locationId,
    via: file.addedVia === 'townwise_ai' ? 'townwise_ai' : 'file',
    kind: file.kind,
    addedAt: file.uploadedAt,
    addedBy: file.uploadedBy,
    // D25: a file staff stored, or text they kept, while open as admin.
    byStaff: file.byStaff,
    enabled: file.disabledAt === null,
    state: fileState(file),
    outcome: file.outcome,
    days: null,
    upload: null,
    file,
  };
}

/** The uploads' records, each with its stored file (only while files are on) and the days it still holds. */
async function withUploads(ctx: TownwiseContext, scope: OrgScope, uploads: readonly UploadRecord[]): Promise<DataItemRecord[]> {
  const ids = uploads.map((upload) => upload.id);
  const [files, owned] = await Promise.all([
    ctx.files === null ? [] : ctx.stores.files.byUploadIds(scope, ids),
    ctx.stores.salesDays.ownedDayCounts(scope, ids),
  ]);
  // Newest first, so an upload with more than one file (none is written today) takes the newest.
  const fileOf = new Map<string, FileRecord>();
  for (const file of files) if (file.uploadId !== null && !fileOf.has(file.uploadId)) fileOf.set(file.uploadId, file);
  return uploads.map((upload) => uploadItem(upload, fileOf.get(upload.id) ?? null, owned.get(upload.id) ?? 0));
}

/** Newest first by (time, id): negative when `a` comes before `b`. */
function newestFirst(a: { at: Date; id: string }, b: { at: Date; id: string }): number {
  const byTime = b.at.getTime() - a.at.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * A page of the location's items (or the organization's, for null), newest first, after `after`. Each source gives
 * `limit + 1` rows before the cursor; the merge takes `limit`, and `next` is the last one's position when any was
 * left. Stored files are left out while they are off.
 */
export async function listDataItems(
  ctx: TownwiseContext, scope: OrgScope, input: { locationId: string | null; viewerId: string; after: DataCursor | null; limit: number },
): Promise<{ items: DataItemRecord[]; next: DataCursor | null }> {
  const [uploads, files] = await Promise.all([
    ctx.stores.uploads.page(scope, { locationId: input.locationId, before: input.after, limit: input.limit + 1 }),
    ctx.files === null
      ? []
      : ctx.stores.files.page(scope, { locationId: input.locationId, viewerId: input.viewerId, before: input.after, limit: input.limit + 1 }),
  ]);
  const merged = [
    ...uploads.map((upload) => ({ at: upload.uploadedAt, id: upload.id, upload, file: null })),
    ...files.map((file) => ({ at: file.uploadedAt, id: file.id, upload: null, file })),
  ].sort(newestFirst);
  const taken = merged.slice(0, input.limit);
  const last = taken.at(-1);
  const next = merged.length > input.limit && last !== undefined ? { at: last.at, id: last.id } : null;
  const uploadItems = new Map((await withUploads(ctx, scope, taken.flatMap((row) => (row.upload === null ? [] : [row.upload]))))
    .map((item) => [item.ref.id, item]));
  const items = taken.flatMap((row) => {
    if (row.file !== null) return [fileItem(row.file)];
    const item = uploadItems.get(row.id);
    return item === undefined ? [] : [item];
  });
  return { items, next };
}

/**
 * One item of the location by its ref, as the list shows it, or null: an unknown id, another location's or
 * organization's, a stored file that wrote days (its upload is the item), a file being deleted, someone else's
 * unfinished upload, and every stored file while files are off.
 */
export async function loadDataItem(
  ctx: TownwiseContext, scope: OrgScope, locationId: string, ref: DataItemRef, viewerId: string,
): Promise<DataItemRecord | null> {
  if (ref.type === 'upload') {
    const upload = await ctx.stores.uploads.get(scope, locationId, ref.id);
    return upload === null ? null : (await withUploads(ctx, scope, [upload]))[0] ?? null;
  }
  if (ctx.files === null) return null;
  const file = await ctx.stores.files.get(scope, locationId, ref.id);
  if (file === null || file.status === 'deleting' || file.uploadId !== null) return null;
  if (file.status === 'uploading' && file.uploadedBy !== viewerId) return null;
  return fileItem(file);
}

/**
 * Whether TownwiseAI may read the item's text (design calls 6 and 8): a text item kept for reference, turned on, with
 * its original still stored, while stored files are on. Never a sales file.
 */
export function readableByTownwiseAi(item: DataItemRecord, filesOn: boolean): boolean {
  const file = item.file;
  return filesOn && item.ref.type === 'file' && file !== null && file.purpose === 'reference' && file.kind === 'text'
    && item.state === 'kept' && item.enabled && file.rawDeletedAt === null;
}
