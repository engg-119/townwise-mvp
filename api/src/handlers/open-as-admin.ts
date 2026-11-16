// Open as admin, Start (D25, spec 10.7). Staff open an active organization as its admin, before or after anyone joins
// it (owner call, 2026-11-15): the grant holds the staff member's session in tw_view_as_grants (kind open_as_admin),
// and while it is live the resolver answers the organization's org admin access (access/resolve.ts). It ends at End
// (POST /api/admin/view-as/end, shared with view-as), at sign-out, when the staff window closes, and when the
// organization is suspended. It is used with a client's data only with that client's consent. Once anyone has joined
// (hasEverJoined, staff setup's notion) it asks a reason, as view-as does (5 to 200 characters), stored on the grant and
// in open_as_admin.started (owner call, 2026-11-15); before that it asks none. Its start (with the reason) and every
// change made in it are listed in the organization's Townwise staff activity. It has no timer of
// its own: the grant expires with the staff window (D2), which every staff request needs anyway.
// open_as_admin.started is written before the grant exists (9.3), so no grant is ever unrecorded.
import { authOf } from '@ckeith26/auth';
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForStaffOrg, type Principal, type StaffActor } from '../access/policy.ts';
import { resolveAccess } from '../access/resolve.ts';
import { hasEverJoined } from '../access/setup.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { GrantRecord } from '../stores/view-as-grants.ts';
import { actorOf, staffOf } from './admin.ts';
import { meResponse } from './me.ts';
import { clearGrant, endExpiredElsewhere } from './view-as.ts';

function openAsAdminActive(): AppError {
  return new AppError(409, 'open_as_admin_active', 'End setting up as Townwise staff first');
}

/** As view-as's reason (handlers/view-as.ts). Required once anyone has joined the organization; optional before. */
const startBody = z.object({ reason: z.string().trim().min(5).max(200).optional() });

function orgSuspended(): AppError {
  return new AppError(409, 'org_suspended', 'Open as admin is closed while the organization is suspended');
}

/** The guard's answer under a live grant of this kind. */
function grantActive(kind: GrantRecord['kind']): AppError {
  return kind === 'open_as_admin' ? openAsAdminActive() : new AppError(409, 'view_as_active', 'End view-as first');
}

/**
 * Clears the grant still holding this session when it is no longer live (expired, its organization suspended, or its
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

/**
 * POST /api/admin/orgs/:orgId/open-as-admin, no body or `{ reason }` (required once anyone has joined): 201 with the
 * organization's admin access and `openAsAdmin` set.
 */
export async function startOpenAsAdmin(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { reason } = parseInput(startBody, req.body ?? {});
  const { scope, org } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  if (org.status !== 'active') throw orgSuspended();
  if (reason === undefined && await hasEverJoined(ctx, scope, org)) {
    throw new AppError(400, 'reason_required', 'Give a reason: someone has joined this organization');
  }

  await clearNotLive(ctx, req, staff.actor);
  await endExpiredElsewhere(ctx, staff.actor);

  const now = ctx.now();
  const grantId = new Types.ObjectId().toHexString();
  const event: AuditEventInput = {
    ...actorOf(staff), viewAsGrantId: grantId, at: now, orgId: scope.orgId, action: 'open_as_admin.started',
    target: { type: 'grant', id: grantId },
    details: reason === undefined ? {} : { reason },
  };
  const eventId = await recordBefore(ctx, event);
  const inserted = await applyRecorded(ctx, event, eventId, () => ctx.stores.grants.insertOpenAsAdmin({
    id: grantId, actorUserId: staff.actor.userId, sessionId: staff.actor.sessionId, orgId: scope.orgId, startedAt: now,
    expiresAt: new Date(staff.actor.verifiedUntil), ...(reason === undefined ? {} : { reason }),
  }));
  if (!inserted) {
    // Another tab of this session started a grant at the same moment.
    await recordNotApplied(ctx, event, eventId, 'open_as_admin_active');
    throw openAsAdminActive();
  }
  res.status(201).json(meResponse(await resolveAccess(ctx, authOf(req))));
}
