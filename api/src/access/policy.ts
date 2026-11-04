// Principal, the five policies, the view-as guard, and the only code that mints an OrgScope (spec 6.10, 7.2).
import type { AuthContext } from '@ckeith26/auth';
import { AppError } from '@ckeith26/server-core';
import type { Request } from 'express';

import type { JoinedSeat } from '../stores/cross-tenant.ts';
import type { OrgRecord, OrgStore } from '../stores/orgs.ts';
import type { Access, ResolvedSeat, Resolution, Role } from './resolve.ts';

declare const orgScopeBrand: unique symbol;

/** The organization a tenant store may touch. Tenant store functions take it first and add
 *  `orgId: scope.orgId` to every filter, update, delete and insert. Minted only in this file. */
export interface OrgScope {
  readonly orgId: string;
  readonly [orgScopeBrand]: true;
}

function mint(orgId: string): OrgScope {
  return Object.freeze({ orgId }) as OrgScope;
}

/** Member routes: the organization of the caller's own active seat, never one from the request. */
function scopeOf(seat: ResolvedSeat): OrgScope {
  return mint(seat.orgId);
}

/** The join handler only, after its compare-and-set succeeds. */
export function scopeForJoinedInvite(seat: JoinedSeat): OrgScope {
  return mint(seat.orgId);
}

/** Approval (F3) and staff creation (F10) only, for the organization that handler just created. */
export function scopeForNewOrg(_staff: StaffPrincipal, orgId: string): OrgScope {
  return mint(orgId);
}

/** Staff routes on /api/admin/orgs/:orgId: reads the organization first, and answers 404 when it does not exist. */
export async function scopeForStaffOrg(
  orgs: Pick<OrgStore, 'findById'>,
  _staff: StaffPrincipal,
  orgId: string,
): Promise<{ scope: OrgScope; org: OrgRecord }> {
  const org = await orgs.findById(orgId);
  if (org === null) throw new AppError(404, 'not_found', 'Not found');
  return { scope: mint(org.id), org };
}

export type Policy = 'signed_in' | 'member' | 'org_admin' | 'staff' | 'staff_self';

export interface StaffActor { userId: string; email: string; sessionId: string; verifiedUntil: string }
export interface ViewAsContext { grantId: string; actor: StaffActor }

export type Principal =
  | { kind: 'staff'; actor: StaffActor }
  | { kind: 'member'; userId: string; email: string; scope: OrgScope; role: Role; memberId: string;
      viewAs: ViewAsContext | null }
  | { kind: 'other'; userId: string; email: string; access: Access; viewAs: ViewAsContext | null };

export type StaffPrincipal = Extract<Principal, { kind: 'staff' }>;
export type MemberPrincipal = Extract<Principal, { kind: 'member' }>;

/** In view-as, userId and email are the target's and viewAs.actor is the staff member. */
export function principalOf(resolution: Resolution, auth: AuthContext): Principal {
  const { user, effective, seat } = resolution;
  let viewAs: ViewAsContext | null = null;
  if (resolution.staffVerifiedUntil !== null) {
    const actor: StaffActor = {
      userId: user.id,
      email: user.email,
      sessionId: auth.sessionId,
      verifiedUntil: resolution.staffVerifiedUntil.toISOString(),
    };
    if (resolution.viewAs === null) return { kind: 'staff', actor };
    viewAs = { grantId: resolution.viewAs.grant.id, actor };
  }
  const person = resolution.viewAs?.target ?? user;
  if (effective.state === 'member' && seat !== null) {
    return {
      kind: 'member', userId: person.id, email: person.email, scope: scopeOf(seat), role: effective.role,
      memberId: seat.id, viewAs,
    };
  }
  return { kind: 'other', userId: person.id, email: person.email, access: effective, viewAs };
}

/** A staff address outside view-as, whatever its two-step state. Staff never join, decline or request. */
export function isStaffPrincipal(principal: Principal): boolean {
  if (principal.kind === 'staff') return true;
  if (principal.kind === 'member' || principal.viewAs !== null) return false;
  return principal.access.state === 'staff_setup_required' || principal.access.state === 'staff_reauth_required';
}

/** Step 4 of the chain. Null when the request may go on. */
export function viewAsRefusal(route: { method: string; policy: Policy }, principal: Principal): AppError | null {
  if (principal.kind === 'staff' || principal.viewAs === null) return null;
  if (route.policy === 'staff_self') return null;
  if (route.policy === 'staff') return new AppError(409, 'view_as_active', 'End view-as first');
  if (route.method !== 'GET') return new AppError(403, 'view_as_read_only', 'View-as is read-only');
  return null;
}

function staffRefusal(principal: Principal): AppError {
  if (principal.kind === 'other' && principal.viewAs === null) {
    if (principal.access.state === 'staff_setup_required') {
      return new AppError(403, 'staff_setup_required', 'Two-step sign-in is required');
    }
    if (principal.access.state === 'staff_reauth_required') {
      return new AppError(403, 'staff_reauth_required', 'Sign in again with a code');
    }
  }
  return new AppError(403, 'forbidden', 'Forbidden');
}

/** Step 5 of the chain, on `effective` (the principal) except staff_self. Null when the policy passes. */
export function policyRefusal(policy: Policy, principal: Principal): AppError | null {
  switch (policy) {
    case 'signed_in':
      return null;
    case 'member':
      return principal.kind === 'member' ? null : new AppError(403, 'no_access', 'No access');
    case 'org_admin':
      if (principal.kind !== 'member') return new AppError(403, 'no_access', 'No access');
      return principal.role === 'org_admin' ? null : new AppError(403, 'forbidden', 'Forbidden');
    case 'staff':
      return principal.kind === 'staff' ? null : staffRefusal(principal);
    case 'staff_self':
      // A grant is live only while its actor passes the staff gate, so any principal in view-as passes.
      if (principal.kind === 'staff' || principal.viewAs !== null) return null;
      return staffRefusal(principal);
  }
}

const resolutions = new WeakMap<Request, Resolution>();

/** Called once per request by the route chain, after the policy passed. */
export function recordResolution(req: Request, resolution: Resolution): void {
  resolutions.set(req, resolution);
}

/** The resolution behind this request's principal (GET /api/me builds its answer from it). */
export function resolutionOf(req: Request): Resolution {
  const resolution = resolutions.get(req);
  if (resolution === undefined) throw new AppError(500, 'internal', 'Internal server error');
  return resolution;
}
