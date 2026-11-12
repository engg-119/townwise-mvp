// Sales history per location (spec 10.4, 11, 14.1, P12, P13). The browser parses the file and sends only
// { date, guests, netSalesCents } per day. The body is never logged, and no figure goes into a log line or an
// audit event: only ids, counts and dates. Staff setup (D23, staff-setup.ts) uploads and deletes through the exported
// functions.
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import { calibrationOf, type Calibration } from '../calibration.ts';
import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../dates.ts';
import { removeStoredFiles } from '../files/remove.ts';
import { currentEmail, DELETED_PERSON, TOWNWISE_STAFF } from '../people.ts';
import type { Coverage, SalesDay } from '../stores/sales-days.ts';
import type { UploadRecord } from '../stores/uploads.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf, orgAdmin } from './team.ts';

/** Spec 10.1. */
export interface UploadView {
  id: string; uploadedAt: string; uploadedByEmail: string; status: 'applying' | 'applied';
  dayCount: number; inserted: number; replaced: number; kept: number; firstDate: string; lastDate: string;
  hasGuests: boolean; hasNetSales: boolean;
}

/**
 * Spec 10.10. The stored file an upload was read from, for the day panel's provenance line. Null for a browser upload,
 * a file since deleted, and every upload while stored files are off; `name` is null during view-as.
 */
export interface HistoryFileLink {
  id: string; name: string | null; kind: 'text' | 'xlsx' | 'xls' | 'pdf' | 'docx' | 'doc' | 'zip' | 'other';
}

/** Spec 10.10. */
export interface HistoryUploadView {
  id: string; uploadedAt: string; uploadedByEmail: string; status: 'applying' | 'applied'; firstDate: string; lastDate: string;
  file: HistoryFileLink | null;
}

/**
 * Spec 10.10: every stored day, oldest first, in columns of equal length. `upload` indexes `uploads` (newest first),
 * the upload that last wrote the day, or is -1 when that upload has no record.
 */
export interface SalesHistory {
  coverage: Coverage;
  uploadsOff: boolean;
  days: { date: string[]; guests: (number | null)[]; netSalesCents: (number | null)[]; upload: number[] };
  uploads: HistoryUploadView[];
}

/** Spec 11.3 and 18. [CONFIRM: ten years per upload; caps of 20,000 guests and one million dollars a day] */
const MAX_UPLOAD_DAYS = 3660;
const MAX_GUESTS = 20_000;
const MAX_NET_SALES_CENTS = 100_000_000;
/** Spec 10.4. */
const RECENT_UPLOADS = 20;
/** Files read per page while matching uploads to the stored files they came from. */
const SOURCE_PAGE = 100;
const MAX_RANGE_DAYS = 366;

const daySchema = z.strictObject({
  date: isoDate,
  guests: z.number().int().min(0).max(MAX_GUESTS).nullable(),
  netSalesCents: z.number().int().min(0).max(MAX_NET_SALES_CENTS).nullable(),
});

/**
 * Spec 11.3, strict at every level: exactly { days }, each day exactly { date, guests, netSalesCents }, 1 to 3,660
 * days, unique dates from 2010-01-01 to `latest` (the server's UTC date plus one day, which covers every US zone),
 * and at least one value per day. Any failure is 400 invalid_request with no field details.
 */
function uploadSchema(latest: string) {
  const day = daySchema.refine((d) => d.date >= EARLIEST_DATE && d.date <= latest && (d.guests !== null || d.netSalesCents !== null));
  return z.strictObject({
    days: z.array(day).min(1).max(MAX_UPLOAD_DAYS).refine((days) => new Set(days.map((d) => d.date)).size === days.length),
  });
}

/** From `from` to `to`, inclusive, at most 366 days. */
const rangeQuery = z.object({ from: isoDate, to: isoDate })
  .refine((range) => range.from <= range.to && daysBetween(range.from, range.to) < MAX_RANGE_DAYS);

/** Whom an upload names (spec 10.1): “Townwise staff” for staff setup's (D23), else the uploader's current email. */
function uploaderOf(ctx: TownwiseContext, upload: UploadRecord): Promise<string> {
  return upload.byStaff ? Promise.resolve(TOWNWISE_STAFF) : currentEmail(ctx, upload.uploadedBy);
}

function uploadView(upload: UploadRecord, uploadedByEmail: string): UploadView {
  return {
    id: upload.id,
    uploadedAt: upload.uploadedAt.toISOString(),
    uploadedByEmail,
    status: upload.status,
    dayCount: upload.dayCount,
    inserted: upload.inserted,
    replaced: upload.replaced,
    kept: upload.kept,
    firstDate: upload.firstDate,
    lastDate: upload.lastDate,
    hasGuests: upload.hasGuests,
    hasNetSales: upload.hasNetSales,
  };
}

/**
 * D28: true when the location shows no day because every upload holding days is turned off, so the client can say
 * that instead of "no history". Only a boolean leaves: no count, date or upload.
 */
async function uploadsOffOf(ctx: TownwiseContext, scope: OrgScope, locationId: string, coverage: Coverage): Promise<boolean> {
  return coverage.dayCount === 0 && await ctx.stores.salesDays.holdsOffDays(scope, locationId);
}

/** GET /api/org/locations/:locationId/sales: coverage, calibration, month sums and the newest 20 uploads. */
export async function getSales(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const [coverage, months, uploads] = await Promise.all([
    ctx.stores.salesDays.coverage(scope, location.id),
    ctx.stores.salesDays.months(scope, location.id),
    ctx.stores.uploads.recent(scope, location.id, RECENT_UPLOADS),
  ]);
  res.status(200).json({
    coverage,
    uploadsOff: await uploadsOffOf(ctx, scope, location.id, coverage),
    calibration: calibrationOf(coverage),
    months,
    uploads: await Promise.all(uploads.map(async (upload) => uploadView(upload, await uploaderOf(ctx, upload)))),
  });
}

/** GET /api/org/locations/:locationId/sales/days?from=&to= (the daily chart and table on P12). */
export async function getSalesDays(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const range = parseInput(rangeQuery, req.query);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  res.status(200).json({ days: await ctx.stores.salesDays.days(scope, location.id, range) });
}

/**
 * storage2.md 16.2: the stored file each upload was read from, by upload id. A stored file names the upload it wrote
 * (`tw_files.uploadId`; an upload names no file), so this pages through the location's live files, newest first, and
 * stops once every upload is matched; a location holds at most FILES_PER_LOCATION files. An upload with no entry is a
 * browser upload or its file was deleted. `name` is null during view-as. While stored files are off nothing is
 * matched, because nothing could be listed or downloaded then.
 */
async function sourcesForUploads(
  ctx: TownwiseContext, member: MemberPrincipal, locationId: string, uploadIds: readonly string[],
): Promise<Map<string, HistoryFileLink>> {
  const found = new Map<string, HistoryFileLink>();
  if (ctx.files === null || uploadIds.length === 0) return found;
  const wanted = new Set(uploadIds);
  const viewAs = member.viewAs !== null;
  let before: string | null = null;
  for (;;) {
    const page = await ctx.stores.files.list(member.scope, locationId, { viewerId: member.userId, before, limit: SOURCE_PAGE });
    for (const file of page) {
      if (file.uploadId === null || !wanted.has(file.uploadId) || found.has(file.uploadId)) continue;
      found.set(file.uploadId, { id: file.id, name: viewAs ? null : file.name, kind: file.kind });
    }
    const last = page.at(-1);
    if (last === undefined || page.length < SOURCE_PAGE || found.size === wanted.size) return found;
    before = last.id;
  }
}

/**
 * GET /api/org/locations/:locationId/sales/history (spec 10.10): every stored day with the upload that wrote it, for
 * the heatmap, the day panel and year over year. A read: it logs nothing and records nothing.
 */
export async function getSalesHistory(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const [coverage, days] = await Promise.all([
    ctx.stores.salesDays.coverage(scope, location.id),
    ctx.stores.salesDays.history(scope, location.id),
  ]);
  const uploadsOff = await uploadsOffOf(ctx, scope, location.id, coverage);
  const uploads = await ctx.stores.uploads.byIds(scope, location.id, [...new Set(days.map((d) => d.uploadId))]);
  const [emails, sources] = await Promise.all([
    Promise.all([...new Set(uploads.flatMap((upload) => (upload.byStaff ? [] : [upload.uploadedBy])))]
      .map(async (userId) => [userId, await currentEmail(ctx, userId)] as const)).then((pairs) => new Map(pairs)),
    sourcesForUploads(ctx, member, location.id, uploads.map((upload) => upload.id)),
  ]);
  const indexOf = new Map(uploads.map((upload, index) => [upload.id, index]));
  const history: SalesHistory = {
    coverage,
    uploadsOff,
    days: {
      date: days.map((d) => d.date),
      guests: days.map((d) => d.guests),
      netSalesCents: days.map((d) => d.netSalesCents),
      upload: days.map((d) => indexOf.get(d.uploadId) ?? -1),
    },
    uploads: uploads.map((upload) => ({
      id: upload.id,
      uploadedAt: upload.uploadedAt.toISOString(),
      uploadedByEmail: upload.byStaff ? TOWNWISE_STAFF : emails.get(upload.uploadedBy) ?? DELETED_PERSON,
      status: upload.status,
      firstDate: upload.firstDate,
      lastDate: upload.lastDate,
      file: sources.get(upload.id) ?? null,
    })),
  };
  res.status(200).json(history);
}

/** An upload body checked by the rules of spec 11.3, with its first and last dates. */
export interface CheckedUpload { days: SalesDay[]; firstDate: string; lastDate: string }

/** The upload route's body check, shared with staff setup (D23). */
export function checkedUpload(raw: unknown, now: Date): CheckedUpload {
  const { days } = parseInput(uploadSchema(utcDay(now, 1)), raw);
  const dates = days.map((day) => day.date);
  return { days, firstDate: dates.reduce((a, b) => (b < a ? b : a)), lastDate: dates.reduce((a, b) => (b > a ? b : a)) };
}

/**
 * Spec 11.4 steps 1 to 3, shared with staff setup (D23): the record as `applying`, every day, then its counts, and the
 * `townwise.upload_applied` line. `replace` sets the days it covers, nulls included; otherwise only new days are
 * written and the rest are `kept`. `id` is the id a staff event already names; `byStaff` marks staff setup's.
 */
export async function applyUpload(ctx: TownwiseContext, scope: OrgScope, locationId: string, upload: CheckedUpload & {
  id?: string; replace: boolean; uploadedBy: string; byStaff?: boolean; now: Date;
}): Promise<UploadRecord> {
  const { days, firstDate, lastDate, replace, now } = upload;
  const started = await ctx.stores.uploads.start(scope, locationId, {
    ...(upload.id === undefined ? {} : { id: upload.id }), uploadedBy: upload.uploadedBy, uploadedAt: now, dayCount: days.length,
    firstDate, lastDate, hasGuests: days.some((day) => day.guests !== null), hasNetSales: days.some((day) => day.netSalesCents !== null),
    ...(upload.byStaff === true ? { byStaff: true } : {}),
  });
  const { inserted, matched } = await ctx.stores.salesDays.apply(scope, locationId, { uploadId: started.id, days, replace, now });
  const counts = { inserted, replaced: replace ? matched : 0, kept: replace ? 0 : matched };
  await ctx.stores.uploads.finish(scope, started.id, counts);
  ctx.logger.info({ orgId: scope.orgId, locationId, uploadId: started.id, dayCount: days.length }, 'townwise.upload_applied');
  return { ...started, ...counts, status: 'applied' };
}

/** The upload route's answer, shared with staff setup (D23): the upload, and the location's coverage after it. */
export async function uploadAnswer(
  ctx: TownwiseContext, scope: OrgScope, locationId: string, upload: UploadRecord, uploadedByEmail: string,
): Promise<{ upload: UploadView; coverage: Coverage; calibration: Calibration }> {
  const coverage = await ctx.stores.salesDays.coverage(scope, locationId);
  return { upload: uploadView(upload, uploadedByEmail), coverage, calibration: calibrationOf(coverage) };
}

/**
 * POST /api/org/locations/:locationId/sales/uploads (spec 11.4). An org admin's upload replaces the days it covers,
 * nulls included; a member's adds new days only and reports the rest as `kept` (D16).
 */
export async function uploadSales(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  const { scope } = member;
  const now = ctx.now();
  const checked = checkedUpload(req.body, now);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const applied = await applyUpload(ctx, scope, location.id, {
    ...checked, replace: member.role === 'org_admin', uploadedBy: member.userId, ...(member.openAsAdmin !== null ? { byStaff: true } : {}), now,
  });
  await recordAfter(ctx, {
    ...actorOf(member), at: now, orgId: scope.orgId, action: 'sales.uploaded',
    target: { type: 'upload', id: applied.id },
    details: {
      locationId: location.id, dayCount: applied.dayCount, inserted: applied.inserted, replaced: applied.replaced,
      firstDate: applied.firstDate, lastDate: applied.lastDate,
    },
  });
  res.status(201).json(await uploadAnswer(ctx, scope, location.id, applied, applied.byStaff ? TOWNWISE_STAFF : member.email));
}

export function filesUnavailable(): AppError {
  return new AppError(503, 'files_unavailable', 'Stored files are off');
}

/**
 * DELETE's check, shared with staff setup (D23): the location's stored files go with its sales data (spec 11A), but
 * not while Townwise is reading one of them.
 */
export async function assertNotReading(ctx: TownwiseContext, scope: OrgScope, locationId: string): Promise<void> {
  if ((await ctx.stores.imports.active(scope, locationId))?.status === 'reading') {
    throw new AppError(409, 'import_running', 'Townwise is reading this location’s files; try again when it is done');
  }
}

/**
 * DELETE's effect, shared with staff setup (D23): every day and upload record of the location, its stored files, (U13B)
 * its forecasts and its answers to TownwiseAI's questions. Notes stay. `files_unavailable`, with nothing deleted, when
 * the location has stored files while they are off.
 */
export async function removeSalesData(
  ctx: TownwiseContext, scope: OrgScope, locationId: string,
): Promise<{ deletedDays: number; deletedUploads: number; deletedFiles: number } | 'files_unavailable'> {
  const removed = await removeStoredFiles(ctx.stores, ctx.files, scope, locationId);
  if (removed === 'files_unavailable') return removed;
  const deletedDays = await ctx.stores.salesDays.removeForLocation(scope, locationId);
  const deletedUploads = await ctx.stores.uploads.removeForLocation(scope, locationId);
  // The forecast lab: calibrations go before their runs, so a running job's callback closes before its run could be written.
  await ctx.stores.calibrations.removeForLocation(scope, locationId);
  // U13B: forecasts are made from the sales data, so they go with it.
  await ctx.stores.forecasts.removeForLocation(scope, locationId);
  // Answers to TownwiseAI's questions were about these days, so they go too, after the days: with no days left no
  // question is asked, and the same days uploaded again are asked about again. Closure notes they saved stay.
  // Order edits and rules stay: they are not about these days, and a sales delete must not forget them.
  // Order edits and rules stay: they are not about these days, and a sales delete must not forget them.
  await ctx.stores.agentAnswers.removeForLocation(scope, locationId);
  if (removed.deletedFiles > 0) {
    ctx.logger.info({ orgId: scope.orgId, locationId, ...removed }, 'townwise.location_files_deleted');
  }
  return { deletedDays, deletedUploads, deletedFiles: removed.deletedFiles };
}

/** DELETE /api/org/locations/:locationId/sales (removeSalesData). */
export async function deleteSales(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  await assertNotReading(ctx, scope, location.id);
  const removed = await removeSalesData(ctx, scope, location.id);
  if (removed === 'files_unavailable') throw filesUnavailable();
  await recordAfter(ctx, {
    ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'sales.deleted',
    target: { type: 'location', id: location.id },
    details: { locationId: location.id, deletedDays: removed.deletedDays, deletedFiles: removed.deletedFiles },
  });
  res.status(200).json(removed);
}
