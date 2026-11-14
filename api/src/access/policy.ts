// Principal, the five policies, the view-as and open-as-admin guards, and the only code that mints an OrgScope
// (spec 6.10, 7.2).
import type { AuthContext } from '@ckeith26/auth';
import { AppError } from '@ckeith26/server-core';
import type { Request } from 'express';

import type { ListedBlob } from '../files/blobs.ts';
import type { ClaimedAiRead, ClaimedCalendar, ClaimedImport, JoinedSeat, LabCallbackClaim, SweptFile, SweptImport } from '../stores/cross-tenant.ts';
import type { OrgRecord, OrgStore } from '../stores/orgs.ts';
import type { OpenAsAdminGrantRecord } from '../stores/view-as-grants.ts';
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

/** The file reader only (files/worker.ts), for the organization of the import it just claimed. */
export function scopeForClaimedImport(claim: ClaimedImport): OrgScope {
  return mint(claim.orgId);
}

/** The TownwiseAI reader only (files/ai-reader.ts), for the organization of the file whose read it just claimed. */
export function scopeForClaimedAiRead(claim: ClaimedAiRead): OrgScope {
  return mint(claim.orgId);
}

/** The forecast lab's callback routes only, for the organization of the calibration whose token they just checked. */
export function scopeForLabCallback(claim: LabCallbackClaim): OrgScope {
  return mint(claim.orgId);
}

/** The daily file sweep only (files/sweeper.ts), for the organization of a file, an import or a blob it found. */
export function scopeForSweep(found: SweptFile | SweptImport | ListedBlob): OrgScope {
  return mint(found.orgId);
}

/** The calendar refresh loop only (calendar/refresher.ts), for the organization of the link calendar it just claimed. */
export function scopeForCalendarRefresh(claim: ClaimedCalendar): OrgScope {
  return mint(claim.orgId);
}

/** Approval (F3) and staff creation (F10) only, for the organization that handler just created. */
export function scopeForNewOrg(_staff: StaffPrincipal, orgId: string): OrgScope {
  return mint(orgId);
}

/** The resolver only (D25), for the organization of the open-as-admin grant holding the staff session. */
export function scopeForOpenAsAdmin(grant: OpenAsAdminGrantRecord): OrgScope {
  return mint(grant.orgId);
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
export interface OpenAsAdminContext { grantId: string; actor: StaffActor }

/**
 * A member principal in open as admin (D25) is the staff member acting as the grant organization's org admin: userId
 * and email are the staff member's, memberId is null (they hold no seat), and openAsAdmin.actor is the staff member.
 */
export type Principal =
  | { kind: 'staff'; actor: StaffActor }
  | { kind: 'member'; userId: string; email: string; scope: OrgScope; role: Role; memberId: string | null;
      viewAs: ViewAsContext | null; openAsAdmin: OpenAsAdminContext | null }
  | { kind: 'other'; userId: string; email: string; access: Access; viewAs: ViewAsContext | null };

export type StaffPrincipal = Extract<Principal, { kind: 'staff' }>;
export type MemberPrincipal = Extract<Principal, { kind: 'member' }>;

/**
 * In view-as, userId and email are the target's and viewAs.actor is the staff member. In open as admin, the org admin
 * principal of the grant's organization, with the resolver's scope.
 */
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
    if (resolution.openAsAdmin !== null) {
      return {
        kind: 'member', userId: user.id, email: user.email, scope: resolution.openAsAdmin.scope, role: 'org_admin',
        memberId: null, viewAs: null, openAsAdmin: { grantId: resolution.openAsAdmin.grant.id, actor },
      };
    }
    if (resolution.viewAs === null) return { kind: 'staff', actor };
    viewAs = { grantId: resolution.viewAs.grant.id, actor };
  }
  const person = resolution.viewAs?.target ?? user;
  if (effective.state === 'member' && seat !== null) {
    return {
      kind: 'member', userId: person.id, email: person.email, scope: scopeOf(seat), role: effective.role,
      memberId: seat.id, viewAs, openAsAdmin: null,
    };
  }
  return { kind: 'other', userId: person.id, email: person.email, access: effective, viewAs };
}

/**
 * A staff address outside view-as, whatever its two-step state, and staff in open as admin (D25). Staff never join,
 * decline or request.
 */
export function isStaffPrincipal(principal: Principal): boolean {
  if (principal.kind === 'staff') return true;
  if (principal.kind === 'member') return principal.openAsAdmin !== null;
  if (principal.viewAs !== null) return false;
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

/**
 * Step 4 too, after the view-as guard (D25): in open as admin, End (staff_self) passes, a staff route answers 409 (End
 * first), and only routes marked `openAsAdmin` run; every other route answers 403, GETs included. Null when the request
 * may go on.
 */
export function openAsAdminRefusal(route: { policy: Policy; openAsAdmin?: true }, principal: Principal): AppError | null {
  if (principal.kind !== 'member' || principal.openAsAdmin === null) return null;
  if (route.policy === 'staff_self') return null;
  if (route.policy === 'staff') return new AppError(409, 'open_as_admin_active', 'End setting up as Townwise staff first');
  if (route.openAsAdmin !== true) return new AppError(403, 'open_as_admin_refused', 'Not available while setting up as Townwise staff');
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
      // A grant is live only while its actor passes the staff gate, so any principal in view-as or open as admin passes.
      if (principal.kind === 'staff' || principal.viewAs !== null) return null;
      if (principal.kind === 'member' && principal.openAsAdmin !== null) return null;
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
