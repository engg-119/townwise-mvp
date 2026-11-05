// Deletion (spec D22, F13, 10.7): staff delete a person's Townwise records, or a suspended organization's. Both follow
// the staff audit rule (9.3): read-only checks, then the event (ids only), then the effect, which deletes by filter so
// a retry completes the work, and then redacts the email or names in older events. The tuning chat's records go too.
// The kit has no user delete (spec 19, item 7): a deleted person's kit user record is deleted by hand afterwards, as a
// runbook step (api/README.md).
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForStaffOrg, type Principal } from '../access/policy.ts';
import { normalizeEmail } from '../normalize-email.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import { deletePersonRecords, findActiveSeat, peopleRecords } from '../stores/cross-tenant.ts';
import { actorOf, notFound, staffOf } from './admin.ts';

function personHasSeat(): AppError {
  return new AppError(409, 'person_has_seat', 'Remove this person from their organization first');
}

/** In the body, never the path, because server-core logs the URL. */
const personBody = z.object({ email: z.string().max(320) });

/**
 * DELETE /api/admin/orgs/:orgId: only a suspended organization (409 org_not_suspended), so its members have already seen
 * the paused page. Former members then resolve to no_org. View-as grants keep only ids. The organization row goes last,
 * so a retry still finds it, and only while the organization is still suspended: one reactivated meanwhile keeps its
 * row (409 org_not_suspended, recorded as not applied), though the records already deleted stay deleted.
 * [CONFIRM: staff-only deletion in v1; suspend before deleting an organization]
 */
export async function deleteOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope, org } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  if (org.status !== 'suspended') throw new AppError(409, 'org_not_suspended', 'Suspend the organization before deleting it');
  const event: AuditEventInput = {
    ...actorOf(staff), at: ctx.now(), orgId: scope.orgId, action: 'org.deleted',
    target: { type: 'org', id: scope.orgId },
    details: {},
  };
  const eventId = await recordBefore(ctx, event);
  const counts = await applyRecorded(ctx, event, eventId, async () => {
    const { stores } = ctx;
    const firstDays = await stores.salesDays.removeForOrg(scope);
    const deletedUploads = await stores.uploads.removeForOrg(scope);
    const deletedNotes = await stores.notes.removeForOrg(scope);
    await stores.chatConversations.removeForOrg(scope);
    await stores.chatLiveTurns.removeForOrg(scope);
    await stores.chatUsage.removeForOrg(scope);
    const deletedLocations = await stores.locations.removeForOrg(scope);
    const deletedSeats = await stores.members.removeForOrg(scope);
    if (org.fromRequestId !== null) await stores.requests.remove(org.fromRequestId);
    const redactedEvents = await stores.audit.redact({ kind: 'org', orgId: scope.orgId, requestId: org.fromRequestId });
    // A row still there after a failed removal was reactivated; a missing one was deleted by a concurrent retry.
    if (!(await stores.orgs.remove(scope)) && (await stores.orgs.findById(scope.orgId)) !== null) return null;
    // An upload or tuning chat turn in flight when the first sweep ran can upsert after it; with the organization
    // gone, no new one starts, so a second sweep leaves nothing behind.
    const lateDays = await stores.salesDays.removeForOrg(scope);
    await stores.chatUsage.removeForOrg(scope);
    return { deletedDays: firstDays + lateDays, deletedUploads, deletedNotes, deletedLocations, deletedSeats, redactedEvents };
  });
  if (counts === null) {
    await recordNotApplied(ctx, event, eventId, 'org_not_suspended');
    throw new AppError(409, 'org_not_suspended', 'The organization was reactivated while it was being deleted');
  }
  res.status(200).json(counts);
}

/**
 * POST /api/admin/people/delete { email }: a person with no active seat (409 person_has_seat; staff remove the seat
 * first, and the last-admin rule applies there). A seat taken while the deletion runs (a join, an approval) is found
 * by a second check after the records are deleted, and the answer is then 409 person_has_seat, recorded as not
 * applied, before any session is revoked or event redacted, so the kit user is never deleted under a seat. 404 when the
 * address has no kit user and Townwise holds nothing for it, audit events included, since the audit log keeps an
 * address until its person is deleted (spec 17). Notes and uploads the person wrote stay with their organization.
 * Until the kit user record is deleted by hand, the person can still continue with Google, and resolves to no_org.
 */
export async function deletePerson(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const email = normalizeEmail(parseInput(personBody, req.body).email);
  if (email === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  if (ctx.config.superadminEmails.has(email)) throw new AppError(400, 'invalid_target', 'Staff accounts can’t be deleted from the console');
  const user = await ctx.authStores.users.findByEmail(email);
  const userId = user?.id ?? null;
  if (userId !== null && await findActiveSeat(ctx.connection, userId) !== null) throw personHasSeat();
  if (userId === null) {
    const { invites } = await peopleRecords(ctx.connection, { userId: null, email });
    if (invites.length === 0 && !(await ctx.stores.audit.namesPerson({ userId: null, email }))) throw notFound();
  }
  const event: AuditEventInput = {
    ...actorOf(staff), at: ctx.now(), orgId: null, action: 'person.deleted',
    // An address that never signed in has no user id; the event then names no one.
    target: { type: 'user', id: userId ?? 'none' },
    details: { userId },
  };
  const eventId = await recordBefore(ctx, event);
  const counts = await applyRecorded(ctx, event, eventId, async () => {
    // Read before they go: the person's seats and requests name addresses they had before this one.
    const known = await peopleRecords(ctx.connection, { userId, email });
    const deleted = await deletePersonRecords(ctx.connection, { userId, email });
    if (userId !== null && await findActiveSeat(ctx.connection, userId) !== null) return null;
    if (userId !== null) {
      await ctx.auth.revokeAllSessions(userId);
      await ctx.authStores.totp.remove(userId);
    }
    const redactedEvents = await ctx.stores.audit.redact({
      kind: 'person', userId, email,
      formerEmails: [...known.seats.map((seat) => seat.email), ...known.requests.map((request) => request.emailAtRequest)],
      seatIds: known.seats.map((seat) => seat.id),
    });
    return { deletedRequests: deleted.requests, deletedSeats: deleted.seats, redactedEvents, kitUserId: userId };
  });
  if (counts === null) {
    await recordNotApplied(ctx, event, eventId, 'person_has_seat');
    throw personHasSeat();
  }
  res.status(200).json(counts);
}
