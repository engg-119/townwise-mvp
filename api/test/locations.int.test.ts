// The organization and its locations (spec 10.3, 6.4, P9, P10, P16), with the Google place an org admin picks, and the
// public town profile route.
import { randomUUID } from 'node:crypto';

import type { Request, Response as ExpressResponse } from 'express';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import { scopeForNewOrg, type OrgScope, type Principal } from '../src/access/policy.ts';
import { createLocation, type LocationSummary } from '../src/handlers/locations.ts';
import type { TownProfile } from '../src/handlers/towns.ts';
import { createGooglePlacesClient } from '../src/places/google.ts';
import {
  addChatTurn, addLocation, addNote, addOpenAsAdminGrant, addOrderRecords, addOwnerCalendar, addRequest, addResearchRecords, addSalesDay, addSeat, addUpload,
  auditEvents, createOrg, ORDER_COLLECTIONS, RESEARCH_COLLECTIONS,
} from './helpers/fixtures.ts';
import { scriptedModel } from './helpers/chat-model.ts';
import { fakePlaces, placeDetails, usAddress } from './helpers/places-fetch.ts';
import {
  call, limiterKey, logLines, signIn, signInStaff, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

const NO_SALES = {
  placeId: null,
  coverage: { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 },
  calibration: { state: 'no_sales_data', updating: null },
  notesCount: 0,
  lastUploadAt: null,
  offDayCount: 0,
  researching: null,
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
          id: busy, name: 'Busy Room', town, placeId: null,
          coverage: { dayCount: 2, guestsDayCount: 1, netSalesDayCount: 1, firstDate: '2026-05-01', lastDate: '2026-05-04', missingDays: 2 },
          calibration: { state: 'not_calibrated', dayCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-04', updating: null, lastRun: null },
          notesCount: 1, lastUploadAt: uploadedAt.toISOString(), offDayCount: 0, researching: null,
        },
        { id: quiet, name: 'Quiet Room', town, ...NO_SALES },
      ],
      requestedLocationCount: 3,
      placeSearch: false,
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

describe('GET /api/org while a forecast updates (D65)', () => {
  const MINUTE = 60_000;

  it('reads running for the location whose calibration is live, and a failed last run with no write once it is past 20 minutes', async () => {
    const t = await team('Updating Diner');
    const busy = await addLocation(server, { orgId: t.orgId, name: 'Busy Room' });
    const stuck = await addLocation(server, { orgId: t.orgId, name: 'Stuck Room' });
    const quiet = await addLocation(server, { orgId: t.orgId, name: 'Quiet Room' });
    for (const locationId of [busy, stuck, quiet]) {
      await addSalesDay(server, { orgId: t.orgId, locationId, date: '2026-05-01', guests: 80, netSalesCents: null });
    }
    const queue = async (locationId: string, requestedAt: Date): Promise<string> => {
      const id = new Types.ObjectId().toHexString();
      await server.ctx.stores.calibrations.insertQueued({ orgId: t.orgId } as OrgScope, {
        id, locationId, requestedBy: { userId: t.admin.userId, role: 'org_admin', via: 'chat' }, regimeStart: null, championRunId: null,
        tokenExpiresAt: new Date(requestedAt.getTime() + 20 * MINUTE), now: requestedAt,
      });
      return id;
    };
    const now = server.clock.now();
    await queue(busy, now);
    const old = new Date(now.getTime() - 25 * MINUTE);
    const id = await queue(stuck, old);
    const before = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(id) });
    let read: Record<string, unknown> = {};
    const writes = await writesDuring(server, async () => {
      const body = await (await call(server, '/api/org', { session: t.member })).json() as { locations: LocationSummary[] };
      read = Object.fromEntries(body.locations.map((location) => [location.id, location.calibration]));
    });
    expect(writes.filter((write) => write.includes('tw_calibrations'))).toEqual([]);
    expect(read[busy]).toMatchObject({ state: 'not_calibrated', updating: { stage: 'running', since: now.toISOString() }, lastRun: null });
    expect(read[stuck]).toMatchObject({
      updating: null, lastRun: { outcome: 'not_run', reason: 'failed', finishedAt: new Date(old.getTime() + 20 * MINUTE).toISOString() },
    });
    expect(read[quiet]).toMatchObject({ state: 'not_calibrated', updating: null, lastRun: null });
    expect(await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(id) })).toEqual(before);
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
    expect(event).toMatchObject({
      action: 'location.created', actorUserId: t.admin.userId, actorRole: 'org_admin', details: { name: 'Harbor Room', townId: 'bar-harbor-me', hasPlace: false },
    });
    expect(String(event?.orgId)).toBe(t.orgId);
    expect(await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(location.id) })).toMatchObject({ placeId: null });

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
      { name: 'Front Room', townId: 'hanover-nh', hasPlace: false }, { name: 'Front Room', townId: 'ithaca-ny', hasPlace: false },
    ]);

    // A stored place survives a rename and a save of the same town, and goes when the town changes by hand or with null.
    const locations = server.connection.collection('tw_locations');
    const placeOf = async (): Promise<unknown> => (await locations.findOne({ _id: new Types.ObjectId(first) }))?.placeId;
    await locations.updateOne({ _id: new Types.ObjectId(first) }, { $set: { placeId: 'ChIJTestPlace0001' } });
    expect((await patch(t.admin, first, { name: 'Front Hall' })).status).toBe(200);
    const kept = await patch(t.admin, first, { name: 'Front Hall', town: { townId: 'ithaca-ny' } });
    expect((await kept.json() as { location: LocationSummary }).location.placeId).toBe('ChIJTestPlace0001');
    expect((await patch(t.admin, first, { town: { townId: 'stowe-vt' } })).status).toBe(200);
    expect(await placeOf()).toBeNull();
    await locations.updateOne({ _id: new Types.ObjectId(first) }, { $set: { placeId: 'ChIJTestPlace0001' } });
    expect((await patch(t.admin, first, { placeId: null })).status).toBe(200);
    expect(await placeOf()).toBeNull();
    // With the search off a place id can't be checked: 503, and nothing changes.
    expect(await errorOf(await patch(t.admin, first, { name: 'Front Room', town: { townId: 'ithaca-ny' }, placeId: 'ChIJTestPlace0009' })))
      .toEqual({ status: 503, error: 'places_unavailable' });
    expect(await errorOf(await create(t.admin, { name: 'Placed', town: { townId: 'ithaca-ny' }, placeId: 'ChIJTestPlace0009' })))
      .toEqual({ status: 503, error: 'places_unavailable' });
    expect(await locations.findOne({ _id: new Types.ObjectId(first) })).toMatchObject({ name: 'Front Hall', town: { townId: 'stowe-vt' }, placeId: null });
    expect((await patch(t.admin, first, { name: 'Front Room' })).status).toBe(200);

    expect(await errorOf(await patch(t.admin, first, { name: 'SECOND' }))).toEqual({ status: 409, error: 'location_name_taken' });
    expect(await errorOf(await patch(t.admin, first, {}))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await patch(t.admin, first, { town: { townId: 'springfield-ma' } }))).toEqual({ status: 400, error: 'unknown_town' });
    expect(await errorOf(await patch(t.member, first, { name: 'Member Room' }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await patch(t.admin, new Types.ObjectId().toHexString(), { name: 'Ghost' }))).toEqual({ status: 404, error: 'not_found' });
  });
});

describe('DELETE /api/org/locations/:locationId', () => {
  // D44: one press deletes the location with all its data; a member still can't.
  it('deletes a location with its sales days and notes, and no other location’s; an empty one, with its unfinished upload records', async () => {
    const t = await team('Delete Group');
    const withData = await addLocation(server, { orgId: t.orgId, name: 'With Data' });
    for (const date of ['2026-05-01', '2026-05-02']) await addSalesDay(server, { orgId: t.orgId, locationId: withData, date, guests: 5, netSalesCents: null });
    for (const detail of ['Closed for a staff day', 'Graduation weekend']) await addNote(server, { orgId: t.orgId, locationId: withData, detail });
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept' });
    await addSalesDay(server, { orgId: t.orgId, locationId: kept, date: '2026-05-01', guests: 7, netSalesCents: null });
    await addNote(server, { orgId: t.orgId, locationId: kept, detail: 'Kept note' });
    const empty = await addLocation(server, { orgId: t.orgId, name: 'Empty' });
    await addUpload(server, { orgId: t.orgId, locationId: empty, uploadedAt: server.clock.now(), status: 'applying' });

    expect(await errorOf(await remove(t.member, withData))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await remove(t.member, empty))).toEqual({ status: 403, error: 'forbidden' });

    expect((await remove(t.admin, withData)).status).toBe(204);
    const of = (collection: string, locationId: string) => server.connection.collection(collection).countDocuments({ locationId: new Types.ObjectId(locationId) });
    expect({ days: await of('tw_sales_days', withData), notes: await of('tw_notes', withData) }).toEqual({ days: 0, notes: 0 });
    expect({ days: await of('tw_sales_days', kept), notes: await of('tw_notes', kept) }).toEqual({ days: 1, notes: 1 });
    const dataEvent = (await auditEvents(server)).find((e) => e.action === 'location.deleted' && (e.target as { id: string }).id === withData);
    expect(dataEvent?.details).toEqual({ name: 'With Data', townId: 'hanover-nh', deletedDays: 2, deletedFiles: 0, deletedNotes: 2 });
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Graduation weekend');

    expect((await remove(t.admin, empty)).status).toBe(204);
    expect(await of('tw_uploads', empty)).toBe(0);
    const org = await (await call(server, '/api/org', { session: t.admin })).json() as { locations: { name: string }[] };
    expect(org.locations.map((l) => l.name)).toEqual(['Kept']);
    const event = (await auditEvents(server)).find((e) => e.action === 'location.deleted' && (e.target as { id: string }).id === empty);
    expect(event?.details).toEqual({ name: 'Empty', townId: 'hanover-nh', deletedDays: 0, deletedFiles: 0, deletedNotes: 0 });
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

  it('deletes the location’s TownwiseAI turn records with it, and no other location’s (resumable-chat-turns)', async () => {
    const t = await team('Turn Group');
    const doomed = await addLocation(server, { orgId: t.orgId, name: 'Doomed' });
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept' });
    await addSalesDay(server, { orgId: t.orgId, locationId: doomed, date: '2026-05-01', guests: 80, netSalesCents: null });
    for (const locationId of [doomed, kept]) {
      await addChatTurn(server, { orgId: t.orgId, locationId, conversationId: new Types.ObjectId().toHexString(), userId: t.member.userId });
    }
    expect((await remove(t.admin, doomed)).status).toBe(204);
    const turns = server.connection.collection('tw_chat_turns');
    expect(await turns.countDocuments({ locationId: new Types.ObjectId(doomed) })).toBe(0);
    expect(await turns.countDocuments({ locationId: new Types.ObjectId(kept) })).toBe(1);
  });

  // U9, TownwiseAI's questions.
  it('deletes the answers to TownwiseAI’s questions about the location with it, and no other location’s', async () => {
    const t = await team('Answer Group');
    const doomed = await addLocation(server, { orgId: t.orgId, name: 'Doomed' });
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept' });
    const answers = server.connection.collection('tw_agent_answers');
    const at = server.clock.now();
    await answers.insertMany([doomed, kept].map((locationId) => ({
      orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(locationId), questionId: 'gap_2026-05-03_2026-05-04',
      answer: 'open', noteId: new Types.ObjectId(), status: 'done', createdAt: at, updatedAt: at,
    })));
    expect((await remove(t.admin, doomed)).status).toBe(204);
    expect(await answers.countDocuments({ locationId: new Types.ObjectId(doomed) })).toBe(0);
    expect(await answers.countDocuments({ locationId: new Types.ObjectId(kept) })).toBe(1);
  });

  it('deletes the location’s own calendars and their events with it, and no other location’s', async () => {
    const t = await team('Calendar Group');
    const doomed = await addLocation(server, { orgId: t.orgId, name: 'Doomed' });
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept' });
    for (const locationId of [doomed, kept]) await addOwnerCalendar(server, { orgId: t.orgId, locationId, eventCount: 3 });
    expect((await remove(t.admin, doomed)).status).toBe(204);
    for (const collection of ['tw_calendar_sources', 'tw_calendar_events']) {
      const of = (locationId: string) => server.connection.collection(collection).countDocuments({ locationId: new Types.ObjectId(locationId) });
      expect({ collection, doomed: await of(doomed), kept: await of(kept) }).toEqual({ collection, doomed: 0, kept: collection === 'tw_calendar_sources' ? 1 : 3 });
    }
  });

  it('deletes the location’s research with it (runs, threads, events, entities, edits), and no other location’s; the town’s rows stay (D66)', async () => {
    const t = await team('Research Group');
    const doomed = await addLocation(server, { orgId: t.orgId, name: 'Doomed' });
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept' });
    for (const locationId of [doomed, kept]) await addResearchRecords(server, { orgId: t.orgId, locationId });
    const townEvents = server.connection.collection('tw_town_events');
    const { insertedId } = await townEvents.insertOne({ townKey: 'hanover-nh', title: 'Fixture Town Fair', start: '2026-06-12', end: '2026-06-12' });
    expect((await remove(t.admin, doomed)).status).toBe(204);
    for (const name of RESEARCH_COLLECTIONS) {
      const collection = server.connection.collection(name);
      expect({ name, doomed: await collection.countDocuments({ locationId: new Types.ObjectId(doomed) }) }).toEqual({ name, doomed: 0 });
      expect({ name, kept: await collection.countDocuments({ locationId: new Types.ObjectId(kept) }) }).toEqual({ name, kept: 1 });
    }
    expect(await townEvents.countDocuments({ _id: insertedId })).toBe(1);
    await townEvents.deleteOne({ _id: insertedId });
  });

  it('deletes the location’s ordering records with it (edits, rules, cards, setup, item sales, counts), and no other location’s', async () => {
    const t = await team('Order Group');
    const doomed = await addLocation(server, { orgId: t.orgId, name: 'Doomed' });
    const kept = await addLocation(server, { orgId: t.orgId, name: 'Kept' });
    for (const locationId of [doomed, kept]) await addOrderRecords(server, { orgId: t.orgId, locationId });
    // D44: item sales go with it in the same press.
    expect((await remove(t.admin, doomed)).status).toBe(204);
    for (const name of ORDER_COLLECTIONS) {
      const collection = server.connection.collection(name);
      expect({ name, doomed: await collection.countDocuments({ locationId: new Types.ObjectId(doomed) }) }).toEqual({ name, doomed: 0 });
      expect({ name, kept: await collection.countDocuments({ locationId: new Types.ObjectId(kept) }) }).toEqual({ name, kept: 1 });
    }
  });
});

describe('GET /api/towns/:townId', () => {
  it('gives any signed-in person, with or without an organization, the public profile of one of the twelve towns', async () => {
    const person = await signIn(server, `waiting-${randomUUID().slice(0, 8)}@example.test`);
    const res = await call(server, '/api/towns/hanover-nh', { session: person });
    expect(res.status).toBe(200);
    const { profile } = await res.json() as { profile: TownProfile };
    expect(profile).toMatchObject({
      townId: 'hanover-nh', name: 'Hanover', state: 'NH', kind: 'college', county: 'Grafton County', year: 2025,
      series: { label: 'Grafton County, NH' }, seriesUnavailable: null, northeast: { label: 'Northeast (sum of CT ME MA NH NJ NY PA)' },
    });
    expect(profile.drivers.length).toBe(2);
    expect(profile.dates.length).toBe(3);
    expect(profile.caveats).toHaveLength(3);
    expect(profile.sources.map((source) => source.url)).toEqual(['https://www.bls.gov/cew/additional-resources/open-data/']);

    const nantucket = await (await call(server, '/api/towns/nantucket-ma', { session: person })).json() as { profile: TownProfile };
    // BLS withheld Nantucket County for April to June 2025: no series, and the reason in its place.
    expect(nantucket.profile).toMatchObject({
      drivers: [], dates: [], series: null,
      seriesUnavailable: 'BLS didn’t publish Nantucket County’s food-service jobs for April to June 2025, so there’s no 2025 index.',
    });
  });

  it('answers 404 for a town outside the twelve, and 401 without a session', async () => {
    const person = await signIn(server, `waiting-${randomUUID().slice(0, 8)}@example.test`);
    expect(await errorOf(await call(server, '/api/towns/springfield-ma', { session: person }))).toEqual({ status: 404, error: 'not_found' });
    expect((await call(server, '/api/towns/hanover-nh')).status).toBe(401);
  });
});

describe('a location’s Google place, with the Places search on', () => {
  // A second server, with Google Places over a fake fetch (helpers/places-fetch.ts), last in the file because starting
  // and closing a server drop the shared test database (as in sales-history.int.test.ts). Tests never call Google.
  const fake = fakePlaces();
  let placed: TownwiseTestServer;
  // Sentinels: neither may reach a log or an audit event.
  const PLACE_ID = 'ChIJTestPlace0001';
  const CURRENT_ID = 'ChIJTestPlace0002';
  const ADDRESS = '8 Test Street, Hanover, NH 03755, USA';
  const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
  const hanoverPlace = (id = CURRENT_ID): unknown => placeDetails(id, ADDRESS, usAddress({ locality: 'Hanover', state: 'NH' }));

  beforeAll(async () => {
    placed = await startTownwiseServer({ places: createGooglePlacesClient('test-places-key', { fetch: fake.fetch, timeoutMs: 200 }) });
  });
  afterAll(async () => { await placed.close(); });
  beforeEach(async () => {
    fake.reset();
    await placed.redis.flushdb();
  });

  async function placedTeam(name: string): Promise<Team> {
    const orgId = await createOrg(placed, { name });
    const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
    const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
    const admin = await signIn(placed, adminEmail);
    const member = await signIn(placed, memberEmail);
    await addSeat(placed, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
    await addSeat(placed, { orgId, userId: member.userId, email: memberEmail });
    return { orgId, admin, adminEmail, member };
  }

  const createAt = (session: TestSession, body: unknown): Promise<Response> => call(placed, '/api/org/locations', { session, json: body });
  const patchAt = (session: TestSession, locationId: string, body: unknown): Promise<Response> =>
    call(placed, `/api/org/locations/${locationId}`, { method: 'PATCH', session, json: body });
  const stored = (locationId: string): Promise<Record<string, unknown> | null> =>
    placed.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(locationId) });

  /** Neither the place id nor the address in any log line or audit event. */
  async function nothingLeaked(): Promise<void> {
    const text = JSON.stringify([logLines(placed), await auditEvents(placed)]);
    for (const secret of [PLACE_ID, CURRENT_ID, ADDRESS]) expect(text).not.toContain(secret);
  }

  it('GET /api/org says the search is on', async () => {
    const t = await placedTeam('Search Group');
    expect(await (await call(placed, '/api/org', { session: t.admin })).json()).toMatchObject({ placeSearch: true });
  });

  it('adds a location at a place Google knows, with Google’s current id and town; the audit event says only that it has one', async () => {
    const t = await placedTeam('Placed Group');
    fake.script({ kind: 'json', body: hanoverPlace() });
    const res = await createAt(t.admin, { name: 'Main Street', town: { townId: 'hanover-nh' }, placeId: PLACE_ID });
    expect(res.status).toBe(201);
    const { location } = await res.json() as { location: LocationSummary };
    expect(location).toMatchObject({ name: 'Main Street', town: HANOVER, placeId: CURRENT_ID });
    expect(await stored(location.id)).toMatchObject({ placeId: CURRENT_ID, town: HANOVER });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toMatch(new RegExp(`^https://places\\.googleapis\\.com/v1/places/${PLACE_ID}\\?sessionToken=[0-9a-f-]{36}$`));
    const event = (await auditEvents(placed)).find((e) => (e.target as { id: string }).id === location.id);
    expect(event).toMatchObject({ action: 'location.created', details: { name: 'Main Street', townId: 'hanover-nh', hasPlace: true } });
    await nothingLeaked();
  });

  it('a place in another town keeps Google’s name for it; a sent town in another case is the same town', async () => {
    const t = await placedTeam('Norwich Group');
    fake.script({ kind: 'json', body: placeDetails(PLACE_ID, 'Norwich, VT, USA', usAddress({ locality: 'Norwich', state: 'VT' })) });
    const res = await createAt(t.admin, { name: 'River Room', town: { townId: null, name: 'norwich', state: 'VT' }, placeId: PLACE_ID });
    expect(res.status).toBe(201);
    expect((await res.json() as { location: LocationSummary }).location).toMatchObject({
      town: { townId: null, name: 'Norwich', state: 'VT' }, placeId: PLACE_ID,
    });
  });

  it('refuses a town that isn’t the place’s, a place Google doesn’t know or outside the US, and Google failing; nothing is added', async () => {
    const t = await placedTeam('Refused Place Group');
    fake.script(
      { kind: 'json', body: hanoverPlace() },
      { kind: 'json', status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } },
      { kind: 'json', body: placeDetails(PLACE_ID, 'San Juan, Puerto Rico', usAddress({ locality: 'San Juan', state: 'San Juan', country: 'PR' })) },
      { kind: 'json', status: 500, body: { error: { code: 500, status: 'INTERNAL' } } },
    );
    const body = (town: unknown): unknown => ({ name: 'Refused', town, placeId: PLACE_ID });
    const writes = await writesDuring(placed, async () => {
      expect(await errorOf(await createAt(t.admin, body({ townId: 'stowe-vt' })))).toEqual({ status: 400, error: 'place_town_mismatch' });
      expect(await errorOf(await createAt(t.admin, body({ townId: 'hanover-nh' })))).toEqual({ status: 400, error: 'unknown_place' });
      expect(await errorOf(await createAt(t.admin, body({ townId: 'hanover-nh' })))).toEqual({ status: 400, error: 'place_not_supported' });
      expect(await errorOf(await createAt(t.admin, body({ townId: 'hanover-nh' })))).toEqual({ status: 503, error: 'places_unavailable' });
    });
    expect(writes).toEqual([]);
    expect(logLines(placed).filter((line) => line.msg === 'townwise.places_failed').at(-1))
      .toMatchObject({ routeId: 'org.locations.create', code: 'upstream_status', status: 500 });
    // Refused before Google is asked: a malformed id, an unknown town, a member.
    expect(await errorOf(await createAt(t.admin, { name: 'Refused', town: { townId: 'hanover-nh' }, placeId: 'ChIJ short' })))
      .toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await createAt(t.admin, body({ townId: 'springfield-ma' })))).toEqual({ status: 400, error: 'unknown_town' });
    expect(await errorOf(await createAt(t.member, body({ townId: 'hanover-nh' })))).toEqual({ status: 403, error: 'forbidden' });
    expect(fake.calls).toHaveLength(4);
    await nothingLeaked();
  });

  it('PATCH sets the place and its town, needs the town with a place id, and takes the place off with null', async () => {
    const t = await placedTeam('Patch Place Group');
    const locationId = await addLocation(placed, { orgId: t.orgId, name: 'Upper Room' });
    await patchAt(t.admin, locationId, { town: { townId: 'stowe-vt' } });
    expect(await errorOf(await patchAt(t.admin, locationId, { placeId: PLACE_ID }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(fake.calls).toHaveLength(0);

    fake.script({ kind: 'json', body: hanoverPlace() });
    const res = await patchAt(t.admin, locationId, { town: { townId: 'hanover-nh' }, placeId: PLACE_ID });
    expect(res.status).toBe(200);
    expect((await res.json() as { location: LocationSummary }).location).toMatchObject({ name: 'Upper Room', town: HANOVER, placeId: CURRENT_ID });

    fake.script({ kind: 'json', body: hanoverPlace() });
    expect(await errorOf(await patchAt(t.admin, locationId, { town: { townId: 'stowe-vt' }, placeId: PLACE_ID })))
      .toEqual({ status: 400, error: 'place_town_mismatch' });
    expect(await stored(locationId)).toMatchObject({ town: HANOVER, placeId: CURRENT_ID });

    expect((await patchAt(t.admin, locationId, { placeId: null })).status).toBe(200);
    expect(await stored(locationId)).toMatchObject({ town: HANOVER, placeId: null });
    expect((await auditEvents(placed)).filter((e) => e.action === 'location.updated' && (e.target as { id: string }).id === locationId)
      .map((e) => e.details)).toEqual([
      { name: 'Upper Room', townId: 'stowe-vt', hasPlace: false },
      { name: 'Upper Room', townId: 'hanover-nh', hasPlace: true },
      { name: 'Upper Room', townId: 'hanover-nh', hasPlace: false },
    ]);
    await nothingLeaked();
  });

  it('a write with a place spends one call of the Places budget; a used-up budget is 429 before Google is asked; a write without a place spends none', async () => {
    const t = await placedTeam('Budget Group');
    const budget = limiterKey('townwise:places', t.admin.userId);
    fake.script({ kind: 'json', body: hanoverPlace() });
    expect((await createAt(t.admin, { name: 'Counted', town: { townId: 'hanover-nh' }, placeId: PLACE_ID })).status).toBe(201);
    expect(await placed.redis.get(budget)).toBe('1');

    // The budget the Places routes share (places.int.test.ts): the 301st call in an hour is refused.
    await placed.redis.set(budget, '300', 'EX', 3600);
    const locationId = await addLocation(placed, { orgId: t.orgId, name: 'Over Budget' });
    const writes = await writesDuring(placed, async () => {
      const refused = await patchAt(t.admin, locationId, { town: { townId: 'hanover-nh' }, placeId: PLACE_ID });
      expect(await errorOf(refused)).toEqual({ status: 429, error: 'rate_limited' });
      expect(refused.headers.get('retry-after')).not.toBeNull();
      expect(await errorOf(await createAt(t.admin, { name: 'Over', town: { townId: 'hanover-nh' }, placeId: PLACE_ID })))
        .toEqual({ status: 429, error: 'rate_limited' });
    });
    expect(writes).toEqual([]);
    expect(fake.calls).toHaveLength(1);

    const spent = await placed.redis.get(budget);
    expect((await createAt(t.admin, { name: 'By Hand', town: { townId: 'hanover-nh' } })).status).toBe(201);
    expect((await patchAt(t.admin, locationId, { name: 'Renamed' })).status).toBe(200);
    expect(await placed.redis.get(budget)).toBe(spent);
    expect(fake.calls).toHaveLength(1);
  });

  it('another organization’s location answers 404 like an unknown one, and Google is not asked', async () => {
    const owner = await placedTeam('Owner Place Group');
    const other = await placedTeam('Other Place Group');
    const locationId = await addLocation(placed, { orgId: owner.orgId, name: 'Their Room' });
    const body = { town: { townId: 'hanover-nh' }, placeId: PLACE_ID };
    expect(await errorOf(await patchAt(other.admin, locationId, body))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await patchAt(other.admin, new Types.ObjectId().toHexString(), body))).toEqual({ status: 404, error: 'not_found' });
    expect(fake.calls).toHaveLength(0);
    // The fixture writes no placeId field, so absent and null both mean the other organization set no place.
    const row = await stored(locationId);
    expect(row).toMatchObject({ name: 'Their Room' });
    expect(row?.placeId ?? null).toBeNull();
  });

  it('under view-as both writes answer 403 view_as_read_only: nothing is written and Google is not asked', async () => {
    const t = await placedTeam('Viewed Place Group');
    const locationId = await addLocation(placed, { orgId: t.orgId, name: 'Viewed Room' });
    const staff = await signInStaff(placed);
    try {
      const started = await call(placed, '/api/admin/view-as', { session: staff, json: { userId: t.admin.userId, reason: 'Checking the place search' } });
      expect(started.status).toBe(201);
      const body = { name: 'Viewed Two', town: { townId: 'hanover-nh' }, placeId: PLACE_ID };
      const writes = await writesDuring(placed, async () => {
        expect(await errorOf(await createAt(staff, body))).toEqual({ status: 403, error: 'view_as_read_only' });
        expect(await errorOf(await patchAt(staff, locationId, body))).toEqual({ status: 403, error: 'view_as_read_only' });
      });
      expect(writes).toEqual([]);
      expect(fake.calls).toHaveLength(0);
      expect((await call(placed, '/api/admin/view-as/end', { session: staff, json: {} })).status).toBe(200);
    } finally {
      await placed.authStores.totp.remove(staff.userId);
    }
  });
});

describe('the Places budget while its store is down', () => {
  // No server: a Redis client whose connection has ended stands for the outage (the limiter refuses without waiting).
  const redis = { status: 'end' };

  it('a location write with a place answers 503 places_unavailable and Google is not asked; without a place it goes on', async () => {
    let asked = 0;
    let counted = 0;
    const ctx = {
      places: { details: () => { asked += 1; return Promise.resolve(null); } },
      redis,
      now: () => new Date('2026-06-01T12:00:00.000Z'),
      stores: { locations: { count: () => { counted += 1; return Promise.resolve(0); }, create: () => Promise.resolve(null) } },
    } as unknown as TownwiseContext;
    const admin = {
      kind: 'member', userId: '000000000000000000000001', email: 'admin@example.test', role: 'org_admin', memberId: '000000000000000000000002',
      scope: { orgId: '000000000000000000000003' }, viewAs: null, openAsAdmin: null,
    } as unknown as Principal;
    const res = {} as ExpressResponse;
    const withPlace = { body: { name: 'Outage', town: { townId: 'hanover-nh' }, placeId: 'ChIJTestPlace0001' } } as Request;
    await expect(createLocation(ctx, withPlace, res, admin)).rejects.toMatchObject({ status: 503, code: 'places_unavailable' });
    expect(asked).toBe(0);
    // Without a place the limiter isn't consulted: the write reaches the store (whose null answer is a taken name).
    const byHand = { body: { name: 'Outage', town: { townId: 'hanover-nh' } } } as Request;
    await expect(createLocation(ctx, byHand, res, admin)).rejects.toMatchObject({ status: 409, code: 'location_name_taken' });
    expect(counted).toBe(2);
    expect(asked).toBe(0);
  });
});

describe('D66: research after an org admin adds a location or changes its place', () => {
  // A third server with research running here (an Anthropic key, standing in as a scripted model, and web search on)
  // and Google Places over a fake fetch. The runner itself does not run in tests: only what the requests queue.
  const fake = fakePlaces();
  let live: TownwiseTestServer;
  const PLACE_A = 'ChIJTestResearchA001';
  const PLACE_B = 'ChIJTestResearchB001';
  const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
  const hanoverPlace = (id: string): unknown => placeDetails(id, '8 Test Street, Hanover, NH 03755, USA', usAddress({ locality: 'Hanover', state: 'NH' }));

  beforeAll(async () => {
    live = await startTownwiseServer({
      env: { TOWNWISE_CHAT_WEB_SEARCH: 'true' }, chat: scriptedModel(),
      places: createGooglePlacesClient('test-places-key', { fetch: fake.fetch, timeoutMs: 200 }),
    });
  });
  afterAll(async () => { await live.close(); });
  beforeEach(async () => {
    fake.reset();
    await live.redis.flushdb();
  });

  async function liveTeam(): Promise<Team> {
    const orgId = await createOrg(live, { name: `Research Group ${randomUUID().slice(0, 6)}` });
    const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
    const admin = await signIn(live, adminEmail);
    await addSeat(live, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
    return { orgId, admin, adminEmail, member: admin };
  }

  const runsOf = (locationId: string) => live.connection.collection('tw_location_research_runs')
    .find({ locationId: new Types.ObjectId(locationId) }).sort({ createdAt: 1, _id: 1 }).toArray();
  const createAt = (session: TestSession, body: unknown): Promise<Response> => call(live, '/api/org/locations', { session, json: body });
  const patchAt = (session: TestSession, locationId: string, body: unknown): Promise<Response> =>
    call(live, `/api/org/locations/${locationId}`, { method: 'PATCH', session, json: body });

  async function created(session: TestSession, body: unknown): Promise<string> {
    const res = await createAt(session, body);
    expect(res.status).toBe(201);
    return (await res.json() as { location: LocationSummary }).location.id;
  }

  it('creating a location queues its early run, due at once, and its town’s week’s run; a rename queues nothing', async () => {
    const t = await liveTeam();
    fake.script({ kind: 'json', body: hanoverPlace(PLACE_A) });
    const locationId = await created(t.admin, { name: 'Lantern Room', town: { townId: 'hanover-nh' }, placeId: PLACE_A });
    const [run] = await runsOf(locationId);
    expect(run).toMatchObject({ trigger: 'early', status: 'queued', placeId: PLACE_A, town: 'hanover-nh', threads: ['neighborhood', 'competitors'] });
    expect(String(run?.key)).toMatch(/^s:[0-9a-f]{24}$/);
    expect(await live.connection.collection('tw_location_research_threads').countDocuments({ runId: run?._id, notBefore: live.clock.now() })).toBe(2);
    expect(await live.connection.collection('tw_town_research_runs').countDocuments({ townKey: 'hanover-nh' })).toBe(1);
    expect((await patchAt(t.admin, locationId, { name: 'Lantern Hall' })).status).toBe(200);
    expect(await runsOf(locationId)).toHaveLength(1);
  });

  it('a place change mid-run ends the run `place_changed`, drops the old place’s rows and edits, and queues a run for the new place; back again queues another', async () => {
    const t = await liveTeam();
    const scope = scopeForNewOrg(STAFF, t.orgId);
    fake.script({ kind: 'json', body: hanoverPlace(PLACE_A) });
    const locationId = await created(t.admin, { name: 'Mill Room', town: { townId: 'hanover-nh' }, placeId: PLACE_A });
    const [first] = await runsOf(locationId);
    if (first === undefined) throw new Error('no early run');
    // A lane is running one of its threads, and an earlier run found an event for place A that a member edited.
    await live.connection.collection('tw_location_research_runs').updateOne({ _id: first._id }, { $set: { status: 'running' } });
    await live.connection.collection('tw_location_research_threads').updateOne({ runId: first._id, thread: 'neighborhood' }, {
      $set: { status: 'running', owner: 'lane-a', leaseUntil: new Date(live.clock.now().getTime() + 90_000) },
    });
    const eventId = await addResearchRecords(live, { orgId: t.orgId, locationId });
    // The fixture's own ended run is not this test's.
    await live.connection.collection('tw_location_research_runs').deleteMany({ locationId: new Types.ObjectId(locationId), status: 'done' });
    await live.connection.collection('tw_location_events').updateMany({ locationId: new Types.ObjectId(locationId) }, { $set: { placeId: PLACE_A } });
    await live.connection.collection('tw_location_entities').updateMany({ locationId: new Types.ObjectId(locationId) }, { $set: { placeId: PLACE_A } });
    await live.connection.collection('tw_research_revisions').insertOne({
      orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(locationId), eventId: 't-0123456789abcdef01234567', op: 'hide', fields: null,
      reverts: null, basedOn: 'base', by: { kind: 'person', userId: t.admin.userId }, createdAt: live.clock.now(),
    });
    expect(await live.connection.collection('tw_research_revisions').countDocuments({ eventId: `l-${eventId}` })).toBe(1);

    fake.script({ kind: 'json', body: hanoverPlace(PLACE_B) });
    expect((await patchAt(t.admin, locationId, { town: { townId: 'hanover-nh' }, placeId: PLACE_B })).status).toBe(200);
    const [ended, next] = await runsOf(locationId);
    expect(ended).toMatchObject({ status: 'off', code: 'place_changed' });
    expect(ended).not.toHaveProperty('liveSubject');
    expect((await live.connection.collection('tw_location_research_threads').find({ runId: ended?._id }).toArray()).map((thread) => [thread.status as string, thread.code as string]))
      .toEqual([['failed', 'place_changed'], ['failed', 'place_changed']]);
    expect(await live.ctx.stores.researchLocations.events(scope, locationId)).toEqual([]);
    expect(await live.connection.collection('tw_location_entities').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(0);
    // The edit of the gone event goes; the town row's edit stays, since the town did not change.
    expect((await live.connection.collection('tw_research_revisions').find({ locationId: new Types.ObjectId(locationId) }).toArray()).map((rev) => rev.eventId as string))
      .toEqual(['t-0123456789abcdef01234567']);
    expect(next).toMatchObject({ trigger: 'early', status: 'queued', placeId: PLACE_B });

    fake.script({ kind: 'json', body: hanoverPlace(PLACE_A) });
    expect((await patchAt(t.admin, locationId, { town: { townId: 'hanover-nh' }, placeId: PLACE_A })).status).toBe(200);
    const runs = await runsOf(locationId);
    expect(runs.map((run) => [run.status as string, run.placeId as string | null])).toEqual([['off', PLACE_A], ['off', PLACE_B], ['queued', PLACE_A]]);
    // A change of town drops the town rows' edits too.
    expect((await patchAt(t.admin, locationId, { town: { townId: 'stowe-vt' } })).status).toBe(200);
    expect(await live.connection.collection('tw_research_revisions').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(0);
    expect((await runsOf(locationId)).at(-1)).toMatchObject({ status: 'queued', placeId: null, town: 'stowe-vt' });
  });

  it('queues nothing for staff open as admin, staff setup, or an organization with research off', async () => {
    const t = await liveTeam();
    const staff = await signInStaff(live);
    await addOpenAsAdminGrant(live, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
    const opened = await created(staff, { name: 'Opened Room', town: { townId: 'hanover-nh' }, orgId: t.orgId });
    expect(await runsOf(opened)).toEqual([]);
    await live.connection.collection('tw_view_as_grants').deleteMany({});

    const made = await call(live, '/api/admin/orgs', { session: staff, json: { name: `Setup Kitchen ${randomUUID().slice(0, 6)}`, adminEmail: `first-${randomUUID().slice(0, 8)}@example.test` } });
    const setupOrgId = (await made.json() as { org: { id: string } }).org.id;
    const setup = await call(live, `/api/admin/orgs/${setupOrgId}/locations`, { session: staff, json: { name: 'Setup Room', town: { townId: 'hanover-nh' } } });
    expect(setup.status).toBe(201);
    expect(await live.connection.collection('tw_location_research_runs').countDocuments({ orgId: new Types.ObjectId(setupOrgId) })).toBe(0);

    await live.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(t.orgId) }, { $set: { research: { on: false, at: live.clock.now(), by: t.admin.userId } } });
    const off = await created(t.admin, { name: 'Quiet Room', town: { townId: 'hanover-nh' } });
    expect(await runsOf(off)).toEqual([]);
  });

  it('a failing enqueue is logged by code and the request still answers 201 and 200', async () => {
    const t = await liveTeam();
    const db = live.connection.db;
    if (db === undefined) throw new Error('not connected');
    // Every write of a location run fails at the database.
    await db.command({ collMod: 'tw_location_research_runs', validator: { $expr: { $eq: [1, 0] } } });
    try {
      const locationId = await created(t.admin, { name: 'Failing Room', town: { townId: 'hanover-nh' } });
      fake.script({ kind: 'json', body: hanoverPlace(PLACE_B) });
      expect((await patchAt(t.admin, locationId, { town: { townId: 'hanover-nh' }, placeId: PLACE_B })).status).toBe(200);
      expect(await runsOf(locationId)).toEqual([]);
      const failed = logLines(live).filter((line) => line.msg === 'townwise.research_enqueue_failed');
      expect(failed.map((line) => line.locationId)).toEqual([locationId, locationId]);
      expect(JSON.stringify(failed)).not.toContain(PLACE_B);
    } finally {
      await db.command({ collMod: 'tw_location_research_runs', validator: {} });
    }
  });
});
