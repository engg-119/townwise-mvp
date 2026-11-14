import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { addInvite, addRemovedSeat, addRequest, addSeat, createOrg } from './helpers/fixtures.ts';
import {
  call, makeStaff, MINUTE, refresh, removeStaffFactor, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
// Keeps the kit's magic-link send limit (20 per hour per IP) out of the way between tests.
beforeEach(async () => { await server.redis.flushdb(); });
afterEach(async () => { await removeStaffFactor(server); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function me(session: TestSession): Promise<MeResponse> {
  const res = await call(server, '/api/me', { session });
  expect(res.status).toBe(200);
  return await res.json() as MeResponse;
}

async function person(name: string): Promise<{ email: string; session: TestSession }> {
  const email = uniqueEmail(name);
  return { email, session: await signIn(server, email) };
}

describe('GET /api/me states (4.2)', () => {
  it('no_org for a new person, with the signed-in user and no staff block', async () => {
    const { email, session } = await person('new');
    expect(await me(session)).toEqual({
      user: { id: session.userId, email }, access: { state: 'no_org' }, viewAs: null, openAsAdmin: null, staff: null, welcome: null,
    });
  });

  it('member with the organization and role of the active seat', async () => {
    const { email, session } = await person('member');
    const orgId = await createOrg(server, { name: 'Lou’s Diner' });
    await addSeat(server, { orgId, userId: session.userId, email, role: 'org_admin' });
    expect((await me(session)).access).toEqual({ state: 'member', org: { id: orgId, name: 'Lou’s Diner' }, role: 'org_admin' });
  });

  it('org_suspended when the active seat is in a suspended organization', async () => {
    const { email, session } = await person('paused');
    const orgId = await createOrg(server, { name: 'Paused Grill', status: 'suspended' });
    await addSeat(server, { orgId, userId: session.userId, email });
    expect((await me(session)).access).toEqual({ state: 'org_suspended', org: { name: 'Paused Grill' } });
  });

  it('invited, naming who added the address: the org admin’s current email, staff, or null when that account is gone', async () => {
    const admin = await person('admin');
    const { email, session } = await person('invitee');
    const byAdmin = await createOrg(server, { name: 'Admin Org' });
    const byStaff = await createOrg(server, { name: 'Staff Org' });
    const byGone = await createOrg(server, { name: 'Gone Org' });
    const t0 = server.clock.now().getTime();
    const adminInvite = await addInvite(server, { orgId: byAdmin, email, invitedBy: admin.session.userId, role: 'org_admin', invitedAt: new Date(t0 - 3 * MINUTE) });
    const staffInvite = await addInvite(server, { orgId: byStaff, email, invitedBy: 'f'.repeat(24), addedByStaff: true, invitedAt: new Date(t0 - 2 * MINUTE) });
    const goneInvite = await addInvite(server, { orgId: byGone, email, invitedBy: new Types.ObjectId().toHexString(), invitedAt: new Date(t0 - MINUTE) });
    expect((await me(session)).access).toEqual({
      state: 'invited',
      pendingRequest: null,
      invitations: [
        { inviteId: adminInvite, orgName: 'Admin Org', role: 'org_admin', invitedBy: { staff: false, email: admin.email } },
        { inviteId: staffInvite, orgName: 'Staff Org', role: 'member', invitedBy: { staff: true, email: null } },
        { inviteId: goneInvite, orgName: 'Gone Org', role: 'member', invitedBy: { staff: false, email: null } },
      ],
    });
  });

  it('the same email invited by two organizations is offered both', async () => {
    const { email, session } = await person('twice');
    const a = await createOrg(server, { name: 'Org One' });
    const b = await createOrg(server, { name: 'Org Two' });
    await addInvite(server, { orgId: a, email, invitedBy: 'f'.repeat(24) });
    await addInvite(server, { orgId: b, email, invitedBy: 'f'.repeat(24) });
    const access = (await me(session)).access;
    expect(access.state).toBe('invited');
    expect(access.state === 'invited' ? access.invitations.map((invite) => invite.orgName).sort() : []).toEqual(['Org One', 'Org Two']);
  });

  it('ignores invitations in a suspended organization', async () => {
    const { email, session } = await person('suspended-invite');
    const orgId = await createOrg(server, { name: 'Paused', status: 'suspended' });
    await addInvite(server, { orgId, email, invitedBy: 'f'.repeat(24) });
    expect((await me(session)).access).toEqual({ state: 'no_org' });
  });

  it('pending with the request; one stored before places, with no place id, reads places as none', async () => {
    const { email, session } = await person('pending');
    const requestId = await addRequest(server, { userId: session.userId, email, status: 'pending', orgName: 'Moose Tavern' });
    expect((await me(session)).access).toEqual({
      state: 'pending',
      request: {
        id: requestId, orgName: 'Moose Tavern', contactName: 'Fixture Contact', contactRole: 'Owner',
        town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' }, locationCount: 1, note: null, status: 'pending',
        createdAt: server.clock.now().toISOString(), decidedAt: null, decisionMessage: null, places: [],
      },
    });
  });

  it('a request stored with a single place id reads it as one place, named null, in the request’s town', async () => {
    const { email, session } = await person('place');
    await addRequest(server, { userId: session.userId, email, status: 'pending', placeId: 'ChIJTestPlace0001' });
    expect((await me(session)).access).toMatchObject({
      state: 'pending',
      request: { places: [{ placeId: 'ChIJTestPlace0001', name: null, town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } }] },
    });
  });

  it('an invitation outranks a pending request and carries it as pendingRequest', async () => {
    const { email, session } = await person('both');
    const requestId = await addRequest(server, { userId: session.userId, email, status: 'pending' });
    const orgId = await createOrg(server, { name: 'Team Org' });
    await addInvite(server, { orgId, email, invitedBy: 'f'.repeat(24) });
    const access = (await me(session)).access;
    expect(access.state).toBe('invited');
    expect(access.state === 'invited' ? access.pendingRequest?.id : null).toBe(requestId);
  });

  it('rejected with the decision message', async () => {
    const { email, session } = await person('rejected');
    await addRequest(server, { userId: session.userId, email, status: 'rejected', decidedAt: server.clock.now(), decisionMessage: 'We could not verify the restaurant.' });
    const access = (await me(session)).access;
    expect(access).toMatchObject({ state: 'rejected', request: { status: 'rejected', decisionMessage: 'We could not verify the restaurant.' } });
  });

  it('removed, with byYou when the person left', async () => {
    const left = await person('left');
    const kicked = await person('kicked');
    const orgId = await createOrg(server, { name: 'Former Org' });
    const at = server.clock.now();
    await addRemovedSeat(server, { orgId, userId: left.session.userId, email: left.email, removedAt: at, removedBy: left.session.userId });
    await addRemovedSeat(server, { orgId, userId: kicked.session.userId, email: kicked.email, removedAt: at, removedBy: 'f'.repeat(24) });
    expect((await me(left.session)).access).toEqual({ state: 'removed', org: { name: 'Former Org' }, removedAt: at.toISOString(), byYou: true });
    expect((await me(kicked.session)).access).toEqual({ state: 'removed', org: { name: 'Former Org' }, removedAt: at.toISOString(), byYou: false });
  });

  it('the newer of the latest rejected request and the latest removed seat wins', async () => {
    const orgId = await createOrg(server, { name: 'Order Org' });
    const t = server.clock.now().getTime();
    const rejectedLater = await person('rejected-later');
    await addRemovedSeat(server, { orgId, userId: rejectedLater.session.userId, email: rejectedLater.email, removedAt: new Date(t - 2 * MINUTE), removedBy: 'f'.repeat(24) });
    await addRequest(server, { userId: rejectedLater.session.userId, email: rejectedLater.email, status: 'rejected', createdAt: new Date(t - 2 * MINUTE), decidedAt: new Date(t - MINUTE) });
    expect((await me(rejectedLater.session)).access.state).toBe('rejected');

    const removedLater = await person('removed-later');
    await addRequest(server, { userId: removedLater.session.userId, email: removedLater.email, status: 'rejected', createdAt: new Date(t - 3 * MINUTE), decidedAt: new Date(t - 2 * MINUTE) });
    await addRemovedSeat(server, { orgId, userId: removedLater.session.userId, email: removedLater.email, removedAt: new Date(t - MINUTE), removedBy: 'f'.repeat(24) });
    expect((await me(removedLater.session)).access.state).toBe('removed');
  });

  it('withdrawn and approved requests do not count as pending or rejected', async () => {
    const { email, session } = await person('withdrawn');
    await addRequest(server, { userId: session.userId, email, status: 'withdrawn' });
    await addRequest(server, { userId: session.userId, email, status: 'approved' });
    expect((await me(session)).access).toEqual({ state: 'no_org' });
  });
});

describe('staff branch (4.2 step 2)', () => {
  it('a staff address with no factor is staff_setup_required', async () => {
    const session = await signIn(server, STAFF_EMAIL);
    expect(await me(session)).toEqual({
      user: { id: session.userId, email: STAFF_EMAIL }, access: { state: 'staff_setup_required' }, viewAs: null, openAsAdmin: null,
      staff: null, welcome: null,
    });
  });

  it('a session created before codes were enabled is staff_reauth_required, session_before_codes', async () => {
    const session = await signIn(server, STAFF_EMAIL);
    await makeStaff(server, session.userId, { enabledAt: new Date(server.clock.now().getTime() + 1000) });
    expect((await me(session)).access).toEqual({ state: 'staff_reauth_required', reason: 'session_before_codes' });
  });

  it('a session created after codes were enabled is staff, verified until the session start plus 60 minutes', async () => {
    const start = server.clock.now();
    const session = await signInStaff(server);
    expect(await me(session)).toEqual({
      user: { id: session.userId, email: STAFF_EMAIL }, access: { state: 'staff' }, viewAs: null, openAsAdmin: null,
      staff: { verifiedUntil: new Date(start.getTime() + 60 * MINUTE).toISOString() }, welcome: null,
    });
  });

  it('with TOWNWISE_STAFF_TWO_STEP=off (development), staff need no codes and are verified for 60 minutes from each request', async () => {
    const open = await startTownwiseServer({ env: { TOWNWISE_STAFF_TWO_STEP: 'off' } });
    try {
      const session = await signIn(open, STAFF_EMAIL);
      open.clock.advance(2 * 60 * MINUTE);
      await refresh(open, session);
      const res = await call(open, '/api/me', { session });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        access: { state: 'staff' }, staff: { verifiedUntil: new Date(open.clock.now().getTime() + 60 * MINUTE).toISOString() },
      });
    } finally {
      await open.close();
    }
  });

  it('a staff email that is also invited, or holds a seat, resolves as staff, never as member', async () => {
    const session = await signInStaff(server);
    const orgId = await createOrg(server, { name: 'Invites Staff' });
    await addInvite(server, { orgId, email: STAFF_EMAIL, invitedBy: 'f'.repeat(24) });
    await addSeat(server, { orgId, userId: session.userId, email: STAFF_EMAIL });
    expect((await me(session)).access).toEqual({ state: 'staff' });
  });
});

describe('a deleted kit user', () => {
  it('answers 401 unauthenticated from resolveAccess', async () => {
    const { session } = await person('gone');
    await server.connection.collection('users').deleteOne({ _id: new Types.ObjectId(session.userId) });
    const res = await call(server, '/api/me', { session });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated', message: 'Unauthenticated' });
  });
});
