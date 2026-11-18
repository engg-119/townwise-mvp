import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import type { TownInput } from '../api';
import { calibrationSchema, coverageSchema, locationSummarySchema, type LocationSummary } from '../schemas';

// The location pages' /api calls (spec 10.3 to 10.5), with the shapes checked against api/src/handlers/locations.ts,
// sales.ts and notes.ts. Pages pass usePortal().api, which re-reads GET /api/me on the access errors of spec 4.3.
// `z.object` strips unknown keys.

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}`;
}

/** Month sums run over the days that have a value; null when no day of the month has one (spec 10.4). */
export const salesMonthSchema = z.object({
  month: z.string(),
  dayCount: z.number(),
  guests: z.number().nullable(),
  netSalesCents: z.number().nullable(),
});
export type SalesMonth = z.infer<typeof salesMonthSchema>;

/** Spec 10.1 UploadView. `applying` is an upload that didn't finish (11.4). */
export const uploadSchema = z.object({
  id: z.string(),
  uploadedAt: z.string(),
  uploadedByEmail: z.string(),
  status: z.enum(['applying', 'applied']),
  dayCount: z.number(),
  inserted: z.number(),
  replaced: z.number(),
  kept: z.number(),
  firstDate: z.string(),
  lastDate: z.string(),
});
export type Upload = z.infer<typeof uploadSchema>;

/** GET .../sales: coverage, calibration, month sums (oldest first) and the newest 20 uploads (newest first). */
export const salesSchema = z.object({
  coverage: coverageSchema,
  /** True when no day shows because every upload holding days is turned off (D28). Optional for an API from before it. */
  uploadsOff: z.boolean().optional(),
  calibration: calibrationSchema,
  months: z.array(salesMonthSchema),
  uploads: z.array(uploadSchema),
});
export type Sales = z.infer<typeof salesSchema>;

export const salesDaySchema = z.object({ date: z.string(), guests: z.number().nullable(), netSalesCents: z.number().nullable() });
export type SalesDay = z.infer<typeof salesDaySchema>;

const salesDaysSchema = z.object({ days: z.array(salesDaySchema) });
const deletedSalesSchema = z.object({ deletedDays: z.number(), deletedUploads: z.number() });

export const NOTE_KINDS = ['closure', 'private_event', 'opening', 'other'] as const;
export const NOTE_EFFECTS = ['closed', 'more_guests', 'fewer_guests', 'unknown'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteEffect = (typeof NOTE_EFFECTS)[number];

/**
 * Spec 12 NoteInput: a full replace on PATCH. A buyout (a private event, closed) may carry its party's size in
 * `expectedGuests`. The hours are optional here because a TownwiseAI proposal has none and the API reads a missing
 * pair as all day; the note form always sends both.
 */
export interface NoteInput {
  kind: NoteKind;
  startDate: string;
  endDate: string;
  /** 0 (Sunday) to 6, sorted; null for every day in the range. */
  weekdays: number[] | null;
  effect: NoteEffect;
  expectedGuests: number | null;
  detail: string | null;
  /** Local 'HH:MM', 24-hour, before endTime on the same day; both null (all day), and always null on a closure. */
  startTime?: string | null | undefined;
  endTime?: string | null | undefined;
}

/**
 * POST .../notes's body: a NoteInput and, from Make a note (calendar-event-suggestions), the owner-calendar event the
 * form opened from, by its calendar id and stored uid. The API links the note when it finds that event, else saves it
 * unlinked; never a title.
 */
export interface NewNoteInput extends NoteInput {
  fromEvent?: { calendarId: string; uid: string };
}

/** Spec 12 Note. `canEdit`: the author, or an org admin. */
export const noteSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTE_KINDS),
  startDate: z.string(),
  endDate: z.string(),
  weekdays: z.array(z.number()).nullable(),
  effect: z.enum(NOTE_EFFECTS),
  expectedGuests: z.number().nullable(),
  detail: z.string().nullable(),
  // Optional: an API from before hours sends neither, which reads as all day (read them with `?? null`).
  startTime: z.string().nullish(),
  endTime: z.string().nullish(),
  createdByEmail: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean(),
  /**
   * A note TownwiseAI made from a file someone let it read (D34, 11A.9); undoing that read deletes it, even after an
   * edit. Optional: an API from before it sends none.
   */
  source: z.object({ via: z.literal('ai_file'), fileId: z.string() }).nullish(),
  /**
   * The owner-calendar event the note was made from (Make a note, or an accepted spotted event), with its dates and
   * hours when linked or last followed; no title. Optional: an API from before it sends none.
   */
  fromEvent: z.object({
    calendarId: z.string(), uid: z.string(), startDate: z.string(), endDate: z.string(), startTime: z.string().nullable(),
    endTime: z.string().nullable(), linkedAt: z.string(),
  }).nullish(),
});
export type Note = z.infer<typeof noteSchema>;

const notesSchema = z.object({ notes: z.array(noteSchema) });
const savedNoteSchema = z.object({ note: noteSchema });
const savedLocationSchema = z.object({ location: locationSummarySchema });

export function fetchSales(api: ApiClient, locationId: string): Promise<Sales> {
  return api.json(`${locationPath(locationId)}/sales`, salesSchema);
}

/** Days from `from` to `to`, inclusive, at most 366 days apart (the API's rule), oldest first. */
export async function fetchSalesDays(api: ApiClient, locationId: string, range: { from: string; to: string }): Promise<SalesDay[]> {
  const body = await api.json(`${locationPath(locationId)}/sales/days?from=${range.from}&to=${range.to}`, salesDaysSchema);
  return body.days;
}

/** Org admins: every day and upload record of the location. Notes stay. */
export function deleteSales(api: ApiClient, locationId: string): Promise<{ deletedDays: number; deletedUploads: number }> {
  return api.json(`${locationPath(locationId)}/sales`, deletedSalesSchema, { method: 'DELETE' });
}

/** Sorted by start date. */
export async function fetchNotes(api: ApiClient, locationId: string): Promise<Note[]> {
  const body = await api.json(`${locationPath(locationId)}/notes`, notesSchema);
  return body.notes;
}

export async function createNote(api: ApiClient, locationId: string, input: NewNoteInput): Promise<Note> {
  const body = await api.json(`${locationPath(locationId)}/notes`, savedNoteSchema, { method: 'POST', body: input });
  return body.note;
}

export async function updateNote(api: ApiClient, locationId: string, noteId: string, input: NoteInput): Promise<Note> {
  const body = await api.json(`${locationPath(locationId)}/notes/${encodeURIComponent(noteId)}`, savedNoteSchema, { method: 'PATCH', body: input });
  return body.note;
}

/** 204. */
export async function deleteNote(api: ApiClient, locationId: string, noteId: string): Promise<void> {
  await api.request(`${locationPath(locationId)}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
}

export async function updateLocation(api: ApiClient, locationId: string, input: { name: string; town: TownInput }): Promise<LocationSummary> {
  const body = await api.json(locationPath(locationId), savedLocationSchema, { method: 'PATCH', body: input });
  return body.location;
}

/** 204: the location with all its data (D44); 409 import_running while a file is being read; 503 files_unavailable. */
export async function deleteLocation(api: ApiClient, locationId: string): Promise<void> {
  await api.request(locationPath(locationId), { method: 'DELETE' });
}
