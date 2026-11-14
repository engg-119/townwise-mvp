// The ordering data layer (design Decisions 3 and 7): the setup under compare-and-set, item sales replaced by range,
// counts merged per day, order cards and rules under races, and tenant scoping. Every figure is synthetic.
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { mintIds, setupInput } from '../src/orders/setup.ts';
import { createItemSalesStore, type ItemSalesStore } from '../src/stores/item-sales.ts';
import { createOrderCountStore, orderCountModel, type OrderCountStore } from '../src/stores/order-counts.ts';
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

  it('a replacing re-upload of a range replaces its days and deletes the one it no longer sends; a retry gives the same result', async () => {
    const t = tenant();
    const now = server.clock.now();
    expect(await itemSales.apply(t.scope, t.locationId, {
      from: FIRST, to: LAST, days: week.map((date) => ({ date, items: { [lager]: 10, [keg]: 2 } })), now, replace: true,
    })).toEqual({ stored: 7, removed: 0, kept: 0 });
    // A day outside the range is untouched.
    await itemSales.apply(t.scope, t.locationId, {
      from: '2026-05-11', to: '2026-05-11', days: [{ date: '2026-05-11', items: { [lager]: 1 } }], now, replace: true,
    });

    const again = { from: FIRST, to: LAST, days: week.slice(0, 6).map((date) => ({ date, items: { [lager]: 12 } })), now, replace: true };
    expect(await itemSales.apply(t.scope, t.locationId, again)).toEqual({ stored: 6, removed: 1, kept: 0 });
    const after = await itemSales.days(t.scope, t.locationId, { from: '2026-05-01', to: '2026-05-31' });
    expect(after).toEqual([...week.slice(0, 6).map((date) => ({ date, items: { [lager]: 12 } })), { date: '2026-05-11', items: { [lager]: 1 } }]);
    expect(await itemSales.apply(t.scope, t.locationId, again)).toEqual({ stored: 6, removed: 0, kept: 0 });
    expect(await itemSales.days(t.scope, t.locationId, { from: '2026-05-01', to: '2026-05-31' })).toEqual(after);

    // Sending no day clears the range.
    expect(await itemSales.apply(t.scope, t.locationId, { from: FIRST, to: '2026-05-05', days: [], now, replace: true }))
      .toEqual({ stored: 0, removed: 2, kept: 0 });
  });

  it('an adding upload inserts only the days not stored, leaves stored days as they are and deletes none; a retry gives the same days', async () => {
    const t = tenant();
    const now = server.clock.now();
    await itemSales.apply(t.scope, t.locationId, {
      from: FIRST, to: '2026-05-05', days: [{ date: FIRST, items: { [lager]: 10 } }, { date: '2026-05-05', items: { [keg]: 2 } }], now, replace: true,
    });
    const before = await itemSales.days(t.scope, t.locationId, { from: '2026-05-01', to: '2026-05-31' });
    // No day sent, and a stored day sent with no items: nothing is deleted or zeroed.
    expect(await itemSales.apply(t.scope, t.locationId, { from: FIRST, to: LAST, days: [], now, replace: false }))
      .toEqual({ stored: 0, removed: 0, kept: 0 });
    const add = { from: FIRST, to: LAST, days: [{ date: FIRST, items: {} }, { date: '2026-05-06', items: { [lager]: 4 } }], now, replace: false };
    expect(await itemSales.apply(t.scope, t.locationId, add)).toEqual({ stored: 1, removed: 0, kept: 1 });
    const after = await itemSales.days(t.scope, t.locationId, { from: '2026-05-01', to: '2026-05-31' });
    expect(after).toEqual([...before, { date: '2026-05-06', items: { [lager]: 4 } }]);
    expect(await itemSales.apply(t.scope, t.locationId, add)).toEqual({ stored: 0, removed: 0, kept: 2 });
    expect(await itemSales.days(t.scope, t.locationId, { from: '2026-05-01', to: '2026-05-31' })).toEqual(after);
  });

  it('reads days in a range oldest first, reports coverage, and deletes the location’s days with a count', async () => {
    const t = tenant();
    const now = server.clock.now();
    expect(await itemSales.coverage(t.scope, t.locationId)).toBeNull();
    await itemSales.apply(t.scope, t.locationId, {
      from: FIRST, to: LAST, days: [...week].reverse().map((date, i) => ({ date, items: { [lager]: i + 0.5 } })), now, replace: true,
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
    await expect(itemSales.apply(t.scope, t.locationId, { from: FIRST, to: FIRST, days, now: server.clock.now(), replace: true })).rejects.toThrow();
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

    expect(await counts.latest(t.scope, t.locationId, '2026-05-01', [a, b, c])).toEqual(new Map([
      [a, { quantity: 2, date: '2026-05-28' }], [b, { quantity: 5, date: '2026-05-28' }], [c, { quantity: 0, date: '2026-05-28' }],
    ]));
    // Only the items asked for.
    expect(await counts.latest(t.scope, t.locationId, '2026-05-01', [a])).toEqual(new Map([[a, { quantity: 2, date: '2026-05-28' }]]));
    const older = id();
    await counts.save(t.scope, t.locationId, '2026-05-21', { [older]: 7 }, now);
    expect((await counts.latest(t.scope, t.locationId, '2026-05-01', [a, older])).get(older)).toEqual({ quantity: 7, date: '2026-05-21' });
    expect((await counts.latest(t.scope, t.locationId, '2026-05-22', [a, older])).has(older)).toBe(false);
  });

  // #68 second review N4: newest first, in batches, stopping once every item asked for has a count; still bounded by `since`.
  it('reads newest first in batches and stops once every item has a count, with the same results', async () => {
    const t = tenant();
    const [often, rare, never] = [id(), id(), id()];
    const now = server.clock.now();
    // 70 daily counts of one item, and one count of another on the oldest day: three batches of 30 reach it.
    const dates = Array.from({ length: 70 }, (_, i) => new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10));
    for (const [i, date] of dates.entries()) await counts.save(t.scope, t.locationId, date, { [often]: i }, now);
    await counts.save(t.scope, t.locationId, dates[0] ?? '', { [rare]: 4 }, now);
    const newest = { quantity: 69, date: dates[69] };
    const find = vi.spyOn(orderCountModel(server.connection), 'find');
    try {
      expect(await counts.latest(t.scope, t.locationId, '2026-01-01', [often])).toEqual(new Map([[often, newest]]));
      // The newest batch held a count of the only item asked for.
      expect(find).toHaveBeenCalledTimes(1);
      find.mockClear();
      expect(await counts.latest(t.scope, t.locationId, '2026-01-01', [often, rare])).toEqual(new Map([
        [often, newest], [rare, { quantity: 4, date: dates[0] }],
      ]));
      expect(find).toHaveBeenCalledTimes(3);
      find.mockClear();
      // An item never counted reads every batch since the bound, and is left out.
      expect([...(await counts.latest(t.scope, t.locationId, '2026-01-01', [often, never])).keys()]).toEqual([often]);
      expect(find).toHaveBeenCalledTimes(3);
      expect((await counts.latest(t.scope, t.locationId, dates[1] ?? '', [rare])).size).toBe(0);
      expect((await counts.latest(t.scope, t.locationId, '2026-01-01', [])).size).toBe(0);
    } finally {
      find.mockRestore();
    }
  });

  it('two first counts of one day both land', async () => {
    const t = tenant();
    const [a, b] = [id(), id()];
    await Promise.all([
      counts.save(t.scope, t.locationId, '2026-05-28', { [a]: 1 }, server.clock.now()),
      counts.save(t.scope, t.locationId, '2026-05-28', { [b]: 2 }, server.clock.now()),
    ]);
    expect([...(await counts.latest(t.scope, t.locationId, '2026-05-28', [a, b])).keys()].sort()).toEqual([a, b].sort());
  });
});

describe('order cards and rules under races', () => {
  const key = () => ({ conversationId: id(), proposalId: 'toolu_order0001' });

  it('a dismiss after a save leaves the card saved; a save after a dismiss saves it; only a move is a change', async () => {
    const t = tenant();
    const card = key();
    const now = server.clock.now();
    const saved = await orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'saved', now });
    expect(saved).toEqual({ card: { proposalId: card.proposalId, kind: 'change', status: 'saved', decisionId: expect.stringMatching(HEX) as unknown }, changed: true });
    expect(await orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'dismissed', now }))
      .toEqual({ card: saved.card, changed: false });
    expect(await orders.findCard(t.scope, card)).toEqual(saved.card);

    const other = key();
    expect(await orders.setCard(t.scope, t.locationId, other, { kind: 'rule', status: 'dismissed', now })).toMatchObject({ card: { status: 'dismissed' }, changed: true });
    // Dismissed again: nothing moved.
    expect(await orders.setCard(t.scope, t.locationId, other, { kind: 'rule', status: 'dismissed', now })).toMatchObject({ card: { status: 'dismissed' }, changed: false });
    expect(await orders.setCard(t.scope, t.locationId, other, { kind: 'rule', status: 'saved', now })).toMatchObject({ card: { status: 'saved' }, changed: true });
    const stored = await server.connection.collection('tw_order_cards').findOne({ conversationId: new Types.ObjectId(other.conversationId) });
    expect(stored).toMatchObject({ locationId: new Types.ObjectId(t.locationId), kind: 'rule', status: 'saved' });
  });

  it('every claim of a change card gets one decision id, so racing saves store one edit; a saved card is not claimed (A3)', async () => {
    const t = tenant();
    const card = key();
    const now = server.clock.now();
    const ids = await Promise.all(Array.from({ length: 5 }, () => orders.claimChange(t.scope, t.locationId, card, now)));
    expect(new Set(ids).size).toBe(1);
    const [decisionId] = ids;
    expect(decisionId).toMatch(HEX);
    expect((await orders.findCard(t.scope, card))?.status).toBe('saving');
    const input = {
      itemId: id(), delivery: '2026-06-04', windowStart: '2026-06-03', windowEnd: '2026-06-10', recommended: 4, unit: 'cases', now,
    };
    const stored = await Promise.all([3, 5, 7].map((quantity) =>
      orders.addDecision(t.scope, t.locationId, { ...input, id: decisionId ?? '', quantity, reason: `try ${String(quantity)}` })));
    expect(new Set(stored.map((decision) => decision.id))).toEqual(new Set([decisionId]));
    expect(new Set(stored.map((decision) => decision.quantity)).size).toBe(1);
    expect(await server.connection.collection('tw_order_decisions').countDocuments({ itemId: input.itemId })).toBe(1);
    const marks = await Promise.all(Array.from({ length: 3 }, () => orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'saved', now })));
    expect(marks.filter((mark) => mark.changed)).toHaveLength(1);
    expect(await orders.claimChange(t.scope, t.locationId, card, now)).toBeNull();
  });

  it('lists the edits for deliveries from a date on, newest first (A9)', async () => {
    const t = tenant();
    const base = { itemId: id(), windowStart: '2026-05-27', windowEnd: '2026-06-03', recommended: 4, quantity: 5, unit: 'cases', reason: 'r' };
    for (const [delivery, minute] of [['2026-05-28', 1], ['2026-06-04', 2], ['2026-06-11', 3]] as const) {
      await orders.addDecision(t.scope, t.locationId, { ...base, delivery, now: new Date(Date.UTC(2026, 5, 1, 12, minute)) });
    }
    expect((await orders.listDecisions(t.scope, t.locationId, '2026-06-01')).map((decision) => decision.delivery)).toEqual(['2026-06-11', '2026-06-04']);
  });

  it('racing first inserts of one card never throw, and a saved one stays saved', async () => {
    const t = tenant();
    const card = key();
    const now = server.clock.now();
    const results = await Promise.all([
      orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'saved', now }),
      ...Array.from({ length: 4 }, () => orders.setCard(t.scope, t.locationId, card, { kind: 'change', status: 'dismissed', now })),
    ]);
    expect(results[0].card.status).toBe('saved');
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
    expect(first.created).toBe(true);
    expect(await orders.addRule(t.scope, t.locationId, { ...input, delta: 5 })).toEqual({ rule: first.rule, created: false });

    const raced = { ...input, itemId: id() };
    const results = await Promise.all(Array.from({ length: 5 }, () => orders.addRule(t.scope, t.locationId, raced)));
    expect(new Set(results.map(({ rule }) => rule.id)).size).toBe(1);
    // A4: only the save that stored it says so, so only it is audited.
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(await server.connection.collection('tw_order_rules').countDocuments({ itemId: raced.itemId })).toBe(1);
  });

  // #68 second review N1: a rule in another unit applies to no line, so saving its reason again moves it, once.
  it('moves an active rule saved in another unit to the new amount and unit, compare-and-set, and leaves a turned-off one', async () => {
    const t = tenant();
    const input = { itemId: id(), delta: 2, unit: 'cases', situation: 'a football weekend', now: server.clock.now() };
    const first = await orders.addRule(t.scope, t.locationId, input);
    const results = await Promise.all(Array.from({ length: 4 }, () => orders.addRule(t.scope, t.locationId, { ...input, delta: 48, unit: 'bottles' })));
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    for (const { rule } of results) expect(rule).toMatchObject({ id: first.rule.id, delta: 48, unit: 'bottles', off: false });
    expect(await orders.findRule(t.scope, t.locationId, input.itemId, input.situation)).toMatchObject({ delta: 48, unit: 'bottles' });
    expect(await server.connection.collection('tw_order_rules').countDocuments({ itemId: input.itemId })).toBe(1);

    const off = { ...input, itemId: id() };
    const stored = await orders.addRule(t.scope, t.locationId, off);
    expect(await orders.turnOff(t.scope, t.locationId, stored.rule.id, server.clock.now())).toBe(true);
    expect(await orders.addRule(t.scope, t.locationId, { ...off, delta: 48, unit: 'bottles' }))
      .toEqual({ rule: { ...stored.rule, off: true }, created: false });
  });

  // #68 second review N3 and R4.
  it('finds a decision by its id, and names the items with any edit or rule', async () => {
    const t = tenant();
    const [edited, ruled, plain] = [id(), id(), id()];
    const now = server.clock.now();
    const decision = await orders.addDecision(t.scope, t.locationId, {
      itemId: edited, delivery: '2026-01-08', windowStart: '2026-01-07', windowEnd: '2026-01-14', recommended: 4, quantity: 6, unit: 'cases',
      reason: 'r', now,
    });
    expect(await orders.findDecision(t.scope, t.locationId, decision.id)).toEqual(decision);
    expect(await orders.findDecision(t.scope, t.locationId, id())).toBeNull();
    expect(await orders.findDecision(t.scope, t.locationId, 'not-an-id')).toBeNull();
    const rule = await orders.addRule(t.scope, t.locationId, { itemId: ruled, delta: 1, unit: 'cases', situation: 's', now });
    await orders.turnOff(t.scope, t.locationId, rule.rule.id, now);
    expect(await orders.itemsWithEdits(t.scope, t.locationId, [edited, ruled, plain])).toEqual(new Set([edited, ruled]));
    expect(await orders.itemsWithEdits(t.scope, t.locationId, [plain])).toEqual(new Set());
    expect(await orders.itemsWithEdits(t.scope, t.locationId, [])).toEqual(new Set());
    const other = tenant();
    expect(await orders.findDecision(other.scope, t.locationId, decision.id)).toBeNull();
    expect(await orders.itemsWithEdits(other.scope, t.locationId, [edited, ruled])).toEqual(new Set());
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
    await itemSales.apply(a.scope, a.locationId, {
      from: '2026-05-01', to: '2026-05-01', days: [{ date: '2026-05-01', items: { [item]: 3 } }], now, replace: true,
    });
    await counts.save(a.scope, a.locationId, '2026-05-01', { [item]: 4 }, now);
    await orders.setCard(a.scope, a.locationId, card, { kind: 'change', status: 'saved', now });

    expect(await setups.get(b.scope, b.locationId)).toBeNull();
    expect(await setups.save(b.scope, b.locationId, 1, newSetup('Intruder'), now)).toBe('changed');
    expect(await itemSales.days(b.scope, b.locationId, { from: '2026-05-01', to: '2026-05-31' })).toEqual([]);
    expect(await itemSales.coverage(b.scope, b.locationId)).toBeNull();
    expect((await counts.latest(b.scope, b.locationId, '2026-01-01', [item])).size).toBe(0);
    expect(await orders.findCard(b.scope, card)).toBeNull();
    // B's range replace and deletes reach nothing of A's.
    expect(await itemSales.apply(b.scope, b.locationId, { from: '2026-05-01', to: '2026-05-31', days: [], now, replace: true }))
      .toEqual({ stored: 0, removed: 0, kept: 0 });
    expect(await setups.removeForLocation(b.scope, b.locationId)).toBe(0);
    expect(await itemSales.removeForLocation(b.scope, b.locationId)).toBe(0);
    expect(await counts.removeForLocation(b.scope, b.locationId)).toBe(0);
    expect(await orders.removeForConversation(b.scope, card.conversationId)).toBe(0);

    expect(await setups.get(a.scope, a.locationId)).toEqual(stored);
    expect(await itemSales.coverage(a.scope, a.locationId)).toEqual({ firstDate: '2026-05-01', lastDate: '2026-05-01', dayCount: 1 });
    expect((await counts.latest(a.scope, a.locationId, '2026-01-01', [item])).get(item)).toEqual({ quantity: 4, date: '2026-05-01' });
    expect((await orders.findCard(a.scope, card))?.status).toBe('saved');
  });
});
