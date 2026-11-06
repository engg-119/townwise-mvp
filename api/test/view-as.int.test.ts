// View-as resolution and the guard (spec 4.2 step 2.4, 7.2 step 4, 8). These tests write grants directly in the
// shape of spec 6.8; Start and End through the API are in view-as-routes.int.test.ts.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import { addGrant, addRequest, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { PROBE_ROUTES } from './helpers/probe.ts';
import {
  call, logLines, makeStaff, MINUTE, refresh, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;

beforeAll(async () => { server = await startTownwiseServer({ probe: PROBE_ROUTES }); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
});
afterEach(async () => {
  await server.authStores.totp.remove(staff.userId);
  await server.connection.collection('tw_view_as_grants').deleteMany({});
});

async function memberOf(name: string): Promise<{ email: string; session: TestSession; orgId: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  const orgId = await createOrg(server, { name: `${name} Org` });
  await addSeat(server, { orgId, userId: session.userId, email, role: 'org_admin' });
  return { email, session, orgId };
}

async function me(session: TestSession): Promise<MeResponse> {
  const res = await call(server, '/api/me', { session });
  expect(res.status).toBe(200);
  return await res.json() as MeResponse;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

describe('a live grant', () => {
  it('returns the target’s exact access with viewAs set; user and staff stay the staff member', async () => {
    const target = await memberOf('target');
    const startedAt = server.clock.now();
    const grantId = await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    expect(await me(staff)).toEqual({
      user: { id: staff.userId, email: STAFF_EMAIL },
      access: { state: 'member', org: { id: target.orgId, name: 'target Org' }, role: 'org_admin' },
      viewAs: {
        id: grantId,
        target: { userId: target.session.userId, email: target.email },
        org: { id: target.orgId, name: 'target Org' },
        role: 'org_admin',
        reason: 'Support request from the owner',
        startedAt: startedAt.toISOString(),
        endsAt: new Date(startedAt.getTime() + 30 * MINUTE).toISOString(),
      },
      staff: { verifiedUntil: new Date(startedAt.getTime() + 60 * MINUTE).toISOString() },
      welcome: null,
    });
  });

  it('shows Waiting exactly as the target sees it', async () => {
    const email = `waiting-${randomUUID().slice(0, 8)}@example.test`;
    const target = await signIn(server, email);
    await addRequest(server, { userId: target.userId, email, status: 'pending' });
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.userId, orgId: null });
    const body = await me(staff);
    expect(body.access).toEqual((await me(target)).access);
    expect(body.access.state).toBe('pending');
    expect(body.viewAs).toMatchObject({ org: null, role: null });
  });

  it('refuses every non-GET without the staff policy with 403 view_as_read_only', async () => {
    const target = await memberOf('readonly');
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    expect(await errorOf(await call(server, '/api/me/join', { session: staff, json: { inviteId: 'f'.repeat(24) } })))
      .toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await errorOf(await call(server, '/api/me/decline', { session: staff, json: { inviteId: 'f'.repeat(24) } })))
      .toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await errorOf(await call(server, '/probe/member', { session: staff, json: {} })))
      .toEqual({ status: 403, error: 'view_as_read_only' });
  });

  it('answers 409 view_as_active on every staff route, any method', async () => {
    const target = await memberOf('staffroute');
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    expect(await errorOf(await call(server, '/probe/staff', { session: staff }))).toEqual({ status: 409, error: 'view_as_active' });
    expect(await errorOf(await call(server, '/probe/staff', { session: staff, json: {} }))).toEqual({ status: 409, error: 'view_as_active' });
  });

  it('lets GETs read as the target and logs townwise.view_as_read with ids only', async () => {
    const target = await memberOf('reader');
    const grantId = await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    server.logs.length = 0;
    const res = await call(server, '/probe/member', { session: staff });
    expect(await res.json()).toEqual({ kind: 'member', orgId: target.orgId, role: 'org_admin' });
    const reads = logLines(server).filter((line) => line.msg === 'townwise.view_as_read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ grantId, routeId: 'probe.member.read' });
    expect(server.logs.join('\n')).not.toContain(target.email);
  });

  it('ends no later than the 60-minute staff window', async () => {
    server.clock.advance(40 * MINUTE);
    await refresh(server, staff);
    const target = await memberOf('window');
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    const body = await me(staff);
    expect(body.viewAs?.endsAt).toBe(body.staff?.verifiedUntil);
  });
});

describe('the guard, generated from the route table', () => {
  const withIds = (path: string): string => path.replace(/:[A-Za-z]+/g, () => new Types.ObjectId().toHexString());

  it('every non-GET route without the staff policy answers 403 view_as_read_only, and nothing is written', async () => {
    const target = await memberOf('generated-write');
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    const writes = TOWNWISE_ROUTES.filter((route) => route.method !== 'GET' && route.policy !== 'staff' && route.policy !== 'staff_self');
    expect(writes.length).toBeGreaterThan(0);
    const before = (await auditEvents(server)).length;
    for (const route of writes) {
      const res = await call(server, `/api${withIds(route.path)}`, {
        method: route.method, session: staff, ...(route.method === 'DELETE' ? {} : { json: {} }),
      });
      expect({ route: route.id, ...(await errorOf(res)) }).toEqual({ route: route.id, status: 403, error: 'view_as_read_only' });
    }
    expect((await auditEvents(server)).length).toBe(before);
  });

  it('every route with the staff policy, any method, answers 409 view_as_active', async () => {
    const target = await memberOf('generated-staff');
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    const staffRoutes = TOWNWISE_ROUTES.filter((route) => route.policy === 'staff');
    expect(staffRoutes.length).toBeGreaterThan(0);
    for (const route of staffRoutes) {
      const res = await call(server, `/api${withIds(route.path)}`, {
        method: route.method, session: staff, ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: {} }),
      });
      expect({ route: route.id, ...(await errorOf(res)) }).toEqual({ route: route.id, status: 409, error: 'view_as_active' });
    }
  });
});

describe('a grant that is not live is ignored', () => {
  it('after it expires', async () => {
    const target = await memberOf('expired');
    await addGrant(server, {
      actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId,
      startedAt: new Date(server.clock.now().getTime() - 31 * MINUTE),
    });
    const body = await me(staff);
    expect(body).toMatchObject({ access: { state: 'staff' }, viewAs: null });
    expect((await call(server, '/probe/staff', { session: staff })).status).toBe(200);
  });

  it('in another session of the same staff member', async () => {
    await server.authStores.totp.remove(staff.userId);
    const first = await signIn(server, STAFF_EMAIL);
    const second = await signIn(server, STAFF_EMAIL);
    await makeStaff(server, first.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
    const target = await memberOf('other-tab');
    await addGrant(server, { actorUserId: first.userId, sessionId: first.sessionId, targetUserId: target.session.userId, orgId: target.orgId });
    expect((await me(first)).viewAs).not.toBeNull();
    expect(await me(second)).toMatchObject({ access: { state: 'staff' }, viewAs: null });
  });

  it('once the target joins, leaves or changes organization', async () => {
    const email = `mover-${randomUUID().slice(0, 8)}@example.test`;
    const target = await signIn(server, email);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.userId, orgId: null });
    expect((await me(staff)).viewAs).not.toBeNull();
    const orgId = await createOrg(server, { name: 'Joined Later' });
    await addSeat(server, { orgId, userId: target.userId, email });
    expect(await me(staff)).toMatchObject({ access: { state: 'staff' }, viewAs: null });
  });

  it('once the staff session is past its 60 minutes, which also ends the staff state', async () => {
    const target = await memberOf('stale');
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: target.session.userId, orgId: target.orgId, minutes: 120 });
    server.clock.advance(61 * MINUTE);
    await refresh(server, staff);
    expect(await me(staff)).toMatchObject({ access: { state: 'staff_reauth_required', reason: 'session_too_old' }, viewAs: null, staff: null });
  });
});
