// The ordering data layer (design Decisions 3 and 7): the setup under compare-and-set, item sales replaced by range,
// counts merged per day, order cards and rules under races, and tenant scoping. Every figure is synthetic.
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { mintIds, setupInput } from '../src/orders/setup.ts';
import { createItemSalesStore, type ItemSalesStore } from '../src/stores/item-sales.ts';
import { createOrderCountStore, type OrderCountStore } from '../src/stores/order-counts.ts';
import { createOrderSetupStore, type OrderSetupStore } from '../src/stores/order-setups.ts';
import { createOrderStore, type OrderStore } from '../src/stores/orders.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const HEX = /^[0-9a-f]{24}$/;

let server: TownwiseTestServer;
let setups: OrderSetupStore;
let itemSales: ItemSalesStore;
let counts: OrderCountStore;
let orders: OrderStore;

beforeAll(async () => {
  server = await startTownwiseServer();
  setups = createOrderSetupStore(server.connection);
  itemSales = createItemSalesStore(server.connection);
  counts = createOrderCountStore(server.connection);
  orders = createOrderStore(server.connection);
});
afterAll(async () => { await server.close(); });

interface Tenant { scope: OrgScope; locationId: string }

function tenant(): Tenant {
  return { scope: scopeForNewOrg(STAFF, new Types.ObjectId().toHexString()), locationId: new Types.ObjectId().toHexString() };
}

const id = (): string => new Types.ObjectId().toHexString();

function newSetup(itemName = 'Lager') {
  return mintIds(setupInput.parse({
    suppliers: [{ key: 'valley', name: 'Valley Beverage', deliveries: [{ deliveryWeekday: 3, cutoffWeekday: 1, cutoffTime: '14:00' }] }],
    items: [{
      name: itemName, supplierId: 'valley', category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 4, dealSize: null,
      neverRunOut: true, posNames: [{ name: 'Lager 12oz' }],
    }],
  }));
}

describe('order setups', () => {
  it('stores the first save as version 1 with minted ids, then saves only on the stored version', async () => {
    const t = tenant();
    expect(await setups.get(t.scope, t.locationId)).toBeNull();
    const setup = newSetup();
    const first = await setups.save(t.scope, t.locationId, 0, setup, server.clock.now());
    if (first === 'changed') throw new Error('first save refused');
    expect(first).toMatchObject({ version: 1, suppliers: setup.suppliers, items: setup.items });
    expect(first.suppliers[0]?.id).toMatch(HEX);
    expect(first.items[0]).toMatchObject({ supplierId: first.suppliers[0]?.id, dealSize: null, posNames: [{ name: 'Lager 12oz', perSale: 1 }] });
    expect(await setups.get(t.scope, t.locationId)).toEqual(first);

    expect(await setups.save(t.scope, t.locationId, 0, newSetup('Stale'), server.clock.now())).toBe('changed');
    expect(await setups.save(t.scope, t.locationId, 2, newSetup('Stale'), server.clock.now())).toBe('changed');
    const items = setup.items.map((each) => ({ ...each, par: 6, dealSize: 5 }));
    const second = await setups.save(t.scope, t.locationId, 1, { ...setup, items }, server.clock.now());
    expect(second).toMatchObject({ version: 2, items: [{ par: 6, dealSize: 5 }] });
    expect(await setups.save(t.scope, t.locationId, 1, newSetup('Stale'), server.clock.now())).toBe('changed');
    expect((await setups.get(t.scope, t.locationId))?.items[0]?.name).toBe('Lager');
  });

  it('two racing first saves: one is stored, the other is changed', async () => {
    const t = tenant();
    const results = await Promise.all([
      setups.save(t.scope, t.locationId, 0, newSetup('First'), server.clock.now()),
      setups.save(t.scope, t.locationId, 0, newSetup('Second'), server.clock.now()),
    ]);
    expect(results.filter((result) => result === 'changed')).toHaveLength(1);
    const stored = results.find((result) => result !== 'changed');
    expect(await setups.get(t.scope, t.locationId)).toEqual(stored);
  });
});

describe('item sales', () => {
  const FIRST = '2026-05-04';
  const LAST = '2026-05-10';
  const week = [FIRST, '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', LAST];
  const lager = id();
  const keg = id();

  it('a re-upload of a range replaces its days and deletes the one it no longer sends; a retry gives the same result', async () => {
    const t = tenant();
    const now = server.clock.now();
    expect(await itemSales.apply(t.scope, t.locationId, {
      from: FIRST, to: LAST, days: week.map((date) => ({ date, items: { [lager]: 10, [keg]: 2 } })), now,
    })).toEqual({ stored: 7, removed: 0 });
    // A day outside the range is untouched.
    await itemSales.apply(t.scope, t.locationId, { from: '2026-05-11', to: '2026-05-11', days: [{ date: '2026-05-11', items: { [lager]: 1 } }], now });

    const again = { from: FIRST, to: LAST, days: week.slice(0, 6).map((date) => ({ date, items: { [lager]: 12 } })), now };
    expect(await itemSales.apply(t.scope, t.locationId, again)).toEqual({ stored: 6, removed: 1 });
    const after = await itemSales.days(t.scope, t.locationId, { from: '2026-05-01', to: '2026-05-31' });
    expect(after).toEqual([...week.slice(0, 6).map((date) => ({ date, items: { [lager]: 12 } })), { date: '2026-05-11', items: { [lager]: 1 } }]);
    expect(await itemSales.apply(t.scope, t.locationId, again)).toEqual({ stored: 6, removed: 0 });
    expect(await itemSales.days(t.scope, t.locationId, { from: '2026-05-01', to: '2026-05-31' })).toEqual(after);

    // Sending no day clears the range.
    expect(await itemSales.apply(t.scope, t.locationId, { from: FIRST, to: '2026-05-05', days: [], now })).toEqual({ stored: 0, removed: 2 });
  });

  it('reads days in a range oldest first, reports coverage, and deletes the location’s days with a count', async () => {
    const t = tenant();
    const now = server.clock.now();
    expect(await itemSales.coverage(t.scope, t.locationId)).toBeNull();
    await itemSales.apply(t.scope, t.locationId, {
      from: FIRST, to: LAST, days: [...week].reverse().map((date, i) => ({ date, items: { [lager]: i + 0.5 } })), now,
    });
    const days = await itemSales.days(t.scope, t.locationId, { from: '2026-05-05', to: '2026-05-07' });
    expect(days.map((day) => day.date)).toEqual(week.slice(1, 4));
    expect(days[0]?.items[lager]).toBe(5.5);
    expect(await itemSales.coverage(t.scope, t.locationId)).toEqual({ firstDate: FIRST, lastDate: LAST, dayCount: 7 });
    expect(await itemSales.removeForLocation(t.scope, t.locationId)).toBe(7);
    expect(await itemSales.coverage(t.scope, t.locationId)).toBeNull();
  });

  it('refuses an item id that is not 24 hex characters, and stores nothing', async () => {
    const t = tenant();
    const days = [{ date: FIRST, items: { 'a.b': 1 } }];
    await expect(itemSales.apply(t.scope, t.locationId, { from: FIRST, to: FIRST, days, now: server.clock.now() })).rejects.toThrow();
    expect(await itemSales.coverage(t.scope, t.locationId)).toBeNull();
  });
});

describe('order counts', () => {
  it('a second count the same day adds its items and keeps the others; the newest date per item wins', async () => {
    const t = tenant();
    const [a, b, c] = [id(), id(), id()];
    const now = server.clock.now();
    await counts.save(t.scope, t.locationId, '2026-05-20', { [a]: 3, [b]: 1 }, now);
    await counts.save(t.scope, t.locationId, '2026-05-28', { [a]: 2, [b]: 4.5 }, now);
    await counts.save(t.scope, t.locationId, '2026-05-28', { [b]: 5, [c]: 0 }, now);
    const doc = await server.connection.collection('tw_order_counts').findOne({ locationId: new Types.ObjectId(t.locationId), date: '2026-05-28' });
    expect(doc?.items).toEqual({ [a]: 2, [b]: 5, [c]: 0 });
    await counts.save(t.scope, t.locationId, '2026-05-10', { [a]: 9 }, now);

    expect(await counts.latest(t.scope, t.locationId, '2026-05-01')).toEqual(new Map([
      [a, { quantity: 2, date: '2026-05-28' }], [b, { quantity: 5, date: '2026-05-28' }], [c, { quantity: 0, date: '2026-05-28' }],
    ]));
    const older = id();
    await counts.save(t.scope, t.locationId, '2026-05-21', { [older]: 7 }, now);
    expect((await counts.latest(t.scope, t.locationId, '2026-05-01')).get(older)).toEqual({ quantity: 7, date: '2026-05-21' });
    expect((await counts.latest(t.scope, t.locationId, '2026-05-22')).has(older)).toBe(false);
  });

  it('two first counts of one day both land', async () => {
    const t = tenant();
    const [a, b] = [id(), id()];
    await Promise.all([
      counts.save(t.scope, t.locationId, '2026-05-28', { [a]: 1 }, server.clock.now()),
      counts.save(t.scope, t.locationId, '2026-05-28', { [b]: 2 }, server.clock.now()),
    ]);
    expect([...(await counts.latest(t.scope, t.locationId, '2026-05-28')).keys()].sort()).toEqual([a, b].sort());
  });
});

describe('order cards and rules under races', () => {
  const key = () => ({ conversationId: id(), proposalId: 'toolu_order0001' });

  it('a dismiss after a save leaves the card saved; a save after a dismiss saves it', async () => {
    const t = tenant();
    const card = key();
    const now = server.clock.now();
    expect(await orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'saved', now }))
      .toEqual({ proposalId: card.proposalId, kind: 'change', status: 'saved' });
    expect(await orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'dismissed', now }))
      .toEqual({ proposalId: card.proposalId, kind: 'change', status: 'saved' });
    expect((await orders.findCard(t.scope, card))?.status).toBe('saved');

    const other = key();
    expect((await orders.setCard(t.scope, t.locationId, other, { kind: 'rule', status: 'dismissed', now })).status).toBe('dismissed');
    expect((await orders.setCard(t.scope, t.locationId, other, { kind: 'rule', status: 'saved', now })).status).toBe('saved');
    const stored = await server.connection.collection('tw_order_cards').findOne({ conversationId: new Types.ObjectId(other.conversationId) });
    expect(stored).toMatchObject({ locationId: new Types.ObjectId(t.locationId), kind: 'rule', status: 'saved' });
  });

  it('racing first inserts of one card never throw, and a saved one stays saved', async () => {
    const t = tenant();
    const card = key();
    const now = server.clock.now();
    const results = await Promise.all([
      orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'saved', now }),
      ...Array.from({ length: 4 }, () => orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'dismissed', now })),
    ]);
    expect(results[0].status).toBe('saved');
    expect((await orders.findCard(t.scope, card))?.status).toBe('saved');
    expect(await server.connection.collection('tw_order_cards').countDocuments({ conversationId: new Types.ObjectId(card.conversationId) })).toBe(1);
  });

  it('removes a conversation’s cards and no other conversation’s', async () => {
    const t = tenant();
    const [doomed, kept] = [key(), key()];
    for (const card of [doomed, kept]) await orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'dismissed', now: server.clock.now() });
    expect(await orders.removeForConversation(t.scope, doomed.conversationId)).toBe(1);
    expect(await orders.findCard(t.scope, doomed)).toBeNull();
    expect(await orders.findCard(t.scope, kept)).not.toBeNull();
  });

  it('saving one rule twice, or at once from several tabs, returns the one stored rule', async () => {
    const t = tenant();
    const input = { itemId: id(), delta: 2, unit: 'cases', situation: 'a football weekend', now: server.clock.now() };
    const first = await orders.addRule(t.scope, t.locationId, input);
    expect(await orders.addRule(t.scope, t.locationId, { ...input, delta: 5 })).toEqual(first);

    const raced = { ...input, itemId: id() };
    const results = await Promise.all(Array.from({ length: 5 }, () => orders.addRule(t.scope, t.locationId, raced)));
    expect(new Set(results.map((rule) => rule.id)).size).toBe(1);
    expect(await server.connection.collection('tw_order_rules').countDocuments({ itemId: raced.itemId })).toBe(1);
  });
});

describe('scoping', () => {
  it('another organization reads none of the location’s rows and deletes none of them', async () => {
    const a = tenant();
    const b = { scope: scopeForNewOrg(STAFF, new Types.ObjectId().toHexString()), locationId: a.locationId };
    const now = server.clock.now();
    const item = id();
    const card = { conversationId: id(), proposalId: 'toolu_order0001' };
    const stored = await setups.save(a.scope, a.locationId, 0, newSetup(), now);
    await itemSales.apply(a.scope, a.locationId, { from: '2026-05-01', to: '2026-05-01', days: [{ date: '2026-05-01', items: { [item]: 3 } }], now });
    await counts.save(a.scope, a.locationId, '2026-05-01', { [item]: 4 }, now);
    await orders.setCard(a.scope, a.locationId, card, { kind: 'change', status: 'saved', now });

    expect(await setups.get(b.scope, b.locationId)).toBeNull();
    expect(await setups.save(b.scope, b.locationId, 1, newSetup('Intruder'), now)).toBe('changed');
    expect(await itemSales.days(b.scope, b.locationId, { from: '2026-05-01', to: '2026-05-31' })).toEqual([]);
    expect(await itemSales.coverage(b.scope, b.locationId)).toBeNull();
    expect((await counts.latest(b.scope, b.locationId, '2026-01-01')).size).toBe(0);
    expect(await orders.findCard(b.scope, card)).toBeNull();
    // B's range replace and deletes reach nothing of A's.
    expect(await itemSales.apply(b.scope, b.locationId, { from: '2026-05-01', to: '2026-05-31', days: [], now })).toEqual({ stored: 0, removed: 0 });
    expect(await setups.removeForLocation(b.scope, b.locationId)).toBe(0);
    expect(await itemSales.removeForLocation(b.scope, b.locationId)).toBe(0);
    expect(await counts.removeForLocation(b.scope, b.locationId)).toBe(0);
    expect(await orders.removeForConversation(b.scope, card.conversationId)).toBe(0);

    expect(await setups.get(a.scope, a.locationId)).toEqual(stored);
    expect(await itemSales.coverage(a.scope, a.locationId)).toEqual({ firstDate: '2026-05-01', lastDate: '2026-05-01', dayCount: 1 });
    expect((await counts.latest(a.scope, a.locationId, '2026-01-01')).get(item)).toEqual({ quantity: 4, date: '2026-05-01' });
    expect((await orders.findCard(a.scope, card))?.status).toBe('saved');
  });
});
