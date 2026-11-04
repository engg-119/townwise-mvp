// View-as Start and End (spec F8, Section 8, 10.7). Start has policy `staff`; End has `staff_self`, the only
// route that runs during view-as (7.2). View-as writes nothing except its own start and end: the guard refuses
// every other write while a grant is live. view_as.started is written before the grant exists (9.3), so no grant
// is ever unrecorded; view_as.ended is written after the grant is cleared.
import { authOf } from '@ckeith26/auth';
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { applyRecorded, recordAfter, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { Principal, StaffActor } from '../access/policy.ts';
import { resolveAccess, resolvePerson } from '../access/resolve.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { GrantEndReason, ViewAsGrantRecord } from '../stores/view-as-grants.ts';
import { meResponse } from './me.ts';

/** D8. [CONFIRM: 30 minutes] */
const VIEW_AS_MS = 30 * 60 * 1000;

const startBody = z.object({ userId: objectId, reason: z.string().trim().min(5).max(200) });
const endBody = z.object({});

function staffActor(actor: StaffActor, grantId: string): Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'> {
  return { actorUserId: actor.userId, actorEmail: actor.email, actorRole: 'superadmin', viewAsGrantId: grantId };
}

/** Ends the grant still holding the staff member's session, live or expired, and records its end. */
async function clearGrant(
  ctx: TownwiseContext,
  actor: StaffActor,
  reasonFor: (grant: ViewAsGrantRecord, now: Date) => GrantEndReason,
): Promise<void> {
  const grant = await ctx.stores.grants.findBySession(actor.sessionId);
  if (grant === null) return;
  const now = ctx.now();
  const endReason = reasonFor(grant, now);
  if (!(await ctx.stores.grants.end(grant.id, actor.sessionId, { endedAt: now, endReason }))) return;
  await recordAfter(ctx, {
    ...staffActor(actor, grant.id), at: now, orgId: grant.orgId, action: 'view_as.ended',
    target: { type: 'grant', id: grant.id },
    details: { endReason },
  });
}

/** POST /api/admin/view-as { userId, reason }: 201 with the target's access and `viewAs` set. */
export async function startViewAs(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  if (principal.kind !== 'staff') throw new AppError(403, 'forbidden', 'Forbidden');
  const { actor } = principal;
  const body = parseInput(startBody, req.body);
  const target = await ctx.authStores.users.findById(body.userId.toLowerCase());
  if (target === null) throw new AppError(404, 'not_found', 'Not found');
  if (ctx.config.superadminEmails.has(target.email)) throw new AppError(400, 'invalid_target', 'Staff accounts cannot be viewed as');
  // The grant is live only while the target's resolved organization still equals this one (4.2 step 2.4).
  const orgId = (await resolvePerson(ctx, target)).seat?.orgId ?? null;

  // Under a live grant the guard has already answered 409, so this clears a grant that expired without End,
  // or one ignored because its target changed organization.
  await clearGrant(ctx, actor, (grant, now) => (grant.expiresAt.getTime() <= now.getTime() ? 'expired' : 'replaced'));

  const now = ctx.now();
  const grantId = new Types.ObjectId().toHexString();
  const expiresAt = new Date(now.getTime() + VIEW_AS_MS);
  const event: AuditEventInput = {
    ...staffActor(actor, grantId), at: now, orgId, action: 'view_as.started',
    target: { type: 'grant', id: grantId },
    details: { targetUserId: target.id, targetEmail: target.email, reason: body.reason, expiresAt: expiresAt.toISOString() },
  };
  const eventId = await recordBefore(ctx, event);
  const inserted = await applyRecorded(ctx, event, eventId, () => ctx.stores.grants.insert({
    id: grantId, actorUserId: actor.userId, sessionId: actor.sessionId, targetUserId: target.id, orgId,
    reason: body.reason, startedAt: now, expiresAt,
  }));
  if (!inserted) {
    // Another tab of this session started a grant at the same moment.
    await recordNotApplied(ctx, event, eventId, 'view_as_active');
    throw new AppError(409, 'view_as_active', 'End view-as first');
  }
  res.status(201).json(meResponse(await resolveAccess(ctx, authOf(req))));
}

/** POST /api/admin/view-as/end {}: idempotent; 200 with the staff member's own access. */
export async function endViewAs(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  // staff_self passed: a staff principal, or any principal in view-as, whose actor is the staff member.
  const actor = principal.kind === 'staff' ? principal.actor : principal.viewAs?.actor;
  if (actor === undefined) throw new AppError(403, 'forbidden', 'Forbidden');
  parseInput(endBody, req.body);
  await clearGrant(ctx, actor, (grant, now) => (grant.expiresAt.getTime() <= now.getTime() ? 'expired' : 'ended'));
  res.status(200).json(meResponse(await resolveAccess(ctx, authOf(req))));
}
