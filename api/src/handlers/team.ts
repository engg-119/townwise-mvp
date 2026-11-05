// Team (spec F5, F6, 10.6): an org admin lists, adds, changes roles and removes, in their own organization only.
// The organization comes from the principal's scope; no route here carries an organization id.
import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import type { Role } from '../access/resolve.ts';
import { normalizeEmail } from '../normalize-email.ts';
import { currentEmail } from '../people.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { MemberRecord } from '../stores/members.ts';

export interface MemberView {
  id: string; email: string; role: Role; status: 'invited' | 'active';
  invitedAt: string; joinedAt: string | null; isYou: boolean; addedByStaff: boolean;
}

export interface AddResult { email: string; outcome: 'invited' | 'already_invited' | 'already_member' | 'invalid' }

/** Spec 18. [CONFIRM: 20 emails per add; 200 people per organization] */
const MAX_EMAILS_PER_ADD = 20;
const MAX_PEOPLE = 200;

const roleSchema = z.enum(['org_admin', 'member']);
/** Also the staff console's team edits (spec 10.7: as 10.6). */
export const addBody = z.object({
  emails: z.array(z.string().max(320)).min(1).max(MAX_EMAILS_PER_ADD),
  // [CONFIRM: role chosen at invite, default member]
  role: roleSchema.default('member'),
});
export const roleBody = z.object({ role: roleSchema });

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** The org_admin policy already passed; this narrows the principal for the handler. */
export function orgAdmin(principal: Principal): MemberPrincipal {
  if (principal.kind !== 'member' || principal.role !== 'org_admin') throw new AppError(403, 'forbidden', 'Forbidden');
  return principal;
}

export function actorOf(principal: MemberPrincipal): Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'> {
  return { actorUserId: principal.userId, actorEmail: principal.email, actorRole: principal.role, viewAsGrantId: null };
}

/** A seat shows the person's current kit email; an invitation shows the address that was added. */
export function emailOf(ctx: TownwiseContext, member: MemberRecord): Promise<string> {
  return member.status === 'active' ? currentEmail(ctx, member.userId) : Promise.resolve(member.email);
}

export async function memberView(ctx: TownwiseContext, member: MemberRecord, you: string): Promise<MemberView> {
  return {
    id: member.id,
    email: await emailOf(ctx, member),
    role: member.role,
    status: member.status,
    invitedAt: member.invitedAt.toISOString(),
    joinedAt: member.joinedAt?.toISOString() ?? null,
    isYou: member.userId === you,
    addedByStaff: member.addedByStaff,
  };
}

/** The organization's active members and open invitations, as `you` sees them. */
export async function teamView(ctx: TownwiseContext, scope: OrgScope, you: string): Promise<MemberView[]> {
  const members = await ctx.stores.members.list(scope);
  return Promise.all(members.map((member) => memberView(ctx, member, you)));
}

async function teamOf(ctx: TownwiseContext, principal: MemberPrincipal): Promise<MemberView[]> {
  return teamView(ctx, principal.scope, principal.userId);
}

/**
 * F5 step 2: one outcome per address, normalized like the kit, duplicates collapsed. `invited` here means the address
 * is new to this organization; no outcome depends on any other organization.
 */
export async function addOutcomes(ctx: TownwiseContext, scope: OrgScope, emails: readonly string[]): Promise<AddResult[]> {
  const results: AddResult[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    const shown = email ?? raw.trim();
    if (seen.has(shown)) continue;
    seen.add(shown);
    results.push({ email: shown, outcome: email === null ? 'invalid' : 'invited' });
  }

  const open = await ctx.stores.members.openInviteEmails(scope, results.filter((r) => r.outcome === 'invited').map((r) => r.email));
  for (const result of results) {
    if (result.outcome !== 'invited') continue;
    const user = await ctx.authStores.users.findByEmail(result.email);
    if (user !== null && await ctx.stores.members.hasActiveSeat(scope, user.id)) result.outcome = 'already_member';
    else if (open.has(result.email)) result.outcome = 'already_invited';
  }
  return results;
}

/** The 200-person cap, active plus invited, for `adding` new invitations (409 member_limit). */
export async function assertRoomFor(ctx: TownwiseContext, scope: OrgScope, adding: number): Promise<void> {
  if (adding > 0 && (await ctx.stores.members.countSeats(scope)) + adding > MAX_PEOPLE) {
    throw new AppError(409, 'member_limit', 'The organization has reached its people limit');
  }
}

export async function listMembers(ctx: TownwiseContext, _req: Request, res: Response, principal: Principal): Promise<void> {
  res.status(200).json({ members: await teamOf(ctx, orgAdmin(principal)) });
}

/** F5. Each address gets one outcome, and no outcome depends on any other organization. */
export async function addMembers(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = orgAdmin(principal);
  const { scope } = caller;
  const body = parseInput(addBody, req.body);
  const results = await addOutcomes(ctx, scope, body.emails);
  const fresh = results.filter((r) => r.outcome === 'invited');
  await assertRoomFor(ctx, scope, fresh.length);
  const now = ctx.now();
  for (const result of fresh) {
    const memberId = await ctx.stores.members.insertInvite(scope, {
      email: result.email, role: body.role, invitedAt: now, invitedBy: caller.userId, addedByStaff: false,
    });
    if (memberId === null) {
      result.outcome = 'already_invited';   // a concurrent add got there first
      continue;
    }
    await recordAfter(ctx, {
      ...actorOf(caller), at: now, orgId: scope.orgId, action: 'member.invited',
      target: { type: 'member', id: memberId },
      details: { email: result.email, role: body.role },
    });
  }
  res.status(200).json({ results, members: await teamOf(ctx, caller) });
}

/**
 * F6, change role: change, recount, revert, so the organization never ends with no active admin. A demotion
 * recounts whatever status was read, because an invitation can turn into a seat between the read and the write.
 */
export async function changeRole(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = orgAdmin(principal);
  const { scope } = caller;
  const memberId = parseInput(objectId, req.params.memberId);
  const { role } = parseInput(roleBody, req.body);
  const member = await ctx.stores.members.find(scope, memberId);
  if (member === null) throw notFound();

  if (member.role !== role && await ctx.stores.members.setRole(scope, memberId, member.role, role)) {
    if (member.role === 'org_admin' && await ctx.stores.members.countActiveAdmins(scope) === 0) {
      await ctx.stores.members.setRole(scope, memberId, role, member.role);
      throw new AppError(409, 'last_admin', 'The organization needs at least one admin');
    }
    await recordAfter(ctx, {
      ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'member.role_changed',
      target: { type: 'member', id: memberId },
      details: { email: await emailOf(ctx, member), from: member.role, to: role },
    });
  }
  // A concurrent change or removal shows as what is there now.
  const current = await ctx.stores.members.find(scope, memberId);
  if (current === null) throw notFound();
  res.status(200).json({ member: await memberView(ctx, current, caller.userId) });
}

/**
 * F6, remove: an invitation is deleted; a seat is removed, recounted and restored if no active admin is left.
 * Every seat removal recounts, because the role read before the write can be stale.
 */
export async function removeMember(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = orgAdmin(principal);
  const { scope } = caller;
  const memberId = parseInput(objectId, req.params.memberId);
  const member = await ctx.stores.members.find(scope, memberId);
  if (member === null) throw notFound();
  const email = await emailOf(ctx, member);
  const now = ctx.now();

  if (member.status === 'invited') {
    if (!(await ctx.stores.members.deleteInvite(scope, memberId))) throw notFound();
  } else {
    if (await ctx.stores.members.removeSeat(scope, memberId, { removedAt: now, removedBy: caller.userId }) === null) throw notFound();
    if (await ctx.stores.members.countActiveAdmins(scope) === 0) {
      await ctx.stores.members.restoreSeat(scope, memberId, member.userId);
      throw new AppError(409, 'last_admin', 'The organization needs at least one admin');
    }
  }
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'member.removed',
    target: { type: 'member', id: memberId },
    details: { email, wasStatus: member.status },
  });
  res.status(204).end();
}
