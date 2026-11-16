// Orders through the API (design Decisions 2 to 8; the order-setup, item-sales, order-counts and order-board specs):
// the setup under compare-and-set, item sales by range, counts, who may do what, isolation, view-as, the exact audit
// details of every order write, and one live board end to end against the engine. Synthetic figures throughout.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ORDER_UNAVAILABLE, liveBoard, type OrderBoard, type OrderLine } from '../src/orders/board.ts';
import { addDays } from '../src/orders/dates.ts';
import { computeOrders, type ItemSalesDay } from '../src/orders/engine.ts';
import type { StoredSetup } from '../src/stores/order-setups.ts';
import { ORDER_CHANGE_RESULT, ORDER_RULE_RESULT } from '../src/chat/tools/orders.ts';
import { localDay, localMinutes } from '../src/time-zones.ts';
import { summaryOf } from '../src/audit.ts';
import {
  addConversation, addGrant, addInvite, addLocation, addOpenAsAdminGrant, addSalesDay, addSeat, auditEvents, createOrg, ORDER_COLLECTIONS,
} from './helpers/fixtures.ts';
import {
  call, limiterKey, refresh, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

// The test clock starts at 2026-06-01T12:00Z: Monday, 8:00am in Hanover.
const TODAY = '2026-06-01';

interface Person { session: TestSession; email: string }
let orgId: string;
let admin: Person;
let member: Person;
let otherAdmin: Person;

async function person(org: string, name: string, role: 'org_admin' | 'member'): Promise<Person> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId: org, userId: session.userId, email, role });
  return { session, email };
}

beforeAll(async () => {
  orgId = await createOrg(server, { name: 'Orders Tavern' });
  admin = await person(orgId, 'admin', 'org_admin');
  member = await person(orgId, 'member', 'member');
  const otherOrgId = await createOrg(server, { name: 'Other Tavern' });
  otherAdmin = await person(otherOrgId, 'other-admin', 'org_admin');
});

const SETUP = {
  suppliers: [{ key: 'north', name: 'North Distributing', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '14:00' }] }],
  items: [
    {
      name: 'House Lager', supplierId: 'north', category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 3, dealSize: 2,
      neverRunOut: true, posNames: [{ name: 'House Lager 12oz' }],
    },
    {
      name: 'Dry Cider', supplierId: 'north', category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 1, dealSize: null,
      neverRunOut: false, posNames: [{ name: 'Dry Cider can', perSale: 1 }],
    },
  ],
};

function base(locationId: string): string {
  return `/api/org/locations/${locationId}/orders`;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function putSetup(locationId: string, body: unknown, who: Person = member): Promise<Response> {
  return call(server, `${base(locationId)}/setup`, { method: 'PUT', session: who.session, json: body });
}

/** A new location with SETUP saved by the member. Resolves the location, the stored setup and the two item ids. */
async function locationWithSetup(name: string): Promise<{ locationId: string; setup: StoredSetup; lager: string; cider: string }> {
  const locationId = await addLocation(server, { orgId, name });
  const res = await putSetup(locationId, { expectedVersion: 0, setup: SETUP });
  expect(res.status).toBe(200);
  const { setup } = await res.json() as { setup: StoredSetup };
  return { locationId, setup, lager: setup.items[0]?.id ?? '', cider: setup.items[1]?.id ?? '' };
}

async function eventsOf(action: string, locationId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) =>
    event.action === action && (event.details as { locationId?: string }).locationId === locationId);
}

/** The location's rows in ordering's six collections, serialized, so any write shows. */
async function orderRows(locationId: string): Promise<string> {
  const docs: unknown[] = [];
  for (const name of ORDER_COLLECTIONS) {
    docs.push(await server.connection.collection(name).find({ locationId: new Types.ObjectId(locationId) }).sort({ _id: 1 }).toArray());
  }
  return JSON.stringify(docs);
}

async function board(locationId: string, who: Person = member): Promise<OrderBoard & { today: string }> {
  const res = await call(server, base(locationId), { session: who.session });
  expect(res.status).toBe(200);
  const body = await res.json() as OrderBoard & { today: string };
  expect(body.available).toBe(true);
  return body;
}

/** Shows a TownwiseAI order card in the conversation: the stored call and the result that says it was shown. */
async function showCards(conversationId: string, calls: { id: string; name: string; input: unknown; result: string }[]): Promise<void> {
  const at = server.clock.now();
  const params = [
    { role: 'assistant', content: calls.map(({ id, name, input }) => ({ type: 'tool_use', id, name, input })) },
    { role: 'user', content: calls.map(({ id, result }) => ({ type: 'tool_result', tool_use_id: id, content: result })) },
  ];
  await server.connection.collection('tw_chat_conversations').updateOne(
    { _id: new Types.ObjectId(conversationId) },
    { $push: { messages: { $each: params.map((param) => ({ at, param: JSON.stringify(param) })) } } } as Record<string, unknown>,
  );
}

function lineOf(answer: OrderBoard, itemId: string): OrderLine {
  const line = answer.orders.flatMap((order) => order.lines).find((candidate) => candidate.itemId === itemId);
  if (line === undefined) throw new Error(`no line for ${itemId}`);
  return line;
}

describe('ordering setup', () => {
  it('a location with no setup reads as empty, and its board names what is missing', async () => {
    const locationId = await addLocation(server, { orgId, name: 'Empty Bar' });
    const res = await call(server, `${base(locationId)}/setup`, { session: member.session });
    expect(res.status).toBe(200);
    // Every setup and board answer carries the town's date (A7, C7). This server has no setup reader (D41).
    expect(await res.json()).toEqual({
      setup: null, coverage: null, itemCoverage: {}, counts: {}, itemsWithHistory: [], today: TODAY, canReadWithAi: false,
    });
    const orders = await call(server, base(locationId), { session: member.session });
    expect(await orders.json()).toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the supplier schedule', 'the items'], today: TODAY });
    const decision = await call(server, `${base(locationId)}/decisions`, {
      session: member.session, json: { itemId: 'a'.repeat(24), delivery: '2026-06-04', quantity: 2, reason: 'Busy week' },
    });
    expect(await errorOf(decision)).toEqual({ status: 409, error: 'order_unavailable' });
    // The labeled sample still answers.
    const sample = await (await call(server, `${base(locationId)}?sample=true`, { session: member.session })).json() as OrderBoard;
    expect(sample).toMatchObject({ available: true, sample: true, today: TODAY });
  });

  it('a member saves the setup as version 1 with minted ids; the audit event carries the counts only', async () => {
    const locationId = await addLocation(server, { orgId, name: 'Setup Bar' });
    const res = await putSetup(locationId, { expectedVersion: 0, setup: SETUP });
    expect(res.status).toBe(200);
    const { setup } = await res.json() as { setup: StoredSetup & { updatedAt: string } };
    const supplierId = setup.suppliers[0]?.id ?? '';
    expect(supplierId).toMatch(/^[0-9a-f]{24}$/);
    expect(setup).toEqual({
      version: 1, updatedAt: server.clock.now().toISOString(),
      suppliers: [{ id: supplierId, name: 'North Distributing', deliveries: SETUP.suppliers[0]?.deliveries }],
      items: SETUP.items.map((item, i) => ({
        ...item, id: setup.items[i]?.id, supplierId, posNames: item.posNames.map((pos) => ({ perSale: 1, ...pos })),
      })),
    });
    for (const item of setup.items) expect(item.id).toMatch(/^[0-9a-f]{24}$/);
    const read = await (await call(server, `${base(locationId)}/setup`, { session: admin.session })).json() as { setup: unknown };
    expect(read.setup).toEqual(setup);

    const events = await eventsOf('order.setup_saved', locationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: member.session.userId, actorRole: 'member', target: { type: 'location', id: locationId } });
    expect(events[0]?.details).toEqual({ locationId, supplierCount: 1, itemCount: 2 });
    const audit = JSON.stringify(await auditEvents(server));
    for (const name of ['North Distributing', 'House Lager', 'Dry Cider']) expect(audit).not.toContain(name);
  });

  it('saves only over the version the editor loaded, and answers 409 setup_changed otherwise', async () => {
    const { locationId, setup } = await locationWithSetup('Busy Bar');
    expect(await errorOf(await putSetup(locationId, { expectedVersion: 0, setup: SETUP }))).toEqual({ status: 409, error: 'setup_changed' });
    const edited = {
      suppliers: setup.suppliers,
      items: setup.items.map((item) => ({ ...item, par: item.par + 1 })),
    };
    const saved = await putSetup(locationId, { expectedVersion: 1, setup: edited }, admin);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ setup: { version: 2, items: [{ id: setup.items[0]?.id, par: 4 }, { id: setup.items[1]?.id, par: 2 }] } });
    expect(await errorOf(await putSetup(locationId, { expectedVersion: 1, setup: SETUP }))).toEqual({ status: 409, error: 'setup_changed' });
    expect(await errorOf(await putSetup(locationId, { expectedVersion: 3, setup: SETUP }))).toEqual({ status: 409, error: 'setup_changed' });
    const stored = await server.connection.collection('tw_order_setups').findOne({ locationId: new Types.ObjectId(locationId) });
    expect(stored?.version).toBe(2);
    expect(await eventsOf('order.setup_saved', locationId)).toHaveLength(2);
  });

  it('refuses an invalid setup with 400 and stores nothing', async () => {
    const locationId = await addLocation(server, { orgId, name: 'Invalid Bar' });
    const [lager] = SETUP.items;
    const refused: unknown[] = [
      { expectedVersion: 0, setup: { ...SETUP, items: [{ ...lager, supplierId: 'south' }] } },
      { expectedVersion: 0, setup: { ...SETUP, suppliers: [{ ...SETUP.suppliers[0], deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '25:00' }] }] } },
      { expectedVersion: 0, setup: { ...SETUP, items: [{ ...lager, price: 30 }] } },
      { expectedVersion: -1, setup: SETUP },
      { expectedVersion: 0.5, setup: SETUP },
      { expectedVersion: 0 },
      { expectedVersion: 0, setup: SETUP, extra: true },
    ];
    for (const body of refused) expect({ body, ...(await errorOf(await putSetup(locationId, body))) }).toEqual({ body, status: 400, error: 'invalid_request' });
    expect(await orderRows(locationId)).toBe(JSON.stringify(ORDER_COLLECTIONS.map(() => [])));
  });

  // #68 second review R4: the remove-item confirm reads what the board reads, plus every saved edit and rule.
  it('names the items with history: item sales in the board’s 244 days, a count in its 400, or any edit or rule', async () => {
    const { locationId, lager, cider } = await locationWithSetup('History Bar');
    const where = { orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId) };
    const history = async (): Promise<unknown> =>
      (await (await call(server, `${base(locationId)}/setup`, { session: member.session })).json() as { itemsWithHistory: unknown }).itemsWithHistory;
    const sales = (date: string, items: Record<string, number>) =>
      server.connection.collection('tw_item_sales').insertOne({ ...where, date, items, uploadedAt: server.clock.now() });
    const count = (date: string, items: Record<string, number>) =>
      server.connection.collection('tw_order_counts').insertOne({ ...where, date, items, updatedAt: server.clock.now() });
    expect(await history()).toEqual([]);
    // Older than the board reads, or sold none: no history.
    await sales(addDays(TODAY, -245), { [lager]: 5 });
    await sales(addDays(TODAY, -100), { [cider]: 0 });
    await count(addDays(TODAY, -401), { [cider]: 2 });
    expect(await history()).toEqual([]);
    await sales(addDays(TODAY, -244), { [lager]: 5 });
    expect(await history()).toEqual([lager]);
    await count(addDays(TODAY, -400), { [cider]: 2 });
    expect(await history()).toEqual([lager, cider]);

    const other = await locationWithSetup('Edited Bar');
    const read = async (): Promise<unknown> =>
      (await (await call(server, `${base(other.locationId)}/setup`, { session: member.session })).json() as { itemsWithHistory: unknown }).itemsWithHistory;
    const decide = (itemId: string, reason: string) => call(server, `${base(other.locationId)}/decisions`, {
      session: member.session, json: { itemId, delivery: '2026-06-04', quantity: 5, reason },
    });
    expect((await decide(other.cider, 'Tasting')).status).toBe(200);
    expect(await read()).toEqual([other.cider]);
  });

  it('a setup with no items, or no supplier, says so on the board', async () => {
    const locationId = await addLocation(server, { orgId, name: 'Half Bar' });
    expect((await putSetup(locationId, { expectedVersion: 0, setup: { suppliers: SETUP.suppliers, items: [] } })).status).toBe(200);
    expect(await (await call(server, base(locationId), { session: member.session })).json())
      .toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the items'], today: TODAY });
    expect((await putSetup(locationId, { expectedVersion: 1, setup: { suppliers: [], items: [] } })).status).toBe(200);
    expect(await (await call(server, base(locationId), { session: member.session })).json())
      .toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the supplier schedule', 'the items'], today: TODAY });
  });
});

describe('item sales', () => {
  let locationId: string;
  let lager: string;
  let cider: string;
  const MAY = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07'];

  beforeAll(async () => {
    ({ locationId, lager, cider } = await locationWithSetup('Sales Bar'));
  });

  function upload(body: unknown, who: Person = member): Promise<Response> {
    return call(server, `${base(locationId)}/item-sales`, { session: who.session, json: body });
  }

  /** The location's stored item-sales days, date to items, oldest first. */
  async function storedDays(id: string): Promise<Record<string, unknown>> {
    const docs = await server.connection.collection('tw_item_sales').find({ locationId: new Types.ObjectId(id) }).sort({ date: 1 }).toArray();
    return Object.fromEntries(docs.map((doc) => [doc.date as string, doc.items as unknown]));
  }

  it('an org admin uploads a range: sent days replace, unsent days in the range go, and the event carries counts and dates only', async () => {
    const week = MAY.map((date, i) => ({ date, items: { [lager]: 10 + i, [cider]: i < 2 ? 0 : 2 } }));
    const first = await upload({ from: MAY[0], to: MAY[6], days: week }, admin);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ stored: 7, removed: 0, kept: 0 });
    const changed = week.slice(0, 6).map((day) => ({ ...day, items: { ...day.items, [lager]: 50 } }));
    const again = await upload({ from: MAY[0], to: MAY[6], days: changed }, admin);
    expect(await again.json()).toEqual({ stored: 6, removed: 1, kept: 0 });
    expect(await storedDays(locationId)).toEqual(Object.fromEntries(changed.map((day) => [day.date, day.items])));

    const events = await eventsOf('order.item_sales_uploaded', locationId);
    expect(events.map((event) => event.details)).toEqual([
      { locationId, dayCount: 7, itemCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-07', removedCount: 0, keptCount: 0 },
      { locationId, dayCount: 6, itemCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-07', removedCount: 1, keptCount: 0 },
    ]);
    expect(events[0]).toMatchObject({ actorUserId: admin.session.userId, actorRole: 'org_admin' });

    const read = await (await call(server, `${base(locationId)}/setup`, { session: member.session })).json() as Record<string, unknown>;
    expect(read.coverage).toEqual({ firstDate: '2026-05-01', lastDate: '2026-05-06', dayCount: 6 });
    // Cider sold nothing on the first two days, so it has four days with sales.
    expect(read.itemCoverage).toEqual({ [lager]: 6, [cider]: 4 });
  });

  // #68 review A1: a member's upload never deletes or overwrites a stored day, so only an org admin's DELETE clears them.
  it('a member adds only days not already stored: no day sent removes nothing, a new day is stored, and items: {} zeroes nothing', async () => {
    const own = await locationWithSetup('Member Bar');
    const week = MAY.map((date, i) => ({ date, items: { [own.lager]: 10 + i, [own.cider]: 2 } }));
    const send = (body: unknown, who: Person): Promise<Response> => call(server, `${base(own.locationId)}/item-sales`, { session: who.session, json: body });
    expect(await (await send({ from: MAY[0], to: MAY[6], days: week }, admin)).json()).toEqual({ stored: 7, removed: 0, kept: 0 });
    const before = await storedDays(own.locationId);

    const none = await send({ from: MAY[0], to: MAY[6], days: [] }, member);
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ stored: 0, removed: 0, kept: 0 });
    expect(await storedDays(own.locationId)).toEqual(before);

    const added = await send({ from: MAY[0], to: '2026-05-08', days: [{ date: MAY[0], items: { [own.lager]: 99 } }, { date: '2026-05-08', items: { [own.lager]: 5 } }] }, member);
    expect(await added.json()).toEqual({ stored: 1, removed: 0, kept: 1 });
    expect(await storedDays(own.locationId)).toEqual({ ...before, '2026-05-08': { [own.lager]: 5 } });

    const emptied = await send({ from: MAY[0], to: MAY[6], days: MAY.map((date) => ({ date, items: {} })) }, member);
    expect(await emptied.json()).toEqual({ stored: 0, removed: 0, kept: 7 });
    expect(await storedDays(own.locationId)).toEqual({ ...before, '2026-05-08': { [own.lager]: 5 } });

    const events = await eventsOf('order.item_sales_uploaded', own.locationId);
    expect(events.map((event) => event.details)).toEqual([
      { locationId: own.locationId, dayCount: 7, itemCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-07', removedCount: 0, keptCount: 0 },
      { locationId: own.locationId, dayCount: 0, itemCount: 0, firstDate: '2026-05-01', lastDate: '2026-05-07', removedCount: 0, keptCount: 0 },
      { locationId: own.locationId, dayCount: 2, itemCount: 1, firstDate: '2026-05-01', lastDate: '2026-05-08', removedCount: 0, keptCount: 1 },
      { locationId: own.locationId, dayCount: 7, itemCount: 0, firstDate: '2026-05-01', lastDate: '2026-05-07', removedCount: 0, keptCount: 7 },
    ]);
    expect(events.slice(1).map((event) => event.actorRole)).toEqual(['member', 'member', 'member']);
    expect(summaryOf('order.item_sales_uploaded', events[2]?.details as Record<string, number | string>))
      .toBe('Uploaded 2 days of item sales for 1 items, 2026-05-01 to 2026-05-08; kept 1 already saved');
    expect(summaryOf('order.item_sales_uploaded', events[0]?.details as Record<string, number | string>))
      .toBe('Uploaded 7 days of item sales for 2 items, 2026-05-01 to 2026-05-07');
    expect(summaryOf('order.item_sales_uploaded', { dayCount: 0, itemCount: 0, firstDate: '2026-05-01', lastDate: '2026-05-07', removedCount: 7, keptCount: 0 }))
      .toBe('Uploaded 0 days of item sales for 0 items, 2026-05-01 to 2026-05-07; removed 7 days the file left out');

    // The org admin's upload still replaces what the member could not.
    expect(await (await send({ from: MAY[0], to: MAY[6], days: [] }, admin)).json()).toEqual({ stored: 0, removed: 7, kept: 0 });
    expect(await storedDays(own.locationId)).toEqual({ '2026-05-08': { [own.lager]: 5 } });
  });

  it('staff opened as admin replace, as an org admin does (D25)', async () => {
    const staff = await signInStaff(server);
    try {
      const setupOrg = await createOrg(server, { name: 'Setup Orders' });
      await addInvite(server, {
        orgId: setupOrg, email: `first-admin-${randomUUID().slice(0, 8)}@example.test`, invitedBy: staff.userId, role: 'org_admin', addedByStaff: true,
      });
      const room = await addLocation(server, { orgId: setupOrg, name: 'Setup Bar' });
      await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: setupOrg });
      const saved = await call(server, `${base(room)}/setup`, { method: 'PUT', session: staff, json: { expectedVersion: 0, setup: SETUP } });
      const item = (await saved.json() as { setup: StoredSetup }).setup.items[0]?.id ?? '';
      const send = (days: unknown[]): Promise<Response> => call(server, `${base(room)}/item-sales`, { session: staff, json: { from: MAY[0], to: MAY[1], days } });
      expect(await (await send([{ date: MAY[0], items: { [item]: 3 } }, { date: MAY[1], items: { [item]: 4 } }])).json()).toEqual({ stored: 2, removed: 0, kept: 0 });
      expect(await (await send([{ date: MAY[0], items: { [item]: 6 } }])).json()).toEqual({ stored: 1, removed: 1, kept: 0 });
      expect(await storedDays(room)).toEqual({ [MAY[0] ?? '']: { [item]: 6 } });
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });

  it('refuses a bad upload with 400 and stores nothing', async () => {
    const before = await orderRows(locationId);
    const day = (date: string, items: Record<string, unknown> = { [lager]: 3 }): Record<string, unknown> => ({ date, items });
    expect(await errorOf(await upload({ from: MAY[0], to: MAY[0], days: [day(MAY[0] ?? '', { [new Types.ObjectId().toHexString()]: 1 })] })))
      .toEqual({ status: 400, error: 'unknown_item' });
    const many = Object.fromEntries(Array.from({ length: 501 }, () => [new Types.ObjectId().toHexString(), 1]));
    const refused: unknown[] = [
      { from: '2026-04-01', to: '2026-05-02', days: [] },                       // 32 days
      { from: MAY[0], to: MAY[1], days: [day('2026-05-01'), day('2026-05-01')] },
      { from: MAY[0], to: MAY[1], days: [day('2026-05-03')] },
      { from: MAY[1], to: MAY[0], days: [] },
      { from: '2026-06-01', to: '2026-06-02', days: [] },                       // ends after the town's today
      { from: '2026-05-31', to: TODAY, days: [] },                              // ends on today, which is still open (A7)
      { from: '2009-12-31', to: '2010-01-01', days: [] },
      { from: MAY[0], to: MAY[0], days: [day('2026-05-01', { [lager]: -1 })] },
      { from: MAY[0], to: MAY[0], days: [day('2026-05-01', { [lager]: 100_001 })] },
      { from: MAY[0], to: MAY[0], days: [day('2026-05-01', { [lager]: '3' })] },
      { from: MAY[0], to: MAY[0], days: [day('2026-05-01', many)] },
      { from: MAY[0], to: MAY[0], days: [{ ...day('2026-05-01'), name: 'House Lager' }] },
      { from: MAY[0], to: '2026-05-1', days: [] },
      { from: MAY[0], to: MAY[0], days: [], extra: true },
    ];
    for (const body of refused) expect({ body, ...(await errorOf(await upload(body))) }).toEqual({ body, status: 400, error: 'invalid_request' });
    expect(await orderRows(locationId)).toBe(before);
  });

  it('counts against its own limiter, 60 an hour, not the sales uploads’ (R7)', async () => {
    const one = { from: MAY[0], to: MAY[0], days: [{ date: MAY[0], items: { [lager]: 10 } }] };
    await server.redis.set(limiterKey('townwise:uploads', member.session.userId), '30', 'EX', 3600);
    expect((await upload(one)).status).toBe(200);
    await server.redis.set(limiterKey('townwise:item-sales', member.session.userId), '60', 'EX', 3600);
    expect(await errorOf(await upload(one))).toEqual({ status: 429, error: 'rate_limited' });
  });

  it('only an org admin deletes item sales: a member gets 403, and the event carries the day count', async () => {
    const remove = (who: Person): Promise<Response> => call(server, `${base(locationId)}/item-sales`, { method: 'DELETE', session: who.session });
    expect(await errorOf(await remove(member))).toEqual({ status: 403, error: 'forbidden' });
    const res = await remove(admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 6 });
    const events = await eventsOf('order.item_sales_deleted', locationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorRole: 'org_admin' });
    expect(events[0]?.details).toEqual({ locationId, dayCount: 6 });
    expect(await server.connection.collection('tw_item_sales').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(0);
    expect(await server.connection.collection('tw_order_setups').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(1);
  });
});

describe('counts', () => {
  let locationId: string;
  let lager: string;
  let cider: string;

  beforeAll(async () => {
    ({ locationId, lager, cider } = await locationWithSetup('Count Bar'));
  });

  function count(body: unknown): Promise<Response> {
    return call(server, `${base(locationId)}/counts`, { session: member.session, json: body });
  }

  it('a member counts part of the bar, then the rest the same day, and each count is audited with the date and item count', async () => {
    expect((await count({ date: TODAY, items: { [lager]: 2.5 } })).status).toBe(204);
    expect((await count({ date: TODAY, items: { [cider]: 0 } })).status).toBe(204);
    const read = await (await call(server, `${base(locationId)}/setup`, { session: member.session })).json() as Record<string, unknown>;
    expect(read.counts).toEqual({ [lager]: { quantity: 2.5, date: TODAY }, [cider]: { quantity: 0, date: TODAY } });
    const events = await eventsOf('order.count_saved', locationId);
    expect(events.map((event) => event.details)).toEqual([
      { locationId, date: TODAY, itemCount: 1 }, { locationId, date: TODAY, itemCount: 1 },
    ]);
  });

  it('takes a count from the last 14 days only, in half units from 0 to 9,999, of the setup’s items', async () => {
    const before = await orderRows(locationId);
    expect(await errorOf(await count({ date: TODAY, items: { [new Types.ObjectId().toHexString()]: 1 } })))
      .toEqual({ status: 400, error: 'unknown_item' });
    const many = Object.fromEntries(Array.from({ length: 301 }, () => [new Types.ObjectId().toHexString(), 1]));
    const refused: unknown[] = [
      { date: '2026-06-02', items: { [lager]: 1 } },                            // tomorrow
      { date: '2026-05-17', items: { [lager]: 1 } },                            // 15 days back
      { date: TODAY, items: { [lager]: 0.25 } },
      { date: TODAY, items: { [lager]: -0.5 } },
      { date: TODAY, items: { [lager]: 10_000 } },
      { date: TODAY, items: { [lager]: '1' } },
      { date: TODAY, items: {} },
      { date: TODAY, items: many },
      { date: TODAY },
      { date: TODAY, items: { [lager]: 1 }, note: 'x' },
    ];
    for (const body of refused) expect({ body, ...(await errorOf(await count(body))) }).toEqual({ body, status: 400, error: 'invalid_request' });
    expect(await orderRows(locationId)).toBe(before);
    expect((await count({ date: '2026-05-18', items: { [lager]: 9999 } })).status).toBe(204);
  });
});

describe('who may reach the order routes', () => {
  let locationId: string;
  let lager: string;

  beforeAll(async () => {
    ({ locationId, lager } = await locationWithSetup('Guarded Bar'));
    expect((await call(server, `${base(locationId)}/counts`, { session: member.session, json: { date: TODAY, items: { [lager]: 1 } } })).status).toBe(204);
  });

  function requests(): { method: string; path: string; json?: unknown }[] {
    const path = base(locationId);
    return [
      { method: 'GET', path },
      { method: 'GET', path: `${path}/setup` },
      { method: 'PUT', path: `${path}/setup`, json: { expectedVersion: 1, setup: SETUP } },
      { method: 'POST', path: `${path}/setup/read`, json: { source: { type: 'text', text: 'House Lager, 24 bottles a case' } } },
      { method: 'POST', path: `${path}/item-sales`, json: { from: '2026-05-01', to: '2026-05-01', days: [{ date: '2026-05-01', items: { [lager]: 1 } }] } },
      { method: 'DELETE', path: `${path}/item-sales` },
      { method: 'POST', path: `${path}/counts`, json: { date: TODAY, items: { [lager]: 2 } } },
      { method: 'POST', path: `${path}/decisions`, json: { itemId: lager, delivery: '2026-06-04', quantity: 2, reason: 'Busy week' } },
      { method: 'POST', path: `${path}/rules`, json: { itemId: lager, situation: 'Busy week' } },
      { method: 'POST', path: `${path}/rules/off`, json: { ruleId: new Types.ObjectId().toHexString() } },
    ];
  }

  it('another organization’s admin gets 404 not_found on every order route of this location, and nothing changes', async () => {
    const before = await orderRows(locationId);
    const events = (await auditEvents(server)).length;
    for (const { method, path, json } of requests()) {
      const res = await call(server, path, { method, session: otherAdmin.session, ...(json === undefined ? {} : { json }) });
      expect({ method, path, ...(await errorOf(res)) }).toEqual({ method, path, status: 404, error: 'not_found' });
    }
    expect(await orderRows(locationId)).toBe(before);
    expect((await auditEvents(server)).length).toBe(events);
  });

  it('staff viewing as a member read the setup and the board, and every order write is refused with nothing stored', async () => {
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: member.session.userId, orgId });
      const before = await orderRows(locationId);
      const events = (await auditEvents(server)).length;
      for (const { method, path, json } of requests()) {
        const res = await call(server, path, { method, session: staff, ...(json === undefined ? {} : { json }) });
        if (method === 'GET') {
          expect({ path, status: res.status }).toEqual({ path, status: 200 });
          const own = await call(server, path, { session: member.session });
          expect(await res.json()).toEqual(await own.json());
        } else {
          expect({ method, path, ...(await errorOf(res)) }).toEqual({ method, path, status: 403, error: 'view_as_read_only' });
        }
      }
      expect(await orderRows(locationId)).toBe(before);
      expect((await auditEvents(server)).length).toBe(events);
    } finally {
      await removeStaffFactor(server);
    }
  });
});

describe('the live board, end to end', () => {
  const LAGER_BY_WEEKDAY = [30, 12, 14, 16, 22, 40, 45];
  const CIDER_BY_WEEKDAY = [6, 2, 2, 3, 4, 8, 9];
  let locationId: string;
  let setup: StoredSetup;
  let lager: string;
  let cider: string;
  let sent: ItemSalesDay[];
  let recommended: number;

  beforeAll(async () => {
    ({ locationId, setup, lager, cider } = await locationWithSetup('Live Bar'));
    // Eight weeks of synthetic item sales, 2026-04-06 to 2026-05-31, with a little day-to-day wobble.
    sent = Array.from({ length: 56 }, (_, i) => {
      const date = addDays('2026-04-06', i);
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      return { date, items: { [lager]: (LAGER_BY_WEEKDAY[weekday] ?? 0) + ((i * 7) % 5), [cider]: (CIDER_BY_WEEKDAY[weekday] ?? 0) + (i % 3) } };
    });
    for (const chunk of [sent.slice(0, 31), sent.slice(31)]) {
      const res = await call(server, `${base(locationId)}/item-sales`, {
        session: member.session, json: { from: chunk[0]?.date, to: chunk.at(-1)?.date, days: chunk },
      });
      expect(res.status).toBe(200);
    }
    expect((await call(server, `${base(locationId)}/counts`, { session: member.session, json: { date: TODAY, items: { [lager]: 3 } } })).status).toBe(204);
  });

  it('computes each line exactly as the engine does on the same input', async () => {
    const answer = await board(locationId);
    const plans = computeOrders({
      suppliers: setup.suppliers, items: setup.items, itemSales: sent, counts: new Map([[lager, { quantity: 3, date: TODAY }]]),
      forecastGuests: new Map(), closedDays: new Set(), historyGuests: [], today: TODAY,
      nowMinutes: localMinutes(server.clock.now(), 'America/New_York'),
    });
    expect(answer).toEqual({ ...liveBoard(plans, []), missing: [], today: TODAY });
    const [order] = answer.orders;
    expect(order).toMatchObject({
      supplier: 'North Distributing', cutoff: '2026-06-03', cutoffTime: '14:00', delivery: '2026-06-04', coversThrough: '2026-06-11',
      deadline: 'Order by Wed, Jun 3, 2:00pm. Thursday’s delivery lasts until next Thursday’s.',
    });
    const line = lineOf(answer, lager);
    expect(line.recommended).toBe(plans[0]?.lines.find((planned) => planned.itemId === lager)?.recommended);
    expect(line).toMatchObject({ onHand: 3, countAgeDays: 0, confidence: 'high', coveredDays: 56, target: 0.98, dealSize: 2 });
    expect(line.sigma).not.toBeNull();
    expect(line.recommended).toBeGreaterThan(0);
    expect(line.recommended % 2).toBe(0);
    // Cider was never counted: the par, at low confidence.
    expect(lineOf(answer, cider)).toMatchObject({ recommended: 1, onHand: null, confidence: 'low' });
    recommended = line.recommended;
  });

  it('saves an edit, remembers it as a rule that moves the line, and turns the rule off; the audit never holds the reason', async () => {
    const path = base(locationId);
    const reason = 'Graduation weekend';
    const decide = (json: unknown): Promise<Response> => call(server, `${path}/decisions`, { session: member.session, json });

    expect(await errorOf(await decide({ itemId: lager, delivery: '2026-06-11', quantity: 4, reason }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await decide({ itemId: 'sample-lager', delivery: '2026-06-04', quantity: 4, reason }))).toEqual({ status: 404, error: 'not_found' });
    for (const quantity of [1.5, -1, 1000, null]) {
      expect(await errorOf(await decide({ itemId: lager, delivery: '2026-06-04', quantity, reason }))).toEqual({ status: 400, error: 'invalid_request' });
    }
    const saved = await decide({ itemId: lager, delivery: '2026-06-04', quantity: recommended + 2, reason, recommended: 0 });
    expect(saved.status).toBe(400);
    const decision = await decide({ itemId: lager, delivery: '2026-06-04', quantity: recommended + 2, reason });
    expect(decision.status).toBe(200);
    expect(await decision.json()).toEqual({ decision: { itemId: lager, delivery: '2026-06-04', quantity: recommended + 2, reason, recommended } });
    expect((await eventsOf('order.decision_saved', locationId)).map((event) => event.details))
      .toEqual([{ locationId, itemId: lager, delivery: '2026-06-04' }]);
    expect(lineOf(await board(locationId), lager)).toMatchObject({ recommended, edit: { quantity: recommended + 2, reason }, rules: [] });

    const remember = (situation: string): Promise<Response> => call(server, `${path}/rules`, { session: member.session, json: { itemId: lager, situation } });
    expect(await errorOf(await remember('Some other reason'))).toEqual({ status: 404, error: 'not_found' });
    const ruled = await remember(reason);
    expect(ruled.status).toBe(200);
    const { rule } = await ruled.json() as { rule: { id: string } };
    expect(rule).toEqual({ id: rule.id, itemId: lager, delta: 2, situation: reason, off: false });
    expect(await (await remember(reason)).json()).toEqual({ rule });
    expect((await eventsOf('order.rule_saved', locationId)).map((event) => event.details)).toEqual([{ locationId, itemId: lager }]);

    const withRule = lineOf(await board(locationId), lager);
    expect(withRule).toMatchObject({ recommended: recommended + 2, rules: [{ id: rule.id, delta: 2, situation: reason }] });
    expect(withRule.why).toContain(`Includes 2 extra cases from your rule: ${reason}.`);

    const off = (ruleId: string): Promise<Response> => call(server, `${path}/rules/off`, { session: member.session, json: { ruleId } });
    expect(await errorOf(await off(new Types.ObjectId().toHexString()))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await off('not-a-rule'))).toEqual({ status: 400, error: 'invalid_request' });
    expect((await off(rule.id)).status).toBe(204);
    expect((await eventsOf('order.rule_turned_off', locationId)).map((event) => event.details)).toEqual([{ locationId, ruleId: rule.id }]);
    expect(lineOf(await board(locationId), lager)).toMatchObject({ recommended, rules: [] });
    expect(await errorOf(await remember(reason))).toEqual({ status: 409, error: 'rule_off' });

    expect(JSON.stringify(await auditEvents(server))).not.toContain(reason);
  });

  it('the order change card saves the owner’s quantity on the live line once, and a saved card stays saved', async () => {
    const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: 'What should I order?' });
    const at = server.clock.now();
    const calls = ['toolu_order_change1', 'toolu_order_change2'];
    const params = [
      { role: 'assistant', content: calls.map((id) => ({ type: 'tool_use', id, name: 'propose_order_change', input: { itemId: cider, delivery: '2026-06-04' } })) },
      { role: 'user', content: calls.map((id) => ({ type: 'tool_result', tool_use_id: id, content: ORDER_CHANGE_RESULT })) },
    ];
    await server.connection.collection('tw_chat_conversations').updateOne(
      { _id: new Types.ObjectId(conversationId) },
      { $push: { messages: { $each: params.map((param) => ({ at, param: JSON.stringify(param) })) } } } as Record<string, unknown>,
    );
    const cardPath = (id: string): string => `/api/org/locations/${locationId}/chat/${conversationId}/order-proposals/${id}`;
    const act = (id: string, json: unknown): Promise<Response> => call(server, cardPath(id), { session: member.session, json });
    const view = { kind: 'change', itemId: cider, delivery: '2026-06-04' };

    expect(await (await call(server, cardPath('toolu_order_change1'), { session: member.session })).json())
      .toEqual({ proposal: { ...view, status: 'open' } });
    expect(await errorOf(await act('toolu_order_change1', { action: 'save', quantity: 1.5, reason: 'Cider tasting' })))
      .toEqual({ status: 400, error: 'invalid_request' });
    const saved = await act('toolu_order_change1', { action: 'save', quantity: 4, reason: 'Cider tasting' });
    const kept = { ...view, status: 'saved', quantity: 4, unit: 'cases', reason: 'Cider tasting' };
    expect(await saved.json()).toEqual({ proposal: kept });
    expect(lineOf(await board(locationId), cider).edit).toEqual({ quantity: 4, reason: 'Cider tasting' });
    // #68 second review N3: a saved card shows its stored edit; a save of another one is 409 card_saved with it.
    expect(await (await call(server, cardPath('toolu_order_change1'), { session: member.session })).json()).toEqual({ proposal: kept });
    const other = await act('toolu_order_change1', { action: 'save', quantity: 5, reason: 'Again' });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: 'card_saved', message: expect.any(String) as unknown, proposal: kept });
    const same = await act('toolu_order_change1', { action: 'save', quantity: 4, reason: ' Cider tasting ' });
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ proposal: kept });
    expect(await (await act('toolu_order_change1', { action: 'dismiss' })).json()).toEqual({ proposal: kept });
    expect(await server.connection.collection('tw_order_decisions').countDocuments({ locationId: new Types.ObjectId(locationId), itemId: cider }))
      .toBe(1);
    expect(await (await act('toolu_order_change2', { action: 'dismiss' })).json()).toEqual({ proposal: { ...view, status: 'dismissed' } });

    expect((await eventsOf('order.card_saved', locationId)).map((event) => event.details)).toEqual([{ locationId, conversationId, kind: 'change' }]);
    const dismissed = await eventsOf('order.card_dismissed', locationId);
    expect(dismissed.map((event) => event.details)).toEqual([{ locationId, conversationId, kind: 'change' }]);
    expect(dismissed[0]).toMatchObject({ target: { type: 'conversation', id: conversationId } });
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Cider tasting');
  });

  it('the rule card saves only the situation it showed: a newer edit since is 409 rule_changed, and a second press adds nothing (A4, A5)', async () => {
    const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: 'Remember that' });
    await showCards(conversationId, [{ id: 'toolu_order_rule1', name: 'propose_order_rule', input: { itemId: cider }, result: ORDER_RULE_RESULT }]);
    const cardPath = `/api/org/locations/${locationId}/chat/${conversationId}/order-proposals/toolu_order_rule1`;
    const act = (json: unknown): Promise<Response> => call(server, cardPath, { session: member.session, json });
    const shown = await (await call(server, cardPath, { session: member.session })).json() as { proposal: { situation: string; delta: number } };
    expect(shown.proposal).toMatchObject({ kind: 'rule', status: 'open', itemId: cider, situation: 'Cider tasting', delta: 3, unit: 'cases' });

    const before = await orderRows(locationId);
    const events = (await auditEvents(server)).length;
    expect(await errorOf(await act({ action: 'save', situation: 'A reason the card never showed' }))).toEqual({ status: 409, error: 'rule_changed' });
    expect(await errorOf(await act({ action: 'save' }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await orderRows(locationId)).toBe(before);
    expect((await auditEvents(server)).length).toBe(events);

    const saved = await (await act({ action: 'save', situation: shown.proposal.situation })).json() as { proposal: { ruleId: string } };
    expect(saved.proposal).toMatchObject({ kind: 'rule', status: 'saved', itemId: cider, situation: 'Cider tasting', delta: 3, unit: 'cases' });
    expect(await (await act({ action: 'save', situation: shown.proposal.situation })).json())
      .toEqual({ proposal: { kind: 'rule', status: 'saved', itemId: cider } });
    expect(await (await act({ action: 'dismiss' })).json()).toEqual({ proposal: { kind: 'rule', status: 'saved', itemId: cider } });
    const ruleEvents = (await eventsOf('order.card_saved', locationId)).filter((event) => (event.details as { kind: string }).kind === 'rule');
    expect(ruleEvents.map((event) => event.details)).toEqual([{ locationId, conversationId, kind: 'rule' }]);
    expect(await eventsOf('order.card_dismissed', locationId)).toHaveLength(1);
    expect(await server.connection.collection('tw_order_rules').countDocuments({ locationId: new Types.ObjectId(locationId), itemId: cider })).toBe(1);
  });

  it('two saves of one change card at once store one edit and one order.card_saved (A3)', async () => {
    const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: 'Change it' });
    await showCards(conversationId, [{
      id: 'toolu_order_change9', name: 'propose_order_change', input: { itemId: lager, delivery: '2026-06-04' }, result: ORDER_CHANGE_RESULT,
    }]);
    const cardPath = `/api/org/locations/${locationId}/chat/${conversationId}/order-proposals/toolu_order_change9`;
    const decisions = server.connection.collection('tw_order_decisions');
    const where = { locationId: new Types.ObjectId(locationId), itemId: lager };
    const stored = await decisions.countDocuments(where);
    const answers = await Promise.all([5, 7].map(async (quantity) => {
      const res = await call(server, cardPath, { session: member.session, json: { action: 'save', quantity, reason: `Busy ${String(quantity)}` } });
      return { status: res.status, body: await res.json() as { proposal: { status: string; quantity: number; reason: string } } };
    }));
    expect(answers.map((answer) => answer.body.proposal.status)).toEqual(['saved', 'saved']);
    // One stored edit, and both answers show it: the save it was is 200, the other 409 card_saved (N3).
    const [kept] = answers.filter((answer) => answer.status === 200);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    for (const answer of answers) expect(answer.body.proposal).toEqual(kept?.body.proposal);
    expect(kept?.body.proposal.reason).toBe(`Busy ${String(kept?.body.proposal.quantity)}`);
    expect(await decisions.countDocuments(where)).toBe(stored + 1);
    const cardEvents = (await eventsOf('order.card_saved', locationId))
      .filter((event) => (event.details as { conversationId: string }).conversationId === conversationId);
    expect(cardEvents).toHaveLength(1);
    expect(kept?.body.proposal).toMatchObject({ kind: 'change', itemId: lager, delivery: '2026-06-04', unit: 'cases' });
    expect(await (await call(server, cardPath, { session: member.session })).json()).toEqual({ proposal: kept?.body.proposal });
  });

  // #68 second review N3: the edit was stored, then the card's save failed; a retry with another quantity says so.
  it('a retry after the edit was stored is 409 card_saved with that edit, and completes the card once', async () => {
    const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: 'Retry it' });
    await showCards(conversationId, [{
      id: 'toolu_order_change7', name: 'propose_order_change', input: { itemId: lager, delivery: '2026-06-04' }, result: ORDER_CHANGE_RESULT,
    }]);
    // What a failure between storing the edit and marking the card saved leaves: a claimed card and its edit.
    const decisionId = new Types.ObjectId();
    const now = server.clock.now();
    await server.connection.collection('tw_order_cards').insertOne({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), conversationId: new Types.ObjectId(conversationId),
      proposalId: 'toolu_order_change7', kind: 'change', status: 'saving', decisionId, createdAt: now,
    });
    await server.connection.collection('tw_order_decisions').insertOne({
      _id: decisionId, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), itemId: lager, delivery: '2026-06-04',
      windowStart: '2026-06-03', windowEnd: '2026-06-10', recommended, quantity: 6, unit: 'cases', reason: 'First try', createdAt: now,
    });
    const cardPath = `/api/org/locations/${locationId}/chat/${conversationId}/order-proposals/toolu_order_change7`;
    const kept = { kind: 'change', status: 'saved', itemId: lager, delivery: '2026-06-04', quantity: 6, unit: 'cases', reason: 'First try' };
    expect(await (await call(server, cardPath, { session: member.session })).json())
      .toEqual({ proposal: { kind: 'change', status: 'open', itemId: lager, delivery: '2026-06-04' } });
    const retry = await call(server, cardPath, { session: member.session, json: { action: 'save', quantity: 8, reason: 'Second try' } });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: 'card_saved', message: expect.any(String) as unknown, proposal: kept });
    expect(await (await call(server, cardPath, { session: member.session })).json()).toEqual({ proposal: kept });
    expect(await server.connection.collection('tw_order_decisions').countDocuments({ _id: decisionId })).toBe(1);
    expect(await server.connection.collection('tw_order_decisions').countDocuments({ reason: 'Second try' })).toBe(0);
    const cardEvents = (await eventsOf('order.card_saved', locationId))
      .filter((event) => (event.details as { conversationId: string }).conversationId === conversationId);
    expect(cardEvents).toHaveLength(1);
  });
});

// #68 second review N1: a rule saved before the item's unit changed applies to no line; remembering the reason again
// moves it to the new edit's amount and unit, through the rules route and through a TownwiseAI rule card.
describe('a rule saved in an old unit', () => {
  it('takes the new edit’s amount and unit, audited as a new save, and applies again', async () => {
    const { locationId, setup, lager, cider } = await locationWithSetup('Unit Change Bar');
    const path = base(locationId);
    const decide = (itemId: string, quantity: number, reason: string): Promise<Response> =>
      call(server, `${path}/decisions`, { session: member.session, json: { itemId, delivery: '2026-06-04', quantity, reason } });
    const remember = (itemId: string, situation: string): Promise<Response> =>
      call(server, `${path}/rules`, { session: member.session, json: { itemId, situation } });
    // No count and no item sales: each line is its par, lager 3 and cider 1.
    expect((await decide(lager, 5, 'Game night')).status).toBe(200);
    expect((await decide(cider, 2, 'Cider fest')).status).toBe(200);
    const first = await (await remember(lager, 'Game night')).json() as { rule: { id: string } };
    expect((await remember(cider, 'Cider fest')).status).toBe(200);
    expect(lineOf(await board(locationId), lager)).toMatchObject({ recommended: 5, rules: [{ id: first.rule.id, delta: 2 }] });

    const bottles = { suppliers: setup.suppliers, items: setup.items.map((item) => ({ ...item, unit: 'bottles' })) };
    expect((await putSetup(locationId, { expectedVersion: 1, setup: bottles })).status).toBe(200);
    expect(lineOf(await board(locationId), lager)).toMatchObject({ unit: 'bottles', recommended: 3, rules: [] });
    // The old rule held the item and situation, so the tool said one exists; now it shows the card again.
    expect((await decide(lager, 9, 'Game night')).status).toBe(200);
    const moved = await remember(lager, 'Game night');
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ rule: { id: first.rule.id, itemId: lager, delta: 6, situation: 'Game night', off: false } });
    expect((await eventsOf('order.rule_saved', locationId)).map((event) => event.details)).toEqual([
      { locationId, itemId: lager }, { locationId, itemId: cider }, { locationId, itemId: lager },
    ]);
    // Again: the rule is in the edit's unit now, so it is the answer, with no new event.
    expect((await remember(lager, 'Game night')).status).toBe(200);
    expect(await eventsOf('order.rule_saved', locationId)).toHaveLength(3);
    expect(lineOf(await board(locationId), lager)).toMatchObject({ recommended: 9, rules: [{ id: first.rule.id, delta: 6 }] });

    // The rule card moves cider's the same way.
    expect((await decide(cider, 13, 'Cider fest')).status).toBe(200);
    const conversationId = await addConversation(server, { orgId, locationId, userId: member.session.userId, text: 'Remember the fest' });
    await showCards(conversationId, [{ id: 'toolu_order_rule5', name: 'propose_order_rule', input: { itemId: cider }, result: ORDER_RULE_RESULT }]);
    const cardPath = `/api/org/locations/${locationId}/chat/${conversationId}/order-proposals/toolu_order_rule5`;
    const card = await call(server, cardPath, { session: member.session, json: { action: 'save', situation: 'Cider fest' } });
    expect(await card.json()).toMatchObject({ proposal: { kind: 'rule', status: 'saved', itemId: cider, delta: 12, unit: 'bottles' } });
    expect(lineOf(await board(locationId), cider)).toMatchObject({ recommended: 13, rules: [{ delta: 12, situation: 'Cider fest' }] });
    expect(await server.connection.collection('tw_order_rules').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(2);
  });
});

describe('a count older than 90 days still counts (E3)', () => {
  it('orders the par less what was counted 100 days ago, not the whole par', async () => {
    const { locationId, lager } = await locationWithSetup('Old Count Bar');
    await server.connection.collection('tw_order_counts').insertOne({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), date: addDays(TODAY, -100), items: { [lager]: 2 },
      updatedAt: server.clock.now(),
    });
    const line = lineOf(await board(locationId), lager);
    expect(line).toMatchObject({ onHand: 2, countAgeDays: 100, recommended: 1, par: 3, confidence: 'low' });
    expect(line.why).toContain('The last count was 100 days ago, so this follows the par.');
  });
});

// Last: it moves the clock 15.5 hours on, to 03:30Z, when the town's date (still Monday) is not the UTC date.
describe('the live board scaled to a published forecast, read at 03:30Z (E13)', () => {
  const RUN = JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('scales each window day by the forecast’s guests over the location’s own, on the town’s date', async () => {
    const forecastOrgId = await createOrg(server, { name: 'Forecast Tavern', forecastsOn: true });
    const owner = await person(forecastOrgId, 'forecast-member', 'member');
    const locationId = await addLocation(server, { orgId: forecastOrgId, name: 'Forecast Bar' });
    const setupRes = await call(server, `${base(locationId)}/setup`, { method: 'PUT', session: owner.session, json: { expectedVersion: 0, setup: SETUP } });
    const { setup } = await setupRes.json() as { setup: StoredSetup };
    const lager = setup.items[0]?.id ?? '';
    // Eight weeks of item sales and guests through yesterday, 100 guests a day.
    const sent = Array.from({ length: 56 }, (_, i) => ({ date: addDays('2026-04-06', i), items: { [lager]: 20 } }));
    for (const chunk of [sent.slice(0, 31), sent.slice(31)]) {
      const res = await call(server, `${base(locationId)}/item-sales`, {
        session: owner.session, json: { from: chunk[0]?.date, to: chunk.at(-1)?.date, days: chunk },
      });
      expect(res.status).toBe(200);
    }
    for (const day of sent) await addSalesDay(server, { orgId: forecastOrgId, locationId, date: day.date, guests: 100, netSalesCents: null });
    expect((await call(server, `${base(locationId)}/counts`, { session: owner.session, json: { date: TODAY, items: { [lager]: 1 } } })).status).toBe(204);

    // A published forecast of 150 guests a day for the two weeks from today.
    const days = Array.from({ length: 14 }, (_, i) => ({
      date: addDays(TODAY, i), status: 'open', low: 120, mid: 150, high: 180, baseline: null, reasons: [{ kind: 'weekday', ref: null, effectPct: null }],
    }));
    const weeks = [0, 7].map((offset) => ({ from: addDays(TODAY, offset), to: addDays(TODAY, offset + 6), openDays: 7, low: 840, mid: 1050, high: 1260 }));
    const staff = await signInStaff(server);
    try {
      const imported = await call(server, `/api/admin/orgs/${forecastOrgId}/locations/${locationId}/forecast-runs`, {
        session: staff, json: { ...RUN, dataThrough: '2026-05-31', madeAt: TODAY, days, weeks },
      });
      expect(imported.status).toBe(201);
      const { run } = await imported.json() as { run: { id: string } };
      expect((await call(server, `/api/admin/orgs/${forecastOrgId}/forecast-runs/${run.id}/publish`, { session: staff, json: {} })).status).toBe(200);
    } finally {
      await removeStaffFactor(server);
    }

    server.clock.advance(15.5 * 3_600_000);
    expect(server.clock.now().toISOString()).toBe('2026-06-02T03:30:00.000Z');
    expect(localDay(server.clock.now(), 'America/New_York')).toBe(TODAY);
    await refresh(server, owner.session);
    const answer = await board(locationId, owner);
    expect(answer.today).toBe(TODAY);
    const line = lineOf(answer, lager);
    // Still Monday in Hanover at 11:30pm: order by Wednesday, the window Wednesday through the next Wednesday.
    expect(answer.orders[0]).toMatchObject({ cutoff: '2026-06-03', delivery: '2026-06-04', coversThrough: '2026-06-11' });
    // 8 window days x 20 servings x 150 / 100 guests, over 24 servings a case less 1%.
    expect(line.mu).toBeCloseTo((8 * 20 * 1.5) / (24 * 0.99), 9);
    expect(line.why).toContain('from the last 8 weeks of sales, scaled to the guest forecast.');
    const plain = computeOrders({
      suppliers: setup.suppliers, items: setup.items, itemSales: sent, counts: new Map([[lager, { quantity: 1, date: TODAY }]]),
      forecastGuests: new Map(), closedDays: new Set(), historyGuests: [], today: TODAY, nowMinutes: 23 * 60 + 30,
    })[0]?.lines.find((planned) => planned.itemId === lager);
    expect(line.mu).toBeCloseTo((plain?.mu ?? 0) * 1.5, 9);
  });
});
