// View-as Start and End through the API (spec F8, Section 8, 9.3, 10.7): read-only, recorded, and bound to the
// staff member's session. Grants here are made only by POST /api/admin/view-as.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import type { AuditEventView } from '../src/audit.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import {
  addInvite, addLocation, addNote, addRequest, addSalesDay, addSeat, auditEvents, createOrg,
} from './helpers/fixtures.ts';
import {
  call, limiterKey, MINUTE, refresh, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const REASON = 'Helping with their upload question';

let server: TownwiseTestServer;
let staff: TestSession;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

function start(userId: string, reason = REASON, session = staff): Promise<Response> {
  return call(server, '/api/admin/view-as', { session, json: { userId, reason } });
}

function end(session = staff): Promise<Response> {
  return call(server, '/api/admin/view-as/end', { session, json: {} });
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

/** An org admin of a new organization, with one open invitation. */
async function orgAdmin(name: string): Promise<{ email: string; session: TestSession; orgId: string; inviteId: string }> {
  const email = uniqueEmail(name);
  const session = await signIn(server, email);
  const orgId = await createOrg(server, { name: `${name} Org` });
  await addSeat(server, { orgId, userId: session.userId, email, role: 'org_admin' });
  const inviteId = await addInvite(server, { orgId, email: uniqueEmail(`${name}-invited`), invitedBy: session.userId });
  return { email, session, orgId, inviteId };
}

function grantDoc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_view_as_grants').findOne({ _id: new Types.ObjectId(id) });
}

async function eventsOfGrant(grantId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === grantId);
}

/** Every Townwise collection, serialized, so any write shows. */
async function snapshot(): Promise<string> {
  const docs: unknown[] = [];
  for (const name of [
    'tw_orgs', 'tw_members', 'tw_locations', 'tw_sales_days', 'tw_uploads', 'tw_notes', 'tw_access_requests',
    'tw_view_as_grants', 'tw_audit_events',
  ]) {
    docs.push(await server.connection.collection(name).find({}).sort({ _id: 1 }).toArray());
  }
  return JSON.stringify(docs);
}

describe('POST /api/admin/view-as', () => {
  it('answers 201 with the target’s exact access, Waiting included, and records view_as.started for the grant', async () => {
    const email = uniqueEmail('waiting');
    const target = await signIn(server, email);
    await addRequest(server, { userId: target.userId, email, status: 'pending' });
    const now = server.clock.now();
    const expiresAt = new Date(now.getTime() + 30 * MINUTE);

    const res = await start(target.userId, `  ${REASON}  `);
    expect(res.status).toBe(201);
    const body = await res.json() as MeResponse;
    const grantId = body.viewAs?.id ?? '';
    expect(body).toEqual({
      user: { id: staff.userId, email: STAFF_EMAIL },
      access: (await me(target)).access,
      viewAs: {
        id: grantId, target: { userId: target.userId, email }, org: null, role: null, reason: REASON,
        startedAt: now.toISOString(), endsAt: expiresAt.toISOString(),
      },
      openAsAdmin: null,
      staff: { verifiedUntil: new Date(now.getTime() + 60 * MINUTE).toISOString() },
      welcome: null,
    });
    expect(body.access.state).toBe('pending');
    expect(await me(staff)).toEqual(body);

    const { _id, ...grant } = await grantDoc(grantId) ?? {};
    expect(String(_id)).toBe(grantId);
    expect(grant).toEqual({
      actorUserId: staff.userId, actorSessionId: staff.sessionId, activeSessionId: staff.sessionId,
      targetUserId: target.userId, orgId: null, reason: REASON, startedAt: now, expiresAt, endedAt: null, endReason: null,
    });
    const events = await eventsOfGrant(grantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      at: now, actorUserId: staff.userId, actorEmail: STAFF_EMAIL, actorRole: 'superadmin', viewAsGrantId: grantId, orgId: null,
      action: 'view_as.started', target: { type: 'grant', id: grantId },
    });
    expect(events[0]?.details).toEqual({ targetUserId: target.userId, targetEmail: email, reason: REASON, expiresAt: expiresAt.toISOString() });
  });

  it('binds the grant and its event to the target’s organization', async () => {
    const target = await orgAdmin('bound');
    const res = await start(target.session.userId);
    expect(res.status).toBe(201);
    const body = await res.json() as MeResponse;
    expect(body.access).toEqual({ state: 'member', org: { id: target.orgId, name: 'bound Org' }, role: 'org_admin' });
    expect(body.viewAs).toMatchObject({ org: { id: target.orgId, name: 'bound Org' }, role: 'org_admin' });
    const grantId = body.viewAs?.id ?? '';
    expect(String((await grantDoc(grantId))?.orgId)).toBe(target.orgId);
    expect(String((await eventsOfGrant(grantId))[0]?.orgId)).toBe(target.orgId);
  });

  it('refuses a staff target, an unknown person, a malformed id and a reason outside 5 to 200 characters, writing nothing', async () => {
    const target = await signIn(server, uniqueEmail('plain'));
    const before = await snapshot();
    expect(await errorOf(await start(staff.userId))).toEqual({ status: 400, error: 'invalid_target' });
    expect(await errorOf(await start(new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await start('not-an-id'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await start(target.userId, '  abcd  '))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await start(target.userId, 'x'.repeat(201)))).toEqual({ status: 400, error: 'invalid_request' });
    const extra = await call(server, '/api/admin/view-as', { session: staff, json: { userId: target.userId } });
    expect(await errorOf(extra)).toEqual({ status: 400, error: 'invalid_request' });
    expect(await snapshot()).toBe(before);
  });

  it('is refused with 503 and leaves no grant when its audit write fails', async () => {
    const target = await signIn(server, uniqueEmail('unrecorded'));
    const db = server.connection.db;
    if (db === undefined) throw new Error('not connected');
    const grantsBefore = await server.connection.collection('tw_view_as_grants').countDocuments({});
    await db.command({ collMod: 'tw_audit_events', validator: { $expr: { $eq: [1, 0] } } });
    try {
      expect(await errorOf(await start(target.userId))).toEqual({ status: 503, error: 'unavailable' });
    } finally {
      await db.command({ collMod: 'tw_audit_events', validator: {} });
    }
    expect(await server.connection.collection('tw_view_as_grants').countDocuments({})).toBe(grantsBefore);
    expect(await me(staff)).toMatchObject({ access: { state: 'staff' }, viewAs: null });
  });

  it('when the grant cannot be stored, view_as.started is followed by staff_action.not_applied and no grant exists', async () => {
    const target = await signIn(server, uniqueEmail('unstored'));
    const db = server.connection.db;
    if (db === undefined) throw new Error('not connected');
    await db.command({ collMod: 'tw_view_as_grants', validator: { $expr: { $eq: [1, 0] } } });
    try {
      expect(await errorOf(await start(target.userId))).toEqual({ status: 500, error: 'internal' });
    } finally {
      await db.command({ collMod: 'tw_view_as_grants', validator: {} });
    }
    const started = (await auditEvents(server)).find((event) => event.action === 'view_as.started'
      && (event.details as { targetUserId: string }).targetUserId === target.userId);
    const grantId = (started?.target as { id: string }).id;
    expect(await grantDoc(grantId)).toBeNull();
    const events = await eventsOfGrant(grantId);
    expect(events.map((e) => e.action)).toEqual(['view_as.started', 'staff_action.not_applied']);
    expect(events[1]?.details).toEqual({ eventId: String(started?._id), code: 'internal' });
    expect(await me(staff)).toMatchObject({ access: { state: 'staff' }, viewAs: null });
  });

  it('two starts racing on one session leave one live grant, and every grant and every refusal is recorded', async () => {
    // signIn reads the newest captured link, so the targets sign in one at a time; only the starts race.
    const targets: TestSession[] = [];
    for (const name of ['race-1', 'race-2', 'race-3', 'race-4', 'race-5']) targets.push(await signIn(server, uniqueEmail(name)));
    const statuses = (await Promise.all(targets.map((target) => start(target.userId)))).map((res) => res.status);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
    expect(statuses).toContain(201);

    const grants = await server.connection.collection('tw_view_as_grants').find({ actorSessionId: staff.sessionId }).toArray();
    expect(grants.filter((grant) => grant.activeSessionId === staff.sessionId)).toHaveLength(1);
    const events = await auditEvents(server);
    const started = events.filter((event) => event.action === 'view_as.started' && event.actorUserId === staff.userId
      && targets.some((target) => (event.details as { targetUserId: string }).targetUserId === target.userId));
    expect(started).toHaveLength(5);
    const notApplied = new Set(events.filter((event) => event.action === 'staff_action.not_applied')
      .map((event) => (event.details as { eventId: string }).eventId));
    for (const event of started) {
      const grantId = (event.target as { id: string }).id;
      const grant = grants.find((doc) => doc._id.toHexString() === grantId);
      if (grant === undefined) {
        expect(notApplied.has(String(event._id))).toBe(true);
      } else if (grant.activeSessionId === undefined) {
        // Cleared by a later start in the same session: its end is recorded.
        expect((await eventsOfGrant(grantId)).map((e) => e.action)).toEqual(['view_as.started', 'view_as.ended']);
      }
    }
  });

  it('the 21st start in an hour is 429, and nothing is written', async () => {
    const target = await signIn(server, uniqueEmail('limited'));
    await server.redis.set(limiterKey('townwise:view-as', staff.userId), '20', 'EX', 3600);
    const before = await snapshot();
    expect(await errorOf(await start(target.userId))).toEqual({ status: 429, error: 'rate_limited' });
    expect(await snapshot()).toBe(before);
  });
});

describe('under a grant made by POST /api/admin/view-as', () => {
  it('every write is refused, every staff route answers 409 view_as_active, reads show the target’s data, and nothing changes', async () => {
    const target = await orgAdmin('readonly');
    const locationId = await addLocation(server, { orgId: target.orgId, name: 'Readonly Room' });
    await addSalesDay(server, { orgId: target.orgId, locationId, date: '2026-05-01', guests: 90, netSalesCents: 210_000 });
    const noteId = await addNote(server, { orgId: target.orgId, locationId, detail: 'Readonly note', createdBy: target.session.userId });
    expect((await start(target.session.userId)).status).toBe(201);
    // Ids from the target's own organization, so a write would have something real to change.
    const ids: Record<string, string> = { memberId: target.inviteId, orgId: target.orgId, locationId, noteId };
    const pathOf = (path: string): string => `/api${path.replace(/:([A-Za-z]+)/g, (_m, name: string) => ids[name] ?? new Types.ObjectId().toHexString())}`;
    const before = await snapshot();
    for (const route of TOWNWISE_ROUTES) {
      if (route.policy === 'staff_self') continue;
      if (route.method === 'GET' && route.policy !== 'staff') continue;
      const res = await call(server, pathOf(route.path), {
        method: route.method, session: staff,
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: { emails: ['new@example.test'], role: 'member', inviteId: target.inviteId } }),
      });
      const expected = route.policy === 'staff' ? { status: 409, error: 'view_as_active' } : { status: 403, error: 'view_as_read_only' };
      expect({ route: route.id, ...(await errorOf(res)) }).toEqual({ route: route.id, ...expected });
    }
    const team = await call(server, '/api/org/members', { session: staff });
    expect(team.status).toBe(200);
    expect((await team.json() as { members: { id: string }[] }).members.map((member) => member.id)).toContain(target.inviteId);
    const notes = await call(server, `/api/org/locations/${locationId}/notes`, { session: staff });
    expect((await notes.json() as { notes: { id: string }[] }).notes.map((note) => note.id)).toEqual([noteId]);
    expect(await snapshot()).toBe(before);
  });
});

describe('POST /api/admin/view-as/end', () => {
  it('ends the grant and records it; the next GET /api/me is staff with no view-as; a second End changes nothing', async () => {
    const target = await orgAdmin('ender');
    const started = await (await start(target.session.userId)).json() as MeResponse;
    const grantId = started.viewAs?.id ?? '';
    server.clock.advance(MINUTE);

    const res = await end();
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body).toMatchObject({ user: { id: staff.userId }, access: { state: 'staff' }, viewAs: null });
    expect(await me(staff)).toEqual(body);
    const grant = await grantDoc(grantId);
    expect(grant).toMatchObject({ endedAt: server.clock.now(), endReason: 'ended' });
    expect(grant).not.toHaveProperty('activeSessionId');
    const events = await eventsOfGrant(grantId);
    expect(events.map((event) => event.action)).toEqual(['view_as.started', 'view_as.ended']);
    expect(events[1]).toMatchObject({ actorUserId: staff.userId, actorRole: 'superadmin', viewAsGrantId: grantId, details: { endReason: 'ended' } });
    expect(String(events[1]?.orgId)).toBe(target.orgId);

    const again = await end();
    expect(again.status).toBe(200);
    expect(await eventsOfGrant(grantId)).toHaveLength(2);

    // The audit log shows both, labelled with the person viewed.
    const audit = await (await call(server, `/api/admin/audit?orgId=${target.orgId}`, { session: staff })).json() as { events: AuditEventView[] };
    expect(audit.events.slice(0, 2).map((event) => [event.summary, event.viewAs])).toEqual([
      ['Ended view-as', { targetEmail: target.email }],
      [`Viewed as ${target.email}`, { targetEmail: target.email }],
    ]);
  });

  it('with a staff session past 60 minutes answers 403 staff_reauth_required', async () => {
    const target = await orgAdmin('stale');
    expect((await start(target.session.userId)).status).toBe(201);
    server.clock.advance(61 * MINUTE);
    await refresh(server, staff);
    expect(await errorOf(await end())).toEqual({ status: 403, error: 'staff_reauth_required' });
  });

  it('is refused to anyone who is not staff', async () => {
    const target = await orgAdmin('not-staff');
    expect(await errorOf(await end(target.session))).toEqual({ status: 403, error: 'forbidden' });
  });
});

describe('a grant that is no longer live', () => {
  it('after expiring without End, does not block a new Start on the same session, and its end is recorded as expired', async () => {
    const first = await orgAdmin('expires');
    const firstGrant = (await (await start(first.session.userId)).json() as MeResponse).viewAs?.id ?? '';
    server.clock.advance(31 * MINUTE);
    await refresh(server, staff);
    expect(await me(staff)).toMatchObject({ access: { state: 'staff' }, viewAs: null });

    const second = await orgAdmin('after-expiry');
    const res = await start(second.session.userId);
    expect(res.status).toBe(201);
    expect((await res.json() as MeResponse).viewAs?.target.userId).toBe(second.session.userId);
    expect(await grantDoc(firstGrant)).toMatchObject({ endReason: 'expired' });
    expect((await eventsOfGrant(firstGrant)).map((event) => [event.action, (event.details as { endReason?: string }).endReason]))
      .toEqual([['view_as.started', undefined], ['view_as.ended', 'expired']]);
  });

  it('once the target changes organization, view-as ends at once, and a new Start replaces the old grant', async () => {
    const email = uniqueEmail('mover');
    const target = await signIn(server, email);
    const oldGrant = (await (await start(target.userId)).json() as MeResponse).viewAs?.id ?? '';
    const orgId = await createOrg(server, { name: 'Joined Org' });
    await addSeat(server, { orgId, userId: target.userId, email });
    expect(await me(staff)).toMatchObject({ access: { state: 'staff' }, viewAs: null });

    const res = await start(target.userId);
    expect(res.status).toBe(201);
    const body = await res.json() as MeResponse;
    expect(body.viewAs?.org).toEqual({ id: orgId, name: 'Joined Org' });
    expect(await grantDoc(oldGrant)).toMatchObject({ endReason: 'replaced' });
    expect(String((await eventsOfGrant(body.viewAs?.id ?? ''))[0]?.orgId)).toBe(orgId);
  });
});

describe('the record', () => {
  it('every grant made in this file has its view_as.started event, written at its start', async () => {
    const grants = await server.connection.collection('tw_view_as_grants').find({}).toArray();
    expect(grants.length).toBeGreaterThan(5);
    const started = new Map((await auditEvents(server))
      .filter((event) => event.action === 'view_as.started')
      .map((event) => [(event.target as { id: string }).id, event]));
    for (const grant of grants) {
      const event = started.get(grant._id.toHexString());
      expect(event?.at).toEqual(grant.startedAt);
      expect((event?.details as { targetUserId: string }).targetUserId).toBe(grant.targetUserId);
    }
  });

  it('logs no reason and no email while viewing as', async () => {
    const target = await orgAdmin('quiet');
    server.logs.length = 0;
    expect((await start(target.session.userId, 'Sentinel reason for this view')).status).toBe(201);
    expect((await call(server, '/api/org/members', { session: staff })).status).toBe(200);
    expect((await end()).status).toBe(200);
    const logs = server.logs.join('\n');
    expect(logs).toContain('townwise.view_as_read');
    expect(logs).not.toContain('Sentinel reason');
    expect(logs).not.toContain(target.email);
  });
});
