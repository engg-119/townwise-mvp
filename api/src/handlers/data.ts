// Your data (D28): the list of everything a location (or the organization) received, one item of it, turning an upload
// or a reference item off and on, renaming one, saving an edit of one, and deleting one. Every location and item from another
// organization answers 404 exactly like an unknown one, because each is loaded through the caller's OrgScope. Names
// travel only in JSON bodies and never reach a log line or an audit event: those carry ids, kinds and counts. Stored
// files are reached through handlers/files.ts.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import {
  DATA_PAGE, listDataItems, loadDataItem, parseRef, refString, type DataCursor, type DataItemRecord, type DataState, type DataVia,
} from '../data/library.ts';
import type { FileBlobs } from '../files/blobs.ts';
import { renamedItemName, TEXT_ITEM_TITLE_MAX } from '../files/items.ts';
import { currentEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import type { FileKind, FileRecord } from '../stores/files.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { fileView, isUploaderOrAdmin, removeWholeFile } from './files.ts';
import { loadLocation, memberOf } from './locations.ts';
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
   * Not in view-as; stored files on; a reference item kept with its original stored and no edit being saved; the people
   * who may turn it off. Saving an edit (POST .../replace) takes these rules, and renaming (PATCH `{ title }`) all but
   * the edit being saved.
   */
  canEdit: boolean;
  /** When an edit last replaced the item's content, and who saved it (as `addedByEmail`); both null if never. */
  editedAt: string | null; editedByEmail: string | null;
}

/** Who added an item and who last edited it, each as the list names them. */
interface ItemEmails { readonly added: string; readonly edited: string | null }

/** Townwise still has the item: it cannot be turned off until it is done. */
const BUSY: readonly DataState[] = ['uploading', 'reading', 'waiting'];

/** The most time between storing a file and saving it as an edit (POST .../replace). */
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

function invalidRequest(): AppError {
  return new AppError(400, 'invalid_request', 'Invalid request');
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

/** A reference item kept with its original stored, with no edit being saved, while stored files are on. */
function editable(item: DataItemRecord, filesOn: boolean): boolean {
  const file = item.file;
  return filesOn && item.ref.type === 'file' && file !== null && file.purpose === 'reference' && item.state === 'kept'
    && file.rawDeletedAt === null && file.replacedBy === null;
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

function dataItemView(member: MemberPrincipal, item: DataItemRecord, emails: ItemEmails, filesOn: boolean): DataItemView {
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
    canEdit: !viewAs && mayManage(member, item) && editable(item, filesOn),
    editedAt: edited === null ? null : edited.toISOString(),
    editedByEmail: edited === null ? null : emails.edited,
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
  const emails = await emailsFor(ctx, items);
  return items.map((item) => dataItemView(member, item, emails(item), ctx.files !== null));
}

/** One item as the client sees it, with its emails read now (also Keep on a TownwiseAI card, chat-item-proposals.ts). */
export async function itemView(ctx: TownwiseContext, member: MemberPrincipal, item: DataItemRecord): Promise<DataItemView> {
  return dataItemView(member, item, (await emailsFor(ctx, [item]))(item), ctx.files !== null);
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

/**
 * GET /org/data?locationId=&after=: the location's items (every location's without one), newest first, 100 a page;
 * `next` is the cursor for the page after, or null on the last. A read: it logs nothing and records nothing.
 */
export async function listData(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const query = parseInput(listQuery, req.query);
  const after = query.after === undefined ? null : parseCursor(query.after);
  const location = query.locationId === undefined ? null : await loadLocation(ctx, scope, query.locationId);
  const page = await listDataItems(ctx, scope, { locationId: location?.id ?? null, viewerId: member.userId, after, limit: DATA_PAGE });
  res.status(200).json({
    items: await itemViews(ctx, member, page.items),
    next: page.next === null ? null : `${page.next.at.toISOString()}_${page.next.id}`,
  });
}

/**
 * GET /locations/:locationId/data/:ref: one item exactly as the list shows it (P26's item page). An item the list leaves
 * out answers 404 like an unknown one: every stored file while files are off, a stored file that wrote days (its
 * upload is the item), a file being deleted and someone else's unfinished upload. A read: it logs nothing and records
 * nothing.
 */
export async function getDataItem(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, member.scope, req.params.locationId);
  const item = await loadDataItem(ctx, member.scope, location.id, ref, member.userId);
  if (item === null) throw notFound();
  res.status(200).json({ item: await itemView(ctx, member, item) });
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
 * The same name as now changes nothing and records nothing. The rename is a compare-and-set on the item still being
 * kept with its original, so a purge's label (its kind) is never overwritten.
 */
async function renameItem(
  ctx: TownwiseContext, res: Response, member: MemberPrincipal, location: LocationRecord, item: DataItemRecord, title: string,
): Promise<void> {
  const { scope } = member;
  const file = editableFile(member, item);
  const name = renamedItemName(file.name, title);
  if (name === null) throw invalidRequest();
  let updated = item;
  if (name !== file.name) {
    const renamed = await ctx.stores.files.rename(scope, location.id, file.id, name);
    if (renamed === null) {
      // Deleted, or its original deleted, meanwhile.
      const again = await loadDataItem(ctx, scope, location.id, item.ref, member.userId);
      if (again !== null) editableFile(member, again);
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
 * B, so a second edit saved with another file answers 409 item_changed; (2) a compare-and-set gives B A's place (who
 * added it, their role, when, how it arrived, its grant, whether it is off) and its edit; (3) A is removed as
 * DELETE /files/:fileId removes a file. A gone whose place B took answers B. Records data.edited, targeting B.
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
  const claimed = await ctx.stores.files.claimReplace(scope, location.id, a.id, b.id);
  if (claimed === null) {
    const current = await ctx.stores.files.get(scope, location.id, a.id);
    if (current === null || current.status === 'deleting') {
      // Removed meanwhile: by another call saving this same edit, once B took its place.
      await finishIfPlaced(ctx, res, member, blobs, location.id, a.id, b.id);
      return;
    }
    if (current.replacedBy !== null && current.replacedBy !== b.id) {
      throw new AppError(409, 'item_changed', 'Someone saved another edit of this item; open it again to see it');
    }
    // Its original was deleted meanwhile.
    throw invalidRequest();
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
      target: { type: 'file', id: bId }, details: { locationId, item: 'file', kind: item.kind },
    });
  }
  res.status(200).json({ item: await itemView(ctx, member, item) });
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
  // Read whether files are on or not: an upload read from a stored file keeps it, and its blobs, while files are off.
  const files = await ctx.stores.files.byUploadIds(scope, [item.ref.id]);
  if (files.length > 0) {
    if (blobs === null) throw filesUnavailable();
    for (const file of files) {
      await removeWholeFile(ctx, blobs, scope, file);
      ctx.logger.info({ fileId: file.id }, 'townwise.file_deleted');
    }
  }
  const removed = await ctx.stores.salesDays.removeForUpload(scope, location.id, item.ref.id);
  await ctx.stores.uploads.remove(scope, location.id, item.ref.id);
  // An upload that never finished may still have had a write in flight: days it landed meanwhile go too.
  const deletedDays = removed + await ctx.stores.salesDays.removeForUpload(scope, location.id, item.ref.id);
  await recordAfter(ctx, {
    ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'sales.upload_deleted',
    target: { type: 'upload', id: item.ref.id }, details: { locationId: location.id, deletedDays, deletedFiles: files.length },
  });
  res.status(200).json({ deletedDays, deletedFiles: files.length });
}
