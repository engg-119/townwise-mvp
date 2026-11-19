// TownwiseAI working on its own (D59, openspec change auto-apply-agent-reads, spec 10.12): the org admin's switch
// (PATCH /api/org/agent-auto), the log of a location's changes (GET .../agent/changes) and Undo of one
// (POST .../agent/changes/:changeId/undo). Undo is ordered for retries, with no transactions: the ledger row goes
// `applied` to `undoing` by compare-and-set; the target is removed only while it is unchanged since it was applied (a
// note by compare-and-set on its updatedAt; an item through the file removal; days through the upload removal D34's undo
// uses); then the row goes `undoing` to `undone`, and only the call whose compare-and-set lands records
// `agent.change_undone`. A target a person changed since leaves the row `adopted` (409 changed_since); one deleted since
// leaves it `undone` (200). A retry of any step finishes it. A calibration already started is never undone. Logs and
// audit events carry ids, the action and the source kind only: never a title, a why, a file name or a figure.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { applyRecorded, recordAfter, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { changeView, mayUndo, targetStates, type AgentChangeView } from '../agent/changes.ts';
import { wantRefitFor } from '../agent/refit.ts';
import type { AgentChangeRecord } from '../stores/agent-changes.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { removeUpload } from './data.ts';
import { removeWholeFile } from './files.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf, assertOpenAsAdminTab, orgAdmin } from './team.ts';

/** `orgId`, the organization the page shows, is required in open as admin (D25), as on the other switches. */
const switchBody = z.strictObject({ on: z.boolean(), orgId: objectId.optional() });
/** The log's page: 50 changes, newest first. */
export const CHANGES_PAGE = 50;
/** `before`, the `next` of the page before: `<ISO time>_<24 hex id>`. */
const logQuery = z.object({ before: z.string().max(64).optional() });

/** Whether TownwiseAI works on its own here, as the panel shows it. */
export interface AgentAutoView {
  /** The organization's switch: on unless an org admin turned it off. */
  on: boolean;
  /** TOWNWISE_AGENT_AUTO is true and TownwiseAI can read files here. */
  available: boolean;
  /** An org admin outside view-as turns it off or on (staff open as admin: off only). */
  canChange: boolean;
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** The switch as the panel shows it to `caller`. */
export async function agentAutoView(ctx: TownwiseContext, caller: MemberPrincipal): Promise<AgentAutoView> {
  const org = await ctx.stores.orgs.findById(caller.scope.orgId);
  return {
    on: org?.agentAuto.on ?? true, available: ctx.config.agentAuto && ctx.aiReads !== null,
    canChange: caller.role === 'org_admin' && caller.viewAs === null,
  };
}

/**
 * PATCH /api/org/agent-auto { on, orgId? } (org admin, outside view-as): 200 { agentAuto: { on } }. A change records
 * `org.agent_auto_switched` before it is applied; the same state again writes nothing. Turning it on is the
 * organization's consent to TownwiseAI reading its files without a press, so staff open as admin may turn it off only:
 * `on: true` answers them 403 open_as_admin_refused. In open as admin a missing or other `orgId` answers 409
 * open_as_admin_active.
 */
export async function switchAgentAuto(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  const { scope } = admin;
  const { on } = parseInput(switchBody, req.body);
  assertOpenAsAdminTab(admin, req.body);
  if (on && admin.openAsAdmin !== null) throw new AppError(403, 'open_as_admin_refused', 'Only the organization’s own admin can turn this on');
  const org = await ctx.stores.orgs.findById(scope.orgId);
  // Only a deletion racing this request gets here; the client re-reads /api/me.
  if (org === null) throw new AppError(403, 'no_access', 'No access');
  if (org.agentAuto.on !== on) {
    const now = ctx.now();
    const event: AuditEventInput = {
      ...actorOf(admin), at: now, orgId: scope.orgId, action: 'org.agent_auto_switched', target: { type: 'org', id: scope.orgId },
      details: { on },
    };
    const eventId = await recordBefore(ctx, event);
    if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.orgs.setAgentAuto(scope, { on, at: now, by: admin.userId })))) {
      await recordNotApplied(ctx, event, eventId, 'not_found');
      throw new AppError(403, 'no_access', 'No access');
    }
  }
  ctx.logger.info({ orgId: scope.orgId, on }, 'townwise.agent_auto_switched');
  res.status(200).json({ agentAuto: { on } });
}

/** `<ISO time>_<24 hex id>`, the time exactly as toISOString writes it. */
function parseBefore(raw: string): { at: Date; id: string } {
  const match = /^(.+)_([0-9a-f]{24})$/.exec(raw);
  const at = new Date(match?.[1] ?? Number.NaN);
  if (match === null || Number.isNaN(at.getTime()) || at.toISOString() !== match[1]) {
    throw new AppError(400, 'invalid_request', 'Invalid request');
  }
  return { at, id: match[2] ?? '' };
}

/**
 * GET /api/org/locations/:locationId/agent/changes?before= (member): 200 { changes, next }: every change TownwiseAI saved
 * at the location, newest first, 50 a page, each with its why (none under view-as), its status and whether Undo is
 * offered (never under view-as). `next` reads the next older page; null on the last. A read: it logs and records nothing.
 */
export async function listAgentChanges(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const query = parseInput(logQuery, req.query);
  const before = query.before === undefined ? undefined : parseBefore(query.before);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const page = await ctx.stores.agentChanges.page(scope, location.id, { ...(before === undefined ? {} : { before }), limit: CHANGES_PAGE });
  const states = await targetStates(ctx, scope, location.id, page.changes);
  const changes: AgentChangeView[] = page.changes.map((change) => changeView(caller, change, states));
  res.status(200).json({ changes, next: page.next === null ? null : `${page.next.at.toISOString()}_${page.next.id}` });
}

/** The undo's second step: the target removed while unchanged. 'changed' when a person changed it since. */
async function removeTarget(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, change: AgentChangeRecord): Promise<'removed' | 'gone' | 'changed'> {
  const { scope } = caller;
  switch (change.action) {
    case 'note.add': {
      const note = await ctx.stores.notes.find(scope, location.id, change.targetId);
      if (note === null) return 'gone';
      if (change.targetUpdatedAt === null || note.updatedAt.getTime() !== change.targetUpdatedAt.getTime()) return 'changed';
      if (await ctx.stores.notes.removeIf(scope, location.id, note.id, change.targetUpdatedAt)) return 'removed';
      // Edited or deleted between the read and the delete.
      return (await ctx.stores.notes.find(scope, location.id, change.targetId)) === null ? 'gone' : 'changed';
    }
    case 'item.add': {
      const file = await ctx.stores.files.get(scope, location.id, change.targetId);
      if (file === null || file.status === 'deleting') {
        if (file !== null && ctx.files !== null) await removeWholeFile(ctx, ctx.files, scope, file, { resume: true });
        return 'gone';
      }
      const blobs = ctx.files;
      if (blobs === null) throw new AppError(503, 'files_unavailable', 'Stored files are off');
      await removeWholeFile(ctx, blobs, scope, file);
      ctx.logger.info({ fileId: file.id }, 'townwise.file_deleted');
      return 'removed';
    }
    case 'sales_days.add': {
      const upload = await ctx.stores.uploads.get(scope, location.id, change.targetId);
      // A retry after the record went still sweeps days a write in flight landed.
      if (upload === null) {
        await ctx.stores.salesDays.removeForUpload(scope, location.id, change.targetId);
        return 'gone';
      }
      await removeUpload(ctx, scope, location.id, upload.id);
      return 'removed';
    }
    case 'rule.add':
    case 'booking.label':
      // Not written in slice 1.
      return 'gone';
  }
}

function changedSince(): AppError {
  return new AppError(409, 'changed_since', 'You changed this since, so it’s yours now. Delete it yourself if you don’t want it.');
}

/**
 * POST /api/org/locations/:locationId/agent/changes/:changeId/undo (member with the action's role, outside view-as):
 * 200 { change } once undone (a retry that finds it undone answers the same and records nothing); 403 for a caller the
 * action's role refuses; 404 for an unknown id or another location's or organization's; 409 changed_since once a person
 * changed the target (the row reads `adopted`), and 409 change_in_progress while it is still being applied.
 */
export async function undoAgentChange(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const changeId = parseInput(objectId, req.params.changeId);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  let change = await ctx.stores.agentChanges.find(scope, location.id, changeId);
  if (change === null) throw notFound();
  if (!mayUndo(caller, change)) throw new AppError(403, 'forbidden', 'Only an org admin can undo this');
  const answer = async (row: AgentChangeRecord): Promise<void> => {
    const states = await targetStates(ctx, scope, location.id, [row]);
    res.status(200).json({ change: changeView(caller, row, states) });
  };
  if (change.status === 'applied') {
    change = await ctx.stores.agentChanges.markUndoing(scope, location.id, change.id, { by: caller.userId, now: ctx.now() })
      ?? await ctx.stores.agentChanges.find(scope, location.id, change.id);
    if (change === null) throw notFound();
  }
  if (change.status === 'undone') {
    await answer(change);
    return;
  }
  if (change.status === 'adopted') throw changedSince();
  if (change.status === 'applying') throw new AppError(409, 'change_in_progress', 'TownwiseAI is still saving this');
  const removed = await removeTarget(ctx, caller, location, change);
  if (removed === 'changed') {
    await ctx.stores.agentChanges.markAdopted(scope, location.id, change.id, { now: ctx.now() });
    ctx.logger.info({ orgId: scope.orgId, locationId: location.id, changeId: change.id, action: change.action }, 'townwise.agent_change_adopted');
    throw changedSince();
  }
  if (await ctx.stores.agentChanges.markUndone(scope, location.id, change.id, { by: caller.userId, now: ctx.now() })) {
    await recordAfter(ctx, {
      ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'agent.change_undone', target: { type: 'location', id: location.id },
      details: { locationId: location.id, action: change.action, sourceKind: change.sourceKind },
    });
    if (removed === 'removed' && change.startDate !== null && change.endDate !== null) {
      await wantRefitFor(ctx, scope, location.id, change.action === 'sales_days.add' ? 'always' : { startDate: change.startDate, endDate: change.endDate });
    }
    ctx.logger.info({ orgId: scope.orgId, locationId: location.id, changeId: change.id, action: change.action, removed }, 'townwise.agent_change_undone');
  }
  const after = await ctx.stores.agentChanges.find(scope, location.id, change.id);
  if (after === null) throw notFound();
  await answer(after);
}
