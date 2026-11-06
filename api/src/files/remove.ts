// Removing stored files (spec 11A, 10.7): every file of a location when its sales data is deleted, every file of an
// organization when it is deleted, and originals on their own (by the owner, a staff purge, or retention). In bulk,
// imports go first, so no reader claims one meanwhile; then unfinished uploads are discarded (their staged chunks would
// otherwise wait 7 days in Azure), every blob under the prefix is deleted, and the entry lists and rows follow. Each
// step deletes by filter, so a retry completes the work. Results carry counts only.
import type { OrgScope } from '../access/policy.ts';
import type { FileRecord } from '../stores/files.ts';
import type { TownwiseStores } from '../stores/index.ts';
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
export function isBusy(file: FileRecord): boolean {
  return !(['read', 'kept', 'failed'] as const).some((status) => status === file.status);
}

/**
 * Deletes the originals of `files` (spec 11A, 11.2 of the storage contract): each blob, then the name (replaced by the
 * kind's label) and the ZIP entry paths, since either can name a person. The cleaned copy, the report and the days
 * stay. A busy file is skipped; with `flagBusy` (the staff purge) it is flagged so the reader deletes its original as
 * soon as it is done, and the daily sweep catches any the reader missed.
 */
export async function deleteOriginals(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries'>, blobs: FileBlobs, scope: OrgScope, files: readonly FileRecord[],
  input: { now: Date; flagBusy: boolean },
): Promise<DeletedOriginals> {
  let deletedOriginals = 0;
  let skippedBusy = 0;
  for (const file of files) {
    if (file.rawDeletedAt !== null) continue;
    if (isBusy(file)) {
      skippedBusy += 1;
      if (input.flagBusy) await stores.files.flagPurge(scope, file.id);
      continue;
    }
    await deleteOneOriginal(stores, blobs, scope, file, input.now);
    deletedOriginals += 1;
  }
  return { deletedOriginals, skippedBusy };
}

/** One original: the blob (a missing one counts as deleted), then the name and the entry paths. */
export async function deleteOneOriginal(
  stores: Pick<TownwiseStores, 'files' | 'fileEntries'>, blobs: FileBlobs, scope: OrgScope, file: FileRecord, now: Date,
): Promise<void> {
  try {
    await blobs.deleteRaw(scope, { locationId: file.locationId, fileId: file.id });
  } catch (err) {
    if (!(err instanceof BlobMissingError)) throw err;
  }
  await stores.files.rawDeleted(scope, file.id, now, kindLabel(file.kind));
  await stores.fileEntries.clearPaths(scope, file.id);
}
