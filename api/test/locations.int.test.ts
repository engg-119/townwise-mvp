// The organization and its locations (spec 10.3, 6.4, P9, P10, P16), and the public town profile route.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LocationSummary } from '../src/handlers/locations.ts';
import type { TownProfile } from '../src/handlers/towns.ts';
import {
  addLocation, addNote, addRequest, addSalesDay, addSeat, addUpload, auditEvents, createOrg,
} from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

const NO_SALES = {
  coverage: { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 },
  calibration: { state: 'no_sales_data' },
  notesCount: 0,
  lastUploadAt: null,
};

interface Team { orgId: string; admin: TestSession; adminEmail: string; member: TestSession }

async function team(name: string): Promise<Team> {
  const orgId = await createOrg(server, { name });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  return { orgId, admin, adminEmail, member };
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function create(session: TestSession, body: unknown): Promise<Response> {
  return call(server, '/api/org/locations', { session, json: body });
}

function patch(session: TestSession, locationId: string, body: unknown): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}`, { method: 'PATCH', session, json: body });
}

function remove(session: TestSession, locationId: string): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}`, { method: 'DELETE', session });
}

describe('GET /api/org', () => {
  it('shows the organization, the caller’s role and every location’s summary, oldest first, to members and org admins', async () => {
    const t = await team('Summary Diner');
    const busy = await addLocation(server, { orgId: t.orgId, name: 'Busy Room' });
    server.clock.advance(1000);
    const quiet = await addLocation(server, { orgId: t.orgId, name: 'Quiet Room' });
    await addSalesDay(server, { orgId: t.orgId, locationId: busy, date: '2026-05-01', guests: 80, netSalesCents: null });
    await addSalesDay(server, { orgId: t.orgId, locationId: busy, date: '2026-05-04', guests: null, netSalesCents: 9000 });
    const uploadedAt = server.clock.now();
    await addUpload(server, { orgId: t.orgId, locationId: busy, uploadedAt, status: 'applied' });
    await addNote(server, { orgId: t.orgId, locationId: busy, detail: 'Closed for a private party' });
    const requestId = await addRequest(server, { userId: t.admin.userId, email: t.adminEmail, status: 'approved' });
    await server.connection.collection('tw_access_requests').updateOne({ _id: new Types.ObjectId(requestId) }, { $set: { locationCount: 3 } });
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(t.orgId) }, { $set: { fromRequestId: new Types.ObjectId(requestId) } });

    const town = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
    const expected = {
      org: { id: t.orgId, name: 'Summary Diner' },
      locations: [
        {
          id: busy, name: 'Busy Room', town,
          coverage: { dayCount: 2, guestsDayCount: 1, netSalesDayCount: 1, firstDate: '2026-05-01', lastDate: '2026-05-04', missingDays: 2 },
          calibration: { state: 'not_calibrated', dayCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-04' },
          notesCount: 1, lastUploadAt: uploadedAt.toISOString(),
        },
        { id: quiet, name: 'Quiet Room', town, ...NO_SALES },
      ],
      requestedLocationCount: 3,
    };
    const asAdmin = await call(server, '/api/org', { session: t.admin });
    expect(asAdmin.status).toBe(200);
    expect(await asAdmin.json()).toEqual({ ...expected, role: 'org_admin' });
    expect(await (await call(server, '/api/org', { session: t.member })).json()).toEqual({ ...expected, role: 'member' });
  });

  it('answers requestedLocationCount null for an organization not made from a request, and 403 no_access to someone with no organization', async () => {
    const t = await team('Direct Diner');
    expect(await (await call(server, '/api/org', { session: t.admin })).json()).toMatchObject({ locations: [], requestedLocationCount: null });
    const outsider = await signIn(server, `outside-${randomUUID().slice(0, 8)}@example.test`);
    expect(await errorOf(await call(server, '/api/org', { session: outsider }))).toEqual({ status: 403, error: 'no_access' });
  });
});

describe('POST /api/org/locations', () => {
  it('adds a location in one of the twelve towns or another town; it starts with no sales data, and is audited', async () => {
    const t = await team('Harbor Group');
    const res = await create(t.admin, { name: '  Harbor Room ', town: { townId: 'bar-harbor-me' } });
    expect(res.status).toBe(201);
    const { location } = await res.json() as { location: LocationSummary };
    expect(location).toEqual({ id: location.id, name: 'Harbor Room', town: { townId: 'bar-harbor-me', name: 'Bar Harbor', state: 'ME' }, ...NO_SALES });
    const event = (await auditEvents(server)).find((e) => (e.target as { id: string }).id === location.id);
    expect(event).toMatchObject({ action: 'location.created', actorUserId: t.admin.userId, actorRole: 'org_admin', details: { name: 'Harbor Room', townId: 'bar-harbor-me' } });
    expect(String(event?.orgId)).toBe(t.orgId);
    expect(await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(location.id) })).toMatchObject({ placeId: null });
    expect(location).not.toHaveProperty('placeId');

    const elsewhere = await create(t.admin, { name: 'Coast Room', town: { townId: null, name: ' Kennebunkport ', state: 'ME' } });
    expect(elsewhere.status).toBe(201);
    expect((await elsewhere.json() as { location: LocationSummary }).location.town).toEqual({ townId: null, name: 'Kennebunkport', state: 'ME' });
  });

  it('refuses a name the organization already uses, ignoring case and spacing; another organization may use it', async () => {
    const t = await team('Name Group');
    expect((await create(t.admin, { name: 'Main  Street', town: { townId: 'stowe-vt' } })).status).toBe(201);
    expect(await errorOf(await create(t.admin, { name: ' main street ', town: { townId: 'stowe-vt' } }))).toEqual({ status: 409, error: 'location_name_taken' });
    const other = await team('Other Name Group');
    expect((await create(other.admin, { name: 'Main Street', town: { townId: 'stowe-vt' } })).status).toBe(201);
  });

  it('refuses an unknown town, a bad state, an empty or long name, and a member', async () => {
    const t = await team('Refusal Group');
    const before = await server.connection.collection('tw_locations').countDocuments({});
    expect(await errorOf(await create(t.admin, { name: 'A', town: { townId: 'springfield-ma' } }))).toEqual({ status: 400, error: 'unknown_town' });
    expect(await errorOf(await create(t.admin, { name: 'A', town: { townId: null, name: 'Somewhere', state: 'XX' } }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await create(t.admin, { name: '   ', town: { townId: 'stowe-vt' } }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await create(t.admin, { name: 'x'.repeat(81), town: { townId: 'stowe-vt' } }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await create(t.member, { name: 'A', town: { townId: 'stowe-vt' } }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await server.connection.collection('tw_locations').countDocuments({})).toBe(before);
  });

  it('the 26th location is 409 location_limit', async () => {
    const t = await team('Limit Group');
    for (let i = 1; i <= 25; i += 1) await addLocation(server, { orgId: t.orgId, name: `Room ${String(i)}` });
    expect(await errorOf(await create(t.admin, { name: 'Room 26', town: { townId: 'stowe-vt' } }))).toEqual({ status: 409, error: 'location_limit' });
  });
});

describe('PATCH /api/org/locations/:locationId', () => {
  it('renames a location or changes its town; a taken name is 409, an empty change or an unknown town is 400', async () => {
    const t = await team('Patch Group');
    const first = await addLocation(server, { orgId: t.orgId, name: 'First' });
    await addLocation(server, { orgId: t.orgId, name: 'Second' });

    const renamed = await patch(t.admin, first, { name: 'Front Room' });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { location: LocationSummary }).location).toMatchObject({ id: first, name: 'Front Room', town: { townId: 'hanover-nh' } });
    const moved = await patch(t.admin, first, { town: { townId: 'ithaca-ny' } });
    expect((await moved.json() as { location: LocationSummary }).location).toMatchObject({ name: 'Front Room', town: { townId: 'ithaca-ny', name: 'Ithaca', state: 'NY' } });
    expect((await auditEvents(server)).filter((e) => e.action === 'location.updated').slice(-2).map((e) => e.details)).toEqual([
      { name: 'Front Room', townId: 'hanover-nh' }, { name: 'Front Room', townId: 'ithaca-ny' },
    ]);

    // A place id is not editable here: PATCH strips it and a stored one survives a rename and a move.
    const locations = server.connection.collection('tw_locations');
    await locations.updateOne({ _id: new Types.ObjectId(first) }, { $set: { placeId: 'ChIJTestPlace0001' } });
    expect((await patch(t.admin, first, { name: 'Front Hall', placeId: 'ChIJTestPlace0009' })).status).toBe(200);
    expect(await locations.findOne({ _id: new Types.ObjectId(first) })).toMatchObject({ name: 'Front Hall', placeId: 'ChIJTestPlace0001' });
    expect((await patch(t.admin, first, { name: 'Front Room' })).status).toBe(200);

    expect(await errorOf(await patch(t.admin, first, { name: 'SECOND' }))).toEqual({ status: 409, error: 'location_name_taken' });
    expect(await errorOf(await patch(t.admin, first, {}))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await patch(t.admin, first, { town: { townId: 'springfield-ma' } }))).toEqual({ status: 400, error: 'unknown_town' });
    expect(await errorOf(await patch(t.member, first, { name: 'Member Room' }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await patch(t.admin, new Types.ObjectId().toHexString(), { name: 'Ghost' }))).toEqual({ status: 404, error: 'not_found' });
  });
});

describe('DELETE /api/org/locations/:locationId', () => {
  it('refuses a location with a sales day or a note; deletes an empty one, with its unfinished upload records', async () => {
    const t = await team('Delete Group');
    const withDays = await addLocation(server, { orgId: t.orgId, name: 'With Days' });
    await addSalesDay(server, { orgId: t.orgId, locationId: withDays, date: '2026-05-01', guests: 5, netSalesCents: null });
    const withNotes = await addLocation(server, { orgId: t.orgId, name: 'With Notes' });
    await addNote(server, { orgId: t.orgId, locationId: withNotes, detail: 'Closed for a staff day' });
    const empty = await addLocation(server, { orgId: t.orgId, name: 'Empty' });
    await addUpload(server, { orgId: t.orgId, locationId: empty, uploadedAt: server.clock.now(), status: 'applying' });

    expect(await errorOf(await remove(t.admin, withDays))).toEqual({ status: 409, error: 'location_has_data' });
    expect(await errorOf(await remove(t.admin, withNotes))).toEqual({ status: 409, error: 'location_has_data' });
    expect(await errorOf(await remove(t.member, empty))).toEqual({ status: 403, error: 'forbidden' });

    expect((await remove(t.admin, empty)).status).toBe(204);
    expect(await server.connection.collection('tw_uploads').countDocuments({ locationId: new Types.ObjectId(empty) })).toBe(0);
    const org = await (await call(server, '/api/org', { session: t.admin })).json() as { locations: { name: string }[] };
    expect(org.locations.map((l) => l.name)).toEqual(['With Days', 'With Notes']);
    const event = (await auditEvents(server)).find((e) => e.action === 'location.deleted' && (e.target as { id: string }).id === empty);
    expect(event?.details).toEqual({ name: 'Empty', townId: 'hanover-nh' });
    expect(await errorOf(await remove(t.admin, empty))).toEqual({ status: 404, error: 'not_found' });
  });

  it('deletes the location’s TownwiseAI proposal records with it, and no other location’s', async () => {
    const t = await team('Proposal Group');
    const doomed = await addLocation(server, { orgId: t.orgId, name: 'Doomed' });
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept' });
    const proposals = server.connection.collection('tw_chat_proposals');
    const at = server.clock.now();
    await proposals.insertMany([doomed, kept].map((locationId) => ({
      orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(locationId), conversationId: new Types.ObjectId(),
      userId: t.member.userId, proposalId: 'toolu_proposal0001', status: 'dismissed', noteId: new Types.ObjectId(), edited: false,
      createdAt: at, updatedAt: at,
    })));
    expect((await remove(t.admin, doomed)).status).toBe(204);
    expect(await proposals.countDocuments({ locationId: new Types.ObjectId(doomed) })).toBe(0);
    expect(await proposals.countDocuments({ locationId: new Types.ObjectId(kept) })).toBe(1);
  });
});

describe('GET /api/towns/:townId', () => {
  it('gives any signed-in person, with or without an organization, the public profile of one of the twelve towns', async () => {
    const person = await signIn(server, `waiting-${randomUUID().slice(0, 8)}@example.test`);
    const res = await call(server, '/api/towns/hanover-nh', { session: person });
    expect(res.status).toBe(200);
    const { profile } = await res.json() as { profile: TownProfile };
    expect(profile).toMatchObject({
      townId: 'hanover-nh', name: 'Hanover', state: 'NH', kind: 'college', county: 'Grafton County', year: 2024,
      series: { label: 'Grafton County, NH' }, northeast: { label: 'Northeast (sum of CT ME MA NH RI VT NJ NY PA)' },
    });
    expect(profile.drivers.length).toBe(2);
    expect(profile.dates.length).toBe(3);
    expect(profile.caveats).toHaveLength(3);
    expect(profile.sources.map((source) => source.url)).toEqual(['https://www.bls.gov/cew/additional-resources/open-data/']);

    const nantucket = await (await call(server, '/api/towns/nantucket-ma', { session: person })).json() as { profile: TownProfile };
    expect(nantucket.profile).toMatchObject({ drivers: [], dates: [] });
  });

  it('answers 404 for a town outside the twelve, and 401 without a session', async () => {
    const person = await signIn(server, `waiting-${randomUUID().slice(0, 8)}@example.test`);
    expect(await errorOf(await call(server, '/api/towns/springfield-ma', { session: person }))).toEqual({ status: 404, error: 'not_found' });
    expect((await call(server, '/api/towns/hanover-nh')).status).toBe(401);
  });
});
