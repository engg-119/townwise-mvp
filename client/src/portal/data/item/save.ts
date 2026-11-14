import type { ApiClient } from '../../../api/client';
import type { FileView } from '../../files/api';
import { createUploadQueue } from '../../files/uploadQueue';
import { replaceItem, type DataItem } from '../api';
import { copyName } from './copy';

// Saving an edit on an item's page (P27, D28), as plain functions the page and its tests call. The bytes go up as a
// new reference file through the stored-files upload queue (files/uploadQueue.ts createUploadQueue, as Add a file
// does), so an edit gets the same create, chunks, complete, retries with backoff, Retry-After pauses and refusal codes
// as any upload. Text and CSV then take the item's place (POST .../replace), which is retry-safe with the same file
// id; a workbook stays a copy beside the original. A save the person leaves keeps running: what it stored stays on
// Your data either way.

export type SaveResult =
  /** Done: show `ref`, the edited item (its ref changed) or the copy. */
  | { at: 'saved'; ref: string }
  /** Nothing changed: the upload was refused or failed. `code` is the queue's (files/copy.ts uploadError). */
  | { at: 'not_stored'; code: string; detail: Readonly<Record<string, unknown>> | null }
  /** The edit is stored as its own item, `f_<fileId>`, but didn't take the item's place; replaceStored may finish it. */
  | { at: 'not_replaced'; fileId: string; error: unknown };

type Stored = { ok: true; file: FileView } | { ok: false; code: string; detail: Readonly<Record<string, unknown>> | null };

/** The item an edit saves over: its name is the stored file's (never null where an edit is offered). */
export type EditTarget = Pick<DataItem, 'locationId' | 'ref'> & { name: string };

/** `bytes` stored as a reference file named `name` at the location, through one upload queue that ends with it. */
export function storeFile(api: ApiClient, locationId: string, name: string, bytes: Uint8Array): Promise<Stored> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  return new Promise((resolve) => {
    let settled = false;
    const queue = createUploadQueue({
      api,
      locationId,
      purpose: 'reference',
      onChange: (snapshot) => {
        const upload = snapshot.items[0];
        if (settled || upload === undefined) return;
        if (upload.state === 'done' && upload.file !== null) {
          settled = true;
          queue.dispose();
          resolve({ ok: true, file: upload.file });
        } else if (upload.state === 'refused' || upload.state === 'failed' || upload.state === 'cancelled') {
          settled = true;
          queue.dispose();
          resolve({ ok: false, code: upload.error?.code ?? 'internal', detail: upload.error?.detail ?? null });
        }
      },
    });
    queue.add([{ name, size: blob.size, slice: (start, end) => blob.slice(start, end) }]);
  });
}

/** Puts a stored edit in the item's place; again with the same `fileId` after a failure, which the API allows. */
export async function replaceStored(api: ApiClient, item: EditTarget, fileId: string): Promise<SaveResult> {
  try {
    const replaced = await replaceItem(api, item.locationId, item.ref, fileId);
    return { at: 'saved', ref: replaced.ref };
  } catch (error) {
    return { at: 'not_replaced', fileId, error };
  }
}

/** Text or a CSV: stored under the item's own name, then put in its place. */
export async function saveInPlace(api: ApiClient, item: EditTarget, bytes: Uint8Array): Promise<SaveResult> {
  const stored = await storeFile(api, item.locationId, item.name, bytes);
  if (!stored.ok) return { at: 'not_stored', code: stored.code, detail: stored.detail };
  return replaceStored(api, item, stored.file.id);
}

/** A workbook: stored as “<name> (edited).xlsx”, a new item beside the original, which stays as it was. */
export async function saveAsCopy(api: ApiClient, item: EditTarget, bytes: Uint8Array): Promise<SaveResult> {
  const stored = await storeFile(api, item.locationId, copyName(item.name), bytes);
  return stored.ok ? { at: 'saved', ref: `f_${stored.file.id}` } : { at: 'not_stored', code: stored.code, detail: stored.detail };
}
