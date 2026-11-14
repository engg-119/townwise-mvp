// Orders through the API (design Decisions 2 to 8; the order-setup, item-sales, order-counts and order-board specs):
// the setup under compare-and-set, item sales by range, counts, who may do what, isolation, view-as, the exact audit
// details of every order write, and one live board end to end against the engine. Synthetic figures throughout.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ORDER_UNAVAILABLE, liveBoard, type OrderBoard, type OrderLine } from '../src/orders/board.ts';
import { addDays } from '../src/orders/dates.ts';
import { computeOrders, type ItemSalesDay } from '../src/orders/engine.ts';
import type { StoredSetup } from '../src/stores/order-setups.ts';
import { ORDER_CHANGE_RESULT } from '../src/chat/tools/orders.ts';
import { localMinutes } from '../src/time-zones.ts';
import { addConversation, addGrant, addLocation, addSeat, auditEvents, createOrg, ORDER_COLLECTIONS } from './helpers/fixtures.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
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

async function board(locationId: string, who: Person = member): Promise<OrderBoard> {
  const res = await call(server, base(locationId), { session: who.session });
  expect(res.status).toBe(200);
  const body = await res.json() as OrderBoard;
  expect(body.available).toBe(true);
  return body;
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
    expect(await res.json()).toEqual({ setup: null, coverage: null, itemCoverage: {}, counts: {} });
    const orders = await call(server, base(locationId), { session: member.session });
    expect(await orders.json()).toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the supplier schedule', 'the items'] });
    const decision = await call(server, `${base(locationId)}/decisions`, {
      session: member.session, json: { itemId: 'a'.repeat(24), delivery: '2026-06-04', quantity: 2, reason: 'Busy week' },
    });
    expect(await errorOf(decision)).toEqual({ status: 409, error: 'order_unavailable' });
    // The labeled sample still answers.
    const sample = await (await call(server, `${base(locationId)}?sample=true`, { session: member.session })).json() as OrderBoard;
    expect(sample).toMatchObject({ available: true, sample: true });
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

  it('a setup with no items, or no supplier, says so on the board', async () => {
    const locationId = await addLocation(server, { orgId, name: 'Half Bar' });
    expect((await putSetup(locationId, { expectedVersion: 0, setup: { suppliers: SETUP.suppliers, items: [] } })).status).toBe(200);
    expect(await (await call(server, base(locationId), { session: member.session })).json())
      .toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the items'] });
    expect((await putSetup(locationId, { expectedVersion: 1, setup: { suppliers: [], items: [] } })).status).toBe(200);
    expect(await (await call(server, base(locationId), { session: member.session })).json())
      .toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the supplier schedule', 'the items'] });
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

  it('a member uploads a range: sent days replace, unsent days in the range go, and the event carries counts and dates only', async () => {
    const week = MAY.map((date, i) => ({ date, items: { [lager]: 10 + i, [cider]: i < 2 ? 0 : 2 } }));
    const first = await upload({ from: MAY[0], to: MAY[6], days: week });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ stored: 7, removed: 0 });
    const again = await upload({ from: MAY[0], to: MAY[6], days: week.slice(0, 6) });
    expect(await again.json()).toEqual({ stored: 6, removed: 1 });

    const events = await eventsOf('order.item_sales_uploaded', locationId);
    expect(events.map((event) => event.details)).toEqual([
      { locationId, dayCount: 7, itemCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-07' },
      { locationId, dayCount: 6, itemCount: 2, firstDate: '2026-05-01', lastDate: '2026-05-07' },
    ]);
    expect(events[0]).toMatchObject({ actorUserId: member.session.userId, actorRole: 'member' });

    const read = await (await call(server, `${base(locationId)}/setup`, { session: member.session })).json() as Record<string, unknown>;
    expect(read.coverage).toEqual({ firstDate: '2026-05-01', lastDate: '2026-05-06', dayCount: 6 });
    // Cider sold nothing on the first two days, so it has four days with sales.
    expect(read.itemCoverage).toEqual({ [lager]: 6, [cider]: 4 });
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
      forecastGuests: new Map(), historyGuests: [], today: TODAY, nowMinutes: localMinutes(server.clock.now(), 'America/New_York'),
    });
    expect(answer).toEqual({ ...liveBoard(plans, []), missing: [] });
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
    expect(await saved.json()).toEqual({ proposal: { ...view, status: 'saved', quantity: 4, reason: 'Cider tasting' } });
    expect(lineOf(await board(locationId), cider).edit).toEqual({ quantity: 4, reason: 'Cider tasting' });
    expect(await (await act('toolu_order_change1', { action: 'save', quantity: 5, reason: 'Again' })).json())
      .toEqual({ proposal: { ...view, status: 'saved' } });
    expect(await (await act('toolu_order_change1', { action: 'dismiss' })).json()).toEqual({ proposal: { ...view, status: 'saved' } });
    expect(await server.connection.collection('tw_order_decisions').countDocuments({ locationId: new Types.ObjectId(locationId), itemId: cider }))
      .toBe(1);
    expect(await (await act('toolu_order_change2', { action: 'dismiss' })).json()).toEqual({ proposal: { ...view, status: 'dismissed' } });

    expect((await eventsOf('order.card_saved', locationId)).map((event) => event.details)).toEqual([{ locationId, conversationId, kind: 'change' }]);
    const dismissed = await eventsOf('order.card_dismissed', locationId);
    expect(dismissed.map((event) => event.details)).toEqual([{ locationId, conversationId, kind: 'change' }]);
    expect(dismissed[0]).toMatchObject({ target: { type: 'conversation', id: conversationId } });
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Cider tasting');
  });
});
