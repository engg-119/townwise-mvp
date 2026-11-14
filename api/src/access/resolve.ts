// resolveAccess(): the only code that decides staff, membership, organization, view-as and open as admin (spec 4.2,
// D25). It never writes, reads from the primary (every Townwise schema sets read: 'primary') and reads the
// time only from ctx.now.
import type { AuthContext, User } from '@ckeith26/auth';
import { AppError } from '@ckeith26/server-core';

import type { TownwiseContext } from '../app.ts';
import type { PlaceKind } from '../places/google.ts';
import type { AccessRequestRecord } from '../stores/access-requests.ts';
import { findActiveSeat, findOpenInvites, latestRemovedSeat, type OpenInvite } from '../stores/cross-tenant.ts';
import type { OpenAsAdminGrantRecord, ViewAsGrantRecord } from '../stores/view-as-grants.ts';
import type { Town } from '../towns.ts';
import { scopeForOpenAsAdmin, type OrgScope } from './policy.ts';
import { isInSetup } from './setup.ts';

export type Role = 'org_admin' | 'member';

export interface AccessRequestView {
  id: string; orgName: string; contactName: string; contactRole: string; town: Town;
  locationCount: number; note: string | null;
  places: { placeId: string; name: string | null; kind: PlaceKind; town: Town }[]; status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  createdAt: string; decidedAt: string | null; decisionMessage: string | null;
}

export interface InvitationView {
  inviteId: string; orgName: string; role: Role;
  /** email: the org admin's current kit email; null when staff added it, or that account no longer exists. */
  invitedBy: { staff: boolean; email: string | null };
}

export type Access =
  | { state: 'staff' }
  | { state: 'staff_setup_required' }
  | { state: 'staff_reauth_required'; reason: 'session_before_codes' | 'session_too_old' }
  | { state: 'member'; org: { id: string; name: string }; role: Role }
  | { state: 'invited'; invitations: InvitationView[]; pendingRequest: AccessRequestView | null }
  | { state: 'pending'; request: AccessRequestView }
  | { state: 'rejected'; request: AccessRequestView }
  | { state: 'removed'; org: { name: string }; removedAt: string; byYou: boolean }
  | { state: 'org_suspended'; org: { name: string } }
  | { state: 'no_org' };

/** The staff window (D2). [CONFIRM: 60 minutes] */
export const STAFF_WINDOW_MS = 60 * 60 * 1000;

/** The person's seat in an active or suspended organization: their resolved organization (4.2 step 3). */
export interface ResolvedSeat { readonly id: string; readonly orgId: string; readonly orgName: string; readonly role: Role }

export interface Resolution {
  /** The signed-in kit user. */
  readonly user: User;
  /** The signed-in person's own access, before any view-as or open-as-admin substitution. */
  readonly self: Access;
  /** What policies evaluate: `self`, the view-as target's access, or (open as admin) the grant organization's admin access. */
  readonly effective: Access;
  /** The resolved seat of the person `effective` describes; null in open as admin, where nobody holds one. */
  readonly seat: ResolvedSeat | null;
  /** Set whenever `self` is staff. */
  readonly staffVerifiedUntil: Date | null;
  /** Set only while a view-as grant is live for this session. */
  readonly viewAs: { readonly grant: ViewAsGrantRecord; readonly target: User } | null;
  /**
   * Set only while an open-as-admin grant is live for this session (D25): held by a staff session that passes the
   * gate, not ended, not expired, its organization still in setup and not suspended since it started. Null on every
   * other path.
   */
  readonly openAsAdmin: { readonly grant: OpenAsAdminGrantRecord; readonly scope: OrgScope; readonly orgName: string } | null;
}

/** The one place product code answers unauthenticated: the kit user no longer exists (D19). */
export function userGone(): never {
  throw new AppError(401, 'unauthenticated', 'Unauthenticated');
}

export function requestView(record: AccessRequestRecord): AccessRequestView {
  return {
    id: record.id,
    orgName: record.orgName,
    contactName: record.contactName,
    contactRole: record.contactRole,
    town: { townId: record.town.townId, name: record.town.name, state: record.town.state },
    locationCount: record.locationCount,
    note: record.note,
    places: record.places.map((place) => ({
      placeId: place.placeId, name: place.name, kind: place.kind,
      town: { townId: place.town.townId, name: place.town.name, state: place.town.state },
    })),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    decidedAt: record.decidedAt?.toISOString() ?? null,
    decisionMessage: record.decisionMessage,
  };
}

async function invitedBy(ctx: TownwiseContext, invite: OpenInvite): Promise<InvitationView['invitedBy']> {
  if (invite.addedByStaff) return { staff: true, email: null };
  const inviter = await ctx.authStores.users.findById(invite.invitedBy);
  return { staff: false, email: inviter?.email ?? null };
}

/** Steps 3 to 7 for one person; also what a view-as target resolves to, and so the grant's organization. */
export async function resolvePerson(
  ctx: TownwiseContext,
  user: User,
): Promise<{ access: Access; seat: ResolvedSeat | null }> {
  const active = await findActiveSeat(ctx.connection, user.id);
  if (active !== null) {
    const org = await ctx.stores.orgs.findById(active.orgId);
    if (org !== null) {
      const seat = { id: active.id, orgId: org.id, orgName: org.name, role: active.role };
      if (org.status === 'active') {
        return { access: { state: 'member', org: { id: org.id, name: org.name }, role: active.role }, seat };
      }
      return { access: { state: 'org_suspended', org: { name: org.name } }, seat };
    }
  }

  const pending = await ctx.stores.requests.findPending(user.id);
  const invites = await findOpenInvites(ctx.connection, user.email);
  if (invites.length > 0) {
    const orgs = await ctx.stores.orgs.findByIds(invites.map((invite) => invite.orgId));
    const activeOrgs = new Map(orgs.filter((org) => org.status === 'active').map((org) => [org.id, org]));
    const invitations: InvitationView[] = [];
    for (const invite of invites) {
      const org = activeOrgs.get(invite.orgId);
      if (org === undefined) continue;
      invitations.push({ inviteId: invite.id, orgName: org.name, role: invite.role, invitedBy: await invitedBy(ctx, invite) });
    }
    if (invitations.length > 0) {
      return {
        access: { state: 'invited', invitations, pendingRequest: pending === null ? null : requestView(pending) },
        seat: null,
      };
    }
  }

  if (pending !== null) return { access: { state: 'pending', request: requestView(pending) }, seat: null };

  const rejected = await ctx.stores.requests.latestRejected(user.id);
  const removedSeat = await latestRemovedSeat(ctx.connection, user.id);
  const removedOrg = removedSeat === null ? null : await ctx.stores.orgs.findById(removedSeat.orgId);
  const rejectedAt = rejected === null ? null : (rejected.decidedAt ?? rejected.createdAt).getTime();
  if (removedSeat !== null && removedOrg !== null && (rejectedAt === null || removedSeat.removedAt.getTime() >= rejectedAt)) {
    return {
      access: {
        state: 'removed',
        org: { name: removedOrg.name },
        removedAt: removedSeat.removedAt.toISOString(),
        byYou: removedSeat.removedBy === user.id,
      },
      seat: null,
    };
  }
  if (rejected !== null) return { access: { state: 'rejected', request: requestView(rejected) }, seat: null };
  return { access: { state: 'no_org' }, seat: null };
}

/**
 * Step 2.1 to 2.3: TOTP enabled, a session created after it was enabled, at most 60 minutes old. In development with
 * TOWNWISE_STAFF_TWO_STEP off (config.ts; production refuses it) none of that is asked.
 */
async function staffGate(ctx: TownwiseContext, auth: AuthContext, now: Date): Promise<Access> {
  if (!ctx.config.staffTwoStep) return { state: 'staff' };
  const factor = await ctx.authStores.totp.get(auth.userId);
  if (factor?.status !== 'enabled' || factor.enabledAt === null) return { state: 'staff_setup_required' };
  if (auth.authenticatedAt.getTime() <= factor.enabledAt.getTime()) {
    return { state: 'staff_reauth_required', reason: 'session_before_codes' };
  }
  if (now.getTime() - auth.authenticatedAt.getTime() > STAFF_WINDOW_MS) {
    return { state: 'staff_reauth_required', reason: 'session_too_old' };
  }
  return { state: 'staff' };
}

export async function resolveAccess(ctx: TownwiseContext, auth: AuthContext): Promise<Resolution> {
  const now = ctx.now();
  const user = await ctx.authStores.users.findById(auth.userId);
  if (user === null) userGone();

  // A staff address never resolves as a member, even when an organization invited it.
  if (!ctx.config.superadminEmails.has(user.email)) {
    const person = await resolvePerson(ctx, user);
    return {
      user, self: person.access, effective: person.access, seat: person.seat, staffVerifiedUntil: null, viewAs: null, openAsAdmin: null,
    };
  }

  const self = await staffGate(ctx, auth, now);
  if (self.state !== 'staff') {
    return { user, self, effective: self, seat: null, staffVerifiedUntil: null, viewAs: null, openAsAdmin: null };
  }
  // With two-step sign-in off nothing was verified at sign-in, so the window runs from each request instead.
  const staffVerifiedUntil = new Date((ctx.config.staffTwoStep ? auth.authenticatedAt : now).getTime() + STAFF_WINDOW_MS);
  const staffOnly: Resolution = { user, self, effective: self, seat: null, staffVerifiedUntil, viewAs: null, openAsAdmin: null };

  // Section 8 and 8a, live grant of either kind: holds this session, not ended, not expired. Then a view-as grant is
  // live while the target's resolved organization still equals the grant's (null equals null), and an open-as-admin
  // grant while its organization is in setup (below). Anything else is ignored like an expired grant.
  const grant = await ctx.stores.grants.findBySession(auth.sessionId);
  if (grant === null) return staffOnly;
  if (grant.endedAt !== null || grant.expiresAt.getTime() <= now.getTime()) return staffOnly;
  if (grant.kind === 'open_as_admin') {
    // D25: live only while its organization exists and is in setup (active, nobody has ever joined it), so a join or a
    // suspension ends it from the next request on. The organization comes from the grant, never from the request.
    const org = await ctx.stores.orgs.findById(grant.orgId);
    if (org === null) return staffOnly;
    // A suspension ends it for good: a grant started at or before the last one stays dead after a reactivation, whether
    // or not End was ever sent (fails closed; nothing here writes).
    if (org.lastSuspendedAt !== null && grant.startedAt.getTime() <= org.lastSuspendedAt.getTime()) return staffOnly;
    const scope = scopeForOpenAsAdmin(grant);
    if (!(await isInSetup(ctx, scope, org))) return staffOnly;
    return {
      user, self, effective: { state: 'member', org: { id: org.id, name: org.name }, role: 'org_admin' }, seat: null,
      staffVerifiedUntil, viewAs: null, openAsAdmin: { grant, scope, orgName: org.name },
    };
  }
  const target = await ctx.authStores.users.findById(grant.targetUserId);
  if (target === null) return staffOnly;
  const person = await resolvePerson(ctx, target);
  if ((person.seat?.orgId ?? null) !== grant.orgId) return staffOnly;
  return { user, self, effective: person.access, seat: person.seat, staffVerifiedUntil, viewAs: { grant, target }, openAsAdmin: null };
}
