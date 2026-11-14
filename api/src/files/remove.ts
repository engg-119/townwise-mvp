// Removing stored files (spec 11A, 10.7): every file of a location when its sales data is deleted, every file of an
// organization when it is deleted, and originals on their own (by the owner, a staff purge, or retention). In bulk,
// imports go first, so no reader claims one meanwhile; then unfinished uploads are discarded (their staged chunks would
// otherwise wait 7 days in Azure), every blob under the prefix is deleted, and the entry lists and rows follow. Each
// step deletes by filter, so a retry completes the work. Results carry counts only.
import type { OrgScope } from '../access/policy.ts';
import type { FileRecord, FileStatus } from '../stores/files.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { utcDay } from '../dates.ts';
import { BlobMissingError, type FileBlobs } from './blobs.ts';
import { kindLabel } from './sniff.ts';

export interface RemovedFiles {
  readonly deletedFiles: number;
  readonly deletedBlobs: number;
}

/**
 * The stored files of one location (`locationId`), or of the whole organization (null). Resolves `files_unavailable`
 * when rows exist but stored files are off, so blobs are never left behind silently; the caller refuses then.
 */
export async function removeStoredFiles(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries' | 'imports'>, blobs: FileBlobs | null, scope: OrgScope, locationId: string | null,
): Promise<RemovedFiles | 'files_unavailable'> {
  if (!(await stores.files.hasAny(scope, locationId))) {
    if (locationId === null) await stores.imports.removeForOrg(scope);
    else await stores.imports.removeForLocation(scope, locationId);
    return { deletedFiles: 0, deletedBlobs: 0 };
  }
  if (blobs === null) return 'files_unavailable';
  if (locationId === null) await stores.imports.removeForOrg(scope);
  else await stores.imports.removeForLocation(scope, locationId);
  for (const file of await stores.files.uploading(scope, locationId)) {
    try {
      await blobs.discardUpload(scope, { locationId: file.locationId, fileId: file.id });
    } catch (err) {
      if (!(err instanceof BlobMissingError)) throw err;
    }
  }
  const deletedBlobs = await blobs.removePrefix(scope, locationId);
  if (locationId === null) await stores.fileEntries.removeForOrg(scope);
  else await stores.fileEntries.removeForLocation(scope, locationId);
  const deletedFiles = locationId === null ? await stores.files.removeForOrg(scope) : await stores.files.removeForLocation(scope, locationId);
  return { deletedFiles, deletedBlobs };
}

export interface DeletedOriginals {
  readonly deletedOriginals: number;
  readonly skippedBusy: number;
}

/** A file the reader still needs (not yet read, or waiting on a question): its original stays until it is done. */
function isBusy(file: FileRecord): boolean {
  return !(['read', 'kept', 'failed'] as const).some((status) => status === file.status);
}

/** The kept outcome of a file whose original was deleted before Townwise read it (a staff purge, or retention). */
export const RAW_DELETED = 'raw_deleted';

/**
 * Deletes the originals of `files` that Townwise is done with (the owner's "delete originals", spec 11A, 11.2 of the
 * storage contract): each blob, then the name (replaced by the kind's label) and the ZIP entry paths, since either can
 * name a person. The cleaned copy, the report and the days stay. A busy file is skipped and counted.
 */
export async function deleteOriginals(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries'>, blobs: FileBlobs, scope: OrgScope, files: readonly FileRecord[], now: Date,
): Promise<DeletedOriginals> {
  let deletedOriginals = 0;
  let skippedBusy = 0;
  for (const file of files) {
    if (file.rawDeletedAt !== null) continue;
    if (isBusy(file)) {
      skippedBusy += 1;
      continue;
    }
    await deleteOneOriginal(stores, blobs, scope, file, now);
    deletedOriginals += 1;
  }
  return { deletedOriginals, skippedBusy };
}

/**
 * One original that must go whatever the reader still wanted from it (a staff purge for a person's deletion request,
 * or retention). Read, kept or failed: deleted. Not read yet (stored, queued or waiting): kept as `raw_deleted` first,
 * so no reader claims it, with its import's question dropped if it was waiting, then deleted. Uploading or being read:
 * flagged (`purgeRaw`); the reader never reads a flagged file and deletes the original once it is done, and the daily
 * sweep finishes any it missed. Resolves `deleted`, `flagged`, or `gone` (already deleted, or being deleted whole).
 */
export async function purgeOriginal(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries' | 'imports'>, blobs: FileBlobs, scope: OrgScope, file: FileRecord, now: Date,
): Promise<'deleted' | 'flagged' | 'gone'> {
  if (file.rawDeletedAt !== null || file.status === 'deleting') return 'gone';
  if (!isBusy(file)) {
    await deleteOneOriginal(stores, blobs, scope, file, now);
    return 'deleted';
  }
  if (file.status === 'stored' || file.status === 'queued' || file.status === 'waiting') {
    const before = await stores.files.keepUnread(scope, file.id, RAW_DELETED);
    if (before !== null) {
      if (before.status === 'waiting' && before.importId !== null) {
        const record = await stores.imports.get(scope, before.locationId, before.importId);
        if (record?.question?.fileId === file.id) await stores.imports.clearQuestion(scope, record.id, record.question.id);
      }
      await deleteOneOriginal(stores, blobs, scope, before, now);
      return 'deleted';
    }
    // A reader claimed it meanwhile (or it is being deleted): the flag covers the first, and is harmless for the second.
  }
  await stores.files.flagPurge(scope, file.id);
  return 'flagged';
}

/** The staff purge of `files`: each original deleted now, or flagged (counted as `skippedBusy`) until it can be. */
export async function purgeEveryOriginal(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries' | 'imports'>, blobs: FileBlobs, scope: OrgScope, files: readonly FileRecord[], now: Date,
): Promise<DeletedOriginals> {
  let deletedOriginals = 0;
  let skippedBusy = 0;
  for (const file of files) {
    const done = await purgeOriginal(stores, blobs, scope, file, now);
    if (done === 'deleted') deletedOriginals += 1;
    if (done === 'flagged') skippedBusy += 1;
  }
  return { deletedOriginals, skippedBusy };
}

/** A workbook's report sheets, each named by its place ("Sheet 1"): a sheet's own name can name a person. */
export function renamedSheets(file: FileRecord): Record<string, unknown>[] | undefined {
  const sheets = file.report?.sheets;
  if (file.kind !== 'xlsx' || !Array.isArray(sheets)) return undefined;
  return sheets.map((sheet: unknown, index) => ({ ...(sheet as Record<string, unknown>), name: `Sheet ${String(index + 1)}` }));
}

/** One original: the blob (a missing one counts as deleted), then the name, a workbook's sheet names and the entry paths. */
async function deleteOneOriginal(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries'>, blobs: FileBlobs, scope: OrgScope, file: FileRecord, now: Date,
): Promise<void> {
  try {
    await blobs.deleteRaw(scope, { locationId: file.locationId, fileId: file.id });
  } catch (err) {
    if (!(err instanceof BlobMissingError)) throw err;
  }
  await stores.files.rawDeleted(scope, file.id, now, kindLabel(file.kind), renamedSheets(file));
  await stores.fileEntries.clearPaths(scope, file.id);
}

/**
 * One file removed whole: its claim (`deleting`), the blobs (an unfinished upload is discarded and its bytes given back),
 * the entry list, the row, and the import's question and emptiness. No audit. `busy` while the reader has it, or when
 * another call claimed it. With `resume` (D28: the item a replace put another file in place of, handlers/data.ts), a
 * file already `deleting` is claimed again, so a retry finishes a removal that stopped part way; each later step can
 * run twice.
 */
export async function removeFile(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries' | 'imports' | 'uploadDays'>, blobs: FileBlobs, scope: OrgScope, file: FileRecord, now: Date,
  opts: { resume?: boolean } = {},
): Promise<'removed' | 'busy'> {
  if (file.status === 'reading') return 'busy';
  const from: FileStatus[] = ['uploading', 'stored', 'queued', 'waiting', 'read', 'kept', 'failed'];
  const claimed = await stores.files.move(scope, file.id, opts.resume === true ? [...from, 'deleting'] : from, 'deleting');
  if (claimed === null) return 'busy';
  const ref = { locationId: file.locationId, fileId: file.id };
  const missingOk = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof BlobMissingError)) throw err;
    }
  };
  if (file.status === 'uploading') {
    await missingOk(() => blobs.discardUpload(scope, ref));
    const day = utcDay(file.uploadedAt);
    if (day === utcDay(now)) await stores.uploadDays.refund(scope, day, file.sizeBytes, now);
  } else {
    await missingOk(() => blobs.deleteRaw(scope, ref));
    await missingOk(() => blobs.deleteClean(scope, ref));
  }
  await stores.fileEntries.removeForFile(scope, file.id);
  await stores.files.remove(scope, file.id);
  if (file.importId !== null) {
    const record = await stores.imports.get(scope, file.locationId, file.importId);
    if (record !== null && record.question?.fileId === file.id) await stores.imports.clearQuestion(scope, record.id, record.question.id);
    const remaining = await stores.files.inImport(scope, file.importId);
    await stores.imports.removeIfEmptyOpen(scope, file.importId, remaining.length);
  }
  return 'removed';
}
