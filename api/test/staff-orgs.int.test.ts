// Staff organizations and teams from the console (spec F5, F6, F7, F10, 9.3, 10.7): create, rename, suspend,
// reactivate, team edits, and sign out everywhere. Every one is a staff action: its event is written before the effect.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import type { AddResult, MemberView } from '../src/handlers/team.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import { addInvite, addLocation, addSeat, auditEvents, createOrg, memberDoc } from './helpers/fixtures.ts';
import {
  call, limiterKey, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

interface Person { email: string; session: TestSession }

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function person(name: string): Promise<Person> {
  const email = uniqueEmail(name);
  return { email, session: await signIn(server, email) };
}

/** An organization with one signed-in org admin. */
async function orgWithAdmin(name: string, status?: 'active' | 'suspended'): Promise<{ orgId: string; admin: Person; adminSeat: string }> {
  const orgId = await createOrg(server, { name, ...(status === undefined ? {} : { status }) });
  const admin = await person('admin');
  const adminSeat = await addSeat(server, { orgId, userId: admin.session.userId, email: admin.email, role: 'org_admin' });
  return { orgId, admin, adminSeat };
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

function patchOrg(orgId: string, body: unknown): Promise<Response> {
  return call(server, `/api/admin/orgs/${orgId}`, { method: 'PATCH', session: staff, json: body });
}

function addMembers(orgId: string, emails: string[], role?: 'org_admin' | 'member'): Promise<Response> {
  return call(server, `/api/admin/orgs/${orgId}/members`, { session: staff, json: role === undefined ? { emails } : { emails, role } });
}

function setRole(orgId: string, memberId: string, role: string): Promise<Response> {
  return call(server, `/api/admin/orgs/${orgId}/members/${memberId}`, { method: 'PATCH', session: staff, json: { role } });
}

function removeMember(orgId: string, memberId: string): Promise<Response> {
  return call(server, `/api/admin/orgs/${orgId}/members/${memberId}`, { method: 'DELETE', session: staff });
}

function signOut(userId: string): Promise<Response> {
  return call(server, `/api/admin/people/${userId}/sign-out-everywhere`, { session: staff, json: {} });
}

async function orgDoc(orgId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(orgId) });
}

async function eventsIn(orgId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => String(event.orgId) === orgId);
}

async function eventsFor(targetId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === targetId);
}

/** Every Townwise document, serialized, so any write shows. */
async function snapshot(): Promise<string> {
  const docs: unknown[] = [];
  for (const name of [
    'tw_orgs', 'tw_members', 'tw_locations', 'tw_sales_days', 'tw_uploads', 'tw_notes', 'tw_access_requests',
    'tw_view_as_grants', 'tw_audit_events', 'tw_chat_conversations', 'tw_chat_live_turns', 'tw_chat_usage',
  ]) {
    docs.push(await server.connection.collection(name).find({}).sort({ _id: 1 }).toArray());
  }
  return JSON.stringify(docs);
}

/** Makes every write to `collection` fail at the database (or only those `refused` matches), then puts it back. */
async function withWritesFailing(collection: string, run: () => Promise<void>, refused?: Record<string, unknown>): Promise<void> {
  const db = server.connection.db;
  if (db === undefined) throw new Error('not connected');
  await db.command({ collMod: collection, validator: refused === undefined ? { $expr: { $eq: [1, 0] } } : { $nor: [refused] } });
  try {
    await run();
  } finally {
    await db.command({ collMod: collection, validator: {} });
  }
}

function createOrgCall(body: Record<string, unknown>): Promise<Response> {
  return call(server, '/api/admin/orgs', { session: staff, json: body });
}

describe('POST /api/admin/orgs (F10)', () => {
  it('creates the organization and an org admin invitation added by staff, recording org.created first; the admin joins on first sign-in', async () => {
    const adminEmail = uniqueEmail('first-admin');
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => {
      res = await call(server, '/api/admin/orgs', { session: staff, json: { name: '  Harbor Light Cafe ', adminEmail: `  ${adminEmail.toUpperCase()} ` } });
    });
    expect(res?.status).toBe(201);
    const body = await res?.json() as { org: { id: string; name: string }; result: AddResult };
    const orgId = body.org.id;
    expect(body).toEqual({ org: { id: orgId, name: 'Harbor Light Cafe' }, result: { email: adminEmail, outcome: 'invited' } });
    expect(writes).toEqual(['insert tw_audit_events', 'insert tw_orgs', 'insert tw_members', 'insert tw_audit_events']);

    expect(await orgDoc(orgId)).toMatchObject({
      name: 'Harbor Light Cafe', status: 'active', createdAt: server.clock.now(), createdBy: staff.userId, fromRequestId: null, suspendedAt: null,
    });
    expect(await server.connection.collection('tw_locations').countDocuments({ orgId: new Types.ObjectId(orgId) })).toBe(0);
    const invite = await server.connection.collection('tw_members').findOne({ orgId: new Types.ObjectId(orgId) });
    expect(invite).toMatchObject({
      email: adminEmail, inviteEmail: adminEmail, role: 'org_admin', status: 'invited', invitedBy: staff.userId, addedByStaff: true,
    });
    const events = await eventsIn(orgId);
    expect(events.map((event) => [event.action, event.actorRole, event.details])).toEqual([
      ['org.created', 'superadmin', { name: 'Harbor Light Cafe', via: 'staff' }],
      ['member.invited', 'superadmin', { email: adminEmail, role: 'org_admin' }],
    ]);

    const admin = await signIn(server, adminEmail);
    const access = (await me(admin)).access;
    expect(access).toMatchObject({
      state: 'invited', invitations: [{ orgName: 'Harbor Light Cafe', role: 'org_admin', invitedBy: { staff: true, email: null } }],
    });
    const inviteId = access.state === 'invited' ? access.invitations[0]?.inviteId ?? '' : '';
    const joined = await call(server, '/api/me/join', { session: admin, json: { inviteId } });
    expect((await joined.json() as MeResponse).access).toEqual({ state: 'member', org: { id: orgId, name: 'Harbor Light Cafe' }, role: 'org_admin' });
  });

  it('refuses a bad name or address with 400 and writes nothing', async () => {
    const before = await snapshot();
    for (const body of [
      { name: 'x', adminEmail: uniqueEmail('a') }, { name: 'x'.repeat(121), adminEmail: uniqueEmail('a') },
      { name: 'Fine Name', adminEmail: 'not an email' }, { name: 'Fine Name' }, { adminEmail: uniqueEmail('a') },
    ]) {
      expect(await errorOf(await call(server, '/api/admin/orgs', { session: staff, json: body }))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await snapshot()).toBe(before);
  });

  it('when its audit write fails, is refused with 503 and creates nothing', async () => {
    const orgs = await server.connection.collection('tw_orgs').countDocuments({});
    await withWritesFailing('tw_audit_events', async () => {
      const res = await call(server, '/api/admin/orgs', { session: staff, json: { name: 'Unrecorded Org', adminEmail: uniqueEmail('a') } });
      expect(await errorOf(res)).toEqual({ status: 503, error: 'unavailable' });
    });
    expect(await server.connection.collection('tw_orgs').countDocuments({})).toBe(orgs);
  });

  it('a repeat with the same id creates nothing new: 200 with the same organization, one org.created, one invitation', async () => {
    const id = new Types.ObjectId().toHexString();
    const adminEmail = uniqueEmail('repeat-admin');
    const first = await createOrgCall({ id, name: 'Once Only Cafe', adminEmail });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ org: { id, name: 'Once Only Cafe' }, result: { email: adminEmail, outcome: 'invited' } });
    const repeat = await createOrgCall({ id: id.toUpperCase(), name: 'Once Only Cafe', adminEmail });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ org: { id, name: 'Once Only Cafe' }, result: { email: adminEmail, outcome: 'already_invited' } });
    expect(await server.connection.collection('tw_orgs').countDocuments({ _id: new Types.ObjectId(id) })).toBe(1);
    expect(await server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(id) })).toBe(1);
    expect((await eventsIn(id)).map((event) => event.action)).toEqual(['org.created', 'member.invited']);
    // After the admin joins, a repeat says so and still adds nothing.
    const admin = await signIn(server, adminEmail);
    const invite = await server.connection.collection('tw_members').findOne({ orgId: new Types.ObjectId(id) });
    expect((await call(server, '/api/me/join', { session: admin, json: { inviteId: String(invite?._id) } })).status).toBe(200);
    expect(await (await createOrgCall({ id, name: 'Once Only Cafe', adminEmail })).json())
      .toMatchObject({ result: { email: adminEmail, outcome: 'already_member' } });
    expect(await server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(id) })).toBe(1);
    expect(await errorOf(await createOrgCall({ id: 'not-an-id', name: 'Once Only Cafe', adminEmail }))).toEqual({ status: 400, error: 'invalid_request' });
  });

  it('a repeat that races the first past its check makes one organization; the loser’s org.created is followed by not_applied conflict', async () => {
    const id = new Types.ObjectId().toHexString();
    const adminEmail = uniqueEmail('raced-admin');
    const body = { id, name: 'Raced Create Cafe', adminEmail };
    const model = server.connection.models.TwOrg as unknown as { create: (...args: unknown[]) => Promise<unknown> };
    const create = model.create.bind(model);
    let repeat: Response | undefined;
    // Between the first request's check and its insert, the repeat runs whole.
    const spy = vi.spyOn(model, 'create').mockImplementationOnce(async (...args: unknown[]) => {
      repeat = await createOrgCall(body);
      return create(...args);
    });
    let first: Response;
    try {
      first = await createOrgCall(body);
    } finally {
      spy.mockRestore();
    }
    expect(repeat?.status).toBe(201);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ org: { id, name: 'Raced Create Cafe' }, result: { email: adminEmail, outcome: 'already_invited' } });
    expect(await server.connection.collection('tw_orgs').countDocuments({ _id: new Types.ObjectId(id) })).toBe(1);
    const events = await eventsIn(id);
    expect(events.map((event) => event.action)).toEqual(['org.created', 'org.created', 'member.invited', 'staff_action.not_applied']);
    expect(events[3]?.details).toEqual({ eventId: String(events[0]?._id), code: 'conflict' });
  });

  it('when the organization cannot be stored, org.created is followed by staff_action.not_applied', async () => {
    await withWritesFailing('tw_orgs', async () => {
      const res = await call(server, '/api/admin/orgs', { session: staff, json: { name: 'Unstored Org', adminEmail: uniqueEmail('a') } });
      expect(await errorOf(res)).toEqual({ status: 500, error: 'internal' });
    });
    const created = (await auditEvents(server)).find((event) => event.action === 'org.created'
      && (event.details as { name: string }).name === 'Unstored Org');
    const orgId = String(created?.orgId);
    expect(await orgDoc(orgId)).toBeNull();
    expect((await eventsIn(orgId)).map((event) => [event.action, event.details])).toEqual([
      ['org.created', { name: 'Unstored Org', via: 'staff' }],
      ['staff_action.not_applied', { eventId: String(created?._id), code: 'internal' }],
    ]);
  });
});

describe('PATCH /api/admin/orgs/:orgId', () => {
  it('renames, recording org.renamed before the change', async () => {
    const { orgId } = await orgWithAdmin('Before Rename Grill');
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await patchOrg(orgId, { name: ' After Rename Grill ' }); });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      org: {
        id: orgId, name: 'After Rename Grill', status: 'active', createdAt: server.clock.now().toISOString(), fromRequestId: null,
        suspendedAt: null,
      },
    });
    expect(writes).toEqual(['insert tw_audit_events', 'update tw_orgs']);
    expect((await eventsIn(orgId)).map((event) => [event.action, event.actorRole, event.details])).toEqual([
      ['org.renamed', 'superadmin', { from: 'Before Rename Grill', to: 'After Rename Grill' }],
    ]);
  });

  it('suspension blocks every member, keeps the data and hides its invitations; reactivation restores access with no other step', async () => {
    const { orgId, admin } = await orgWithAdmin('Paused Bistro');
    const member = await person('member');
    await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    const invitee = await person('invitee');
    await addInvite(server, { orgId, email: invitee.email, invitedBy: admin.session.userId });
    const locationId = await addLocation(server, { orgId, name: 'Paused Room' });
    expect((await call(server, '/api/org', { session: member.session })).status).toBe(200);

    const suspended = await patchOrg(orgId, { status: 'suspended' });
    expect(suspended.status).toBe(200);
    expect((await suspended.json() as { org: Record<string, unknown> }).org).toMatchObject({
      status: 'suspended', suspendedAt: server.clock.now().toISOString(),
    });
    for (const session of [admin.session, member.session]) {
      expect((await me(session)).access).toEqual({ state: 'org_suspended', org: { name: 'Paused Bistro' } });
      expect(await errorOf(await call(server, '/api/org', { session }))).toEqual({ status: 403, error: 'no_access' });
      expect(await errorOf(await call(server, `/api/org/locations/${locationId}/notes`, { session }))).toEqual({ status: 403, error: 'no_access' });
    }
    expect(await errorOf(await call(server, '/api/org/members', { session: admin.session }))).toEqual({ status: 403, error: 'no_access' });
    expect((await me(invitee.session)).access).toEqual({ state: 'no_org' });

    const reactivated = await patchOrg(orgId, { status: 'active' });
    expect((await reactivated.json() as { org: Record<string, unknown> }).org).toMatchObject({ status: 'active', suspendedAt: null });
    expect((await me(member.session)).access).toMatchObject({ state: 'member', org: { id: orgId } });
    const org = await call(server, '/api/org', { session: admin.session });
    expect((await org.json() as { locations: { id: string }[] }).locations.map((location) => location.id)).toEqual([locationId]);
    expect((await me(invitee.session)).access.state).toBe('invited');
    expect((await eventsIn(orgId)).map((event) => [event.action, event.details])).toEqual([
      ['org.suspended', {}], ['org.reactivated', {}],
    ]);
  });

  it('a value that already holds records nothing; a name and a status in one request record both, in order, then change in one write', async () => {
    const { orgId } = await orgWithAdmin('Steady Diner');
    expect((await patchOrg(orgId, { name: 'Steady Diner', status: 'active' })).status).toBe(200);
    expect(await eventsIn(orgId)).toEqual([]);
    let status = 0;
    const writes = await writesDuring(server, async () => { status = (await patchOrg(orgId, { name: 'Renamed Diner', status: 'suspended' })).status; });
    expect(status).toBe(200);
    expect(writes).toEqual(['insert tw_audit_events', 'insert tw_audit_events', 'update tw_orgs']);
    expect((await eventsIn(orgId)).map((event) => event.action)).toEqual(['org.renamed', 'org.suspended']);
    expect(await orgDoc(orgId)).toMatchObject({ name: 'Renamed Diner', status: 'suspended' });
  });

  it('a name and a status whose second event can’t be written: 503, neither changes, and the first event says it didn’t apply', async () => {
    const { orgId } = await orgWithAdmin('Half Done Diner');
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await patchOrg(orgId, { name: 'Never Renamed Diner', status: 'suspended' }))).toEqual({ status: 503, error: 'unavailable' });
    }, { action: 'org.suspended' });
    expect(await orgDoc(orgId)).toMatchObject({ name: 'Half Done Diner', status: 'active', suspendedAt: null });
    const events = await eventsIn(orgId);
    expect(events.map((event) => [event.action, event.details])).toEqual([
      ['org.renamed', { from: 'Half Done Diner', to: 'Never Renamed Diner' }],
      ['staff_action.not_applied', { eventId: String(events[0]?._id), code: 'unavailable' }],
    ]);
  });

  it('answers 404 for an unknown organization and 400 for a malformed id or body, writing nothing', async () => {
    const { orgId } = await orgWithAdmin('Strict Patch Cafe');
    const before = await snapshot();
    expect(await errorOf(await patchOrg(new Types.ObjectId().toHexString(), { status: 'suspended' }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await patchOrg('nope', { status: 'suspended' }))).toEqual({ status: 400, error: 'invalid_request' });
    for (const body of [{}, { status: 'paused' }, { name: 'x' }]) {
      expect(await errorOf(await patchOrg(orgId, body))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await snapshot()).toBe(before);
  });

  it('when its audit write fails, is refused with 503 and the organization is unchanged', async () => {
    const { orgId, admin } = await orgWithAdmin('Guarded Status Cafe');
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await patchOrg(orgId, { status: 'suspended' }))).toEqual({ status: 503, error: 'unavailable' });
      expect(await errorOf(await patchOrg(orgId, { name: 'Unrecorded Name' }))).toEqual({ status: 503, error: 'unavailable' });
    });
    expect(await orgDoc(orgId)).toMatchObject({ name: 'Guarded Status Cafe', status: 'active' });
    expect((await me(admin.session)).access.state).toBe('member');
  });
});

describe('staff team edits (F5, F6 from the console)', () => {
  it('adds addresses as the org admin route does, each marked added by staff and recorded before its insert', async () => {
    const { orgId, admin } = await orgWithAdmin('Staff Adds Kitchen');
    const already = uniqueEmail('already');
    await addInvite(server, { orgId, email: already, invitedBy: admin.session.userId });
    const first = uniqueEmail('first');
    const second = uniqueEmail('second');
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => {
      res = await addMembers(orgId, [first, `  ${second.toUpperCase()}`, already, admin.email, 'nope'], 'org_admin');
    });
    expect(res?.status).toBe(200);
    const body = await res?.json() as { results: AddResult[]; members: MemberView[] };
    expect(body.results).toEqual([
      { email: first, outcome: 'invited' }, { email: second, outcome: 'invited' }, { email: already, outcome: 'already_invited' },
      { email: admin.email, outcome: 'already_member' }, { email: 'nope', outcome: 'invalid' },
    ]);
    expect(writes).toEqual(['insert tw_audit_events', 'insert tw_audit_events', 'insert tw_members']);
    expect(body.members.filter((m) => m.addedByStaff).map((m) => [m.email, m.role, m.isYou])).toEqual([
      [first, 'org_admin', false], [second, 'org_admin', false],
    ]);
    const rows = await server.connection.collection('tw_members').find({ orgId: new Types.ObjectId(orgId), addedByStaff: true }).toArray();
    expect(rows.map((row) => String(row.invitedBy))).toEqual([staff.userId, staff.userId]);
    for (const row of rows) {
      expect((await eventsFor(String(row._id))).map((event) => [event.action, event.actorRole, event.details])).toEqual([
        ['member.invited', 'superadmin', { email: String(row.email), role: 'org_admin' }],
      ]);
    }
  });

  it('addresses whose later event can’t be written: 503, nobody is added, and the earlier event says it didn’t apply', async () => {
    const { orgId } = await orgWithAdmin('Half Added Kitchen');
    const first = uniqueEmail('first');
    const second = uniqueEmail('second');
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await addMembers(orgId, [first, second]))).toEqual({ status: 503, error: 'unavailable' });
    }, { 'details.email': second });
    expect(await server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(orgId), status: 'invited' })).toBe(0);
    const events = await eventsIn(orgId);
    expect(events.map((event) => [event.action, event.details])).toEqual([
      ['member.invited', { email: first, role: 'member' }],
      ['staff_action.not_applied', { eventId: String(events[0]?._id), code: 'unavailable' }],
    ]);
  });

  it('an address another add took first is already_invited, followed by not_applied, while the others are added', async () => {
    const { orgId, admin } = await orgWithAdmin('Raced Add Kitchen');
    const taken = uniqueEmail('taken');
    const free = uniqueEmail('free');
    const model = server.connection.models.TwMember as unknown as { collection: { insertMany: (...args: unknown[]) => Promise<unknown> } };
    const insertMany = model.collection.insertMany.bind(model.collection);
    // Between the events and the insert, an org admin invites one of the addresses.
    const spy = vi.spyOn(model.collection, 'insertMany').mockImplementationOnce(async (...args: unknown[]) => {
      expect((await call(server, '/api/org/members', { session: admin.session, json: { emails: [taken] } })).status).toBe(200);
      return insertMany(...args);
    });
    let res: Response;
    try {
      res = await addMembers(orgId, [taken, free]);
    } finally {
      spy.mockRestore();
    }
    expect((await res.json() as { results: AddResult[] }).results).toEqual([
      { email: taken, outcome: 'already_invited' }, { email: free, outcome: 'invited' },
    ]);
    const rows = await server.connection.collection('tw_members').find({ orgId: new Types.ObjectId(orgId), status: 'invited' }).toArray();
    expect(rows.map((row) => [String(row.email), Boolean(row.addedByStaff)])).toEqual([[taken, false], [free, true]]);
    const staffEvents = (await eventsIn(orgId)).filter((event) => event.actorRole === 'superadmin');
    const takenEvent = staffEvents.find((event) => (event.details as { email?: string }).email === taken);
    expect(staffEvents.map((event) => event.action)).toEqual(['member.invited', 'member.invited', 'staff_action.not_applied']);
    expect(staffEvents[2]?.details).toEqual({ eventId: String(takenEvent?._id), code: 'already_invited' });
  });

  it('is 409 member_limit past 200 people, and 404 for an unknown organization', async () => {
    const { orgId, admin } = await orgWithAdmin('Full Staff Kitchen');
    const now = server.clock.now();
    await server.connection.collection('tw_members').insertMany(Array.from({ length: 199 }, (_, i) => {
      const email = `seed-${String(i)}-${randomUUID().slice(0, 4)}@example.test`;
      return {
        orgId: new Types.ObjectId(orgId), email, role: 'member', status: 'invited', inviteEmail: email, userId: null,
        invitedAt: now, invitedBy: admin.session.userId, addedByStaff: false, joinedAt: null, removedAt: null, removedBy: null,
      };
    }));
    expect(await errorOf(await addMembers(orgId, [uniqueEmail('over')]))).toEqual({ status: 409, error: 'member_limit' });
    expect(await errorOf(await addMembers(new Types.ObjectId().toHexString(), [uniqueEmail('x')]))).toEqual({ status: 404, error: 'not_found' });
  });

  it('changes a role, recording member.role_changed before the change; the same role records nothing', async () => {
    const { orgId } = await orgWithAdmin('Staff Roles Grill');
    const member = await person('member');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await setRole(orgId, seat, 'org_admin'); });
    expect((await res?.json() as { member: MemberView }).member).toMatchObject({ id: seat, role: 'org_admin', email: member.email });
    expect(writes).toEqual(['insert tw_audit_events', 'findAndModify tw_members']);
    expect((await me(member.session)).access).toMatchObject({ state: 'member', role: 'org_admin' });
    expect((await setRole(orgId, seat, 'org_admin')).status).toBe(200);
    expect((await eventsFor(seat)).map((event) => [event.action, event.actorRole, event.details])).toEqual([
      ['member.role_changed', 'superadmin', { email: member.email, from: 'member', to: 'org_admin' }],
    ]);
  });

  it('demoting the last admin is 409 last_admin; the role stays, and the event is followed by staff_action.not_applied', async () => {
    const { adminSeat, orgId } = await orgWithAdmin('Staff Last Admin Grill');
    expect(await errorOf(await setRole(orgId, adminSeat, 'member'))).toEqual({ status: 409, error: 'last_admin' });
    expect(await memberDoc(server, adminSeat)).toMatchObject({ role: 'org_admin', status: 'active' });
    const events = await eventsFor(adminSeat);
    expect(events.map((event) => event.action)).toEqual(['member.role_changed', 'staff_action.not_applied']);
    expect(events[1]?.details).toEqual({ eventId: String(events[0]?._id), code: 'last_admin' });
  });

  it('demotes an admin invitation in an organization with no active admin: no active admin is lost', async () => {
    const orgId = await createOrg(server, { name: 'Invite Only Bakery' });
    const inviteId = await addInvite(server, { orgId, email: uniqueEmail('future-admin'), invitedBy: staff.userId, role: 'org_admin', addedByStaff: true });
    const res = await setRole(orgId, inviteId, 'member');
    expect(res.status).toBe(200);
    expect((await res.json() as { member: MemberView }).member).toMatchObject({ id: inviteId, role: 'member', status: 'invited' });
    expect(await memberDoc(server, inviteId)).toMatchObject({ role: 'member', status: 'invited' });
    expect((await eventsFor(inviteId)).map((event) => event.action)).toEqual(['member.role_changed']);
  });

  it('removes an invitation and a member; the removed member sees that they were removed, not by themself', async () => {
    const { orgId } = await orgWithAdmin('Staff Removes Bistro');
    const invitee = await person('invitee');
    const inviteId = await addInvite(server, { orgId, email: invitee.email, invitedBy: staff.userId, addedByStaff: true });
    const member = await person('member');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });

    expect((await removeMember(orgId, inviteId)).status).toBe(204);
    expect(await memberDoc(server, inviteId)).toBeNull();
    expect((await me(invitee.session)).access).toEqual({ state: 'no_org' });
    let status = 0;
    const writes = await writesDuring(server, async () => { status = (await removeMember(orgId, seat)).status; });
    expect(status).toBe(204);
    expect(writes).toEqual(['insert tw_audit_events', 'findAndModify tw_members']);
    expect(await memberDoc(server, seat)).toMatchObject({ status: 'removed', removedBy: staff.userId });
    expect((await me(member.session)).access).toMatchObject({ state: 'removed', org: { name: 'Staff Removes Bistro' }, byYou: false });
    expect([...await eventsFor(inviteId), ...await eventsFor(seat)].map((event) => [event.action, event.actorRole, event.details])).toEqual([
      ['member.removed', 'superadmin', { email: invitee.email, wasStatus: 'invited' }],
      ['member.removed', 'superadmin', { email: member.email, wasStatus: 'active' }],
    ]);
  });

  it('removing the last admin is 409 last_admin; the seat is restored, and the event is followed by staff_action.not_applied', async () => {
    const { orgId, admin, adminSeat } = await orgWithAdmin('Staff Keeps Admin Cafe');
    expect(await errorOf(await removeMember(orgId, adminSeat))).toEqual({ status: 409, error: 'last_admin' });
    expect(await memberDoc(server, adminSeat)).toMatchObject({ status: 'active', activeUserId: admin.session.userId });
    const events = await eventsFor(adminSeat);
    expect(events.map((event) => [event.action, event.details])).toEqual([
      ['member.removed', { email: admin.email, wasStatus: 'active' }],
      ['staff_action.not_applied', { eventId: String(events[0]?._id), code: 'last_admin' }],
    ]);
  });

  it('can’t remove a member from an organization that has no active admin yet: 409 last_admin, and the seat is restored', async () => {
    const orgId = await createOrg(server, { name: 'Adminless Staff Bakery' });
    const member = await person('adminless');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    expect(await errorOf(await removeMember(orgId, seat))).toEqual({ status: 409, error: 'last_admin' });
    expect(await memberDoc(server, seat)).toMatchObject({ status: 'active', activeUserId: member.session.userId });
    expect((await eventsFor(seat)).map((event) => [event.action, (event.details as { code?: string }).code ?? null])).toEqual([
      ['member.removed', null], ['staff_action.not_applied', 'last_admin'],
    ]);
  });

  it('when the audit write fails, an add, a role change and a removal are refused with 503 and nothing changes', async () => {
    const { orgId, adminSeat } = await orgWithAdmin('Unrecorded Team Cafe');
    const member = await person('member');
    const seat = await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    const before = await snapshot();
    await withWritesFailing('tw_audit_events', async () => {
      for (const res of [await addMembers(orgId, [uniqueEmail('x')]), await setRole(orgId, seat, 'org_admin'), await removeMember(orgId, adminSeat)]) {
        expect(await errorOf(res)).toEqual({ status: 503, error: 'unavailable' });
      }
    });
    expect(await snapshot()).toBe(before);
  });
});

describe('isolation of the console’s team routes, generated from the route table', () => {
  const memberRoutes = TOWNWISE_ROUTES.filter((route) => route.policy === 'staff' && route.path.includes(':memberId'));

  it('covers the role change and the removal', () => {
    expect(memberRoutes.map((route) => route.id).sort()).toEqual(['admin.orgs.members.remove', 'admin.orgs.members.update']);
  });

  for (const route of memberRoutes) {
    it(`${route.method} /api${route.path}: organization A’s path with any of B’s member ids is 404 not_found, and B is unchanged`, async () => {
      const a = await orgWithAdmin('Alpha Console Org');
      const b = await orgWithAdmin('Beta Console Org');
      const bMember = await person('b-member');
      const bIds = [b.adminSeat, await addSeat(server, { orgId: b.orgId, userId: bMember.session.userId, email: bMember.email }),
        await addInvite(server, { orgId: b.orgId, email: uniqueEmail('b-invited'), invitedBy: b.admin.session.userId })];
      const before = await snapshot();
      for (const id of bIds) {
        const res = await call(server, `/api/admin/orgs/${a.orgId}/members/${id}`, {
          method: route.method, session: staff, ...(route.method === 'PATCH' ? { json: { role: 'member' } } : {}),
        });
        expect({ id, ...(await errorOf(res)) }).toEqual({ id, status: 404, error: 'not_found' });
      }
      expect(await snapshot()).toBe(before);
    });
  }
});

describe('POST /api/admin/people/:userId/sign-out-everywhere', () => {
  it('revokes every session of the person through the kit, recorded first with their organization; staff stay signed in', async () => {
    const { orgId, admin } = await orgWithAdmin('Signed Out Kitchen');
    const second = await signIn(server, admin.email);
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await signOut(admin.session.userId); });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ revoked: 2 });
    expect(writes[0]).toBe('insert tw_audit_events');
    expect(writes).toContain('update auth_sessions');
    for (const session of [admin.session, second]) {
      expect(await errorOf(await call(server, '/api/me', { session }))).toEqual({ status: 401, error: 'unauthenticated' });
      const refreshed = await call(server, '/auth/refresh', { json: { platform: 'native', refreshToken: session.refreshToken } });
      expect(refreshed.status).toBe(401);
    }
    expect((await me(staff)).access.state).toBe('staff');
    const events = await eventsFor(admin.session.userId);
    expect(events.map((event) => [event.action, event.actorRole, String(event.orgId), event.details])).toEqual([
      ['people.signed_out_everywhere', 'superadmin', orgId, {}],
    ]);
    // Signing in again works, and the seat is untouched (D18).
    expect((await me(await signIn(server, admin.email))).access).toMatchObject({ state: 'member', org: { id: orgId } });
  });

  it('records no organization for a person with none, and answers 0 when nothing was live', async () => {
    const loner = await person('loner');
    await call(server, '/auth/logout-all', { session: loner.session, json: {} });
    const res = await signOut(loner.session.userId);
    expect(await res.json()).toEqual({ revoked: 0 });
    expect((await eventsFor(loner.session.userId))[0]).toMatchObject({ action: 'people.signed_out_everywhere', orgId: null });
  });

  it('refuses a staff account with 400 invalid_target, an unknown person with 404 and a malformed id with 400, recording nothing', async () => {
    const before = await snapshot();
    expect(await errorOf(await signOut(staff.userId))).toEqual({ status: 400, error: 'invalid_target' });
    expect(await errorOf(await signOut(new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await signOut('nope'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await snapshot()).toBe(before);
    expect((await me(staff)).access.state).toBe('staff');
  });

  it('when its audit write fails, is refused with 503 and every session stays live', async () => {
    const target = await person('still-signed-in');
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await signOut(target.session.userId))).toEqual({ status: 503, error: 'unavailable' });
    });
    expect((await me(target.session)).access).toEqual({ state: 'no_org' });
  });
});

describe('rate limits', () => {
  const NEW_WRITES = [
    'org.update', 'org.leave', 'admin.orgs.create', 'admin.orgs.update', 'admin.orgs.remove', 'admin.orgs.members.add',
    'admin.orgs.members.update', 'admin.orgs.members.remove', 'admin.people.sign_out_everywhere', 'admin.people.delete',
  ];

  it('every route added here is in the table, with no route limiter of its own', () => {
    const routes = TOWNWISE_ROUTES.filter((route) => NEW_WRITES.includes(route.id));
    expect(routes.map((route) => route.id).sort()).toEqual([...NEW_WRITES].sort());
    for (const route of routes) expect(route.limiter).toBeUndefined();
  });

  it('each counts toward townwise:writes: the 301st write in 10 minutes is 429 before anything is read, and nothing is written', async () => {
    const { orgId, adminSeat } = await orgWithAdmin('Limited Org');
    await patchOrg(orgId, { status: 'suspended' });
    const ids: Record<string, string> = { orgId, memberId: adminSeat, userId: staff.userId };
    await server.redis.set(limiterKey('townwise:writes', staff.userId), '300', 'EX', 600);
    const before = await snapshot();
    for (const route of TOWNWISE_ROUTES.filter((r) => NEW_WRITES.includes(r.id))) {
      const path = route.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => ids[name] ?? '');
      const res = await call(server, `/api${path}`, {
        method: route.method, session: staff,
        ...(route.method === 'DELETE' ? {} : { json: { name: 'Limited Renamed', status: 'active', emails: [uniqueEmail('x')], role: 'member', email: uniqueEmail('x'), adminEmail: uniqueEmail('x') } }),
      });
      expect({ route: route.id, ...(await errorOf(res)) }).toEqual({ route: route.id, status: 429, error: 'rate_limited' });
      expect(res.headers.get('retry-after')).not.toBeNull();
    }
    expect(await snapshot()).toBe(before);
  });
});

describe('logs and the record', () => {
  it('logs no email, organization name or address while staff create, edit and sign out', async () => {
    server.logs.length = 0;
    const adminEmail = uniqueEmail('sentinel-admin');
    const created = await call(server, '/api/admin/orgs', { session: staff, json: { name: 'Sentinel Logs Org', adminEmail } });
    const orgId = (await created.json() as { org: { id: string } }).org.id;
    const added = uniqueEmail('sentinel-added');
    const results = await (await addMembers(orgId, [added])).json() as { members: MemberView[] };
    const memberId = results.members.find((m) => m.email === added)?.id ?? '';
    await setRole(orgId, memberId, 'org_admin');
    await removeMember(orgId, memberId);
    await patchOrg(orgId, { name: 'Sentinel Renamed Org', status: 'suspended' });
    const target = await person('sentinel-target');
    await signOut(target.session.userId);
    const logs = server.logs.join('\n');
    expect(logs).toContain(orgId);
    for (const secret of ['Sentinel Logs Org', 'Sentinel Renamed Org', adminEmail, added, target.email, STAFF_EMAIL]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('every event written here carries only its action’s allowlisted detail keys', async () => {
    const events = await auditEvents(server);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action as AuditAction];
      expect(Object.keys(event.details as object).every((key) => allowed.includes(key))).toBe(true);
    }
  });
});
