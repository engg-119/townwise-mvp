// The caller's own organization (spec 10.3, F7, D9, P18): org admins rename it and read its Townwise staff activity;
// any member leaves it, which ends their Google access for calendars there (openspec change connect-google-calendar,
// design decision 11), only through calendar/google-access.ts. The organization comes only from the principal's
// scope; no route here carries an id.
import { authOf } from '@ckeith26/auth';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter, staffActivityViews } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { resolveAccess } from '../access/resolve.ts';
import { endGoogleAccess, googleAccessDeps, markPersonForCheck } from '../calendar/google-access.ts';
import { memberOf } from './locations.ts';
import { meResponse } from './me.ts';
import { actorOf, assertOpenAsAdminTab, lastAdmin, orgAdmin, removeActiveSeat } from './team.ts';

/** Spec 10.3: the staff events in one page of Settings' staff activity. */
const STAFF_ACTIVITY_EVENTS = 50;

/** `before`, the `nextBefore` of the page before, pages to older events. */
const staffActivityQuery = z.object({ before: z.iso.datetime().optional() });

const renameBody = z.object({ name: z.string().trim().min(2).max(120) });
/** Strict: leaving carries nothing, so an organization id in the body is refused (spec 6.10 rule 3). */
const leaveBody = z.strictObject({});

/**
 * PATCH /api/org { name, orgId? } (P18). `orgId`, the organization the page shows, is required in open as admin (D25).
 */
export async function renameOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
  assertOpenAsAdminTab(admin, req.body);
  const { scope } = admin;
  const { name } = parseInput(renameBody, req.body);
  const before = await ctx.stores.orgs.rename(scope, name);
  // Only a deletion racing this request gets here; the client re-reads /api/me.
  if (before === null) throw new AppError(403, 'no_access', 'No access');
  if (before.name !== name) {
    await recordAfter(ctx, {
      ...actorOf(admin), at: ctx.now(), orgId: scope.orgId, action: 'org.renamed',
      target: { type: 'org', id: scope.orgId },
      details: { from: before.name, to: name },
    });
  }
  res.status(200).json({ org: { id: scope.orgId, name } });
}

/**
 * POST /api/org/leave {} (F7): the same as removing oneself (removeActiveSeat), recorded as member.left with the role
 * the seat had when it was removed. The last admin, or one being demoted while they leave, gets 409 last_admin and
 * keeps the seat; a member leaves whether or not the organization has an admin. Their Google connection is marked for
 * a check before the seat goes and ended after member.left, as for removeMember (handlers/team.ts).
 */
export async function leaveOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  // Open as admin holds no seat to leave (D25); its guard refuses this route first.
  if (caller.memberId === null) throw new AppError(403, 'forbidden', 'Forbidden');
  const { scope } = caller;
  parseInput(leaveBody, req.body);
  const now = ctx.now();
  const google = googleAccessDeps(ctx);
  const connectionId = await markPersonForCheck(google, scope, caller.userId);
  const removal = await removeActiveSeat(ctx, scope, caller.memberId, caller.userId, { removedAt: now, removedBy: caller.userId });
  if (removal.kind === 'last_admin') throw lastAdmin();
  // not_found means an admin removed the seat meanwhile: the caller is out either way, and did not leave.
  if (removal.kind === 'removed') {
    await recordAfter(ctx, {
      ...actorOf(caller), actorRole: removal.role, at: now, orgId: scope.orgId, action: 'member.left',
      target: { type: 'member', id: caller.memberId },
      details: { email: caller.email },
    });
    if (connectionId !== null) await endGoogleAccess(google, scope, connectionId, 'left');
  }
  res.status(200).json(meResponse(await resolveAccess(ctx, authOf(req))));
}

/**
 * GET /api/org/staff-activity?before= (D9, P18): every staff action on this organization, and every one the forecast
 * lab took on its own (the system's publishes and finished calibrations), newest first, each marked applied or not, a
 * page of 50 at a time. `nextBefore` reads the next older page; null when there is none. A page also carries every
 * event sharing its last event's time, so paging skips none.
 */
export async function getStaffActivity(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = orgAdmin(principal);
  const { before } = parseInput(staffActivityQuery, req.query);
  // A staff_action.not_applied event marks the row it qualifies, so it takes no row of its own.
  const page = await ctx.stores.audit.query({
    orgId: scope.orgId, actorRole: ['superadmin', 'system'], excludeAction: 'staff_action.not_applied', limit: STAFF_ACTIVITY_EVENTS,
    ...(before === undefined ? {} : { before: new Date(before) }),
  });
  res.status(200).json({ events: await staffActivityViews(ctx, page.events), nextBefore: page.nextBefore?.toISOString() ?? null });
}
