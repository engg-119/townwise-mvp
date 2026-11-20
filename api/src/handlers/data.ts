// Your data (D28): the list of everything a location (or the organization) received, one item of it, turning an upload
// or a reference item off and on, renaming one, saving an edit of one, letting TownwiseAI read one and undoing what that
// read made (spec 11A.9, D34), and deleting one. Every location and item from another
// organization answers 404 exactly like an unknown one, because each is loaded through the caller's OrgScope. Names
// travel only in JSON bodies and never reach a log line or an audit event: those carry ids, kinds and counts. Stored
// files are reached through handlers/files.ts.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { wantRefitFor } from '../agent/refit.ts';
import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import { folderOf, isUnimportedCalendarFile, type DataFolder } from '../data/folders.ts';
import {
  DATA_PAGE, listDataItems, loadDataItem, parseRef, refString, type DataCursor, type DataItemRecord, type DataState, type DataVia,
} from '../data/library.ts';
import type { FileBlobs } from '../files/blobs.ts';
import { RETRYABLE_IMPORTS, runCalendarImport } from '../files/calendar-import.ts';
import { renamedItemName, replaceClaimLive, replaceClaimStaleBefore, TEXT_ITEM_TITLE_MAX } from '../files/items.ts';
import { AI_READS_IN_FLIGHT } from '../files/limits.ts';
import { currentEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import type {
  AiActionsOutcome, AiCalibration, AiDaysReason, AiEventEffect, AiEventKind, AiFileKind, AiItemReason, AiReadStatus, CalendarImportCode,
  FileKind, FileRecord, FileStatus,
} from '../stores/files.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord } from '../stores/notes.ts';
import type { CalendarKind, CalendarStatus, OwnerCalendarRecord } from '../stores/owner-calendars.ts';
import { fileView, isUploaderOrAdmin, removeWholeFile } from './files.ts';
import { loadLocation, memberOf } from './locations.ts';
import { calendarOfFile, shownView } from './owner-calendars.ts';
import { finishAccepted, finishAcceptedNote } from './rule-suggestions.ts';
import { filesUnavailable } from './sales.ts';
import { actorOf } from './team.ts';

/** One item as the client sees it. */
export interface DataItemView {
  ref: string; locationId: string; via: DataVia; kind: 'daily_totals' | FileKind;
  /** The stored file's name; null for daily totals and under view-as. */
  name: string | null;
  /** The person's current email, “Townwise staff” or “Deleted person”. */
  addedAt: string; addedByEmail: string;
  /** Null for daily totals: no file is kept. */
  sizeBytes: number | null;
  enabled: boolean; state: DataState; outcome: string | null;
  days: { count: number; inUse: number; firstDate: string; lastDate: string } | null;
  file: null | {
    id: string; hasClean: boolean; rawAvailable: boolean; rawExpiresAt: string | null;
    entries: { total: number; used: number; kept: number } | null;
    canDownloadRaw: boolean; canDownloadClean: boolean; canDeleteRaw: boolean;
  };
  /** Not in view-as; the person who added it or an org admin (only an org admin for a staff upload); not busy; uploads and reference items only. */
  canTurnOff: boolean;
  /** Not in view-as; an upload: org admins; a file with no days: the person who added it or an org admin. */
  canDelete: boolean;
  /**
   * Not in view-as; stored files on; a reference item kept with its original stored and no edit being saved (no claim,
   * or a stale one: REPLACE_CLAIM_MS); the people who may turn it off. Saving an edit (POST .../replace) and renaming
   * (PATCH `{ title }`) take these rules.
   */
  canEdit: boolean;
  /** When an edit last replaced the item's content, and who saved it (as `addedByEmail`); both null if never. */
  editedAt: string | null; editedByEmail: string | null;
  /**
   * Spec 11A.9: not in view-as; stored files and reading with TownwiseAI on; a stored file (the item's, or the one an
   * upload was read from) finished (read, kept or failed) with its original; the people who may turn it off; and no
   * read yet, or a failed, skipped or undone one. POST .../ai takes these rules.
   */
  canAiRead: boolean;
  /** Reading with TownwiseAI, null when nobody asked (or the item has no stored file). */
  ai: DataItemAiView | null;
  /**
   * Spec 11A.9: on an upload or a summary item a TownwiseAI read made, the ref of the item it was read from (`f_<id>`,
   * or `u_<id>` for a file that wrote days of its own); null for anything else, once that file is gone, and while
   * stored files are off.
   */
  fromAiRead: string | null;
  /**
   * D60: on one item's view only (GET .../data/:ref and POST .../data/:ref/calendar), never the list's, what importing
   * the stored file (`f_`) as a calendar did: `added` while its calendar exists (its id, label and event count);
   * `removed` once that calendar was removed (the file stays, and is never imported again); `refused` with the code and
   * whether a retry may mend it (`retry`: the location had 5 calendars, or the original couldn't be read, and the
   * original is still stored); null for any other item, and while stored files are off.
   */
  calendar?: DataItemCalendarView | null;
  /** D61: the Your data folder the item is in (data/folders.ts), from what Townwise knows of it, never its name. */
  folder: DataFolder;
}

/**
 * D61: one of the list's calendars, an item of Your data's Calendars folder: never its address, and to staff a Google
 * calendar is "Google calendar" (as Your calendars shows it). It opens at the client's `c_<id>` item page.
 */
export interface DataCalendarView {
  id: string; locationId: string; label: string; kind: CalendarKind;
  /** A link's host (`calendar.google.com`); null for a file or a Google calendar. */
  host: string | null;
  eventCount: number; skippedRepeating: number; status: CalendarStatus; lastSuccessAt: string | null; createdAt: string;
}

/** What importing a calendar file kept in Your data did (DataItemView.calendar, D60). */
export type DataItemCalendarView =
  | { status: 'added'; calendarId: string; label: string; eventCount: number }
  | { status: 'removed' }
  | { status: 'refused'; reason: CalendarImportCode; retry: boolean };

/**
 * A read's state and, once done, what TownwiseAI found and what it made (spec 11A.9). `kind`, `summary`, `facts` and
 * `daysCut` (the file had daily totals for more than the 1,500 dates read) only once it is done; under view-as
 * `summary`, `facts` and the notes' titles are null (they may describe private data), and once the original is deleted
 * the summary is empty, the facts none and the titles null. What the read made, once recorded: `notes` it created that
 * still exist (each note's id and dates as they are now, and the title of the event it was made from), `notesSkipped`
 * (the events it made no note of, by why: `guard` for the closed-note guard), `daysWritten` (the days its upload held
 * once written), `daysAlreadyHad` (verified days left out because the location had them), `uploadRef` and `itemRef`
 * (its upload and summary item, while they exist), `daysReason` and `itemReason` (why it wrote no days or kept no
 * summary item, as codes), and `calibration` (the model update's status, and the calibration's id when one started);
 * `[]`, null, 0, 0, null, null, null, null and null before that and once undone. `canUndo`: the read ended (done,
 * failed or skipped) after its actions began, and made something or stopped before saying what (DELETE .../ai), and the
 * caller asked for it or is an org admin, not under view-as. D46: `rulesSuggested`, the suggested closure rules the read
 * stored, and `rulesWaiting`, those still open (what an undo removes); 0 and 0 before that and once undone.
 */
export interface DataItemAiView {
  status: AiReadStatus;
  reason: string | null;
  partial: boolean;
  kind: AiFileKind | null;
  summary: string | null;
  facts: string[] | null;
  daysCut: boolean;
  notes: { id: string; title: string | null; startDate: string; endDate: string }[];
  notesSkipped: AiActionsOutcome['notesSkipped'] | null;
  daysWritten: number;
  daysAlreadyHad: number;
  uploadRef: string | null;
  itemRef: string | null;
  daysReason: AiDaysReason | null;
  itemReason: AiItemReason | null;
  calibration: AiCalibration | null;
  canUndo: boolean;
  rulesSuggested: number;
  rulesWaiting: number;
  /**
   * D49: on one item's view only (GET .../data/:ref), never the list's, the events the read found, in its order, as it
   * read them; `noteId` is the note the read made from the event while that note exists, else null; `title` is null
   * under view-as; [] before the read is done and once the original is deleted.
   */
  events?: DataItemAiEvent[];
}

/** An event a read found (DataItemAiView.events). */
export interface DataItemAiEvent {
  title: string | null; startDate: string; endDate: string; kind: AiEventKind; effect: AiEventEffect; expectedGuests: number | null;
  noteId: string | null;
}

/**
 * What the views of a page of items read beyond the items (spec 11A.9): the notes, uploads and summary items TownwiseAI
 * reads made that still exist, and, by file id, the ref of each item an upload or summary item was read from.
 */
interface AiLinks {
  readonly notes: ReadonlyMap<string, NoteRecord>;
  readonly uploads: ReadonlySet<string>;
  readonly items: ReadonlySet<string>;
  readonly sources: ReadonlyMap<string, string>;
  /** D46: by file id, how many suggested closure rules its read stored are still open. */
  readonly waiting: ReadonlyMap<string, number>;
}

/** Who added an item and who last edited it, each as the list names them. */
interface ItemEmails { readonly added: string; readonly edited: string | null }

/** Townwise still has the item: it cannot be turned off until it is done. */
const BUSY: readonly DataState[] = ['uploading', 'reading', 'waiting'];

/** A stored file TownwiseAI may be asked to read: nothing else is still reading or writing it. */
const FINISHED: readonly FileStatus[] = ['read', 'kept', 'failed'];

/** Reads that may be asked for again. */
const ASK_AGAIN: readonly AiReadStatus[] = ['failed', 'skipped', 'undone'];

/** The most time between storing a file and saving it as an edit (POST .../replace). */
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

function invalidRequest(): AppError {
  return new AppError(400, 'invalid_request', 'Invalid request');
}

function itemChanged(): AppError {
  return new AppError(409, 'item_changed', 'Someone saved another edit of this item; open it again to see it');
}

/** A rename while an edit of the item is being saved: the edit would put a file with its own name in its place. */
function editBeingSaved(): AppError {
  return new AppError(409, 'item_busy', 'An edit of this item is being saved; try again in a moment');
}

/** The person who added it or an org admin; only an org admin for a Townwise staff upload. */
function mayManage(member: MemberPrincipal, item: DataItemRecord): boolean {
  if (member.role === 'org_admin') return true;
  return !item.byStaff && member.userId === item.addedBy;
}

/** Uploads, and stored files kept for reference: a sales file that wrote no days has nothing to leave out. */
function turnable(item: DataItemRecord): boolean {
  return item.ref.type === 'upload' || item.file?.purpose === 'reference';
}

/** A reference item kept with its original stored, with no edit being saved at `now`, while stored files are on. */
function editable(item: DataItemRecord, filesOn: boolean, now: Date): boolean {
  const file = item.file;
  return filesOn && item.ref.type === 'file' && file !== null && file.purpose === 'reference' && item.state === 'kept'
    && file.rawDeletedAt === null && !replaceClaimLive(file, now);
}

/**
 * The file of an item being renamed or edited: 403 forbidden for anyone who may not turn it off, 400 for an upload or a
 * sales file, 409 item_busy while it is not kept, and 400 once its original is deleted (its content is gone).
 */
function editableFile(member: MemberPrincipal, item: DataItemRecord): FileRecord {
  if (!mayManage(member, item)) throw new AppError(403, 'forbidden', 'Only the person who added it or an org admin can do that');
  const file = item.file;
  if (item.ref.type !== 'file' || file?.purpose !== 'reference') {
    throw new AppError(400, 'invalid_request', 'Only items kept for reference can be renamed or edited');
  }
  if (item.state !== 'kept') throw new AppError(409, 'item_busy', 'Townwise is still using this item; try again when it is done');
  if (file.rawDeletedAt !== null) throw new AppError(400, 'invalid_request', 'This item’s original was deleted');
  return file;
}

/** A file item's last edit: who saved it (null for Townwise staff, D25), or null if it was never edited. */
function editOf(item: DataItemRecord): { by: string | null } | null {
  const by = item.ref.type === 'file' ? item.file?.editedBy ?? null : null;
  if (by === null) return null;
  return { by: item.file?.editedByStaff === true ? null : by };
}

/** Whether the caller may ask TownwiseAI to read the item's stored file now (DataItemView.canAiRead). */
function aiReadable(member: MemberPrincipal, item: DataItemRecord, file: FileRecord | null, aiOn: boolean): boolean {
  return member.viewAs === null && aiOn && file !== null && file.rawDeletedAt === null && FINISHED.includes(file.status)
    && mayManage(member, item) && (file.ai === null || ASK_AGAIN.includes(file.ai.status));
}

/** The person who asked for the read, or an org admin, outside view-as. */
function mayUndo(member: MemberPrincipal, file: FileRecord): boolean {
  return member.viewAs === null && (member.role === 'org_admin' || member.userId === file.ai?.requestedBy);
}

/** Reads that ended, and whose actions (when they began) may be undone. */
const ENDED: readonly AiReadStatus[] = ['done', 'failed', 'skipped'];

/**
 * A read that ended (done, failed or skipped) after its actions began (a plan was saved), and whose outcome made a
 * note, an upload or a summary item, or was never recorded (it stopped part way, so it may have written some).
 */
function undoable(file: FileRecord): boolean {
  const ai = file.ai;
  if (ai === null || !ENDED.includes(ai.status) || ai.actions === null) return false;
  const { outcome } = ai.actions;
  return outcome === null || outcome.notes.length > 0 || outcome.uploadId !== null || outcome.itemId !== null
    || (outcome.rulesSuggested?.length ?? 0) > 0;
}

function aiView(member: MemberPrincipal, file: FileRecord | null, links: AiLinks, withEvents: boolean): DataItemAiView | null {
  const ai = file?.ai ?? null;
  if (file === null || ai === null) return null;
  const result = ai.status === 'done' ? ai.result : null;
  const hidden = member.viewAs !== null;
  const actions = ai.status === 'done' ? ai.actions : null;
  const outcome = actions?.outcome ?? null;
  const notes = (outcome?.notes ?? []).flatMap((id) => {
    const note = links.notes.get(id);
    if (note === undefined) return [];
    // The title of the event the note was made from: the plan's ids follow the answer's events.
    const title = hidden ? null : result?.events[actions?.plan.noteIds.indexOf(id) ?? -1]?.title ?? null;
    return [{ id, title, startDate: note.startDate, endDate: note.endDate }];
  });
  const uploadId = outcome?.uploadId ?? null;
  const itemId = outcome?.itemId ?? null;
  const events = !withEvents ? {} : {
    events: (result?.events ?? []).map((event, index): DataItemAiEvent => {
      const noteId = actions?.plan.noteIds[index];
      return {
        title: hidden ? null : event.title, startDate: event.startDate, endDate: event.endDate, kind: event.kind, effect: event.effect,
        expectedGuests: event.expectedGuests, noteId: noteId !== undefined && links.notes.has(noteId) ? noteId : null,
      };
    }),
  };
  return {
    status: ai.status,
    reason: ai.reason,
    partial: ai.partial,
    kind: result?.kind ?? null,
    summary: result === null || hidden ? null : result.summary,
    facts: result === null || hidden ? null : [...result.facts],
    daysCut: result?.daysCut ?? false,
    notes,
    notesSkipped: outcome === null ? null : { ...outcome.notesSkipped },
    daysWritten: outcome?.daysWritten ?? 0,
    daysAlreadyHad: outcome?.daysAlreadyHad ?? 0,
    uploadRef: uploadId !== null && links.uploads.has(uploadId) ? `u_${uploadId}` : null,
    itemRef: itemId !== null && links.items.has(itemId) ? `f_${itemId}` : null,
    daysReason: outcome?.daysReason ?? null,
    itemReason: outcome?.itemReason ?? null,
    calibration: outcome === null ? null : { ...outcome.calibration },
    canUndo: undoable(file) && mayUndo(member, file),
    rulesSuggested: outcome?.rulesSuggested?.length ?? 0,
    rulesWaiting: outcome === null ? 0 : links.waiting.get(file.id) ?? 0,
    ...events,
  };
}

/** The file an upload or a summary item was read from by TownwiseAI, or null. */
function aiSourceOf(item: DataItemRecord): string | null {
  return item.upload?.source?.fileId ?? (item.ref.type === 'file' ? item.file?.source?.fileId ?? null : null);
}

/** AiLinks for `items`: one read of notes, one of files, and one of uploads per location whose read wrote one. */
async function aiLinksFor(ctx: TownwiseContext, scope: OrgScope, items: readonly DataItemRecord[]): Promise<AiLinks> {
  const outcomes = ctx.files === null ? [] : items.flatMap((item) => {
    const ai = item.file?.ai;
    const outcome = ai?.status === 'done' ? ai.actions?.outcome ?? null : null;
    return outcome === null || item.file === null ? [] : [{ locationId: item.locationId, fileId: item.file.id, outcome }];
  });
  const uploadIds = new Map<string, string[]>();
  for (const { locationId, outcome } of outcomes) {
    if (outcome.uploadId !== null) uploadIds.set(locationId, [...(uploadIds.get(locationId) ?? []), outcome.uploadId]);
  }
  const sourceIds = items.flatMap((item) => aiSourceOf(item) ?? []);
  const itemIds = outcomes.flatMap(({ outcome }) => outcome.itemId ?? []);
  const [notes, uploads, files, waiting] = await Promise.all([
    ctx.stores.notes.byIds(scope, outcomes.flatMap(({ outcome }) => outcome.notes)),
    Promise.all([...uploadIds].map(([locationId, ids]) => ctx.stores.uploads.byIds(scope, locationId, ids))),
    ctx.files === null || sourceIds.length + itemIds.length === 0 ? [] : ctx.stores.files.byIds(scope, [...new Set([...sourceIds, ...itemIds])]),
    // D46: only a read that suggested rules is looked up.
    Promise.all(outcomes.filter(({ outcome }) => (outcome.rulesSuggested?.length ?? 0) > 0).map(async ({ locationId, fileId }) => (
      [fileId, (await ctx.stores.agentSuggestions.openFromFile(scope, locationId, fileId)).length] as const
    ))),
  ]);
  return {
    waiting: new Map(waiting),
    notes: new Map(notes.map((note) => [note.id, note])),
    uploads: new Set(uploads.flat().map((upload) => upload.id)),
    items: new Set(files.map((file) => file.id)),
    sources: new Map(files.map((file) => [file.id, file.uploadId === null ? `f_${file.id}` : `u_${file.uploadId}`])),
  };
}

function dataItemView(
  member: MemberPrincipal, item: DataItemRecord, emails: ItemEmails, filesOn: boolean, aiOn: boolean, now: Date, links: AiLinks,
  withEvents = false,
): DataItemView {
  const viewAs = member.viewAs !== null;
  const file = filesOn ? item.file : null;
  const shown = file === null ? null : fileView(member, file, emails.added, null);
  const edited = item.ref.type === 'file' ? file?.editedAt ?? null : null;
  return {
    ref: refString(item.ref),
    locationId: item.locationId,
    via: item.via,
    kind: item.kind,
    name: viewAs || file === null ? null : file.name,
    addedAt: item.addedAt.toISOString(),
    addedByEmail: item.byStaff ? TOWNWISE_STAFF : emails.added,
    sizeBytes: file === null ? null : file.sizeBytes,
    enabled: item.enabled,
    state: item.state,
    outcome: item.outcome,
    days: item.days === null ? null : { ...item.days },
    file: shown === null ? null : {
      id: shown.id, hasClean: shown.hasClean, rawAvailable: shown.rawAvailable, rawExpiresAt: shown.rawExpiresAt, entries: shown.entries,
      canDownloadRaw: shown.canDownloadRaw, canDownloadClean: shown.canDownloadClean, canDeleteRaw: shown.canDeleteRaw,
    },
    canTurnOff: !viewAs && mayManage(member, item) && !BUSY.includes(item.state) && turnable(item),
    canDelete: !viewAs && (item.ref.type === 'upload' ? member.role === 'org_admin' : item.file !== null && isUploaderOrAdmin(member, item.file)),
    canEdit: !viewAs && mayManage(member, item) && editable(item, filesOn, now),
    editedAt: edited === null ? null : edited.toISOString(),
    editedByEmail: edited === null ? null : emails.edited,
    canAiRead: aiReadable(member, item, file, aiOn),
    ai: aiView(member, file, links, withEvents),
    fromAiRead: links.sources.get(aiSourceOf(item) ?? '') ?? null,
    folder: folderOf(item),
  };
}

/** Reads the current email of everyone who added or last edited one of `items`, once each; resolves each item's. */
async function emailsFor(ctx: TownwiseContext, items: readonly DataItemRecord[]): Promise<(item: DataItemRecord) => ItemEmails> {
  const ids = [...new Set(items.flatMap((item) => [item.byStaff ? null : item.addedBy, editOf(item)?.by ?? null]))]
    .filter((id): id is string => id !== null);
  const emails = new Map(await Promise.all(ids.map(async (id) => [id, await currentEmail(ctx, id)] as const)));
  const emailOf = (id: string): string => emails.get(id) ?? DELETED_PERSON;
  return (item) => {
    const edit = editOf(item);
    return {
      added: item.byStaff ? TOWNWISE_STAFF : emailOf(item.addedBy),
      edited: edit === null ? null : edit.by === null ? TOWNWISE_STAFF : emailOf(edit.by),
    };
  };
}

async function itemViews(ctx: TownwiseContext, member: MemberPrincipal, items: readonly DataItemRecord[]): Promise<DataItemView[]> {
  const [emails, links] = await Promise.all([emailsFor(ctx, items), aiLinksFor(ctx, member.scope, items)]);
  const now = ctx.now();
  return items.map((item) => dataItemView(member, item, emails(item), ctx.files !== null, ctx.aiReads !== null, now, links));
}

/**
 * One item as the client sees it, with its emails read now (also Keep on a TownwiseAI card, chat-item-proposals.ts);
 * with `events`, its read's events too (DataItemAiView.events, D49); with `calendar`, its calendar import (D60).
 */
export async function itemView(
  ctx: TownwiseContext, member: MemberPrincipal, item: DataItemRecord, opts: { events?: boolean; calendar?: boolean } = {},
): Promise<DataItemView> {
  const [emails, links, calendar] = await Promise.all([
    emailsFor(ctx, [item]), aiLinksFor(ctx, member.scope, [item]), opts.calendar === true ? calendarOf(ctx, member.scope, item) : undefined,
  ]);
  const view = dataItemView(member, item, emails(item), ctx.files !== null, ctx.aiReads !== null, ctx.now(), links, opts.events === true);
  return calendar === undefined ? view : { ...view, calendar };
}

/**
 * A stored file's calendar import (DataItemCalendarView): the calendar that keeps its id says it was added, also when
 * the file's own record was never written; else the file's record says whether it was added once or refused.
 */
async function calendarOf(ctx: TownwiseContext, scope: OrgScope, item: DataItemRecord): Promise<DataItemCalendarView | null> {
  const file = item.file;
  if (ctx.files === null || item.ref.type !== 'file' || file === null) return null;
  const calendar = await calendarOfFile(ctx, scope, item.locationId, file.id);
  if (calendar !== null) return { status: 'added', calendarId: calendar.id, label: calendar.label, eventCount: calendar.eventCount };
  const record = file.calendarImport;
  if (record === null) return null;
  if (record.state === 'added') return { status: 'removed' };
  return { status: 'refused', reason: record.code, retry: RETRYABLE_IMPORTS.has(record.code) && file.rawDeletedAt === null };
}

const listQuery = z.object({ locationId: objectId.optional(), after: z.string().max(64).optional() });

/** `<ISO time>_<24 hex id>`, the time exactly as toISOString writes it. */
function parseCursor(raw: string): DataCursor {
  const match = /^(.+)_([0-9a-f]{24})$/.exec(raw);
  const at = new Date(match?.[1] ?? Number.NaN);
  if (match === null || Number.isNaN(at.getTime()) || at.toISOString() !== match[1]) {
    throw new AppError(400, 'invalid_request', 'Invalid request');
  }
  return { at, id: match[2] ?? '' };
}

/** The calendars of the location, or of every location of the organization for null (D61). */
async function scopeCalendars(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord | null): Promise<OwnerCalendarRecord[]> {
  const ids = location === null ? (await ctx.stores.locations.list(scope)).map((each) => each.id) : [location.id];
  return (await Promise.all(ids.map((id) => ctx.stores.ownerCalendars.list(scope, id)))).flat();
}

function dataCalendarView(calendar: OwnerCalendarRecord, member: MemberPrincipal): DataCalendarView {
  const shown = shownView(calendar, member);
  return {
    id: shown.id, locationId: calendar.locationId, label: shown.label, kind: shown.kind, host: shown.host, eventCount: shown.eventCount,
    skippedRepeating: shown.skippedRepeating, status: shown.status, lastSuccessAt: shown.lastSuccessAt, createdAt: shown.createdAt,
  };
}

/**
 * GET /org/data?locationId=&after=: the location's items (every location's without one), newest first, 100 a page;
 * `next` is the cursor for the page after, or null on the last. D61: `calendars`, the same on every page, are the
 * scope's calendars (oldest first, each location's in turn), each an item of the Calendars folder; a stored file a
 * calendar was imported from (D60) is left out of `items` while that calendar exists, so it shows once, as the
 * calendar (a page may then hold fewer than 100 with more to come). Each item carries its `folder`. D59: `agentAuto`,
 * whether TownwiseAI reads a file added here on its own (TOWNWISE_AGENT_AUTO, TownwiseAI reading files and the
 * organization's switch), so Add a file's box starts checked. A read: it logs nothing and records nothing.
 */
export async function listData(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const query = parseInput(listQuery, req.query);
  const after = query.after === undefined ? null : parseCursor(query.after);
  const location = query.locationId === undefined ? null : await loadLocation(ctx, scope, query.locationId);
  const [page, calendars] = await Promise.all([
    listDataItems(ctx, scope, { locationId: location?.id ?? null, viewerId: member.userId, after, limit: DATA_PAGE }),
    scopeCalendars(ctx, scope, location),
  ]);
  const imported = new Set(calendars.flatMap((calendar) => calendar.fromFileId ?? []));
  const items = page.items.filter((item) => item.ref.type !== 'file' || !imported.has(item.ref.id));
  const agentAuto = ctx.config.agentAuto && ctx.aiReads !== null && (await ctx.stores.orgs.findById(scope.orgId))?.agentAuto.on === true;
  res.status(200).json({
    items: await itemViews(ctx, member, items),
    next: page.next === null ? null : `${page.next.at.toISOString()}_${page.next.id}`,
    calendars: calendars.map((calendar) => dataCalendarView(calendar, member)),
    agentAuto,
  });
}

/**
 * GET /locations/:locationId/data/:ref: one item exactly as the list shows it, plus its read's `ai.events` (D49) (P26's
 * item page). An item the list leaves out answers 404 like an unknown one: every stored file while files are off, a
 * stored file that wrote days (its upload is the item), a file being deleted and someone else's unfinished upload. A
 * read: it logs nothing and records nothing.
 */
export async function getDataItem(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, member.scope, req.params.locationId);
  const item = await loadDataItem(ctx, member.scope, location.id, ref, member.userId);
  if (item === null) throw notFound();
  res.status(200).json({ item: await itemView(ctx, member, item, { events: true, calendar: true }) });
}

/**
 * POST /locations/:locationId/data/:ref/calendar {}: imports a calendar file kept in Your data again (D60), after its
 * import was refused for a cause a retry may mend (`calendar.retry`: the location had 5 calendars, or its original
 * couldn't be read), or (UI review 2026-11-19, Import as a calendar) for the first time, a calendar file kept before
 * D60 with no import record while its original is kept. Any member, as Your calendars' import; never under view-as (the
 * chain refuses it). In order: 400 for the body and the ref, 404 for another organization's or an unknown location or
 * item, 503 files_unavailable while stored files are off, and 400 invalid_request for an item that is no calendar file
 * (an old one whose original was deleted included). 200 with the item and its
 * `calendar` as they are after it: a retry refused again says so there, and an item already added, removed or refused
 * for good is answered as it is, so a double press is harmless and never imports a file twice.
 */
export async function retryDataCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  parseInput(z.strictObject({}), req.body);
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const blobs = ctx.files;
  if (blobs === null) throw filesUnavailable();
  const item = await loadDataItem(ctx, scope, location.id, ref, member.userId);
  if (item === null) throw notFound();
  const calendar = await calendarOf(ctx, scope, item);
  const file = item.file;
  // UI review 2026-11-19: a calendar file kept before D60 (no record, no calendar) is imported here once, while its
  // original is kept; the calendar's unique index on the file's id still holds two presses at once to one calendar.
  const unimported = calendar === null && file !== null && item.ref.type === 'file' && file.purpose === 'reference'
    && file.status === 'kept' && file.rawDeletedAt === null && isUnimportedCalendarFile(file);
  if (file === null || (calendar === null && !unimported)) throw invalidRequest();
  let shown = item;
  if (unimported || (calendar?.status === 'refused' && calendar.retry)) {
    shown = { ...item, file: { ...file, calendarImport: await runCalendarImport(ctx, blobs, member, location, file) } };
  }
  res.status(200).json({ item: await itemView(ctx, member, shown, { calendar: true }) });
}

/** The location, then the item by its ref; a stored file answers 503 files_unavailable while files are off. */
async function loadItem(ctx: TownwiseContext, member: MemberPrincipal, req: Request): Promise<{ location: LocationRecord; item: DataItemRecord }> {
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, member.scope, req.params.locationId);
  if (ref.type === 'file' && ctx.files === null) throw filesUnavailable();
  const item = await loadDataItem(ctx, member.scope, location.id, ref, member.userId);
  if (item === null) throw notFound();
  return { location, item };
}

const updateBody = z.union([
  z.strictObject({ enabled: z.boolean() }),
  z.strictObject({ title: z.string().trim().min(1).max(TEXT_ITEM_TITLE_MAX) }),
]);

/**
 * PATCH /locations/:locationId/data/:ref { enabled } or { title }: turns an upload or a reference item off or on, or
 * renames a reference item. Asking for the state or the name it already has changes nothing and records nothing.
 */
export async function updateDataItem(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const body = parseInput(updateBody, req.body);
  const { location, item } = await loadItem(ctx, member, req);
  if ('title' in body) {
    await renameItem(ctx, res, member, location, item, body.title);
    return;
  }
  const { enabled } = body;
  if (!mayManage(member, item)) throw new AppError(403, 'forbidden', 'Only the person who added it or an org admin can do that');
  if (BUSY.includes(item.state)) throw new AppError(409, 'item_busy', 'Townwise is still using this item; try again when it is done');
  if (!turnable(item)) throw new AppError(400, 'invalid_request', 'Only uploads and items kept for reference can be turned off');
  let updated = item;
  if (item.enabled !== enabled) {
    const input = { enabled, by: member.userId, at: ctx.now() };
    if (item.ref.type === 'upload') {
      const upload = await ctx.stores.uploads.setEnabled(scope, location.id, item.ref.id, input);
      if (upload === null) throw notFound();
      updated = { ...item, enabled: upload.disabledAt === null, upload };
    } else {
      const file = await ctx.stores.files.setEnabled(scope, location.id, item.ref.id, input);
      if (file === null) throw notFound();
      updated = { ...item, enabled: file.disabledAt === null, file };
    }
    await recordAfter(ctx, {
      ...actorOf(member), at: input.at, orgId: scope.orgId, action: enabled ? 'data.turned_on' : 'data.turned_off',
      target: { type: item.ref.type, id: item.ref.id }, details: { locationId: location.id, item: item.ref.type, kind: item.kind },
    });
  }
  res.status(200).json({ item: await itemView(ctx, member, updated) });
}

/**
 * PATCH { title }: the reference item's new name is the title as a file name, keeping its extension (files/items.ts).
 * The same name as now changes nothing and records nothing. While an edit of the item is being saved (a live claim) it
 * answers 409 item_busy, since the edit's file keeps its own name. The rename is a compare-and-set on the item still
 * being kept with its original and no live claim, so a purge's label (its kind) is never overwritten and no rename lands
 * while an edit is being saved.
 */
async function renameItem(
  ctx: TownwiseContext, res: Response, member: MemberPrincipal, location: LocationRecord, item: DataItemRecord, title: string,
): Promise<void> {
  const { scope } = member;
  const now = ctx.now();
  const file = editableFile(member, item);
  if (replaceClaimLive(file, now)) throw editBeingSaved();
  const name = renamedItemName(file.name, title);
  if (name === null) throw invalidRequest();
  let updated = item;
  if (name !== file.name) {
    const renamed = await ctx.stores.files.rename(scope, location.id, file.id, name, replaceClaimStaleBefore(now));
    if (renamed === null) {
      // Deleted, its original deleted, or an edit claimed it, meanwhile.
      const again = await loadDataItem(ctx, scope, location.id, item.ref, member.userId);
      if (again !== null && replaceClaimLive(editableFile(member, again), now)) throw editBeingSaved();
      throw notFound();
    }
    updated = { ...item, file: renamed };
    await recordAfter(ctx, {
      ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'data.renamed',
      target: { type: 'file', id: file.id }, details: { locationId: location.id, item: 'file', kind: item.kind },
    });
  }
  res.status(200).json({ item: await itemView(ctx, member, updated) });
}

const replaceBody = z.strictObject({ fileId: objectId });

/**
 * POST /locations/:locationId/data/:ref/replace { fileId }: saves an edit of a reference item (D28). The browser stores
 * the edited content as a new reference file (B) through the chunked upload, then this puts B in the item's place (A).
 * B is the caller's, kept, at the same location, stored in the last 24 hours, and holds no other item's place. With no
 * multi-document transactions (DocumentDB), the order lets a retry finish the work: (1) a compare-and-set claims A for
 * B, so a second edit saved with another file answers 409 item_changed while the first is being saved, and a claim a
 * stopped call left is freed (claimItem); (2) a compare-and-set gives B A's place (who added it, their role, when, how
 * it arrived, its grant, whether it is off) and its edit; (3) A is removed as DELETE /files/:fileId removes a file. A
 * gone whose place B took answers B. Records data.edited, targeting B and naming A in `replaces`.
 */
export async function replaceDataItem(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const { fileId } = parseInput(replaceBody, req.body);
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const blobs = ctx.files;
  if (blobs === null) throw filesUnavailable();
  const item = await loadDataItem(ctx, scope, location.id, ref, member.userId);
  if (item === null) {
    if (ref.type !== 'file') throw notFound();
    await finishIfPlaced(ctx, res, member, blobs, location.id, ref.id, fileId);
    return;
  }
  const a = editableFile(member, item);
  const b = await ctx.stores.files.get(scope, location.id, fileId);
  if (b === null || b.status === 'deleting') throw notFound();
  // A retry after step 2: B already carries A's place, and with it A's uploader and time.
  const placed = b.replaces === a.id;
  if (!placed) {
    const recent = ctx.now().getTime() - b.uploadedAt.getTime() <= EDIT_WINDOW_MS;
    if (b.id === a.id || b.purpose !== 'reference' || b.status !== 'kept' || b.uploadedBy !== member.userId || !recent
      || b.rawDeletedAt !== null || b.replaces !== null || b.replacedBy !== null) {
      throw invalidRequest();
    }
  }
  const claimed = await claimItem(ctx, blobs, scope, location.id, a.id, b.id);
  if (claimed === null) {
    // Removed meanwhile: by another call saving this same edit, once B took its place.
    await finishIfPlaced(ctx, res, member, blobs, location.id, a.id, b.id);
    return;
  }
  if (!placed) {
    const took = await ctx.stores.files.takePlace(scope, location.id, b.id, {
      from: claimed, at: ctx.now(), by: member.userId, byStaff: member.openAsAdmin !== null,
    });
    if (took === null) {
      // B changed meanwhile (deleted, or put in another item's place): A is left as it was.
      await ctx.stores.files.releaseReplace(scope, a.id, b.id);
      const now = await ctx.stores.files.get(scope, location.id, b.id);
      throw now === null || now.status === 'deleting' ? notFound() : invalidRequest();
    }
  }
  await finishReplace(ctx, res, member, blobs, location.id, a.id, b.id);
}

/**
 * Step 1: A claimed for B (`replacedBy`, `replacedAt`), or null once A is gone or going. When another file X holds the
 * claim, it is freed once (freeClaim) and A claimed again; a claim that stays X's answers 409 item_changed.
 */
async function claimItem(
  ctx: TownwiseContext, blobs: FileBlobs, scope: OrgScope, locationId: string, aId: string, bId: string,
): Promise<FileRecord | null> {
  for (let attempt = 1; ; attempt += 1) {
    const claimed = await ctx.stores.files.claimReplace(scope, locationId, aId, bId, ctx.now());
    if (claimed !== null) return claimed;
    const current = await ctx.stores.files.get(scope, locationId, aId);
    if (current === null || current.status === 'deleting') return null;
    const other = current.replacedBy;
    // Its original was deleted meanwhile.
    if (other === null || other === bId) throw invalidRequest();
    if (attempt > 1 || !(await freeClaim(ctx, blobs, scope, current, other))) throw itemChanged();
  }
}

/**
 * Frees A's claim for another file X that a stopped call left; true when it was released. X gone or being deleted can
 * never take A's place, so its claim goes at once; a stale claim (REPLACE_CLAIM_MS) goes while X has not taken A's
 * place. When X took A's place and the stale claim left A behind, A is removed as step 3 removes it, and this edit
 * answers 409 item_changed. A live claim stays (false).
 */
async function freeClaim(ctx: TownwiseContext, blobs: FileBlobs, scope: OrgScope, a: FileRecord, xId: string): Promise<boolean> {
  const x = await ctx.stores.files.get(scope, a.locationId, xId);
  const stale = !replaceClaimLive(a, ctx.now());
  if (x === null || x.status === 'deleting' || (x.replaces !== a.id && stale)) {
    await ctx.stores.files.releaseReplace(scope, a.id, xId);
    return true;
  }
  if (x.replaces === a.id && stale) {
    await removeWholeFile(ctx, blobs, scope, a, { resume: true });
    throw itemChanged();
  }
  return false;
}

/** A replace whose item is gone, or going: B answers once it took A's place (the caller may manage it); else 404. */
async function finishIfPlaced(
  ctx: TownwiseContext, res: Response, member: MemberPrincipal, blobs: FileBlobs, locationId: string, aId: string, bId: string,
): Promise<void> {
  const b = await loadDataItem(ctx, member.scope, locationId, { type: 'file', id: bId }, member.userId);
  if (b?.file?.replaces !== aId) throw notFound();
  if (!mayManage(member, b)) throw new AppError(403, 'forbidden', 'Only the person who added it or an org admin can do that');
  await finishReplace(ctx, res, member, blobs, locationId, aId, bId);
}

/**
 * Step 3 and the answer: A is removed, or its removal finished when one stopped part way (removeFile's `resume`), then
 * B answers as its item. data.edited is recorded when this call found A still there.
 */
async function finishReplace(
  ctx: TownwiseContext, res: Response, member: MemberPrincipal, blobs: FileBlobs, locationId: string, aId: string, bId: string,
): Promise<void> {
  const { scope } = member;
  const left = await ctx.stores.files.get(scope, locationId, aId);
  if (left !== null) await removeWholeFile(ctx, blobs, scope, left, { resume: true });
  const item = await loadDataItem(ctx, scope, locationId, { type: 'file', id: bId }, member.userId);
  if (item === null) throw notFound();
  if (left !== null) {
    await recordAfter(ctx, {
      ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'data.edited',
      target: { type: 'file', id: bId }, details: { locationId, item: 'file', kind: item.kind, replaces: aId },
    });
  }
  res.status(200).json({ item: await itemView(ctx, member, item) });
}

function aiUnavailable(): AppError {
  return new AppError(503, 'ai_unavailable', 'TownwiseAI can’t read files right now');
}

function aiReadRunning(): AppError {
  return new AppError(409, 'ai_read_running', 'TownwiseAI is already reading this file');
}

const aiReadBody = z.strictObject({});

/**
 * POST /locations/:locationId/data/:ref/ai {}: lets TownwiseAI read the item's stored file (spec 11A.9, D34), opted in
 * per file. The ref is a stored file (`f_`) or an upload read from one (`u_`, whose file is read). The person who added
 * it or an org admin (an org admin only, for a Townwise staff upload); never under view-as (the chain refuses it).
 * In order: 400 for the body and the ref, 404 for another organization's or an unknown location or item, 503
 * files_unavailable while stored files are off, 503 ai_unavailable while reading with TownwiseAI is off, 403 for anyone
 * else, 409 ai_read_running while a read is queued or reading, 200 with the item unchanged once a read is done (a double
 * press is harmless), 400 invalid_request for an item with no stored file, one whose original was deleted, or one
 * Townwise is still uploading or reading, and 429 ai_read_queue_full while the organization already has 10 reads queued
 * or reading (a count, then the write: two presses at once can pass it by one). The route's own limiter (30 an hour per
 * account) refuses while its store is down. A compare-and-set queues the read, so of two presses one wins and the other
 * answers as above; then it records file.ai_read_requested (the file's kind, never a name), wakes the reader and answers
 * 202 { item }.
 */
export async function requestAiRead(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  parseInput(aiReadBody, req.body);
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  if (ctx.files === null) throw filesUnavailable();
  const item = await loadDataItem(ctx, scope, location.id, ref, member.userId);
  if (item === null) throw notFound();
  const reads = ctx.aiReads;
  if (reads === null) throw aiUnavailable();
  if (!mayManage(member, item)) throw new AppError(403, 'forbidden', 'Only the person who added it or an org admin can do that');
  const answered = await answerAsIs(ctx, res, member, item);
  if (answered) return;
  const file = item.file;
  if (file === null) throw new AppError(400, 'invalid_request', 'Only a stored file can be read by TownwiseAI');
  if (file.rawDeletedAt !== null) throw new AppError(400, 'invalid_request', 'This file’s original was deleted');
  if (!FINISHED.includes(file.status)) throw new AppError(400, 'invalid_request', 'Townwise is still uploading or reading this file');
  if (await ctx.stores.files.aiReadsInFlight(scope) >= AI_READS_IN_FLIGHT) {
    throw new AppError(429, 'ai_read_queue_full', 'TownwiseAI is already reading 10 of your organization’s files; try again when one is done');
  }
  const at = ctx.now();
  const queued = await ctx.stores.files.requestAiRead(scope, location.id, file.id, {
    by: member.userId, role: member.role, byStaff: member.openAsAdmin !== null, grantId: member.openAsAdmin?.grantId ?? null, at,
  });
  if (queued === null) {
    // Another press won, or the file changed meanwhile: answer as it is now.
    const now = await loadDataItem(ctx, scope, location.id, item.ref, member.userId);
    if (now === null) throw notFound();
    if (await answerAsIs(ctx, res, member, now)) return;
    throw invalidRequest();
  }
  await recordAfter(ctx, {
    ...actorOf(member), at, orgId: scope.orgId, action: 'file.ai_read_requested',
    target: { type: 'file', id: file.id }, details: { locationId: location.id, kind: file.kind },
  });
  reads.nudge();
  res.status(202).json({ item: await itemView(ctx, member, { ...item, file: queued }) });
}

/** A read already asked for: 409 while it runs, the item as it is once done (true); false for anything else. */
async function answerAsIs(ctx: TownwiseContext, res: Response, member: MemberPrincipal, item: DataItemRecord): Promise<boolean> {
  const status = item.file?.ai?.status;
  if (status === 'queued' || status === 'reading') throw aiReadRunning();
  if (status !== 'done') return false;
  res.status(200).json({ item: await itemView(ctx, member, item) });
  return true;
}

function nothingToUndo(): AppError {
  return new AppError(400, 'nothing_to_undo', 'TownwiseAI made nothing from this file to undo');
}

/**
 * DELETE /locations/:locationId/data/:ref/ai: undoes what TownwiseAI made from the item's stored file (spec 11A.9): the
 * notes it made from the file (one the person since edited goes too), its upload with the days that upload still holds
 * (only days it added: a TownwiseAI upload never replaces one) through the upload delete of DELETE .../data/:ref, and
 * its summary item (an edit of it too) through the file removal. A calibration the read started is not undone: it runs
 * on, and its forecast is published only as any is, when staff switch forecasts on; the answer names it in
 * `calibrationKept`. The person who asked for the read or an org admin; never under view-as (the chain refuses it). In
 * order: 400 for the ref, 404 for another organization's or an unknown location or item, 503 files_unavailable while
 * stored files are off, 400 nothing_to_undo for an item with no stored file or no read, 403 for anyone else, 409
 * ai_read_running while the read is queued or reading, 200 with the item unchanged once it is undone (a retry that
 * finds it done records nothing), and 400 nothing_to_undo for a read whose actions never began or that made nothing. A
 * read that failed or was skipped after its actions began (its plan saved, its outcome never recorded) can be undone:
 * whatever it wrote goes. With no multi-document transactions the order lets a retry finish the work: a
 * compare-and-set marks the read `undoing`; the notes, uploads and summary items that carry this file as their source
 * are removed (each step by filter, so it runs twice harmlessly); then a compare-and-set marks it `undone` and clears
 * its actions and its answer, and only the call that does records file.ai_undone (counts of what it removed). Answers
 * 200 { item, calibrationKept }. D46: the read's suggested closure rules still open go one at a time, each by
 * compare-and-set, except one whose rule a confirm already wrote under its id, which is finished as accepted; accepted
 * and dismissed ones stay.
 */
export async function undoAiRead(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const blobs = ctx.files;
  if (blobs === null) throw filesUnavailable();
  const item = await loadDataItem(ctx, scope, location.id, ref, member.userId);
  if (item === null) throw notFound();
  const file = item.file;
  const ai = file?.ai ?? null;
  if (file === null || ai === null) throw nothingToUndo();
  if (member.role !== 'org_admin' && member.userId !== ai.requestedBy) {
    throw new AppError(403, 'forbidden', 'Only the person who asked TownwiseAI to read this file or an org admin can undo it');
  }
  if (ai.status === 'queued' || ai.status === 'reading') throw aiReadRunning();
  if (ai.status === 'undone') {
    res.status(200).json({ item: await itemView(ctx, member, item), calibrationKept: null });
    return;
  }
  if (!ai.undoing && !undoable(file)) throw nothingToUndo();
  const calibration = ai.actions?.outcome?.calibration ?? null;
  const marked = await ctx.stores.files.markAiUndoing(scope, location.id, file.id);
  if (marked === null) {
    // Undone by another call meanwhile, or the file deleted.
    const now = await loadDataItem(ctx, scope, location.id, item.ref, member.userId);
    if (now === null) throw notFound();
    if (now.file?.ai?.status !== 'undone') throw nothingToUndo();
    res.status(200).json({ item: await itemView(ctx, member, now), calibrationKept: null });
    return;
  }
  const notes = await ctx.stores.notes.removeFromAiRead(scope, location.id, file.id);
  let suggestions = 0;
  for (const open of await ctx.stores.agentSuggestions.openFromFile(scope, location.id, file.id)) {
    const rule = await ctx.stores.businessRules.find(scope, location.id, open.id);
    // D59: a note suggestion whose note an accept already wrote under its id is finished as accepted, as a rule is.
    const accepted = open.type === 'note' ? await ctx.stores.notes.find(scope, location.id, open.id) : null;
    if (rule !== null && open.type === 'rule') await finishAccepted(ctx, member, location, open, rule);
    else if (accepted !== null && open.type === 'note') await finishAcceptedNote(ctx, member, location, open);
    else if (await ctx.stores.agentSuggestions.removeOpen(scope, location.id, open.id)) suggestions += 1;
  }
  let days = 0;
  for (const upload of await ctx.stores.uploads.fromAiRead(scope, location.id, file.id)) {
    days += (await removeUpload(ctx, scope, location.id, upload.id)).deletedDays;
  }
  let items = 0;
  for (const summary of await ctx.stores.files.fromAiRead(scope, location.id, file.id)) {
    await removeWholeFile(ctx, blobs, scope, summary, { resume: true });
    ctx.logger.info({ fileId: summary.id }, 'townwise.file_deleted');
    items += 1;
  }
  // D59: the file's changes in TownwiseAI's ledger read as undone, so none of them is ever made again.
  await ctx.stores.agentChanges.markSourceUndone(scope, location.id, { kind: 'file', id: file.id }, { by: member.userId, now: ctx.now() });
  if (notes > 0 || days > 0) await wantRefitFor(ctx, scope, location.id, 'always');
  if (await ctx.stores.files.finishAiUndo(scope, location.id, file.id)) {
    await recordAfter(ctx, {
      ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'file.ai_undone',
      target: { type: 'file', id: file.id }, details: { locationId: location.id, notes, days, items, suggestions },
    });
    ctx.logger.info({ fileId: file.id, notes, days, items, suggestions }, 'townwise.ai_read_undone');
  }
  const after = await loadDataItem(ctx, scope, location.id, item.ref, member.userId);
  if (after === null) throw notFound();
  res.status(200).json({
    item: await itemView(ctx, member, after), calibrationKept: calibration?.status === 'started' ? calibration.id : null,
  });
}

/**
 * One upload removed (D28): the stored files that wrote its days (which need stored files on), then the days it still
 * holds, then its record last, so a retry finds it; days a later upload replaced stay. An upload that never finished
 * may still have had a write in flight: days it landed meanwhile go too. Shared by DELETE .../data/:ref and an undo of
 * a TownwiseAI read (whose upload no stored file wrote).
 */
export async function removeUpload(ctx: TownwiseContext, scope: OrgScope, locationId: string, uploadId: string): Promise<{ deletedDays: number; deletedFiles: number }> {
  // Read whether files are on or not: an upload read from a stored file keeps it, and its blobs, while files are off.
  const files = await ctx.stores.files.byUploadIds(scope, [uploadId]);
  if (files.length > 0) {
    const blobs = ctx.files;
    if (blobs === null) throw filesUnavailable();
    for (const file of files) {
      await removeWholeFile(ctx, blobs, scope, file);
      ctx.logger.info({ fileId: file.id }, 'townwise.file_deleted');
    }
  }
  const removed = await ctx.stores.salesDays.removeForUpload(scope, locationId, uploadId);
  await ctx.stores.uploads.remove(scope, locationId, uploadId);
  const deletedDays = removed + await ctx.stores.salesDays.removeForUpload(scope, locationId, uploadId);
  return { deletedDays, deletedFiles: files.length };
}

/**
 * DELETE /locations/:locationId/data/:ref. An upload (org admins only): its stored file, then the days it still holds,
 * then its record last, so a retry finds it; days a later upload replaced stay. A stored file (the person who added it
 * or an org admin): removed whole, as DELETE /files/:fileId does.
 */
export async function removeDataItem(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const { location, item } = await loadItem(ctx, member, req);
  const blobs = ctx.files;
  if (item.ref.type === 'file') {
    // loadItem answered 503 for a stored file while files are off, and a file item always carries its file.
    const file = item.file;
    if (file === null || blobs === null) throw filesUnavailable();
    if (!isUploaderOrAdmin(member, file)) throw new AppError(403, 'forbidden', 'Only the person who added it or an org admin can do that');
    await removeWholeFile(ctx, blobs, scope, file);
    if (file.status !== 'uploading') {
      await recordAfter(ctx, {
        ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'file.deleted',
        target: { type: 'file', id: file.id }, details: { locationId: location.id, kind: file.kind, reason: 'owner' },
      });
    }
    ctx.logger.info({ fileId: file.id }, 'townwise.file_deleted');
    res.status(200).json({ deletedDays: 0, deletedFiles: 1 });
    return;
  }
  if (member.role !== 'org_admin') throw new AppError(403, 'forbidden', 'Only an org admin can delete an upload');
  const { deletedDays, deletedFiles } = await removeUpload(ctx, scope, location.id, item.ref.id);
  await recordAfter(ctx, {
    ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'sales.upload_deleted',
    target: { type: 'upload', id: item.ref.id }, details: { locationId: location.id, deletedDays, deletedFiles },
  });
  res.status(200).json({ deletedDays, deletedFiles });
}
