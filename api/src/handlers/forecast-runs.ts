// Forecast runs from the staff console (spec 10.13, 14.4, 16.4 P21 Forecasts): list an organization's runs, import a
// run file for one of its locations as a draft, publish it so owners and TownwiseAI see it, withdraw it, or delete it.
// Every route here has policy `staff`. Each change is a staff action its org admins see in their Townwise staff
// activity (D9): read-only checks, then the event (ids, the model version, dates and the day count, never a figure),
// then the effect (spec 9.3). The model itself never reaches the API: a run file holds outputs only. Log lines carry
// ids and counts only, never a figure or the file.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForStaffOrg, type OrgScope, type Principal } from '../access/policy.ts';
import { utcDay } from '../dates.ts';
import { checkForecastRunFile, runFileSha256, type ForecastRunFile } from '../forecasts/file.ts';
import { runView, type ForecastRunView } from '../forecasts/reader.ts';
import { storedRef } from '../forecasts/reasons.ts';
import { currentEmail } from '../people.ts';
import type { AuditAction, AuditEventInput } from '../stores/audit-events.ts';
import type { ForecastRowInput, ForecastRunRecord, RunStatus } from '../stores/forecasts.ts';
import { townEvents } from '../town-calendar.ts';
import { actorOf, notFound, staffOf } from './admin.ts';

/** The newest imports a list shows. */
const RUN_LIST_LIMIT = 100;

const emptyBody = z.strictObject({});

export interface StaffForecastRunView extends ForecastRunView {
  locationId: string;
  status: RunStatus;
  range: { from: string; to: string };
  dayCount: number;
  weekCount: number;
  importedAt: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
  /** The importing staff member's current address; null once that person's records were deleted. */
  importedByEmail: string | null;
}

async function staffView(ctx: TownwiseContext, run: ForecastRunRecord, emails?: Map<string, string>): Promise<StaffForecastRunView> {
  const by = run.importedBy;
  return {
    ...runView(run),
    locationId: run.locationId,
    status: run.status,
    range: run.range,
    dayCount: run.dayCount,
    weekCount: run.weekCount,
    importedAt: run.importedAt.toISOString(),
    publishedAt: run.publishedAt?.toISOString() ?? null,
    withdrawnAt: run.withdrawnAt?.toISOString() ?? null,
    importedByEmail: by === null ? null : emails?.get(by) ?? await currentEmail(ctx, by),
  };
}

function eventOf(staff: ReturnType<typeof staffOf>, now: Date, scope: OrgScope, action: AuditAction, run: {
  id: string; locationId: string; version: string; range: { from: string; to: string }; dayCount: number;
}): AuditEventInput {
  return {
    ...actorOf(staff), at: now, orgId: scope.orgId, action,
    target: { type: 'forecast_run', id: run.id },
    details: { locationId: run.locationId, modelVersion: run.version, from: run.range.from, to: run.range.to, dayCount: run.dayCount },
  };
}

function recordFacts(run: ForecastRunRecord): Parameters<typeof eventOf>[4] {
  return { id: run.id, locationId: run.locationId, version: run.model.version, range: run.range, dayCount: run.dayCount };
}

/** The rows a run file makes, field by field. A ref is kept only when it names a calendar entry on its day. */
function rowsOf(file: ForecastRunFile, townId: string | null): ForecastRowInput[] {
  const days = file.days.map((day): ForecastRowInput => {
    const events = townEvents(townId, { from: day.date, to: day.date });
    return {
      span: 'day', from: day.date, to: day.date, status: day.status, low: day.low, mid: day.mid, high: day.high,
      baseline: day.baseline, openDays: null,
      reasons: day.reasons.map((reason) => ({ kind: reason.kind, ref: storedRef(reason.ref, events), effectPct: reason.effectPct })),
    };
  });
  const weeks = file.weeks.map((week): ForecastRowInput => ({
    span: 'week', from: week.from, to: week.to, status: null, low: week.low, mid: week.mid, high: week.high, baseline: null,
    openDays: week.openDays, reasons: [],
  }));
  return [...days, ...weeks];
}

async function scopeOf(ctx: TownwiseContext, req: Request, principal: Principal) {
  const staff = staffOf(principal);
  const { scope } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  return { staff, scope };
}

async function runOf(ctx: TownwiseContext, scope: OrgScope, rawId: unknown): Promise<ForecastRunRecord> {
  const run = await ctx.stores.forecasts.find(scope, parseInput(objectId, rawId));
  if (run === null) throw notFound();
  return run;
}

/** GET /api/admin/orgs/:orgId/forecast-runs: 200 { runs }, newest import first, at most 100. */
export async function listForecastRuns(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = await scopeOf(ctx, req, principal);
  const runs = await ctx.stores.forecasts.list(scope, RUN_LIST_LIMIT);
  const ids = [...new Set(runs.flatMap((run) => (run.importedBy === null ? [] : [run.importedBy])))];
  const emails = new Map(await Promise.all(ids.map(async (id): Promise<[string, string]> => [id, await currentEmail(ctx, id)])));
  res.status(200).json({ runs: await Promise.all(runs.map((run) => staffView(ctx, run, emails))) });
}

/**
 * POST /api/admin/orgs/:orgId/locations/:locationId/forecast-runs, body a townwise.forecast-run/1 file: 201 { run } as
 * a new draft; 200 { run } for a file this location already has, in its current status; 400 invalid_forecast_file
 * { issues } (paths and codes only). A run left `importing` by a crash finishes when the same file is imported again.
 */
export async function importForecastRun(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await scopeOf(ctx, req, principal);
  const location = await ctx.stores.locations.find(scope, parseInput(objectId, req.params.locationId));
  if (location === null) throw notFound();
  const now = ctx.now();
  const check = checkForecastRunFile(req.body, utcDay(now));
  if (!check.ok) {
    res.status(400).json({ error: 'invalid_forecast_file', message: 'Invalid forecast file', issues: check.issues });
    return;
  }
  const { file } = check;
  const { forecasts } = ctx.stores;
  const fileSha256 = runFileSha256(file);
  const existing = await forecasts.findByFile(scope, location.id, fileSha256);
  if (existing !== null && existing.status !== 'importing') {
    res.status(200).json({ run: await staffView(ctx, existing) });
    return;
  }
  const runId = existing?.id ?? new Types.ObjectId().toHexString();
  const dates = file.days.map((day) => day.date).sort();
  const event = eventOf(staff, now, scope, 'forecast.imported', {
    id: runId, locationId: location.id, version: file.model.version,
    range: { from: dates[0] ?? '', to: dates.at(-1) ?? '' }, dayCount: file.days.length,
  });
  const eventId = await recordBefore(ctx, event);
  const outcome = await applyRecorded(ctx, event, eventId, async () => {
    const { run } = await forecasts.upsertRun(scope, location.id, { id: runId, file, fileSha256, importedBy: staff.actor.userId, lab: null, now });
    // Another import of the same file made the run first; this one finishes it with the same rows.
    const raced = run.id !== runId;
    if (run.status === 'importing') {
      await forecasts.writeRows(scope, location.id, run.id, rowsOf(file, location.town.townId));
      if (await forecasts.countRows(scope, run.id) !== run.dayCount + run.weekCount) throw new Error('forecast rows incomplete');
      await forecasts.setStatus(scope, run.id, { from: ['importing'], to: 'draft', at: now, by: null });
    }
    return { run: await forecasts.find(scope, run.id), raced };
  });
  if (outcome.raced) await recordNotApplied(ctx, event, eventId, 'conflict');
  if (outcome.run === null) throw notFound();
  ctx.logger.info({
    orgId: scope.orgId, locationId: location.id, runId: outcome.run.id, days: outcome.run.dayCount, weeks: outcome.run.weekCount,
  }, 'townwise.forecast_imported');
  res.status(outcome.raced ? 200 : 201).json({ run: await staffView(ctx, outcome.run) });
}

/**
 * One status change: `from` the statuses it applies to, `done` the status that already answers 200 with nothing
 * written, and any other status a 409 with `refused`.
 */
async function changeStatus(ctx: TownwiseContext, req: Request, res: Response, principal: Principal, change: {
  action: AuditAction; from: readonly RunStatus[]; to: RunStatus; refused: (status: RunStatus) => AppError;
}): Promise<void> {
  const { staff, scope } = await scopeOf(ctx, req, principal);
  parseInput(emptyBody, req.body);
  const run = await runOf(ctx, scope, req.params.runId);
  if (run.status === change.to) {
    res.status(200).json({ run: await staffView(ctx, run) });
    return;
  }
  if (!change.from.includes(run.status)) throw change.refused(run.status);
  const now = ctx.now();
  const event = eventOf(staff, now, scope, change.action, recordFacts(run));
  const eventId = await recordBefore(ctx, event);
  const changed = await applyRecorded(ctx, event, eventId, () => ctx.stores.forecasts.setStatus(scope, run.id, {
    from: change.from, to: change.to, at: now, by: staff.actor.userId,
  }));
  // A concurrent change or deletion won; the answer says what is there now.
  if (!changed) await recordNotApplied(ctx, event, eventId, 'conflict');
  const current = await ctx.stores.forecasts.find(scope, run.id);
  if (current === null) throw notFound();
  if (current.status !== change.to) throw change.refused(current.status);
  ctx.logger.info({ orgId: scope.orgId, runId: run.id, status: change.to }, 'townwise.forecast_status');
  res.status(200).json({ run: await staffView(ctx, current) });
}

function notDraft(): AppError {
  return new AppError(409, 'forecast_run_not_draft', 'Only a draft forecast can be published');
}

/** POST .../forecast-runs/:runId/publish {}: a draft becomes published (200); published already, 200; otherwise 409. */
export function publishForecastRun(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  return changeStatus(ctx, req, res, principal, { action: 'forecast.published', from: ['draft'], to: 'published', refused: notDraft });
}

/** POST .../forecast-runs/:runId/withdraw {}: a draft or published run becomes withdrawn (200); one still importing is 409. */
export function withdrawForecastRun(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  return changeStatus(ctx, req, res, principal, {
    action: 'forecast.withdrawn', from: ['draft', 'published'], to: 'withdrawn',
    refused: () => new AppError(409, 'forecast_run_importing', 'This forecast’s import hasn’t finished'),
  });
}

/** DELETE /api/admin/orgs/:orgId/forecast-runs/:runId: its rows, then the run (a retry finishes). 204. */
export async function deleteForecastRun(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { staff, scope } = await scopeOf(ctx, req, principal);
  const run = await runOf(ctx, scope, req.params.runId);
  const event = eventOf(staff, ctx.now(), scope, 'forecast.deleted', recordFacts(run));
  const eventId = await recordBefore(ctx, event);
  if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.forecasts.remove(scope, run.id)))) {
    await recordNotApplied(ctx, event, eventId, 'not_found');
    throw notFound();
  }
  ctx.logger.info({ orgId: scope.orgId, runId: run.id, status: 'deleted' }, 'townwise.forecast_status');
  res.status(204).end();
}
