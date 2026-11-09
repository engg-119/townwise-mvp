// Open as admin, Start (D25, spec 10.7). Staff open an organization nobody has joined as its admin: the grant holds the
// staff member's session in tw_view_as_grants (kind open_as_admin), and while it is live the resolver answers the
// organization's org admin access (access/resolve.ts). It ends at End (POST /api/admin/view-as/end, shared with
// view-as), at sign-out, when the staff window closes, when the organization is suspended, and at the first join.
// It takes no reason: nobody has joined, so the organization holds only what Townwise staff put in it. It has no timer
// of its own: the grant expires with the staff window (D2), which every staff request needs anyway.
// open_as_admin.started is written before the grant exists (9.3), so no grant is ever unrecorded.
import { authOf } from '@ckeith26/auth';
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';

import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForStaffOrg, type Principal, type StaffActor } from '../access/policy.ts';
import { resolveAccess } from '../access/resolve.ts';
import { isInSetup, notInSetup } from '../access/setup.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { GrantRecord } from '../stores/view-as-grants.ts';
import { actorOf, staffOf } from './admin.ts';
import { meResponse } from './me.ts';
import { clearGrant } from './view-as.ts';

function openAsAdminActive(): AppError {
  return new AppError(409, 'open_as_admin_active', 'End setting up as Townwise staff first');
}

/** The guard's answer under a live grant of this kind. */
function grantActive(kind: GrantRecord['kind']): AppError {
  return kind === 'open_as_admin' ? openAsAdminActive() : new AppError(409, 'view_as_active', 'End view-as first');
}

/**
 * Clears the grant still holding this session when it is no longer live (expired, its organization out of setup, or its
 * view-as target moved), recording its end. Under a live grant the guard has already answered 409, but another tab of
 * this session may have started one since: that one is refused with the guard's 409, never replaced, so the session's
 * other tabs never move to another organization between two requests. Liveness is the resolver's alone.
 */
async function clearNotLive(ctx: TownwiseContext, req: Request, actor: StaffActor): Promise<void> {
  const held = await ctx.stores.grants.findBySession(actor.sessionId);
  if (held === null) return;
  const resolution = await resolveAccess(ctx, authOf(req));
  if (resolution.openAsAdmin !== null) throw grantActive('open_as_admin');
  if (resolution.viewAs !== null) throw grantActive('view_as');
  await clearGrant(ctx, actor, (grant, now) => {
    // A grant holds one session at most once, so `held` held it throughout and the resolver found it not live. Any other
    // grant was stored after that read, by a start racing this one.
    if (grant.id !== held.id) throw grantActive(grant.kind);
    return grant.expiresAt.getTime() <= now.getTime() ? 'expired' : 'replaced';
  });
}

/** POST /api/admin/orgs/:orgId/open-as-admin, no body: 201 with the organization's admin access and `openAsAdmin` set. */
export async function startOpenAsAdmin(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope, org } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  if (!(await isInSetup(ctx, scope, org))) throw notInSetup();

  await clearNotLive(ctx, req, staff.actor);

  const now = ctx.now();
  const grantId = new Types.ObjectId().toHexString();
  const event: AuditEventInput = {
    ...actorOf(staff), viewAsGrantId: grantId, at: now, orgId: scope.orgId, action: 'open_as_admin.started',
    target: { type: 'grant', id: grantId },
    details: {},
  };
  const eventId = await recordBefore(ctx, event);
  const inserted = await applyRecorded(ctx, event, eventId, () => ctx.stores.grants.insertOpenAsAdmin({
    id: grantId, actorUserId: staff.actor.userId, sessionId: staff.actor.sessionId, orgId: scope.orgId, startedAt: now,
    expiresAt: new Date(staff.actor.verifiedUntil),
  }));
  if (!inserted) {
    // Another tab of this session started a grant at the same moment.
    await recordNotApplied(ctx, event, eventId, 'open_as_admin_active');
    throw openAsAdminActive();
  }
  res.status(201).json(meResponse(await resolveAccess(ctx, authOf(req))));
}
