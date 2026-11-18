// Deletion (spec D22, F13, 9.3, 10.7, 19 item 7): staff delete a suspended organization's records, or a person's.
// Each writes its event first, deletes by filter (the tuning chat's records, TownwiseAI's proposal records and order
// cards included), and redacts the audit log. Google access for calendars (connect-google-calendar) ends first: an
// organization's connections through revokeForOrg, and a person's leftover ones through endGoogleAccess, each grant
// revoked through helpers/google.ts's fake, which runs with Google calendars off as the calendar key is set.
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import {
  addActivityDay, addAuditEvent, addChatTurn, addChatUsage, addConversation, addGrant, addInvite, addLiveTurn, addLocation, addNote, addOrderRecords, addOwnerCalendar,
  addRemovedSeat, addRequest, addSalesDay, addSeat, addUpload, auditEvents, createOrg, ORDER_COLLECTIONS,
} from './helpers/fixtures.ts';
import { addGoogleCalendar, addGoogleConnection, createFakeGoogle, REFRESH_TOKEN, SHARED_ID } from './helpers/google.ts';
import {
  call, logLines, makeStaff, MINUTE, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring,
  type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;
const KEY = createSecretKey(randomBytes(32));
const google = createFakeGoogle();

beforeAll(async () => { server = await startTownwiseServer({ calendarKey: KEY, revokeGoogle: google.revoke }); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  google.reset();
  staff = await signInStaff(server);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

/** Every tenant collection: each document carries orgId. */
const TENANT_COLLECTIONS = [
  'tw_members', 'tw_locations', 'tw_sales_days', 'tw_uploads', 'tw_notes', 'tw_chat_conversations', 'tw_chat_live_turns',
  'tw_chat_usage', 'tw_chat_proposals',
  // A TownwiseAI turn's progress (resumable-chat-turns).
  'tw_chat_turns',
  // U9, TownwiseAI's questions, and its weekly suggestions with their pass rows.
  'tw_agent_answers', 'tw_agent_suggestions', 'tw_suggestion_passes',
  // U13B.
  'tw_forecast_runs', 'tw_forecasts',
  // The forecast lab, and (D42) the weekly refresh's week rows.
  'tw_calibrations', 'tw_forecast_weeks',
  // Business rules (spec 6.24).
  'tw_business_rules',
  // The owner's own calendars and their events, and (connect-google-calendar) the Google connections that read them.
  'tw_calendar_sources', 'tw_calendar_events', 'tw_google_connections',
  // Orders: edits, rules, cards, setups, item sales and counts.
  ...ORDER_COLLECTIONS,
  // The days each person used the app (staff-overview).
  'tw_activity_days',
] as const;

/** A tw_chat_proposals record (spec 6.16): the author dismissed a proposal in one of their conversations. */
async function addProposal(opts: { orgId: string; locationId: string; userId: string }): Promise<void> {
  const at = server.clock.now();
  await server.connection.collection('tw_chat_proposals').insertOne({
    orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), conversationId: new Types.ObjectId(),
    userId: opts.userId, proposalId: 'toolu_proposal0001', status: 'dismissed', noteId: new Types.ObjectId(), edited: false,
    createdAt: at, updatedAt: at,
  });
}

/** A tw_order_cards record: the author set aside an order change TownwiseAI proposed in the conversation. */
async function addOrderCard(opts: { orgId: string; locationId: string; conversationId: string }): Promise<void> {
  await server.connection.collection('tw_order_cards').insertOne({
    orgId: new Types.ObjectId(opts.orgId), locationId: new Types.ObjectId(opts.locationId), conversationId: new Types.ObjectId(opts.conversationId),
    proposalId: 'toolu_order0001', kind: 'change', status: 'dismissed', decisionId: new Types.ObjectId(), createdAt: server.clock.now(),
  });
}

interface Person { email: string; session: TestSession }

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function person(name: string): Promise<Person> {
  const email = uniqueEmail(name);
  return { email, session: await signIn(server, email) };
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

function deleteOrg(orgId: string): Promise<Response> {
  return call(server, `/api/admin/orgs/${orgId}`, { method: 'DELETE', session: staff });
}

function deletePerson(email: unknown): Promise<Response> {
  return call(server, '/api/admin/people/delete', { session: staff, json: { email } });
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

/** Every Townwise document, serialized, so any write shows. */
async function snapshot(): Promise<string> {
  const docs: unknown[] = [];
  for (const name of ['tw_orgs', 'tw_access_requests', 'tw_view_as_grants', 'tw_audit_events', ...TENANT_COLLECTIONS]) {
    docs.push(await server.connection.collection(name).find({}).sort({ _id: 1 }).toArray());
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

interface PopulatedOrg {
  orgId: string; name: string; oldName: string; locationNames: string[]; requestId: string;
  admin: Person; member: Person; invitedEmail: string;
  /** The member's Google refresh token, which deleting the organization revokes. */
  googleToken: string;
}

/** An organization with a record in every tenant collection, its request, a view-as grant, and events naming it. */
async function populatedOrg(name: string, status: 'active' | 'suspended'): Promise<PopulatedOrg> {
  const admin = await person('admin');
  const member = await person('member');
  const requestId = await addRequest(server, { userId: admin.session.userId, email: admin.email, status: 'approved', orgName: name });
  const orgId = await createOrg(server, { name, status, fromRequestId: requestId });
  await addSeat(server, { orgId, userId: admin.session.userId, email: admin.email, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
  const invitedEmail = uniqueEmail('invited');
  await addInvite(server, { orgId, email: invitedEmail, invitedBy: admin.session.userId });
  await addRemovedSeat(server, {
    orgId, userId: new Types.ObjectId().toHexString(), email: uniqueEmail('gone'), removedAt: server.clock.now(),
    removedBy: admin.session.userId,
  });
  const locationNames = [`${name} Main Room`, `${name} Patio`];
  const locationIds = [await addLocation(server, { orgId, name: locationNames[0] ?? '' }), await addLocation(server, { orgId, name: locationNames[1] ?? '' })];
  const locationId = locationIds[0] ?? '';
  await addSalesDay(server, { orgId, locationId, date: '2026-05-01', guests: 120, netSalesCents: 345_600 });
  await addSalesDay(server, { orgId, locationId, date: '2026-05-02', guests: 98, netSalesCents: 287_100 });
  await addUpload(server, { orgId, locationId, uploadedAt: server.clock.now(), status: 'applied' });
  await addNote(server, { orgId, locationId, detail: `${name} note detail`, createdBy: member.session.userId });
  await addOwnerCalendar(server, { orgId, locationId });
  // connect-google-calendar: the member's Google connection, with the Google calendar it reads.
  const googleToken = `${REFRESH_TOKEN}-${randomUUID().slice(0, 8)}`;
  const connectionId = await addGoogleConnection(server, { orgId, userId: member.session.userId, key: KEY, refreshToken: googleToken });
  await addGoogleCalendar(server, { orgId, locationId, connectionId, key: KEY, googleCalendarId: SHARED_ID, slot: 1 });
  const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: `${name} chat` });
  await addProposal({ orgId, locationId, userId: member.session.userId });
  await addChatTurn(server, { orgId, locationId, conversationId, userId: member.session.userId });
  // Orders: a record in each of its collections, the card in the member's conversation.
  await addOrderRecords(server, { orgId, locationId, conversationId });
  // U9: an answer to a TownwiseAI question.
  await server.connection.collection('tw_agent_answers').insertOne({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), questionId: 'gap_2026-05-03_2026-05-04',
    answer: 'not_sure', noteId: new Types.ObjectId(), status: 'done', createdAt: server.clock.now(), updatedAt: server.clock.now(),
  });
  // A weekly suggestion and its week's pass row.
  await server.connection.collection('tw_agent_suggestions').insertOne({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), week: '2026-06-01', type: 'note',
    content: {
      kind: 'closure', startDate: '2026-07-04', endDate: '2026-07-04', weekdays: null, effect: 'closed', expectedGuests: null,
      detail: null, startTime: null, endTime: null,
    },
    text: null, why: 'Sentinel why', calendarIds: [], status: 'open', decidedBy: null, decidedAt: null,
    createdAt: server.clock.now(), updatedAt: server.clock.now(),
  });
  await server.connection.collection('tw_suggestion_passes').insertOne({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), week: '2026-06-01', status: 'suggested', suggested: 1,
    createdAt: server.clock.now(), updatedAt: server.clock.now(),
  });
  // D42: a week row of the weekly refresh.
  await server.connection.collection('tw_forecast_weeks').insertOne({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), week: '2026-06-01', status: 'unchanged',
    calibrationId: null, dataSha256: null, createdAt: server.clock.now(), updatedAt: server.clock.now(),
  });
  await addLiveTurn(server, { orgId, userId: member.session.userId });
  // The days its people used the app (staff-overview).
  await addActivityDay(server, { orgId, userId: admin.session.userId, day: '2026-05-31' });
  await addActivityDay(server, { orgId, userId: member.session.userId, day: '2026-06-01' });
  await addChatUsage(server, { orgId, month: '2026-06', costMicroUsd: 1_250_000 });
  await addGrant(server, { actorUserId: staff.userId, sessionId: randomUUID(), targetUserId: member.session.userId, orgId });

  const at = server.clock.now();
  const oldName = `${name} Old`;
  await addAuditEvent(server, {
    at, orgId: null, action: 'access_request.created', actorUserId: admin.session.userId, actorEmail: admin.email, actorRole: 'user',
    target: { type: 'request', id: requestId }, details: { orgName: oldName, townId: 'hanover-nh', townName: 'Hanover' },
  });
  await addAuditEvent(server, {
    at, orgId, action: 'org.created', actorRole: 'superadmin', target: { type: 'org', id: orgId }, details: { name: oldName, via: 'request' },
  });
  await addAuditEvent(server, { at, orgId, action: 'org.renamed', target: { type: 'org', id: orgId }, details: { from: oldName, to: name } });
  await addAuditEvent(server, {
    at, orgId, action: 'location.created', target: { type: 'location', id: locationId }, details: { name: locationNames[0] ?? '', townId: 'hanover-nh' },
  });
  await addAuditEvent(server, { at, orgId, action: 'member.role_changed', details: { email: member.email, from: 'member', to: 'org_admin' } });
  return { orgId, name, oldName, locationNames, requestId, admin, member, invitedEmail, googleToken };
}

/** One organization's documents in every collection, its request and its events, serialized. */
async function snapshotOf(org: PopulatedOrg): Promise<string> {
  const orgId = new Types.ObjectId(org.orgId);
  const docs: unknown[] = [
    await server.connection.collection('tw_orgs').findOne({ _id: orgId }),
    await server.connection.collection('tw_access_requests').findOne({ _id: new Types.ObjectId(org.requestId) }),
    await server.connection.collection('tw_view_as_grants').find({ orgId }).toArray(),
    await server.connection.collection('tw_audit_events').find({ $or: [{ orgId }, { 'target.id': org.requestId }] }).sort({ _id: 1 }).toArray(),
  ];
  for (const name of TENANT_COLLECTIONS) docs.push(await server.connection.collection(name).find({ orgId }).sort({ _id: 1 }).toArray());
  return JSON.stringify(docs);
}

describe('DELETE /api/admin/orgs/:orgId', () => {
  it('refuses an active organization with 409 org_not_suspended, and writes nothing', async () => {
    const org = await populatedOrg('Still Open Grill', 'active');
    const before = await snapshot();
    expect(await errorOf(await deleteOrg(org.orgId))).toEqual({ status: 409, error: 'org_not_suspended' });
    expect(await snapshot()).toBe(before);
  });

  it('deletes every record of a suspended organization, collection by collection, and never another organization’s', async () => {
    const doomed = await populatedOrg('Doomed Harbor Grill', 'suspended');
    const kept = await populatedOrg('Surviving Pine Cafe', 'suspended');
    const keptBefore = await snapshotOf(kept);

    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await deleteOrg(doomed.orgId); });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      deletedDays: 2, deletedUploads: 1, deletedNotes: 1, deletedLocations: 2, deletedSeats: 4, redactedEvents: 4,
    });
    // The event is written before the effect; the organization row is deleted last, then sales days, ordering's
    // records, chat usage and (U13B) forecasts swept again.
    expect(writes[0]).toBe('insert tw_audit_events');
    // Stored files (none here) are swept again after the row too: imports first. Then (staff-overview) active days, (D42)
    // week rows, the weekly suggestions' pass rows and suggestions, and (U13B) forecast rows, then runs.
    expect(writes.slice(-17)).toEqual([
      'delete tw_orgs', 'delete tw_imports', 'delete tw_sales_days', 'delete tw_item_sales', 'delete tw_order_counts',
      'delete tw_order_setups', 'delete tw_order_decisions', 'delete tw_order_rules', 'delete tw_order_cards',
      'delete tw_chat_usage', 'delete tw_activity_days', 'delete tw_calibrations', 'delete tw_forecast_weeks', 'delete tw_suggestion_passes',
      'delete tw_agent_suggestions', 'delete tw_forecasts', 'delete tw_forecast_runs',
    ]);

    const orgId = new Types.ObjectId(doomed.orgId);
    for (const name of TENANT_COLLECTIONS) expect({ name, n: await count(name, { orgId }) }).toEqual({ name, n: 0 });
    expect(await count('tw_orgs', { _id: orgId })).toBe(0);
    expect(await count('tw_access_requests', { _id: new Types.ObjectId(doomed.requestId) })).toBe(0);
    // The member's Google grant was revoked (connect-google-calendar), and the other organization's was not.
    expect(google.callsOf('revoke').map((each) => each.args[0])).toEqual([doomed.googleToken]);
    // View-as grants keep only ids.
    expect(await count('tw_view_as_grants', { orgId })).toBe(1);
    expect(await snapshotOf(kept)).toBe(keptBefore);

    // The audit log keeps the events, with the organization's and its locations' names replaced.
    const events = await auditEvents(server);
    const text = JSON.stringify(events);
    for (const name of [doomed.name, doomed.oldName, ...doomed.locationNames]) expect(text).not.toContain(name);
    expect(text).toContain(kept.name);
    const doomedEvents = events.filter((event) => String(event.orgId) === doomed.orgId);
    expect(doomedEvents.map((event) => [event.action, event.details])).toEqual([
      ['org.created', { name: 'deleted organization', via: 'request' }],
      ['org.renamed', { from: 'deleted organization', to: 'deleted organization' }],
      ['location.created', { name: 'deleted location', townId: 'hanover-nh' }],
      ['member.role_changed', { email: doomed.member.email, from: 'member', to: 'org_admin' }],
      ['org.deleted', {}],
    ]);
    expect(doomedEvents.at(-1)).toMatchObject({ actorUserId: staff.userId, actorRole: 'superadmin', target: { type: 'org', id: doomed.orgId } });
    expect(events.find((event) => (event.target as { id: string }).id === doomed.requestId)?.details)
      .toEqual({ orgName: 'deleted organization', townId: 'hanover-nh', townName: 'Hanover' });

    // Former members resolve to no organization, and the console no longer finds it.
    for (const session of [doomed.admin.session, doomed.member.session]) expect((await me(session)).access).toEqual({ state: 'no_org' });
    expect((await me(kept.member.session)).access).toEqual({ state: 'org_suspended', org: { name: kept.name } });
    expect(await errorOf(await call(server, `/api/admin/orgs/${doomed.orgId}`, { session: staff }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await deleteOrg(doomed.orgId))).toEqual({ status: 404, error: 'not_found' });
  });

  it('a step that fails adds staff_action.not_applied and leaves the organization, and a retry completes the work', async () => {
    const org = await populatedOrg('Interrupted Deli', 'suspended');
    const model = server.connection.models.TwLocation as unknown as { deleteMany: (...args: unknown[]) => unknown };
    const spy = vi.spyOn(model, 'deleteMany').mockImplementationOnce(() => { throw new Error('interrupted'); });
    try {
      expect(await errorOf(await deleteOrg(org.orgId))).toEqual({ status: 500, error: 'internal' });
    } finally {
      spy.mockRestore();
    }
    const orgId = new Types.ObjectId(org.orgId);
    expect(await count('tw_sales_days', { orgId })).toBe(0);
    expect(await count('tw_locations', { orgId })).toBe(2);
    expect(await count('tw_orgs', { _id: orgId })).toBe(1);

    const retried = await deleteOrg(org.orgId);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ deletedDays: 0, deletedLocations: 2, deletedSeats: 4 });
    for (const name of TENANT_COLLECTIONS) expect({ name, n: await count(name, { orgId }) }).toEqual({ name, n: 0 });
    expect(await count('tw_orgs', { _id: orgId })).toBe(0);
    const staffEvents = (await auditEvents(server)).filter((event) => String(event.orgId) === org.orgId && event.actorUserId === staff.userId);
    expect(staffEvents.map((event) => event.action)).toEqual(['org.deleted', 'staff_action.not_applied', 'org.deleted']);
    expect(staffEvents[1]?.details).toEqual({ eventId: String(staffEvents[0]?._id), code: 'internal' });
  });

  it('an organization reactivated while it is being deleted keeps its row: 409 org_not_suspended, recorded as not applied', async () => {
    const org = await populatedOrg('Reactivated Midway Grill', 'suspended');
    const model = server.connection.models.TwLocation as unknown as { deleteMany: (...args: unknown[]) => Promise<unknown> };
    const deleteMany = model.deleteMany.bind(model);
    let reactivated = 0;
    const spy = vi.spyOn(model, 'deleteMany').mockImplementationOnce(async (...args: unknown[]) => {
      reactivated = (await call(server, `/api/admin/orgs/${org.orgId}`, { method: 'PATCH', session: staff, json: { status: 'active' } })).status;
      return deleteMany(...args);
    });
    try {
      expect(await errorOf(await deleteOrg(org.orgId))).toEqual({ status: 409, error: 'org_not_suspended' });
    } finally {
      spy.mockRestore();
    }
    expect(reactivated).toBe(200);
    const orgId = new Types.ObjectId(org.orgId);
    expect(await server.connection.collection('tw_orgs').findOne({ _id: orgId })).toMatchObject({ status: 'active' });
    // The records deleted before the reactivation stay deleted.
    expect(await count('tw_locations', { orgId })).toBe(0);
    const staffEvents = (await auditEvents(server)).filter((event) => String(event.orgId) === org.orgId && event.actorUserId === staff.userId);
    expect(staffEvents.map((event) => event.action)).toEqual(['org.deleted', 'org.reactivated', 'staff_action.not_applied']);
    expect(staffEvents[2]?.details).toEqual({ eventId: String(staffEvents[0]?._id), code: 'org_not_suspended' });
    // Suspended again, a retry completes the deletion.
    expect((await call(server, `/api/admin/orgs/${org.orgId}`, { method: 'PATCH', session: staff, json: { status: 'suspended' } })).status).toBe(200);
    expect((await deleteOrg(org.orgId)).status).toBe(200);
    expect(await count('tw_orgs', { _id: orgId })).toBe(0);
  });

  it('sales days, ordering’s records and chat usage written after the first sweep, by requests in flight, are swept too', async () => {
    const org = await populatedOrg('Late Writes Grill', 'suspended');
    const model = server.connection.models.TwOrg as unknown as { deleteOne: (...args: unknown[]) => Promise<unknown> };
    const deleteOne = model.deleteOne.bind(model);
    const locationId = new Types.ObjectId().toHexString();
    const spy = vi.spyOn(model, 'deleteOne').mockImplementationOnce(async (...args: unknown[]) => {
      const removed = await deleteOne(...args);
      await addSalesDay(server, { orgId: org.orgId, locationId, date: '2026-05-03', guests: 77, netSalesCents: 199_900 });
      await addChatUsage(server, { orgId: org.orgId, month: '2026-07', costMicroUsd: 40_000 });
      // A request already past its policy can still record an active day (staff-overview).
      await addActivityDay(server, { orgId: org.orgId, userId: org.member.session.userId, day: '2026-06-02' });
      // A setup save, an item sales upload, a count, an edit, a rule and a card save still running (A14).
      await addOrderRecords(server, { orgId: org.orgId, locationId });
      return removed;
    });
    let res: Response;
    try {
      res = await deleteOrg(org.orgId);
    } finally {
      spy.mockRestore();
    }
    expect(await res.json()).toMatchObject({ deletedDays: 3 });
    const orgId = new Types.ObjectId(org.orgId);
    for (const name of TENANT_COLLECTIONS) expect({ name, n: await count(name, { orgId }) }).toEqual({ name, n: 0 });
    expect(await count('tw_orgs', { _id: orgId })).toBe(0);
  });

  it('when its audit write fails, is refused with 503 and deletes nothing', async () => {
    const org = await populatedOrg('Unrecorded Deletion Cafe', 'suspended');
    const before = await snapshotOf(org);
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await deleteOrg(org.orgId))).toEqual({ status: 503, error: 'unavailable' });
    });
    expect(await snapshotOf(org)).toBe(before);
  });

  it('is refused with 503 files_unavailable, recorded as not applied, when stored files are off but it has files', async () => {
    const org = await populatedOrg('Files Left Behind Cafe', 'suspended');
    await server.connection.collection('tw_files').insertOne({ orgId: new Types.ObjectId(org.orgId), locationId: new Types.ObjectId(), status: 'read' });
    const records = async (): Promise<string> => {
      const docs: unknown[] = [await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(org.orgId) })];
      for (const name of TENANT_COLLECTIONS) docs.push(await server.connection.collection(name).find({ orgId: new Types.ObjectId(org.orgId) }).toArray());
      return JSON.stringify(docs);
    };
    const before = await records();
    expect(await errorOf(await deleteOrg(org.orgId))).toEqual({ status: 503, error: 'files_unavailable' });
    expect(await records()).toBe(before);
    const events = (await auditEvents(server)).filter((event) => String(event.orgId) === org.orgId);
    expect(events.at(-1)).toMatchObject({ action: 'staff_action.not_applied', details: { code: 'files_unavailable' } });
    expect(await count('tw_files', { orgId: new Types.ObjectId(org.orgId) })).toBe(1);
  });

  it('answers 404 for an unknown organization and 400 for a malformed id', async () => {
    expect(await errorOf(await deleteOrg(new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await deleteOrg('nope'))).toEqual({ status: 400, error: 'invalid_request' });
  });
});

interface DoomedPerson {
  person: Person; second: TestSession; formerOrgId: string; locationId: string; noteId: string; grantId: string; conversationId: string;
  /** Addresses they had before: in their own events, on an old seat, on a request, and only in an event about that seat. */
  oldEmail: string; seatEmail: string; requestEmail: string; changedEmail: string;
}

/** A person with every kind of Townwise record a person can have, except an active seat, and a TOTP factor. */
async function doomedPerson(name: string): Promise<DoomedPerson> {
  const doomed = await person(name);
  const second = await signIn(server, doomed.email);
  const { userId } = doomed.session;
  const formerOrgId = await createOrg(server, { name: `${name} Former Home` });
  const locationId = await addLocation(server, { orgId: formerOrgId, name: 'Former Room' });
  await addRemovedSeat(server, { orgId: formerOrgId, userId, email: doomed.email, removedAt: server.clock.now(), removedBy: userId });
  const olderOrgId = await createOrg(server, { name: `${name} Older Home` });
  const seatEmail = uniqueEmail(`${name}-seat`);
  const olderSeat = await addRemovedSeat(server, { orgId: olderOrgId, userId, email: seatEmail, removedAt: server.clock.now(), removedBy: 'e'.repeat(24) });
  const noteId = await addNote(server, { orgId: formerOrgId, locationId, detail: 'Written before leaving', createdBy: userId });
  const conversationId = await addConversation(server, { orgId: formerOrgId, locationId, userId, text: `${name} private chat` });
  await addProposal({ orgId: formerOrgId, locationId, userId });
  // Orders: the location's records, with an order card in the person's conversation.
  await addOrderRecords(server, { orgId: formerOrgId, locationId, conversationId });
  await addLiveTurn(server, { orgId: formerOrgId, userId });
  // The days they used the app, in both organizations they were in (staff-overview).
  await addActivityDay(server, { orgId: formerOrgId, userId, day: '2026-05-30' });
  await addActivityDay(server, { orgId: olderOrgId, userId, day: '2026-04-02' });
  await addChatTurn(server, { orgId: formerOrgId, locationId, conversationId, userId });
  const inviting = await createOrg(server, { name: `${name} Inviting Cafe` });
  const paused = await createOrg(server, { name: `${name} Paused Inviter`, status: 'suspended' });
  await addInvite(server, { orgId: inviting, email: doomed.email, invitedBy: 'f'.repeat(24) });
  await addInvite(server, { orgId: paused, email: doomed.email, invitedBy: 'f'.repeat(24) });
  await addRequest(server, { userId, email: doomed.email, status: 'rejected' });
  const requestEmail = uniqueEmail(`${name}-request`);
  await addRequest(server, { userId, email: requestEmail, status: 'withdrawn' });
  const grantId = await addGrant(server, { actorUserId: staff.userId, sessionId: randomUUID(), targetUserId: userId, orgId: null });
  await makeStaff(server, userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });

  const at = server.clock.now();
  const oldEmail = uniqueEmail(`${name}-old`);
  await addAuditEvent(server, {
    at, orgId: null, action: 'access_request.created', actorUserId: userId, actorEmail: doomed.email, actorRole: 'user',
    details: { orgName: 'Their Kitchen', townId: 'hanover-nh', townName: 'Hanover' },
  });
  await addAuditEvent(server, { at, orgId: inviting, action: 'member.invited', details: { email: doomed.email, role: 'member' } });
  await addAuditEvent(server, {
    at, orgId: null, action: 'view_as.started', actorEmail: STAFF_EMAIL, actorRole: 'superadmin', viewAsGrantId: grantId,
    target: { type: 'grant', id: grantId },
    details: { targetUserId: userId, targetEmail: oldEmail, reason: 'Checking their request', expiresAt: at.toISOString() },
  });
  // Written under an address they no longer use: found by their user id.
  await addAuditEvent(server, { at, orgId: formerOrgId, action: 'member.left', actorUserId: userId, actorEmail: oldEmail, details: { email: oldEmail } });
  // Other people's events naming older addresses: by their seats' and requests' addresses, and by the seat itself.
  const seatTarget = { type: 'member', id: olderSeat };
  const changedEmail = uniqueEmail(`${name}-changed`);
  await addAuditEvent(server, { at, orgId: olderOrgId, action: 'member.invited', target: seatTarget, details: { email: seatEmail, role: 'member' } });
  await addAuditEvent(server, {
    at, orgId: olderOrgId, action: 'member.role_changed', target: seatTarget, details: { email: changedEmail, from: 'member', to: 'org_admin' },
  });
  await addAuditEvent(server, { at, orgId: inviting, action: 'member.removed', details: { email: requestEmail, wasStatus: 'invited' } });
  await addAuditEvent(server, {
    at, orgId: olderOrgId, action: 'member.joined', actorEmail: STAFF_EMAIL, actorRole: 'superadmin', details: { email: requestEmail, role: 'org_admin' },
  });
  return { person: doomed, second, formerOrgId, locationId, noteId, grantId, conversationId, oldEmail, seatEmail, requestEmail, changedEmail };
}

/** One person's records in every collection that holds any, serialized. */
async function snapshotOfPerson(target: Person): Promise<string> {
  const { userId } = target.session;
  const conversationIds = (await server.connection.collection('tw_chat_conversations').find({ userId }).toArray()).map((doc) => doc._id);
  const docs: unknown[] = [
    await server.connection.collection('tw_access_requests').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_members').find({ $or: [{ userId }, { inviteEmail: target.email }] }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_chat_conversations').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_chat_live_turns').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_chat_proposals').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_chat_turns').find({ userId }).sort({ _id: 1 }).toArray(),
    // Order cards hold no person id: they are the cards in the person's conversations.
    await server.connection.collection('tw_order_cards').find({ conversationId: { $in: conversationIds } }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_profiles').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_google_connections').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_activity_days').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_audit_events').find({ $or: [{ actorUserId: userId }, { 'details.email': target.email }] }).sort({ _id: 1 }).toArray(),
    await server.authStores.totp.get(userId),
  ];
  return JSON.stringify(docs);
}

describe('POST /api/admin/people/delete', () => {
  it('deletes every Townwise record of the person, signs them out, removes their authenticator and redacts the audit log', async () => {
    const doomed = await doomedPerson('doomed');
    const bystander = await doomedPerson('bystander');
    // The display name is account-level: the person's own is deleted, the bystander's stays.
    const at = server.clock.now();
    await server.connection.collection('tw_profiles').insertMany([
      { userId: doomed.person.session.userId, displayName: 'Doomed', createdAt: at, updatedAt: at },
      { userId: bystander.person.session.userId, displayName: 'Bystander', createdAt: at, updatedAt: at },
    ]);
    const bystanderBefore = await snapshotOfPerson(bystander.person);
    // Someone who shares the deleted person's organization keeps their seat, invitation, conversations and live turn.
    const sharer = await person('sharer');
    await addSeat(server, { orgId: doomed.formerOrgId, userId: sharer.session.userId, email: sharer.email });
    const sharerConversation = await addConversation(server, { orgId: doomed.formerOrgId, locationId: doomed.locationId, userId: sharer.session.userId, text: 'Sharer chat' });
    await addOrderCard({ orgId: doomed.formerOrgId, locationId: doomed.locationId, conversationId: sharerConversation });
    await addProposal({ orgId: doomed.formerOrgId, locationId: doomed.locationId, userId: sharer.session.userId });
    await addLiveTurn(server, { orgId: doomed.formerOrgId, userId: sharer.session.userId });
    await addChatTurn(server, { orgId: doomed.formerOrgId, locationId: doomed.locationId, conversationId: sharerConversation, userId: sharer.session.userId });
    await addRemovedSeat(server, {
      orgId: bystander.formerOrgId, userId: sharer.session.userId, email: sharer.email, removedAt: server.clock.now(), removedBy: 'e'.repeat(24),
    });
    await addAuditEvent(server, { at: server.clock.now(), orgId: doomed.formerOrgId, action: 'member.joined', actorUserId: sharer.session.userId, actorEmail: sharer.email, details: { email: sharer.email, role: 'member' } });
    const sharerBefore = await snapshotOfPerson(sharer);
    const { userId } = doomed.person.session;

    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await deletePerson(`  ${doomed.person.email.toUpperCase()} `); });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ deletedRequests: 2, deletedSeats: 4, redactedEvents: 8, kitUserId: userId });
    expect(writes[0]).toBe('insert tw_audit_events');

    expect(await count('tw_access_requests', { userId })).toBe(0);
    expect(await count('tw_members', { userId })).toBe(0);
    expect(await count('tw_members', { inviteEmail: doomed.person.email })).toBe(0);
    expect(await count('tw_chat_conversations', { userId })).toBe(0);
    expect(await count('tw_chat_live_turns', { userId })).toBe(0);
    expect(await count('tw_chat_proposals', { userId })).toBe(0);
    expect(await count('tw_chat_turns', { userId })).toBe(0);
    expect(await count('tw_order_cards', { conversationId: new Types.ObjectId(doomed.conversationId) })).toBe(0);
    expect(await count('tw_profiles', { userId })).toBe(0);
    // Their active days, in both organizations (staff-overview); not counted, so the answer above is unchanged.
    expect(await count('tw_activity_days', { userId })).toBe(0);
    expect(await server.authStores.totp.get(userId)).toBeNull();
    for (const session of [doomed.person.session, doomed.second]) {
      expect(await errorOf(await call(server, '/api/me', { session }))).toEqual({ status: 401, error: 'unauthenticated' });
    }
    // Their notes stay with their organization, and view-as grants keep only ids and the staff reason.
    expect(await count('tw_notes', { _id: new Types.ObjectId(doomed.noteId) })).toBe(1);
    // So do the location's order records other than their cards.
    for (const name of ORDER_COLLECTIONS.filter((each) => each !== 'tw_order_cards')) {
      expect({ name, n: await count(name, { locationId: new Types.ObjectId(doomed.locationId) }) }).toEqual({ name, n: 1 });
    }
    expect(await count('tw_view_as_grants', { _id: new Types.ObjectId(doomed.grantId) })).toBe(1);
    expect(await snapshotOfPerson(bystander.person)).toBe(bystanderBefore);
    expect(await snapshotOfPerson(sharer)).toBe(sharerBefore);
    expect((await me(sharer.session)).access).toMatchObject({ state: 'member', org: { id: doomed.formerOrgId } });

    // Every address they were known by is gone from the audit log, other people's events included.
    const events = await auditEvents(server);
    const text = JSON.stringify(events);
    for (const address of [doomed.person.email, doomed.oldEmail, doomed.seatEmail, doomed.requestEmail, doomed.changedEmail]) {
      expect(text).not.toContain(address);
    }
    expect(text).toContain(bystander.person.email);
    expect(text).toContain(bystander.seatEmail);
    for (const event of events.filter((e) => e.actorUserId === userId)) expect(event.actorEmail).toBe('deleted person');
    const deleted = events.filter((event) => event.action === 'person.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      actorUserId: staff.userId, actorRole: 'superadmin', orgId: null, target: { type: 'user', id: userId }, details: { userId },
    });

    // The kit user record stays until it is deleted by hand (runbook); meanwhile they can sign in, with no organization.
    expect(await server.authStores.users.findById(userId)).not.toBeNull();
    expect((await me(await signIn(server, doomed.person.email))).access).toEqual({ state: 'no_org' });
  });

  it('ends the Google connections a crash left the person (connect-google-calendar): each with its calendars, the grant revoked once', async () => {
    const doomed = await doomedPerson('google-leftover');
    const { userId } = doomed.person.session;
    const token = `${REFRESH_TOKEN}-leftover`;
    const olderOrgId = await createOrg(server, { name: `Leftover Older Home ${randomUUID().slice(0, 6)}` });
    const olderLocation = await addLocation(server, { orgId: olderOrgId, name: 'Older Room' });
    const first = await addGoogleConnection(server, { orgId: doomed.formerOrgId, userId, key: KEY, refreshToken: token });
    await addGoogleCalendar(server, { orgId: doomed.formerOrgId, locationId: doomed.locationId, connectionId: first, key: KEY, googleCalendarId: SHARED_ID });
    server.clock.advance(MINUTE);
    const second = await addGoogleConnection(server, { orgId: olderOrgId, userId, key: KEY, refreshToken: token });
    await addGoogleCalendar(server, { orgId: olderOrgId, locationId: olderLocation, connectionId: second, key: KEY, googleCalendarId: SHARED_ID });
    const from = server.logs.length;
    expect((await deletePerson(doomed.person.email)).status).toBe(200);
    // The first is ended without a revoke while the second still holds the grant (the other-organization rule).
    const ended = logLines(server).slice(from).filter((line) => line.msg === 'townwise.google_access_ended')
      .map(({ connectionId, calendars, reason }) => ({ connectionId, calendars, reason }));
    expect(ended).toEqual([first, second].map((connectionId) => ({ connectionId, calendars: 1, reason: 'person_deleted' })));
    expect(google.callsOf('revoke').map((each) => each.args[0])).toEqual([token]);
    expect(await count('tw_google_connections', { userId })).toBe(0);
    for (const locationId of [doomed.locationId, olderLocation]) {
      expect(await count('tw_calendar_sources', { locationId: new Types.ObjectId(locationId) })).toBe(0);
      expect(await count('tw_calendar_events', { locationId: new Types.ObjectId(locationId) })).toBe(0);
    }
  });

  it('clears a former staff member’s id and address from the weekly refresh’s pause, which stays paused', async () => {
    // A former staff member (no longer in TOWNWISE_SUPERADMIN_EMAILS) who last paused the weekly refresh.
    const former = await person('former-staff');
    const pausedAt = server.clock.now();
    await server.ctx.stores.forecastSchedule.setPaused({ at: pausedAt, by: former.session.userId, email: former.email }, pausedAt);
    try {
      expect((await deletePerson(former.email)).status).toBe(200);
      const doc = await server.connection.collection('tw_forecast_schedule').findOne({ _id: 'weekly' as never });
      expect(doc?.paused).toEqual({ at: pausedAt, by: null, email: 'Deleted person' });
      expect(JSON.stringify(doc)).not.toContain(former.email);
      expect(JSON.stringify(doc)).not.toContain(former.session.userId);
      // Staff still see that it is paused, by whom no longer.
      const res = await call(server, '/api/admin/forecast-schedule', { session: staff, json: { paused: true } });
      expect(await res.json()).toMatchObject({ schedule: { paused: { at: pausedAt.toISOString(), email: 'Deleted person' } } });
    } finally {
      await server.ctx.stores.forecastSchedule.setPaused(null, server.clock.now());
    }
  });

  it('deletes an address that never signed in: its invitations and the events that name it', async () => {
    const orgId = await createOrg(server, { name: 'Inviting Bakery' });
    const email = uniqueEmail('never-signed-in');
    await addInvite(server, { orgId, email, invitedBy: 'f'.repeat(24) });
    await addAuditEvent(server, { at: server.clock.now(), orgId, action: 'member.invited', details: { email, role: 'member' } });
    const res = await deletePerson(email);
    expect(await res.json()).toEqual({ deletedRequests: 0, deletedSeats: 1, redactedEvents: 1, kitUserId: null });
    expect(await count('tw_members', { inviteEmail: email })).toBe(0);
    const events = await auditEvents(server);
    expect(JSON.stringify(events)).not.toContain(email);
    expect(events.at(-1)).toMatchObject({ action: 'person.deleted', target: { type: 'user', id: 'none' }, details: { userId: null } });
  });

  it('deletes an address only the audit log still holds, and then answers 404', async () => {
    const email = uniqueEmail('only-audited');
    await addAuditEvent(server, { at: server.clock.now(), orgId: null, action: 'member.removed', details: { email, wasStatus: 'invited' } });
    expect(await (await deletePerson(email)).json()).toEqual({ deletedRequests: 0, deletedSeats: 0, redactedEvents: 1, kitUserId: null });
    expect(JSON.stringify(await auditEvents(server))).not.toContain(email);
    expect(await errorOf(await deletePerson(email))).toEqual({ status: 404, error: 'not_found' });
  });

  it('refuses a person with an active seat (409 person_has_seat), a staff address (400 invalid_target), an unknown address (404) and a bad one (400), writing nothing', async () => {
    const orgId = await createOrg(server, { name: 'Seated Org', status: 'suspended' });
    const seated = await person('seated');
    await addSeat(server, { orgId, userId: seated.session.userId, email: seated.email });
    const before = await snapshot();
    expect(await errorOf(await deletePerson(seated.email))).toEqual({ status: 409, error: 'person_has_seat' });
    expect(await errorOf(await deletePerson(STAFF_EMAIL))).toEqual({ status: 400, error: 'invalid_target' });
    expect(await errorOf(await deletePerson(uniqueEmail('nobody')))).toEqual({ status: 404, error: 'not_found' });
    for (const email of ['not an email', 42, 'x'.repeat(321)]) {
      expect(await errorOf(await deletePerson(email))).toEqual({ status: 400, error: 'invalid_request' });
    }
    expect(await snapshot()).toBe(before);
    expect((await me(seated.session)).access.state).toBe('org_suspended');
  });

  it('a person who joins while their deletion runs keeps the seat: 409 person_has_seat, recorded as not applied, nothing revoked or redacted', async () => {
    const orgId = await createOrg(server, { name: 'Joined Midway Cafe' });
    const joiner = await person('joiner');
    await makeStaff(server, joiner.session.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
    const inviteId = await addInvite(server, { orgId, email: joiner.email, invitedBy: 'f'.repeat(24), role: 'org_admin' });
    await addAuditEvent(server, { at: server.clock.now(), orgId, action: 'member.invited', target: { type: 'member', id: inviteId }, details: { email: joiner.email, role: 'org_admin' } });
    const model = server.connection.models.TwMember as unknown as { deleteMany: (...args: unknown[]) => Promise<unknown> };
    const deleteMany = model.deleteMany.bind(model);
    let joined = 0;
    // Just before their invitations are deleted, the person joins.
    const spy = vi.spyOn(model, 'deleteMany').mockImplementationOnce(async (...args: unknown[]) => {
      joined = (await call(server, '/api/me/join', { session: joiner.session, json: { inviteId } })).status;
      return deleteMany(...args);
    });
    try {
      expect(await errorOf(await deletePerson(joiner.email))).toEqual({ status: 409, error: 'person_has_seat' });
    } finally {
      spy.mockRestore();
    }
    expect(joined).toBe(200);
    expect(await server.connection.collection('tw_members').findOne({ _id: new Types.ObjectId(inviteId) }))
      .toMatchObject({ status: 'active', activeUserId: joiner.session.userId });
    // Still signed in, with their authenticator, and the audit log still names them.
    expect((await me(joiner.session)).access).toMatchObject({ state: 'member', org: { id: orgId }, role: 'org_admin' });
    expect(await server.authStores.totp.get(joiner.session.userId)).not.toBeNull();
    const events = await auditEvents(server);
    expect(JSON.stringify(events)).toContain(joiner.email);
    const staffEvents = events.filter((event) => event.actorUserId === staff.userId && (event.target as { id: string }).id === joiner.session.userId);
    expect(staffEvents.map((event) => [event.action, event.details])).toEqual([
      ['person.deleted', { userId: joiner.session.userId }],
      ['staff_action.not_applied', { eventId: String(staffEvents[0]?._id), code: 'person_has_seat' }],
    ]);
  });

  it('when its audit write fails, is refused with 503: nothing is deleted and the person stays signed in', async () => {
    const doomed = await doomedPerson('unrecorded');
    const before = await snapshotOfPerson(doomed.person);
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await deletePerson(doomed.person.email))).toEqual({ status: 503, error: 'unavailable' });
    });
    expect(await snapshotOfPerson(doomed.person)).toBe(before);
    expect((await me(doomed.person.session)).access.state).toBe('invited');
  });
});

describe('logs and the record', () => {
  it('logs no email or name while deleting', async () => {
    const org = await populatedOrg('Sentinel Deleted Grill', 'suspended');
    const doomed = await doomedPerson('sentinel');
    server.logs.length = 0;
    expect((await deleteOrg(org.orgId)).status).toBe(200);
    expect((await deletePerson(doomed.person.email)).status).toBe(200);
    const logs = server.logs.join('\n');
    expect(logs).toContain(org.orgId);
    for (const secret of [org.name, ...org.locationNames, org.admin.email, doomed.person.email, doomed.oldEmail, doomed.seatEmail, doomed.requestEmail]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('deletion events hold ids only, and every event carries only its action’s allowlisted detail keys', async () => {
    const events = await auditEvents(server);
    expect(events.some((event) => event.action === 'org.deleted')).toBe(true);
    for (const event of events) {
      const allowed: readonly string[] = AUDIT_DETAIL_KEYS[event.action as AuditAction];
      expect(Object.keys(event.details as object).every((key) => allowed.includes(key))).toBe(true);
      if (event.action === 'org.deleted') expect(event.details).toEqual({});
      if (event.action === 'person.deleted') expect(Object.keys(event.details as object)).toEqual(['userId']);
    }
  });
});
