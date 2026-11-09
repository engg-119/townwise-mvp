// Your data (D28): the list of everything a location (or the organization) received, turning an upload or a reference
// item off and on, and deleting one. Every location and item from another organization answers 404 exactly like an
// unknown one, because each is loaded through the caller's OrgScope. Names travel only in JSON bodies and never reach a
// log line or an audit event: those carry ids, kinds and counts. Stored files are reached through handlers/files.ts.
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
import { currentEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import type { FileKind } from '../stores/files.ts';
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
}

/** Townwise still has the item: it cannot be turned off until it is done. */
const BUSY: readonly DataState[] = ['uploading', 'reading', 'waiting'];

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
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

export function dataItemView(member: MemberPrincipal, item: DataItemRecord, email: string, filesOn: boolean): DataItemView {
  const viewAs = member.viewAs !== null;
  const file = filesOn ? item.file : null;
  const shown = file === null ? null : fileView(member, file, email, null);
  return {
    ref: refString(item.ref),
    locationId: item.locationId,
    via: item.via,
    kind: item.kind,
    name: viewAs || file === null ? null : file.name,
    addedAt: item.addedAt.toISOString(),
    addedByEmail: item.byStaff ? TOWNWISE_STAFF : email,
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
  };
}

async function itemViews(ctx: TownwiseContext, member: MemberPrincipal, items: readonly DataItemRecord[]): Promise<DataItemView[]> {
  const ids = [...new Set(items.flatMap((item) => (item.byStaff ? [] : [item.addedBy])))];
  const emails = new Map(await Promise.all(ids.map(async (id) => [id, await currentEmail(ctx, id)] as const)));
  return items.map((item) => dataItemView(member, item, emails.get(item.addedBy) ?? DELETED_PERSON, ctx.files !== null));
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

/** The location, then the item by its ref; a stored file answers 503 files_unavailable while files are off. */
async function loadItem(ctx: TownwiseContext, member: MemberPrincipal, req: Request): Promise<{ location: LocationRecord; item: DataItemRecord }> {
  const ref = parseRef(req.params.ref);
  const location = await loadLocation(ctx, member.scope, req.params.locationId);
  if (ref.type === 'file' && ctx.files === null) throw filesUnavailable();
  const item = await loadDataItem(ctx, member.scope, location.id, ref, member.userId);
  if (item === null) throw notFound();
  return { location, item };
}

const updateBody = z.strictObject({ enabled: z.boolean() });

/**
 * PATCH /locations/:locationId/data/:ref { enabled }: turns an upload or a reference item off or on. Asking for the state
 * it is already in changes nothing and records nothing.
 */
export async function updateDataItem(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const { enabled } = parseInput(updateBody, req.body);
  const { location, item } = await loadItem(ctx, member, req);
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
  const email = item.byStaff ? TOWNWISE_STAFF : await currentEmail(ctx, item.addedBy);
  res.status(200).json({ item: dataItemView(member, updated, email, ctx.files !== null) });
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
  const deletedDays = await ctx.stores.salesDays.removeForUpload(scope, location.id, item.ref.id);
  await ctx.stores.uploads.remove(scope, location.id, item.ref.id);
  await recordAfter(ctx, {
    ...actorOf(member), at: ctx.now(), orgId: scope.orgId, action: 'sales.upload_deleted',
    target: { type: 'upload', id: item.ref.id }, details: { locationId: location.id, deletedDays, deletedFiles: files.length },
  });
  res.status(200).json({ deletedDays, deletedFiles: files.length });
}
