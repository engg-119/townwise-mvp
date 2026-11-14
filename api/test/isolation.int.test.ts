// Tenant isolation through every route built so far: a member of organization A cannot read or write
// organization B. The route cases are generated from TOWNWISE_ROUTES, so new routes join them.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { TOWNWISE_ROUTES, type TownwiseRoute } from '../src/access/routes.ts';
import { ORDER_CHANGE_RESULT } from '../src/chat/tools/orders.ts';
import { createItemReader } from '../src/files/items.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { createTownwiseStores } from '../src/stores/index.ts';
import {
  addConversation, addInvite, addLocation, addNote, addOpenAsAdminGrant, addOrderRecords, addRequest, addSalesDay, addSeat, addUpload,
  createOrg, ORDER_COLLECTIONS,
} from './helpers/fixtures.ts';
import { seedReadFile } from './helpers/files.ts';
import { PROBE_ROUTES } from './helpers/probe.ts';
import { call, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;

interface Tenant {
  orgId: string;
  name: string;
  admin: { email: string; session: TestSession };
  member: { email: string; session: TestSession };
  /** An open invitation for someone outside both organizations. */
  inviteId: string;
  /** The admin's and the member's seat ids. */
  seatIds: string[];
  /**
   * A location with a sales day, an upload record, a note and a tuning chat conversation, both the member's. The
   * conversation also holds a note proposal, `toolu_proposal0001`, a proposal to keep text, `toolu_item0001` (D28),
   * and an order change, `toolu_order0001`, all shown to the member. The location has a row in each of ordering's six
   * collections: an edit, a rule, the order change's card (set aside), the setup, a day of item sales and a count.
   */
  locationId: string;
  locationName: string;
  noteId: string;
  conversationId: string;
  /** A read file of the location (original and cleaned copy stored) and its import. */
  fileId: string;
  importId: string;
  /** D28: the location's upload record, an item on Your data. */
  uploadId: string;
  /** D28: an item kept for reference at the location (a text file with no import and no upload), the member's. */
  refFileId: string;
}

/**
 * D25: an organization nobody has joined, made from fixtures with no seat, which staff have open as its admin. Its
 * location's note, conversation (with the same proposal as A's and B's), read file and import are the staff member's.
 */
interface SetupTenant {
  orgId: string;
  /** Its open org admin invitation. */
  inviteId: string;
  locationId: string;
  noteId: string;
  conversationId: string;
  fileId: string;
  importId: string;
  /** D28: its upload record and an item kept for reference, as A's and B's. */
  uploadId: string;
  refFileId: string;
}

let a: Tenant;
let b: Tenant;
let c: SetupTenant;
/** A staff session holding an open-as-admin grant on C. */
let staffSession: TestSession;
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
  const uploadId = await addUpload(server, { orgId, locationId, uploadedAt: server.clock.now(), status: 'applied' });
  const noteId = await addNote(server, { orgId, locationId, detail: `${name} private note`, createdBy: member.session.userId });
  const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: `${name} private chat` });
  const fileId = await seedReadFile(server, blobs, {
    orgId, locationId, uploadedBy: member.session.userId, name: `${name} sales.csv`, raw: Buffer.from('Date,Guests\n'), clean: 'date,guests,net_sales\r\n',
  });
  const importId = String((await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) }))?.importId);
  const refFileId = await addReferenceItem(orgId, locationId, member.session.userId, name);
  await withProposal(conversationId, name);
  await addOrderRecords(server, { orgId, locationId, conversationId });
  // U9: an answer to a TownwiseAI question.
  await server.connection.collection('tw_agent_answers').insertOne({
    orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), questionId: 'gap_2026-05-02_2026-05-03',
    answer: 'open', noteId: new Types.ObjectId(), status: 'done', createdAt: server.clock.now(), updatedAt: server.clock.now(),
  });
  return {
    orgId, name, admin, member, inviteId, seatIds, locationId, locationName, noteId, conversationId, fileId, importId, uploadId, refFileId,
  };
}

/** C, in setup (D23): active, with only an open invitation, so nobody has ever joined it. */
async function setupTenant(name: string, staffUserId: string): Promise<SetupTenant> {
  const orgId = await createOrg(server, { name });
  const inviteId = await addInvite(server, {
    orgId, email: `first-admin-${randomUUID().slice(0, 8)}@example.test`, invitedBy: staffUserId, role: 'org_admin', addedByStaff: true,
  });
  const locationId = await addLocation(server, { orgId, name: `${name} Front Room` });
  const noteId = await addNote(server, { orgId, locationId, detail: `${name} setup note`, createdBy: staffUserId });
  const uploadId = await addUpload(server, { orgId, locationId, uploadedAt: server.clock.now(), status: 'applied' });
  const conversationId = await addConversation(server, { orgId, locationId, userId: staffUserId, text: `${name} setup chat` });
  await withProposal(conversationId, name);
  const fileId = await seedReadFile(server, blobs, {
    orgId, locationId, uploadedBy: staffUserId, name: `${name} sales.csv`, raw: Buffer.from('Date,Guests\n'), clean: 'date,guests,net_sales\r\n',
  });
  const importId = String((await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) }))?.importId);
  const refFileId = await addReferenceItem(orgId, locationId, staffUserId, name);
  return { orgId, inviteId, locationId, noteId, conversationId, fileId, importId, uploadId, refFileId };
}

/** D28: a `.txt` item kept for reference, as Your data's Paste text leaves one, and its original in the memory blobs. */
async function addReferenceItem(orgId: string, locationId: string, uploadedBy: string, name: string): Promise<string> {
  const _id = new Types.ObjectId();
  const raw = Buffer.from(`${name} reference text`);
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), importId: null, purpose: 'reference',
    uploadedBy, uploaderRole: 'member', uploadedAt: server.clock.now(), name: `${name} private item.txt`, kind: 'text',
    sizeBytes: raw.length, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference',
    progress: null, readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null,
    rawDeletedAt: null, attempts: 0,
  });
  await blobs.writeRaw({ orgId } as unknown as OrgScope, { locationId, fileId: _id.toHexString() }, raw, 'text/plain');
  return _id.toHexString();
}

/**
 * Appends a turn in which TownwiseAI proposed a note, `toolu_proposal0001`, keeping the tenant's private text,
 * `toolu_item0001`, and an order change, `toolu_order0001`, all shown to the owner.
 */
async function withProposal(conversationId: string, name: string): Promise<void> {
  const at = server.clock.now();
  const note = { kind: 'closure', startDate: '2026-05-04', endDate: '2026-05-04', weekdays: null, effect: 'closed', expectedGuests: null, detail: null };
  const item = { title: 'Catering list', text: `${name} private item` };
  const params = [
    { role: 'user', content: 'We close on May 4.' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_proposal0001', name: 'propose_note', input: note },
      { type: 'tool_use', id: 'toolu_item0001', name: 'propose_data_item', input: item },
      { type: 'tool_use', id: 'toolu_order0001', name: 'propose_order_change', input: { itemId: 'a'.repeat(24), delivery: '2026-06-03' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_proposal0001', content: 'Shown to the owner as a proposal.' },
      { type: 'tool_result', tool_use_id: 'toolu_item0001', content: 'Shown to the owner as a proposal. They decide whether to keep it.' },
      { type: 'tool_result', tool_use_id: 'toolu_order0001', content: ORDER_CHANGE_RESULT },
    ] },
    { role: 'assistant', content: [{ type: 'text', text: 'Proposed.' }] },
  ];
  await server.connection.collection('tw_chat_conversations').updateOne(
    { _id: new Types.ObjectId(conversationId) },
    { $push: { messages: { $each: params.map((param) => ({ at, param: JSON.stringify(param) })) } } } as Record<string, unknown>,
  );
}

/** Every Townwise document that belongs to B, serialized, so any change shows. */
async function snapshotOf(org: Tenant): Promise<string> {
  const orgId = new Types.ObjectId(org.orgId);
  const docs: unknown[] = [await server.connection.collection('tw_orgs').findOne({ _id: orgId })];
  for (const name of [
    'tw_members', 'tw_locations', 'tw_sales_days', 'tw_uploads', 'tw_notes', 'tw_view_as_grants', 'tw_audit_events',
    'tw_chat_conversations', 'tw_chat_live_turns', 'tw_chat_usage', 'tw_chat_proposals', 'tw_files', 'tw_imports',
    'tw_upload_days',
    // U11, statement moments.
    'tw_welcomes',
    // U9, TownwiseAI's questions.
    'tw_agent_answers',
    // Orders: edits, rules, cards, setups, item sales and counts.
    ...ORDER_COLLECTIONS,
  ]) {
    docs.push(await server.connection.collection(name).find({ orgId }).sort({ _id: 1 }).toArray());
  }
  docs.push(await server.connection.collection('tw_access_requests')
    .find({ userId: { $in: [org.admin.session.userId, org.member.session.userId] } }).sort({ _id: 1 }).toArray());
  return JSON.stringify(docs);
}

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ probe: PROBE_ROUTES, files: blobs });
  a = await tenant('Alpine Tavern');
  b = await tenant('Beachside Bistro');
  bInvitesAMember = await addInvite(server, { orgId: b.orgId, email: a.member.email, invitedBy: b.admin.session.userId });
  await addRequest(server, { userId: b.member.session.userId, email: b.member.email, status: 'withdrawn' });
  staffSession = await signInStaff(server);
  c = await setupTenant('Cedar Cafe', staffSession.userId);
  await addOpenAsAdminGrant(server, { actorUserId: staffSession.userId, sessionId: staffSession.sessionId, orgId: c.orgId });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

/** Every id of B a request could carry, keyed by the names routes use. */
function bIds(): Record<string, string> {
  return {
    orgId: b.orgId, inviteId: b.inviteId, memberId: b.inviteId, userId: b.member.session.userId,
    locationId: b.locationId, noteId: b.noteId, conversationId: b.conversationId, fileId: b.fileId, importId: b.importId,
    ref: `u_${b.uploadId}`,
  };
}

/** What B's tenant data must never leak. */
function bSecrets(): string[] {
  return [
    b.orgId, b.name, b.admin.email, b.member.email, b.locationId, b.locationName, b.noteId, b.conversationId, `${b.name} private chat`,
    b.fileId, b.importId, b.uploadId, `${b.name} private item`, b.refFileId, `${b.name} private item.txt`, `${b.name} reference text`,
  ];
}

function pathWithBIds(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => bIds()[name] ?? new Types.ObjectId().toHexString());
}

/**
 * Writes that carry none of B's ids (no path id, no body) and act on the caller's own seat, so they succeed. Each
 * entry is a deliberate exemption from the 4xx check; B's snapshot is still compared.
 */
const SELF_WRITES = new Set(['me.welcome']); // U11, statement moments.

/** Calls `route` as `session` with B's ids in its path (and, on a write, its body). Nothing of B shows and B is unchanged. */
async function presentBIds(route: TownwiseRoute, session: TestSession): Promise<number> {
  const before = await snapshotOf(b);
  const res = await call(server, `/api${pathWithBIds(route.path)}`, {
    method: route.method,
    session,
    ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { json: bIds() }),
  });
  const text = await res.text();
  for (const secret of [...bSecrets(), b.inviteId, bInvitesAMember]) expect(text).not.toContain(secret);
  expect(await snapshotOf(b)).toBe(before);
  return res.status;
}

describe('isolation through the route table', () => {
  for (const route of TOWNWISE_ROUTES) {
    it(`${route.method} /api${route.path}: A’s member presenting B’s ids reads nothing of B and changes nothing`, async () => {
      const status = await presentBIds(route, a.member.session);
      if (SELF_WRITES.has(route.id)) expect(status).toBe(204);
      else if (route.method !== 'GET') expect(status).toBeGreaterThanOrEqual(400);
    });
  }
});

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
  'org.files.create': { name: 'a.csv', sizeBytes: 10, purpose: 'history' },
  'org.data.text': { title: 'a', text: 'a' },
  'org.imports.answer': { questionId: 'q', choice: 'not_sure' },
  'org.chat.proposal': { action: 'dismiss' },
  'org.chat.item_proposal': { action: 'dismiss' },
  'org.chat.rename': { title: 'Renamed by A' },
  'org.chat.active': { nodeId: 'legacy-0' },
  'org.chat.feedback': { rating: 'up' },
  'org.agent.answer': { answer: 'not_sure' },
  // D28.
  'org.data.update': { enabled: false },
  'org.data.replace': { fileId: new Types.ObjectId().toHexString() },
  // Orders.
  'org.orders.decision': { itemId: 'a'.repeat(24), delivery: '2026-06-03', quantity: 1, reason: 'Order from A' },
  'org.orders.rule': { itemId: 'a'.repeat(24), situation: 'Order from A' },
  'org.orders.rule_off': { ruleId: new Types.ObjectId().toHexString() },
  'org.orders.setup.save': { expectedVersion: 1, setup: { suppliers: [], items: [] } },
  'org.orders.item_sales.upload': { from: '2026-05-01', to: '2026-05-01', days: [] },
  'org.orders.counts.save': { date: '2026-05-31', items: { ['a'.repeat(24)]: 1 } },
  'org.chat.order_proposal': { action: 'dismiss' },
};
const QUERY: Record<string, string> = {
  'org.sales.days': '?from=2026-01-01&to=2026-05-31', 'org.calendar.get': '?from=2026-01-01&to=2026-05-31',
  // U13A.
  'org.people.get': '?from=2026-05-01&to=2026-05-31',
  // U13B.
  'org.forecast.get': '?from=2026-05-01&to=2026-05-31',
};

/**
 * Calls `route` as `session` once for each of B's ids in each of its path positions, with `own` (ids of the caller's
 * own organization) everywhere else: each answers 404 not_found, shows nothing of B and leaves B unchanged.
 */
async function expectForeignIdsNotFound(route: TownwiseRoute, session: TestSession, own: Record<string, string>): Promise<void> {
  const bOwn: Record<string, string[]> = {
    memberId: [b.inviteId, ...b.seatIds], locationId: [b.locationId], noteId: [b.noteId], conversationId: [b.conversationId],
    fileId: [b.fileId], importId: [b.importId], ref: [`u_${b.uploadId}`, `f_${b.refFileId}`],
  };
  const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? '');
  // Every other segment is the caller's own, so the request reaches the route: an empty one would match no route, and
  // its 404 would come from the app, not from the foreign id.
  expect(params.filter((name) => own[name] === undefined)).toEqual([]);
  let cases = 0;
  for (const foreign of params) {
    for (const id of bOwn[foreign] ?? []) {
      cases += 1;
      const before = await snapshotOf(b);
      const path = route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => (name === foreign ? id : own[name] ?? ''));
      const res = await call(server, `/api${path}${QUERY[route.id] ?? ''}`, {
        method: route.method,
        session,
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
}

/** The path ids of an organization's own records, and the ids no organization owns, for `route`. */
function ownIds(
  org: Pick<Tenant, 'inviteId' | 'locationId' | 'noteId' | 'conversationId' | 'fileId' | 'importId' | 'uploadId'>, route: TownwiseRoute,
): Record<string, string> {
  return {
    memberId: org.inviteId, locationId: org.locationId, noteId: org.noteId, conversationId: org.conversationId, fileId: org.fileId,
    importId: org.importId, index: '0', questionId: 'gap_2026-05-02_2026-05-03',
    // D28: a proposal to keep text is its own call, and so is an order change.
    proposalId: route.id.startsWith('org.chat.item_proposal') ? 'toolu_item0001'
      : route.id.startsWith('org.chat.order_proposal') ? 'toolu_order0001' : 'toolu_proposal0001',
    ref: `u_${org.uploadId}`,
    // The reply of the organization's conversation (its stored messages have no tree, so their nodes are legacy-{index}).
    nodeId: 'legacy-1',
  };
}

describe('isolation of id-bearing tenant routes, generated from the route table', () => {
  it('covers the team, location, sales, note, tuning chat, proposal and order routes', () => {
    expect(tenantRoutesWithIds.map((route) => route.id)).toEqual(expect.arrayContaining([
      'org.members.update', 'org.members.remove', 'org.locations.update', 'org.locations.remove', 'org.sales.get',
      'org.sales.days', 'org.sales.upload', 'org.sales.remove', 'org.notes.list', 'org.notes.create', 'org.notes.update',
      'org.notes.remove', 'org.sales.history', 'org.calendar.get', 'org.chat.get', 'org.chat.conversation', 'org.chat.turn', 'org.chat.remove',
      'org.chat.proposal', 'org.chat.rename', 'org.chat.active', 'org.chat.feedback',
      'org.files.create', 'org.files.chunk', 'org.files.complete', 'org.files.list', 'org.files.get', 'org.files.raw', 'org.files.clean',
      'org.files.remove_raw', 'org.files.remove', 'org.imports.current', 'org.imports.get', 'org.imports.start', 'org.imports.answer',
      // U3 stages 5 to 9.
      'org.files.entries', 'org.originals.remove', 'org.data.text',
      'org.agent.get', 'org.agent.answer',
      'org.people.get', 'org.estimates.about',
      // U13B.
      'org.forecast.get',
      // D28, Your data.
      'org.data.update', 'org.data.remove', 'org.chat.item_proposal.get', 'org.chat.item_proposal', 'org.data.replace', 'org.data.get',
      // Orders.
      'org.orders.get', 'org.orders.decision', 'org.orders.rule', 'org.orders.rule_off', 'org.orders.setup.get', 'org.orders.setup.save',
      'org.orders.item_sales.upload', 'org.orders.item_sales.remove', 'org.orders.counts.save', 'org.chat.order_proposal.get',
      'org.chat.order_proposal',
    ]));
  });

  for (const route of tenantRoutesWithIds) {
    it(`${route.method} /api${route.path}: A’s org admin presenting any of B’s ids, with A’s own ids elsewhere, gets 404 not_found, and B is unchanged`, async () => {
      await expectForeignIdsNotFound(route, a.admin.session, ownIds(a, route));
    });
  }
});

describe('isolation while staff have an organization open as admin', () => {
  it('the staff session is open as admin of C', async () => {
    const res = await call(server, '/api/me', { session: staffSession });
    expect(await res.json()).toMatchObject({ access: { state: 'member', org: { id: c.orgId }, role: 'org_admin' }, openAsAdmin: { org: { id: c.orgId } } });
  });

  // End (admin.view_as.end) would end the grant for every later case; open-as-admin-routes.int.test.ts covers it.
  for (const route of TOWNWISE_ROUTES.filter((r) => r.id !== 'admin.view_as.end')) {
    it(`${route.method} /api${route.path}: staff open as admin of C presenting B’s ids read nothing of B and change nothing`, async () => {
      const status = await presentBIds(route, staffSession);
      // Only the reads that carry no id answer, and they answer C's (/api/me, the organization, its staff activity).
      if (route.method === 'GET' && route.openAsAdmin === true && !route.path.includes('/:')) expect(status).toBe(200);
      else expect(status).toBeGreaterThanOrEqual(400);
    });
  }

  for (const route of tenantRoutesWithIds.filter((r) => r.openAsAdmin === true)) {
    it(`${route.method} /api${route.path}: staff open as admin of C presenting any of B’s ids, with C’s own ids elsewhere, get 404 not_found`, async () => {
      await expectForeignIdsNotFound(route, staffSession, ownIds(c, route));
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

  it('A’s member cannot save or set aside B’s proposals by any mix of ids, though they can act on their own', async () => {
    const before = await snapshotOf(b);
    const proposals = server.connection.collection('tw_chat_proposals');
    const mixes = [
      [b.locationId, b.conversationId], [a.locationId, b.conversationId], [b.locationId, a.conversationId],
    ] as const;
    for (const [location, conversation] of mixes) {
      for (const json of [{ action: 'save' }, { action: 'dismiss' }]) {
        const res = await call(server, `/api/org/locations/${location}/chat/${conversation}/proposals/toolu_proposal0001`, {
          session: a.member.session, json,
        });
        const text = await res.text();
        expect({ location, conversation, status: res.status }).toEqual({ location, conversation, status: 404 });
        for (const secret of bSecrets()) expect(text).not.toContain(secret);
      }
    }
    expect(await snapshotOf(b)).toBe(before);
    const own = await call(server, `/api/org/locations/${a.locationId}/chat/${a.conversationId}/proposals/toolu_proposal0001`, {
      session: a.member.session, json: { action: 'dismiss' },
    });
    expect(own.status).toBe(200);
    await proposals.deleteMany({ orgId: new Types.ObjectId(a.orgId) });
  });

  it('A’s member cannot see, keep or set aside B’s proposals to keep text by any mix of ids, though they can their own', async () => {
    const before = await snapshotOf(b);
    const mixes = [
      [b.locationId, b.conversationId], [a.locationId, b.conversationId], [b.locationId, a.conversationId],
    ] as const;
    for (const [location, conversation] of mixes) {
      const path = `/api/org/locations/${location}/chat/${conversation}/item-proposals/toolu_item0001`;
      for (const json of [undefined, { action: 'save' }, { action: 'dismiss' }]) {
        const res = await call(server, path, { session: a.member.session, ...(json === undefined ? {} : { json }) });
        const text = await res.text();
        expect({ location, conversation, json, status: res.status }).toEqual({ location, conversation, json, status: 404 });
        for (const secret of bSecrets()) expect(text).not.toContain(secret);
      }
    }
    expect(await snapshotOf(b)).toBe(before);
    const own = `/api/org/locations/${a.locationId}/chat/${a.conversationId}/item-proposals/toolu_item0001`;
    expect(await (await call(server, own, { session: a.member.session })).json()).toMatchObject({
      proposal: { id: 'toolu_item0001', text: `${a.name} private item`, status: 'open' },
    });
    expect((await call(server, own, { session: a.member.session, json: { action: 'dismiss' } })).status).toBe(200);
    await server.connection.collection('tw_chat_proposals').deleteMany({ orgId: new Types.ObjectId(a.orgId) });
  });

  it('declining B’s invitation addressed to someone else is 409 no_invite', async () => {
    const res = await call(server, '/api/me/decline', { session: a.admin.session, json: { inviteId: b.inviteId } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_invite' });
  });

  it('GET /api/org/data with B’s location id answers 404, and without one lists none of B', async () => {
    const before = await snapshotOf(b);
    for (const session of [a.member.session, a.admin.session]) {
      const foreign = await call(server, `/api/org/data?locationId=${b.locationId}`, { session });
      const text = await foreign.text();
      expect(foreign.status).toBe(404);
      expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
      for (const secret of bSecrets()) expect(text).not.toContain(secret);
      const own = await call(server, '/api/org/data', { session });
      const listed = await own.text();
      expect(own.status).toBe(200);
      // Exactly A's upload and A's item kept for reference: the org-wide list's files half has only orgId to scope it.
      const { items } = JSON.parse(listed) as { items: { ref: string; locationId: string }[] };
      expect(items.map((item) => item.ref).sort()).toEqual([`f_${a.refFileId}`, `u_${a.uploadId}`]);
      expect(items.every((item) => item.locationId === a.locationId)).toBe(true);
      for (const secret of bSecrets()) expect(listed).not.toContain(secret);
    }
    expect(await snapshotOf(b)).toBe(before);
  });

  it('TownwiseAI’s item reader, in A’s scope, finds none of B’s items by any mix of location ids', async () => {
    const reader = createItemReader(createTownwiseStores(server.connection), blobs);
    const scope = { orgId: a.orgId } as unknown as OrgScope;
    expect(await reader.readText(scope, a.locationId, b.refFileId)).toEqual({ status: 'not_found' });
    expect(await reader.readText(scope, b.locationId, b.refFileId)).toEqual({ status: 'not_found' });
    expect(await reader.readText(scope, a.locationId, a.refFileId)).toEqual({ status: 'ok', text: `${a.name} reference text`, truncated: false });
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
