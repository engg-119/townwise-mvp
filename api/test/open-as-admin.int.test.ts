// Open as admin (D25): resolution, the principal and the guard. A grant held by a staff session opens an organization
// nobody has joined as its admin, and is live only while that organization is in setup (active, nobody has ever joined
// it). These tests write grants directly in the shape insertOpenAsAdmin writes.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import { createViewAsGrantStore, viewAsGrantModel } from '../src/stores/view-as-grants.ts';
import { addGrant, addInvite, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { PROBE_ROUTES } from './helpers/probe.ts';
import {
  call, makeStaff, MINUTE, refresh, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';
import { joinAs, setupOrg } from './helpers/setup-org.ts';

let server: TownwiseTestServer;
let staff: TestSession;
let org: { orgId: string; name: string; adminEmail: string };
let grantId: string;
/** An organization with a seated org admin. */
let other: { orgId: string; adminUserId: string; admin: TestSession };

beforeAll(async () => { server = await startTownwiseServer({ probe: PROBE_ROUTES }); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
  // Made through the console before the grant exists: while it is live, every staff route answers 409.
  org = await setupOrg(server, staff);
  grantId = await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: org.orgId });
  const email = `other-admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  const orgId = await createOrg(server, { name: `Other Org ${randomUUID().slice(0, 6)}` });
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  other = { orgId, adminUserId: admin.userId, admin };
});
afterEach(async () => {
  await server.authStores.totp.remove(staff.userId);
  await server.connection.collection('tw_view_as_grants').deleteMany({});
});

async function me(session: TestSession): Promise<MeResponse> {
  const res = await call(server, '/api/me', { session });
  expect(res.status).toBe(200);
  return await res.json() as MeResponse;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

/** Replaces the session's grant with one of these minutes. */
async function regrant(minutes: number): Promise<string> {
  await server.connection.collection('tw_view_as_grants').deleteMany({});
  return addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: org.orgId, minutes });
}

/** A second session of the staff member, which passes the gate too. */
async function anotherStaffSession(): Promise<TestSession> {
  // With codes enabled, a magic link answers a code challenge, so the factor is removed and seeded again.
  await server.authStores.totp.remove(staff.userId);
  const session = await signIn(server, STAFF_EMAIL);
  await makeStaff(server, staff.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
  return session;
}

const notLive = { access: { state: 'staff' }, openAsAdmin: null, viewAs: null };

describe('a live open-as-admin grant', () => {
  it('GET /api/me answers the organization’s admin access with openAsAdmin set; user and staff stay the staff member', async () => {
    expect(await me(staff)).toEqual({
      user: { id: staff.userId, email: STAFF_EMAIL },
      access: { state: 'member', org: { id: org.orgId, name: org.name }, role: 'org_admin' },
      viewAs: null,
      openAsAdmin: { id: grantId, org: { id: org.orgId, name: org.name }, startedAt: server.clock.now().toISOString() },
      staff: { verifiedUntil: expect.any(String) as string },
      welcome: null,
    });
  });

  it('a member route takes the organization from the grant, never from the request', async () => {
    const expected = { kind: 'member', orgId: org.orgId, role: 'org_admin' };
    const read = await call(server, `/probe/member?orgId=${other.orgId}`, { session: staff });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(expected);
    const write = await call(server, '/probe/member', { session: staff, json: { orgId: other.orgId } });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual(expected);
    const admin = await call(server, '/probe/org-admin', { session: staff });
    expect(await admin.json()).toEqual(expected);
  });

  it('every staff route answers 409 open_as_admin_active, any method, and nothing is written', async () => {
    const withIds = (path: string): string => path.replace(/:[A-Za-z]+/g, () => new Types.ObjectId().toHexString());
    const staffRoutes = TOWNWISE_ROUTES.filter((route) => route.policy === 'staff');
    expect(staffRoutes.length).toBeGreaterThan(0);
    const answers: { route: string; status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      for (const route of staffRoutes) {
        const res = await call(server, `/api${withIds(route.path)}`, {
          method: route.method, session: staff, ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: {} }),
        });
        answers.push({ route: route.id, ...(await errorOf(res)) });
      }
      answers.push({ route: 'probe.staff.read', ...(await errorOf(await call(server, '/probe/staff', { session: staff }))) });
      answers.push({ route: 'probe.staff.write', ...(await errorOf(await call(server, '/probe/staff', { session: staff, json: {} }))) });
    });
    const expected = [...staffRoutes.map((route) => route.id), 'probe.staff.read', 'probe.staff.write']
      .map((route) => ({ route, status: 409, error: 'open_as_admin_active' }));
    expect(answers).toEqual(expected);
    expect(writes).toEqual([]);
    expect(await me(staff)).toMatchObject({ openAsAdmin: { id: grantId } });
  });

  it('a route not marked for this mode answers 403 open_as_admin_refused: joining an invitation to the staff address seats nobody', async () => {
    const inviteId = await addInvite(server, { orgId: other.orgId, email: STAFF_EMAIL, invitedBy: other.adminUserId });
    const before = (await auditEvents(server)).length;
    expect(await errorOf(await call(server, '/api/me/join', { session: staff, json: { inviteId } }))).toEqual({ status: 403, error: 'open_as_admin_refused' });
    expect(await server.connection.collection('tw_members').countDocuments({ activeUserId: staff.userId })).toBe(0);
    expect(await errorOf(await call(server, '/api/me/decline', { session: staff, json: { inviteId } }))).toEqual({ status: 403, error: 'open_as_admin_refused' });
    expect(await server.connection.collection('tw_members').countDocuments({ _id: new Types.ObjectId(inviteId) })).toBe(1);
    expect(await errorOf(await call(server, '/api/org/leave', { session: staff, json: {} }))).toEqual({ status: 403, error: 'open_as_admin_refused' });
    expect((await auditEvents(server)).length).toBe(before);
  });

  it('it is not view-as: a write passes the view-as guard', async () => {
    const res = await call(server, '/probe/member', { session: staff, json: {} });
    expect(res.status).toBe(200);
  });

  it('inside, generated from the route table: each refused route answers 403 open_as_admin_refused and changes nothing', async () => {
    const withIds = (path: string): string => path.replace(/:[A-Za-z]+/g, () => new Types.ObjectId().toHexString());
    const refused = TOWNWISE_ROUTES.filter((route) => route.policy !== 'staff' && route.policy !== 'staff_self' && route.openAsAdmin !== true);
    expect(refused.length).toBeGreaterThan(0);
    const answers: { route: string; status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      for (const route of refused) {
        const res = await call(server, `/api${withIds(route.path)}`, {
          method: route.method, session: staff, ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: {} }),
        });
        answers.push({ route: route.id, ...(await errorOf(res)) });
      }
    });
    expect(answers).toEqual(refused.map((route) => ({ route: route.id, status: 403, error: 'open_as_admin_refused' })));
    expect(writes).toEqual([]);
  });

  it('staff do what an org admin does: rename, add a location, upload days that replace, read them back, write a note, delete the location’s sales', async () => {
    const name = `Renamed Kitchen ${randomUUID().slice(0, 6)}`;
    const renamed = await call(server, '/api/org', { method: 'PATCH', session: staff, json: { name, orgId: org.orgId } });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ org: { id: org.orgId, name } });

    const created = await call(server, '/api/org/locations', {
      session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' }, orgId: org.orgId },
    });
    expect(created.status).toBe(201);
    const location = `/api/org/locations/${(await created.json() as { location: { id: string } }).location.id}`;

    const upload = (days: { date: string; guests: number | null; netSalesCents: number | null }[]): Promise<Response> =>
      call(server, `${location}/sales/uploads`, { session: staff, json: { days } });
    const first = await upload([{ date: '2026-05-01', guests: 101, netSalesCents: 350_050 }, { date: '2026-05-02', guests: 90, netSalesCents: null }]);
    expect(first.status).toBe(201);
    // As an org admin's, the second upload replaces the day it covers.
    const second = await upload([{ date: '2026-05-02', guests: 95, netSalesCents: 300_000 }]);
    expect(second.status).toBe(201);
    expect((await second.json() as { upload: Record<string, unknown> }).upload).toMatchObject({ inserted: 0, replaced: 1, kept: 0 });
    const history = await call(server, `${location}/sales/history`, { session: staff });
    expect(history.status).toBe(200);
    expect((await history.json() as { days: Record<string, unknown> }).days).toMatchObject({
      date: ['2026-05-01', '2026-05-02'], guests: [101, 95], netSalesCents: [350_050, 300_000],
    });

    const note = {
      kind: 'closure', startDate: '2026-05-04', endDate: '2026-05-04', weekdays: null, effect: 'closed', expectedGuests: null,
      detail: 'Closed for the town meeting',
    };
    const written = await call(server, `${location}/notes`, { session: staff, json: note });
    expect(written.status).toBe(201);
    const noteId = (await written.json() as { note: { id: string } }).note.id;
    const notes = await call(server, `${location}/notes`, { session: staff });
    expect(notes.status).toBe(200);
    expect((await notes.json() as { notes: { id: string }[] }).notes.map((listed) => listed.id)).toEqual([noteId]);

    const removed = await call(server, `${location}/sales`, { method: 'DELETE', session: staff });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ deletedDays: 2, deletedUploads: 2 });
    // Nobody joined, so the grant is still live, on the renamed organization.
    expect(await me(staff)).toMatchObject({
      access: { state: 'member', org: { id: org.orgId, name }, role: 'org_admin' }, openAsAdmin: { id: grantId, org: { id: org.orgId, name } },
    });
  });

  it('Your data works fully: list, turn off and on, delete; each is staff’s own, recorded with the grant id and no names', async () => {
    const created = await call(server, '/api/org/locations', {
      session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' }, orgId: org.orgId },
    });
    const locationId = (await created.json() as { location: { id: string } }).location.id;
    const location = `/api/org/locations/${locationId}`;
    const sent = await call(server, `${location}/sales/uploads`, { session: staff, json: { days: [{ date: '2026-05-01', guests: 101, netSalesCents: null }] } });
    const uploadId = (await sent.json() as { upload: { id: string } }).upload.id;
    const ref = `u_${uploadId}`;

    const listed = await call(server, `/api/org/data?locationId=${locationId}`, { session: staff });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { items: { ref: string }[] }).items.map((item) => item.ref)).toEqual([ref]);
    const off = await call(server, `${location}/data/${ref}`, { method: 'PATCH', session: staff, json: { enabled: false } });
    expect(off.status).toBe(200);
    expect(await server.connection.collection('tw_uploads').findOne({ _id: new Types.ObjectId(uploadId) })).toMatchObject({ disabledBy: staff.userId });
    expect((await call(server, `${location}/data/${ref}`, { method: 'PATCH', session: staff, json: { enabled: true } })).status).toBe(200);
    const removed = await call(server, `${location}/data/${ref}`, { method: 'DELETE', session: staff });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deletedDays: 1, deletedFiles: 0 });

    const events = (await auditEvents(server)).filter((event) => event.action.startsWith('data.') || event.action === 'sales.upload_deleted');
    expect(events.map((event) => event.action)).toEqual(['data.turned_off', 'data.turned_on', 'sales.upload_deleted']);
    for (const event of events) {
      expect(event).toMatchObject({ actorUserId: staff.userId, actorEmail: STAFF_EMAIL, actorRole: 'superadmin', viewAsGrantId: grantId });
    }
  });

  it('the name prompt is asked of the staff member, and the name saves to their own profile, not the organization’s', async () => {
    const asked = await call(server, '/api/me/profile', { session: staff });
    expect(await asked.json()).toEqual({ displayName: null, askName: true });
    const saved = await call(server, '/api/me/profile', { method: 'PATCH', session: staff, json: { displayName: 'Sam' } });
    expect(saved.status).toBe(200);
    expect(await server.connection.collection('tw_profiles').find({}).toArray()).toEqual([
      expect.objectContaining({ userId: staff.userId, displayName: 'Sam' }),
    ]);
  });

  it('Team is closed: list, add, change and remove answer 403 open_as_admin_refused, and no member row changes', async () => {
    const rows = (): Promise<unknown[]> => server.connection.collection('tw_members').find({ orgId: new Types.ObjectId(org.orgId) }).sort({ _id: 1 }).toArray();
    const before = await rows();
    // setupOrg's org admin invitation.
    expect(before).toHaveLength(1);
    const memberId = String((before[0] as { _id: Types.ObjectId })._id);
    const answers: { status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      answers.push(await errorOf(await call(server, '/api/org/members', { session: staff })));
      answers.push(await errorOf(await call(server, '/api/org/members', { session: staff, json: { emails: ['new-cook@example.test'], role: 'member' } })));
      answers.push(await errorOf(await call(server, `/api/org/members/${memberId}`, { method: 'PATCH', session: staff, json: { role: 'member' } })));
      answers.push(await errorOf(await call(server, `/api/org/members/${memberId}`, { method: 'DELETE', session: staff })));
    });
    expect(answers).toEqual(Array.from({ length: 4 }, () => ({ status: 403, error: 'open_as_admin_refused' })));
    expect(writes).toEqual([]);
    expect(await rows()).toEqual(before);
  });
});

describe('a grant that is not live is ignored', () => {
  it('once anyone joins the organization, from the next request on', async () => {
    expect((await call(server, '/probe/member', { session: staff })).status).toBe(200);
    await joinAs(server, org.adminEmail);
    expect(await errorOf(await call(server, '/probe/member', { session: staff }))).toEqual({ status: 403, error: 'no_access' });
    expect(await me(staff)).toMatchObject(notLive);
  });

  it('while the organization is suspended', async () => {
    await server.connection.collection('tw_orgs').updateOne(
      { _id: new Types.ObjectId(org.orgId) }, { $set: { status: 'suspended', suspendedAt: server.clock.now() } },
    );
    expect(await errorOf(await call(server, '/probe/member', { session: staff }))).toEqual({ status: 403, error: 'no_access' });
    expect(await me(staff)).toMatchObject(notLive);
  });

  it('for an organization that no longer exists', async () => {
    await server.connection.collection('tw_orgs').deleteOne({ _id: new Types.ObjectId(org.orgId) });
    expect(await me(staff)).toMatchObject(notLive);
    expect(await errorOf(await call(server, '/probe/member', { session: staff }))).toEqual({ status: 403, error: 'no_access' });
  });

  it('after its expiresAt', async () => {
    await regrant(1);
    expect((await me(staff)).openAsAdmin).not.toBeNull();
    server.clock.advance(2 * MINUTE);
    expect(await me(staff)).toMatchObject(notLive);
    expect(await errorOf(await call(server, '/probe/member', { session: staff }))).toEqual({ status: 403, error: 'no_access' });
  });

  it('once it has ended', async () => {
    await server.connection.collection('tw_view_as_grants').updateOne(
      { _id: new Types.ObjectId(grantId) }, { $set: { endedAt: server.clock.now(), endReason: 'ended' } },
    );
    expect(await me(staff)).toMatchObject(notLive);
  });

  it('in another session of the same staff member', async () => {
    const second = await anotherStaffSession();
    expect((await me(staff)).openAsAdmin).not.toBeNull();
    expect(await me(second)).toMatchObject(notLive);
    expect(await errorOf(await call(server, '/probe/member', { session: second }))).toEqual({ status: 403, error: 'no_access' });
  });

  it('after sign out everywhere: the session answers 401, and a new one starts with no open-as', async () => {
    expect((await call(server, '/auth/logout-all', { session: staff, json: {} })).status).toBeLessThan(300);
    expect((await call(server, '/api/me', { session: staff })).status).toBe(401);
    const fresh = await anotherStaffSession();
    expect(await me(fresh)).toMatchObject(notLive);
  });

  it('once the staff session is past its 60 minutes', async () => {
    await regrant(120);
    server.clock.advance(61 * MINUTE);
    await refresh(server, staff);
    expect(await me(staff)).toMatchObject({
      access: { state: 'staff_reauth_required', reason: 'session_too_old' }, openAsAdmin: null, viewAs: null, staff: null,
    });
    expect(await errorOf(await call(server, '/probe/member', { session: staff }))).toEqual({ status: 403, error: 'no_access' });
  });

  it('held by a session that is not staff, it is ignored', async () => {
    await addOpenAsAdminGrant(server, { actorUserId: other.adminUserId, sessionId: other.admin.sessionId, orgId: org.orgId });
    const body = await me(other.admin);
    expect(body).toMatchObject({ access: { state: 'member', org: { id: other.orgId }, role: 'org_admin' }, openAsAdmin: null, viewAs: null, staff: null });
    expect(await (await call(server, '/probe/member', { session: other.admin })).json()).toEqual({ kind: 'member', orgId: other.orgId, role: 'org_admin' });
  });

  it('one live grant per session across both kinds', async () => {
    await expect(addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: other.adminUserId, orgId: other.orgId }))
      .rejects.toThrow(/duplicate key/);
  });
});

describe('the grant store', () => {
  it('insertOpenAsAdmin answers false on a session that holds a grant, and writes the grant findBySession reads', async () => {
    const grants = createViewAsGrantStore(server.connection);
    const now = server.clock.now();
    const expiresAt = new Date(now.getTime() + 60 * MINUTE);
    const input = { id: new Types.ObjectId().toHexString(), actorUserId: staff.userId, sessionId: staff.sessionId, orgId: org.orgId, startedAt: now, expiresAt };
    expect(await grants.insertOpenAsAdmin(input)).toBe(false);

    await server.connection.collection('tw_view_as_grants').deleteMany({});
    expect(await grants.insertOpenAsAdmin(input)).toBe(true);
    const doc = await server.connection.collection('tw_view_as_grants').findOne({ _id: new Types.ObjectId(input.id) });
    expect(doc).toEqual({
      _id: new Types.ObjectId(input.id), kind: 'open_as_admin', actorUserId: staff.userId, actorSessionId: staff.sessionId,
      activeSessionId: staff.sessionId, orgId: new Types.ObjectId(org.orgId), startedAt: now, expiresAt, endedAt: null, endReason: null,
    });
    expect(await grants.findBySession(staff.sessionId)).toEqual({ kind: 'open_as_admin', id: input.id, orgId: org.orgId, startedAt: now, expiresAt, endedAt: null });
    expect((await me(staff)).openAsAdmin).toEqual({ id: input.id, org: { id: org.orgId, name: org.name }, startedAt: now.toISOString() });
  });

  it('a grant stored without a kind reads as view-as, as every grant before D25', async () => {
    await server.connection.collection('tw_view_as_grants').deleteMany({});
    const id = await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: other.adminUserId, orgId: other.orgId });
    expect(await createViewAsGrantStore(server.connection).findBySession(staff.sessionId))
      .toMatchObject({ kind: 'view_as', id, targetUserId: other.adminUserId, orgId: other.orgId });
  });

  it('a view-as grant still needs its target and a reason of 5 to 200 characters; kind takes only open_as_admin', async () => {
    const Grant = viewAsGrantModel(server.connection);
    const now = server.clock.now();
    const base = { actorUserId: staff.userId, actorSessionId: 'session', startedAt: now, expiresAt: now, endedAt: null, endReason: null };
    await expect(new Grant({ ...base, orgId: null, reason: 'Support request' }).validate()).rejects.toThrow(/targetUserId/);
    await expect(new Grant({ ...base, orgId: null, targetUserId: other.adminUserId }).validate()).rejects.toThrow(/reason/);
    await expect(new Grant({ ...base, orgId: null, targetUserId: other.adminUserId, reason: 'abc' }).validate()).rejects.toThrow(/reason/);
    await expect(new Grant({ ...base, orgId: null, targetUserId: other.adminUserId, reason: 'x'.repeat(201) }).validate()).rejects.toThrow(/reason/);
    await expect(new Grant({ ...base, orgId: null, targetUserId: other.adminUserId, reason: 'Support request' }).validate()).resolves.toBeUndefined();
    await expect(new Grant({ ...base, kind: 'view_as', orgId: null, targetUserId: other.adminUserId, reason: 'Support request' }).validate())
      .rejects.toThrow(/kind/);
    await expect(new Grant({ ...base, kind: 'open_as_admin', orgId: new Types.ObjectId(org.orgId) }).validate()).resolves.toBeUndefined();
  });
});
