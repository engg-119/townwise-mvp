// The welcome statement's server side (spec 15.8, 10.1, 10.2, 6.15): who GET /api/me offers it to, POST
// /api/me/welcome, view-as, deletion, and that the name never reaches a log.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { addInvite, addLocation, addSalesDay, addSeat, createOrg } from './helpers/fixtures.ts';
import {
  call, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
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

const CONTACT = 'Pat Sample';
const ORG_NAME = 'Harbor Kitchen';
const REQUEST = {
  orgName: 'Harbor Kitchen Group', contactName: CONTACT, contactRole: 'General manager',
  town: { townId: 'bar-harbor-me' }, locationCount: 1, note: null,
};

interface Owner { email: string; session: TestSession; orgId: string }

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function me(session: TestSession): Promise<MeResponse> {
  const res = await call(server, '/api/me', { session });
  expect(res.status).toBe(200);
  return await res.json() as MeResponse;
}

function recordWelcome(session: TestSession): Promise<Response> {
  return call(server, '/api/me/welcome', { method: 'POST', session });
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function welcomes(filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection('tw_welcomes').countDocuments(filter);
}

/** A person who requested access through the API and was approved by staff: the org admin of a new organization. */
async function approvedOwner(name: string, contactName = CONTACT): Promise<Owner> {
  const email = uniqueEmail(name);
  const session = await signIn(server, email);
  const sent = await call(server, '/api/access-requests', { session, json: { ...REQUEST, contactName } });
  expect(sent.status).toBe(201);
  const sentMe = await sent.json() as MeResponse;
  expect(sentMe.welcome).toBeNull();
  if (sentMe.access.state !== 'pending') throw new Error('expected pending');
  const approved = await call(server, `/api/admin/requests/${sentMe.access.request.id}/approve`, {
    session: staff, json: { orgName: ORG_NAME, locationName: 'Main Street' },
  });
  expect(approved.status).toBe(200);
  const body = await approved.json() as { org: { id: string } };
  return { email, session, orgId: body.org.id };
}

describe('GET /api/me welcome', () => {
  it('the requester’s first GET /api/me after approval carries the welcome with their first name and the organization’s name', async () => {
    const owner = await approvedOwner('owner');
    const body = await me(owner.session);
    expect(body.access).toMatchObject({ state: 'member', role: 'org_admin' });
    expect(body.welcome).toEqual({ firstName: 'Pat', restaurant: ORG_NAME });
    // Reading it again writes nothing and still offers it: only POST /api/me/welcome records it.
    expect((await me(owner.session)).welcome).toEqual({ firstName: 'Pat', restaurant: ORG_NAME });
    expect(await welcomes({ userId: owner.session.userId })).toBe(0);
  });

  it('a contact name with no usable first name gives a welcome without one', async () => {
    const owner = await approvedOwner('honorific', 'Dr. Rivera');
    expect((await me(owner.session)).welcome).toEqual({ firstName: null, restaurant: ORG_NAME });
  });

  it('POST /api/me/welcome answers 204, twice, and GET /api/me then answers welcome null', async () => {
    const owner = await approvedOwner('seen');
    const first = await recordWelcome(owner.session);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');
    const firstSeen = (await server.connection.collection('tw_welcomes').findOne({ userId: owner.session.userId }))?.seenAt as Date;
    server.clock.advance(60_000);
    expect((await recordWelcome(owner.session)).status).toBe(204);
    expect((await me(owner.session)).welcome).toBeNull();
    const rows = await server.connection.collection('tw_welcomes').find({ userId: owner.session.userId }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: new Types.ObjectId(owner.orgId), userId: owner.session.userId, seenAt: firstSeen });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['_id', 'orgId', 'seenAt', 'userId']);
  });

  it('a teammate who joined by invitation never gets a welcome', async () => {
    const owner = await approvedOwner('team-owner');
    const teammateEmail = uniqueEmail('teammate');
    const teammate = await signIn(server, teammateEmail);
    const inviteId = await addInvite(server, { orgId: owner.orgId, email: teammateEmail, invitedBy: owner.session.userId });
    const joined = await call(server, '/api/me/join', { session: teammate, json: { inviteId } });
    expect(joined.status).toBe(200);
    expect((await joined.json() as MeResponse).welcome).toBeNull();
    expect((await me(teammate)).welcome).toBeNull();
    // The requester still has theirs.
    expect((await me(owner.session)).welcome).not.toBeNull();
  });

  it('an organization with a sales day gives no welcome; a day with no value does not count', async () => {
    const owner = await approvedOwner('has-data');
    const locationId = await addLocation(server, { orgId: owner.orgId, name: 'Second Room' });
    await addSalesDay(server, { orgId: owner.orgId, locationId, date: '2026-05-01', guests: null, netSalesCents: null });
    expect((await me(owner.session)).welcome).not.toBeNull();
    await addSalesDay(server, { orgId: owner.orgId, locationId, date: '2026-05-02', guests: 80, netSalesCents: null });
    expect((await me(owner.session)).welcome).toBeNull();
  });

  it('a staff-created organization gives no welcome', async () => {
    const email = uniqueEmail('staff-made');
    const session = await signIn(server, email);
    const orgId = await createOrg(server, { name: 'Staff Made Kitchen' });
    await addSeat(server, { orgId, userId: session.userId, email, role: 'org_admin' });
    expect((await me(session)).welcome).toBeNull();
  });

  it('under view-as GET /api/me answers welcome null and POST /api/me/welcome answers 403 view_as_read_only', async () => {
    const owner = await approvedOwner('viewed');
    const started = await call(server, '/api/admin/view-as', {
      session: staff, json: { userId: owner.session.userId, reason: 'Checking the welcome statement' },
    });
    expect(started.status).toBe(201);
    expect((await started.json() as MeResponse).welcome).toBeNull();
    const viewing = await me(staff);
    expect(viewing.viewAs).not.toBeNull();
    expect(viewing.welcome).toBeNull();
    expect(await errorOf(await recordWelcome(staff))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect(await welcomes({ userId: owner.session.userId })).toBe(0);
    expect((await call(server, '/api/admin/view-as/end', { session: staff, json: {} })).status).toBe(200);
    // Staff never consume the target's welcome.
    expect((await me(owner.session)).welcome).toEqual({ firstName: 'Pat', restaurant: ORG_NAME });
  });

  it('pending and no_org answer welcome null; POST answers 403 no_access', async () => {
    const session = await signIn(server, uniqueEmail('nobody'));
    expect((await me(session)).welcome).toBeNull();
    expect(await errorOf(await recordWelcome(session))).toEqual({ status: 403, error: 'no_access' });
    const sent = await call(server, '/api/access-requests', { session, json: REQUEST });
    expect(sent.status).toBe(201);
    expect((await me(session)).welcome).toBeNull();
    expect(await errorOf(await recordWelcome(session))).toEqual({ status: 403, error: 'no_access' });
    expect(await welcomes({ userId: session.userId })).toBe(0);
  });

  it('join, decline and access-request answers carry welcome null', async () => {
    const orgId = await createOrg(server, { name: 'Invite Kitchen' });
    const email = uniqueEmail('invitee');
    const session = await signIn(server, email);
    const declined = await call(server, '/api/me/decline', {
      session, json: { inviteId: await addInvite(server, { orgId, email, invitedBy: 'fixture' }) },
    });
    expect(declined.status).toBe(200);
    expect((await declined.json() as MeResponse).welcome).toBeNull();
    const joined = await call(server, '/api/me/join', {
      session, json: { inviteId: await addInvite(server, { orgId, email, invitedBy: 'fixture' }) },
    });
    expect(joined.status).toBe(200);
    expect((await joined.json() as MeResponse).welcome).toBeNull();
  });
});

describe('deletion', () => {
  it('deleting the organization deletes its tw_welcomes rows; deleting the person deletes theirs', async () => {
    const owner = await approvedOwner('deleted-org');
    expect((await recordWelcome(owner.session)).status).toBe(204);
    const other = await approvedOwner('kept-org');
    expect((await recordWelcome(other.session)).status).toBe(204);
    const suspended = await call(server, `/api/admin/orgs/${owner.orgId}`, { method: 'PATCH', session: staff, json: { status: 'suspended' } });
    expect(suspended.status).toBe(200);
    expect((await call(server, `/api/admin/orgs/${owner.orgId}`, { method: 'DELETE', session: staff })).status).toBe(200);
    expect(await welcomes({ orgId: new Types.ObjectId(owner.orgId) })).toBe(0);
    expect(await welcomes({ orgId: new Types.ObjectId(other.orgId) })).toBe(1);

    // A person with no seat whose markers remain in organizations they left.
    const email = uniqueEmail('leaver');
    const leaver = await signIn(server, email);
    await server.connection.collection('tw_welcomes').insertMany([
      { orgId: new Types.ObjectId(), userId: leaver.userId, seenAt: server.clock.now() },
      { orgId: new Types.ObjectId(other.orgId), userId: leaver.userId, seenAt: server.clock.now() },
    ]);
    const deleted = await call(server, '/api/admin/people/delete', { session: staff, json: { email } });
    expect(deleted.status).toBe(200);
    expect(await welcomes({ userId: leaver.userId })).toBe(0);
    expect(await welcomes({ userId: other.session.userId })).toBe(1);
  });
});

describe('privacy', () => {
  it('the first name and the organization’s name travel only in the GET /api/me body, never in a log line', async () => {
    server.logs.length = 0;
    const owner = await approvedOwner('quiet', 'Quintessa Sample');
    expect((await me(owner.session)).welcome).toEqual({ firstName: 'Quintessa', restaurant: ORG_NAME });
    expect((await recordWelcome(owner.session)).status).toBe(204);
    const logged = server.logs.join('\n');
    expect(logged).toContain('/api/me/welcome');
    expect(logged).not.toContain('Quintessa');
    expect(logged).not.toContain(ORG_NAME);
    // No audit event names the welcome: it is a display marker.
    const events = await server.connection.collection('tw_audit_events').find({ actorUserId: owner.session.userId }).toArray();
    expect(events.filter((event) => String(event.action).includes('welcome'))).toEqual([]);
  });
});
