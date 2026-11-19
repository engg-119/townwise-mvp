// Staff approve and reject access requests (spec F3, F4, 9.3, 10.7).
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminRequestView } from '../src/handlers/admin.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import { addRequest, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { createCapturingTransport } from './helpers/mail.ts';
import {
  call, logLines, MAIL_REPLY_TO, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;
const mail = createCapturingTransport();

beforeAll(async () => { server = await startTownwiseServer({ mailTransport: mail }); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.mailer.idle();
  mail.sent.length = 0;
  staff = await signInStaff(server);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

const REQUEST = {
  orgName: 'Harbor Kitchen Group', contactName: 'Pat Sample', contactRole: 'General manager',
  town: { townId: 'bar-harbor-me' }, locationCount: 3, note: 'Sentinel request note',
};

const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };

/** Three checked places, one outside the twelve towns; the Google names are not the location names staff choose. */
const PLACES3 = [
  { placeId: 'ChIJTestPlace0001', name: 'Lou’s Restaurant', town: { townId: 'hanover-nh' } },
  { placeId: 'ChIJTestPlace0002', name: 'Lou’s Bakery', town: { townId: null, name: 'Norwich', state: 'VT' } },
  { placeId: 'ChIJTestPlace0003', name: 'Lou’s River Cafe', town: { townId: 'hanover-nh' } },
];
const NAMES3 = ['Main Street', 'Elm Street', 'River Road'];

interface Requester { email: string; session: TestSession; requestId: string }

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

/** A person who signed in and sent a request through the API. */
async function requester(name: string, places?: readonly unknown[]): Promise<Requester> {
  const email = uniqueEmail(name);
  const session = await signIn(server, email);
  const res = await call(server, '/api/access-requests', { session, json: places === undefined ? REQUEST : { ...REQUEST, places } });
  expect(res.status).toBe(201);
  const body = await res.json() as MeResponse;
  return { email, session, requestId: body.access.state === 'pending' ? body.access.request.id : '' };
}

/** A pending request stored the old way, with a single placeId and no places. */
async function storedBeforePlaces(name: string, placeId: string): Promise<Requester> {
  const email = uniqueEmail(name);
  const session = await signIn(server, email);
  const requestId = await addRequest(server, { userId: session.userId, email, status: 'pending', placeId });
  return { email, session, requestId };
}

function approve(requestId: string, body: unknown = { orgName: 'Harbor Kitchen', locationName: 'Main Street' }, session = staff): Promise<Response> {
  return call(server, `/api/admin/requests/${requestId}/approve`, { session, json: body });
}

function reject(requestId: string, body: unknown = {}, session = staff): Promise<Response> {
  return call(server, `/api/admin/requests/${requestId}/reject`, { session, json: body });
}

const APPROVED_SUBJECT = 'You’re in: welcome to Townwise';

/** The “You’re in” emails sent so far to `to` (every requester also got “request received”). */
async function approvedTo(to: string): Promise<{ to: string; text: string }[]> {
  await server.mailer.idle();
  return mail.sent.filter((message) => message.subject === APPROVED_SUBJECT && message.to === to);
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

async function requestDoc(requestId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_access_requests').findOne({ _id: new Types.ObjectId(requestId) });
}

/** Every event about this request, or in the organization it became. */
async function eventsAbout(requestId: string, orgId: string | null): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) =>
    (event.target as { id: string }).id === requestId || (orgId !== null && String(event.orgId) === orgId));
}

/** The organization's locations, oldest first. */
async function locationsOf(orgId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_locations').find({ orgId: new Types.ObjectId(orgId) }).sort({ createdAt: 1, _id: 1 }).toArray();
}

async function tenantCounts(requestId: string): Promise<{ orgs: number; locations: number; seats: number }> {
  const orgs = await server.connection.collection('tw_orgs').find({ fromRequestId: new Types.ObjectId(requestId) }).toArray();
  const orgIds = orgs.map((org) => org._id);
  return {
    orgs: orgs.length,
    locations: await server.connection.collection('tw_locations').countDocuments({ orgId: { $in: orgIds } }),
    seats: await server.connection.collection('tw_members').countDocuments({ orgId: { $in: orgIds } }),
  };
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

describe('GET /api/admin/requests', () => {
  it('lists pending requests oldest first, with the requester’s current email, a seat warning and the pending count', async () => {
    await server.connection.collection('tw_access_requests').deleteMany({});
    const first = await requester('first');
    server.clock.advance(1000);
    const second = await requester('second');
    const orgId = await createOrg(server, { name: 'Elsewhere Org' });
    await addSeat(server, { orgId, userId: second.session.userId, email: second.email });
    const decided = await requester('decided');
    await server.connection.collection('tw_access_requests').updateOne(
      { _id: new Types.ObjectId(decided.requestId) },
      { $set: { status: 'rejected', decidedAt: server.clock.now(), decidedBy: staff.userId, decisionMessage: 'Sentinel decision' } },
    );

    const res = await call(server, '/api/admin/requests', { session: staff });
    expect(res.status).toBe(200);
    const body = await res.json() as { requests: AdminRequestView[]; pendingCount: number };
    expect(body.pendingCount).toBe(2);
    expect(body.requests.map((r) => r.id)).toEqual([first.requestId, second.requestId]);
    expect(body.requests[0]).toEqual({
      id: first.requestId, orgName: REQUEST.orgName, contactName: REQUEST.contactName, contactRole: REQUEST.contactRole,
      town: { townId: 'bar-harbor-me', name: 'Bar Harbor', state: 'ME' }, locationCount: 3, note: REQUEST.note,
      status: 'pending', createdAt: expect.any(String) as string, decidedAt: null, decisionMessage: null,
      requester: { userId: first.session.userId, email: first.email }, emailAtRequest: first.email,
      requesterHasOrg: false, decidedBy: null, orgId: null, places: [],
    });
    expect(body.requests[1]?.requesterHasOrg).toBe(true);

    const rejected = await (await call(server, '/api/admin/requests?status=rejected', { session: staff })).json() as { requests: AdminRequestView[] };
    expect(rejected.requests).toHaveLength(1);
    expect(rejected.requests[0]).toMatchObject({ id: decided.requestId, decidedBy: { email: STAFF_EMAIL }, decisionMessage: 'Sentinel decision' });
    expect(await errorOf(await call(server, '/api/admin/requests?status=everything', { session: staff }))).toEqual({ status: 400, error: 'invalid_request' });
  });

  it('the admin request list carries each place’s kind', async () => {
    await server.connection.collection('tw_access_requests').deleteMany({});
    const placed = await requester('kinds', [PLACES3[0], { ...PLACES3[1], kind: 'address' }, { ...PLACES3[2], kind: 'business' }]);
    const body = await (await call(server, '/api/admin/requests', { session: staff })).json() as { requests: AdminRequestView[] };
    expect(body.requests.map((r) => r.id)).toEqual([placed.requestId]);
    expect(body.requests[0]?.places.map(({ placeId, kind }) => ({ placeId, kind }))).toEqual([
      { placeId: 'ChIJTestPlace0001', kind: 'business' },
      { placeId: 'ChIJTestPlace0002', kind: 'address' },
      { placeId: 'ChIJTestPlace0003', kind: 'business' },
    ]);
  });
});

describe('POST /api/admin/requests/:requestId/approve (F3)', () => {
  it('creates the organization, its first location in the request’s town and the requester’s admin seat; the requester is a member next', async () => {
    const person = await requester('owner');
    const res = await approve(person.requestId, { orgName: '  Harbor Kitchen ', locationName: ' Main  Street ' });
    expect(res.status).toBe(200);
    const body = await res.json() as { org: { id: string; name: string }; request: AdminRequestView };
    const orgId = body.org.id;
    expect(body.org).toEqual({ id: orgId, name: 'Harbor Kitchen' });
    expect(body.request).toMatchObject({
      id: person.requestId, status: 'approved', orgId, decidedAt: server.clock.now().toISOString(),
      decidedBy: { email: STAFF_EMAIL }, requesterHasOrg: true,
    });

    const oid = new Types.ObjectId(orgId);
    expect(await server.connection.collection('tw_orgs').findOne({ _id: oid })).toMatchObject({
      name: 'Harbor Kitchen', status: 'active', createdAt: server.clock.now(), createdBy: staff.userId,
      fromRequestId: new Types.ObjectId(person.requestId), suspendedAt: null,
    });
    const locations = await server.connection.collection('tw_locations').find({ orgId: oid }).toArray();
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      name: 'Main  Street', nameKey: 'main street', town: { townId: 'bar-harbor-me', name: 'Bar Harbor', state: 'ME' },
      createdAt: server.clock.now(), createdBy: staff.userId, placeId: null,
    });
    const seats = await server.connection.collection('tw_members').find({ orgId: oid }).toArray();
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({
      email: person.email, role: 'org_admin', status: 'active', userId: person.session.userId,
      activeUserId: person.session.userId, joinedAt: server.clock.now(), invitedBy: staff.userId, addedByStaff: false,
    });
    expect(seats[0]).not.toHaveProperty('inviteEmail');
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'approved', orgId: oid, decidedBy: staff.userId });

    expect((await me(person.session)).access).toEqual({ state: 'member', org: { id: orgId, name: 'Harbor Kitchen' }, role: 'org_admin' });

    const events = await eventsAbout(person.requestId, orgId);
    expect(events.map((e) => e.action)).toEqual([
      'access_request.created', 'access_request.approved', 'org.created', 'location.created', 'member.joined',
    ]);
    for (const event of events.slice(1)) {
      expect(event).toMatchObject({ actorUserId: staff.userId, actorEmail: STAFF_EMAIL, actorRole: 'superadmin', orgId: oid });
    }
    expect(events.slice(1).map((e) => e.details)).toEqual([
      { orgId },
      { name: 'Harbor Kitchen', via: 'request' },
      { name: 'Main  Street', townId: 'bar-harbor-me' },
      { email: person.email, role: 'org_admin' },
    ]);
  });

  it('a request stored before places approves with one location name and gives the location its place id', async () => {
    const placeId = 'ChIJTestPlace0002';
    const placed = await storedBeforePlaces('placed', placeId);
    const oldPlaces = [{ placeId, name: null, kind: 'business', town: HANOVER }];
    expect((await me(placed.session)).access).toMatchObject({ state: 'pending', request: { places: oldPlaces } });
    const listed = await (await call(server, '/api/admin/requests', { session: staff })).json() as { requests: AdminRequestView[] };
    expect(listed.requests.find((r) => r.id === placed.requestId)?.places).toEqual(oldPlaces);

    server.logs.length = 0;
    const res = await approve(placed.requestId, { orgName: 'Placed Kitchen', locationNames: ['Main Street'] });
    expect(res.status).toBe(200);
    const body = await res.json() as { org: { id: string }; request: AdminRequestView };
    expect(body.request.places).toEqual(oldPlaces);
    const locations = await locationsOf(body.org.id);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ name: 'Main Street', placeId, town: HANOVER });
    const events = await eventsAbout(placed.requestId, body.org.id);
    expect(JSON.stringify(events)).not.toContain(placeId);
    expect(server.logs.join('\n')).not.toContain(placeId);

    // A retry of a half-finished approval skips a place that already has its location, so that location keeps
    // the name and place it was inserted with.
    const halfPlaceId = 'ChIJTestPlace0003';
    const half = await storedBeforePlaces('halfplace', halfPlaceId);
    const halfOrg = new Types.ObjectId();
    await server.connection.collection('tw_access_requests').updateOne(
      { _id: new Types.ObjectId(half.requestId) },
      { $set: { status: 'approved', orgId: halfOrg, decidedAt: server.clock.now(), decidedBy: staff.userId } },
    );
    await server.connection.collection('tw_orgs').insertOne({
      _id: halfOrg, name: 'Half Place', status: 'active', createdAt: server.clock.now(), createdBy: staff.userId,
      fromRequestId: new Types.ObjectId(half.requestId), suspendedAt: null,
    });
    await server.connection.collection('tw_locations').insertOne({
      orgId: halfOrg, name: 'Main Street', nameKey: 'main street', town: { townId: 'bar-harbor-me', name: 'Bar Harbor', state: 'ME' },
      createdAt: server.clock.now(), createdBy: staff.userId, placeId: halfPlaceId,
    });
    expect((await approve(half.requestId, { orgName: 'Half Place', locationNames: ['Renamed'] })).status).toBe(200);
    expect(await locationsOf(halfOrg.toHexString())).toMatchObject([{ name: 'Main Street', placeId: halfPlaceId }]);

    const plain = await requester('plain');
    const plainBody = await (await approve(plain.requestId)).json() as { org: { id: string } };
    expect(await locationsOf(plainBody.org.id)).toMatchObject([{ placeId: null }]);
  });

  it('a request with places becomes one location per place, each with its name, town and place id, and a location.created each', async () => {
    const person = await requester('places', PLACES3);
    server.logs.length = 0;
    const res = await approve(person.requestId, { orgName: 'Harbor Kitchen', locationNames: NAMES3 });
    expect(res.status).toBe(200);
    const orgId = (await res.json() as { org: { id: string } }).org.id;
    expect(await locationsOf(orgId)).toMatchObject([
      { name: 'Main Street', nameKey: 'main street', placeId: 'ChIJTestPlace0001', town: HANOVER },
      { name: 'Elm Street', nameKey: 'elm street', placeId: 'ChIJTestPlace0002', town: { townId: null, name: 'Norwich', state: 'VT' } },
      { name: 'River Road', nameKey: 'river road', placeId: 'ChIJTestPlace0003', town: HANOVER },
    ]);
    const events = await eventsAbout(person.requestId, orgId);
    expect(events.map((e) => e.action)).toEqual([
      'access_request.created', 'access_request.approved', 'org.created', 'location.created', 'location.created', 'location.created', 'member.joined',
    ]);
    expect(events.filter((e) => e.action === 'location.created').map((e) => e.details)).toEqual([
      { name: 'Main Street', townId: 'hanover-nh' }, { name: 'Elm Street', townId: null }, { name: 'River Road', townId: 'hanover-nh' },
    ]);
    for (const secret of PLACES3.flatMap((place) => [place.placeId, place.name])) {
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(server.logs.join('\n')).not.toContain(secret);
    }
  });

  it('with places the body needs locationNames matching them: 400 invalid_request and nothing written', async () => {
    const before = (await auditEvents(server)).length;
    const placed = await requester('names', PLACES3);
    const plain = await requester('names-plain');
    for (const body of [
      { orgName: 'Harbor Kitchen', locationName: 'Main' },   // a console from before places
      { orgName: 'Harbor Kitchen', locationNames: ['Main Street', 'Elm Street'] },
      { orgName: 'Harbor Kitchen', locationNames: ['Main Street', ' main street ', 'Elm'] },
      { orgName: 'Harbor Kitchen', locationNames: ['Main Street', 'Main  Street', 'Elm'] },
      { orgName: 'Harbor Kitchen', locationNames: ['Main', '', 'Elm'] },
      { orgName: 'Harbor Kitchen', locationNames: ['Main', 'x'.repeat(81), 'Elm'] },
      { orgName: 'Harbor Kitchen', locationName: 'Main', locationNames: NAMES3 },
    ]) {
      expect(await errorOf(await approve(placed.requestId, body))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await errorOf(await approve(plain.requestId, { orgName: 'Harbor Kitchen', locationNames: ['Main'] })))
      .toEqual({ status: 400, error: 'invalid_request' });
    for (const { requestId } of [placed, plain]) {
      expect(await requestDoc(requestId)).toMatchObject({ status: 'pending', orgId: null });
      expect(await tenantCounts(requestId)).toEqual({ orgs: 0, locations: 0, seats: 0 });
    }
    expect((await auditEvents(server)).length).toBe(before + 2);   // only their access_request.created
  });

  it('a retry after a stop partway through the places creates only the missing ones, whatever names it sends', async () => {
    const person = await requester('stopped', PLACES3);
    const model = server.connection.models.TwLocation as unknown as { updateOne: (...args: unknown[]) => Promise<unknown> };
    const updateOne = model.updateOne.bind(model);
    let calls = 0;
    // The first place's location is written; the approval stops at the second.
    const spy = vi.spyOn(model, 'updateOne').mockImplementation((...args: unknown[]) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('stopped')) : updateOne(...args);
    });
    let res: Response;
    try {
      res = await approve(person.requestId, { orgName: 'Harbor Kitchen', locationNames: NAMES3 });
    } finally {
      spy.mockRestore();
    }
    expect(await errorOf(res)).toEqual({ status: 500, error: 'internal' });
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 0 });

    const retry = await approve(person.requestId, { orgName: 'Harbor Kitchen', locationNames: ['Renamed', 'Elm Street', 'River Road'] });
    expect(retry.status).toBe(200);
    const orgId = (await retry.json() as { org: { id: string } }).org.id;
    expect(await locationsOf(orgId)).toMatchObject([
      { name: 'Main Street', placeId: 'ChIJTestPlace0001' },
      { name: 'Elm Street', placeId: 'ChIJTestPlace0002' },
      { name: 'River Road', placeId: 'ChIJTestPlace0003' },
    ]);
    const events = await eventsAbout(person.requestId, orgId);
    expect(events.filter((e) => e.action === 'location.created')).toHaveLength(3);
    expect(events.filter((e) => e.action === 'member.joined')).toHaveLength(1);
  });

  it('a retry name on another place’s location is 409 location_name_taken, never a merge', async () => {
    const person = await requester('taken', PLACES3);
    const orgId = new Types.ObjectId();
    await server.connection.collection('tw_access_requests').updateOne(
      { _id: new Types.ObjectId(person.requestId) },
      { $set: { status: 'approved', orgId, decidedAt: server.clock.now(), decidedBy: staff.userId } },
    );
    await server.connection.collection('tw_orgs').insertOne({
      _id: orgId, name: 'Taken Kitchen', status: 'active', createdAt: server.clock.now(), createdBy: staff.userId,
      fromRequestId: new Types.ObjectId(person.requestId), suspendedAt: null,
    });
    await server.connection.collection('tw_locations').insertOne({
      orgId, name: 'Main Street', nameKey: 'main street', town: HANOVER,
      createdAt: server.clock.now(), createdBy: staff.userId, placeId: 'ChIJTestPlace0001',
    });
    server.clock.advance(1000);   // the retry's locations sort after it

    const taken = { orgName: 'Taken Kitchen', locationNames: ['Anything', 'Main Street', 'River Road'] };
    expect(await errorOf(await approve(person.requestId, taken))).toEqual({ status: 409, error: 'location_name_taken' });
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 0 });

    const fixed = { orgName: 'Taken Kitchen', locationNames: ['Anything', 'Elm Street', 'River Road'] };
    expect((await approve(person.requestId, fixed)).status).toBe(200);
    expect(await locationsOf(orgId.toHexString())).toMatchObject([
      { name: 'Main Street', placeId: 'ChIJTestPlace0001' },
      { name: 'Elm Street', placeId: 'ChIJTestPlace0002' },
      { name: 'River Road', placeId: 'ChIJTestPlace0003' },
    ]);
  });

  it('a retry never adds a location once someone has joined, even after one of its locations is deleted', async () => {
    const person = await requester('joined', PLACES3.slice(0, 2));
    const body = { orgName: 'Joined Kitchen', locationNames: ['Main Street', 'Elm Street'] };
    const res = await approve(person.requestId, body);
    expect(res.status).toBe(200);
    const orgId = (await res.json() as { org: { id: string } }).org.id;
    await server.connection.collection('tw_locations').deleteOne({ orgId: new Types.ObjectId(orgId), placeId: 'ChIJTestPlace0002' });
    expect((await approve(person.requestId, body)).status).toBe(200);
    expect(await locationsOf(orgId)).toMatchObject([{ name: 'Main Street', placeId: 'ChIJTestPlace0001' }]);

    // Nor once the person who joined has left, on an organization with no firstJoinedAt (as one approved before D23):
    // only the removed seat's joinedAt holds the retry.
    const orgFilter = { _id: new Types.ObjectId(orgId) };
    await server.connection.collection('tw_members').updateOne(
      { orgId: new Types.ObjectId(orgId), userId: person.session.userId },
      { $set: { status: 'removed', removedAt: server.clock.now(), removedBy: 'f'.repeat(24) }, $unset: { activeUserId: '' } },
    );
    await server.connection.collection('tw_orgs').updateOne(orgFilter, { $unset: { firstJoinedAt: '' } });
    expect((await approve(person.requestId, body)).status).toBe(200);
    expect(await locationsOf(orgId)).toHaveLength(1);

    // Nor once no member row records the join: the organization's firstJoinedAt outlives them (D23).
    await server.connection.collection('tw_orgs').updateOne(orgFilter, { $set: { firstJoinedAt: server.clock.now() } });
    await server.connection.collection('tw_members').deleteMany({ orgId: new Types.ObjectId(orgId) });
    expect((await approve(person.requestId, body)).status).toBe(200);
    expect(await locationsOf(orgId)).toHaveLength(1);
    expect((await eventsAbout(person.requestId, orgId)).filter((e) => e.action === 'location.created')).toHaveLength(2);
  });

  it('concurrent approvals of a request with places make one organization with one location per place', async () => {
    const person = await requester('race-places', PLACES3.slice(0, 2));
    const body = { orgName: 'Race Kitchen', locationNames: ['Main Street', 'Elm Street'] };
    const results = await Promise.all(Array.from({ length: 5 }, () => approve(person.requestId, body)));
    const ok = results.filter((res) => res.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const res of results.filter((r) => r.status !== 200)) {
      expect([{ status: 409, error: 'request_not_pending' }, { status: 409, error: 'requester_has_org' }]).toContainEqual(await errorOf(res));
    }
    const orgIds = new Set(await Promise.all(ok.map(async (res) => (await res.json() as { org: { id: string } }).org.id)));
    expect(orgIds.size).toBe(1);
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 2, seats: 1 });
    expect((await eventsAbout(person.requestId, [...orgIds][0] ?? null)).filter((e) => e.action === 'location.created')).toHaveLength(2);
  });

  it('answers 409 request_not_pending for a decided request, 404 for an unknown one, 400 for bad input, and writes nothing', async () => {
    const person = await requester('decided');
    expect((await reject(person.requestId)).status).toBe(200);
    const before = (await auditEvents(server)).length;
    expect(await errorOf(await approve(person.requestId))).toEqual({ status: 409, error: 'request_not_pending' });
    expect(await errorOf(await approve(new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await approve('not-an-id'))).toEqual({ status: 400, error: 'invalid_request' });
    const fresh = await requester('fresh');
    const afterFresh = (await auditEvents(server)).length;
    for (const body of [{}, { orgName: 'H', locationName: 'Main' }, { orgName: 'Harbor', locationName: '' }, { orgName: 'Harbor', locationName: 'x'.repeat(81) }]) {
      expect(await errorOf(await approve(fresh.requestId, body))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect((await auditEvents(server)).length).toBe(afterFresh);
    expect(afterFresh).toBe(before + 1);   // only fresh's access_request.created
    expect(await requestDoc(fresh.requestId)).toMatchObject({ status: 'pending' });
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 0, locations: 0, seats: 0 });
  });

  it('a requester who already holds a seat is 409 requester_has_org, and nothing is written', async () => {
    const person = await requester('seated');
    const orgId = await createOrg(server, { name: 'Already Org' });
    await addSeat(server, { orgId, userId: person.session.userId, email: person.email });
    const before = (await auditEvents(server)).length;
    expect(await errorOf(await approve(person.requestId))).toEqual({ status: 409, error: 'requester_has_org' });
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'pending', orgId: null });
    expect((await auditEvents(server)).length).toBe(before);
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 0, locations: 0, seats: 0 });
  });

  it('a retry completes an approval that stopped after the request was marked, with no second approval event', async () => {
    const person = await requester('retry');
    const orgId = new Types.ObjectId();
    await server.connection.collection('tw_access_requests').updateOne(
      { _id: new Types.ObjectId(person.requestId) },
      { $set: { status: 'approved', orgId, decidedAt: server.clock.now(), decidedBy: staff.userId } },
    );
    const retryBody = { orgName: 'Retry Kitchen', locationName: 'Retry Street' };
    const res = await approve(person.requestId, retryBody);
    expect(res.status).toBe(200);
    expect((await res.json() as { org: { id: string } }).org.id).toBe(orgId.toHexString());
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 1 });
    expect((await eventsAbout(person.requestId, orgId.toHexString())).map((e) => e.action))
      .toEqual(['access_request.created', 'org.created', 'location.created', 'member.joined']);

    // Again: nothing new, and a seat the organization later removed is never put back.
    await server.connection.collection('tw_members').updateOne(
      { orgId, userId: person.session.userId },
      { $set: { status: 'removed', removedAt: server.clock.now(), removedBy: 'f'.repeat(24) }, $unset: { activeUserId: '' } },
    );
    expect((await approve(person.requestId, retryBody)).status).toBe(200);
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 1 });
    expect(await server.connection.collection('tw_members').findOne({ orgId, userId: person.session.userId })).toMatchObject({ status: 'removed' });
    expect((await eventsAbout(person.requestId, orgId.toHexString())).filter((e) => e.action === 'member.joined')).toHaveLength(1);
  });

  it('a retry after a stop between the organization and its first location adds that location and the seat', async () => {
    const person = await requester('half');
    const orgId = new Types.ObjectId();
    await server.connection.collection('tw_access_requests').updateOne(
      { _id: new Types.ObjectId(person.requestId) },
      { $set: { status: 'approved', orgId, decidedAt: server.clock.now(), decidedBy: staff.userId } },
    );
    await server.connection.collection('tw_orgs').insertOne({
      _id: orgId, name: 'Half Kitchen', status: 'active', createdAt: server.clock.now(), createdBy: staff.userId,
      fromRequestId: new Types.ObjectId(person.requestId), suspendedAt: null,
    });
    expect((await approve(person.requestId, { orgName: 'Half Kitchen', locationName: 'Main Street' })).status).toBe(200);
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 1 });
    expect((await eventsAbout(person.requestId, orgId.toHexString())).map((e) => e.action))
      .toEqual(['access_request.created', 'location.created', 'member.joined']);
  });

  it('a retry never adds a location to an organization in use, whatever name it sends, even after its only location is deleted', async () => {
    const person = await requester('replay');
    const res = await approve(person.requestId);
    expect(res.status).toBe(200);
    const orgId = (await res.json() as { org: { id: string } }).org.id;
    const replay = { orgName: 'Replay Kitchen', locationName: 'Second Street' };
    expect((await approve(person.requestId, replay)).status).toBe(200);
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 1 });

    // An org admin may delete the only location (P16); a retry still adds none.
    await server.connection.collection('tw_locations').deleteMany({ orgId: new Types.ObjectId(orgId) });
    expect((await approve(person.requestId, replay)).status).toBe(200);
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 0, seats: 1 });
    expect((await eventsAbout(person.requestId, orgId)).filter((e) => e.action === 'location.created')).toHaveLength(1);
  });

  it('an approval racing the requester’s deletion takes back the seat it gave after the deletion’s check, with the organization made for it: 404, not applied', async () => {
    const person = await requester('deleted-midway');
    const model = server.connection.models.TwOrg as unknown as { updateOne: (...args: unknown[]) => Promise<unknown> };
    const updateOne = model.updateOne.bind(model);
    let deleted: Response | undefined;
    // The request is marked approved; before the organization is made, staff delete the requester, start to finish.
    const spy = vi.spyOn(model, 'updateOne').mockImplementationOnce(async (...args: unknown[]) => {
      deleted = await call(server, '/api/admin/people/delete', { session: staff, json: { email: person.email } });
      return updateOne(...args);
    });
    let res: Response;
    try {
      res = await approve(person.requestId);
    } finally {
      spy.mockRestore();
    }
    expect(deleted?.status).toBe(200);
    expect(await errorOf(res)).toEqual({ status: 404, error: 'not_found' });
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 0, locations: 0, seats: 0 });
    expect(await server.connection.collection('tw_members').countDocuments({ userId: person.session.userId })).toBe(0);
    const approved = (await auditEvents(server)).find((event) => event.action === 'access_request.approved'
      && (event.target as { id: string }).id === person.requestId);
    const orgId = (approved?.details as { orgId: string }).orgId;
    expect(await server.connection.collection('tw_locations').countDocuments({ orgId: new Types.ObjectId(orgId) })).toBe(0);
    // No event holds their email, or the organization's or location's name; the approval says it didn't apply.
    const events = await eventsAbout(person.requestId, orgId);
    const text = JSON.stringify(await auditEvents(server));
    expect(text).not.toContain(person.email);
    expect(JSON.stringify(events)).not.toContain('Harbor Kitchen');
    expect(JSON.stringify(events)).not.toContain('Main Street');
    expect(events.map((event) => event.action)).toEqual([
      'access_request.created', 'access_request.approved', 'org.created', 'location.created', 'staff_action.not_applied',
    ]);
    expect(events.at(-1)?.details).toEqual({ eventId: String(approved?._id), code: 'not_found' });
    expect(await approvedTo(person.email)).toEqual([]);
  });

  it('a requester who joined another organization before the seat step is 409 requester_has_org; the organization has no admin', async () => {
    const person = await requester('gap');
    const orgId = new Types.ObjectId();
    await server.connection.collection('tw_access_requests').updateOne(
      { _id: new Types.ObjectId(person.requestId) },
      { $set: { status: 'approved', orgId, decidedAt: server.clock.now(), decidedBy: staff.userId } },
    );
    const elsewhere = await createOrg(server, { name: 'Elsewhere' });
    await addSeat(server, { orgId: elsewhere, userId: person.session.userId, email: person.email });
    expect(await errorOf(await approve(person.requestId))).toEqual({ status: 409, error: 'requester_has_org' });
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 0 });
    expect((await me(person.session)).access).toMatchObject({ state: 'member', org: { id: elsewhere } });
  });

  it('concurrent approvals make one organization; every approval event that lost is followed by staff_action.not_applied', async () => {
    const person = await requester('race');
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => approve(person.requestId, { orgName: `Race Kitchen ${String(i)}`, locationName: 'Main' })));
    const ok = results.filter((res) => res.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // A loser sees the request already decided, or (checking after the winner seated them) the requester's new seat.
    for (const res of results.filter((r) => r.status !== 200)) {
      expect([{ status: 409, error: 'request_not_pending' }, { status: 409, error: 'requester_has_org' }]).toContainEqual(await errorOf(res));
    }
    const orgIds = new Set(await Promise.all(ok.map(async (res) => (await res.json() as { org: { id: string } }).org.id)));
    expect(orgIds.size).toBe(1);
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 1 });

    const events = await auditEvents(server);
    const approvals = events.filter((e) => e.action === 'access_request.approved' && (e.target as { id: string }).id === person.requestId);
    const notApplied = events.filter((e) => e.action === 'staff_action.not_applied' && (e.target as { id: string }).id === person.requestId);
    expect(approvals.length).toBe(1 + notApplied.length);
    const approvalIds = approvals.map((e) => String(e._id));
    for (const event of notApplied) {
      expect(approvalIds).toContain((event.details as { eventId: string }).eventId);
      expect(event.details).toMatchObject({ code: 'request_not_pending' });
    }
    const winner = approvals.find((e) => !notApplied.some((n) => (n.details as { eventId: string }).eventId === String(e._id)));
    expect((winner?.details as { orgId: string }).orgId).toBe([...orgIds][0]);
  });

  it('when the audit write fails, the approval is refused with 503 unavailable and nothing changes', async () => {
    const person = await requester('no-audit');
    const before = (await auditEvents(server)).length;
    server.logs.length = 0;
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await approve(person.requestId))).toEqual({ status: 503, error: 'unavailable' });
      expect(await errorOf(await reject(person.requestId, { message: 'Sentinel decision' }))).toEqual({ status: 503, error: 'unavailable' });
    });
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'pending', orgId: null, decisionMessage: null });
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 0, locations: 0, seats: 0 });
    expect((await auditEvents(server)).length).toBe(before);
    const failures = logLines(server).filter((line) => line.msg === 'townwise.audit_write_failed');
    expect(failures.map((line) => line.action)).toEqual(['access_request.approved', 'access_request.rejected']);
    expect(failures[0]).toMatchObject({ targetId: person.requestId });
    expect(server.logs.join('\n')).not.toContain(person.email);
  });

  it('when marking the request fails, the approval event is followed by staff_action.not_applied and nothing is created', async () => {
    const person = await requester('mark-fails');
    await withWritesFailing('tw_access_requests', async () => {
      expect(await errorOf(await approve(person.requestId))).toEqual({ status: 500, error: 'internal' });
    });
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'pending', orgId: null });
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 0, locations: 0, seats: 0 });
    const events = await eventsAbout(person.requestId, null);
    expect(events.map((e) => e.action)).toEqual(['access_request.created', 'access_request.approved', 'staff_action.not_applied']);
    expect(events[2]?.details).toEqual({ eventId: String(events[1]?._id), code: 'internal' });
  });
});

describe('POST /api/admin/requests/:requestId/reject (F4)', () => {
  it('records the decision and the message; the audit event says only whether there was a message; the requester may ask again', async () => {
    const person = await requester('rejected');
    const res = await reject(person.requestId, { message: '  We only onboard restaurants in the twelve towns for now. ' });
    expect(res.status).toBe(200);
    const body = await res.json() as { request: AdminRequestView };
    expect(body.request).toMatchObject({
      status: 'rejected', decisionMessage: 'We only onboard restaurants in the twelve towns for now.',
      decidedAt: server.clock.now().toISOString(), decidedBy: { email: STAFF_EMAIL }, orgId: null,
    });
    expect((await me(person.session)).access).toMatchObject({
      state: 'rejected', request: { id: person.requestId, decisionMessage: 'We only onboard restaurants in the twelve towns for now.' },
    });
    const events = (await eventsAbout(person.requestId, null)).filter((e) => e.action === 'access_request.rejected');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorRole: 'superadmin', actorUserId: staff.userId, orgId: null, details: { hasMessage: true } });
    expect(JSON.stringify(await auditEvents(server))).not.toContain('twelve towns');

    expect((await call(server, '/api/access-requests', { session: person.session, json: REQUEST })).status).toBe(201);
  });

  it('without a message, or with a blank one, hasMessage is false and no message is stored', async () => {
    const person = await requester('silent');
    expect((await reject(person.requestId, { message: '   ' })).status).toBe(200);
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'rejected', decisionMessage: null });
    const events = (await eventsAbout(person.requestId, null)).filter((e) => e.action === 'access_request.rejected');
    expect(events[0]?.details).toEqual({ hasMessage: false });
  });

  it('a decided request is 409 request_not_pending; a message over 500 characters is 400', async () => {
    const person = await requester('twice');
    expect(await errorOf(await reject(person.requestId, { message: 'm'.repeat(501) }))).toEqual({ status: 400, error: 'invalid_request' });
    expect((await reject(person.requestId)).status).toBe(200);
    expect(await errorOf(await reject(person.requestId))).toEqual({ status: 409, error: 'request_not_pending' });
    expect(await errorOf(await reject(new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
  });

  it('when marking the request fails, the rejection event is followed by staff_action.not_applied and the request stays pending', async () => {
    const person = await requester('reject-fails');
    await withWritesFailing('tw_access_requests', async () => {
      expect(await errorOf(await reject(person.requestId, { message: 'Not in our towns yet' }))).toEqual({ status: 500, error: 'internal' });
    });
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'pending', decisionMessage: null });
    const events = await eventsAbout(person.requestId, null);
    expect(events.map((e) => e.action)).toEqual(['access_request.created', 'access_request.rejected', 'staff_action.not_applied']);
    expect(events[2]?.details).toEqual({ eventId: String(events[1]?._id), code: 'internal' });
  });

  it('approve and reject racing: one wins, and a losing decision event is followed by staff_action.not_applied', async () => {
    for (let round = 0; round < 3; round += 1) {
      const person = await requester(`decide-${String(round)}`);
      const results = await Promise.all([approve(person.requestId), reject(person.requestId)]);
      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      const status = (await requestDoc(person.requestId))?.status;
      expect(['approved', 'rejected']).toContain(status);
      const events = await auditEvents(server);
      const decisions = events.filter((e) => ['access_request.approved', 'access_request.rejected'].includes(String(e.action))
        && (e.target as { id: string }).id === person.requestId);
      const notApplied = events.filter((e) => e.action === 'staff_action.not_applied' && (e.target as { id: string }).id === person.requestId);
      expect(decisions.length).toBe(1 + notApplied.length);
    }
  });
});

describe('roles', () => {
  it('requesters, members and org admins get 403 forbidden on every request route, and nothing changes', async () => {
    const person = await requester('target');
    const orgId = await createOrg(server, { name: 'Client Org' });
    const adminEmail = uniqueEmail('client-admin');
    const admin = await signIn(server, adminEmail);
    await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
    const memberEmail = uniqueEmail('client-member');
    const member = await signIn(server, memberEmail);
    await addSeat(server, { orgId, userId: member.userId, email: memberEmail });

    for (const session of [person.session, admin, member]) {
      expect(await errorOf(await call(server, '/api/admin/requests', { session }))).toEqual({ status: 403, error: 'forbidden' });
      expect(await errorOf(await approve(person.requestId, undefined, session))).toEqual({ status: 403, error: 'forbidden' });
      expect(await errorOf(await reject(person.requestId, undefined, session))).toEqual({ status: 403, error: 'forbidden' });
    }
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'pending' });
  });

  it('staff whose two-step sign-in is not set up get staff_setup_required', async () => {
    const person = await requester('setup');
    await server.authStores.totp.remove(staff.userId);
    const unenrolled = await signIn(server, STAFF_EMAIL);
    expect(await errorOf(await approve(person.requestId, undefined, unenrolled))).toEqual({ status: 403, error: 'staff_setup_required' });
    expect(await requestDoc(person.requestId)).toMatchObject({ status: 'pending' });
  });
});

describe('audit', () => {
  it('every event written here carries only its action’s allowlisted detail keys, and never a note or decision message', async () => {
    const events = await auditEvents(server);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action as AuditAction];
      expect(Object.keys(event.details as object).every((key) => allowed.includes(key))).toBe(true);
    }
    const text = JSON.stringify(events);
    for (const secret of ['Sentinel request note', 'Sentinel decision', 'Pat Sample']) expect(text).not.toContain(secret);
  });
});

describe('email (spec D14)', () => {
  it('an approval sends one “You’re in” to the requester’s current address, with the stored organization name and the town', async () => {
    const person = await requester('mail-approved');
    const renamed = uniqueEmail('mail-renamed');
    expect(await server.authStores.users.updateEmail({ id: person.session.userId, from: person.email, to: renamed })).not.toBeNull();
    server.logs.length = 0;
    const res = await approve(person.requestId, { orgName: 'Harbor Kitchen Co', locationName: 'Sentinel Location' });
    expect(res.status).toBe(200);
    const orgId = (await res.json() as { org: { id: string } }).org.id;
    expect(await approvedTo(person.email)).toEqual([]);
    const sent = await approvedTo(renamed);
    expect(sent).toHaveLength(1);
    expect(mail.sent.find((message) => message.to === renamed)).toMatchObject({ replyTo: MAIL_REPLY_TO });
    expect(sent[0]?.text).toContain('Harbor Kitchen Co in Bar Harbor, ME is set up on Townwise, and you’re its admin.');
    expect(sent[0]?.text).not.toContain('Sentinel Location');
    const logged = logLines(server).filter((line) => line.msg === 'townwise.email_sent');
    expect(logged).toEqual([expect.objectContaining({ kind: 'request_approved', requestId: person.requestId, orgId })]);
    for (const secret of [renamed, person.email, 'Harbor Kitchen Co', 'Bar Harbor']) expect(server.logs.join('\n')).not.toContain(secret);
  });

  it('a retry that completes a stopped approval sends one email over both calls, and a replay sends none', async () => {
    const person = await requester('mail-retry');
    await server.connection.collection('tw_access_requests').updateOne(
      { _id: new Types.ObjectId(person.requestId) },
      { $set: { status: 'approved', orgId: new Types.ObjectId(), decidedAt: server.clock.now(), decidedBy: staff.userId } },
    );
    expect((await approve(person.requestId)).status).toBe(200);
    expect((await approve(person.requestId)).status).toBe(200);
    expect(await approvedTo(person.email)).toHaveLength(1);
  });

  it('409 request_not_pending, 409 requester_has_org and 404 send nothing; concurrent approvals send exactly one', async () => {
    const rejected = await requester('mail-rejected');
    expect((await reject(rejected.requestId, { message: 'Sentinel decision' })).status).toBe(200);
    expect((await approve(rejected.requestId)).status).toBe(409);
    const seated = await requester('mail-seated');
    await addSeat(server, { orgId: await createOrg(server, { name: 'Mail Elsewhere' }), userId: seated.session.userId, email: seated.email });
    expect(await errorOf(await approve(seated.requestId))).toEqual({ status: 409, error: 'requester_has_org' });
    expect((await approve(new Types.ObjectId().toHexString())).status).toBe(404);
    expect(await approvedTo(rejected.email)).toEqual([]);
    expect(await approvedTo(seated.email)).toEqual([]);

    const racer = await requester('mail-race');
    const results = await Promise.all(Array.from({ length: 5 }, () => approve(racer.requestId)));
    expect(results.some((res) => res.status === 200)).toBe(true);
    expect(await approvedTo(racer.email)).toHaveLength(1);
  });

  it('a rejection sends no email (no email reports one), and an approve and reject race mails only an approval that won', async () => {
    const person = await requester('mail-reject');
    mail.sent.length = 0;
    expect((await reject(person.requestId, { message: 'Sentinel decision' })).status).toBe(200);
    await server.mailer.idle();
    expect(mail.sent).toEqual([]);

    for (let round = 0; round < 3; round += 1) {
      const racer = await requester(`mail-decide-${String(round)}`);
      await Promise.all([approve(racer.requestId), reject(racer.requestId)]);
      const status = (await requestDoc(racer.requestId))?.status;
      expect(await approvedTo(racer.email)).toHaveLength(status === 'approved' ? 1 : 0);
    }
  });

  it('a failed send still answers 200 with the requester seated, and logs email_failed without the address', async () => {
    const person = await requester('mail-fails');
    await server.mailer.idle();
    mail.failNext();
    server.logs.length = 0;
    expect((await approve(person.requestId)).status).toBe(200);
    await server.mailer.idle();
    expect(await tenantCounts(person.requestId)).toEqual({ orgs: 1, locations: 1, seats: 1 });
    expect((await me(person.session)).access.state).toBe('member');
    const failed = logLines(server).filter((line) => line.msg === 'townwise.email_failed');
    expect(failed).toEqual([expect.objectContaining({ kind: 'request_approved', requestId: person.requestId, code: 'upstream_status' })]);
    expect(server.logs.join('\n')).not.toContain(person.email);
  });
});
