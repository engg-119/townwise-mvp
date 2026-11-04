// Team (spec F5, F6, 10.6): an org admin lists, adds, changes roles and removes, in their own organization only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import type { AddResult, MemberView } from '../src/handlers/team.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import { addInvite, addRequest, addSeat, auditEvents, createOrg, memberDoc } from './helpers/fixtures.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });
afterEach(async () => { await removeStaffFactor(server); });

interface Person { email: string; session: TestSession }

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function person(name: string): Promise<Person> {
  const email = uniqueEmail(name);
  return { email, session: await signIn(server, email) };
}

/** An organization with one signed-in org admin. */
async function orgWithAdmin(name: string): Promise<{ orgId: string; admin: Person; adminSeat: string }> {
  const orgId = await createOrg(server, { name });
  const admin = await person('admin');
  const adminSeat = await addSeat(server, { orgId, userId: admin.session.userId, email: admin.email, role: 'org_admin' });
  return { orgId, admin, adminSeat };
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function add(session: TestSession, emails: string[], role?: 'org_admin' | 'member'): Promise<Response> {
  return call(server, '/api/org/members', { session, json: role === undefined ? { emails } : { emails, role } });
}

async function addOk(session: TestSession, emails: string[], role?: 'org_admin' | 'member'): Promise<{ results: AddResult[]; members: MemberView[] }> {
  const res = await add(session, emails, role);
  expect(res.status).toBe(200);
  return await res.json() as { results: AddResult[]; members: MemberView[] };
}

async function team(session: TestSession): Promise<MemberView[]> {
  const res = await call(server, '/api/org/members', { session });
  expect(res.status).toBe(200);
  return (await res.json() as { members: MemberView[] }).members;
}

function setRole(session: TestSession, memberId: string, role: string): Promise<Response> {
  return call(server, `/api/org/members/${memberId}`, { method: 'PATCH', session, json: { role } });
}

function remove(session: TestSession, memberId: string): Promise<Response> {
  return call(server, `/api/org/members/${memberId}`, { method: 'DELETE', session });
}

async function me(session: TestSession): Promise<MeResponse> {
  const res = await call(server, '/api/me', { session });
  expect(res.status).toBe(200);
  return await res.json() as MeResponse;
}

async function eventsFor(targetId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === targetId);
}

async function activeAdmins(orgId: string): Promise<number> {
  return server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(orgId), status: 'active', role: 'org_admin' });
}

describe('GET /api/org/members', () => {
  it('lists active members and open invitations, oldest first, with the current kit email for seats and “You” for the caller', async () => {
    const start = server.clock.now().getTime();
    const { orgId, admin, adminSeat } = await orgWithAdmin('Listing Org');
    server.clock.advance(1000);
    const member = await person('member');
    const memberSeat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    server.clock.advance(1000);
    const invited = uniqueEmail('invited');
    const inviteId = await addInvite(server, { orgId, email: invited, invitedBy: 'f'.repeat(24), addedByStaff: true, role: 'org_admin' });
    await server.connection.collection('tw_members').insertOne({
      orgId: new Types.ObjectId(orgId), email: uniqueEmail('gone'), role: 'member', status: 'removed', userId: 'e'.repeat(24),
      invitedAt: server.clock.now(), invitedBy: 'fixture', addedByStaff: false, joinedAt: server.clock.now(),
      removedAt: server.clock.now(), removedBy: admin.session.userId,
    });
    // The member's Google address changed after they joined: Team shows the current one.
    const renamed = uniqueEmail('renamed');
    expect(await server.authStores.users.updateEmail({ id: member.session.userId, from: member.email, to: renamed })).not.toBeNull();

    const members = await team(admin.session);
    expect(members.map((m) => m.id)).toEqual([adminSeat, memberSeat, inviteId]);
    expect(members[0]).toMatchObject({ email: admin.email, role: 'org_admin', status: 'active', isYou: true, addedByStaff: false });
    expect(members[1]).toMatchObject({ email: renamed, role: 'member', status: 'active', isYou: false });
    expect(members[2]).toEqual({
      id: inviteId, email: invited, role: 'org_admin', status: 'invited',
      invitedAt: server.clock.now().toISOString(), joinedAt: null, isYou: false, addedByStaff: true,
    });
    expect(Date.parse(members[1]?.joinedAt ?? '')).toBeGreaterThan(start);
  });
});

describe('POST /api/org/members (F5)', () => {
  it('normalizes each address like the kit, collapses duplicates and answers one outcome per address', async () => {
    const { orgId, admin } = await orgWithAdmin('Adding Org');
    const member = await person('member');
    await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    const already = uniqueEmail('already');
    await addInvite(server, { orgId, email: already, invitedBy: admin.session.userId });
    const fresh = uniqueEmail('fresh');

    const { results, members } = await addOk(admin.session, [
      `  ${fresh.toUpperCase()} `, fresh, already, member.email.toUpperCase(), admin.email, 'not an email', '',
    ]);
    expect(results).toEqual([
      { email: fresh, outcome: 'invited' },
      { email: already, outcome: 'already_invited' },
      { email: member.email, outcome: 'already_member' },
      { email: admin.email, outcome: 'already_member' },
      { email: 'not an email', outcome: 'invalid' },
      { email: '', outcome: 'invalid' },
    ]);
    expect(members.map((m) => m.email)).toEqual([admin.email, member.email, already, fresh]);

    const row = await server.connection.collection('tw_members').findOne({ orgId: new Types.ObjectId(orgId), inviteEmail: fresh });
    expect(row).toMatchObject({
      email: fresh, role: 'member', status: 'invited', userId: null, invitedBy: admin.session.userId,
      invitedAt: server.clock.now(), addedByStaff: false, joinedAt: null, removedAt: null, removedBy: null,
    });
    expect(row).not.toHaveProperty('activeUserId');
    const events = await eventsFor(String(row?._id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'member.invited', actorUserId: admin.session.userId, actorEmail: admin.email, actorRole: 'org_admin',
      viewAsGrantId: null, orgId: new Types.ObjectId(orgId), details: { email: fresh, role: 'member' },
    });
    // Only the one invitation was recorded.
    const invitedEvents = (await auditEvents(server)).filter((e) => e.action === 'member.invited' && String(e.orgId) === orgId);
    expect(invitedEvents).toHaveLength(1);
  });

  it('invites with the chosen role', async () => {
    const { admin } = await orgWithAdmin('Role Org');
    const email = uniqueEmail('new-admin');
    const { members } = await addOk(admin.session, [email], 'org_admin');
    expect(members.find((m) => m.email === email)).toMatchObject({ role: 'org_admin', status: 'invited' });
  });

  it('no outcome depends on another organization', async () => {
    const a = await orgWithAdmin('Org A');
    const b = await orgWithAdmin('Org B');
    const bMember = await person('b-member');
    await addSeat(server, { orgId: b.orgId, userId: bMember.session.userId, email: bMember.email });
    const bInvited = uniqueEmail('b-invited');
    await addInvite(server, { orgId: b.orgId, email: bInvited, invitedBy: b.admin.session.userId });

    const { results } = await addOk(a.admin.session, [bMember.email, bInvited, b.admin.email]);
    expect(results.map((r) => r.outcome)).toEqual(['invited', 'invited', 'invited']);
    // An invitation from A never moves B's member out of B.
    expect((await me(bMember.session)).access).toMatchObject({ state: 'member', org: { id: b.orgId } });
  });

  it('refuses more than 20 addresses, an address over 320 characters, an empty list and an unknown role', async () => {
    const { admin } = await orgWithAdmin('Limits Org');
    const many = Array.from({ length: 21 }, (_, i) => `p${String(i)}@example.test`);
    expect(await errorOf(await add(admin.session, many))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await add(admin.session, [`${'a'.repeat(310)}@example.test`]))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await add(admin.session, []))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await call(server, '/api/org/members', { session: admin.session, json: { emails: ['x@example.test'], role: 'owner' } })))
      .toEqual({ status: 400, error: 'invalid_request' });
  });

  it('is 409 member_limit past 200 active plus invited people, and adds nobody', async () => {
    const { orgId, admin } = await orgWithAdmin('Full Org');
    const now = server.clock.now();
    await server.connection.collection('tw_members').insertMany(Array.from({ length: 198 }, (_, i) => {
      const email = `seed-${String(i)}-${randomUUID().slice(0, 4)}@example.test`;
      return {
        orgId: new Types.ObjectId(orgId), email, role: 'member', status: 'invited', inviteEmail: email, userId: null,
        invitedAt: now, invitedBy: admin.session.userId, addedByStaff: false, joinedAt: null, removedAt: null, removedBy: null,
      };
    }));
    const before = await server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(orgId) });
    expect(await errorOf(await add(admin.session, [uniqueEmail('one'), uniqueEmail('two')]))).toEqual({ status: 409, error: 'member_limit' });
    expect(await server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(orgId) })).toBe(before);
    const { results } = await addOk(admin.session, [uniqueEmail('last')]);
    expect(results[0]?.outcome).toBe('invited');
    // At the cap, an address already on the team is still answered.
    expect((await addOk(admin.session, [admin.email])).results[0]?.outcome).toBe('already_member');
  });
});

describe('an added email works the first time that person continues with Google', () => {
  it('a person who already signed in, with no organization, is offered the invitation and joins as the role chosen', async () => {
    const { orgId, admin } = await orgWithAdmin('Join Org');
    const joiner = await person('joiner');
    expect((await me(joiner.session)).access).toEqual({ state: 'no_org' });
    await addOk(admin.session, [joiner.email], 'org_admin');

    const access = (await me(joiner.session)).access;
    expect(access).toMatchObject({
      state: 'invited', pendingRequest: null,
      invitations: [{ orgName: 'Join Org', role: 'org_admin', invitedBy: { staff: false, email: admin.email } }],
    });
    const inviteId = access.state === 'invited' ? access.invitations[0]?.inviteId ?? '' : '';
    const joined = await call(server, '/api/me/join', { session: joiner.session, json: { inviteId } });
    expect(joined.status).toBe(200);
    expect((await joined.json() as MeResponse).access).toEqual({ state: 'member', org: { id: orgId, name: 'Join Org' }, role: 'org_admin' });
    expect((await team(admin.session)).find((m) => m.id === inviteId)).toMatchObject({ status: 'active', email: joiner.email });
  });

  it('a person with a pending request is offered the invitation, and Join withdraws the request', async () => {
    const { orgId, admin } = await orgWithAdmin('Pending Join Org');
    const joiner = await person('pending');
    const requestId = await addRequest(server, { userId: joiner.session.userId, email: joiner.email, status: 'pending' });
    expect((await me(joiner.session)).access.state).toBe('pending');
    await addOk(admin.session, [joiner.email]);

    const access = (await me(joiner.session)).access;
    expect(access).toMatchObject({ state: 'invited', pendingRequest: { id: requestId, status: 'pending' } });
    const inviteId = access.state === 'invited' ? access.invitations[0]?.inviteId ?? '' : '';
    expect((await call(server, '/api/me/join', { session: joiner.session, json: { inviteId } })).status).toBe(200);
    expect((await me(joiner.session)).access).toMatchObject({ state: 'member', org: { id: orgId }, role: 'member' });
    expect(await server.connection.collection('tw_access_requests').findOne({ _id: new Types.ObjectId(requestId) }))
      .toMatchObject({ status: 'withdrawn', withdrawnReason: 'joined_org' });
  });

  it('a person added before they ever signed in is offered the invitation at their first sign-in', async () => {
    const { admin } = await orgWithAdmin('First Sign-in Org');
    const email = uniqueEmail('later');
    await addOk(admin.session, [email]);
    const later = await signIn(server, email);
    expect((await me(later)).access).toMatchObject({ state: 'invited', invitations: [{ orgName: 'First Sign-in Org' }] });
  });
});

describe('PATCH /api/org/members/:memberId (F6)', () => {
  it('promotes and demotes, recording member.role_changed', async () => {
    const { orgId, admin } = await orgWithAdmin('Roles Org');
    const member = await person('member');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });

    const promoted = await setRole(admin.session, seat, 'org_admin');
    expect(promoted.status).toBe(200);
    expect((await promoted.json() as { member: MemberView }).member).toMatchObject({ id: seat, role: 'org_admin', status: 'active', email: member.email });
    expect((await me(member.session)).access).toMatchObject({ state: 'member', role: 'org_admin' });

    expect((await setRole(member.session, seat, 'member')).status).toBe(200);   // demoting oneself while another admin exists
    expect((await memberDoc(server, seat))?.role).toBe('member');

    const changes = (await eventsFor(seat)).filter((e) => e.action === 'member.role_changed');
    expect(changes.map((e) => e.details)).toEqual([
      { email: member.email, from: 'member', to: 'org_admin' },
      { email: member.email, from: 'org_admin', to: 'member' },
    ]);
    expect(changes[1]).toMatchObject({ actorUserId: member.session.userId, actorRole: 'org_admin' });
  });

  it('demoting the last admin is 409 last_admin, the role stays, and nothing is recorded', async () => {
    const { admin, adminSeat } = await orgWithAdmin('Last Admin Org');
    expect(await errorOf(await setRole(admin.session, adminSeat, 'member'))).toEqual({ status: 409, error: 'last_admin' });
    expect(await memberDoc(server, adminSeat)).toMatchObject({ role: 'org_admin', status: 'active' });
    expect((await eventsFor(adminSeat)).filter((e) => e.action === 'member.role_changed')).toEqual([]);
  });

  it('changes an invitation’s role; the same role is a no-op with no event', async () => {
    const { orgId, admin } = await orgWithAdmin('Invite Role Org');
    const inviteId = await addInvite(server, { orgId, email: uniqueEmail('inv'), invitedBy: admin.session.userId });
    expect((await setRole(admin.session, inviteId, 'org_admin')).status).toBe(200);
    expect(await memberDoc(server, inviteId)).toMatchObject({ role: 'org_admin', status: 'invited' });
    expect((await setRole(admin.session, inviteId, 'org_admin')).status).toBe(200);
    expect((await eventsFor(inviteId)).filter((e) => e.action === 'member.role_changed')).toHaveLength(1);
  });

  it('concurrent demotions of the last two admins leave at least one admin', async () => {
    const { orgId, admin, adminSeat } = await orgWithAdmin('Race Org');
    const second = await person('second');
    const secondSeat = await addSeat(server, { orgId, userId: second.session.userId, email: second.email, role: 'org_admin' });
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all([setRole(admin.session, secondSeat, 'member'), setRole(second.session, adminSeat, 'member')]);
      expect(await activeAdmins(orgId)).toBeGreaterThanOrEqual(1);
      for (const res of results) expect([200, 403, 409]).toContain(res.status);
      // Restore both admins for the next round.
      await server.connection.collection('tw_members').updateMany({ orgId: new Types.ObjectId(orgId) }, { $set: { role: 'org_admin' } });
    }
  });

  it('answers 404 for an unknown, removed or malformed id, and 400 for an unknown role', async () => {
    const { orgId, admin, adminSeat } = await orgWithAdmin('Missing Org');
    const gone = await person('gone');
    const seat = await addSeat(server, { orgId, userId: gone.session.userId, email: gone.email });
    expect((await remove(admin.session, seat)).status).toBe(204);
    expect(await errorOf(await setRole(admin.session, seat, 'org_admin'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await setRole(admin.session, new Types.ObjectId().toHexString(), 'member'))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await setRole(admin.session, 'nope', 'member'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await setRole(admin.session, adminSeat, 'owner'))).toEqual({ status: 400, error: 'invalid_request' });
  });
});

describe('DELETE /api/org/members/:memberId (F6, F7)', () => {
  it('deletes an invitation and records member.removed with wasStatus invited; the invitee is back to no organization', async () => {
    const { orgId, admin } = await orgWithAdmin('Uninvite Org');
    const invitee = await person('invitee');
    const inviteId = await addInvite(server, { orgId, email: invitee.email, invitedBy: admin.session.userId });
    expect((await me(invitee.session)).access.state).toBe('invited');

    expect((await remove(admin.session, inviteId)).status).toBe(204);
    expect(await memberDoc(server, inviteId)).toBeNull();
    expect((await me(invitee.session)).access).toEqual({ state: 'no_org' });
    const events = await eventsFor(inviteId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'member.removed', actorRole: 'org_admin', details: { email: invitee.email, wasStatus: 'invited' } });
  });

  it('removes a member: their next request is 403 no_access, their session stays, and they see that they were removed', async () => {
    const { orgId, admin } = await orgWithAdmin('Removal Org');
    const member = await person('member');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });

    expect((await remove(admin.session, seat)).status).toBe(204);
    const doc = await memberDoc(server, seat);
    expect(doc).toMatchObject({ status: 'removed', removedAt: server.clock.now(), removedBy: admin.session.userId, userId: member.session.userId });
    expect(doc).not.toHaveProperty('activeUserId');
    expect(await errorOf(await call(server, '/api/org/members', { session: member.session }))).toEqual({ status: 403, error: 'no_access' });
    expect((await me(member.session)).access).toEqual({
      state: 'removed', org: { name: 'Removal Org' }, removedAt: server.clock.now().toISOString(), byYou: false,
    });
    expect((await eventsFor(seat))[0]).toMatchObject({ action: 'member.removed', details: { email: member.email, wasStatus: 'active' } });
    // The team no longer lists them, and adding them again is a new invitation.
    expect((await team(admin.session)).map((m) => m.id)).not.toContain(seat);
    expect((await addOk(admin.session, [member.email])).results[0]?.outcome).toBe('invited');
  });

  it('the last admin cannot remove themself: 409 last_admin, and the seat is restored', async () => {
    const { admin, adminSeat } = await orgWithAdmin('Keep Admin Org');
    expect(await errorOf(await remove(admin.session, adminSeat))).toEqual({ status: 409, error: 'last_admin' });
    const doc = await memberDoc(server, adminSeat);
    expect(doc).toMatchObject({ status: 'active', activeUserId: admin.session.userId, removedAt: null, removedBy: null });
    expect((await me(admin.session)).access).toMatchObject({ state: 'member', role: 'org_admin' });
    expect((await eventsFor(adminSeat)).filter((e) => e.action === 'member.removed')).toEqual([]);
  });

  it('an admin may remove themself while another admin exists', async () => {
    const { orgId, admin, adminSeat } = await orgWithAdmin('Step Down Org');
    const other = await person('other');
    await addSeat(server, { orgId, userId: other.session.userId, email: other.email, role: 'org_admin' });
    expect((await remove(admin.session, adminSeat)).status).toBe(204);
    expect((await me(admin.session)).access).toMatchObject({ state: 'removed', byYou: true });
    expect(await activeAdmins(orgId)).toBe(1);
  });

  it('answers 404 for an unknown or already removed id', async () => {
    const { orgId, admin } = await orgWithAdmin('Twice Org');
    const member = await person('member');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    expect((await remove(admin.session, seat)).status).toBe(204);
    expect(await errorOf(await remove(admin.session, seat))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await remove(admin.session, new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
  });
});

describe('roles', () => {
  it('members get 403 forbidden on every team route; people with no organization and staff get 403 no_access; nothing changes', async () => {
    const { orgId, adminSeat } = await orgWithAdmin('Roles Matrix Org');
    const member = await person('member');
    await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    const outsider = await person('outsider');
    const staff = await signInStaff(server);
    const before = JSON.stringify(await server.connection.collection('tw_members').find({ orgId: new Types.ObjectId(orgId) }).toArray());

    const attempts = (session: TestSession): Promise<Response>[] => [
      call(server, '/api/org/members', { session }),
      add(session, [uniqueEmail('x')]),
      setRole(session, adminSeat, 'member'),
      remove(session, adminSeat),
    ];
    for (const [session, error] of [[member.session, 'forbidden'], [outsider.session, 'no_access'], [staff, 'no_access']] as const) {
      for (const res of await Promise.all(attempts(session))) expect(await errorOf(res)).toEqual({ status: 403, error });
    }
    expect(JSON.stringify(await server.connection.collection('tw_members').find({ orgId: new Types.ObjectId(orgId) }).toArray())).toBe(before);
  });
});

describe('audit', () => {
  it('every event written here carries only its action’s allowlisted detail keys', async () => {
    const events = await auditEvents(server);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action as AuditAction];
      expect(Object.keys(event.details as object).every((key) => allowed.includes(key))).toBe(true);
    }
  });
});
