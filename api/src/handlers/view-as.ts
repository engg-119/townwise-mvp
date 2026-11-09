// View-as Start and End (spec F8, Section 8, 10.7). Start has policy `staff`; End has `staff_self`, the only
// route that runs during view-as (7.2). View-as writes nothing except its own start and end: the guard refuses
// every other write while a grant is live. view_as.started is written before the grant exists (9.3), so no grant
// is ever unrecorded; view_as.ended is written after the grant is cleared. End also ends open as admin (D25,
// open-as-admin.ts), whose grant holds the session the same way, and records open_as_admin.ended for it.
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
import type { GrantEndReason, GrantRecord } from '../stores/view-as-grants.ts';
import { meResponse } from './me.ts';

/** D8. [CONFIRM: 30 minutes] */
const VIEW_AS_MS = 30 * 60 * 1000;

const startBody = z.object({ userId: objectId, reason: z.string().trim().min(5).max(200) });
const endBody = z.object({});

function staffActor(actor: StaffActor, grantId: string): Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'> {
  return { actorUserId: actor.userId, actorEmail: actor.email, actorRole: 'superadmin', viewAsGrantId: grantId };
}

/**
 * Ends the grant still holding the staff member's session, live or expired, of either kind, and records its end:
 * open_as_admin.ended for an open-as-admin grant (D25), view_as.ended otherwise.
 */
export async function clearGrant(
  ctx: TownwiseContext,
  actor: StaffActor,
  reasonFor: (grant: GrantRecord, now: Date) => GrantEndReason,
): Promise<void> {
  const grant = await ctx.stores.grants.findBySession(actor.sessionId);
  if (grant === null) return;
  const now = ctx.now();
  const endReason = reasonFor(grant, now);
  if (!(await ctx.stores.grants.end(grant.id, actor.sessionId, { endedAt: now, endReason }))) return;
  await recordAfter(ctx, {
    ...staffActor(actor, grant.id), at: now, orgId: grant.orgId,
    action: grant.kind === 'open_as_admin' ? 'open_as_admin.ended' : 'view_as.ended',
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
  // or one ignored because its target changed organization (or, open as admin, its organization left setup).
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

/** The staff member behind a principal that passed staff_self: staff, in view-as, or in open as admin (D25). */
function endActor(principal: Principal): StaffActor | undefined {
  if (principal.kind === 'staff') return principal.actor;
  if (principal.kind === 'member' && principal.openAsAdmin !== null) return principal.openAsAdmin.actor;
  return principal.viewAs?.actor;
}

/** POST /api/admin/view-as/end {}: ends view-as or open as admin; idempotent; 200 with the staff member's own access. */
export async function endViewAs(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const actor = endActor(principal);
  if (actor === undefined) throw new AppError(403, 'forbidden', 'Forbidden');
  parseInput(endBody, req.body);
  await clearGrant(ctx, actor, (grant, now) => (grant.expiresAt.getTime() <= now.getTime() ? 'expired' : 'ended'));
  res.status(200).json(meResponse(await resolveAccess(ctx, authOf(req))));
}
