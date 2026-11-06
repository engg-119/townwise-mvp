import type { AuthContext } from '@ckeith26/auth';
import { ConfigError } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import { policyRefusal, principalOf, viewAsRefusal, type Policy, type Principal } from '../src/access/policy.ts';
import type { Access, Resolution } from '../src/access/resolve.ts';
import { assertRouteTable, TOWNWISE_ROUTES, type TownwiseRoute } from '../src/access/routes.ts';

const handler: TownwiseRoute['handler'] = () => Promise.resolve();
const route = (overrides: Partial<TownwiseRoute>): TownwiseRoute => ({
  id: 'test.route', method: 'POST', path: '/test', policy: 'signed_in', bodyLimit: '32kb', handler, ...overrides,
});

const auth: AuthContext = {
  userId: 'a'.repeat(24), sessionId: 'session-1', platform: 'native', authenticatedAt: new Date('2026-06-01T12:00:00Z'),
};
const user = { id: 'a'.repeat(24), email: 'person@example.test', googleSubject: null, createdAt: new Date(0) };
const target = { id: 'b'.repeat(24), email: 'target@example.test', googleSubject: null, createdAt: new Date(0) };
const seat = { id: 'c'.repeat(24), orgId: 'd'.repeat(24), orgName: 'Org A', role: 'member' as const };
const grant = {
  id: 'e'.repeat(24), targetUserId: target.id, orgId: seat.orgId, reason: 'Support request', startedAt: new Date(0),
  expiresAt: new Date(1), endedAt: null,
};

function resolution(effective: Access, opts?: { staff?: boolean; viewAs?: boolean }): Resolution {
  const staff = opts?.staff === true || opts?.viewAs === true;
  return {
    user,
    self: staff ? { state: 'staff' } : effective,
    effective,
    seat: effective.state === 'member' || effective.state === 'org_suspended' ? seat : null,
    staffVerifiedUntil: staff ? new Date('2026-06-01T13:00:00Z') : null,
    viewAs: opts?.viewAs === true ? { grant, target } : null,
  };
}

const memberAccess: Access = { state: 'member', org: { id: seat.orgId, name: seat.orgName }, role: 'member' };
const adminAccess: Access = { state: 'member', org: { id: seat.orgId, name: seat.orgName }, role: 'org_admin' };
const principals: Record<string, Principal> = {
  staff: principalOf(resolution({ state: 'staff' }, { staff: true }), auth),
  staffSetup: principalOf(resolution({ state: 'staff_setup_required' }), auth),
  staffReauth: principalOf(resolution({ state: 'staff_reauth_required', reason: 'session_too_old' }), auth),
  admin: principalOf(resolution(adminAccess), auth),
  member: principalOf(resolution(memberAccess), auth),
  noOrg: principalOf(resolution({ state: 'no_org' }), auth),
  viewAsMember: principalOf(resolution(memberAccess, { viewAs: true }), auth),
  viewAsPending: principalOf(resolution({ state: 'no_org' }, { viewAs: true }), auth),
};

function codeOf(policy: Policy, name: string): string | null {
  const principal = principals[name];
  if (principal === undefined) throw new Error(name);
  return policyRefusal(policy, principal)?.code ?? null;
}

describe('route table', () => {
  it('TOWNWISE_ROUTES passes the boot checks', () => {
    expect(() => { assertRouteTable(TOWNWISE_ROUTES); }).not.toThrow();
  });

  it('boot refuses a duplicate method and path', () => {
    expect(() => { assertRouteTable([route({ id: 'a' }), route({ id: 'b' })]); }).toThrow(ConfigError);
  });

  it('boot refuses a GET with a body limit', () => {
    expect(() => { assertRouteTable([route({ method: 'GET', bodyLimit: '32kb' })]); }).toThrow(ConfigError);
  });

  it('saving or setting aside a TownwiseAI proposal is a member POST with an 8kb body and no route limiter', () => {
    const proposal = TOWNWISE_ROUTES.find((entry) => entry.id === 'org.chat.proposal');
    expect(proposal).toMatchObject({
      method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/proposals/:proposalId', policy: 'member', bodyLimit: '8kb',
    });
    expect(proposal?.limiter).toBeUndefined();
  });

  it('boot refuses staff_self on any route except POST /admin/view-as/end', () => {
    expect(() => { assertRouteTable([route({ policy: 'staff_self', path: '/admin/view-as' })]); }).toThrow(ConfigError);
    expect(() => { assertRouteTable([route({ policy: 'staff_self', path: '/admin/view-as/end' })]); }).not.toThrow();
  });
});

describe('principal', () => {
  it('builds a member principal with the seat organization as its scope', () => {
    const principal = principals.member;
    expect(principal).toMatchObject({ kind: 'member', userId: user.id, email: user.email, role: 'member', memberId: seat.id, viewAs: null });
    expect(principal?.kind === 'member' ? principal.scope.orgId : null).toBe(seat.orgId);
  });

  it('in view-as carries the target as the person and the staff member as the actor', () => {
    expect(principals.viewAsMember).toMatchObject({
      kind: 'member', userId: target.id, email: target.email,
      viewAs: { grantId: grant.id, actor: { userId: user.id, email: user.email, sessionId: auth.sessionId } },
    });
  });
});

describe('policies', () => {
  it('signed_in passes everyone', () => {
    for (const name of Object.keys(principals)) expect(codeOf('signed_in', name)).toBeNull();
  });

  it('member passes active members and answers no_access to everyone else', () => {
    expect(codeOf('member', 'member')).toBeNull();
    expect(codeOf('member', 'admin')).toBeNull();
    for (const name of ['staff', 'staffSetup', 'noOrg']) expect(codeOf('member', name)).toBe('no_access');
  });

  it('org_admin answers forbidden to a member and no_access to a non-member', () => {
    expect(codeOf('org_admin', 'admin')).toBeNull();
    expect(codeOf('org_admin', 'member')).toBe('forbidden');
    expect(codeOf('org_admin', 'noOrg')).toBe('no_access');
  });

  it('staff answers the staff codes only to staff addresses; everyone else gets forbidden', () => {
    expect(codeOf('staff', 'staff')).toBeNull();
    expect(codeOf('staff', 'staffSetup')).toBe('staff_setup_required');
    expect(codeOf('staff', 'staffReauth')).toBe('staff_reauth_required');
    for (const name of ['admin', 'member', 'noOrg']) expect(codeOf('staff', name)).toBe('forbidden');
  });

  it('staff_self passes staff and any principal in view-as; otherwise it answers as staff does', () => {
    for (const name of ['staff', 'viewAsMember', 'viewAsPending']) expect(codeOf('staff_self', name)).toBeNull();
    expect(codeOf('staff_self', 'staffReauth')).toBe('staff_reauth_required');
    expect(codeOf('staff_self', 'member')).toBe('forbidden');
  });
});

describe('view-as guard', () => {
  const refusal = (method: TownwiseRoute['method'], policy: Policy, name: string): string | null => {
    const principal = principals[name];
    if (principal === undefined) throw new Error(name);
    return viewAsRefusal({ method, policy }, principal)?.code ?? null;
  };

  it('answers 409 view_as_active on every staff route, any method, before anything else', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      expect(refusal(method, 'staff', 'viewAsMember')).toBe('view_as_active');
    }
  });

  it('answers 403 view_as_read_only on every other non-GET, and lets GETs and staff_self through', () => {
    for (const policy of ['signed_in', 'member', 'org_admin'] as const) {
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) expect(refusal(method, policy, 'viewAsPending')).toBe('view_as_read_only');
      expect(refusal('GET', policy, 'viewAsMember')).toBeNull();
    }
    expect(refusal('POST', 'staff_self', 'viewAsMember')).toBeNull();
  });

  it('does nothing outside view-as', () => {
    for (const name of ['staff', 'member', 'noOrg']) expect(refusal('POST', 'signed_in', name)).toBeNull();
  });
});
