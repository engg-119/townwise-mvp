// Tenant isolation through every route built so far: a member of organization A cannot read or write
// organization B. The route cases are generated from TOWNWISE_ROUTES, so new routes join them.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOWNWISE_ROUTES } from '../src/access/routes.ts';
import {
  addConversation, addInvite, addLocation, addNote, addRequest, addSalesDay, addSeat, addUpload, createOrg,
} from './helpers/fixtures.ts';
import { PROBE_ROUTES } from './helpers/probe.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

interface Tenant {
  orgId: string;
  name: string;
  admin: { email: string; session: TestSession };
  member: { email: string; session: TestSession };
  /** An open invitation for someone outside both organizations. */
  inviteId: string;
  /** The admin's and the member's seat ids. */
  seatIds: string[];
  /** A location with a sales day, an upload record, a note and a tuning chat conversation, both the member's. */
  locationId: string;
  locationName: string;
  noteId: string;
  conversationId: string;
}

let a: Tenant;
let b: Tenant;
/** B's invitation addressed to A's member. */
let bInvitesAMember: string;

async function tenant(name: string): Promise<Tenant> {
  const orgId = await createOrg(server, { name });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const admin = { email: adminEmail, session: await signIn(server, adminEmail) };
  const member = { email: memberEmail, session: await signIn(server, memberEmail) };
  const seatIds = [
    await addSeat(server, { orgId, userId: admin.session.userId, email: adminEmail, role: 'org_admin' }),
    await addSeat(server, { orgId, userId: member.session.userId, email: memberEmail }),
  ];
  const inviteId = await addInvite(server, { orgId, email: `outsider-${randomUUID().slice(0, 8)}@example.test`, invitedBy: admin.session.userId });
  const locationName = `${name} Main Room`;
  const locationId = await addLocation(server, { orgId, name: locationName });
  await addSalesDay(server, { orgId, locationId, date: '2026-05-01', guests: 140, netSalesCents: 512_300 });
  await addUpload(server, { orgId, locationId, uploadedAt: server.clock.now(), status: 'applied' });
  const noteId = await addNote(server, { orgId, locationId, detail: `${name} private note`, createdBy: member.session.userId });
  const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: `${name} private chat` });
  return { orgId, name, admin, member, inviteId, seatIds, locationId, locationName, noteId, conversationId };
}

/** Every Townwise document that belongs to B, serialized, so any change shows. */
async function snapshotOf(org: Tenant): Promise<string> {
  const orgId = new Types.ObjectId(org.orgId);
  const docs: unknown[] = [await server.connection.collection('tw_orgs').findOne({ _id: orgId })];
  for (const name of [
    'tw_members', 'tw_locations', 'tw_sales_days', 'tw_uploads', 'tw_notes', 'tw_view_as_grants', 'tw_audit_events',
    'tw_chat_conversations', 'tw_chat_live_turns', 'tw_chat_usage',
    // U11, statement moments.
    'tw_welcomes',
  ]) {
    docs.push(await server.connection.collection(name).find({ orgId }).sort({ _id: 1 }).toArray());
  }
  docs.push(await server.connection.collection('tw_access_requests')
    .find({ userId: { $in: [org.admin.session.userId, org.member.session.userId] } }).sort({ _id: 1 }).toArray());
  return JSON.stringify(docs);
}

beforeAll(async () => {
  server = await startTownwiseServer({ probe: PROBE_ROUTES });
  a = await tenant('Alpine Tavern');
  b = await tenant('Beachside Bistro');
  bInvitesAMember = await addInvite(server, { orgId: b.orgId, email: a.member.email, invitedBy: b.admin.session.userId });
  await addRequest(server, { userId: b.member.session.userId, email: b.member.email, status: 'withdrawn' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

/** Every id of B a request could carry, keyed by the names routes use. */
function bIds(): Record<string, string> {
  return {
    orgId: b.orgId, inviteId: b.inviteId, memberId: b.inviteId, userId: b.member.session.userId,
    locationId: b.locationId, noteId: b.noteId, conversationId: b.conversationId,
  };
}

/** What B's tenant data must never leak. */
function bSecrets(): string[] {
  return [b.orgId, b.name, b.admin.email, b.member.email, b.locationId, b.locationName, b.noteId, b.conversationId, `${b.name} private chat`];
}

function pathWithBIds(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => bIds()[name] ?? new Types.ObjectId().toHexString());
}

/**
 * Writes that carry none of B's ids (no path id, no body) and act on the caller's own seat, so they succeed. Each
 * entry is a deliberate exemption from the 4xx check; B's snapshot is still compared.
 */
const SELF_WRITES = new Set(['me.welcome']); // U11, statement moments.

describe('isolation through the route table', () => {
  for (const route of TOWNWISE_ROUTES) {
    it(`${route.method} /api${route.path}: A’s member presenting B’s ids reads nothing of B and changes nothing`, async () => {
      const before = await snapshotOf(b);
      const res = await call(server, `/api${pathWithBIds(route.path)}`, {
        method: route.method,
        session: a.member.session,
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: bIds() }),
      });
      const text = await res.text();
      if (SELF_WRITES.has(route.id)) expect(res.status).toBe(204);
      else if (route.method !== 'GET') expect(res.status).toBeGreaterThanOrEqual(400);
      for (const secret of [...bSecrets(), b.inviteId, bInvitesAMember]) expect(text).not.toContain(secret);
      expect(await snapshotOf(b)).toBe(before);
    });
  }
});

describe('isolation of id-bearing tenant routes, generated from the route table', () => {
  const tenantRoutesWithIds = TOWNWISE_ROUTES.filter((route) =>
    (route.policy === 'member' || route.policy === 'org_admin') && route.path.includes('/:'));

  // A valid body and query per route, so a 404 can only come from the foreign id.
  const NOTE = { kind: 'closure', startDate: '2026-05-04', endDate: '2026-05-04', weekdays: null, effect: 'closed', expectedGuests: null, detail: null };
  const BODY: Record<string, unknown> = {
    'org.members.update': { role: 'member' },
    'org.locations.update': { name: 'Renamed by A' },
    'org.sales.upload': { days: [{ date: '2026-05-02', guests: 1, netSalesCents: null }] },
    'org.notes.create': NOTE,
    'org.notes.update': NOTE,
    'org.chat.turn': { content: 'Hello from A' },
  };
  const QUERY: Record<string, string> = { 'org.sales.days': '?from=2026-01-01&to=2026-05-31' };

  it('covers the team, location, sales, note and tuning chat routes', () => {
    expect(tenantRoutesWithIds.map((route) => route.id)).toEqual(expect.arrayContaining([
      'org.members.update', 'org.members.remove', 'org.locations.update', 'org.locations.remove', 'org.sales.get',
      'org.sales.days', 'org.sales.upload', 'org.sales.remove', 'org.notes.list', 'org.notes.create', 'org.notes.update',
      'org.notes.remove', 'org.chat.get', 'org.chat.conversation', 'org.chat.turn', 'org.chat.remove',
    ]));
  });

  for (const route of tenantRoutesWithIds) {
    it(`${route.method} /api${route.path}: A’s org admin presenting any of B’s ids, with A’s own ids elsewhere, gets 404 not_found, and B is unchanged`, async () => {
      const bOwn: Record<string, string[]> = {
        memberId: [b.inviteId, ...b.seatIds], locationId: [b.locationId], noteId: [b.noteId], conversationId: [b.conversationId],
      };
      const aOwn: Record<string, string> = {
        memberId: a.inviteId, locationId: a.locationId, noteId: a.noteId, conversationId: a.conversationId,
      };
      const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? '');
      let cases = 0;
      for (const foreign of params) {
        for (const id of bOwn[foreign] ?? []) {
          cases += 1;
          const before = await snapshotOf(b);
          const path = route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => (name === foreign ? id : aOwn[name] ?? ''));
          const res = await call(server, `/api${path}${QUERY[route.id] ?? ''}`, {
            method: route.method,
            session: a.admin.session,
            ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: BODY[route.id] ?? {} }),
          });
          const text = await res.text();
          expect({ case: `${foreign}=${id}`, status: res.status }).toEqual({ case: `${foreign}=${id}`, status: 404 });
          expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
          for (const secret of bSecrets()) expect(text).not.toContain(secret);
          expect(await snapshotOf(b)).toBe(before);
        }
      }
      expect(cases).toBeGreaterThan(0);
    });
  }
});

describe('isolation, case by case', () => {
  it('GET /api/me shows A’s member only A, even though B invited them', async () => {
    const res = await call(server, '/api/me', { session: a.member.session });
    expect(await res.json()).toMatchObject({ access: { state: 'member', org: { id: a.orgId, name: a.name }, role: 'member' } });
  });

  it('joining B’s invitation addressed to someone else is 409 no_invite', async () => {
    const res = await call(server, '/api/me/join', { session: a.member.session, json: { inviteId: b.inviteId } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_invite' });
  });

  it('joining B’s invitation addressed to A’s member is 409 already_in_org, and both organizations are unchanged', async () => {
    const beforeA = await snapshotOf(a);
    const beforeB = await snapshotOf(b);
    const res = await call(server, '/api/me/join', { session: a.member.session, json: { inviteId: bInvitesAMember } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_in_org' });
    expect(await snapshotOf(a)).toBe(beforeA);
    expect(await snapshotOf(b)).toBe(beforeB);
  });

  it('declining B’s invitation addressed to someone else is 409 no_invite', async () => {
    const res = await call(server, '/api/me/decline', { session: a.admin.session, json: { inviteId: b.inviteId } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_invite' });
  });

  it('a member route takes the organization only from the principal, never from the request', async () => {
    const read = await call(server, `/probe/member?orgId=${b.orgId}`, { session: a.member.session });
    expect(await read.json()).toEqual({ kind: 'member', orgId: a.orgId, role: 'member' });
    const write = await call(server, '/probe/member', { session: a.member.session, json: { orgId: b.orgId } });
    expect(await write.json()).toEqual({ kind: 'member', orgId: a.orgId, role: 'member' });
    const admin = await call(server, '/probe/org-admin', { session: b.admin.session });
    expect(await admin.json()).toEqual({ kind: 'member', orgId: b.orgId, role: 'org_admin' });
  });

  it('org_admin routes answer 403 forbidden to a member and 403 no_access to someone with no organization', async () => {
    const member = await call(server, '/probe/org-admin', { session: a.member.session });
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: 'forbidden' });
    const outsider = await signIn(server, `outside-${randomUUID().slice(0, 8)}@example.test`);
    const res = await call(server, '/probe/org-admin', { session: outsider });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'no_access' });
  });

  it('a removed member’s next member request is 403 no_access', async () => {
    const before = await call(server, '/probe/member', { session: b.member.session });
    expect(before.status).toBe(200);
    await server.connection.collection('tw_members').updateOne(
      { activeUserId: b.member.session.userId },
      { $set: { status: 'removed', removedAt: server.clock.now(), removedBy: b.admin.session.userId }, $unset: { activeUserId: '' } },
    );
    const after = await call(server, '/probe/member', { session: b.member.session });
    expect(after.status).toBe(403);
    expect(await after.json()).toMatchObject({ error: 'no_access' });
  });
});
