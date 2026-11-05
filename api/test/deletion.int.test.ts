// Deletion (spec D22, F13, 9.3, 10.7, 19 item 7): staff delete a suspended organization's records, or a person's.
// Each writes its event first, deletes by filter (the tuning chat's records included), and redacts the audit log.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse } from '../src/handlers/me.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';
import {
  addAuditEvent, addChatUsage, addConversation, addGrant, addInvite, addLiveTurn, addLocation, addNote, addRemovedSeat,
  addRequest, addSalesDay, addSeat, addUpload, auditEvents, createOrg,
} from './helpers/fixtures.ts';
import {
  call, makeStaff, MINUTE, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, writesDuring,
  type TestSession, type TownwiseTestServer,
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

/** Every tenant collection: each document carries orgId. */
const TENANT_COLLECTIONS = [
  'tw_members', 'tw_locations', 'tw_sales_days', 'tw_uploads', 'tw_notes', 'tw_chat_conversations', 'tw_chat_live_turns',
  'tw_chat_usage',
] as const;

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
  await addConversation(server, { orgId, locationId, userId: member.session.userId, text: `${name} chat` });
  await addLiveTurn(server, { orgId, userId: member.session.userId });
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
  return { orgId, name, oldName, locationNames, requestId, admin, member, invitedEmail };
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
    // The event is written before the effect, and the organization row is deleted last.
    expect(writes[0]).toBe('insert tw_audit_events');
    expect(writes.at(-1)).toBe('delete tw_orgs');

    const orgId = new Types.ObjectId(doomed.orgId);
    for (const name of TENANT_COLLECTIONS) expect({ name, n: await count(name, { orgId }) }).toEqual({ name, n: 0 });
    expect(await count('tw_orgs', { _id: orgId })).toBe(0);
    expect(await count('tw_access_requests', { _id: new Types.ObjectId(doomed.requestId) })).toBe(0);
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

  it('when its audit write fails, is refused with 503 and deletes nothing', async () => {
    const org = await populatedOrg('Unrecorded Deletion Cafe', 'suspended');
    const before = await snapshotOf(org);
    await withWritesFailing('tw_audit_events', async () => {
      expect(await errorOf(await deleteOrg(org.orgId))).toEqual({ status: 503, error: 'unavailable' });
    });
    expect(await snapshotOf(org)).toBe(before);
  });

  it('answers 404 for an unknown organization and 400 for a malformed id', async () => {
    expect(await errorOf(await deleteOrg(new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await deleteOrg('nope'))).toEqual({ status: 400, error: 'invalid_request' });
  });
});

interface DoomedPerson {
  person: Person; second: TestSession; oldEmail: string; formerOrgId: string; noteId: string; grantId: string;
}

/** A person with every kind of Townwise record a person can have, except an active seat, and a TOTP factor. */
async function doomedPerson(name: string): Promise<DoomedPerson> {
  const doomed = await person(name);
  const second = await signIn(server, doomed.email);
  const { userId } = doomed.session;
  const formerOrgId = await createOrg(server, { name: `${name} Former Home` });
  const locationId = await addLocation(server, { orgId: formerOrgId, name: 'Former Room' });
  await addRemovedSeat(server, { orgId: formerOrgId, userId, email: doomed.email, removedAt: server.clock.now(), removedBy: userId });
  const noteId = await addNote(server, { orgId: formerOrgId, locationId, detail: 'Written before leaving', createdBy: userId });
  await addConversation(server, { orgId: formerOrgId, locationId, userId, text: `${name} private chat` });
  await addLiveTurn(server, { orgId: formerOrgId, userId });
  const inviting = await createOrg(server, { name: `${name} Inviting Cafe` });
  const paused = await createOrg(server, { name: `${name} Paused Inviter`, status: 'suspended' });
  await addInvite(server, { orgId: inviting, email: doomed.email, invitedBy: 'f'.repeat(24) });
  await addInvite(server, { orgId: paused, email: doomed.email, invitedBy: 'f'.repeat(24) });
  await addRequest(server, { userId, email: doomed.email, status: 'rejected' });
  await addRequest(server, { userId, email: doomed.email, status: 'withdrawn' });
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
  return { person: doomed, second, oldEmail, formerOrgId, noteId, grantId };
}

/** One person's records in every collection that holds any, serialized. */
async function snapshotOfPerson(target: Person): Promise<string> {
  const { userId } = target.session;
  const docs: unknown[] = [
    await server.connection.collection('tw_access_requests').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_members').find({ $or: [{ userId }, { inviteEmail: target.email }] }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_chat_conversations').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_chat_live_turns').find({ userId }).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_audit_events').find({ $or: [{ actorUserId: userId }, { 'details.email': target.email }] }).sort({ _id: 1 }).toArray(),
    await server.authStores.totp.get(userId),
  ];
  return JSON.stringify(docs);
}

describe('POST /api/admin/people/delete', () => {
  it('deletes every Townwise record of the person, signs them out, removes their authenticator and redacts the audit log', async () => {
    const doomed = await doomedPerson('doomed');
    const bystander = await doomedPerson('bystander');
    const bystanderBefore = await snapshotOfPerson(bystander.person);
    const { userId } = doomed.person.session;

    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await deletePerson(`  ${doomed.person.email.toUpperCase()} `); });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ deletedRequests: 2, deletedSeats: 3, redactedEvents: 4, kitUserId: userId });
    expect(writes[0]).toBe('insert tw_audit_events');

    expect(await count('tw_access_requests', { userId })).toBe(0);
    expect(await count('tw_members', { userId })).toBe(0);
    expect(await count('tw_members', { inviteEmail: doomed.person.email })).toBe(0);
    expect(await count('tw_chat_conversations', { userId })).toBe(0);
    expect(await count('tw_chat_live_turns', { userId })).toBe(0);
    expect(await server.authStores.totp.get(userId)).toBeNull();
    for (const session of [doomed.person.session, doomed.second]) {
      expect(await errorOf(await call(server, '/api/me', { session }))).toEqual({ status: 401, error: 'unauthenticated' });
    }
    // Their notes stay with their organization, and view-as grants keep only ids and the staff reason.
    expect(await count('tw_notes', { _id: new Types.ObjectId(doomed.noteId) })).toBe(1);
    expect(await count('tw_view_as_grants', { _id: new Types.ObjectId(doomed.grantId) })).toBe(1);
    expect(await snapshotOfPerson(bystander.person)).toBe(bystanderBefore);

    const events = await auditEvents(server);
    const text = JSON.stringify(events);
    expect(text).not.toContain(doomed.person.email);
    expect(text).not.toContain(doomed.oldEmail);
    expect(text).toContain(bystander.person.email);
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
    for (const secret of [org.name, ...org.locationNames, org.admin.email, doomed.person.email, doomed.oldEmail]) {
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
