// The staff console reads (spec 10.7, P20 to P23): organizations, people and the audit log, and the staff
// policy on every console route.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import type { AuditEventView } from '../src/audit.ts';
import type { PersonView } from '../src/handlers/admin.ts';
import type { MeResponse } from '../src/handlers/me.ts';
import {
  addAuditEvent, addInvite, addLocation, addNote, addRemovedSeat, addRequest, addSalesDay, addSeat, addUpload, createOrg,
} from './helpers/fixtures.ts';
import {
  call, MINUTE, refresh, signIn, signInStaff, startTownwiseServer, STAFF_EMAIL, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const UNENROLLED_STAFF = 'staff-unenrolled@townwise.test';
const NEVER_SIGNED_IN_STAFF = 'staff-never@townwise.test';
/** Sales figures written as fixtures; no console response may carry them (D7). */
const FIGURES = [4321, 1234, 98765432, 55555];

let server: TownwiseTestServer;
let staff: TestSession;

beforeAll(async () => {
  server = await startTownwiseServer({
    env: { TOWNWISE_SUPERADMIN_EMAILS: [STAFF_EMAIL, UNENROLLED_STAFF, NEVER_SIGNED_IN_STAFF].join(',') },
  });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

function uniqueEmail(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`;
}

async function person(name: string): Promise<{ email: string; session: TestSession }> {
  const email = uniqueEmail(name);
  return { email, session: await signIn(server, email) };
}

async function get<T>(path: string, session = staff): Promise<T> {
  const res = await call(server, path, { session });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

/** Every number anywhere in a JSON value. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}

function count(collection: string): Promise<number> {
  return server.connection.collection(collection).countDocuments({});
}

describe('the staff policy on every console route, generated from the route table', () => {
  const consoleRoutes = TOWNWISE_ROUTES.filter((route) => route.policy === 'staff' || route.policy === 'staff_self');

  async function answers(session: TestSession): Promise<{ route: string; status: number; error: string }[]> {
    const results: { route: string; status: number; error: string }[] = [];
    for (const route of consoleRoutes) {
      const path = route.path.replace(/:[A-Za-z]+/g, () => new Types.ObjectId().toHexString());
      const res = await call(server, `/api${path}`, {
        method: route.method, session, ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: {} }),
      });
      results.push({ route: route.id, ...(await errorOf(res)) });
    }
    return results;
  }

  it('covers the whole console built so far', () => {
    expect(consoleRoutes.map((route) => route.id)).toEqual(expect.arrayContaining([
      'admin.requests.list', 'admin.orgs.list', 'admin.orgs.get', 'admin.people.list', 'admin.people.lookup',
      'admin.audit.list', 'admin.view_as.start', 'admin.view_as.end',
    ]));
  });

  it('refuses an org admin, a member, a requester and a person with no organization with 403 forbidden, and writes nothing', async () => {
    const orgId = await createOrg(server, { name: 'Policy Org' });
    const admin = await person('policy-admin');
    const member = await person('policy-member');
    const requester = await person('policy-requester');
    const outsider = await person('policy-outsider');
    await addSeat(server, { orgId, userId: admin.session.userId, email: admin.email, role: 'org_admin' });
    await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    await addRequest(server, { userId: requester.session.userId, email: requester.email, status: 'pending' });
    const before = { events: await count('tw_audit_events'), grants: await count('tw_view_as_grants') };
    for (const caller of [admin, member, requester, outsider]) {
      for (const result of await answers(caller.session)) {
        expect(result).toEqual({ route: result.route, status: 403, error: 'forbidden' });
      }
    }
    expect({ events: await count('tw_audit_events'), grants: await count('tw_view_as_grants') }).toEqual(before);
  });

  it('answers staff without two-step 403 staff_setup_required, and a staff session past 60 minutes 403 staff_reauth_required', async () => {
    const unenrolled = await signIn(server, UNENROLLED_STAFF);
    for (const result of await answers(unenrolled)) {
      expect(result).toEqual({ route: result.route, status: 403, error: 'staff_setup_required' });
    }
    server.clock.advance(61 * MINUTE);
    await refresh(server, staff);
    for (const result of await answers(staff)) {
      expect(result).toEqual({ route: result.route, status: 403, error: 'staff_reauth_required' });
    }
  });
});

interface OrgRow {
  id: string; name: string; status: string; createdAt: string; adminCount: number; memberCount: number;
  inviteCount: number; locationCount: number; salesDayCount: number; lastUploadAt: string | null;
}

describe('GET /api/admin/orgs', () => {
  it('lists every organization newest first, with team, location, day and upload counts, and no figures', async () => {
    const createdAt = server.clock.now();
    const orgId = await createOrg(server, { name: 'Alpine Tavern' });
    const admin = await person('a-admin');
    await addSeat(server, { orgId, userId: admin.session.userId, email: admin.email, role: 'org_admin' });
    for (const name of ['a-member-1', 'a-member-2']) {
      const member = await person(name);
      await addSeat(server, { orgId, userId: member.session.userId, email: member.email });
    }
    await addInvite(server, { orgId, email: uniqueEmail('a-invited'), invitedBy: admin.session.userId });
    const removed = await person('a-removed');
    await addRemovedSeat(server, {
      orgId, userId: removed.session.userId, email: removed.email, removedAt: createdAt, removedBy: admin.session.userId,
    });
    const main = await addLocation(server, { orgId, name: 'Main Street' });
    await addLocation(server, { orgId, name: 'Harbor' });
    await addSalesDay(server, { orgId, locationId: main, date: '2026-05-01', guests: 4321, netSalesCents: 98765432 });
    await addSalesDay(server, { orgId, locationId: main, date: '2026-05-02', guests: null, netSalesCents: 55555 });
    await addSalesDay(server, { orgId, locationId: main, date: '2026-05-04', guests: 1234, netSalesCents: null });
    const uploadedAt = new Date(createdAt.getTime() + 1000);
    await addUpload(server, { orgId, locationId: main, uploadedAt, status: 'applied' });
    // An upload that never finished is not the last upload.
    await addUpload(server, { orgId, locationId: main, uploadedAt: new Date(createdAt.getTime() + 5000), status: 'applying' });
    server.clock.advance(1000);
    const pausedId = await createOrg(server, { name: 'Beachside Bistro', status: 'suspended' });

    const body = await get<{ orgs: OrgRow[] }>('/api/admin/orgs');
    const ids = body.orgs.map((org) => org.id);
    expect(ids.indexOf(pausedId)).toBeLessThan(ids.indexOf(orgId));
    expect(body.orgs.find((org) => org.id === orgId)).toEqual({
      id: orgId, name: 'Alpine Tavern', status: 'active', createdAt: createdAt.toISOString(),
      adminCount: 1, memberCount: 2, inviteCount: 1, locationCount: 2, salesDayCount: 3, lastUploadAt: uploadedAt.toISOString(),
    });
    // With no admin, the console shows “No admin yet”.
    expect(body.orgs.find((org) => org.id === pausedId)).toEqual({
      id: pausedId, name: 'Beachside Bistro', status: 'suspended', createdAt: new Date(createdAt.getTime() + 1000).toISOString(),
      adminCount: 0, memberCount: 0, inviteCount: 0, locationCount: 0, salesDayCount: 0, lastUploadAt: null,
    });
    for (const figure of FIGURES) expect(numbersIn(body)).not.toContain(figure);
  });
});

interface OrgDetail {
  org: Record<string, unknown>;
  members: Record<string, unknown>[];
  locations: Record<string, unknown>[];
  recent: AuditEventView[];
}

describe('GET /api/admin/orgs/:orgId', () => {
  it('shows the organization, its team, its locations with coverage and its newest 20 events, with no figures or note text', async () => {
    const createdAt = server.clock.now();
    const at = (seconds: number): Date => new Date(createdAt.getTime() + seconds * 1000);
    const orgId = await createOrg(server, { name: 'Cedar Grill' });
    const admin = await person('c-admin');
    const seatId = await addSeat(server, { orgId, userId: admin.session.userId, email: admin.email, role: 'org_admin' });
    const invitedEmail = uniqueEmail('c-invited');
    const inviteId = await addInvite(server, { orgId, email: invitedEmail, invitedBy: staff.userId, addedByStaff: true });
    const main = await addLocation(server, { orgId, name: 'Main Street' });
    const second = await addLocation(server, { orgId, name: 'Second Street' });
    await addSalesDay(server, { orgId, locationId: main, date: '2026-05-01', guests: 4321, netSalesCents: 98765432 });
    await addSalesDay(server, { orgId, locationId: main, date: '2026-05-02', guests: null, netSalesCents: 55555 });
    await addSalesDay(server, { orgId, locationId: main, date: '2026-05-04', guests: 1234, netSalesCents: null });
    await addNote(server, { orgId, locationId: main, detail: 'Sentinel note detail' });
    await addNote(server, { orgId, locationId: main, detail: 'Sentinel note detail' });
    await addUpload(server, { orgId, locationId: main, uploadedAt: at(2), status: 'applied' });
    // Another organization's rows, even under this location's id, are not this organization's.
    const otherId = await createOrg(server, { name: 'Other Grill' });
    await addSalesDay(server, { orgId: otherId, locationId: main, date: '2026-05-03', guests: 10, netSalesCents: 10 });
    await addNote(server, { orgId: otherId, locationId: main, detail: 'Other note' });
    await addUpload(server, { orgId: otherId, locationId: main, uploadedAt: at(9), status: 'applied' });
    for (let i = 0; i < 22; i += 1) {
      await addAuditEvent(server, { at: at(i), orgId, action: 'member.invited', details: { email: `person${String(i)}@example.test`, role: 'member' } });
    }
    await addAuditEvent(server, { at: at(60), orgId: otherId, action: 'org.suspended', actorRole: 'superadmin', details: {} });

    const body = await get<OrgDetail>(`/api/admin/orgs/${orgId}`);
    expect(body.org).toEqual({
      id: orgId, name: 'Cedar Grill', status: 'active', createdAt: createdAt.toISOString(), fromRequestId: null, suspendedAt: null,
    });
    expect(body.members).toEqual([
      {
        id: seatId, email: admin.email, role: 'org_admin', status: 'active', invitedAt: createdAt.toISOString(),
        joinedAt: createdAt.toISOString(), isYou: false, addedByStaff: false,
      },
      {
        id: inviteId, email: invitedEmail, role: 'member', status: 'invited', invitedAt: createdAt.toISOString(),
        joinedAt: null, isYou: false, addedByStaff: true,
      },
    ]);
    const town = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
    expect(body.locations).toEqual([
      {
        id: main, name: 'Main Street', town,
        coverage: { dayCount: 3, guestsDayCount: 2, netSalesDayCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-04', missingDays: 1 },
        notesCount: 2, lastUploadAt: at(2).toISOString(),
      },
      {
        id: second, name: 'Second Street', town,
        coverage: { dayCount: 0, guestsDayCount: 0, netSalesDayCount: 0, firstDate: null, lastDate: null, missingDays: 0 },
        notesCount: 0, lastUploadAt: null,
      },
    ]);
    expect(body.recent).toHaveLength(20);
    expect(body.recent.map((event) => event.summary)).toEqual(
      Array.from({ length: 20 }, (_, i) => `Added person${String(21 - i)}@example.test as member`),
    );
    expect(body.recent[0]).toMatchObject({ orgId, orgName: 'Cedar Grill', action: 'member.invited', at: at(21).toISOString(), viewAs: null });
    for (const figure of FIGURES) expect(numbersIn(body)).not.toContain(figure);
    expect(JSON.stringify(body)).not.toContain('Sentinel note detail');
  });

  it('answers 404 for an organization that does not exist and 400 for a malformed id', async () => {
    const missing = await call(server, `/api/admin/orgs/${new Types.ObjectId().toHexString()}`, { session: staff });
    expect(await errorOf(missing)).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await call(server, '/api/admin/orgs/not-an-id', { session: staff }))).toEqual({ status: 400, error: 'invalid_request' });
  });
});

interface PeopleBody { people: PersonView[]; truncated: boolean }

describe('GET /api/admin/people', () => {
  it('lists staff with their two-step state, then everyone else once, with the kind they resolve to', async () => {
    await signIn(server, UNENROLLED_STAFF);   // signed in, no authenticator
    const since = server.clock.now();
    const orgId = await createOrg(server, { name: 'People Org' });
    const pausedId = await createOrg(server, { name: 'Paused Org', status: 'suspended' });
    const p = {
      admin: await person('p-admin'),
      member: await person('p-member'),
      invited: await person('p-invited'),
      pending: await person('p-pending'),
      rejected: await person('p-rejected'),
      removed: await person('p-removed'),
      withdrawn: await person('p-withdrawn'),
      pausedInvite: await person('p-paused-invite'),
      noRecord: await person('p-no-record'),
    };
    const adminId = p.admin.session.userId;
    await addSeat(server, { orgId, userId: adminId, email: p.admin.email, role: 'org_admin' });
    await addSeat(server, { orgId, userId: p.member.session.userId, email: p.member.email });
    await addInvite(server, { orgId, email: p.invited.email, invitedBy: adminId });
    await addRequest(server, { userId: p.pending.session.userId, email: p.pending.email, status: 'pending' });
    await addRequest(server, { userId: p.rejected.session.userId, email: p.rejected.email, status: 'rejected', decidedAt: since });
    await addRemovedSeat(server, { orgId, userId: p.removed.session.userId, email: p.removed.email, removedAt: since, removedBy: adminId });
    await addRequest(server, { userId: p.withdrawn.session.userId, email: p.withdrawn.email, status: 'withdrawn' });
    await addInvite(server, { orgId: pausedId, email: p.pausedInvite.email, invitedBy: adminId });
    const neverSignedIn = uniqueEmail('p-never');
    await addInvite(server, { orgId, email: neverSignedIn, invitedBy: adminId });
    // A staff address that an organization invited is listed once, as staff.
    await addInvite(server, { orgId, email: UNENROLLED_STAFF, invitedBy: adminId });

    const body = await get<PeopleBody>('/api/admin/people');
    expect(body.truncated).toBe(false);
    const row = (email: string): PersonView | undefined => body.people.find((entry) => entry.email === email);

    expect(body.people.slice(0, 3).map((entry) => entry.kind)).toEqual(['staff', 'staff', 'staff']);
    const staffUser = await server.authStores.users.findById(staff.userId);
    const factor = await server.authStores.totp.get(staff.userId);
    expect(row(STAFF_EMAIL)).toEqual({
      userId: staff.userId, email: STAFF_EMAIL, kind: 'staff', org: null, since: staffUser?.createdAt.toISOString(),
      staffTwoStep: { state: 'on', since: factor?.enabledAt?.toISOString() },
    });
    expect(row(UNENROLLED_STAFF)).toMatchObject({ kind: 'staff', staffTwoStep: { state: 'not_set_up' } });
    expect(body.people.filter((entry) => entry.email === UNENROLLED_STAFF)).toHaveLength(1);
    expect(row(NEVER_SIGNED_IN_STAFF)).toEqual({
      userId: null, email: NEVER_SIGNED_IN_STAFF, kind: 'staff', org: null, since: null, staffTwoStep: { state: 'not_signed_in' },
    });

    const org = { id: orgId, name: 'People Org' };
    const expected = (entry: { email: string; session: TestSession }, kind: PersonView['kind'], withOrg: boolean): PersonView => ({
      userId: entry.session.userId, email: entry.email, kind, org: withOrg ? org : null, since: since.toISOString(), staffTwoStep: null,
    });
    expect(row(p.admin.email)).toEqual(expected(p.admin, 'org_admin', true));
    expect(row(p.member.email)).toEqual(expected(p.member, 'member', true));
    expect(row(p.invited.email)).toEqual(expected(p.invited, 'invited', true));
    expect(row(p.pending.email)).toEqual(expected(p.pending, 'pending', false));
    expect(row(p.rejected.email)).toEqual(expected(p.rejected, 'rejected', false));
    expect(row(p.removed.email)).toEqual(expected(p.removed, 'removed', true));
    expect(row(p.withdrawn.email)).toEqual(expected(p.withdrawn, 'signed_in', false));
    // An invitation from a paused organization does not count, exactly as on the person's own page.
    expect(row(p.pausedInvite.email)).toEqual(expected(p.pausedInvite, 'signed_in', false));
    expect(row(neverSignedIn)).toEqual({ userId: null, email: neverSignedIn, kind: 'invited', org, since: since.toISOString(), staffTwoStep: null });
    // Someone with no Townwise record is found only by exact email.
    expect(row(p.noRecord.email)).toBeUndefined();

    // Kind is what each person sees: their own GET /api/me state.
    for (const entry of [p.admin, p.member, p.invited, p.pending, p.rejected, p.removed, p.withdrawn, p.pausedInvite]) {
      const { access } = await get<MeResponse>('/api/me', entry.session);
      const kind = access.state === 'member' ? access.role : access.state === 'no_org' ? 'signed_in' : access.state;
      expect({ email: entry.email, kind: row(entry.email)?.kind }).toEqual({ email: entry.email, kind });
    }
  });

  it('filters by kind, and refuses an unknown kind', async () => {
    const requester = await person('k-pending');
    await addRequest(server, { userId: requester.session.userId, email: requester.email, status: 'pending' });
    const body = await get<PeopleBody>('/api/admin/people?kind=pending');
    expect(body.people.map((entry) => entry.email)).toContain(requester.email);
    expect(new Set(body.people.map((entry) => entry.kind))).toEqual(new Set(['pending']));
    expect(await errorOf(await call(server, '/api/admin/people?kind=owner', { session: staff }))).toEqual({ status: 400, error: 'invalid_request' });
  });

  it('stops at 1,000 people and says so', async () => {
    const orgId = await createOrg(server, { name: 'Crowded Org' });
    const now = server.clock.now();
    await server.connection.collection('tw_members').insertMany(Array.from({ length: 1001 }, (_, i) => {
      const email = `crowd-${String(i)}@example.test`;
      return {
        orgId: new Types.ObjectId(orgId), email, role: 'member', status: 'invited', inviteEmail: email, userId: null,
        invitedAt: now, invitedBy: 'fixture', addedByStaff: false, joinedAt: null, removedAt: null, removedBy: null,
      };
    }));
    try {
      const body = await get<PeopleBody>('/api/admin/people');
      expect(body.people).toHaveLength(1000);
      expect(body.truncated).toBe(true);
    } finally {
      await server.connection.collection('tw_members').deleteMany({ orgId: new Types.ObjectId(orgId) });
    }
  });
});

describe('GET /api/admin/people/lookup', () => {
  it('finds one person by exact email, signed-in-only people and invited addresses included, and answers null for no one', async () => {
    const signedIn = await person('lookup');
    const user = await server.authStores.users.findById(signedIn.session.userId);
    const padded = encodeURIComponent(`  ${signedIn.email.toUpperCase()} `);
    expect(await get(`/api/admin/people/lookup?q=${padded}`)).toEqual({
      person: { userId: signedIn.session.userId, email: signedIn.email, kind: 'signed_in', org: null, since: user?.createdAt.toISOString(), staffTwoStep: null },
    });

    const orgId = await createOrg(server, { name: 'Lookup Org' });
    const invited = uniqueEmail('lookup-invited');
    await addInvite(server, { orgId, email: invited, invitedBy: 'fixture' });
    expect(await get(`/api/admin/people/lookup?q=${encodeURIComponent(invited)}`)).toEqual({
      person: { userId: null, email: invited, kind: 'invited', org: { id: orgId, name: 'Lookup Org' }, since: server.clock.now().toISOString(), staffTwoStep: null },
    });

    expect(await get(`/api/admin/people/lookup?q=${encodeURIComponent(uniqueEmail('nobody'))}`)).toEqual({ person: null });
    const staffRow = await get<{ person: PersonView }>(`/api/admin/people/lookup?q=${encodeURIComponent(NEVER_SIGNED_IN_STAFF)}`);
    expect(staffRow.person).toMatchObject({ kind: 'staff', staffTwoStep: { state: 'not_signed_in' } });
  });

  it('refuses a missing or malformed address, and keeps the address out of the logs', async () => {
    expect(await errorOf(await call(server, '/api/admin/people/lookup', { session: staff }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await call(server, '/api/admin/people/lookup?q=not-an-email', { session: staff }))).toEqual({ status: 400, error: 'invalid_request' });
    const quiet = await person('quiet');
    server.logs.length = 0;
    await get(`/api/admin/people/lookup?q=${encodeURIComponent(quiet.email)}`);
    const logs = server.logs.join('\n');
    expect(logs).toContain('/api/admin/people/lookup');
    expect(logs).not.toContain(quiet.email);
    expect(logs).not.toContain(encodeURIComponent(quiet.email));
  });
});

interface AuditBody { events: AuditEventView[]; nextBefore: string | null }

describe('GET /api/admin/audit', () => {
  const ids = async (query: string): Promise<string[]> => (await get<AuditBody>(`/api/admin/audit?${query}`)).events.map((event) => event.id);

  it('lists events newest first, with plain-words summaries, organization names, view-as labels and “Didn’t take effect”', async () => {
    const actorUserId = new Types.ObjectId().toHexString();
    const orgId = await createOrg(server, { name: 'Audit Org' });
    const goneId = new Types.ObjectId().toHexString();
    const t = server.clock.now().getTime();
    const staffEvent = { actorUserId, actorEmail: STAFF_EMAIL, actorRole: 'superadmin' };
    const grant = { type: 'grant', id: new Types.ObjectId().toHexString() };
    const roleChange = await addAuditEvent(server, {
      ...staffEvent, at: new Date(t + 1000), orgId, action: 'member.role_changed',
      details: { email: 'cook@example.test', from: 'org_admin', to: 'member' },
    });
    await addAuditEvent(server, {
      ...staffEvent, at: new Date(t + 2000), orgId, action: 'staff_action.not_applied', details: { eventId: roleChange, code: 'last_admin' },
    });
    await addAuditEvent(server, {
      ...staffEvent, at: new Date(t + 3000), orgId, action: 'view_as.started', viewAsGrantId: grant.id, target: grant,
      details: { targetUserId: 'c'.repeat(24), targetEmail: 'owner@example.test', reason: 'Helping with an upload', expiresAt: new Date(t + 3000).toISOString() },
    });
    await addAuditEvent(server, {
      ...staffEvent, at: new Date(t + 4000), orgId, action: 'view_as.ended', viewAsGrantId: grant.id, target: grant, details: { endReason: 'ended' },
    });
    await addAuditEvent(server, { ...staffEvent, at: new Date(t + 5000), orgId: goneId, action: 'org.suspended', details: {} });

    const body = await get<AuditBody>(`/api/admin/audit?actorUserId=${actorUserId}`);
    expect(body.events.map((event) => event.summary)).toEqual([
      'Suspended the organization',
      'Ended view-as',
      'Viewed as owner@example.test',
      'Didn’t take effect (last_admin)',
      'Changed cook@example.test from admin to member. Didn’t take effect (last_admin).',
    ]);
    expect(body.events[0]).toMatchObject({ orgId: goneId, orgName: null, viewAs: null });
    expect(body.events[1]).toMatchObject({ orgName: 'Audit Org', viewAs: { targetEmail: 'owner@example.test' }, action: 'view_as.ended' });
    expect(body.events[2]).toMatchObject({ viewAs: { targetEmail: 'owner@example.test' } });
    expect(body.events[4]).toEqual({
      id: roleChange, at: new Date(t + 1000).toISOString(), actorEmail: STAFF_EMAIL, actorRole: 'superadmin', viewAs: null,
      orgId, orgName: 'Audit Org', action: 'member.role_changed',
      summary: 'Changed cook@example.test from admin to member. Didn’t take effect (last_admin).',
      details: { email: 'cook@example.test', from: 'org_admin', to: 'member' },
    });
    expect(body.nextBefore).toBeNull();
  });

  it('summarizes the events an approval writes', async () => {
    const requester = await person('approved');
    const sent = await call(server, '/api/access-requests', {
      session: requester.session,
      json: { orgName: 'Harbor Kitchen Group', contactName: 'Pat Sample', contactRole: 'Owner', town: { townId: 'bar-harbor-me' }, locationCount: 1 },
    });
    const me = await sent.json() as MeResponse;
    const requestId = me.access.state === 'pending' ? me.access.request.id : '';
    const approved = await call(server, `/api/admin/requests/${requestId}/approve`, {
      session: staff, json: { orgName: 'Harbor Kitchen', locationName: 'Main Street' },
    });
    const { org } = await approved.json() as { org: { id: string } };
    const body = await get<AuditBody>(`/api/admin/audit?orgId=${org.id}`);
    expect(body.events.map((event) => [event.action, event.summary, event.orgName])).toEqual([
      ['member.joined', `${requester.email} joined as admin`, 'Harbor Kitchen'],
      ['location.created', 'Added the location Main Street', 'Harbor Kitchen'],
      ['org.created', 'Created Harbor Kitchen', 'Harbor Kitchen'],
      ['access_request.approved', 'Approved an access request', 'Harbor Kitchen'],
    ]);
    const created = await get<AuditBody>(`/api/admin/audit?actorUserId=${requester.session.userId}&action=access_request.created`);
    expect(created.events.map((event) => event.summary)).toEqual(['Requested access for Harbor Kitchen Group in Bar Harbor']);
  });

  it('filters by organization, actor and action; an empty filter is no filter', async () => {
    const actor = new Types.ObjectId().toHexString();
    const other = new Types.ObjectId().toHexString();
    const orgA = await createOrg(server, { name: 'Filter A' });
    const orgB = await createOrg(server, { name: 'Filter B' });
    const t = server.clock.now().getTime();
    const invited = { action: 'member.invited', details: { email: 'x@example.test', role: 'member' } };
    const e1 = await addAuditEvent(server, { ...invited, at: new Date(t + 1000), orgId: orgA, actorUserId: actor });
    const e2 = await addAuditEvent(server, { ...invited, at: new Date(t + 2000), orgId: orgB, actorUserId: actor });
    const e3 = await addAuditEvent(server, {
      at: new Date(t + 3000), orgId: orgA, actorUserId: actor, action: 'org.renamed', details: { from: 'Filter A', to: 'Filter A2' },
    });
    const e4 = await addAuditEvent(server, { ...invited, at: new Date(t + 4000), orgId: orgA, actorUserId: other });
    expect(await ids(`actorUserId=${actor}`)).toEqual([e3, e2, e1]);
    expect(await ids(`orgId=${orgA}`)).toEqual([e4, e3, e1]);
    expect(await ids(`orgId=${orgA}&actorUserId=${actor}&action=member.invited`)).toEqual([e1]);
    expect(await ids(`orgId=${orgA}&actorUserId=&action=&before=&limit=`)).toEqual([e4, e3, e1]);
  });

  it('pages with before, and a page boundary inside events that share a time skips none', async () => {
    const actorUserId = new Types.ObjectId().toHexString();
    const t = server.clock.now().getTime();
    const event = (at: number): Promise<string> => addAuditEvent(server, { at: new Date(at), orgId: null, actorUserId, action: 'org.suspended', details: {} });
    const earlier = [await event(t + 1000), await event(t + 1000), await event(t + 1000)];
    const later = [await event(t + 2000), await event(t + 2000), await event(t + 2000)];

    const first = await get<AuditBody>(`/api/admin/audit?actorUserId=${actorUserId}&limit=2`);
    expect(first.events.map((e) => e.id)).toEqual([...later].reverse());
    expect(first.nextBefore).toBe(new Date(t + 2000).toISOString());
    const second = await get<AuditBody>(`/api/admin/audit?actorUserId=${actorUserId}&limit=2&before=${encodeURIComponent(first.nextBefore ?? '')}`);
    expect(second.events.map((e) => e.id)).toEqual([...earlier].reverse());
    expect(second.nextBefore).toBeNull();
  });

  it('refuses a bad limit, action, time or id with 400', async () => {
    for (const query of ['limit=0', 'limit=201', 'limit=ten', 'action=member.promoted', 'before=yesterday', 'orgId=xyz', 'actorUserId=123']) {
      const res = await call(server, `/api/admin/audit?${query}`, { session: staff });
      expect({ query, ...(await errorOf(res)) }).toEqual({ query, status: 400, error: 'invalid_request' });
    }
  });
});
