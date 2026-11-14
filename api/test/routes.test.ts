import { readFileSync } from 'node:fs';

import type { AuthContext } from '@ckeith26/auth';
import { ConfigError } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import {
  isStaffPrincipal, openAsAdminRefusal, policyRefusal, principalOf, scopeForOpenAsAdmin, viewAsRefusal, type Policy, type Principal,
} from '../src/access/policy.ts';
import type { Access, Resolution } from '../src/access/resolve.ts';
import { assertRouteTable, TOWNWISE_ROUTES, type TownwiseRoute } from '../src/access/routes.ts';
import type { TownwiseContext } from '../src/app.ts';
import { createLabCallbackRouter } from '../src/lab/callback.ts';

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
  kind: 'view_as' as const, id: 'e'.repeat(24), targetUserId: target.id, orgId: seat.orgId, reason: 'Support request',
  startedAt: new Date(0), expiresAt: new Date(1), endedAt: null,
};
const openGrant = { kind: 'open_as_admin' as const, id: 'f'.repeat(24), orgId: 'd'.repeat(24), startedAt: new Date(0), expiresAt: new Date(1), endedAt: null };

function resolution(effective: Access, opts?: { staff?: boolean; viewAs?: boolean; openAsAdmin?: boolean }): Resolution {
  const openAsAdmin = opts?.openAsAdmin === true;
  const staff = opts?.staff === true || opts?.viewAs === true || openAsAdmin;
  return {
    user,
    self: staff ? { state: 'staff' } : effective,
    effective,
    seat: !openAsAdmin && (effective.state === 'member' || effective.state === 'org_suspended') ? seat : null,
    staffVerifiedUntil: staff ? new Date('2026-06-01T13:00:00Z') : null,
    viewAs: opts?.viewAs === true ? { grant, target } : null,
    openAsAdmin: openAsAdmin ? { grant: openGrant, scope: scopeForOpenAsAdmin(openGrant), orgName: 'Org A' } : null,
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
  openAsAdmin: principalOf(resolution(adminAccess, { openAsAdmin: true }), auth),
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

  it('places.map is a signed_in POST with a 32kb body and the places limiter, open as admin', () => {
    const rows = TOWNWISE_ROUTES.filter((r) => r.id === 'places.map')
      .map(({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }) => ({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }));
    expect(rows).toEqual([
      { id: 'places.map', method: 'POST', path: '/places/map', policy: 'signed_in', bodyLimit: '32kb', limiter: 'places', openAsAdmin: true },
    ]);
  });

  it('serves sales history and the town calendar as member GETs with no body and no route limiter (spec 10.10)', () => {
    const rows = TOWNWISE_ROUTES.filter((r) => r.id === 'org.sales.history' || r.id === 'org.calendar.get')
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    expect(rows).toEqual([
      { id: 'org.sales.history', method: 'GET', path: '/org/locations/:locationId/sales/history', policy: 'member', bodyLimit: 'none', limiter: undefined },
      { id: 'org.calendar.get', method: 'GET', path: '/org/locations/:locationId/calendar', policy: 'member', bodyLimit: 'none', limiter: undefined },
    ]);
  });

  it('U13A: people in town and how Townwise estimates are member reads with no body and no limiter', () => {
    const rows = TOWNWISE_ROUTES.filter((r) => r.id === 'org.people.get' || r.id === 'org.estimates.about')
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    expect(rows).toEqual([
      { id: 'org.people.get', method: 'GET', path: '/org/locations/:locationId/people-in-town', policy: 'member', bodyLimit: 'none', limiter: undefined },
      { id: 'org.estimates.about', method: 'GET', path: '/org/locations/:locationId/estimates/about', policy: 'member', bodyLimit: 'none', limiter: undefined },
    ]);
  });

  it('U13B: the forecast is a member read; forecast runs are staff routes with their body limits and no limiter', () => {
    const rows = TOWNWISE_ROUTES.filter((r) => r.id === 'org.forecast.get' || r.id.startsWith('admin.forecasts.'))
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    expect(rows).toEqual([
      { id: 'org.forecast.get', method: 'GET', path: '/org/locations/:locationId/forecast', policy: 'member', bodyLimit: 'none', limiter: undefined },
      { id: 'admin.forecasts.list', method: 'GET', path: '/admin/orgs/:orgId/forecast-runs', policy: 'staff', bodyLimit: 'none', limiter: undefined },
      {
        id: 'admin.forecasts.import', method: 'POST', path: '/admin/orgs/:orgId/locations/:locationId/forecast-runs', policy: 'staff',
        bodyLimit: '256kb', limiter: undefined,
      },
      {
        id: 'admin.forecasts.publish', method: 'POST', path: '/admin/orgs/:orgId/forecast-runs/:runId/publish', policy: 'staff',
        bodyLimit: '32kb', limiter: undefined,
      },
      {
        id: 'admin.forecasts.withdraw', method: 'POST', path: '/admin/orgs/:orgId/forecast-runs/:runId/withdraw', policy: 'staff',
        bodyLimit: '32kb', limiter: undefined,
      },
      { id: 'admin.forecasts.remove', method: 'DELETE', path: '/admin/orgs/:orgId/forecast-runs/:runId', policy: 'staff', bodyLimit: 'none', limiter: undefined },
      { id: 'admin.forecasts.switch', method: 'POST', path: '/admin/orgs/:orgId/forecasts-switch', policy: 'staff', bodyLimit: '2kb', limiter: undefined },
    ]);
  });

  it('the forecast lab: calibrations and the forecasts switch are staff routes with 2kb bodies, and no route limiter', () => {
    const rows = TOWNWISE_ROUTES.filter((r) => r.id.startsWith('admin.calibrations.') || r.id === 'admin.forecasts.switch')
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    expect(rows).toEqual([
      { id: 'admin.calibrations.list', method: 'GET', path: '/admin/orgs/:orgId/calibrations', policy: 'staff', bodyLimit: 'none', limiter: undefined },
      {
        id: 'admin.calibrations.start', method: 'POST', path: '/admin/orgs/:orgId/locations/:locationId/calibrations', policy: 'staff',
        bodyLimit: '2kb', limiter: undefined,
      },
      { id: 'admin.forecasts.switch', method: 'POST', path: '/admin/orgs/:orgId/forecasts-switch', policy: 'staff', bodyLimit: '2kb', limiter: undefined },
    ]);
  });

  it('/lab holds the only routes outside /auth and /api', () => {
    // main.ts mounts exactly three routers.
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const mounts = [...main.matchAll(/\{ path: '(\/[^']*)', router: /g)].map((match) => match[1]);
    expect(mounts).toEqual(['/auth', '/api', '/lab']);
    // The lab router holds the job's two callback routes and nothing else; building it touches no context.
    const lab = createLabCallbackRouter({} as TownwiseContext);
    const routes = lab.stack.flatMap((layer) => {
      const route = layer.route as { path: string; methods: Record<string, boolean> } | undefined;
      return route === undefined ? [] : Object.keys(route.methods).map((method) => `${method.toUpperCase()} ${route.path}`);
    });
    expect(routes).toEqual(['GET /calibrations/:id/input', 'POST /calibrations/:id/result']);
  });

  it('D23: staff setup routes are staff writes with the org routes’ body limits and no route limiter', () => {
    const ids = ['admin.orgs.locations.create', 'admin.orgs.locations.update', 'admin.orgs.locations.remove', 'admin.orgs.sales.upload', 'admin.orgs.sales.remove'];
    const rows = TOWNWISE_ROUTES.filter((r) => ids.includes(r.id))
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    const base = '/admin/orgs/:orgId/locations';
    expect(rows).toEqual([
      { id: 'admin.orgs.locations.create', method: 'POST', path: base, policy: 'staff', bodyLimit: '32kb', limiter: undefined },
      { id: 'admin.orgs.locations.update', method: 'PATCH', path: `${base}/:locationId`, policy: 'staff', bodyLimit: '32kb', limiter: undefined },
      { id: 'admin.orgs.locations.remove', method: 'DELETE', path: `${base}/:locationId`, policy: 'staff', bodyLimit: 'none', limiter: undefined },
      {
        id: 'admin.orgs.sales.upload', method: 'POST', path: `${base}/:locationId/sales/uploads`, policy: 'staff', bodyLimit: '256kb',
        limiter: undefined,
      },
      { id: 'admin.orgs.sales.remove', method: 'DELETE', path: `${base}/:locationId/sales`, policy: 'staff', bodyLimit: 'none', limiter: undefined },
    ]);
    // The same bodies as the org routes they mirror.
    const limitOf = (id: string): TownwiseRoute['bodyLimit'] | undefined => TOWNWISE_ROUTES.find((r) => r.id === id)?.bodyLimit;
    for (const [setup, org] of [
      ['admin.orgs.locations.create', 'org.locations.create'], ['admin.orgs.locations.update', 'org.locations.update'],
      ['admin.orgs.locations.remove', 'org.locations.remove'], ['admin.orgs.sales.upload', 'org.sales.upload'],
      ['admin.orgs.sales.remove', 'org.sales.remove'],
    ] as const) {
      expect(limitOf(setup)).toBe(limitOf(org));
    }
  });

  it('orders: the board, edits, rules, the setup, item sales and counts are member routes but deleting item sales', () => {
    const rows = TOWNWISE_ROUTES.filter((r) => r.id.startsWith('org.orders.'))
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    const base = '/org/locations/:locationId/orders';
    expect(rows).toEqual([
      { id: 'org.orders.get', method: 'GET', path: base, policy: 'member', bodyLimit: 'none', limiter: undefined },
      { id: 'org.orders.decision', method: 'POST', path: `${base}/decisions`, policy: 'member', bodyLimit: '2kb', limiter: undefined },
      { id: 'org.orders.rule', method: 'POST', path: `${base}/rules`, policy: 'member', bodyLimit: '2kb', limiter: undefined },
      { id: 'org.orders.rule_off', method: 'POST', path: `${base}/rules/off`, policy: 'member', bodyLimit: '1kb', limiter: undefined },
      { id: 'org.orders.setup.get', method: 'GET', path: `${base}/setup`, policy: 'member', bodyLimit: 'none', limiter: undefined },
      { id: 'org.orders.setup.save', method: 'PUT', path: `${base}/setup`, policy: 'member', bodyLimit: '1mb', limiter: undefined },
      { id: 'org.orders.item_sales.upload', method: 'POST', path: `${base}/item-sales`, policy: 'member', bodyLimit: '256kb', limiter: 'item_sales' },
      { id: 'org.orders.item_sales.remove', method: 'DELETE', path: `${base}/item-sales`, policy: 'org_admin', bodyLimit: 'none', limiter: undefined },
      { id: 'org.orders.counts.save', method: 'POST', path: `${base}/counts`, policy: 'member', bodyLimit: '32kb', limiter: undefined },
    ]);
  });

  it('D25: Open as admin is a staff POST with no body, sharing the view-as limiter', () => {
    expect(TOWNWISE_ROUTES.find((r) => r.id === 'admin.orgs.open_as_admin')).toMatchObject({
      method: 'POST', path: '/admin/orgs/:orgId/open-as-admin', policy: 'staff', bodyLimit: 'none', limiter: 'view-as',
    });
  });

  // D25's route classification: people, seats and requests stay closed while open as admin; every other non-staff route runs.
  const REFUSED = ['me.join', 'me.decline', 'me.welcome', 'requests.create', 'org.leave', 'org.members.list', 'org.members.add', 'org.members.update', 'org.members.remove'];
  it('D25: every route runs while open as admin except staff routes and the people, seat and request routes', () => {
    for (const r of TOWNWISE_ROUTES) {
      const staffRoute = r.policy === 'staff' || r.policy === 'staff_self';
      expect({ id: r.id, open: r.openAsAdmin === true }).toEqual({ id: r.id, open: !staffRoute && !REFUSED.includes(r.id) });
    }
    expect(REFUSED.filter((id) => !TOWNWISE_ROUTES.some((r) => r.id === id))).toEqual([]);
  });

  it('boot refuses a duplicate method and path', () => {
    expect(() => { assertRouteTable([route({ id: 'a' }), route({ id: 'b' })]); }).toThrow(ConfigError);
  });

  it('boot refuses a GET with a body limit', () => {
    expect(() => { assertRouteTable([route({ method: 'GET', bodyLimit: '32kb' })]); }).toThrow(ConfigError);
  });

  it('boot refuses a PUT without a streamed or 1 MB body, and a streamed body on any route but the chunk route', () => {
    expect(() => { assertRouteTable([route({ method: 'PUT', bodyLimit: '32kb' })]); }).toThrow(ConfigError);
    expect(() => { assertRouteTable([route({ method: 'PUT', bodyLimit: 'stream' })]); }).toThrow(ConfigError);
    // The ordering setup is saved whole, as one JSON document of up to 1 MB, and no other route takes one.
    expect(() => { assertRouteTable([route({ id: 'org.orders.setup.save', method: 'PUT', bodyLimit: '1mb' })]); }).not.toThrow();
    expect(() => { assertRouteTable([route({ method: 'PUT', bodyLimit: '1mb' })]); }).toThrow(ConfigError);
    expect(() => { assertRouteTable([route({ id: 'org.orders.setup.save', method: 'POST', bodyLimit: '1mb' })]); }).toThrow(ConfigError);
    expect(TOWNWISE_ROUTES.filter((r) => r.bodyLimit === '1mb').map((r) => r.id)).toEqual(['org.orders.setup.save']);
    expect(() => { assertRouteTable([route({ id: 'org.files.chunk', method: 'POST', bodyLimit: 'stream' })]); }).toThrow(ConfigError);
    expect(() => { assertRouteTable([route({ id: 'org.files.chunk', method: 'PUT', bodyLimit: 'stream' })]); }).not.toThrow();
  });

  it('declares every stored-files route with its policy, body limit and limiter, current before :importId', () => {
    const table = (id: string): Pick<TownwiseRoute, 'method' | 'path' | 'policy' | 'bodyLimit' | 'limiter'> | undefined => {
      const found = TOWNWISE_ROUTES.find((candidate) => candidate.id === id);
      return found === undefined ? undefined : {
        method: found.method, path: found.path, policy: found.policy, bodyLimit: found.bodyLimit,
        ...(found.limiter === undefined ? {} : { limiter: found.limiter }),
      };
    };
    const base = '/org/locations/:locationId';
    expect(table('org.files.create')).toEqual({ method: 'POST', path: `${base}/files`, policy: 'member', bodyLimit: '2kb', limiter: 'files' });
    expect(table('org.files.chunk')).toEqual({
      method: 'PUT', path: `${base}/files/:fileId/chunks/:index`, policy: 'member', bodyLimit: 'stream', limiter: 'file_chunks',
    });
    expect(table('org.files.complete')).toEqual({ method: 'POST', path: `${base}/files/:fileId/complete`, policy: 'member', bodyLimit: '2kb' });
    expect(table('org.files.list')).toEqual({ method: 'GET', path: `${base}/files`, policy: 'member', bodyLimit: 'none' });
    expect(table('org.files.get')).toEqual({ method: 'GET', path: `${base}/files/:fileId`, policy: 'member', bodyLimit: 'none' });
    expect(table('org.originals.remove')).toEqual({ method: 'DELETE', path: `${base}/originals`, policy: 'org_admin', bodyLimit: 'none' });
    expect(table('admin.orgs.originals.remove')).toEqual({ method: 'POST', path: '/admin/orgs/:orgId/originals/delete', policy: 'staff', bodyLimit: '32kb' });
    expect(table('org.files.entries')).toEqual({ method: 'GET', path: `${base}/files/:fileId/entries`, policy: 'member', bodyLimit: 'none' });
    expect(table('org.files.raw')).toEqual({ method: 'GET', path: `${base}/files/:fileId/raw`, policy: 'member', bodyLimit: 'none', limiter: 'downloads' });
    expect(table('org.files.clean')).toEqual({ method: 'GET', path: `${base}/files/:fileId/clean`, policy: 'member', bodyLimit: 'none', limiter: 'downloads' });
    expect(table('org.files.remove_raw')).toEqual({ method: 'DELETE', path: `${base}/files/:fileId/raw`, policy: 'member', bodyLimit: 'none' });
    expect(table('org.files.remove')).toEqual({ method: 'DELETE', path: `${base}/files/:fileId`, policy: 'member', bodyLimit: 'none' });
    expect(table('org.data.text')).toEqual({ method: 'POST', path: `${base}/data/text`, policy: 'member', bodyLimit: '32kb', limiter: 'files' });
    expect(table('org.imports.current')).toEqual({ method: 'GET', path: `${base}/imports/current`, policy: 'member', bodyLimit: 'none' });
    expect(table('org.imports.get')).toEqual({ method: 'GET', path: `${base}/imports/:importId`, policy: 'member', bodyLimit: 'none' });
    expect(table('org.imports.start')).toEqual({ method: 'POST', path: `${base}/imports/:importId/start`, policy: 'member', bodyLimit: '2kb' });
    expect(table('org.imports.answer')).toEqual({ method: 'POST', path: `${base}/imports/:importId/answer`, policy: 'member', bodyLimit: '2kb' });
    const ids = TOWNWISE_ROUTES.map((candidate) => candidate.id);
    expect(ids.indexOf('org.imports.current')).toBeLessThan(ids.indexOf('org.imports.get'));
  });

  it('D28: Your data is a member GET of the organization, and a member GET, PATCH, replace POST and DELETE of one item, with no route limiter', () => {
    const ids = ['org.data.list', 'org.data.get', 'org.data.update', 'org.data.replace', 'org.data.remove'];
    const rows = TOWNWISE_ROUTES.filter((r) => ids.includes(r.id))
      .map(({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }) => ({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }));
    expect(rows).toEqual([
      { id: 'org.data.list', method: 'GET', path: '/org/data', policy: 'member', bodyLimit: 'none', limiter: undefined, openAsAdmin: true },
      { id: 'org.data.get', method: 'GET', path: '/org/locations/:locationId/data/:ref', policy: 'member', bodyLimit: 'none', limiter: undefined, openAsAdmin: true },
      { id: 'org.data.update', method: 'PATCH', path: '/org/locations/:locationId/data/:ref', policy: 'member', bodyLimit: '2kb', limiter: undefined, openAsAdmin: true },
      {
        id: 'org.data.replace', method: 'POST', path: '/org/locations/:locationId/data/:ref/replace', policy: 'member', bodyLimit: '2kb',
        limiter: undefined, openAsAdmin: true,
      },
      { id: 'org.data.remove', method: 'DELETE', path: '/org/locations/:locationId/data/:ref', policy: 'member', bodyLimit: 'none', limiter: undefined, openAsAdmin: true },
    ]);
  });

  it('business rules are member routes with 2kb bodies on writes and no route limiter, after the notes block', () => {
    const base = '/org/locations/:locationId/rules';
    const rows = TOWNWISE_ROUTES.filter((r) => r.id.startsWith('org.rules.'))
      .map(({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }) => ({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }));
    expect(rows).toEqual([
      { id: 'org.rules.list', method: 'GET', path: base, policy: 'member', bodyLimit: 'none', limiter: undefined, openAsAdmin: true },
      { id: 'org.rules.create', method: 'POST', path: base, policy: 'member', bodyLimit: '2kb', limiter: undefined, openAsAdmin: true },
      { id: 'org.rules.update', method: 'PATCH', path: `${base}/:ruleId`, policy: 'member', bodyLimit: '2kb', limiter: undefined, openAsAdmin: true },
      { id: 'org.rules.remove', method: 'DELETE', path: `${base}/:ruleId`, policy: 'member', bodyLimit: 'none', limiter: undefined, openAsAdmin: true },
    ]);
    const ids = TOWNWISE_ROUTES.map((entry) => entry.id);
    expect(ids.indexOf('org.rules.list')).toBe(ids.indexOf('org.notes.remove') + 1);
  });

  it('owner calendars are member routes open as admin, with no route limiter, events before the :calendarId routes, and the only 2mb body', () => {
    const rows = TOWNWISE_ROUTES.filter((r) => r.id.startsWith('org.owner_calendars.'))
      .map(({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }) => ({ id, method, path, policy, bodyLimit, limiter, openAsAdmin }));
    const base = '/org/locations/:locationId/owner-calendars';
    const row = { policy: 'member', limiter: undefined, openAsAdmin: true };
    expect(rows).toEqual([
      { id: 'org.owner_calendars.list', method: 'GET', path: base, bodyLimit: 'none', ...row },
      { id: 'org.owner_calendars.events', method: 'GET', path: `${base}/events`, bodyLimit: 'none', ...row },
      { id: 'org.owner_calendars.create', method: 'POST', path: base, bodyLimit: '2mb', ...row },
      { id: 'org.owner_calendars.refresh', method: 'POST', path: `${base}/:calendarId/refresh`, bodyLimit: 'none', ...row },
      { id: 'org.owner_calendars.remove', method: 'DELETE', path: `${base}/:calendarId`, bodyLimit: 'none', ...row },
    ]);
    expect(TOWNWISE_ROUTES.filter((r) => r.bodyLimit === '2mb').map((r) => r.id)).toEqual(['org.owner_calendars.create']);
  });

  it('saving or setting aside a TownwiseAI proposal is a member POST with an 8kb body and no route limiter', () => {
    const proposal = TOWNWISE_ROUTES.find((entry) => entry.id === 'org.chat.proposal');
    expect(proposal).toMatchObject({
      method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/proposals/:proposalId', policy: 'member', bodyLimit: '8kb',
    });
    expect(proposal?.limiter).toBeUndefined();
  });

  it('renaming and switching a TownwiseAI version are member writes with a 1kb body and no route limiter', () => {
    const base = '/org/locations/:locationId/chat/:conversationId';
    const rows = TOWNWISE_ROUTES.filter((r) => r.id === 'org.chat.rename' || r.id === 'org.chat.active')
      .map(({ id, method, path, policy, bodyLimit, limiter }) => ({ id, method, path, policy, bodyLimit, limiter }));
    expect(rows).toEqual([
      { id: 'org.chat.rename', method: 'PATCH', path: base, policy: 'member', bodyLimit: '1kb', limiter: undefined },
      { id: 'org.chat.active', method: 'POST', path: `${base}/active`, policy: 'member', bodyLimit: '1kb', limiter: undefined },
    ]);
    const ids = TOWNWISE_ROUTES.map((entry) => entry.id);
    const after = ids.indexOf('org.chat.remove') + 1;
    expect(ids.slice(after, after + 2)).toEqual(['org.chat.rename', 'org.chat.active']);
  });

  it('the profile is a member GET and a member PATCH with a 1kb body and no route limiter', () => {
    const pick = (id: string) => {
      const entry = TOWNWISE_ROUTES.find((candidate) => candidate.id === id);
      return { id: entry?.id, method: entry?.method, path: entry?.path, policy: entry?.policy, bodyLimit: entry?.bodyLimit, limiter: entry?.limiter };
    };
    expect(pick('me.profile.get')).toEqual({ id: 'me.profile.get', method: 'GET', path: '/me/profile', policy: 'member', bodyLimit: 'none', limiter: undefined });
    expect(pick('me.profile.update')).toEqual({ id: 'me.profile.update', method: 'PATCH', path: '/me/profile', policy: 'member', bodyLimit: '1kb', limiter: undefined });
  });

  it('rating a TownwiseAI reply is a member POST with a 1kb body and no route limiter', () => {
    const feedback = TOWNWISE_ROUTES.find((entry) => entry.id === 'org.chat.feedback');
    expect(feedback).toMatchObject({
      method: 'POST', path: '/org/locations/:locationId/chat/:conversationId/feedback/:nodeId', policy: 'member', bodyLimit: '1kb',
    });
    expect(feedback?.limiter).toBeUndefined();
    const ids = TOWNWISE_ROUTES.map((entry) => entry.id);
    expect(ids.indexOf('org.chat.feedback')).toBe(ids.indexOf('org.chat.proposal') + 1);
  });

  it('D28: a proposal to keep text is a member GET and a member POST with a 2kb body, limited by files as Paste text is', () => {
    const path = '/org/locations/:locationId/chat/:conversationId/item-proposals/:proposalId';
    const rows = TOWNWISE_ROUTES.filter((r) => ['org.chat.item_proposal.get', 'org.chat.item_proposal'].includes(r.id))
      .map(({ id, method, path: at, policy, bodyLimit, limiter }) => ({ id, method, path: at, policy, bodyLimit, limiter }));
    expect(rows).toEqual([
      { id: 'org.chat.item_proposal.get', method: 'GET', path, policy: 'member', bodyLimit: 'none', limiter: undefined },
      { id: 'org.chat.item_proposal', method: 'POST', path, policy: 'member', bodyLimit: '2kb', limiter: 'files' },
    ]);
  });

  // U9, TownwiseAI's side panel.
  it('the side panel is a member GET, and answering a question a member POST with a 1kb body and no route limiter', () => {
    const base = '/org/locations/:locationId';
    expect(TOWNWISE_ROUTES.find((entry) => entry.id === 'org.agent.get')).toMatchObject({
      method: 'GET', path: `${base}/agent`, policy: 'member', bodyLimit: 'none',
    });
    const answer = TOWNWISE_ROUTES.find((entry) => entry.id === 'org.agent.answer');
    expect(answer).toMatchObject({ method: 'POST', path: `${base}/agent/questions/:questionId`, policy: 'member', bodyLimit: '1kb' });
    expect(answer?.limiter).toBeUndefined();
  });

  it('boot refuses staff_self on any route except POST /admin/view-as/end', () => {
    expect(() => { assertRouteTable([route({ policy: 'staff_self', path: '/admin/view-as' })]); }).toThrow(ConfigError);
    expect(() => { assertRouteTable([route({ policy: 'staff_self', path: '/admin/view-as/end' })]); }).not.toThrow();
  });

  it('boot refuses openAsAdmin on a staff or staff_self route', () => {
    expect(() => { assertRouteTable([route({ policy: 'staff', openAsAdmin: true })]); }).toThrow(ConfigError);
    expect(() => { assertRouteTable([route({ method: 'POST', path: '/admin/view-as/end', policy: 'staff_self', openAsAdmin: true })]); }).toThrow(ConfigError);
    for (const policy of ['signed_in', 'member', 'org_admin'] as const) {
      expect(() => { assertRouteTable([route({ policy, openAsAdmin: true })]); }).not.toThrow();
    }
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
      openAsAdmin: null,
    });
  });

  it('open as admin builds an org admin principal of the grant’s organization, acting as the staff member', () => {
    expect(principals.openAsAdmin).toMatchObject({
      kind: 'member', userId: user.id, email: user.email, role: 'org_admin', memberId: null, viewAs: null,
      openAsAdmin: { grantId: openGrant.id, actor: { userId: user.id, email: user.email, sessionId: auth.sessionId } },
    });
    expect(principals.openAsAdmin?.kind === 'member' ? principals.openAsAdmin.scope.orgId : null).toBe(openGrant.orgId);
  });

  it('a seat member is not in open as admin', () => {
    expect(principals.member).toMatchObject({ kind: 'member', openAsAdmin: null });
    expect(principals.admin).toMatchObject({ kind: 'member', openAsAdmin: null });
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
    expect(codeOf('staff_self', 'admin')).toBe('forbidden');
  });

  it('member, org_admin and staff_self pass open as admin, and it counts as a staff principal', () => {
    for (const policy of ['member', 'org_admin', 'staff_self'] as const) expect(codeOf(policy, 'openAsAdmin')).toBeNull();
    const staffish = (name: string): boolean => { const p = principals[name]; if (p === undefined) throw new Error(name); return isStaffPrincipal(p); };
    expect(staffish('openAsAdmin')).toBe(true);
    expect(staffish('admin')).toBe(false);
    expect(staffish('viewAsMember')).toBe(false);
  });

  it('staff answers forbidden in open as admin (the guard answers first in the chain)', () => {
    expect(codeOf('staff', 'openAsAdmin')).toBe('forbidden');
  });
});

describe('view-as guard', () => {
  const refusal = (method: TownwiseRoute['method'], policy: Policy, name: string): string | null => {
    const principal = principals[name];
    if (principal === undefined) throw new Error(name);
    return viewAsRefusal({ method, policy }, principal)?.code ?? null;
  };

  it('answers 409 view_as_active on every staff route, any method, before anything else', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(refusal(method, 'staff', 'viewAsMember')).toBe('view_as_active');
    }
  });

  it('answers 403 view_as_read_only on every other non-GET, and lets GETs and staff_self through', () => {
    for (const policy of ['signed_in', 'member', 'org_admin'] as const) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect(refusal(method, policy, 'viewAsPending')).toBe('view_as_read_only');
      expect(refusal('GET', policy, 'viewAsMember')).toBeNull();
    }
    expect(refusal('POST', 'staff_self', 'viewAsMember')).toBeNull();
  });

  it('does nothing outside view-as', () => {
    for (const name of ['staff', 'member', 'noOrg']) expect(refusal('POST', 'signed_in', name)).toBeNull();
  });

  it('does nothing in open as admin: no write is read-only', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) expect(refusal(method, 'member', 'openAsAdmin')).toBeNull();
  });
});

describe('open-as-admin guard', () => {
  const refusal = (target: Pick<TownwiseRoute, 'policy' | 'openAsAdmin'>, name = 'openAsAdmin'): string | null => {
    const principal = principals[name];
    if (principal === undefined) throw new Error(name);
    return openAsAdminRefusal(target, principal)?.code ?? null;
  };

  it('answers 409 open_as_admin_active on every staff route, any method', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(refusal(route({ method, policy: 'staff' }))).toBe('open_as_admin_active');
      // Boot refuses the mark on a staff route; the guard would still refuse it.
      expect(refusal(route({ method, policy: 'staff', openAsAdmin: true }))).toBe('open_as_admin_active');
    }
  });

  it('answers 403 open_as_admin_refused on every unmarked route, GETs included, and lets marked routes and staff_self through', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const policy of ['signed_in', 'member', 'org_admin'] as const) {
        expect(refusal(route({ method, policy }))).toBe('open_as_admin_refused');
        expect(refusal(route({ method, policy, openAsAdmin: true }))).toBeNull();
      }
    }
    expect(refusal({ policy: 'member' })).toBe('open_as_admin_refused');
    expect(refusal({ policy: 'signed_in' })).toBe('open_as_admin_refused');
    expect(refusal({ policy: 'member', openAsAdmin: true })).toBeNull();
    expect(refusal({ policy: 'staff_self' })).toBeNull();
  });

  it('does nothing outside open as admin, view-as included', () => {
    for (const name of ['staff', 'member', 'admin', 'noOrg', 'viewAsMember', 'viewAsPending', 'staffReauth']) {
      for (const policy of ['signed_in', 'member', 'org_admin', 'staff', 'staff_self'] as const) {
        expect(refusal({ policy }, name)).toBeNull();
      }
    }
  });
});
