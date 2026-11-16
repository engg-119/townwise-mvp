// Open as admin, Start and End through the API (D25, spec 9.2, 9.3, 10.7): staff open an organization as its admin,
// before or after anyone joins it (owner call, 2026-11-15). Start is recorded before the grant exists and is refused while a grant of either kind is live; End,
// shared with view-as, ends either kind and records its end. Grants here are made only by
// POST /api/admin/orgs/:orgId/open-as-admin.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEventView } from '../src/audit.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import { addGrant, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, logLines, makeStaff, MINUTE, refresh, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';
import { joinAs, setupOrg } from './helpers/setup-org.ts';

const REASON = 'Helping with their upload question';

let server: TownwiseTestServer;
let staff: TestSession;
/** When the staff session signed in: the staff window, and so the grant, ends 60 minutes later. */
let sessionStart: Date;
let org: { orgId: string; name: string; adminEmail: string };

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  sessionStart = server.clock.now();
  staff = await signInStaff(server);
  // Made through the console before any grant: while one is live, every staff route answers 409.
  org = await setupOrg(server, staff);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

/** Start: with no body, or with `{ reason }` (required once someone has joined). */
function start(orgId: string, session = staff, reason?: string): Promise<Response> {
  return call(server, `/api/admin/orgs/${orgId}/open-as-admin`, reason === undefined ? { method: 'POST', session } : { session, json: { reason } });
}

const OPEN_REASON = 'Fixing their location settings';

async function orgDoc(orgId: string, change: Record<string, unknown>): Promise<void> {
  await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(orgId) }, change);
}

function end(session = staff): Promise<Response> {
  return call(server, '/api/admin/view-as/end', { session, json: {} });
}

/** A second session of the staff member, which passes the gate too. */
async function anotherStaffSession(): Promise<TestSession> {
  // With codes enabled, a magic link answers a code challenge, so the factor is removed and seeded again.
  await server.authStores.totp.remove(staff.userId);
  const session = await signIn(server, STAFF_EMAIL);
  await makeStaff(server, staff.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
  return session;
}

function startViewAs(userId: string): Promise<Response> {
  return call(server, '/api/admin/view-as', { session: staff, json: { userId, reason: REASON } });
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

function grants(): ReturnType<TownwiseTestServer['connection']['collection']> {
  return server.connection.collection('tw_view_as_grants');
}

/** The events on this organization, but for the two setupOrg's console create writes (org.created, member.invited). */
async function eventsIn(orgId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server))
    .filter((event) => String(event.orgId) === orgId && event.action !== 'org.created' && event.action !== 'member.invited');
}

async function eventsOfGrant(grantId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === grantId);
}

async function setOrgStatus(orgId: string, status: 'active' | 'suspended'): Promise<void> {
  await server.connection.collection('tw_orgs').updateOne(
    { _id: new Types.ObjectId(orgId) },
    { $set: { status, suspendedAt: status === 'suspended' ? server.clock.now() : null } },
  );
}

const STAFF_ONLY = { access: { state: 'staff' }, viewAs: null, openAsAdmin: null };

describe('POST /api/admin/orgs/:orgId/open-as-admin', () => {
  it('answers 201 with the organization’s admin access and openAsAdmin set, and records open_as_admin.started with ids only', async () => {
    const res = await start(org.orgId);
    expect(res.status).toBe(201);
    const body = await res.json() as MeResponse;
    expect(body).toMatchObject({
      access: { state: 'member', org: { id: org.orgId, name: org.name }, role: 'org_admin' }, viewAs: null,
      openAsAdmin: { org: { id: org.orgId, name: org.name } },
    });
    expect(await me(staff)).toEqual(body);

    const grant = await grants().findOne({ activeSessionId: staff.sessionId });
    expect(grant).toMatchObject({ kind: 'open_as_admin', actorUserId: staff.userId, actorSessionId: staff.sessionId, endedAt: null });
    // The staff window's end: no timer of its own.
    expect(grant?.expiresAt).toEqual(new Date(sessionStart.getTime() + 60 * MINUTE));
    expect(grant).not.toHaveProperty('targetUserId');
    expect(grant).not.toHaveProperty('reason');
    const id = String(grant?._id);
    expect(body.openAsAdmin?.id).toBe(id);
    expect(await eventsIn(org.orgId)).toEqual([expect.objectContaining({
      action: 'open_as_admin.started', actorRole: 'superadmin', actorEmail: STAFF_EMAIL, viewAsGrantId: id, target: { type: 'grant', id }, details: {},
    })]);

    // The portal's first read after the start, GET /api/org, runs in this mode and answers the organization.
    const opened = await call(server, '/api/org', { session: staff });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ org: { id: org.orgId, name: org.name }, role: 'org_admin' });
  });

  it('once someone has joined, asks a reason as view-as does: none is 400 reason_required, one outside 5 to 200 characters 400 invalid_request, writing nothing', async () => {
    await joinAs(server, org.adminEmail);
    const answers: { status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      answers.push(await errorOf(await start(org.orgId)));
      answers.push(await errorOf(await call(server, `/api/admin/orgs/${org.orgId}/open-as-admin`, { session: staff, json: {} })));
      for (const reason of ['abc', '   abc   ', 'x'.repeat(201)]) answers.push(await errorOf(await start(org.orgId, staff, reason)));
    });
    expect(answers).toEqual([
      { status: 400, error: 'reason_required' }, { status: 400, error: 'reason_required' },
      { status: 400, error: 'invalid_request' }, { status: 400, error: 'invalid_request' }, { status: 400, error: 'invalid_request' },
    ]);
    expect(writes).toEqual([]);
    expect(await me(staff)).toMatchObject(STAFF_ONLY);
  });

  it('opens an organization someone joined with a reason: the grant and open_as_admin.started carry it, and its admin reads it in Townwise staff activity', async () => {
    const admin = await joinAs(server, org.adminEmail);
    const res = await start(org.orgId, staff, `  ${OPEN_REASON}  `);
    expect(res.status).toBe(201);
    const body = await res.json() as MeResponse;
    expect(body).toMatchObject({
      access: { state: 'member', org: { id: org.orgId, name: org.name }, role: 'org_admin' }, viewAs: null,
      openAsAdmin: { org: { id: org.orgId, name: org.name } },
    });
    const id = body.openAsAdmin?.id ?? '';
    expect(await grants().findOne({ _id: new Types.ObjectId(id) })).toMatchObject({ kind: 'open_as_admin', reason: OPEN_REASON });
    expect((await eventsIn(org.orgId)).filter((event) => event.action === 'open_as_admin.started')).toEqual([expect.objectContaining({
      actorRole: 'superadmin', actorEmail: STAFF_EMAIL, viewAsGrantId: id, target: { type: 'grant', id }, details: { reason: OPEN_REASON },
    })]);
    const activity = await call(server, '/api/org/staff-activity', { session: admin });
    expect(activity.status).toBe(200);
    const started = (await activity.json() as { events: Record<string, unknown>[] }).events
      .filter((event) => String(event.summary).startsWith('Opened the organization as its admin'));
    expect(started).toEqual([expect.objectContaining({
      staffEmail: STAFF_EMAIL, summary: 'Opened the organization as its admin', viewAs: null, openAsAdmin: { reason: OPEN_REASON },
    })]);
  });

  it('“joined” is staff setup’s: a firstJoinedAt alone, or a member row that joined on an organization from before that field, asks a reason; an open invitation does not', async () => {
    // Everyone who joined has since left: firstJoinedAt outlives the seat.
    await orgDoc(org.orgId, { $set: { firstJoinedAt: server.clock.now() } });
    const legacy = await setupOrg(server, staff);
    await joinAs(server, legacy.adminEmail);
    await orgDoc(legacy.orgId, { $unset: { firstJoinedAt: '' } });
    const invited = await setupOrg(server, staff);
    expect(await errorOf(await start(org.orgId))).toEqual({ status: 400, error: 'reason_required' });
    expect(await errorOf(await start(legacy.orgId))).toEqual({ status: 400, error: 'reason_required' });
    // The console agrees: neither is in setup.
    for (const orgId of [org.orgId, legacy.orgId]) {
      expect(await (await call(server, `/api/admin/orgs/${orgId}`, { session: staff })).json()).toMatchObject({ org: { inSetup: false } });
    }
    const opened = await start(invited.orgId);
    expect(opened.status).toBe(201);
    const id = (await opened.json() as MeResponse).openAsAdmin?.id ?? '';
    expect(await grants().findOne({ _id: new Types.ObjectId(id) })).not.toHaveProperty('reason');
    expect((await eventsOfGrant(id))[0]).toMatchObject({ action: 'open_as_admin.started', details: {} });
  });

  it('refuses a suspended organization with 409 org_suspended, joined or not, an unknown one with 404 and a malformed id with 400, writing nothing', async () => {
    await setOrgStatus(org.orgId, 'suspended');
    const joined = await setupOrg(server, staff);
    await joinAs(server, joined.adminEmail);
    await setOrgStatus(joined.orgId, 'suspended');
    const answers: { status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      for (const orgId of [org.orgId, joined.orgId, new Types.ObjectId().toHexString(), 'not-an-id']) {
        answers.push(await errorOf(await start(orgId)));
      }
    });
    expect(answers).toEqual([
      { status: 409, error: 'org_suspended' }, { status: 409, error: 'org_suspended' },
      { status: 404, error: 'not_found' }, { status: 400, error: 'invalid_request' },
    ]);
    expect(writes).toEqual([]);
    expect(await me(staff)).toMatchObject(STAFF_ONLY);
  });

  it('refuses everyone who is not staff, writing nothing', async () => {
    const adminEmail = uniqueEmail('org-admin');
    const admin = await signIn(server, adminEmail);
    const seatedOrg = await createOrg(server, { name: 'Seated Org' });
    await addSeat(server, { orgId: seatedOrg, userId: admin.userId, email: adminEmail, role: 'org_admin' });
    const outsider = await signIn(server, uniqueEmail('no-org'));
    const answers: { status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      answers.push(await errorOf(await start(org.orgId, admin)));
      answers.push(await errorOf(await start(seatedOrg, admin)));
      answers.push(await errorOf(await start(org.orgId, outsider)));
    });
    expect(answers).toEqual([
      { status: 403, error: 'forbidden' }, { status: 403, error: 'forbidden' }, { status: 403, error: 'forbidden' },
    ]);
    expect(writes).toEqual([]);

    server.clock.advance(61 * MINUTE);
    await refresh(server, staff);
    const stale = await writesDuring(server, async () => {
      expect(await errorOf(await start(org.orgId))).toEqual({ status: 403, error: 'staff_reauth_required' });
    });
    expect(stale).toEqual([]);
    expect(await grants().countDocuments({ kind: 'open_as_admin', orgId: new Types.ObjectId(org.orgId) })).toBe(0);
  });

  it('is refused with 503 and leaves no grant when its audit write fails', async () => {
    const db = server.connection.db;
    if (db === undefined) throw new Error('not connected');
    const grantsBefore = await grants().countDocuments({});
    await db.command({ collMod: 'tw_audit_events', validator: { $expr: { $eq: [1, 0] } } });
    try {
      expect(await errorOf(await start(org.orgId))).toEqual({ status: 503, error: 'unavailable' });
    } finally {
      await db.command({ collMod: 'tw_audit_events', validator: {} });
    }
    expect(await grants().countDocuments({})).toBe(grantsBefore);
    expect(await me(staff)).toMatchObject(STAFF_ONLY);
  });

  it('two starts racing on one session leave one live grant, and every grant and every refusal is recorded', async () => {
    // Five organizations race, as in the view-as race test: a start that replaced another's live grant would show as a
    // second 201 and an open_as_admin.ended event.
    const orgs = [org];
    for (let i = 0; i < 4; i += 1) orgs.push(await setupOrg(server, staff));
    const ours = new Set(orgs.map((o) => o.orgId));
    const statuses = (await Promise.all(orgs.map((o) => start(o.orgId)))).map((res) => res.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409, 409, 409, 409]);

    const sessionGrants = await grants().find({ actorSessionId: staff.sessionId }).toArray();
    expect(sessionGrants).toHaveLength(1);
    const live = sessionGrants[0];
    expect(live?.activeSessionId).toBe(staff.sessionId);
    const liveId = String(live?._id);

    const events = (await auditEvents(server)).filter((event) => ours.has(String(event.orgId)));
    expect(events.filter((event) => event.action === 'open_as_admin.ended')).toEqual([]);
    const started = events.filter((event) => event.action === 'open_as_admin.started');
    expect(started.map((event) => (event.target as { id: string }).id)).toContain(liveId);
    const notApplied = new Map(events.filter((event) => event.action === 'staff_action.not_applied')
      .map((event) => [(event.details as { eventId: string }).eventId, event]));
    for (const event of started) {
      const grantId = (event.target as { id: string }).id;
      if (grantId === liveId) {
        expect(notApplied.has(String(event._id))).toBe(false);
      } else {
        // A loser that reached the handler: recorded, then recorded as not applied.
        expect(notApplied.get(String(event._id))).toMatchObject({
          viewAsGrantId: grantId, target: { type: 'grant', id: grantId }, details: { eventId: String(event._id), code: 'open_as_admin_active' },
        });
      }
    }
    expect(notApplied.size).toBe(started.length - 1);
    expect((await me(staff)).openAsAdmin).toMatchObject({ id: liveId, org: { id: String(live?.orgId) } });
  });

  it('one organization at a time: while one is live, a second start and a view-as start answer 409 open_as_admin_active and write nothing', async () => {
    const second = await setupOrg(server, staff);
    const target = await signIn(server, uniqueEmail('target'));
    expect((await start(org.orgId)).status).toBe(201);
    const answers: { status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      answers.push(await errorOf(await start(second.orgId)));
      answers.push(await errorOf(await start(org.orgId)));
      answers.push(await errorOf(await startViewAs(target.userId)));
    });
    expect(answers).toEqual([
      { status: 409, error: 'open_as_admin_active' }, { status: 409, error: 'open_as_admin_active' },
      { status: 409, error: 'open_as_admin_active' },
    ]);
    expect(writes).toEqual([]);
    expect((await me(staff)).openAsAdmin?.org.id).toBe(org.orgId);
  });

  it('while view-as is live, a start answers 409 view_as_active', async () => {
    const target = await signIn(server, uniqueEmail('viewed'));
    expect((await startViewAs(target.userId)).status).toBe(201);
    const writes = await writesDuring(server, async () => {
      expect(await errorOf(await start(org.orgId))).toEqual({ status: 409, error: 'view_as_active' });
    });
    expect(writes).toEqual([]);
    expect(await grants().countDocuments({ kind: 'open_as_admin', actorSessionId: staff.sessionId })).toBe(0);
  });

  it('a grant that stopped being live (its organization was suspended) is cleared by the next start, recorded as replaced', async () => {
    const next = await setupOrg(server, staff);
    const firstId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    await setOrgStatus(org.orgId, 'suspended');
    expect(await me(staff)).toMatchObject(STAFF_ONLY);

    const res = await start(next.orgId);
    expect(res.status).toBe(201);
    expect((await res.json() as MeResponse).openAsAdmin?.org.id).toBe(next.orgId);
    const first = await grants().findOne({ _id: new Types.ObjectId(firstId) });
    expect(first).toMatchObject({ endedAt: server.clock.now(), endReason: 'replaced' });
    expect(first).not.toHaveProperty('activeSessionId');
    const ended = (await eventsOfGrant(firstId)).filter((event) => event.action === 'open_as_admin.ended');
    expect(ended).toEqual([expect.objectContaining({
      actorRole: 'superadmin', actorEmail: STAFF_EMAIL, viewAsGrantId: firstId, target: { type: 'grant', id: firstId }, details: { endReason: 'replaced' },
    })]);
    expect(String(ended[0]?.orgId)).toBe(org.orgId);
  });
});

describe('End (POST /api/admin/view-as/end)', () => {
  it('ends the grant and records open_as_admin.ended; the next GET /api/me is staff; a second End writes nothing', async () => {
    const grantId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    server.clock.advance(MINUTE);

    const res = await end();
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body).toMatchObject({ user: { id: staff.userId }, ...STAFF_ONLY });
    expect(await me(staff)).toEqual(body);
    const grant = await grants().findOne({ _id: new Types.ObjectId(grantId) });
    expect(grant).toMatchObject({ endedAt: server.clock.now(), endReason: 'ended' });
    expect(grant).not.toHaveProperty('activeSessionId');
    const events = await eventsOfGrant(grantId);
    expect(events.map((event) => event.action)).toEqual(['open_as_admin.started', 'open_as_admin.ended']);
    expect(events[1]).toMatchObject({
      at: server.clock.now(), actorUserId: staff.userId, actorEmail: STAFF_EMAIL, actorRole: 'superadmin', viewAsGrantId: grantId,
      target: { type: 'grant', id: grantId }, details: { endReason: 'ended' },
    });
    expect(String(events[1]?.orgId)).toBe(org.orgId);

    let again: Response | undefined;
    const writes = await writesDuring(server, async () => { again = await end(); });
    expect(again?.status).toBe(200);
    expect(writes).toEqual([]);

    // The audit log names both in plain words, with no view-as label.
    const audit = await (await call(server, `/api/admin/audit?orgId=${org.orgId}`, { session: staff })).json() as { events: AuditEventView[] };
    expect(audit.events.filter((event) => event.action.startsWith('open_as_admin.')).map((event) => [event.summary, event.viewAs])).toEqual([
      ['Ended setting up as admin', null],
      ['Opened the organization as its admin, to set it up', null],
    ]);
  });

  it('after someone joined, the grant is still live, and End ends it and records its end', async () => {
    const grantId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    await joinAs(server, org.adminEmail);
    expect((await me(staff)).openAsAdmin).toMatchObject({ id: grantId, org: { id: org.orgId } });

    expect((await end()).status).toBe(200);
    expect(await grants().findOne({ _id: new Types.ObjectId(grantId) })).toMatchObject({ endReason: 'ended' });
    expect(await grants().findOne({ activeSessionId: staff.sessionId })).toBeNull();
    const ended = (await eventsOfGrant(grantId)).filter((event) => event.action === 'open_as_admin.ended');
    expect(ended).toEqual([expect.objectContaining({ viewAsGrantId: grantId, details: { endReason: 'ended' } })]);
    expect(String(ended[0]?.orgId)).toBe(org.orgId);
  });

  it('once ended, a reactivated organization does not bring it back', async () => {
    expect((await start(org.orgId)).status).toBe(201);
    await setOrgStatus(org.orgId, 'suspended');
    expect(await me(staff)).toMatchObject(STAFF_ONLY);
    expect((await end()).status).toBe(200);
    await setOrgStatus(org.orgId, 'active');
    expect(await me(staff)).toMatchObject(STAFF_ONLY);
  });
});

describe('a suspension', () => {
  it('ends it for good: with no End ever sent, a reactivation inside the staff window does not bring it back', async () => {
    const grantId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    // Another staff session suspends and reactivates through the console, as staff B (or A on another device) would.
    const other = await anotherStaffSession();
    const setStatus = (status: 'active' | 'suspended'): Promise<Response> =>
      call(server, `/api/admin/orgs/${org.orgId}`, { method: 'PATCH', session: other, json: { status } });
    server.clock.advance(MINUTE);
    expect((await setStatus('suspended')).status).toBe(200);
    // A fresh tab reads GET /api/me during the suspension, so the client never sends End.
    expect(await me(staff)).toMatchObject(STAFF_ONLY);
    server.clock.advance(MINUTE);
    expect((await setStatus('active')).status).toBe(200);

    expect(await me(staff)).toMatchObject(STAFF_ONLY);
    expect(await errorOf(await call(server, '/api/org', { session: staff }))).toEqual({ status: 403, error: 'no_access' });
    // The resolver wrote nothing: the grant still holds the session, and the next start or End clears it.
    expect(await grants().findOne({ _id: new Types.ObjectId(grantId) })).toMatchObject({ activeSessionId: staff.sessionId, endedAt: null });

    // Opened again after the reactivation, it is a new grant, and live.
    const reopened = await start(org.orgId);
    expect(reopened.status).toBe(201);
    expect((await reopened.json() as MeResponse).openAsAdmin?.id).not.toBe(grantId);
    expect(await grants().findOne({ _id: new Types.ObjectId(grantId) })).toMatchObject({ endReason: 'replaced' });
  });
});

describe('a tab still showing an organization this session no longer has open', () => {
  /** X (`org`) open, then suspended, then Y opened from the console: the X tab has not read GET /api/me since. */
  async function openYAfterXSuspended(): Promise<{ y: { orgId: string; name: string }; xGrantId: string; yGrantId: string }> {
    const y = await setupOrg(server, staff);
    const xGrantId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    await setOrgStatus(org.orgId, 'suspended');
    const started = await start(y.orgId);
    expect(started.status).toBe(201);
    return { y, xGrantId, yGrantId: (await started.json() as MeResponse).openAsAdmin?.id ?? '' };
  }

  it('its rename and new location, naming X or no organization, answer 409 open_as_admin_active and write nothing in Y', async () => {
    const { y } = await openYAfterXSuspended();
    const answers: { status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      for (const named of [{ orgId: org.orgId }, {}]) {
        answers.push(await errorOf(await call(server, '/api/org', { method: 'PATCH', session: staff, json: { name: 'Meant for X', ...named } })));
        answers.push(await errorOf(await call(server, '/api/org/locations', {
          session: staff, json: { name: 'Meant for X Street', town: { townId: 'hanover-nh' }, ...named },
        })));
      }
    });
    expect(answers).toEqual(Array.from({ length: 4 }, () => ({ status: 409, error: 'open_as_admin_active' })));
    expect(writes).toEqual([]);
    // A tab showing Y names Y, and its rename goes through.
    const renamed = await call(server, '/api/org', { method: 'PATCH', session: staff, json: { name: `${y.name} Two`, orgId: y.orgId } });
    expect(renamed.status).toBe(200);
  });

  it('its End, naming X’s grant, leaves Y’s running and writes nothing; End naming Y’s grant ends it', async () => {
    const { y, xGrantId, yGrantId } = await openYAfterXSuspended();
    let stale: Response | undefined;
    const writes = await writesDuring(server, async () => {
      stale = await call(server, '/api/admin/view-as/end', { session: staff, json: { grantId: xGrantId } });
    });
    expect(stale?.status).toBe(200);
    expect(writes).toEqual([]);
    expect((await me(staff)).openAsAdmin).toMatchObject({ id: yGrantId, org: { id: y.orgId } });

    const res = await call(server, '/api/admin/view-as/end', { session: staff, json: { grantId: yGrantId } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(STAFF_ONLY);
    expect(await grants().findOne({ _id: new Types.ObjectId(yGrantId) })).toMatchObject({ endReason: 'ended' });
  });

  it('a view-as tab’s End, naming its view-as grant, ends it; once open as admin started since, the same End leaves it running', async () => {
    const target = await signIn(server, uniqueEmail('viewed-tab'));
    const viewAsId = (await (await startViewAs(target.userId)).json() as MeResponse).viewAs?.id ?? '';
    const endViewAs = (): Promise<Response> => call(server, '/api/admin/view-as/end', { session: staff, json: { grantId: viewAsId } });
    expect((await endViewAs()).status).toBe(200);
    expect(await grants().findOne({ _id: new Types.ObjectId(viewAsId) })).toMatchObject({ endReason: 'ended' });
    const openId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    let stale: Response | undefined;
    const writes = await writesDuring(server, async () => { stale = await endViewAs(); });
    expect(stale?.status).toBe(200);
    expect(writes).toEqual([]);
    expect((await me(staff)).openAsAdmin?.id).toBe(openId);
  });
});

describe('a grant that expired with an earlier staff sign-in', () => {
  /** Its end, recorded late: the grant and its one open_as_admin.ended event carry the time it expired, not the time of the record. */
  async function expectEndedAtExpiry(grantId: string): Promise<void> {
    const expiresAt = new Date(sessionStart.getTime() + 60 * MINUTE);
    const grant = await grants().findOne({ _id: new Types.ObjectId(grantId) });
    expect(grant).toMatchObject({ endedAt: expiresAt, endReason: 'expired' });
    expect(grant).not.toHaveProperty('activeSessionId');
    const ended = (await eventsOfGrant(grantId)).filter((event) => event.action === 'open_as_admin.ended');
    expect(ended).toEqual([expect.objectContaining({
      at: expiresAt, actorRole: 'superadmin', actorUserId: staff.userId, viewAsGrantId: grantId, details: { endReason: 'expired' },
    })]);
    expect(String(ended[0]?.orgId)).toBe(org.orgId);
  }

  it('is ended as expired by the next sign-in’s End, at the time it expired, on its organization with its own summary', async () => {
    const grantId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    // Recorded hours later, it still carries the time it expired.
    server.clock.advance(4 * 60 * MINUTE);
    const next = await anotherStaffSession();
    expect((await end(next)).status).toBe(200);
    await expectEndedAtExpiry(grantId);
    const audit = await (await call(server, `/api/admin/audit?orgId=${org.orgId}`, { session: next })).json() as { events: AuditEventView[] };
    expect(audit.events.filter((event) => event.action.startsWith('open_as_admin.')).map((event) => event.summary)).toEqual([
      'Setting up as admin ended with the staff sign-in', 'Opened the organization as its admin, to set it up',
    ]);
  });

  it('is ended the same way by the next sign-in’s open-as-admin start, and by its view-as start', async () => {
    const first = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    server.clock.advance(61 * MINUTE);
    const next = await anotherStaffSession();
    const y = await setupOrg(server, next);
    expect((await start(y.orgId, next)).status).toBe(201);
    await expectEndedAtExpiry(first);

    // And a view-as start: a third sign-in, after the second's grant expired too.
    const second = (await me(next)).openAsAdmin?.id ?? '';
    server.clock.advance(61 * MINUTE);
    const third = await anotherStaffSession();
    const target = await signIn(server, uniqueEmail('viewed-later'));
    expect((await call(server, '/api/admin/view-as', { session: third, json: { userId: target.userId, reason: REASON } })).status).toBe(201);
    expect(await grants().findOne({ _id: new Types.ObjectId(second) })).toMatchObject({ endReason: 'expired' });
    expect((await eventsOfGrant(second)).filter((event) => event.action === 'open_as_admin.ended')).toEqual([
      expect.objectContaining({ actorUserId: staff.userId, details: { endReason: 'expired' } }),
    ]);
  });

  it('leaves a view-as grant that expired in another session, and another staff member’s grant, alone (decision 6)', async () => {
    const twoHoursAgo = new Date(server.clock.now().getTime() - 120 * MINUTE);
    const target = await signIn(server, uniqueEmail('viewed-before'));
    const viewAs = await addGrant(server, {
      actorUserId: staff.userId, sessionId: 'an-earlier-session', targetUserId: target.userId, orgId: null, startedAt: twoHoursAgo,
    });
    const theirs = await addOpenAsAdminGrant(server, {
      actorUserId: new Types.ObjectId().toHexString(), sessionId: 'another-staff-member', orgId: org.orgId, startedAt: twoHoursAgo,
    });
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await end(); });
    expect(res?.status).toBe(200);
    expect(writes).toEqual([]);
    expect(await grants().findOne({ _id: new Types.ObjectId(viewAs) })).toMatchObject({ activeSessionId: 'an-earlier-session', endedAt: null });
    expect(await grants().findOne({ _id: new Types.ObjectId(theirs) })).toMatchObject({ activeSessionId: 'another-staff-member', endedAt: null });
  });

  it('a start in another session leaves a grant still live there alone', async () => {
    const grantId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    const next = await anotherStaffSession();
    const y = await setupOrg(server, next);
    expect((await start(y.orgId, next)).status).toBe(201);
    expect(await grants().findOne({ _id: new Types.ObjectId(grantId) })).toMatchObject({ activeSessionId: staff.sessionId, endedAt: null });
    expect((await me(staff)).openAsAdmin?.id).toBe(grantId);
  });
});

describe('the record', () => {
  it('start and end carry only allowlisted details, and no name, email or reason', async () => {
    expect((await start(org.orgId)).status).toBe(201);
    expect((await end()).status).toBe(200);
    const events = (await auditEvents(server)).filter((event) => String(event.action).startsWith('open_as_admin.'));
    expect(new Set(events.map((event) => event.action))).toEqual(new Set(['open_as_admin.started', 'open_as_admin.ended']));
    for (const event of events) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action as AuditAction];
      for (const key of Object.keys(event.details as object)) expect(allowed).toContain(key);
      const text = JSON.stringify(event.details);
      // Every organization in this file is named “Setup Kitchen …” (setupOrg).
      expect(text).not.toContain('Setup Kitchen');
      expect(text).not.toContain(STAFF_EMAIL);
      expect(text).not.toContain(REASON);
    }
  });

  it('logs no email or organization name while starting and ending', async () => {
    server.logs.length = 0;
    expect((await start(org.orgId)).status).toBe(201);
    expect((await call(server, '/api/me', { session: staff })).status).toBe(200);
    expect((await end()).status).toBe(200);
    const lines = logLines(server);
    expect(lines.length).toBeGreaterThan(0);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(STAFF_EMAIL);
    expect(text).not.toContain(org.name);
  });
});

describe('attribution', () => {
  const DAY = { date: '2026-05-01', guests: 20, netSalesCents: 150_000 };
  const NOTE = {
    kind: 'closure', startDate: '2026-05-04', endDate: '2026-05-04', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
  };

  /** Start (with a reason once someone has joined), then make one of each kind of change as the staff member; resolves the location's id. */
  async function changeAsStaff(reason?: string): Promise<string> {
    expect((await start(org.orgId, staff, reason)).status).toBe(201);
    const renamed = await call(server, '/api/org', { method: 'PATCH', session: staff, json: { name: `${org.name} Two`, orgId: org.orgId } });
    expect(renamed.status).toBe(200);
    const created = await call(server, '/api/org/locations', {
      session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' }, orgId: org.orgId },
    });
    expect(created.status).toBe(201);
    const locationId = (await created.json() as { location: { id: string } }).location.id;
    expect((await call(server, `/api/org/locations/${locationId}/notes`, { session: staff, json: NOTE })).status).toBe(201);
    expect((await call(server, `/api/org/locations/${locationId}/sales/uploads`, { session: staff, json: { days: [DAY] } })).status).toBe(201);
    expect((await call(server, `/api/org/locations/${locationId}/sales`, { method: 'DELETE', session: staff })).status).toBe(200);
    // Uploaded again, so the admin who joins later finds an upload to read.
    expect((await call(server, `/api/org/locations/${locationId}/sales/uploads`, { session: staff, json: { days: [DAY] } })).status).toBe(201);
    return locationId;
  }

  it('every change made inside is recorded as Townwise staff: actor role superadmin, the staff email and the grant id', async () => {
    await changeAsStaff();
    const grantId = String((await grants().findOne({ activeSessionId: staff.sessionId }))?._id);
    const changes = (await eventsIn(org.orgId)).filter((event) => !String(event.action).startsWith('open_as_admin.'));
    expect(changes.map((event) => event.action).sort()).toEqual([
      'location.created', 'note.created', 'org.renamed', 'sales.deleted', 'sales.uploaded', 'sales.uploaded',
    ]);
    for (const event of changes) {
      expect(event).toMatchObject({ actorRole: 'superadmin', actorEmail: STAFF_EMAIL, actorUserId: staff.userId, viewAsGrantId: grantId });
    }
  });

  it('what staff wrote is stored with byStaff', async () => {
    const locationId = await changeAsStaff();
    const orgOid = new Types.ObjectId(org.orgId);
    expect(await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(locationId) })).toMatchObject({ byStaff: true });
    expect(await server.connection.collection('tw_notes').find({ orgId: orgOid }).toArray()).toEqual([expect.objectContaining({ byStaff: true })]);
    expect(await server.connection.collection('tw_uploads').find({ orgId: orgOid }).toArray()).toEqual([expect.objectContaining({ byStaff: true })]);
  });

  it('the admin who joins sees each change in Townwise staff activity, and every author reads Townwise staff', async () => {
    const locationId = await changeAsStaff();
    expect((await end()).status).toBe(200);
    const admin = await joinAs(server, org.adminEmail);

    const activity = await call(server, '/api/org/staff-activity', { session: admin });
    expect(activity.status).toBe(200);
    const summaries = (await activity.json() as { events: { summary: string }[] }).events.map((event) => event.summary);
    expect(summaries).toEqual(expect.arrayContaining([
      'Opened the organization as its admin, to set it up', 'Ended setting up as admin',
      'Added the location Main Street', 'Added a note (closure), 2026-05-04 to 2026-05-04',
    ]));

    const notes = await call(server, `/api/org/locations/${locationId}/notes`, { session: admin });
    const notesText = await notes.text();
    const noteList = (JSON.parse(notesText) as { notes: { createdByEmail: string; canEdit: boolean }[] }).notes;
    expect(noteList).toHaveLength(1);
    expect(noteList.map((note) => [note.createdByEmail, note.canEdit])).toEqual([['Townwise staff', true]]);

    const sales = await call(server, `/api/org/locations/${locationId}/sales`, { session: admin });
    const salesText = await sales.text();
    const uploads = (JSON.parse(salesText) as { uploads: { uploadedByEmail: string }[] }).uploads;
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((upload) => upload.uploadedByEmail === 'Townwise staff')).toBe(true);
    // The staff activity names the staff member by design (D9); the authors of notes and uploads never do.
    for (const text of [notesText, salesText]) expect(text).not.toContain(STAFF_EMAIL);
  });

  it('after a join, the admin sees each change while staff are still inside, and what staff wrote reads Townwise staff', async () => {
    const admin = await joinAs(server, org.adminEmail);
    const locationId = await changeAsStaff(OPEN_REASON);
    // Still open: nothing ended it.
    expect((await me(staff)).openAsAdmin).toMatchObject({ org: { id: org.orgId } });
    const grantId = String((await grants().findOne({ activeSessionId: staff.sessionId }))?._id);

    const activity = await call(server, '/api/org/staff-activity', { session: admin });
    expect(activity.status).toBe(200);
    const summaries = (await activity.json() as { events: { summary: string }[] }).events.map((event) => event.summary);
    expect(summaries).toEqual(expect.arrayContaining([
      'Opened the organization as its admin', 'Added the location Main Street', 'Added a note (closure), 2026-05-04 to 2026-05-04',
    ]));
    const changes = (await eventsIn(org.orgId)).filter((event) => !String(event.action).startsWith('open_as_admin.') && event.actorRole === 'superadmin');
    expect(changes.length).toBeGreaterThan(0);
    for (const event of changes) expect(event).toMatchObject({ actorEmail: STAFF_EMAIL, viewAsGrantId: grantId });

    const notes = await (await call(server, `/api/org/locations/${locationId}/notes`, { session: admin })).json() as { notes: { createdByEmail: string }[] };
    expect(notes.notes.map((note) => note.createdByEmail)).toEqual(['Townwise staff']);
  });
});
