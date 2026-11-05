// The caller's own organization (spec 10.3, F7, D9, P18): org admins rename it and read its Townwise staff activity;
// any member leaves it. The organization comes only from the principal's scope; no route here carries an id.
import { authOf } from '@ckeith26/auth';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter, staffActivityViews } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { resolveAccess } from '../access/resolve.ts';
import { memberOf } from './locations.ts';
import { meResponse } from './me.ts';
import { actorOf, orgAdmin } from './team.ts';

/** Spec 10.3: the newest staff events shown on Settings. */
const STAFF_ACTIVITY_EVENTS = 50;

const renameBody = z.object({ name: z.string().trim().min(2).max(120) });
/** Strict: leaving carries nothing, so an organization id in the body is refused (spec 6.10 rule 3). */
const leaveBody = z.strictObject({});

/** PATCH /api/org { name } (P18). [CONFIRM: org admins can rename their own organization] */
export async function renameOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const admin = orgAdmin(principal);
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
 * POST /api/org/leave {} (F7): the same as removing oneself, recorded as member.left. The last admin gets 409
 * last_admin and keeps the seat. The recount uses the role the seat had when it was removed, read in the same write,
 * so leaving as a member never depends on whether the organization has an admin.
 */
export async function leaveOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  parseInput(leaveBody, req.body);
  const now = ctx.now();
  const role = await ctx.stores.members.removeSeat(scope, caller.memberId, { removedAt: now, removedBy: caller.userId });
  if (role === 'org_admin' && await ctx.stores.members.countActiveAdmins(scope) === 0) {
    await ctx.stores.members.restoreSeat(scope, caller.memberId, caller.userId);
    throw new AppError(409, 'last_admin', 'The organization needs at least one admin');
  }
  // A null role means an admin removed the seat meanwhile: the caller is out either way, and did not leave.
  if (role !== null) {
    await recordAfter(ctx, {
      ...actorOf(caller), actorRole: role, at: now, orgId: scope.orgId, action: 'member.left',
      target: { type: 'member', id: caller.memberId },
      details: { email: caller.email },
    });
  }
  res.status(200).json(meResponse(await resolveAccess(ctx, authOf(req))));
}

/** GET /api/org/staff-activity (D9, P18): every staff event on this organization, newest first. */
export async function getStaffActivity(ctx: TownwiseContext, _req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = orgAdmin(principal);
  const page = await ctx.stores.audit.query({ orgId: scope.orgId, actorRole: 'superadmin', limit: STAFF_ACTIVITY_EVENTS });
  res.status(200).json({ events: await staffActivityViews(ctx, page.events.slice(0, STAFF_ACTIVITY_EVENTS)) });
}
