import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import { addInvite, addRequest, addSeat, auditEvents, createOrg, memberDoc } from './helpers/fixtures.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';
import { createCapturingTransport } from './helpers/mail.ts';

let server: TownwiseTestServer;
/** Nothing in this file may send an email (spec D14: only a request, its approval and a location's first forecast do). */
const mail = createCapturingTransport();

beforeAll(async () => { server = await startTownwiseServer({ mailTransport: mail }); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });
afterEach(async () => { await removeStaffFactor(server); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function person(name: string): Promise<{ email: string; session: TestSession }> {
  const email = uniqueEmail(name);
  return { email, session: await signIn(server, email) };
}

function join(session: TestSession, inviteId: string): Promise<Response> {
  return call(server, '/api/me/join', { session, json: { inviteId } });
}

function decline(session: TestSession, inviteId: string): Promise<Response> {
  return call(server, '/api/me/decline', { session, json: { inviteId } });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

async function eventsFor(targetId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === targetId);
}

describe('POST /api/me/join', () => {
  it('turns the invitation into an active seat, answers the new MeResponse and records member.joined', async () => {
    const admin = await person('admin');
    const { email, session } = await person('joiner');
    const orgId = await createOrg(server, { name: 'Harbor House' });
    const inviteId = await addInvite(server, { orgId, email, invitedBy: admin.session.userId, role: 'org_admin' });

    const res = await join(session, inviteId);
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body).toEqual({
      user: { id: session.userId, email },
      access: { state: 'member', org: { id: orgId, name: 'Harbor House' }, role: 'org_admin' },
      viewAs: null, openAsAdmin: null, staff: null, welcome: null,
    });

    const seat = await memberDoc(server, inviteId);
    expect(seat).toMatchObject({ status: 'active', userId: session.userId, activeUserId: session.userId, joinedAt: server.clock.now() });
    expect(seat).not.toHaveProperty('inviteEmail');

    const events = await eventsFor(inviteId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'member.joined', actorUserId: session.userId, actorEmail: email, actorRole: 'org_admin',
      viewAsGrantId: null, orgId: new Types.ObjectId(orgId), details: { email, role: 'org_admin' },
    });
  });

  it('five concurrent joins of one invitation leave exactly one active seat', async () => {
    const { email, session } = await person('racer');
    const orgId = await createOrg(server, { name: 'Race Org' });
    const inviteId = await addInvite(server, { orgId, email, invitedBy: 'f'.repeat(24) });
    const results = await Promise.all(Array.from({ length: 5 }, () => join(session, inviteId)));
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) expect((await errorOf(res)).error).toBe('no_invite');
    expect(await server.connection.collection('tw_members').countDocuments({ activeUserId: session.userId })).toBe(1);
  });

  it('joining an invitation addressed to a different email is 409 no_invite and changes nothing', async () => {
    const invited = uniqueEmail('invited');
    const other = await person('other');
    const orgId = await createOrg(server, { name: 'Email Org' });
    const inviteId = await addInvite(server, { orgId, email: invited, invitedBy: 'f'.repeat(24) });
    const before = await memberDoc(server, inviteId);
    expect(await errorOf(await join(other.session, inviteId))).toEqual({ status: 409, error: 'no_invite' });
    expect(await memberDoc(server, inviteId)).toEqual(before);
  });

  it('joining a second organization is 409 already_in_org, and the invitation stays open', async () => {
    const { email, session } = await person('settled');
    const home = await createOrg(server, { name: 'Home Org' });
    await addSeat(server, { orgId: home, userId: session.userId, email });
    const other = await createOrg(server, { name: 'Other Org' });
    const inviteId = await addInvite(server, { orgId: other, email, invitedBy: 'f'.repeat(24) });
    const before = await memberDoc(server, inviteId);
    expect(await errorOf(await join(session, inviteId))).toEqual({ status: 409, error: 'already_in_org' });
    expect(await memberDoc(server, inviteId)).toEqual(before);
  });

  it('an invitation in a suspended organization is 409 no_invite', async () => {
    const { email, session } = await person('paused');
    const orgId = await createOrg(server, { name: 'Paused Org', status: 'suspended' });
    const inviteId = await addInvite(server, { orgId, email, invitedBy: 'f'.repeat(24) });
    expect(await errorOf(await join(session, inviteId))).toEqual({ status: 409, error: 'no_invite' });
  });

  it('a malformed or missing invite id is 400 invalid_request', async () => {
    const { session } = await person('malformed');
    expect(await errorOf(await join(session, 'not-an-id'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await call(server, '/api/me/join', { session, json: { inviteId: { $ne: null } } })))
      .toEqual({ status: 400, error: 'invalid_request' });
  });

  it('staff addresses are 403 forbidden, whatever their two-step state', async () => {
    const orgId = await createOrg(server, { name: 'Staff Invite Org' });
    const inviteId = await addInvite(server, { orgId, email: STAFF_EMAIL, invitedBy: 'f'.repeat(24) });
    const unenrolled = await signIn(server, STAFF_EMAIL);
    expect(await errorOf(await join(unenrolled, inviteId))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await decline(unenrolled, inviteId))).toEqual({ status: 403, error: 'forbidden' });
    const staff = await signInStaff(server);
    expect(await errorOf(await join(staff, inviteId))).toEqual({ status: 403, error: 'forbidden' });
    expect(await memberDoc(server, inviteId)).toMatchObject({ status: 'invited', inviteEmail: STAFF_EMAIL });
  });
});

describe('invited while pending (F2b)', () => {
  it('stays pending until Join is pressed; Join withdraws the request', async () => {
    const { email, session } = await person('pending-join');
    const requestId = await addRequest(server, { userId: session.userId, email, status: 'pending' });
    const orgId = await createOrg(server, { name: 'Pending Join Org' });
    const inviteId = await addInvite(server, { orgId, email, invitedBy: 'f'.repeat(24) });

    for (let i = 0; i < 2; i += 1) {
      const me = await (await call(server, '/api/me', { session })).json() as MeResponse;
      expect(me.access).toMatchObject({ state: 'invited', pendingRequest: { id: requestId, status: 'pending' } });
    }
    const requests = server.connection.collection('tw_access_requests');
    expect(await requests.findOne({ _id: new Types.ObjectId(requestId) })).toMatchObject({ status: 'pending' });
    expect(await memberDoc(server, inviteId)).toMatchObject({ status: 'invited' });

    expect((await join(session, inviteId)).status).toBe(200);
    expect(await requests.findOne({ _id: new Types.ObjectId(requestId) }))
      .toMatchObject({ status: 'withdrawn', withdrawnReason: 'joined_org', decidedAt: server.clock.now() });
    const withdrawn = await eventsFor(requestId);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]).toMatchObject({ action: 'access_request.withdrawn', orgId: null, details: { reason: 'joined_org' } });
  });

  it('“Not my team” deletes only the caller’s own invitation, and the request stays pending', async () => {
    const { email, session } = await person('not-my-team');
    const colleague = uniqueEmail('colleague');
    const requestId = await addRequest(server, { userId: session.userId, email, status: 'pending' });
    const first = await createOrg(server, { name: 'First Org' });
    const second = await createOrg(server, { name: 'Second Org' });
    const declined = await addInvite(server, { orgId: first, email, invitedBy: 'f'.repeat(24) });
    const kept = await addInvite(server, { orgId: second, email, invitedBy: 'f'.repeat(24) });
    const colleagueInvite = await addInvite(server, { orgId: first, email: colleague, invitedBy: 'f'.repeat(24) });

    const res = await decline(session, declined);
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body.access).toMatchObject({ state: 'invited', invitations: [{ inviteId: kept, orgName: 'Second Org' }], pendingRequest: { id: requestId } });
    expect(await memberDoc(server, declined)).toBeNull();
    expect(await memberDoc(server, kept)).toMatchObject({ status: 'invited' });
    expect(await memberDoc(server, colleagueInvite)).toMatchObject({ status: 'invited', inviteEmail: colleague });
    expect(await server.connection.collection('tw_access_requests').findOne({ _id: new Types.ObjectId(requestId) }))
      .toMatchObject({ status: 'pending' });

    const events = await eventsFor(declined);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'member.declined', actorRole: 'user', orgId: new Types.ObjectId(first), details: { email } });

    expect((await decline(session, kept)).status).toBe(200);
    expect((await (await call(server, '/api/me', { session })).json() as MeResponse).access.state).toBe('pending');
  });

  it('declining someone else’s invitation is 409 no_invite', async () => {
    const { session } = await person('decliner');
    const orgId = await createOrg(server, { name: 'Decline Org' });
    const inviteId = await addInvite(server, { orgId, email: uniqueEmail('someone'), invitedBy: 'f'.repeat(24) });
    expect(await errorOf(await decline(session, inviteId))).toEqual({ status: 409, error: 'no_invite' });
    expect(await memberDoc(server, inviteId)).toMatchObject({ status: 'invited' });
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

describe('email (spec D14)', () => {
  it('joining, declining and every flow above send no email', async () => {
    await server.mailer.idle();
    expect(mail.sent).toEqual([]);
  });
});
