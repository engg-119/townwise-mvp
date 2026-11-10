import type { TownwiseRoute } from '../../src/access/routes.ts';

/** Answers what the chain handed the handler, so tests can see the principal and its scope. */
const echo: TownwiseRoute['handler'] = (_ctx, _req, res, principal) => {
  res.status(200).json({
    kind: principal.kind,
    orgId: principal.kind === 'member' ? principal.scope.orgId : null,
    role: principal.kind === 'member' ? principal.role : null,
  });
  return Promise.resolve();
};

/**
 * Test-only routes mounted at /probe with the same chain as /api, for policies no product route uses yet. The member
 * and org admin probes run in open as admin (D25); the staff ones do not.
 */
export const PROBE_ROUTES: readonly TownwiseRoute[] = [
  { id: 'probe.member.read', method: 'GET', path: '/member', policy: 'member', bodyLimit: 'none', openAsAdmin: true, handler: echo },
  { id: 'probe.member.write', method: 'POST', path: '/member', policy: 'member', bodyLimit: '256kb', openAsAdmin: true, handler: echo },
  { id: 'probe.org_admin.read', method: 'GET', path: '/org-admin', policy: 'org_admin', bodyLimit: 'none', openAsAdmin: true, handler: echo },
  { id: 'probe.staff.read', method: 'GET', path: '/staff', policy: 'staff', bodyLimit: 'none', handler: echo },
  { id: 'probe.staff.write', method: 'POST', path: '/staff', policy: 'staff', bodyLimit: '32kb', handler: echo },
];
