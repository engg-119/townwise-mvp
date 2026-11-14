// Deletion (spec D22, F13, 10.7): staff delete a person's Townwise records, or a suspended organization's. Both follow
// the staff audit rule (9.3): read-only checks, then the event (ids only), then the effect, which deletes by filter so
// a retry completes the work, and then redacts the email or names in older events. The tuning chat's records go too,
// and so do forecast runs (U13B); a person's deletion clears their staff id from the runs they imported or published.
// The kit has no user delete (spec 19, item 7): a deleted person's kit user record is deleted by hand afterwards, as a
// runbook step (api/README.md).
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { applyRecorded, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForStaffOrg, type Principal } from '../access/policy.ts';
import { purgeEveryOriginal, removeStoredFiles, type RemovedFiles } from '../files/remove.ts';
import { normalizeEmail } from '../normalize-email.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import { deletePersonRecords, findActiveSeat, peopleRecords } from '../stores/cross-tenant.ts';
import { actorOf, notFound, staffOf } from './admin.ts';
import { removeWholeFile } from './files.ts';

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
    // Stored files first (spec 11A): when they are off but rows exist, nothing is deleted and the deletion is refused,
    // so blobs are never left behind silently.
    const files = await removeStoredFiles(stores, ctx.files, scope, null);
    if (files === 'files_unavailable') return 'files_unavailable' as const;
    await stores.uploadDays.removeForOrg(scope);
    await stores.filesUsage.removeForOrg(scope);
    const firstDays = await stores.salesDays.removeForOrg(scope);
    const deletedUploads = await stores.uploads.removeForOrg(scope);
    const deletedNotes = await stores.notes.removeForOrg(scope);
    // D31, business rules.
    await stores.businessRules.removeForOrg(scope);
    await stores.chatConversations.removeForOrg(scope);
    await stores.chatLiveTurns.removeForOrg(scope);
    await stores.chatUsage.removeForOrg(scope);
    await stores.welcomes.removeForOrg(scope);
    await stores.chatProposals.removeForOrg(scope);
    // U9, TownwiseAI's questions.
    await stores.agentAnswers.removeForOrg(scope);
    // The forecast lab: calibrations, before the runs.
    await stores.calibrations.removeForOrg(scope);
    // U13B: forecast runs and their rows.
    await stores.forecasts.removeForOrg(scope);
    const deletedLocations = await stores.locations.removeForOrg(scope);
    const deletedSeats = await stores.members.removeForOrg(scope);
    if (org.fromRequestId !== null) await stores.requests.remove(org.fromRequestId);
    const redactedEvents = await stores.audit.redact({ kind: 'org', orgId: scope.orgId, requestId: org.fromRequestId });
    // A row still there after a failed removal was reactivated; a missing one was deleted by a concurrent retry.
    if (!(await stores.orgs.remove(scope)) && (await stores.orgs.findById(scope.orgId)) !== null) return null;
    // A reader mid-file can write a cleaned copy after the first pass, and an upload in flight its last chunk: the
    // stored files are swept again, and the daily sweep's orphan check catches anything later still.
    const late = await removeStoredFiles(stores, ctx.files, scope, null);
    logFiles(ctx, scope.orgId, files, late === 'files_unavailable' ? { deletedFiles: 0, deletedBlobs: 0 } : late);
    // With the row gone no new request starts, so this second sweep catches sales days and chat usage that requests
    // already running wrote after the first. It narrows the gap, not closes it: a tuning chat turn started before the
    // suspension can still add chat usage for up to 150 seconds (its time limit), an upload still running can write
    // days after this sweep, and its tw_uploads row, if written after the first sweep, is never swept. Those rows
    // carry only the deleted organization's id.
    const lateDays = await stores.salesDays.removeForOrg(scope);
    await stores.chatUsage.removeForOrg(scope);
    await stores.calibrations.removeForOrg(scope);
    // U13B: a staff forecast import already past its organization check can still write a run and rows.
    await stores.forecasts.removeForOrg(scope);
    return { deletedDays: firstDays + lateDays, deletedUploads, deletedNotes, deletedLocations, deletedSeats, redactedEvents };
  });
  if (counts === 'files_unavailable') {
    await recordNotApplied(ctx, event, eventId, 'files_unavailable');
    throw new AppError(503, 'files_unavailable', 'Stored files are off, so the organization’s files cannot be deleted');
  }
  if (counts === null) {
    await recordNotApplied(ctx, event, eventId, 'org_not_suspended');
    throw new AppError(409, 'org_not_suspended', 'The organization was reactivated while it was being deleted');
  }
  res.status(200).json(counts);
}

function logFiles(ctx: TownwiseContext, orgId: string, first: RemovedFiles, late: RemovedFiles): void {
  const deletedFiles = first.deletedFiles + late.deletedFiles;
  const deletedBlobs = first.deletedBlobs + late.deletedBlobs;
  if (deletedFiles > 0 || deletedBlobs > 0) ctx.logger.info({ orgId, deletedFiles, deletedBlobs }, 'townwise.org_files_deleted');
}

/** An enum, never free text, so no diner's or server's name can land in the audit log. */
const purgeBody = z.strictObject({ basis: z.enum(['data_subject_request', 'org_request', 'other']) });

/**
 * POST /api/admin/orgs/:orgId/originals/delete { basis } (spec 11A): every original file of the organization, for a
 * person's deletion request (a diner, a server or anyone named in an export), without anyone reading the files.
 * Recorded before the effect by the staff rule; the cleaned copies, reports and days stay, since they hold dates and
 * numbers only. A file not read yet is kept unread (`raw_deleted`) and its original deleted now; one still uploading or
 * being read is flagged, and its original goes as soon as that ends (files/remove.ts purgeOriginal). What TownwiseAI
 * read in each file goes with its original (spec 11A.9): the answer's summary, facts, events and days on the file, and
 * the summary items its reads kept on Your data, removed whole (their text came from the file); the notes and days it
 * wrote stay, as days a file wrote do.
 */
export async function purgeOriginals(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  const { basis } = parseInput(purgeBody, req.body);
  const originals = [...await ctx.stores.files.originals(scope, null), ...await ctx.stores.files.uploading(scope, null)];
  const blobs = ctx.files;
  if (originals.length > 0 && blobs === null) throw new AppError(503, 'files_unavailable', 'Stored files are off');
  const event: AuditEventInput = {
    ...actorOf(staff), at: ctx.now(), orgId: scope.orgId, action: 'org.originals_deleted',
    target: { type: 'org', id: scope.orgId },
    details: { count: originals.length, basis },
  };
  const eventId = await recordBefore(ctx, event);
  let deletedSummaries = 0;
  const result = blobs === null
    ? { deletedOriginals: 0, skippedBusy: 0 }
    : await applyRecorded(ctx, event, eventId, async () => {
      const purged = await purgeEveryOriginal(ctx.stores, blobs, scope, originals, ctx.now());
      for (const summary of await ctx.stores.files.fromAiReads(scope, originals.map((file) => file.id))) {
        await removeWholeFile(ctx, blobs, scope, summary, { resume: true });
        deletedSummaries += 1;
      }
      return purged;
    });
  // A waiting file's question was dropped: its import is queued again, for the reader to finish.
  ctx.nudgeFiles();
  ctx.logger.info({ orgId: scope.orgId, count: result.deletedOriginals, skippedBusy: result.skippedBusy, deletedSummaries, by: 'staff' }, 'townwise.originals_deleted');
  res.status(200).json(result);
}

/**
 * POST /api/admin/people/delete { email }: a person with no active seat (409 person_has_seat; staff remove the seat
 * first, and the last-admin rule applies there). A seat taken while the deletion runs, by a join or an approval, before
 * a second check after the records are deleted is found by it, and the answer is then 409 person_has_seat, recorded as
 * not applied, before any session is revoked or event redacted. After that check, an approval that seats the person
 * reads the request again, finds it deleted here, and takes the seat back (approveRequest); a join needs an
 * invitation, and this deleted theirs, so only one added afterwards can seat them, which the runbook's check before
 * the kit user is deleted catches (api/README.md). 404 when the
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
