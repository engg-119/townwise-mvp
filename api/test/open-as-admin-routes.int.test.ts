// Open as admin, Start and End through the API (D25, spec 9.2, 9.3, 10.7): staff open an organization nobody has joined
// as its admin. Start is recorded before the grant exists and is refused while a grant of either kind is live; End,
// shared with view-as, ends either kind and records its end. Grants here are made only by
// POST /api/admin/orgs/:orgId/open-as-admin.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEventView } from '../src/audit.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import { addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, logLines, MINUTE, refresh, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring,
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

/** Start, with no body. */
function start(orgId: string, session = staff): Promise<Response> {
  return call(server, `/api/admin/orgs/${orgId}/open-as-admin`, { method: 'POST', session });
}

function end(session = staff): Promise<Response> {
  return call(server, '/api/admin/view-as/end', { session, json: {} });
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
  });

  it('refuses an organization someone joined or that is suspended with 409 org_not_in_setup, an unknown one with 404 and a malformed id with 400, writing nothing', async () => {
    const joined = await setupOrg(server, staff);
    await joinAs(server, joined.adminEmail);
    const suspended = await setupOrg(server, staff);
    await setOrgStatus(suspended.orgId, 'suspended');
    const answers: { status: number; error: string }[] = [];
    const writes = await writesDuring(server, async () => {
      for (const orgId of [joined.orgId, suspended.orgId, new Types.ObjectId().toHexString(), 'not-an-id']) {
        answers.push(await errorOf(await start(orgId)));
      }
    });
    expect(answers).toEqual([
      { status: 409, error: 'org_not_in_setup' }, { status: 409, error: 'org_not_in_setup' },
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

  it('a grant that stopped being live (someone joined) is cleared by the next start, recorded as replaced', async () => {
    const next = await setupOrg(server, staff);
    const firstId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    await joinAs(server, org.adminEmail);
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

  it('after someone joined, End clears the ignored grant and records its end', async () => {
    const grantId = (await (await start(org.orgId)).json() as MeResponse).openAsAdmin?.id ?? '';
    await joinAs(server, org.adminEmail);
    expect(await me(staff)).toMatchObject(STAFF_ONLY);

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

  /** Start, then make one of each kind of change as the staff member; resolves the location's id. */
  async function changeAsStaff(): Promise<string> {
    expect((await start(org.orgId)).status).toBe(201);
    const renamed = await call(server, '/api/org', { method: 'PATCH', session: staff, json: { name: `${org.name} Two` } });
    expect(renamed.status).toBe(200);
    const created = await call(server, '/api/org/locations', {
      session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' } },
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
});
