// Staff console (spec 10.7): requests (F3, F4: list, approve, reject), organizations (F10: create, rename, suspend,
// reactivate) and their teams, people (sign out everywhere) and the audit log. Deletion is in deletion.ts.
// Every route here has policy `staff`. Staff events are written before the effect (spec 9.3): read-only checks,
// then the event, then the change.
import type { User } from '@ckeith26/auth';
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import {
  applyRecorded, applyRecordedAll, auditEventViews, recordAfter, recordAllBefore, recordBefore, recordNotApplied, type Recorded,
} from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForNewOrg, scopeForStaffOrg, type OrgScope, type Principal, type StaffPrincipal } from '../access/policy.ts';
import { requestView, type AccessRequestView } from '../access/resolve.ts';
import { isInSetup } from '../access/setup.ts';
import { endGoogleAccess, googleAccessDeps, markPersonForCheck } from '../calendar/google-access.ts';
import { normalizeEmail } from '../normalize-email.ts';
import { currentEmail } from '../people.ts';
import type { AccessRequestRecord } from '../stores/access-requests.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction, type AuditEventInput } from '../stores/audit-events.ts';
import {
  adminOrgStats, findActiveSeat, NO_ORG_STATS, peopleRecords,
  type PeopleRecords, type PersonInvite, type PersonRequest, type PersonSeat,
} from '../stores/cross-tenant.ts';
import { locationNameKey } from '../stores/locations.ts';
import type { OrgRecord } from '../stores/orgs.ts';
import { NO_COVERAGE } from '../stores/sales-days.ts';
import { MAX_LOCATIONS } from './locations.ts';
import {
  addBody, addOutcomes, assertRoomFor, changeActiveRole, emailOf, lastAdmin, memberView, removeActiveSeat, roleBody, teamView,
  type AddResult, type SeatRemoval,
} from './team.ts';

export type AdminRequestView = AccessRequestView & {
  requester: { userId: string; email: string };
  emailAtRequest: string;
  requesterHasOrg: boolean;
  decidedBy: { email: string } | null;
  orgId: string | null;
};

const listQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending') });
const nameSchema = z.string().trim().min(1).max(80);
/** `locationName` for a request with no places, `locationNames` for one with places (locationNamesFor). */
const approveBody = z.object({
  orgName: z.string().trim().min(2).max(120),
  locationName: nameSchema.optional(),
  locationNames: z.array(nameSchema).min(1).max(MAX_LOCATIONS).optional(),
});
type ApproveBody = z.infer<typeof approveBody>;
const rejectBody = z.object({ message: z.string().trim().max(500).nullish() });

export function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** The staff policy already passed; this narrows the principal for the handler. */
export function staffOf(principal: Principal): StaffPrincipal {
  if (principal.kind !== 'staff') throw new AppError(403, 'forbidden', 'Forbidden');
  return principal;
}

export function actorOf(staff: StaffPrincipal): Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'> {
  return { actorUserId: staff.actor.userId, actorEmail: staff.actor.email, actorRole: 'superadmin', viewAsGrantId: null };
}

async function adminRequestView(ctx: TownwiseContext, record: AccessRequestRecord): Promise<AdminRequestView> {
  return {
    ...requestView(record),
    requester: { userId: record.userId, email: await currentEmail(ctx, record.userId) },
    emailAtRequest: record.emailAtRequest,
    requesterHasOrg: (await findActiveSeat(ctx.connection, record.userId)) !== null,
    decidedBy: record.decidedBy === null ? null : { email: await currentEmail(ctx, record.decidedBy) },
    orgId: record.orgId,
  };
}

async function reloaded(ctx: TownwiseContext, requestId: string): Promise<AdminRequestView> {
  const record = await ctx.stores.requests.findById(requestId);
  if (record === null) throw notFound();
  return adminRequestView(ctx, record);
}

export async function listRequests(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  staffOf(principal);
  const { status } = parseInput(listQuery, req.query);
  const records = await ctx.stores.requests.listByStatus(status);
  const requests = await Promise.all(records.map((record) => adminRequestView(ctx, record)));
  res.status(200).json({ requests, pendingCount: await ctx.stores.requests.countPending() });
}

/**
 * Takes back the seat an approval gave a person whose request was deleted meanwhile (person deletion), and, when
 * nobody else is in it, the organization and the locations made only for that request, with their names in the
 * audit log, as organization deletion does.
 */
async function undoApproval(ctx: TownwiseContext, scope: OrgScope, requestId: string, seatId: string): Promise<void> {
  const { stores } = ctx;
  await stores.members.deleteSeat(scope, seatId);
  if (await stores.members.countSeats(scope) > 0) return;
  // D66: research of those locations, runs and threads first (the weekly planner may have queued a run for the new,
  // active organization meanwhile).
  await stores.researchLocations.removeForOrg(scope);
  await stores.researchRevisions.removeForOrg(scope);
  await stores.locations.removeForOrg(scope);
  await stores.audit.redact({ kind: 'org', orgId: scope.orgId, requestId });
  await stores.orgs.removeFromRequest(scope, requestId);
}

/**
 * The location names step 7 uses. A request with places takes `locationNames`, one per place in the same order and
 * unique by name key, since two names with one key would be one location (`ensureByName`); a request without takes
 * `locationName`. Any other body is 400, before anything is written.
 */
function locationNamesFor(request: AccessRequestRecord, body: ApproveBody): string[] {
  const { locationName, locationNames } = body;
  if (request.places.length === 0) {
    if (locationName !== undefined && locationNames === undefined) return [locationName];
  } else if (locationNames !== undefined && locationName === undefined && locationNames.length === request.places.length
    && new Set(locationNames.map(locationNameKey)).size === locationNames.length) {
    return locationNames;
  }
  throw new AppError(400, 'invalid_request', 'Invalid request');
}

/**
 * F3. A request already approved with an organization skips to step 6, so a retry completes the work. After it seats
 * the requester, it reads the request again: person deletion deletes the request before its own second check for a
 * seat, so a request gone now means a seat given after that check, which is taken back (undoApproval) before
 * member.joined is written, and the answer is 404, recorded as not applied.
 */
export async function approveRequest(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const requestId = parseInput(objectId, req.params.requestId);
  const body = parseInput(approveBody, req.body);
  const request = await ctx.stores.requests.findById(requestId);
  if (request === null) throw notFound();
  const names = locationNamesFor(request, body);
  const requester = await ctx.authStores.users.findById(request.userId);
  if (requester === null) throw notFound();
  const actor = actorOf(staff);
  const now = ctx.now();

  let orgId = request.orgId;
  let approval: Recorded | null = null;
  if (request.status !== 'approved' || orgId === null) {
    if (request.status !== 'pending') throw new AppError(409, 'request_not_pending', 'The request was already decided');
    if (await findActiveSeat(ctx.connection, request.userId) !== null) {
      throw new AppError(409, 'requester_has_org', 'The requester already belongs to an organization');
    }
    orgId = new Types.ObjectId().toHexString();
    const event: AuditEventInput = {
      ...actor, at: now, orgId, action: 'access_request.approved',
      target: { type: 'request', id: requestId },
      details: { orgId },
    };
    const decision = { orgId, decidedAt: now, decidedBy: staff.actor.userId };
    const eventId = await recordBefore(ctx, event);
    if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.requests.markApproved(requestId, decision)))) {
      await recordNotApplied(ctx, event, eventId, 'request_not_pending');
      throw new AppError(409, 'request_not_pending', 'The request was already decided');
    }
    approval = { event, eventId };
  }

  // Follow-on records are written after their steps, as client events are (spec 9.3).
  const { org, inserted } = await ctx.stores.orgs.insertFromRequest({
    id: orgId, name: body.orgName, createdAt: now, createdBy: staff.actor.userId, fromRequestId: requestId,
  });
  if (inserted) {
    await recordAfter(ctx, {
      ...actor, at: now, orgId, action: 'org.created',
      target: { type: 'org', id: orgId },
      details: { name: org.name, via: 'request' },
    });
  }
  const scope = scopeForNewOrg(staff, org.id);
  // Step 7 runs only while the organization is new or not yet in use, so a retry finishes a stopped approval but never
  // adds a location to an organization in use (spec 3, 6.4), whatever names it sends. Without places, that means no
  // location and no people, and it makes the one location in the request's town. With places, it means no row records
  // a join, read as staff setup reads it (D23): the organization's `firstJoinedAt`, then any member row that
  // joined, removed seats included (a location count can't tell, since a stop partway leaves some places done), and
  // it makes a location for each place that has none yet. That path keys on the place id, not the name: a retry may
  // name a place differently, so a place with a location is skipped, and a name found on another place's location is
  // refused, never merged.
  if (request.places.length === 0) {
    if (inserted || (await ctx.stores.locations.count(scope) === 0 && await ctx.stores.members.countSeats(scope) === 0)) {
      for (const name of names) {
        const location = await ctx.stores.locations.ensureByName(scope, {
          name, town: request.town, placeId: null, createdAt: now, createdBy: staff.actor.userId,
        });
        if (location.inserted) {
          await recordAfter(ctx, {
            ...actor, at: now, orgId, action: 'location.created',
            target: { type: 'location', id: location.id },
            details: { name, townId: request.town.townId },
          });
        }
      }
    }
  } else if (inserted || (org.firstJoinedAt === null && !(await ctx.stores.members.anyJoined(scope)))) {
    const placed = new Set((await ctx.stores.locations.list(scope)).flatMap((l) => (l.placeId === null ? [] : [l.placeId])));
    for (const [i, place] of request.places.entries()) {
      const name = names[i];
      // locationNamesFor gives one name per place, so a mismatch is a bug: refuse it rather than leave a place out.
      if (name === undefined || names.length !== request.places.length) throw new Error('location names and places differ in length');
      if (placed.has(place.placeId)) continue;
      const location = await ctx.stores.locations.ensureByName(scope, {
        name, town: place.town, placeId: place.placeId, createdAt: now, createdBy: staff.actor.userId,
      });
      if (!location.inserted && location.placeId !== place.placeId) {
        throw new AppError(409, 'location_name_taken', 'Another location already uses that name');
      }
      if (location.inserted) {
        await recordAfter(ctx, {
          ...actor, at: now, orgId, action: 'location.created',
          target: { type: 'location', id: location.id },
          details: { name, townId: place.town.townId },
        });
      }
    }
  }
  const seat = await ctx.stores.members.insertAdminSeat(scope, {
    userId: requester.id, email: requester.email, joinedAt: now, invitedBy: staff.actor.userId,
  });
  if (seat.kind === 'elsewhere') {
    // The organization now exists with no admin; its detail page shows that.
    throw new AppError(409, 'requester_has_org', 'The requester already belongs to an organization');
  }
  if (seat.kind === 'inserted') {
    if (await ctx.stores.requests.findById(requestId) === null) {
      await undoApproval(ctx, scope, requestId, seat.id);
      if (approval !== null) await recordNotApplied(ctx, approval.event, approval.eventId, 'not_found');
      throw notFound();
    }
    // D23: once anyone has joined, staff setup never reopens.
    await ctx.stores.orgs.markJoined(scope, now);
    await recordAfter(ctx, {
      ...actor, at: now, orgId, action: 'member.joined',
      target: { type: 'member', id: seat.id },
      details: { email: requester.email, role: 'org_admin' },
    });
    ctx.mailer.send({ kind: 'request_approved', orgName: org.name, town: request.town }, requester.email, { requestId, orgId });
  } else {
    // A retry finds the seat a first try took, and finishes the mark if that try stopped before it.
    await ctx.stores.orgs.markJoined(scope, now);
  }
  res.status(200).json({ org: { id: org.id, name: org.name }, request: await reloaded(ctx, requestId) });
}

/** F4. The message is shown to the requester and never written to the audit log. */
export async function rejectRequest(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const requestId = parseInput(objectId, req.params.requestId);
  const body = parseInput(rejectBody, req.body);
  const request = await ctx.stores.requests.findById(requestId);
  if (request === null) throw notFound();
  if (request.status !== 'pending') throw new AppError(409, 'request_not_pending', 'The request was already decided');
  const message = body.message === undefined || body.message === null || body.message === '' ? null : body.message;
  const now = ctx.now();
  const event: AuditEventInput = {
    ...actorOf(staff), at: now, orgId: null, action: 'access_request.rejected',
    target: { type: 'request', id: requestId },
    details: { hasMessage: message !== null },
  };
  const eventId = await recordBefore(ctx, event);
  const decision = { decidedAt: now, decidedBy: staff.actor.userId, decisionMessage: message };
  if (!(await applyRecorded(ctx, event, eventId, () => ctx.stores.requests.markRejected(requestId, decision)))) {
    await recordNotApplied(ctx, event, eventId, 'request_not_pending');
    throw new AppError(409, 'request_not_pending', 'The request was already decided');
  }
  res.status(200).json({ request: await reloaded(ctx, requestId) });
}

// Organizations, people and the audit log (spec 10.7, P20 to P23). Staff reads here are not recorded (D7), and
// they carry counts, dates, emails and names only: never a sales figure or note text. Staff read those through view-as
// (D7), or by opening an organization as its admin (D25).

/** P21: the newest events on the organization's page. */
const RECENT_EVENTS = 20;
/** P22: the list stops here and says so. */
const MAX_PEOPLE = 1000;

export async function listOrgs(ctx: TownwiseContext, _req: Request, res: Response, principal: Principal): Promise<void> {
  staffOf(principal);
  const [orgs, stats] = await Promise.all([ctx.stores.orgs.list(), adminOrgStats(ctx.connection)]);
  res.status(200).json({
    orgs: orgs.map((org) => {
      const counts = stats.get(org.id) ?? NO_ORG_STATS;
      return {
        id: org.id, name: org.name, status: org.status, createdAt: org.createdAt.toISOString(),
        adminCount: counts.adminCount, memberCount: counts.memberCount, inviteCount: counts.inviteCount,
        locationCount: counts.locationCount, salesDayCount: counts.salesDayCount,
        lastUploadAt: counts.lastUploadAt?.toISOString() ?? null,
      };
    }),
  });
}

/** Spec 10.7: the organization as the console shows it. */
function staffOrgView(org: OrgRecord): Record<string, string | null> {
  return {
    id: org.id, name: org.name, status: org.status, createdAt: org.createdAt.toISOString(),
    fromRequestId: org.fromRequestId, suspendedAt: org.suspendedAt?.toISOString() ?? null,
  };
}

export async function getOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope, org } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  const [members, locations, coverage, notes, uploads, recent, request, inSetup] = await Promise.all([
    ctx.stores.members.list(scope),
    ctx.stores.locations.list(scope),
    ctx.stores.salesDays.coverageByLocation(scope),
    ctx.stores.notes.countByLocation(scope),
    ctx.stores.uploads.lastUploadByLocation(scope),
    ctx.stores.audit.query({ orgId: scope.orgId, limit: RECENT_EVENTS }),
    // For “From request {date}”; gone once its requester is deleted (spec 10.7, Deletion).
    org.fromRequestId === null ? null : ctx.stores.requests.findById(org.fromRequestId),
    isInSetup(ctx, scope, org),
  ]);
  res.status(200).json({
    org: { ...staffOrgView(org), fromRequestSentAt: request?.createdAt.toISOString() ?? null, inSetup },
    members: await Promise.all(members.map((member) => memberView(ctx, member, staff.actor.userId))),
    locations: locations.map((location) => ({
      id: location.id, name: location.name, town: location.town,
      // D47: whether it is linked to a Google place, never the id (D7: metadata only).
      hasPlace: location.placeId !== null,
      coverage: coverage.get(location.id) ?? NO_COVERAGE,
      notesCount: notes.get(location.id) ?? 0,
      lastUploadAt: uploads.get(location.id)?.toISOString() ?? null,
    })),
    recent: await auditEventViews(ctx, recent.events.slice(0, RECENT_EVENTS)),
  });
}

// Organizations and their teams from the console (F5, F6, F10, P20, P21). Each change is a staff action, shown to the
// organization's admins (D9): its event is written before the effect, and an effect that finds nothing to change or is
// refused adds staff_action.not_applied with the refusal's code (spec 9.3).

const orgName = z.string().trim().min(2).max(120);
/** `id`, generated by the client for each new organization, makes a repeat of the request (a retry) create nothing new. */
const createOrgBody = z.object({ name: orgName, adminEmail: z.string().max(320), id: objectId.optional() });
const updateOrgBody = z.object({ name: orgName.optional(), status: z.enum(['active', 'suspended']).optional() })
  .refine((body) => body.name !== undefined || body.status !== undefined);

function idTaken(): AppError {
  return new AppError(409, 'conflict', 'Another organization already has this id');
}

/**
 * POST /api/admin/orgs { name, adminEmail, id? } (F10): the organization and an org admin invitation added by staff. No
 * location: the admin's first page asks for one. With `id`, a repeat of this request answers 200 with the organization
 * it made and writes no second org.created (repeatCreate); any other organization with that id is 409 conflict.
 * [CONFIRM: staff can create organizations without a request]
 */
export async function createOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const body = parseInput(createOrgBody, req.body);
  const adminEmail = normalizeEmail(body.adminEmail);
  if (adminEmail === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  const actor = actorOf(staff);
  const now = ctx.now();
  const orgId = body.id?.toLowerCase() ?? new Types.ObjectId().toHexString();
  let org = await ctx.stores.orgs.findById(orgId);
  let created = false;
  if (org === null) {
    // The staff action's event is org.created; the invitation is a follow-on record, written after its step (spec 9.3).
    const event: AuditEventInput = {
      ...actor, at: now, orgId, action: 'org.created',
      target: { type: 'org', id: orgId },
      details: { name: body.name, via: 'staff' },
    };
    const eventId = await recordBefore(ctx, event);
    org = await applyRecorded(ctx, event, eventId, () => ctx.stores.orgs.insertByStaff({
      id: orgId, name: body.name, createdAt: now, createdBy: staff.actor.userId,
    }));
    created = org !== null;
    if (org === null) {
      // A concurrent repeat inserted it first; this one goes on as a repeat.
      await recordNotApplied(ctx, event, eventId, 'conflict');
      org = await ctx.stores.orgs.findById(orgId);
      if (org === null) throw notFound();
    }
  }
  const scope = scopeForNewOrg(staff, org.id);
  if (!created) {
    const outcome = await repeatCreate(ctx, staff, scope, org, { name: body.name, adminEmail });
    res.status(200).json({ org: { id: org.id, name: org.name }, result: { email: adminEmail, outcome } });
    return;
  }
  const memberId = await ctx.stores.members.insertInvite(scope, {
    email: adminEmail, role: 'org_admin', invitedAt: now, invitedBy: staff.actor.userId, addedByStaff: true,
  });
  if (memberId !== null) {
    await recordAfter(ctx, {
      ...actor, at: now, orgId, action: 'member.invited',
      target: { type: 'member', id: memberId },
      details: { email: adminEmail, role: 'org_admin' },
    });
  }
  const result: AddResult = { email: adminEmail, outcome: memberId === null ? 'already_invited' : 'invited' };
  res.status(201).json({ org: { id: org.id, name: org.name }, result });
}

/**
 * A repeat of POST /api/admin/orgs: only of an active organization this route made (no request) with the same name,
 * whose admin address is the one sent, or which has nobody yet. Otherwise 409 conflict. It adds nothing, except the
 * admin invitation when the organization has nobody yet (a create that stopped before it), recorded before its
 * insert as the console's team adds are. Resolves the admin address's outcome.
 */
async function repeatCreate(
  ctx: TownwiseContext, staff: StaffPrincipal, scope: OrgScope, org: OrgRecord, sent: { name: string; adminEmail: string },
): Promise<AddResult['outcome']> {
  if (org.fromRequestId !== null || org.status !== 'active' || org.name !== sent.name) throw idTaken();
  const people = await ctx.stores.members.list(scope);
  const admin = people.find((row) => row.email === sent.adminEmail);
  if (admin !== undefined) return admin.status === 'active' ? 'already_member' : 'already_invited';
  if (people.length > 0) throw idTaken();
  const id = new Types.ObjectId().toHexString();
  const event: AuditEventInput = {
    ...actorOf(staff), at: ctx.now(), orgId: scope.orgId, action: 'member.invited',
    target: { type: 'member', id },
    details: { email: sent.adminEmail, role: 'org_admin' },
  };
  const eventId = await recordBefore(ctx, event);
  const [inserted] = await applyRecorded(ctx, event, eventId, () => ctx.stores.members.insertInvites(scope, [{
    id, email: sent.adminEmail, role: 'org_admin', invitedAt: event.at, invitedBy: staff.actor.userId, addedByStaff: true,
  }]));
  if (inserted === true) return 'invited';
  await recordNotApplied(ctx, event, eventId, 'already_invited');   // a concurrent repeat got there first
  return 'already_invited';
}

/**
 * PATCH /api/admin/orgs/:orgId { name?, status? } (P21): rename, suspend or reactivate. A field that already matches
 * changes nothing and records nothing. Every event is written before either change, and both changes are one write,
 * so a refusal (503) never follows an applied change. Suspension keeps every record: members resolve to org_suspended
 * until reactivation, which restores access with no other step (F7).
 */
export async function updateOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope, org } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  const body = parseInput(updateOrgBody, req.body);
  const actor = actorOf(staff);
  const target = { type: 'org', id: scope.orgId } as const;
  const now = ctx.now();
  const changes: { name?: string; status?: 'active' | 'suspended' } = {};
  const events: AuditEventInput[] = [];
  if (body.name !== undefined && body.name !== org.name) {
    changes.name = body.name;
    events.push({ ...actor, at: now, orgId: scope.orgId, action: 'org.renamed', target, details: { from: org.name, to: body.name } });
  }
  if (body.status !== undefined && body.status !== org.status) {
    changes.status = body.status;
    events.push({
      ...actor, at: now, orgId: scope.orgId, action: body.status === 'suspended' ? 'org.suspended' : 'org.reactivated', target,
      details: {},
    });
  }
  if (events.length > 0) {
    const recorded = await recordAllBefore(ctx, events);
    if (!(await applyRecordedAll(ctx, recorded, () => ctx.stores.orgs.update(scope, changes, now)))) {
      for (const { event, eventId } of recorded) await recordNotApplied(ctx, event, eventId, 'not_found');
      throw notFound();
    }
  }
  const current = await ctx.stores.orgs.findById(scope.orgId);
  if (current === null) throw notFound();
  res.status(200).json({ org: staffOrgView(current) });
}

/**
 * POST /api/admin/orgs/:orgId/members (F5 from the console): as the org admin route, each row marked added by staff.
 * Every row's event is written before any row is added, and the rows are one write, so a refusal (503) never follows
 * an added row.
 */
export async function addOrgMembers(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  const body = parseInput(addBody, req.body);
  const results = await addOutcomes(ctx, scope, body.emails);
  const fresh = results.filter((r) => r.outcome === 'invited');
  await assertRoomFor(ctx, scope, fresh.length);
  const actor = actorOf(staff);
  const now = ctx.now();
  // Each row's id is chosen first, so the event written before the insert names it.
  const rows = fresh.map((result) => ({ result, id: new Types.ObjectId().toHexString() }));
  const recorded = await recordAllBefore(ctx, rows.map(({ result, id }): AuditEventInput => ({
    ...actor, at: now, orgId: scope.orgId, action: 'member.invited',
    target: { type: 'member', id },
    details: { email: result.email, role: body.role },
  })));
  const inserted = await applyRecordedAll(ctx, recorded, () => ctx.stores.members.insertInvites(scope, rows.map(({ result, id }) => ({
    id, email: result.email, role: body.role, invitedAt: now, invitedBy: staff.actor.userId, addedByStaff: true,
  }))));
  for (const [i, { event, eventId }] of recorded.entries()) {
    const row = rows[i];
    if (row === undefined || inserted[i] === true) continue;
    row.result.outcome = 'already_invited';   // a concurrent add got there first
    await recordNotApplied(ctx, event, eventId, 'already_invited');
  }
  res.status(200).json({ results, members: await teamView(ctx, scope, staff.actor.userId) });
}

/** PATCH /api/admin/orgs/:orgId/members/:memberId { role } (F6 from the console): change, recount, revert (changeActiveRole). */
export async function changeOrgMemberRole(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  const memberId = parseInput(objectId, req.params.memberId);
  const { role } = parseInput(roleBody, req.body);
  const member = await ctx.stores.members.find(scope, memberId);
  if (member === null) throw notFound();
  if (member.role !== role) {
    const event: AuditEventInput = {
      ...actorOf(staff), at: ctx.now(), orgId: scope.orgId, action: 'member.role_changed',
      target: { type: 'member', id: memberId },
      details: { email: await emailOf(ctx, member), from: member.role, to: role },
    };
    const eventId = await recordBefore(ctx, event);
    const outcome = await applyRecorded(ctx, event, eventId, () => changeActiveRole(ctx, scope, memberId, member.role, role));
    if (outcome === 'last_admin') {
      await recordNotApplied(ctx, event, eventId, 'last_admin');
      throw lastAdmin();
    }
    // A concurrent change or removal won; the answer shows what is there now.
    if (outcome === 'conflict') await recordNotApplied(ctx, event, eventId, 'conflict');
  }
  const current = await ctx.stores.members.find(scope, memberId);
  if (current === null) throw notFound();
  res.status(200).json({ member: await memberView(ctx, current, staff.actor.userId) });
}

/**
 * DELETE /api/admin/orgs/:orgId/members/:memberId (F6 from the console): an invitation is deleted; a seat is removed,
 * recounted and restored when no active admin is left (removeActiveSeat). The person's Google access for calendars
 * there is marked for a check before the seat goes and ended once it has (calendar/google-access.ts, as in
 * handlers/team.ts).
 */
export async function removeOrgMember(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  const memberId = parseInput(objectId, req.params.memberId);
  const member = await ctx.stores.members.find(scope, memberId);
  if (member === null) throw notFound();
  const now = ctx.now();
  const event: AuditEventInput = {
    ...actorOf(staff), at: now, orgId: scope.orgId, action: 'member.removed',
    target: { type: 'member', id: memberId },
    details: { email: await emailOf(ctx, member), wasStatus: member.status },
  };
  const eventId = await recordBefore(ctx, event);
  const google = googleAccessDeps(ctx);
  // Before the seat goes, as in handlers/team.ts: the mark is what lets the check finish an interrupted removal.
  const connectionId = member.status === 'active' ? await markPersonForCheck(google, scope, member.userId) : null;
  const outcome = await applyRecorded(ctx, event, eventId, async (): Promise<SeatRemoval['kind']> => {
    if (member.status === 'invited') return await ctx.stores.members.deleteInvite(scope, memberId) ? 'removed' : 'not_found';
    return (await removeActiveSeat(ctx, scope, memberId, member.userId, { removedAt: now, removedBy: staff.actor.userId })).kind;
  });
  if (outcome === 'not_found') {
    await recordNotApplied(ctx, event, eventId, 'not_found');
    throw notFound();
  }
  if (outcome === 'last_admin') {
    await recordNotApplied(ctx, event, eventId, 'last_admin');
    throw lastAdmin();
  }
  if (connectionId !== null) await endGoogleAccess(google, scope, connectionId, 'seat_removed');
  res.status(204).end();
}

type PersonKind = 'staff' | 'org_admin' | 'member' | 'invited' | 'pending' | 'rejected' | 'removed' | 'signed_in';

export interface PersonView {
  userId: string | null; email: string;
  kind: PersonKind;
  org: { id: string; name: string } | null;
  since: string | null;
  /** Staff rows only. */
  staffTwoStep: { state: 'on'; since: string } | { state: 'not_set_up' } | { state: 'not_signed_in' } | null;
}

const PERSON_KINDS = ['staff', 'org_admin', 'member', 'invited', 'pending', 'rejected', 'removed', 'signed_in'] as const;
const peopleQuery = z.object({ kind: z.enum(PERSON_KINDS).optional() });
const lookupQuery = z.object({ q: z.string().max(320) });

function latest<T>(items: readonly T[], time: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, item) => (best === undefined || time(item) > time(best) ? item : best), undefined);
}

/**
 * One person's row, in the order of spec 4.2 steps 3 to 7, so Kind is what the person resolves to: an active
 * seat, then invitations in active organizations, then a pending request, then the newer of a rejected request
 * and a removed seat, then signed in only. An address with no kit user is listed only for its invitations.
 */
function personView(user: User | null, email: string, records: PeopleRecords, orgs: ReadonlyMap<string, OrgRecord>): PersonView | null {
  const base = { userId: user?.id ?? null, email, staffTwoStep: null };
  const orgRef = (orgId: string): PersonView['org'] => {
    const org = orgs.get(orgId);
    return org === undefined ? null : { id: org.id, name: org.name };
  };
  const seat = records.seats.find((s) => s.status === 'active' && orgs.has(s.orgId));
  if (seat !== undefined) return { ...base, kind: seat.role, org: orgRef(seat.orgId), since: seat.joinedAt?.toISOString() ?? null };
  const invite = [...records.invites]
    .filter((i) => (user === null ? orgs.has(i.orgId) : orgs.get(i.orgId)?.status === 'active'))
    .sort((x, y) => x.invitedAt.getTime() - y.invitedAt.getTime())[0];
  if (invite !== undefined) return { ...base, kind: 'invited', org: orgRef(invite.orgId), since: invite.invitedAt.toISOString() };
  if (user === null) return null;
  const pending = records.requests.find((r) => r.status === 'pending');
  if (pending !== undefined) return { ...base, kind: 'pending', org: null, since: pending.createdAt.toISOString() };
  const rejected = latest(records.requests.filter((r) => r.status === 'rejected'), (r) => r.createdAt.getTime());
  const removed = latest(records.seats.filter((s) => s.status === 'removed'), (s) => s.removedAt?.getTime() ?? 0);
  const rejectedAt = rejected === undefined ? null : rejected.decidedAt ?? rejected.createdAt;
  if (removed?.removedAt != null && orgs.has(removed.orgId) && (rejectedAt === null || removed.removedAt >= rejectedAt)) {
    return { ...base, kind: 'removed', org: orgRef(removed.orgId), since: removed.removedAt.toISOString() };
  }
  if (rejectedAt !== null) return { ...base, kind: 'rejected', org: null, since: rejectedAt.toISOString() };
  return { ...base, kind: 'signed_in', org: null, since: user.createdAt.toISOString() };
}

/** A staff row: the address from TOWNWISE_SUPERADMIN_EMAILS, with its two-step state from the kit. */
async function staffPerson(ctx: TownwiseContext, email: string): Promise<PersonView> {
  const user = await ctx.authStores.users.findByEmail(email);
  const factor = user === null ? null : await ctx.authStores.totp.get(user.id);
  let staffTwoStep: PersonView['staffTwoStep'] = { state: 'not_signed_in' };
  if (user !== null) {
    staffTwoStep = factor?.status === 'enabled' && factor.enabledAt !== null
      ? { state: 'on', since: factor.enabledAt.toISOString() }
      : { state: 'not_set_up' };
  }
  return { userId: user?.id ?? null, email, kind: 'staff', org: null, since: user?.createdAt.toISOString() ?? null, staffTwoStep };
}

async function orgsOf(ctx: TownwiseContext, records: PeopleRecords): Promise<Map<string, OrgRecord>> {
  const ids = new Set([...records.seats.map((s) => s.orgId), ...records.invites.map((i) => i.orgId)]);
  return new Map((await ctx.stores.orgs.findByIds([...ids])).map((org) => [org.id, org]));
}

/** P22: everyone Townwise has a record for. People come only from Townwise records and config (spec 10.7). */
export async function listPeople(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  staffOf(principal);
  const { kind } = parseInput(peopleQuery, req.query);
  const records = await peopleRecords(ctx.connection);
  const userIds = [...new Set([...records.seats.map((s) => s.userId), ...records.requests.map((r) => r.userId)])];
  const inviteEmails = [...new Set(records.invites.map((i) => i.email))];
  const [byId, byInviteEmail, orgs, staff] = await Promise.all([
    Promise.all(userIds.map((id) => ctx.authStores.users.findById(id))),
    Promise.all(inviteEmails.map(async (email) => [email, await ctx.authStores.users.findByEmail(email)] as const)),
    orgsOf(ctx, records),
    Promise.all([...ctx.config.superadminEmails].map((email) => staffPerson(ctx, email))),
  ]);
  const users = new Map(byId.flatMap((user) => (user === null ? [] : [[user.id, user] as const])));
  const inviteUsers = new Map(byInviteEmail);

  // One entry per person: by kit user when there is one, else by the invited address.
  const people = new Map<string, { user: User | null; email: string; seats: PersonSeat[]; invites: PersonInvite[]; requests: PersonRequest[] }>();
  const entry = (user: User | null, email: string) => {
    const key = user === null ? `email:${email}` : `user:${user.id}`;
    let found = people.get(key);
    if (found === undefined) {
      found = { user, email: user?.email ?? email, seats: [], invites: [], requests: [] };
      people.set(key, found);
    }
    return found;
  };
  for (const seat of records.seats) {
    const user = users.get(seat.userId);
    if (user !== undefined) entry(user, user.email).seats.push(seat);
  }
  for (const request of records.requests) {
    const user = users.get(request.userId);
    if (user !== undefined) entry(user, user.email).requests.push(request);
  }
  for (const invite of records.invites) entry(inviteUsers.get(invite.email) ?? null, invite.email).invites.push(invite);

  // A staff address is listed once, as staff, even when an organization invited or seated it.
  const rows: PersonView[] = [...staff];
  for (const person of people.values()) {
    if (ctx.config.superadminEmails.has(person.email)) continue;
    const row = personView(person.user, person.email, person, orgs);
    if (row !== null) rows.push(row);
  }
  const listed = rows
    .filter((row) => kind === undefined || row.kind === kind)
    .sort((a, b) => Number(b.kind === 'staff') - Number(a.kind === 'staff') || a.email.localeCompare(b.email));
  res.status(200).json({ people: listed.slice(0, MAX_PEOPLE), truncated: listed.length > MAX_PEOPLE });
}

/** P22 lookup: one person by exact email, signed-in-only people included. `q` is redacted from request logs. */
export async function lookupPerson(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  staffOf(principal);
  const email = normalizeEmail(parseInput(lookupQuery, req.query).q);
  if (email === null) throw new AppError(400, 'invalid_request', 'Invalid request');
  if (ctx.config.superadminEmails.has(email)) {
    res.status(200).json({ person: await staffPerson(ctx, email) });
    return;
  }
  const user = await ctx.authStores.users.findByEmail(email);
  const records = await peopleRecords(ctx.connection, { userId: user?.id ?? null, email });
  res.status(200).json({ person: personView(user, email, records, await orgsOf(ctx, records)) });
}

const emptyBody = z.object({});

/**
 * POST /api/admin/people/:userId/sign-out-everywhere {} (F7, P22): every session of the person, through the kit's
 * revokeAllSessions. The event's organization is the person's active organization at the time, or none (spec 9.2).
 * [CONFIRM: sign out everywhere for staff]
 */
export async function signOutEverywhere(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const userId = parseInput(objectId, req.params.userId).toLowerCase();
  parseInput(emptyBody, req.body);
  const target = await ctx.authStores.users.findById(userId);
  if (target === null) throw notFound();
  if (ctx.config.superadminEmails.has(target.email)) {
    throw new AppError(400, 'invalid_target', 'Staff accounts can’t be signed out from the console');
  }
  const seat = await findActiveSeat(ctx.connection, target.id);
  const event: AuditEventInput = {
    ...actorOf(staff), at: ctx.now(), orgId: seat?.orgId ?? null, action: 'people.signed_out_everywhere',
    target: { type: 'user', id: target.id },
    details: {},
  };
  const eventId = await recordBefore(ctx, event);
  const revoked = await applyRecorded(ctx, event, eventId, () => ctx.auth.revokeAllSessions(target.id));
  res.status(200).json({ revoked });
}

/** An empty query value means the filter is not set. */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const AUDIT_ACTIONS = Object.keys(AUDIT_DETAIL_KEYS) as [AuditAction, ...AuditAction[]];
const auditQuery = z.object({
  orgId: optional(objectId),
  actorUserId: optional(objectId),
  action: optional(z.enum(AUDIT_ACTIONS)),
  before: optional(z.iso.datetime()),
  limit: z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(1).max(200).default(50)),
});

/** P23: newest first, filtered by organization, actor and action, paged with `before`. */
export async function queryAudit(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  staffOf(principal);
  const query = parseInput(auditQuery, req.query);
  const page = await ctx.stores.audit.query({
    limit: query.limit,
    ...(query.orgId === undefined ? {} : { orgId: query.orgId.toLowerCase() }),
    ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId.toLowerCase() }),
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.before === undefined ? {} : { before: new Date(query.before) }),
  });
  res.status(200).json({ events: await auditEventViews(ctx, page.events), nextBefore: page.nextBefore?.toISOString() ?? null });
}
