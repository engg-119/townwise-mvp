// The ordering setup card of a stored propose_order_setup call (spec D56), through the API with memory blobs: what its
// GET answers, who it answers, that it stops once the file is off, deleted or no longer the caller's to read, and that
// it can only be set aside. The calls are seeded as a turn stores them: phase B wires the tool into the turn and adds
// the turn-driven tests here. Synthetic content only.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { addConversation, addGrant, addLocation, addSeat, auditEvents, createOrg, ORDER_COLLECTIONS } from './helpers/fixtures.ts';
import { call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const blobs = createMemoryFileBlobs();
let server: TownwiseTestServer;
let orgId: string;
let author: TestSession;
let teammate: TestSession;
let admin: TestSession;
let outsider: TestSession;
let locationId: string;

const CALL = 'toolu_order_setup1';
const REGISTER_NAME = 'Sentinel-register-name';
const GUIDE = 'Quillvane Beverage order guide\nVorlan Brewing IPA 1/2 BBL\nDelivers Tuesday, order by Sunday 2pm';
const SUPPLIER = { name: 'Quillvane Beverage', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 0, cutoffTime: '14:00' }] };
const ITEM = {
  name: 'Vorlan Brewing IPA', supplier: 'Quillvane Beverage', category: 'draft', unit: 'kegs', servingsPerUnit: 124,
  servingsEstimated: true, dealSize: null, note: '',
};
const STOUT = { ...ITEM, name: 'Sentinel Stout', servingsPerUnit: null, servingsEstimated: false };

/** The input as the model wrote it, with what it must never bring: a par, a never run out and a register name. */
function input(ref: string): Record<string, unknown> {
  return {
    ref, kind: 'order_guide', confidence: 'high', suppliers: [SUPPLIER], itemsCut: false,
    items: [{ ...ITEM, par: 4, neverRunOut: true, posNames: [{ name: REGISTER_NAME, perSale: 1 }] }, STOUT],
  };
}

/** The result the tool wrote for it: the stout's name is not in the text sent. */
const SHOWN = JSON.stringify({
  shown: true, supplierCount: 1, itemCount: 2, namesChecked: true, notInFile: ['sentinel stout'], partial: false, itemsCut: false, readWeb: true,
});

/** The card's `read`: the checked suggestions, each name's inFile laid over. */
const READ = {
  kind: 'order_guide', confidence: 'high', suppliers: [SUPPLIER], itemsCut: false, partial: false,
  items: [{ ...ITEM, posNames: [], inFile: true }, { ...STOUT, posNames: [], inFile: false }],
};

/** A file of Your data, its original in the memory blobs. Resolves its ref. */
async function seed(over: Record<string, unknown> = {}, at = locationId): Promise<string> {
  const _id = new Types.ObjectId();
  const bytes = Buffer.from(GUIDE);
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(at), importId: null, purpose: 'reference',
    uploadedBy: author.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'Guide.txt', kind: 'text',
    sizeBytes: bytes.length, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference',
    progress: null, readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null,
    rawDeletedAt: null, attempts: 0, ...over,
  });
  await blobs.writeRaw({ orgId } as unknown as OrgScope, { locationId: at, fileId: _id.toHexString() }, bytes, 'application/octet-stream');
  return `f_${_id.toHexString()}`;
}

interface StoredCall { id: string; name?: string; input: unknown; result: string; isError?: boolean }

/** A conversation of `owner` holding these tool calls and their results, as a turn stores them. */
async function conversationWith(calls: readonly StoredCall[], owner = author, at = locationId): Promise<string> {
  const conversationId = await addConversation(server, { orgId, locationId: at, userId: owner.userId, text: 'Set up my orders from this guide' });
  const now = server.clock.now();
  const params = [
    { role: 'assistant', content: calls.map((each) => ({ type: 'tool_use', id: each.id, name: each.name ?? 'propose_order_setup', input: each.input })) },
    {
      role: 'user',
      content: calls.map((each) => ({ type: 'tool_result', tool_use_id: each.id, content: each.result, ...(each.isError === true ? { is_error: true } : {}) })),
    },
  ];
  await server.connection.collection('tw_chat_conversations').updateOne(
    { _id: new Types.ObjectId(conversationId) },
    { $push: { messages: { $each: params.map((param) => ({ at: now, param: JSON.stringify(param) })) } } } as Record<string, unknown>,
  );
  return conversationId;
}

function cardPath(conversationId: string, id = CALL, at = locationId): string {
  return `/api/org/locations/${at}/chat/${conversationId}/order-proposals/${id}`;
}

async function getCard(conversationId: string, session = author, id = CALL): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(server, cardPath(conversationId, id), { session });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function act(conversationId: string, json: unknown, session = author): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(server, cardPath(conversationId), { session, json });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function cardEvents(conversationId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) =>
    String(event.action).startsWith('order.card_') && (event.details as { conversationId?: string }).conversationId === conversationId);
}

/** The location's rows in ordering's collections but the cards, serialized, so any write to the setup shows. */
async function orderRowsButCards(): Promise<string> {
  const docs: unknown[] = [];
  for (const name of ORDER_COLLECTIONS.filter((each) => each !== 'tw_order_cards')) {
    docs.push(await server.connection.collection(name).find({ locationId: new Types.ObjectId(locationId) }).sort({ _id: 1 }).toArray());
  }
  return JSON.stringify(docs);
}

const NOT_FOUND = { status: 404, body: { error: 'not_found', message: 'Not found' } };

beforeAll(async () => {
  server = await startTownwiseServer({ files: blobs });
  orgId = await createOrg(server, { name: 'Setup Card Tavern' });
  const join = async (name: string, role: 'member' | 'org_admin', org = orgId): Promise<TestSession> => {
    const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId: org, userId: session.userId, email, role });
    return session;
  };
  author = await join('author', 'member');
  teammate = await join('teammate', 'member');
  admin = await join('admin', 'org_admin');
  outsider = await join('outsider', 'org_admin', await createOrg(server, { name: 'Other Tavern' }));
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  locationId = await addLocation(server, { orgId, name: `Taproom ${randomUUID().slice(0, 8)}` });
});

describe('the ordering setup card', () => {
  it('a shown propose_order_setup call’s GET answers the checked suggestions with each name’s inFile, never a par, a never run out or a point-of-sale name', async () => {
    const ref = await seed();
    const conversationId = await conversationWith([{ id: CALL, input: input(ref), result: SHOWN }]);
    const card = await getCard(conversationId);
    expect(card).toEqual({ status: 200, body: { proposal: { kind: 'setup', status: 'open', read: READ, readWeb: true } } });
    expect(JSON.stringify(card.body)).not.toMatch(/Sentinel-register|"par"|neverRunOut|f_[0-9a-f]{24}/);
    // The GET stores nothing.
    expect(await server.connection.collection('tw_order_cards').countDocuments({ conversationId: new Types.ObjectId(conversationId) })).toBe(0);

    // A picture's names were never checked: each inFile is null.
    const unchecked = JSON.stringify({ ...JSON.parse(SHOWN) as object, namesChecked: false, notInFile: [], readWeb: false });
    const picture = await conversationWith([{ id: CALL, input: input(ref), result: unchecked }]);
    expect((await getCard(picture)).body).toEqual({
      proposal: { kind: 'setup', status: 'open', readWeb: false, read: { ...READ, items: READ.items.map((item) => ({ ...item, inFile: null })) } },
    });
  });

  it('is 404 for another member’s conversation, another organization’s location, a call that showed nothing and an unknown id', async () => {
    const ref = await seed();
    const refused = JSON.stringify({ shown: false, reason: 'Nothing was shown to the owner.' });
    const conversationId = await conversationWith([
      { id: CALL, input: input(ref), result: SHOWN },
      { id: 'toolu_refused', input: input(ref), result: refused },
      { id: 'toolu_failed', input: input(ref), result: SHOWN, isError: true },
      { id: 'toolu_bad_ref', input: input('u_0000000000000000000000a1'), result: SHOWN },
      { id: 'toolu_other_tool', name: 'read_data_item', input: input(ref), result: SHOWN },
    ]);
    expect((await getCard(conversationId)).status).toBe(200);
    for (const session of [teammate, admin, outsider]) {
      expect(await getCard(conversationId, session)).toEqual(NOT_FOUND);
      expect(await act(conversationId, { action: 'dismiss' }, session)).toEqual(NOT_FOUND);
    }
    for (const id of ['toolu_refused', 'toolu_failed', 'toolu_bad_ref', 'toolu_other_tool', 'toolu_unknown']) {
      expect({ id, ...(await getCard(conversationId, author, id)) }).toEqual({ id, ...NOT_FOUND });
    }
    expect((await getCard(conversationId, author, 'bad.id')).status).toBe(400);
    expect(await cardEvents(conversationId)).toEqual([]);
  });

  it('is 404 once the file is turned off, its original is deleted, or the caller is neither its uploader nor an org admin', async () => {
    const files = server.connection.collection('tw_files');
    for (const change of [{ disabledAt: server.clock.now(), disabledBy: author.userId }, { rawDeletedAt: server.clock.now() }, { status: 'deleting' }]) {
      const ref = await seed();
      const conversationId = await conversationWith([{ id: CALL, input: input(ref), result: SHOWN }]);
      expect((await getCard(conversationId)).status).toBe(200);
      await files.updateOne({ _id: new Types.ObjectId(ref.slice(2)) }, { $set: change });
      expect({ change: Object.keys(change), ...(await getCard(conversationId)) }).toEqual({ change: Object.keys(change), ...NOT_FOUND });
      expect(await act(conversationId, { action: 'dismiss' })).toEqual(NOT_FOUND);
      expect(await cardEvents(conversationId)).toEqual([]);
    }
    // A file gone altogether, and one of another location.
    const gone = await conversationWith([{ id: CALL, input: input(`f_${new Types.ObjectId().toHexString()}`), result: SHOWN }]);
    expect(await getCard(gone)).toEqual(NOT_FOUND);
    const elsewhere = await seed({}, await addLocation(server, { orgId, name: 'Patio' }));
    expect(await getCard(await conversationWith([{ id: CALL, input: input(elsewhere), result: SHOWN }]))).toEqual(NOT_FOUND);

    // A teammate's file: a member who is not an org admin gets no card from it, an org admin does.
    const theirs = await seed({ uploadedBy: teammate.userId });
    expect(await getCard(await conversationWith([{ id: CALL, input: input(theirs), result: SHOWN }]))).toEqual(NOT_FOUND);
    const adminsOwn = await conversationWith([{ id: CALL, input: input(theirs), result: SHOWN }], admin);
    expect((await getCard(adminsOwn, admin)).status).toBe(200);
    // After a role change the same card stops for the person who lost the role, and the uploader's own never did.
    const seat = { orgId: new Types.ObjectId(orgId), userId: admin.userId };
    await server.connection.collection('tw_members').updateOne(seat, { $set: { role: 'member' } });
    try {
      expect(await getCard(adminsOwn, admin)).toEqual(NOT_FOUND);
    } finally {
      await server.connection.collection('tw_members').updateOne(seat, { $set: { role: 'org_admin' } });
    }
    const uploaders = await conversationWith([{ id: CALL, input: input(theirs), result: SHOWN }], teammate);
    expect((await getCard(uploaders, teammate)).status).toBe(200);
  });

  it('dismiss moves the card once, with one order.card_dismissed of kind setup and no name in it; a save action is 400 and nothing writes order.card_saved', async () => {
    const ref = await seed();
    const conversationId = await conversationWith([{ id: CALL, input: input(ref), result: SHOWN }]);
    for (const json of [{ action: 'save' }, { action: 'save', situation: 'Sentinel reason' }, { action: 'save', quantity: 2, reason: 'Sentinel reason' }, {}, { action: 'dismiss', extra: true }]) {
      expect(await act(conversationId, json)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await cardEvents(conversationId)).toEqual([]);

    const dismissed = { status: 200, body: { proposal: { kind: 'setup', status: 'dismissed' } } };
    expect(await act(conversationId, { action: 'dismiss' })).toEqual(dismissed);
    expect(await act(conversationId, { action: 'dismiss' })).toEqual(dismissed);
    expect((await getCard(conversationId)).body).toEqual({ proposal: { kind: 'setup', status: 'dismissed', read: READ, readWeb: true } });

    const events = await cardEvents(conversationId);
    expect(events.map((event) => ({ action: event.action, details: event.details, target: event.target }))).toEqual([{
      action: 'order.card_dismissed', details: { locationId, conversationId, kind: 'setup' }, target: { type: 'conversation', id: conversationId },
    }]);
    expect(JSON.stringify(events)).not.toMatch(/Vorlan|Quillvane|Sentinel|f_[0-9a-f]{24}/);
    const rows = await server.connection.collection('tw_order_cards').find({ conversationId: new Types.ObjectId(conversationId) }).toArray();
    expect(rows.map((row) => ({ proposalId: row.proposalId as unknown, kind: row.kind as unknown, status: row.status as unknown })))
      .toEqual([{ proposalId: CALL, kind: 'setup', status: 'dismissed' }]);
  });

  it('dismiss under view-as is 403 view_as_read_only', async () => {
    const ref = await seed();
    const conversationId = await conversationWith([{ id: CALL, input: input(ref), result: SHOWN }]);
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: author.userId, orgId });
      expect(await getCard(conversationId, staff)).toEqual(await getCard(conversationId));
      expect(await act(conversationId, { action: 'dismiss' }, staff)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
      expect(await cardEvents(conversationId)).toEqual([]);
      expect(await server.connection.collection('tw_order_cards').countDocuments({ conversationId: new Types.ObjectId(conversationId) })).toBe(0);
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });

  it('GET and dismiss leave the ordering setup’s version unchanged', async () => {
    const saved = await call(server, `/api/org/locations/${locationId}/orders/setup`, {
      method: 'PUT', session: author,
      json: {
        expectedVersion: 0,
        setup: {
          suppliers: [{ key: 'north', name: 'North Distributing', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '14:00' }] }],
          items: [{
            name: 'Vorlan Brewing IPA', supplierId: 'north', category: 'draft', unit: 'kegs', servingsPerUnit: 120, par: 2, dealSize: null,
            neverRunOut: true, posNames: [{ name: 'Vorlan pint', perSale: 1 }],
          }],
        },
      },
    });
    expect(saved.status).toBe(200);
    const before = await orderRowsButCards();
    const ref = await seed();
    const conversationId = await conversationWith([{ id: CALL, input: input(ref), result: SHOWN }]);
    expect((await getCard(conversationId)).status).toBe(200);
    expect((await act(conversationId, { action: 'dismiss' })).status).toBe(200);
    expect(await orderRowsButCards()).toBe(before);
    const setup = await (await call(server, `/api/org/locations/${locationId}/orders/setup`, { session: author })).json() as { setup: { version: number } };
    expect(setup.setup.version).toBe(1);
  });
});
