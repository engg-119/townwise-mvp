// The caller's own organization (spec 10.3, F7, D9): org admins rename it and read its Townwise staff activity; any
// member leaves it.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StaffActivityView } from '../src/audit.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import { addAuditEvent, addGrant, addInvite, addSeat, auditEvents, createOrg, memberDoc } from './helpers/fixtures.ts';
import { holdCalls } from './helpers/hold.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring,
  type TestSession, type TownwiseTestServer,
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

/** An organization with one signed-in org admin and one signed-in member. */
async function team(name: string): Promise<{ orgId: string; admin: Person; adminSeat: string; member: Person; memberSeat: string }> {
  const orgId = await createOrg(server, { name });
  const admin = await person('admin');
  const adminSeat = await addSeat(server, { orgId, userId: admin.session.userId, email: admin.email, role: 'org_admin' });
  const member = await person('member');
  const memberSeat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
  return { orgId, admin, adminSeat, member, memberSeat };
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

async function me(session: TestSession): Promise<MeResponse> {
  const res = await call(server, '/api/me', { session });
  expect(res.status).toBe(200);
  return await res.json() as MeResponse;
}

function rename(session: TestSession, body: unknown): Promise<Response> {
  return call(server, '/api/org', { method: 'PATCH', session, json: body });
}

function leave(session: TestSession, body: unknown = {}): Promise<Response> {
  return call(server, '/api/org/leave', { session, json: body });
}

async function orgDoc(orgId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(orgId) });
}

async function eventsIn(orgId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => String(event.orgId) === orgId);
}

async function activeAdmins(orgId: string): Promise<number> {
  return server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(orgId), status: 'active', role: 'org_admin' });
}

/** Makes every write to `collection` fail at the database, then puts it back. */
async function withWritesFailing(collection: string, run: () => Promise<void>): Promise<void> {
  const db = server.connection.db;
  if (db === undefined) throw new Error('not connected');
  await db.command({ collMod: collection, validator: { $expr: { $eq: [1, 0] } } });
  try {
    await run();
  } finally {
    await db.command({ collMod: collection, validator: {} });
  }
}

describe('PATCH /api/org', () => {
  it('renames the organization, trimmed, and records org.renamed after the change', async () => {
    const { orgId, admin, member } = await team('Old Name Kitchen');
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await rename(admin.session, { name: '  New Name Kitchen  ' }); });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ org: { id: orgId, name: 'New Name Kitchen' } });
    // A client event is written after the effect (spec 9.3).
    expect(writes).toEqual(['findAndModify tw_orgs', 'insert tw_audit_events']);
    expect((await me(member.session)).access).toMatchObject({ state: 'member', org: { id: orgId, name: 'New Name Kitchen' } });
    const events = (await eventsIn(orgId)).filter((event) => event.action === 'org.renamed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: admin.session.userId, actorEmail: admin.email, actorRole: 'org_admin', viewAsGrantId: null,
      target: { type: 'org', id: orgId }, details: { from: 'Old Name Kitchen', to: 'New Name Kitchen' },
    });
  });

  it('the same name changes nothing and records nothing', async () => {
    const { orgId, admin } = await team('Same Name Diner');
    expect((await rename(admin.session, { name: 'Same Name Diner' })).status).toBe(200);
    expect((await eventsIn(orgId)).filter((event) => event.action === 'org.renamed')).toEqual([]);
  });

  it('renames only the caller’s own organization, whatever organization id the body carries', async () => {
    const a = await team('Alpha Grill');
    const b = await team('Beta Grill');
    expect((await rename(a.admin.session, { name: 'Alpha Renamed', orgId: b.orgId })).status).toBe(200);
    expect(await orgDoc(a.orgId)).toMatchObject({ name: 'Alpha Renamed' });
    expect(await orgDoc(b.orgId)).toMatchObject({ name: 'Beta Grill' });
  });

  it('refuses a name outside 2 to 120 characters, and a missing name, with 400', async () => {
    const { orgId, admin } = await team('Valid Name Cafe');
    for (const body of [{ name: ' x ' }, { name: 'x'.repeat(121) }, {}, { name: 42 }]) {
      expect(await errorOf(await rename(admin.session, body))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await orgDoc(orgId)).toMatchObject({ name: 'Valid Name Cafe' });
  });

  it('a member gets 403 forbidden; someone with no organization and staff get 403 no_access; nothing changes', async () => {
    const { orgId, member } = await team('Guarded Name Bistro');
    const outsider = await person('outsider');
    const staff = await signInStaff(server);
    expect(await errorOf(await rename(member.session, { name: 'Taken Over' }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await rename(outsider.session, { name: 'Taken Over' }))).toEqual({ status: 403, error: 'no_access' });
    expect(await errorOf(await rename(staff, { name: 'Taken Over' }))).toEqual({ status: 403, error: 'no_access' });
    expect(await orgDoc(orgId)).toMatchObject({ name: 'Guarded Name Bistro' });
  });

  it('when its audit write fails, the rename stands and the failure is logged with ids only', async () => {
    const { orgId, admin } = await team('Unrecorded Name Tavern');
    server.logs.length = 0;
    await withWritesFailing('tw_audit_events', async () => {
      expect((await rename(admin.session, { name: 'Recorded Nowhere Tavern' })).status).toBe(200);
    });
    expect(await orgDoc(orgId)).toMatchObject({ name: 'Recorded Nowhere Tavern' });
    const failed = logLines(server).filter((line) => line.msg === 'townwise.audit_write_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ action: 'org.renamed', orgId, targetId: orgId });
    expect(server.logs.join('\n')).not.toContain('Tavern');
  });
});

describe('POST /api/org/leave (F7)', () => {
  it('a member leaves: 200 with their access now removed by themself, recorded as member.left after the change', async () => {
    const { orgId, member, memberSeat } = await team('Leaving Kitchen');
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await leave(member.session); });
    expect(res?.status).toBe(200);
    const body = await res?.json() as MeResponse;
    expect(body.access).toEqual({
      state: 'removed', org: { name: 'Leaving Kitchen' }, removedAt: server.clock.now().toISOString(), byYou: true,
    });
    expect(writes).toEqual(['findAndModify tw_members', 'insert tw_audit_events']);
    const doc = await memberDoc(server, memberSeat);
    expect(doc).toMatchObject({ status: 'removed', removedBy: member.session.userId, userId: member.session.userId });
    expect(doc).not.toHaveProperty('activeUserId');
    expect(await errorOf(await call(server, '/api/org', { session: member.session }))).toEqual({ status: 403, error: 'no_access' });
    const events = (await eventsIn(orgId)).filter((event) => event.action === 'member.left');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: member.session.userId, actorRole: 'member', target: { type: 'member', id: memberSeat },
      details: { email: member.email },
    });
  });

  it('an org admin leaves while another admin exists', async () => {
    const { orgId, admin, member, memberSeat } = await team('Two Admin Grill');
    await server.connection.collection('tw_members').updateOne({ _id: new Types.ObjectId(memberSeat) }, { $set: { role: 'org_admin' } });
    expect((await leave(admin.session)).status).toBe(200);
    expect((await me(admin.session)).access).toMatchObject({ state: 'removed', byYou: true });
    expect((await me(member.session)).access).toMatchObject({ state: 'member', role: 'org_admin' });
    expect(await activeAdmins(orgId)).toBe(1);
  });

  it('the last admin gets 409 last_admin, keeps the seat, and nothing is recorded', async () => {
    const { orgId, admin, adminSeat } = await team('Sole Admin Cafe');
    expect(await errorOf(await leave(admin.session))).toEqual({ status: 409, error: 'last_admin' });
    expect(await memberDoc(server, adminSeat)).toMatchObject({
      status: 'active', activeUserId: admin.session.userId, removedAt: null, removedBy: null,
    });
    expect((await me(admin.session)).access).toMatchObject({ state: 'member', role: 'org_admin' });
    expect((await eventsIn(orgId)).filter((event) => event.action === 'member.left')).toEqual([]);
  });

  it('the last two admins leaving at once, both removed before either recounts: the first to recount stays, the other leaves', async () => {
    const { orgId, admin, adminSeat, member, memberSeat } = await team('Racing Admins Diner');
    await server.connection.collection('tw_members').updateOne({ _id: new Types.ObjectId(memberSeat) }, { $set: { role: 'org_admin' } });
    const counts = holdCalls(server, 'countDocuments');
    try {
      const first = leave(admin.session);
      await counts.arrived(1);            // the first seat is removed; its recount waits
      const second = leave(member.session);
      await counts.arrived(2);            // the second seat is removed too
      counts.release(1);                  // no admin is left: the first seat is put back
      expect(await errorOf(await first)).toEqual({ status: 409, error: 'last_admin' });
      counts.open();                      // the first admin is back, so the second leaves
      expect((await second).status).toBe(200);
    } finally {
      counts.restore();
    }
    expect(await memberDoc(server, adminSeat)).toMatchObject({ status: 'active', role: 'org_admin' });
    expect(await memberDoc(server, memberSeat)).toMatchObject({ status: 'removed', removedBy: member.session.userId });
    expect(await activeAdmins(orgId)).toBe(1);
    expect((await eventsIn(orgId)).filter((event) => event.action === 'member.left').map((event) => event.actorUserId))
      .toEqual([member.session.userId]);
  });

  it('a member may leave an organization that has no active admin yet (its admin invitation still pending)', async () => {
    const orgId = await createOrg(server, { name: 'No Admin Yet Bakery' });
    await addInvite(server, { orgId, email: uniqueEmail('future-admin'), invitedBy: 'f'.repeat(24), role: 'org_admin', addedByStaff: true });
    const member = await person('adminless');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    expect((await leave(member.session)).status).toBe(200);
    expect(await memberDoc(server, seat)).toMatchObject({ status: 'removed', removedBy: member.session.userId });
    expect((await me(member.session)).access).toMatchObject({ state: 'removed', byYou: true });
    expect((await eventsIn(orgId)).filter((event) => event.action === 'member.left').map((event) => event.actorUserId))
      .toEqual([member.session.userId]);
  });

  it('refuses a body that carries anything, with 400, and the seat stays', async () => {
    const a = await team('Strict Body Grill');
    const b = await team('Other Body Grill');
    expect(await errorOf(await leave(a.member.session, { orgId: b.orgId }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await memberDoc(server, a.memberSeat)).toMatchObject({ status: 'active' });
    expect(await memberDoc(server, b.memberSeat)).toMatchObject({ status: 'active' });
  });

  it('someone with no organization, staff, and a member of a suspended organization get 403 no_access', async () => {
    const outsider = await person('outsider');
    const staff = await signInStaff(server);
    const orgId = await createOrg(server, { name: 'Paused Leave Org', status: 'suspended' });
    const paused = await person('paused');
    const seat = await addSeat(server, { orgId, userId: paused.session.userId, email: paused.email });
    for (const session of [outsider.session, staff, paused.session]) {
      expect(await errorOf(await leave(session))).toEqual({ status: 403, error: 'no_access' });
    }
    expect(await memberDoc(server, seat)).toMatchObject({ status: 'active' });
  });
});

describe('GET /api/org/staff-activity (D9)', () => {
  it('lists every staff event on this organization, newest first, with view-as details; a refused one shows once, as not applied', async () => {
    const { orgId, admin, member } = await team('Watched Kitchen');
    const other = await team('Unwatched Kitchen');
    const base = server.clock.now().getTime();
    const at = (seconds: number): Date => new Date(base + seconds * 1000);
    const staffEvent = { actorEmail: STAFF_EMAIL, actorRole: 'superadmin' };
    const grantId = new Types.ObjectId().toHexString();
    const expiresAt = at(1800).toISOString();
    await addAuditEvent(server, {
      ...staffEvent, at: at(1), orgId, action: 'view_as.started', viewAsGrantId: grantId, target: { type: 'grant', id: grantId },
      details: { targetUserId: member.session.userId, targetEmail: member.email, reason: 'Helping with an upload', expiresAt },
    });
    await addAuditEvent(server, { ...staffEvent, at: at(2), orgId, action: 'view_as.ended', viewAsGrantId: grantId, details: { endReason: 'ended' } });
    const changed = await addAuditEvent(server, {
      ...staffEvent, at: at(3), orgId, action: 'member.role_changed', details: { email: admin.email, from: 'org_admin', to: 'member' },
    });
    await addAuditEvent(server, { ...staffEvent, at: at(4), orgId, action: 'staff_action.not_applied', details: { eventId: changed, code: 'last_admin' } });
    // Not staff, or not this organization: never listed.
    await addAuditEvent(server, { at: at(5), orgId, action: 'org.renamed', actorRole: 'org_admin', details: { from: 'A', to: 'B' } });
    await addAuditEvent(server, { ...staffEvent, at: at(6), orgId: other.orgId, action: 'org.suspended', details: {} });

    const res = await call(server, '/api/org/staff-activity', { session: admin.session });
    expect(res.status).toBe(200);
    const { events } = await res.json() as { events: StaffActivityView[] };
    const applied = { applied: true, notAppliedReason: null };
    expect(events).toEqual([
      {
        at: at(3).toISOString(), staffEmail: STAFF_EMAIL, summary: `Changed ${admin.email} from admin to member`, viewAs: null,
        applied: false, notAppliedReason: 'The organization needs at least one admin',
      },
      { at: at(2).toISOString(), staffEmail: STAFF_EMAIL, summary: 'Ended view-as', viewAs: null, ...applied },
      {
        at: at(1).toISOString(), staffEmail: STAFF_EMAIL, summary: `Viewed as ${member.email}`,
        viewAs: { targetEmail: member.email, reason: 'Helping with an upload', endsAt: expiresAt }, ...applied,
      },
    ]);
    // The other organization's admins see only its own staff event.
    const theirs = await (await call(server, '/api/org/staff-activity', { session: other.admin.session })).json() as { events: StaffActivityView[] };
    expect(theirs.events).toEqual([
      { at: at(6).toISOString(), staffEmail: STAFF_EMAIL, summary: 'Suspended the organization', viewAs: null, ...applied },
    ]);
  });

  it('a staff change the console refuses shows once, as not applied with a plain reason', async () => {
    const { orgId, admin, adminSeat } = await team('Refused Change Grill');
    const staff = await signInStaff(server);
    const refused = await call(server, `/api/admin/orgs/${orgId}/members/${adminSeat}`, { method: 'PATCH', session: staff, json: { role: 'member' } });
    expect(await errorOf(refused)).toEqual({ status: 409, error: 'last_admin' });
    expect((await eventsIn(orgId)).map((event) => event.action)).toEqual(['member.role_changed', 'staff_action.not_applied']);
    const { events } = await (await call(server, '/api/org/staff-activity', { session: admin.session })).json() as { events: StaffActivityView[] };
    expect(events).toEqual([{
      at: server.clock.now().toISOString(), staffEmail: STAFF_EMAIL, summary: `Changed ${admin.email} from admin to member`,
      viewAs: null, applied: false, notAppliedReason: 'The organization needs at least one admin',
    }]);
  });

  it('shows the newest 50 staff actions; not-applied records take no row', async () => {
    const { orgId, admin } = await team('Busy Staff Kitchen');
    const base = server.clock.now().getTime();
    const staffEvent = (at: number, action: string, details: Record<string, unknown>): Record<string, unknown> => ({
      at: new Date(base + at), actorUserId: 'a'.repeat(24), actorEmail: STAFF_EMAIL, actorRole: 'superadmin',
      viewAsGrantId: null, orgId: new Types.ObjectId(orgId), action, target: { type: 'org', id: orgId }, details,
    });
    await server.connection.collection('tw_audit_events').insertMany(Array.from({ length: 55 }, (_, i) => staffEvent(i * 1000, 'org.suspended', {})));
    // Newer than all of them: ten records that qualify an older event.
    await server.connection.collection('tw_audit_events').insertMany(Array.from({ length: 10 }, (_, i) => staffEvent(
      100_000 + i, 'staff_action.not_applied', { eventId: new Types.ObjectId().toHexString(), code: 'internal' },
    )));
    const { events } = await (await call(server, '/api/org/staff-activity', { session: admin.session })).json() as { events: StaffActivityView[] };
    expect(events).toHaveLength(50);
    expect(events[0]?.at).toBe(new Date(base + 54_000).toISOString());
    expect(events.every((event) => event.summary === 'Suspended the organization')).toBe(true);
  });

  it('a staff invitation made in the console appears in the org admin’s staff activity', async () => {
    const { orgId, admin } = await team('Staff Invite Kitchen');
    const staff = await signInStaff(server);
    const invited = uniqueEmail('staff-added');
    const added = await call(server, `/api/admin/orgs/${orgId}/members`, { session: staff, json: { emails: [invited] } });
    expect(added.status).toBe(200);
    const { events } = await (await call(server, '/api/org/staff-activity', { session: admin.session })).json() as { events: StaffActivityView[] };
    expect(events[0]).toMatchObject({ staffEmail: STAFF_EMAIL, summary: `Added ${invited} as member`, applied: true, notAppliedReason: null });
  });

  it('a member gets 403 forbidden; someone with no organization and staff get 403 no_access', async () => {
    const { member } = await team('Hidden Activity Grill');
    const outsider = await person('outsider');
    const staff = await signInStaff(server);
    const path = '/api/org/staff-activity';
    expect(await errorOf(await call(server, path, { session: member.session }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await call(server, path, { session: outsider.session }))).toEqual({ status: 403, error: 'no_access' });
    expect(await errorOf(await call(server, path, { session: staff }))).toEqual({ status: 403, error: 'no_access' });
  });

  it('staff in view-as read it when the target is an org admin, and get 403 forbidden when the target is a member', async () => {
    const { orgId, admin, member } = await team('Viewed Activity Grill');
    const staff = await signInStaff(server);
    const grantId = await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: admin.session.userId, orgId });
    server.logs.length = 0;
    expect((await call(server, '/api/org/staff-activity', { session: staff })).status).toBe(200);
    expect(logLines(server).filter((line) => line.msg === 'townwise.view_as_read')).toEqual([
      expect.objectContaining({ grantId, routeId: 'org.staff_activity' }),
    ]);
    await server.connection.collection('tw_view_as_grants').updateOne(
      { _id: new Types.ObjectId(grantId) }, { $set: { targetUserId: member.session.userId } },
    );
    expect(await errorOf(await call(server, '/api/org/staff-activity', { session: staff }))).toEqual({ status: 403, error: 'forbidden' });
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
