// Staff setup (D23, F10b, spec 10.7): while an organization is active and nobody has ever held a seat in it, staff add,
// rename and remove its locations and upload or delete its daily totals. Each write is a staff action recorded before
// its effect; answers carry ids, names, towns, counts and coverage, never a figure; setup ends for good at the first
// join (409 org_not_in_setup; `firstJoinedAt` outlives the seat and its person) and is closed while suspended; the
// admin who joins reads the days, with the uploader shown as “Townwise staff”, and finds every setup write in their
// staff activity. The figures are synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StaffActivityView } from '../src/audit.ts';
import type { LocationSummary } from '../src/handlers/locations.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import type { SalesHistory, UploadView } from '../src/handlers/sales.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import type { Coverage, SalesDay } from '../src/stores/sales-days.ts';
import { addLocation, addRemovedSeat, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  call, limiterKey, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;

beforeAll(async () => {
  server = await startTownwiseServer();
  staff = await signInStaff(server);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

// The test clock starts at 2026-06-01T12:00Z. Figures no id, time or count here can contain.
const DAYS: SalesDay[] = [
  { date: '2026-05-01', guests: 17389, netSalesCents: 98_765_431 },
  { date: '2026-05-02', guests: 17388, netSalesCents: null },
  { date: '2026-05-03', guests: null, netSalesCents: 98_765_432 },
];
const FIGURES = [/(?<![0-9a-f])1738[89](?![0-9a-f])/i, /(?<![0-9a-f])9876543[12](?![0-9a-f])/i, /987654\.3[12]/];
const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };

interface SetupOrg { orgId: string; name: string; adminEmail: string }
interface UploadAnswer { upload: UploadView; coverage: Coverage; calibration: { state: string } }

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

/** An organization made as staff make one (F10): active, with only an org admin invitation. */
async function setupOrg(name = `Setup Kitchen ${randomUUID().slice(0, 6)}`): Promise<SetupOrg> {
  const adminEmail = uniqueEmail('first-admin');
  const res = await call(server, '/api/admin/orgs', { session: staff, json: { name, adminEmail } });
  expect(res.status).toBe(201);
  return { orgId: (await res.json() as { org: { id: string } }).org.id, name, adminEmail };
}

/** The person invited at `email` signs in and joins (F1). */
async function joinAs(email: string): Promise<TestSession> {
  const session = await signIn(server, email);
  const me = await (await call(server, '/api/me', { session })).json() as MeResponse;
  const inviteId = me.access.state === 'invited' ? me.access.invitations[0]?.inviteId ?? '' : '';
  expect((await call(server, '/api/me/join', { session, json: { inviteId } })).status).toBe(200);
  return session;
}

/** The invited admin signs in and joins. */
function join(org: SetupOrg): Promise<TestSession> {
  return joinAs(org.adminEmail);
}

/** Staff add `email` to the organization's team as a member (F5 from the console); resolves the invitation's id. */
async function inviteMember(orgId: string, email: string): Promise<string> {
  const res = await call(server, `/api/admin/orgs/${orgId}/members`, { session: staff, json: { emails: [email], role: 'member' } });
  expect(res.status).toBe(200);
  return (await res.json() as { members: { id: string; email: string }[] }).members.find((m) => m.email === email)?.id ?? '';
}

async function firstJoinedAt(orgId: string): Promise<unknown> {
  return (await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(orgId) }))?.firstJoinedAt;
}

const base = (orgId: string): string => `/api/admin/orgs/${orgId}/locations`;

function addLoc(orgId: string, body: unknown = { name: 'Main Street', town: { townId: 'hanover-nh' } }, session = staff): Promise<Response> {
  return call(server, base(orgId), { session, json: body });
}

function updateLoc(orgId: string, locationId: string, body: unknown, session = staff): Promise<Response> {
  return call(server, `${base(orgId)}/${locationId}`, { method: 'PATCH', session, json: body });
}

function removeLoc(orgId: string, locationId: string, session = staff): Promise<Response> {
  return call(server, `${base(orgId)}/${locationId}`, { method: 'DELETE', session });
}

function upload(orgId: string, locationId: string, days: unknown = DAYS, session = staff): Promise<Response> {
  return call(server, `${base(orgId)}/${locationId}/sales/uploads`, { session, json: { days } });
}

function removeSales(orgId: string, locationId: string, session = staff): Promise<Response> {
  return call(server, `${base(orgId)}/${locationId}/sales`, { method: 'DELETE', session });
}

/** All five routes, with valid bodies, each answer as { route, status, error }; `skipCreate` leaves out the create. */
async function everyRoute(
  orgId: string, locationId: string, opts: { session?: TestSession; skipCreate?: boolean } = {},
): Promise<{ route: string; status: number; error: string }[]> {
  const session = opts.session ?? staff;
  const calls: [string, () => Promise<Response>][] = [
    ['update', () => updateLoc(orgId, locationId, { name: 'Renamed' }, session)],
    ['upload', () => upload(orgId, locationId, DAYS, session)],
    ['sales.remove', () => removeSales(orgId, locationId, session)],
    ['remove', () => removeLoc(orgId, locationId, session)],
  ];
  if (opts.skipCreate !== true) {
    calls.unshift(['create', () => addLoc(orgId, { name: `Another ${randomUUID().slice(0, 4)}`, town: { townId: 'hanover-nh' } }, session)]);
  }
  const answers: { route: string; status: number; error: string }[] = [];
  for (const [route, run] of calls) answers.push({ route, ...(await errorOf(await run())) });
  return answers;
}

/** Every route answered `status` and `error`. */
function allAnswered(answers: { route: string; status: number; error: string }[], status: number, error: string): void {
  expect(answers).toEqual(answers.map(({ route }) => ({ route, status, error })));
}

async function created(orgId: string, name = 'Main Street'): Promise<LocationSummary> {
  const res = await addLoc(orgId, { name, town: { townId: 'hanover-nh' } });
  expect(res.status).toBe(201);
  return (await res.json() as { location: LocationSummary }).location;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

async function eventsIn(orgId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => String(event.orgId) === orgId);
}

/** The organization's tenant records and events, serialized, so any write shows. */
async function snapshotOf(orgId: string): Promise<string> {
  const docs: unknown[] = [];
  for (const name of ['tw_orgs', 'tw_members', 'tw_locations', 'tw_uploads', 'tw_sales_days', 'tw_audit_events']) {
    const filter = name === 'tw_orgs' ? { _id: new Types.ObjectId(orgId) } : { orgId: new Types.ObjectId(orgId) };
    docs.push(await server.connection.collection(name).find(filter).sort({ _id: 1 }).toArray());
  }
  return JSON.stringify(docs);
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

function doc(collection: string, id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection(collection).findOne({ _id: new Types.ObjectId(id) });
}

describe('in setup', () => {
  it('adds a location, recording location.created before the insert; the location carries the staff id and byStaff', async () => {
    const org = await setupOrg();
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await addLoc(org.orgId, { name: '  Main Street ', town: { townId: 'hanover-nh' } }); });
    expect(res?.status).toBe(201);
    expect(writes).toEqual(['insert tw_audit_events', 'insert tw_locations']);
    const { location } = await res?.json() as { location: LocationSummary };
    expect(location).toEqual({
      id: location.id, name: 'Main Street', town: HANOVER, placeId: null,
      coverage: { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 },
      calibration: { state: 'no_sales_data', updating: null }, notesCount: 0, lastUploadAt: null, offDayCount: 0,
    });
    expect(await doc('tw_locations', location.id)).toMatchObject({ name: 'Main Street', createdBy: staff.userId, byStaff: true });
    expect((await eventsIn(org.orgId)).at(-1)).toMatchObject({
      action: 'location.created', actorRole: 'superadmin', actorUserId: staff.userId, actorEmail: STAFF_EMAIL,
      target: { type: 'location', id: location.id }, details: { name: 'Main Street', townId: 'hanover-nh', hasPlace: false },
    });
  });

  it('renames a location and moves its town, recording location.updated, with the result’s details, before the update', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => {
      res = await updateLoc(org.orgId, location.id, { name: 'Lake Street', town: { townId: null, name: 'Lebanon', state: 'NH' } });
    });
    expect(res?.status).toBe(200);
    expect(writes).toEqual(['insert tw_audit_events', 'update tw_locations']);
    expect((await res?.json() as { location: LocationSummary }).location).toMatchObject({
      id: location.id, name: 'Lake Street', town: { townId: null, name: 'Lebanon', state: 'NH' },
    });
    expect((await eventsIn(org.orgId)).at(-1)).toMatchObject({
      action: 'location.updated', actorRole: 'superadmin', target: { type: 'location', id: location.id },
      details: { name: 'Lake Street', townId: null, hasPlace: false },
    });
  });

  it('removes an empty location, recording location.deleted before the delete; one with days is 409 location_has_data, recording nothing', async () => {
    const org = await setupOrg();
    const empty = await created(org.orgId, 'Annex');
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await removeLoc(org.orgId, empty.id); });
    expect(res?.status).toBe(204);
    expect(writes.slice(0, 2)).toEqual(['insert tw_audit_events', 'delete tw_locations']);
    expect(await doc('tw_locations', empty.id)).toBeNull();
    expect((await eventsIn(org.orgId)).at(-1)).toMatchObject({
      action: 'location.deleted', actorRole: 'superadmin', target: { type: 'location', id: empty.id }, details: { name: 'Annex', townId: 'hanover-nh' },
    });

    const full = await created(org.orgId, 'Full Room');
    await addSalesDay(server, { orgId: org.orgId, locationId: full.id, date: '2026-05-01', guests: 10, netSalesCents: null });
    const before = await snapshotOf(org.orgId);
    expect(await errorOf(await removeLoc(org.orgId, full.id))).toEqual({ status: 409, error: 'location_has_data' });
    expect(await snapshotOf(org.orgId)).toBe(before);
  });

  it('uploads daily totals, replacing the days they cover, recording sales.uploaded before the record and the days', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await upload(org.orgId, location.id); });
    expect(res?.status).toBe(201);
    // D59: the new days mark the location as wanting a refit.
    expect(writes).toEqual(['insert tw_audit_events', 'insert tw_uploads', 'update tw_sales_days', 'update tw_uploads', 'update tw_locations']);
    const text = await res?.text() ?? '';
    for (const figure of FIGURES) expect(text).not.toMatch(figure);
    const answer = JSON.parse(text) as UploadAnswer;
    expect(answer).toEqual({
      upload: {
        id: answer.upload.id, uploadedAt: server.clock.now().toISOString(), uploadedByEmail: 'Townwise staff', status: 'applied',
        dayCount: 3, inserted: 3, replaced: 0, kept: 0, firstDate: '2026-05-01', lastDate: '2026-05-03', hasGuests: true, hasNetSales: true,
      },
      coverage: { dayCount: 3, guestsDayCount: 2, netSalesDayCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-03', missingDays: 0 },
      calibration: { state: 'not_calibrated', dayCount: 3, firstDate: '2026-05-01', lastDate: '2026-05-03', updating: null, lastRun: null },
    });
    expect(await doc('tw_uploads', answer.upload.id)).toMatchObject({ uploadedBy: staff.userId, byStaff: true, status: 'applied' });
    // Written before the days, so it has no inserted or replaced, which exist only after.
    expect((await eventsIn(org.orgId)).at(-1)).toMatchObject({
      action: 'sales.uploaded', actorRole: 'superadmin', target: { type: 'upload', id: answer.upload.id },
      details: { locationId: location.id, dayCount: 3, firstDate: '2026-05-01', lastDate: '2026-05-03' },
    });
    expect(Object.keys((await eventsIn(org.orgId)).at(-1)?.details as object).sort()).toEqual(['dayCount', 'firstDate', 'lastDate', 'locationId']);

    const again = await upload(org.orgId, location.id, [{ date: '2026-05-02', guests: 17389, netSalesCents: 98_765_432 }]);
    expect((await again.json() as UploadAnswer).upload).toMatchObject({ dayCount: 1, inserted: 0, replaced: 1, kept: 0 });
    const day = await server.connection.collection('tw_sales_days').findOne({ locationId: new Types.ObjectId(location.id), date: '2026-05-02' });
    expect(day).toMatchObject({ guests: 17389, netSalesCents: 98_765_432 });
  });

  it('refuses a body the org route refuses with 400, writing nothing', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    const before = await snapshotOf(org.orgId);
    for (const days of [[], [{ date: '2026-05-01', guests: 1, netSalesCents: null, name: 'Guest Name' }], [{ date: '2026-07-01', guests: 1, netSalesCents: null }]]) {
      expect(await errorOf(await upload(org.orgId, location.id, days))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await errorOf(await addLoc(org.orgId, { name: '', town: { townId: 'hanover-nh' } }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await addLoc(org.orgId, { name: 'Elsewhere', town: { townId: 'nowhere-xx' } }))).toEqual({ status: 400, error: 'unknown_town' });
    expect(await errorOf(await updateLoc(org.orgId, location.id, {}))).toEqual({ status: 400, error: 'invalid_request' });
    // A place is checked with Google before anything is recorded; the search is off here.
    expect(await errorOf(await addLoc(org.orgId, { name: 'Placed', town: { townId: 'hanover-nh' }, placeId: 'ChIJ_fixture_place_1' })))
      .toEqual({ status: 503, error: 'places_unavailable' });
    expect(await snapshotOf(org.orgId)).toBe(before);
  });

  it('deletes a location’s sales data, recording sales.deleted with the days it held before the delete', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    expect((await upload(org.orgId, location.id)).status).toBe(201);
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await removeSales(org.orgId, location.id); });
    expect(res?.status).toBe(200);
    expect(writes[0]).toBe('insert tw_audit_events');
    expect(writes).toContain('delete tw_sales_days');
    expect(await res?.json()).toEqual({ deletedDays: 3, deletedUploads: 1, deletedFiles: 0 });
    expect((await eventsIn(org.orgId)).at(-1)).toMatchObject({
      action: 'sales.deleted', actorRole: 'superadmin', target: { type: 'location', id: location.id },
      details: { locationId: location.id, deletedDays: 3 },
    });
    expect(await server.connection.collection('tw_sales_days').countDocuments({ locationId: new Types.ObjectId(location.id) })).toBe(0);
  });

  it('stays open with only open invitations, and after an invitation is withdrawn or declined', async () => {
    const org = await setupOrg();
    const declined = uniqueEmail('declined');
    const withdrawn = await inviteMember(org.orgId, uniqueEmail('withdrawn'));
    await inviteMember(org.orgId, declined);
    expect((await addLoc(org.orgId, { name: 'While Invited', town: { townId: 'hanover-nh' } })).status).toBe(201);
    expect((await call(server, `/api/admin/orgs/${org.orgId}/members/${withdrawn}`, { method: 'DELETE', session: staff })).status).toBe(204);
    const decliner = await signIn(server, declined);
    const me = await (await call(server, '/api/me', { session: decliner })).json() as MeResponse;
    const inviteId = me.access.state === 'invited' ? me.access.invitations[0]?.inviteId ?? '' : '';
    expect((await call(server, '/api/me/decline', { session: decliner, json: { inviteId } })).status).toBe(200);
    expect((await addLoc(org.orgId, { name: 'After Withdrawn', town: { townId: 'hanover-nh' } })).status).toBe(201);
    expect(await firstJoinedAt(org.orgId)).toBeUndefined();
  });
});

describe('when setup is over', () => {
  it('answers 409 org_not_in_setup on every route once the invited admin joins, writing nothing', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    await join(org);
    expect(await firstJoinedAt(org.orgId)).toEqual(server.clock.now());
    const before = await snapshotOf(org.orgId);
    allAnswered(await everyRoute(org.orgId, location.id), 409, 'org_not_in_setup');
    expect(await snapshotOf(org.orgId)).toBe(before);
  });

  it('the console’s organization read says inSetup: true before the first join, false while suspended and after the join', async () => {
    const org = await setupOrg();
    const inSetup = async (): Promise<unknown> => {
      const res = await call(server, `/api/admin/orgs/${org.orgId}`, { session: staff });
      expect(res.status).toBe(200);
      return (await res.json() as { org: { inSetup: unknown } }).org.inSetup;
    };
    const status = (value: string): Promise<Response> => call(server, `/api/admin/orgs/${org.orgId}`, { method: 'PATCH', session: staff, json: { status: value } });
    expect(await inSetup()).toBe(true);
    expect((await status('suspended')).status).toBe(200);
    expect(await inSetup()).toBe(false);
    expect((await status('active')).status).toBe(200);
    expect(await inSetup()).toBe(true);
    await join(org);
    expect(await inSetup()).toBe(false);
  });

  it('sets firstJoinedAt at the first join and never moves it', async () => {
    const org = await setupOrg();
    const memberEmail = uniqueEmail('member');
    await inviteMember(org.orgId, memberEmail);
    const at = server.clock.now();
    await joinAs(memberEmail);
    expect(await firstJoinedAt(org.orgId)).toEqual(at);
    server.clock.advance(1000);
    await join(org);
    expect(await firstJoinedAt(org.orgId)).toEqual(at);
  });

  it('never reopens: 409 after the only person who joined leaves, and after that person is deleted', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    const memberEmail = uniqueEmail('member');
    await inviteMember(org.orgId, memberEmail);
    const member = await joinAs(memberEmail);
    // The admin invitation is still open, so nobody is seated once the member leaves.
    expect((await call(server, '/api/org/leave', { session: member, json: {} })).status).toBe(200);
    allAnswered(await everyRoute(org.orgId, location.id), 409, 'org_not_in_setup');
    expect((await call(server, '/api/admin/people/delete', { session: staff, json: { email: memberEmail } })).status).toBe(200);
    // Deletion took the removed seat, so only the organization's marker says anyone joined.
    expect(await server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(org.orgId), joinedAt: { $ne: null } })).toBe(0);
    const before = await snapshotOf(org.orgId);
    allAnswered(await everyRoute(org.orgId, location.id), 409, 'org_not_in_setup');
    expect(await snapshotOf(org.orgId)).toBe(before);
  });

  it('never reopens after staff remove the only person who joined', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    const memberEmail = uniqueEmail('member');
    const seat = await inviteMember(org.orgId, memberEmail);
    await joinAs(memberEmail);
    expect((await call(server, `/api/admin/orgs/${org.orgId}/members/${seat}`, { method: 'DELETE', session: staff })).status).toBe(204);
    allAnswered(await everyRoute(org.orgId, location.id), 409, 'org_not_in_setup');
  });

  it('closes an organization from before firstJoinedAt while any of its rows joined, a removed one included', async () => {
    const orgId = await createOrg(server, { name: 'Older Diner' });
    const gone = await signIn(server, uniqueEmail('gone'));
    await addRemovedSeat(server, { orgId, userId: gone.userId, email: uniqueEmail('gone'), removedAt: server.clock.now(), removedBy: 'fixture' });
    const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
    expect(await firstJoinedAt(orgId)).toBeUndefined();
    allAnswered(await everyRoute(orgId, locationId), 409, 'org_not_in_setup');
  });

  it('marks the organization an approval seats its requester in', async () => {
    const session = await signIn(server, uniqueEmail('requester'));
    const sent = await call(server, '/api/access-requests', {
      session, json: { orgName: 'Approved Diner', contactName: 'Pat Doe', contactRole: 'Owner', town: { townId: 'hanover-nh' }, locationCount: 1 },
    });
    expect(sent.status).toBe(201);
    const pending = (await sent.json() as MeResponse).access;
    const requestId = pending.state === 'pending' ? pending.request.id : '';
    const approved = await call(server, `/api/admin/requests/${requestId}/approve`, {
      session: staff, json: { orgName: 'Approved Diner', locationName: 'Main Street' },
    });
    expect(approved.status).toBe(200);
    const { org } = await approved.json() as { org: { id: string } };
    expect(await firstJoinedAt(org.id)).toEqual(server.clock.now());
  });

  it('answers 409 org_not_in_setup while any seat is active, a member’s or an org admin’s', async () => {
    for (const role of ['member', 'org_admin'] as const) {
      const orgId = await createOrg(server, { name: `Seated ${role} Diner` });
      const person = await signIn(server, uniqueEmail(role));
      await addSeat(server, { orgId, userId: person.userId, email: uniqueEmail(role), role });
      const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
      allAnswered(await everyRoute(orgId, locationId), 409, 'org_not_in_setup');
    }
  });

  it('stays closed when a person deletion takes the only joined row of an organization with no firstJoinedAt', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    const memberEmail = uniqueEmail('member');
    await inviteMember(org.orgId, memberEmail);
    const joinedAt = server.clock.now();
    const member = await joinAs(memberEmail);
    // As an organization from before the field, or one whose join stopped before marking it.
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(org.orgId) }, { $unset: { firstJoinedAt: '' } });
    expect((await call(server, '/api/org/leave', { session: member, json: {} })).status).toBe(200);
    expect((await call(server, '/api/admin/people/delete', { session: staff, json: { email: memberEmail } })).status).toBe(200);
    expect(await server.connection.collection('tw_members').countDocuments({ orgId: new Types.ObjectId(org.orgId), joinedAt: { $ne: null } })).toBe(0);
    // The deletion marked the organization, with the person's join, before it deleted the row.
    expect(await firstJoinedAt(org.orgId)).toEqual(joinedAt);
    allAnswered(await everyRoute(org.orgId, location.id), 409, 'org_not_in_setup');
    const read = await call(server, `/api/admin/orgs/${org.orgId}`, { session: staff });
    expect((await read.json() as { org: { inSetup: unknown } }).org.inSetup).toBe(false);
  });

  it('answers 409 org_not_in_setup on a suspended organization with nobody in it, and opens again on reactivation', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    const status = (value: string): Promise<Response> => call(server, `/api/admin/orgs/${org.orgId}`, { method: 'PATCH', session: staff, json: { status: value } });
    expect((await status('suspended')).status).toBe(200);
    const before = await snapshotOf(org.orgId);
    allAnswered(await everyRoute(org.orgId, location.id), 409, 'org_not_in_setup');
    expect(await snapshotOf(org.orgId)).toBe(before);
    expect((await status('active')).status).toBe(200);
    expect((await upload(org.orgId, location.id)).status).toBe(201);
  });
});

describe('who and which', () => {
  it('refuses a member and an org admin with 403, writing nothing', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    // Their own organization, so only the policy refuses them.
    const theirs = await createOrg(server, { name: 'Their Own Diner' });
    const admin = await signIn(server, uniqueEmail('admin'));
    const member = await signIn(server, uniqueEmail('member'));
    await addSeat(server, { orgId: theirs, userId: admin.userId, email: uniqueEmail('admin'), role: 'org_admin' });
    await addSeat(server, { orgId: theirs, userId: member.userId, email: uniqueEmail('member') });
    const before = await snapshotOf(org.orgId);
    for (const session of [admin, member]) allAnswered(await everyRoute(org.orgId, location.id, { session }), 403, 'forbidden');
    expect(await snapshotOf(org.orgId)).toBe(before);
  });

  it('answers 404 for an unknown organization, an unknown location and another organization’s location; 400 for a malformed id', async () => {
    const a = await setupOrg();
    const b = await setupOrg();
    const theirs = await created(b.orgId);
    expect((await upload(b.orgId, theirs.id)).status).toBe(201);
    const beforeA = await snapshotOf(a.orgId);
    const beforeB = await snapshotOf(b.orgId);
    const unknown = new Types.ObjectId().toHexString();
    allAnswered(await everyRoute(unknown, theirs.id), 404, 'not_found');
    for (const locationId of [theirs.id, unknown]) allAnswered(await everyRoute(a.orgId, locationId, { skipCreate: true }), 404, 'not_found');
    expect(await errorOf(await upload('not-an-id', theirs.id))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await removeLoc(a.orgId, 'not-an-id'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await snapshotOf(a.orgId)).toBe(beforeA);
    expect(await snapshotOf(b.orgId)).toBe(beforeB);
  });

  it('counts each toward townwise:writes, refusing the 301st in 10 minutes with 429 and writing nothing', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    await server.redis.set(limiterKey('townwise:writes', staff.userId), '300', 'EX', 600);
    const before = await snapshotOf(org.orgId);
    allAnswered(await everyRoute(org.orgId, location.id), 429, 'rate_limited');
    expect(await snapshotOf(org.orgId)).toBe(before);
  });
});

describe('the record', () => {
  it('when its audit write fails, each route is refused with 503 and nothing changes', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    const empty = await created(org.orgId, 'Annex');
    expect((await upload(org.orgId, location.id)).status).toBe(201);
    const before = await snapshotOf(org.orgId);
    await withWritesFailing('tw_audit_events', async () => {
      const calls = [
        () => addLoc(org.orgId, { name: 'Unrecorded', town: { townId: 'hanover-nh' } }),
        () => updateLoc(org.orgId, location.id, { name: 'Unrecorded' }),
        () => removeLoc(org.orgId, empty.id),
        () => upload(org.orgId, location.id, [{ date: '2026-05-04', guests: 1, netSalesCents: null }]),
        () => removeSales(org.orgId, location.id),
      ];
      for (const run of calls) expect(await errorOf(await run())).toEqual({ status: 503, error: 'unavailable' });
    });
    expect(await snapshotOf(org.orgId)).toBe(before);
  });

  it('a name another location has is 409 location_name_taken, its event followed by staff_action.not_applied', async () => {
    const org = await setupOrg();
    const first = await created(org.orgId, 'Main Street');
    const second = await created(org.orgId, 'Annex');
    expect(await errorOf(await addLoc(org.orgId, { name: 'main  street', town: { townId: 'hanover-nh' } })))
      .toEqual({ status: 409, error: 'location_name_taken' });
    expect(await errorOf(await updateLoc(org.orgId, second.id, { name: 'MAIN STREET' }))).toEqual({ status: 409, error: 'location_name_taken' });
    const events = await eventsIn(org.orgId);
    const tail = events.slice(-4);
    expect(tail.map((event) => [event.action, (event.details as { code?: string }).code ?? null])).toEqual([
      ['location.created', null], ['staff_action.not_applied', 'location_name_taken'],
      ['location.updated', null], ['staff_action.not_applied', 'location_name_taken'],
    ]);
    expect((tail[1]?.details as { eventId: string }).eventId).toBe(String(tail[0]?._id));
    expect(await server.connection.collection('tw_locations').countDocuments({ orgId: new Types.ObjectId(org.orgId) })).toBe(2);
    expect((await doc('tw_locations', second.id))?.name).toBe('Annex');
    expect((await doc('tw_locations', first.id))?.name).toBe('Main Street');
  });

  it('with stored files off, deleting a location’s sales data that has files is 503 files_unavailable, recorded as not applied', async () => {
    const org = await setupOrg();
    const location = await created(org.orgId);
    expect((await upload(org.orgId, location.id)).status).toBe(201);
    await server.connection.collection('tw_files').insertOne({
      orgId: new Types.ObjectId(org.orgId), locationId: new Types.ObjectId(location.id), status: 'read',
    });
    expect(await errorOf(await removeSales(org.orgId, location.id))).toEqual({ status: 503, error: 'files_unavailable' });
    const events = await eventsIn(org.orgId);
    expect(events.slice(-2).map((event) => event.action)).toEqual(['sales.deleted', 'staff_action.not_applied']);
    expect(events.at(-1)).toMatchObject({ details: { code: 'files_unavailable' } });
    expect(await server.connection.collection('tw_sales_days').countDocuments({ locationId: new Types.ObjectId(location.id) })).toBe(3);
  });
});

describe('after the admin joins', () => {
  it('lists every setup write in staff activity, and the admin reads the days with the uploader shown as Townwise staff', async () => {
    const org = await setupOrg();
    const main = await created(org.orgId, 'Main Street');
    expect((await updateLoc(org.orgId, main.id, { name: 'Main Street Grill' })).status).toBe(200);
    const annex = await created(org.orgId, 'Annex');
    expect((await upload(org.orgId, main.id)).status).toBe(201);
    expect((await upload(org.orgId, annex.id, [{ date: '2026-05-10', guests: 5, netSalesCents: null }])).status).toBe(201);
    expect((await removeSales(org.orgId, annex.id)).status).toBe(200);
    expect((await removeLoc(org.orgId, annex.id)).status).toBe(204);
    // A rename that didn't take effect shows as not applied.
    const kept = await created(org.orgId, 'Side Door');
    expect((await updateLoc(org.orgId, kept.id, { name: 'Main Street Grill' })).status).toBe(409);

    const admin = await join(org);
    const activity = await call(server, '/api/org/staff-activity', { session: admin });
    expect(activity.status).toBe(200);
    const { events } = await activity.json() as { events: StaffActivityView[] };
    expect(events.map((event) => [event.summary, event.applied, event.notAppliedReason])).toEqual([
      ['Updated the location Main Street Grill', false, 'Another location already uses that name'],
      ['Added the location Side Door', true, null],
      ['Deleted the location Annex', true, null],
      ['Deleted 1 days of sales data', true, null],
      ['Uploaded 1 days of sales data, 2026-05-10 to 2026-05-10', true, null],
      ['Uploaded 3 days of sales data, 2026-05-01 to 2026-05-03', true, null],
      ['Added the location Annex', true, null],
      ['Updated the location Main Street Grill', true, null],
      ['Added the location Main Street', true, null],
      [`Added ${org.adminEmail} as admin`, true, null],
      [`Created ${org.name}`, true, null],
    ]);
    expect(events.every((event) => event.staffEmail === STAFF_EMAIL)).toBe(true);

    const days = await call(server, `/api/org/locations/${main.id}/sales/days?from=2026-05-01&to=2026-05-31`, { session: admin });
    expect((await days.json() as { days: SalesDay[] }).days).toEqual(DAYS);
    const orgRead = await (await call(server, '/api/org', { session: admin })).json() as { locations: LocationSummary[] };
    expect(orgRead.locations.map((location) => [location.name, location.coverage.dayCount])).toEqual([['Main Street Grill', 3], ['Side Door', 0]]);

    // The admin's own upload names them; staff setup's names Townwise staff, never the staff email.
    expect((await call(server, `/api/org/locations/${main.id}/sales/uploads`, {
      session: admin, json: { days: [{ date: '2026-05-04', guests: 7, netSalesCents: null }] },
    })).status).toBe(201);
    const sales = await call(server, `/api/org/locations/${main.id}/sales`, { session: admin });
    const salesText = await sales.text();
    expect((JSON.parse(salesText) as { uploads: UploadView[] }).uploads.map((u) => [u.dayCount, u.uploadedByEmail])).toEqual([
      [1, org.adminEmail], [3, 'Townwise staff'],
    ]);
    const history = await call(server, `/api/org/locations/${main.id}/sales/history`, { session: admin });
    const historyText = await history.text();
    expect((JSON.parse(historyText) as SalesHistory).uploads.map((u) => [u.firstDate, u.uploadedByEmail])).toEqual([
      ['2026-05-04', org.adminEmail], ['2026-05-01', 'Townwise staff'],
    ]);
    for (const text of [salesText, historyText]) expect(text).not.toContain(STAFF_EMAIL);
  });

  it('logs no figure, name or email, and records only allowlisted details with no figure', async () => {
    server.logs.length = 0;
    const org = await setupOrg('Sentinel Setup Diner');
    const location = await created(org.orgId, 'Sentinel Room');
    await updateLoc(org.orgId, location.id, { name: 'Sentinel Room Two' });
    await upload(org.orgId, location.id);
    await removeSales(org.orgId, location.id);
    await removeLoc(org.orgId, location.id);
    const logs = server.logs.join('\n');
    expect(logs).toContain(location.id);
    for (const secret of ['Sentinel Setup Diner', 'Sentinel Room', org.adminEmail, STAFF_EMAIL]) expect(logs).not.toContain(secret);
    for (const figure of FIGURES) expect(logs).not.toMatch(figure);
    const events = await eventsIn(org.orgId);
    for (const event of events) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action as AuditAction];
      expect(Object.keys(event.details as object).every((key) => allowed.includes(key))).toBe(true);
    }
    for (const figure of FIGURES) expect(JSON.stringify(events)).not.toMatch(figure);
  });
});
