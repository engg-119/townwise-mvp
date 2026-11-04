// Staff console (spec 10.7): requests (F3, F4: list, approve, reject), organizations, people and the audit log.
// Every route here has policy `staff`. Staff events are written before the effect (spec 9.3): read-only checks,
// then the event, then the change.
import type { User } from '@ckeith26/auth';
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';

import { applyRecorded, auditEventViews, recordAfter, recordBefore, recordNotApplied } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import { scopeForNewOrg, scopeForStaffOrg, type Principal, type StaffPrincipal } from '../access/policy.ts';
import { requestView, type AccessRequestView } from '../access/resolve.ts';
import { normalizeEmail } from '../normalize-email.ts';
import { currentEmail } from '../people.ts';
import type { AccessRequestRecord } from '../stores/access-requests.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction, type AuditEventInput } from '../stores/audit-events.ts';
import {
  adminOrgStats, findActiveSeat, NO_ORG_STATS, peopleRecords,
  type PeopleRecords, type PersonInvite, type PersonRequest, type PersonSeat,
} from '../stores/cross-tenant.ts';
import type { OrgRecord } from '../stores/orgs.ts';
import { NO_COVERAGE } from '../stores/sales-days.ts';
import { memberView } from './team.ts';

export type AdminRequestView = AccessRequestView & {
  requester: { userId: string; email: string };
  emailAtRequest: string;
  requesterHasOrg: boolean;
  decidedBy: { email: string } | null;
  orgId: string | null;
};

const listQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending') });
const approveBody = z.object({
  orgName: z.string().trim().min(2).max(120),
  locationName: z.string().trim().min(1).max(80),
});
const rejectBody = z.object({ message: z.string().trim().max(500).nullish() });

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** The staff policy already passed; this narrows the principal for the handler. */
function staffOf(principal: Principal): StaffPrincipal {
  if (principal.kind !== 'staff') throw new AppError(403, 'forbidden', 'Forbidden');
  return principal;
}

function actorOf(staff: StaffPrincipal): Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'> {
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

/** F3. A request already approved with an organization skips to step 6, so a retry completes the work. */
export async function approveRequest(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const requestId = parseInput(objectId, req.params.requestId);
  const body = parseInput(approveBody, req.body);
  const request = await ctx.stores.requests.findById(requestId);
  if (request === null) throw notFound();
  const requester = await ctx.authStores.users.findById(request.userId);
  if (requester === null) throw notFound();
  const actor = actorOf(staff);
  const now = ctx.now();

  let orgId = request.orgId;
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
  // Step 7 runs only while the organization has no location and no people, so a retry finishes a stopped
  // approval but never adds a location to an organization in use (spec 3, 6.4), whatever name it sends.
  if (inserted || (await ctx.stores.locations.count(scope) === 0 && await ctx.stores.members.countSeats(scope) === 0)) {
    const location = await ctx.stores.locations.ensureByName(scope, {
      name: body.locationName, town: request.town, createdAt: now, createdBy: staff.actor.userId,
    });
    if (location.inserted) {
      await recordAfter(ctx, {
        ...actor, at: now, orgId, action: 'location.created',
        target: { type: 'location', id: location.id },
        details: { name: body.locationName, townId: request.town.townId },
      });
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
    await recordAfter(ctx, {
      ...actor, at: now, orgId, action: 'member.joined',
      target: { type: 'member', id: seat.id },
      details: { email: requester.email, role: 'org_admin' },
    });
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
// they carry counts, dates, emails and names only: sales figures and note text are visible only through view-as.

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

export async function getOrg(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const staff = staffOf(principal);
  const { scope, org } = await scopeForStaffOrg(ctx.stores.orgs, staff, parseInput(objectId, req.params.orgId));
  const [members, locations, coverage, notes, uploads, recent] = await Promise.all([
    ctx.stores.members.list(scope),
    ctx.stores.locations.list(scope),
    ctx.stores.salesDays.coverageByLocation(scope),
    ctx.stores.notes.countByLocation(scope),
    ctx.stores.uploads.lastUploadByLocation(scope),
    ctx.stores.audit.query({ orgId: scope.orgId, limit: RECENT_EVENTS }),
  ]);
  res.status(200).json({
    org: {
      id: org.id, name: org.name, status: org.status, createdAt: org.createdAt.toISOString(),
      fromRequestId: org.fromRequestId, suspendedAt: org.suspendedAt?.toISOString() ?? null,
    },
    members: await Promise.all(members.map((member) => memberView(ctx, member, staff.actor.userId))),
    locations: locations.map((location) => ({
      id: location.id, name: location.name, town: location.town,
      coverage: coverage.get(location.id) ?? NO_COVERAGE,
      notesCount: notes.get(location.id) ?? 0,
      lastUploadAt: uploads.get(location.id)?.toISOString() ?? null,
    })),
    recent: await auditEventViews(ctx, recent.events.slice(0, RECENT_EVENTS)),
  });
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
