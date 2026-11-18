import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { fileViewSchema, FILE_KINDS, type FileView } from '../files/api';

// Your data (D28), with the shapes of api/src/handlers/data.ts: every upload and stored file a location received.
// Items are named by `ref` (`u_<id>` for an upload, `f_<id>` for a stored file that wrote no days). Names travel
// only in JSON bodies, never in a path or query (server-core logs every URL). Pages pass usePortal().api.

export const DATA_VIAS = ['browser', 'file', 'staff', 'townwise_ai'] as const;
export const DATA_STATES = ['uploading', 'reading', 'waiting', 'used', 'kept', 'failed', 'not_finished'] as const;

/**
 * Reading with TownwiseAI (D34, spec 11A.9): null until someone asks. Every code (status, reasons, kind, the forecast
 * update's status) is read as a string, so a code the server adds later still shows the page's general line for it.
 * `summary`, `facts` and the notes' titles are null under view-as.
 */
export const aiReadSchema = z.object({
  /** queued, reading, done, failed, skipped or undone. */
  status: z.string(),
  /** Why a read failed or was skipped. */
  reason: z.string().nullable(),
  /** The input was cut: TownwiseAI read only the start. */
  partial: z.boolean(),
  /** What TownwiseAI found the file to be, once done: sales, calendar, inventory, menu, staffing or other. */
  kind: z.string().nullable(),
  summary: z.string().nullable(),
  facts: z.array(z.string()).nullable(),
  /** The file has daily totals for more dates than TownwiseAI reads (it read the newest 1,500). */
  daysCut: z.boolean(),
  /** The notes it made that still exist, with their dates as they are now and the title of the event each came from. */
  notes: z.array(z.object({ id: z.string(), title: z.string().nullable(), startDate: z.string(), endDate: z.string() })),
  /** Events it made no note of; `guard`: closed periods past the limits (14 days in a row, 31 in all). */
  notesSkipped: z.object({ guard: z.number() }).nullable(),
  daysWritten: z.number(),
  /** Days it found that the location already had: TownwiseAI only adds days, never changes one. */
  daysAlreadyHad: z.number(),
  /** Its upload of days and its summary item, while they exist. */
  uploadRef: z.string().nullable(),
  itemRef: z.string().nullable(),
  /** Why it wrote no days, or kept no summary item. */
  daysReason: z.string().nullable(),
  itemReason: z.string().nullable(),
  /** The forecast update: started (with the calibration's id), or why not. */
  calibration: z.object({ status: z.string(), id: z.string().nullable() }).nullable(),
  /** The caller may undo it: done and made something, or failed or skipped after it began adding. */
  canUndo: z.boolean(),
  /**
   * D46: the suggested closure rules the read stored, and those still waiting (what an undo removes); 0 from an API
   * before them.
   */
  rulesSuggested: z.number().default(0),
  rulesWaiting: z.number().default(0),
});
export type AiRead = z.infer<typeof aiReadSchema>;

export const dataItemSchema = z.object({
  ref: z.string(),
  locationId: z.string(),
  via: z.enum(DATA_VIAS),
  kind: z.enum(['daily_totals', ...FILE_KINDS]),
  /** The stored file's name; null for daily totals and under view-as. */
  name: z.string().nullable(),
  addedAt: z.string(),
  /** The person's current email, “Townwise staff” or “Deleted person”. */
  addedByEmail: z.string(),
  /** Null for daily totals: no file is kept. */
  sizeBytes: z.number().nullable(),
  enabled: z.boolean(),
  state: z.enum(DATA_STATES),
  /** Read as a string: a code the server adds later still shows the general line for its state. */
  outcome: z.string().nullable(),
  days: z.object({ count: z.number(), inUse: z.number(), firstDate: z.string(), lastDate: z.string() }).nullable(),
  file: z.object({
    id: z.string(),
    hasClean: z.boolean(),
    rawAvailable: z.boolean(),
    rawExpiresAt: z.string().nullable(),
    entries: z.object({ total: z.number(), used: z.number(), kept: z.number() }).nullable(),
    canDownloadRaw: z.boolean(),
    canDownloadClean: z.boolean(),
    canDeleteRaw: z.boolean(),
  }).nullable(),
  canTurnOff: z.boolean(),
  canDelete: z.boolean(),
  /** A reference item kept with its original, stored files on, not under view-as, for the people who may turn it off. */
  canEdit: z.boolean(),
  /** When an edit last replaced the item's content, and who saved it (named as `addedByEmail`); both null if never. */
  editedAt: z.string().nullable(),
  editedByEmail: z.string().nullable(),
  /** The caller may let TownwiseAI read the item's stored file now (POST .../ai): never under view-as. */
  canAiRead: z.boolean(),
  ai: aiReadSchema.nullable(),
  /** On an upload or a summary item a TownwiseAI read made: the ref of the item it was read from. */
  fromAiRead: z.string().nullable(),
});
export type DataItem = z.infer<typeof dataItemSchema>;

const listSchema = z.object({ items: z.array(dataItemSchema), next: z.string().nullable() });
const itemSchema = z.object({ item: dataItemSchema });
const removedSchema = z.object({ deletedDays: z.number(), deletedFiles: z.number() });
const undoneSchema = z.object({ item: dataItemSchema, calibrationKept: z.string().nullable() });
const textSchema = z.object({ file: fileViewSchema });

function itemPath(locationId: string, ref: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/data/${encodeURIComponent(ref)}`;
}

/** Newest first, 100 a page; one location's items, or every location's without `locationId`. `after` is the last page's `next`. */
export function listData(api: ApiClient, opts: { locationId?: string; after?: string }): Promise<{ items: DataItem[]; next: string | null }> {
  const query = new URLSearchParams();
  if (opts.locationId !== undefined) query.set('locationId', opts.locationId);
  if (opts.after !== undefined) query.set('after', opts.after);
  const text = query.toString();
  return api.json(`/api/org/data${text === '' ? '' : `?${text}`}`, listSchema);
}

/** One item, as the list shows it; 404 once it is gone (deleted, or replaced by an edit, which changes its ref). */
export async function getItem(api: ApiClient, locationId: string, ref: string): Promise<DataItem> {
  const body = await api.json(itemPath(locationId, ref), itemSchema);
  return body.item;
}

/** Turns an upload or an item kept for reference off or on; answers the item as it now is. */
export async function setEnabled(api: ApiClient, locationId: string, ref: string, enabled: boolean): Promise<DataItem> {
  const body = await api.json(itemPath(locationId, ref), itemSchema, { method: 'PATCH', body: { enabled } });
  return body.item;
}

/**
 * Renames an item kept for reference: `title` becomes its name, keeping the current extension; the same name changes
 * nothing. 409 item_busy while Townwise is still reading it or an edit of it is being saved; 400 invalid_request for a
 * title that makes no file name, or once its original is deleted.
 */
export async function renameItem(api: ApiClient, locationId: string, ref: string, title: string): Promise<DataItem> {
  const body = await api.json(itemPath(locationId, ref), itemSchema, { method: 'PATCH', body: { title } });
  return body.item;
}

/**
 * Puts a reference file the caller stored in the last 24 hours (`fileId`) in an item's place, keeping who added the
 * item, when and whether it is off; answers the item as it now is, whose ref is `f_<fileId>`. Retry-safe with the
 * same `fileId`; 409 item_changed when another edit took the item's place first.
 */
export async function replaceItem(api: ApiClient, locationId: string, ref: string, fileId: string): Promise<DataItem> {
  const body = await api.json(`${itemPath(locationId, ref)}/replace`, itemSchema, { method: 'POST', body: { fileId } });
  return body.item;
}

/** An upload (org admins): its file and the days it still holds; a stored file: removed whole. */
export function removeItem(api: ApiClient, locationId: string, ref: string): Promise<{ deletedDays: number; deletedFiles: number }> {
  return api.json(itemPath(locationId, ref), removedSchema, { method: 'DELETE' });
}

/** Pasted text kept for reference, as a `.txt` file named from its title. */
export async function addText(api: ApiClient, locationId: string, input: { title: string; text: string }): Promise<FileView> {
  const body = await api.json(`/api/org/locations/${encodeURIComponent(locationId)}/data/text`, textSchema, { method: 'POST', body: input });
  return body.file;
}

/**
 * Lets TownwiseAI read the item's stored file (an `f_` item's, or the file a `u_` upload was read from); answers the item
 * with its read queued (202), or as it is once a read is done. 409 ai_read_running while one is queued or reading; 503
 * ai_unavailable while reading with TownwiseAI is off, files_unavailable while stored files are off; 429 ai_read_queue_full while
 * the organization has 10 reads queued or reading.
 */
export async function readWithAi(api: ApiClient, locationId: string, ref: string): Promise<DataItem> {
  const body = await api.json(`${itemPath(locationId, ref)}/ai`, itemSchema, { method: 'POST', body: {} });
  return body.item;
}

/**
 * Removes what TownwiseAI made from the item's file (its notes, its upload of days, its summary item); a forecast update
 * it started keeps running, named by `calibrationKept`. 400 nothing_to_undo, 409 ai_read_running.
 */
export function undoAiRead(api: ApiClient, locationId: string, ref: string): Promise<{ item: DataItem; calibrationKept: string | null }> {
  return api.json(`${itemPath(locationId, ref)}/ai`, undoneSchema, { method: 'DELETE' });
}
