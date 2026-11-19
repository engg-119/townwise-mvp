// TownwiseAI working on its own (D59, openspec change auto-apply-agent-reads, spec 10.12): the org admin's switch
// (PATCH /api/org/agent-auto), the log of a location's changes (GET .../agent/changes) and Undo of one
// (POST .../agent/changes/:changeId/undo). Undo is ordered for retries, with no transactions: the ledger row goes
// `applied` to `undoing` by compare-and-set; the target is removed only while it is unchanged since it was applied (a
// note by compare-and-set on its updatedAt; an item through the file removal; days through the upload removal D34's undo
// uses; slice 3, a rule by compare-and-set on its updatedAt); then the row goes `undoing` to `undone`, and only the call whose compare-and-set lands records
// `agent.change_undone`. A target a person changed since leaves the row `adopted` (409 changed_since); one deleted since
// leaves it `undone` (200). A retry of any step finishes it. A calibration already started is never undone. Undo per
// calendar (slice 2, a `booking.label` change): the notes that calendar's sort made are undone first, each as its own
// change (one a person changed since is theirs and stays), then the labels that sort set that nobody changed since are
// cleared and the confirm TownwiseAI made is taken back, so the calendar waits for Use for forecasts again (or reads as
// never sorted when no label is left); it answers 409 change_in_progress while the calendar's sort still runs. [CONFIRM:
// Undo per calendar takes back the notes, labels and confirm TownwiseAI made that nobody changed since] Logs and
// audit events carry ids, the action and the source kind only: never a title, a why, a file name or a figure.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { applyRecorded, recordAfter, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, Principal } from '../access/policy.ts';
import { TOWNWISE_AI_AUTHOR } from '../agent/apply.ts';
import { changeView, mayUndo, targetStates, type AgentChangeView } from '../agent/changes.ts';
import { wantRefitFor } from '../agent/refit.ts';
import { isAnswerChange } from '../calendar/answers.ts';
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
      if (change.targetUpdatedAt?.getTime() !== note.updatedAt.getTime()) return 'changed';
      if (await ctx.stores.notes.removeIf(scope, location.id, note.id, note.updatedAt)) return 'removed';
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
    case 'booking.label': {
      // Its notes first, so a retry after the labels went still finds them. Only the sort's own (a booking's): a closure
      // note a calendar's answer saved (D59 slice 5) is not part of the labels, and keeps its own Undo.
      for (const row of await ctx.stores.agentChanges.listBySource(scope, location.id, { kind: 'calendar', id: change.targetId })) {
        if (row.action === 'note.add' && !isAnswerChange(row) && (row.status === 'applied' || row.status === 'undoing')) {
          await undoRow(ctx, caller, location, row, { pastChanged: true });
        }
      }
      const calendars = ctx.stores.ownerCalendars;
      const cleared = await calendars.clearAiLabels(scope, location.id, change.targetId, change.targetUpdatedAt ?? change.appliedAt);
      if (cleared === null) return 'gone';
      await calendars.unconfirmBy(scope, location.id, change.targetId, TOWNWISE_AI_AUTHOR);
      // No label left at all: the calendar reads as never sorted, so its page offers Sort again, not an empty confirm.
      await calendars.unsortIfUnlabeled(scope, location.id, change.targetId, ctx.now());
      return cleared > 0 ? 'removed' : 'gone';
    }
    case 'rule.add': {
      // Slice 3: as a note, by compare-and-set on the rule's updatedAt.
      const rule = await ctx.stores.businessRules.find(scope, location.id, change.targetId);
      if (rule === null) return 'gone';
      if (change.targetUpdatedAt?.getTime() !== rule.updatedAt.getTime()) return 'changed';
      if (await ctx.stores.businessRules.removeIf(scope, location.id, rule.id, rule.updatedAt)) return 'removed';
      return (await ctx.stores.businessRules.find(scope, location.id, change.targetId)) === null ? 'gone' : 'changed';
    }
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
  const change = await ctx.stores.agentChanges.find(scope, location.id, changeId);
  if (change === null) throw notFound();
  const author = change.action === 'note.add' ? (await ctx.stores.notes.find(scope, location.id, change.targetId))?.createdBy ?? null : null;
  if (!mayUndo(caller, change, author)) throw new AppError(403, 'forbidden', 'Only an org admin can undo this');
  const after = await undoRow(ctx, caller, location, change);
  const states = await targetStates(ctx, scope, location.id, [after]);
  res.status(200).json({ change: changeView(caller, after, states) });
}

/**
 * The undo's steps for one row the caller may undo (the top): the row after, `undone`; throws 409 changed_since once a
 * person changed the target (the row reads `adopted`; with `pastChanged`, a calendar's undo of its notes, it answers the
 * row instead) and 409 change_in_progress while it is still being applied.
 */
async function undoRow(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, row: AgentChangeRecord, opts: { pastChanged?: boolean } = {},
): Promise<AgentChangeRecord> {
  const { scope } = caller;
  let change: AgentChangeRecord | null = row;
  // A calendar's labels while its sort still runs (its notes are being written): Undo waits until the sort ends.
  if (change.action === 'booking.label' && change.status === 'applied'
    && (await ctx.stores.ownerCalendars.find(scope, location.id, change.targetId))?.autoSort?.status === 'sorting') {
    throw new AppError(409, 'change_in_progress', 'TownwiseAI is still saving this');
  }
  if (change.status === 'applied') {
    change = await ctx.stores.agentChanges.markUndoing(scope, location.id, change.id, { by: caller.userId, now: ctx.now() })
      ?? await ctx.stores.agentChanges.find(scope, location.id, change.id);
    if (change === null) throw notFound();
  }
  if (change.status === 'undone') return change;
  if (change.status === 'adopted') {
    if (opts.pastChanged === true) return change;
    throw changedSince();
  }
  if (change.status === 'applying') throw new AppError(409, 'change_in_progress', 'TownwiseAI is still saving this');
  const removed = await removeTarget(ctx, caller, location, change);
  if (removed === 'changed') {
    await ctx.stores.agentChanges.markAdopted(scope, location.id, change.id, { now: ctx.now() });
    ctx.logger.info({ orgId: scope.orgId, locationId: location.id, changeId: change.id, action: change.action }, 'townwise.agent_change_adopted');
    // A calendar's own undo goes on past a note a person changed: that note is theirs now.
    if (opts.pastChanged === true) return change;
    throw changedSince();
  }
  if (await ctx.stores.agentChanges.markUndone(scope, location.id, change.id, { by: caller.userId, now: ctx.now() })) {
    await recordAfter(ctx, {
      ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'agent.change_undone', target: { type: 'location', id: location.id },
      details: { locationId: location.id, action: change.action, sourceKind: change.sourceKind },
    });
    // A target already gone on a retry may be what an earlier attempt removed: the refit is wanted either way, and the
    // pass clears the mark when nothing it reads changed.
    if (change.action === 'rule.add' && change.startDate !== null) {
      // A rule marks from its start, as a person's rule does (handlers/rules.ts).
      await wantRefitFor(ctx, scope, location.id, { startDate: change.startDate, endDate: change.startDate }, 'person_change');
    } else if (change.startDate !== null && change.endDate !== null) {
      await wantRefitFor(
        ctx, scope, location.id, change.action === 'sales_days.add' ? 'always' : { startDate: change.startDate, endDate: change.endDate }, 'person_change',
      );
    }
    ctx.logger.info({ orgId: scope.orgId, locationId: location.id, changeId: change.id, action: change.action, removed }, 'townwise.agent_change_undone');
  }
  const after = await ctx.stores.agentChanges.find(scope, location.id, change.id);
  if (after === null) throw notFound();
  return after;
}
