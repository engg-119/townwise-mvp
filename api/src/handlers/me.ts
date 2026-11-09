// GET /api/me, POST /api/me/join, POST /api/me/decline, POST /api/me/welcome (spec 4.1, F1, F2b, 10.2, 15.8).
import { authOf } from '@ckeith26/auth';
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { isStaffPrincipal, resolutionOf, scopeForJoinedInvite, type Principal } from '../access/policy.ts';
import { resolveAccess, type Access, type Resolution, type Role } from '../access/resolve.ts';
import { claimInvite, declineInvite as deleteInvite } from '../stores/cross-tenant.ts';
import { memberOf } from './locations.ts';
import { welcomeFor, type WelcomeView } from '../welcome.ts';

export interface ViewAsView {
  id: string;
  target: { userId: string; email: string };
  org: { id: string; name: string } | null;
  role: Role | null;
  reason: string;
  startedAt: string;
  endsAt: string;
}

export interface MeResponse {
  /** Always the signed-in person; during view-as, the staff actor. */
  user: { id: string; email: string };
  /** During view-as: the target's access. */
  access: Access;
  viewAs: ViewAsView | null;
  /** Set whenever the signed-in person's own state is 'staff'. */
  staff: { verifiedUntil: string } | null;
  /** GET /api/me only: the first visit after approval (spec 15.8). Every other answer carries null. */
  welcome: WelcomeView | null;
}

export function meResponse(resolution: Resolution): MeResponse {
  const { user, seat, staffVerifiedUntil } = resolution;
  let viewAs: ViewAsView | null = null;
  if (resolution.viewAs !== null && staffVerifiedUntil !== null) {
    const { grant, target } = resolution.viewAs;
    viewAs = {
      id: grant.id,
      target: { userId: target.id, email: target.email },
      org: seat === null ? null : { id: seat.orgId, name: seat.orgName },
      role: seat?.role ?? null,
      reason: grant.reason,
      startedAt: grant.startedAt.toISOString(),
      // The 60-minute staff window ends view-as too.
      endsAt: new Date(Math.min(grant.expiresAt.getTime(), staffVerifiedUntil.getTime())).toISOString(),
    };
  }
  return {
    user: { id: user.id, email: user.email },
    access: resolution.effective,
    viewAs,
    staff: staffVerifiedUntil === null ? null : { verifiedUntil: staffVerifiedUntil.toISOString() },
    welcome: null,
  };
}

const inviteBody = z.object({ inviteId: objectId });

/** A person who may join or decline: anyone signed in except a staff address (they never resolve as members). */
function invitee(principal: Principal): { userId: string; email: string } {
  if (principal.kind === 'staff' || isStaffPrincipal(principal)) throw new AppError(403, 'forbidden', 'Forbidden');
  return { userId: principal.userId, email: principal.email };
}

export async function getMe(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  res.status(200).json({ ...meResponse(resolutionOf(req)), welcome: await welcomeFor(ctx, principal) });
}

/**
 * POST /api/me/welcome (spec 15.8): the client showed the welcome, so GET /api/me answers welcome null from now on,
 * on every device. Idempotent; no body, no audit event (a display marker, not an action). The view-as guard refuses
 * it, so the member is the signed-in person.
 */
export async function recordWelcome(ctx: TownwiseContext, _req: Request, res: Response, principal: Principal): Promise<void> {
  const member = memberOf(principal);
  await ctx.stores.welcomes.record(member.scope, member.userId, ctx.now());
  res.status(204).end();
}

export async function joinInvite(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = invitee(principal);
  const { inviteId } = parseInput(inviteBody, req.body);
  const now = ctx.now();
  const claimed = await claimInvite(ctx.connection, { inviteId, email: caller.email, userId: caller.userId, now });
  if (claimed.kind === 'no_invite') throw new AppError(409, 'no_invite', 'Invitation not available');
  if (claimed.kind === 'already_in_org') throw new AppError(409, 'already_in_org', 'Already in an organization');
  const scope = scopeForJoinedInvite(claimed.seat);
  // D23: once anyone has joined, staff setup never reopens.
  await ctx.stores.orgs.markJoined(scope, now);
  const withdrawnRequestId = await ctx.stores.requests.withdrawPendingOnJoin(caller.userId, now);
  const actor = { actorUserId: caller.userId, actorEmail: caller.email, actorRole: claimed.seat.role, viewAsGrantId: null };
  await recordAfter(ctx, {
    ...actor, at: now, orgId: scope.orgId, action: 'member.joined',
    target: { type: 'member', id: claimed.seat.id },
    details: { email: caller.email, role: claimed.seat.role },
  });
  if (withdrawnRequestId !== null) {
    await recordAfter(ctx, {
      ...actor, at: now, orgId: null, action: 'access_request.withdrawn',
      target: { type: 'request', id: withdrawnRequestId },
      details: { reason: 'joined_org' },
    });
  }
  res.status(200).json(meResponse(await resolveAccess(ctx, authOf(req))));
}

export async function declineInvite(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = invitee(principal);
  const { inviteId } = parseInput(inviteBody, req.body);
  const now = ctx.now();
  const declined = await deleteInvite(ctx.connection, { inviteId, email: caller.email });
  if (declined === null) throw new AppError(409, 'no_invite', 'Invitation not available');
  await recordAfter(ctx, {
    actorUserId: caller.userId, actorEmail: caller.email, actorRole: 'user', viewAsGrantId: null,
    at: now, orgId: declined.orgId, action: 'member.declined',
    target: { type: 'member', id: declined.id },
    details: { email: caller.email },
  });
  res.status(200).json(meResponse(await resolveAccess(ctx, authOf(req))));
}
