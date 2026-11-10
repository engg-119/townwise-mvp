import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import { fileViewSchema, FILE_KINDS, type FileView } from '../files/api';

// Your data (D28), with the shapes of api/src/handlers/data.ts: every upload and stored file a location received.
// Items are named by `ref` (`u_<id>` for an upload, `f_<id>` for a stored file that wrote no days). Names travel
// only in JSON bodies, never in a path or query (server-core logs every URL). Pages pass usePortal().api.

export const DATA_VIAS = ['browser', 'file', 'staff', 'townwise_ai'] as const;
export const DATA_STATES = ['uploading', 'reading', 'waiting', 'used', 'kept', 'failed', 'not_finished'] as const;

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
});
export type DataItem = z.infer<typeof dataItemSchema>;

const listSchema = z.object({ items: z.array(dataItemSchema), next: z.string().nullable() });
const itemSchema = z.object({ item: dataItemSchema });
const removedSchema = z.object({ deletedDays: z.number(), deletedFiles: z.number() });
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

/** Turns an upload or an item kept for reference off or on; answers the item as it now is. */
export async function setEnabled(api: ApiClient, locationId: string, ref: string, enabled: boolean): Promise<DataItem> {
  const body = await api.json(itemPath(locationId, ref), itemSchema, { method: 'PATCH', body: { enabled } });
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
