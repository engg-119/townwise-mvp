// The order tools (design Decision 9, the townwise-ai-orders spec), without Docker: each reads the live board or the
// setup from fakes of the stores, never the labeled sample; answers available false or shown false when there is
// nothing to read or show; and its card's views carry ids, dates, booleans and counts only. Synthetic data only.
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { ORDER_CHANGE_RESULT, ORDER_RULE_RESULT } from '../src/chat/tools/orders.ts';
import { inputViewOf, resultViewOf, toolNamed, type ToolContext, type ToolView } from '../src/chat/tools/registry.ts';
import { ORDER_UNAVAILABLE } from '../src/orders/board.ts';
import type { ForecastWindow } from '../src/forecasts/reader.ts';
import type { ItemSalesDay } from '../src/stores/item-sales.ts';
import type { StoredSetup } from '../src/stores/order-setups.ts';
import type { DecisionRecord, RuleRecord } from '../src/stores/orders.ts';

// 2026-11-10 is a Tuesday; 14:00 UTC is 9:00am in Hanover. The supplier delivers Thursdays, order by Wednesday 5:00pm.
const TODAY = '2026-11-10';
const NOW = new Date('2026-11-10T14:00:00.000Z');
const DELIVERY = '2026-11-12';
const LOCATION_ID = '000000000000000000000001';
const SUPPLIER = '0000000000000000000000a1';
const LAGER = '0000000000000000000000b1';
const CIDER = '0000000000000000000000b2';
const UNKNOWN = '0000000000000000000000ff';
const POS_NAME = 'Sentinel-register-name';

const SETUP: StoredSetup = {
  version: 3,
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  suppliers: [{ id: SUPPLIER, name: 'Sentinel Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '17:00' }] }],
  items: [
    {
      id: LAGER, name: 'Sentinel Lager', supplierId: SUPPLIER, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 3,
      dealSize: null, neverRunOut: true, posNames: [{ name: POS_NAME, perSale: 1 }],
    },
    {
      id: CIDER, name: 'Sentinel Cider', supplierId: SUPPLIER, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 2,
      dealSize: 5, neverRunOut: false, posNames: [],
    },
  ],
};

function plusDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Six weeks covered, through yesterday: 12 lager servings a day, none on Sundays, never any cider. */
const SALES: ItemSalesDay[] = Array.from({ length: 42 }, (_unused, index) => {
  const date = plusDays('2026-09-29', index);
  return { date, items: new Date(`${date}T00:00:00.000Z`).getUTCDay() === 0 ? {} : { [LAGER]: 12 } };
});

const NO_FORECAST: ForecastWindow = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [], notCovered: [] };

interface Fakes {
  setup?: StoredSetup | null;
  decision?: DecisionRecord | null;
  rule?: RuleRecord | null;
  /** Each item-sales read's range, as it is made. */
  reads?: { from: string; to: string }[];
}

function context(fakes: Fakes = {}): ToolContext {
  const stores = {
    orderSetups: { get: () => Promise.resolve(fakes.setup === undefined ? SETUP : fakes.setup) },
    itemSales: {
      days: (_scope: OrgScope, _location: string, range: { from: string; to: string }) => {
        fakes.reads?.push(range);
        return Promise.resolve(SALES.filter((day) => day.date >= range.from && day.date <= range.to));
      },
      coverage: () => Promise.resolve({ firstDate: '2026-09-29', lastDate: '2026-11-09', dayCount: SALES.length }),
    },
    orderCounts: { latest: () => Promise.resolve(new Map([[LAGER, { quantity: 1.5, date: '2026-11-08' }]])) },
    salesDays: { days: () => Promise.resolve([]) },
    orders: {
      listDecisions: () => Promise.resolve([]),
      listRules: () => Promise.resolve([]),
      latestDecision: () => Promise.resolve(fakes.decision ?? null),
      findRule: () => Promise.resolve(fakes.rule ?? null),
      itemsWithEdits: () => Promise.resolve(new Set<string>()),
    },
  };
  return {
    ctx: { stores, ports: { forecasts: { window: () => Promise.resolve(NO_FORECAST) } }, now: () => NOW } as unknown as TownwiseContext,
    scope: { orgId: '000000000000000000000003' } as unknown as OrgScope,
    location: {
      id: LOCATION_ID, name: 'Test Taproom', placeId: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
      town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
    },
    today: TODAY,
    timeZone: 'America/New_York',
    role: 'member',
    actor: { actorUserId: 'user-1', actorEmail: 'member@example.test', actorRole: 'member', viewAsGrantId: null },
    turn: { readUntrusted: false },
  };
}

async function run(name: string, input: unknown, tc: ToolContext): Promise<string> {
  const tool = toolNamed(name);
  const parsed = tool?.parse(input, TODAY) ?? null;
  if (tool === undefined || parsed === null) throw new Error(`invalid input for ${name}`);
  return (await tool.run(tc, parsed)).content;
}

const json = (content: string): Record<string, unknown> => JSON.parse(content) as Record<string, unknown>;
const result = (content: string) => ({ type: 'tool_result' as const, tool_use_id: 't1', content });

function decision(fields: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: '0000000000000000000000d1', itemId: LAGER, delivery: DELIVERY, windowStart: '2026-11-11', windowEnd: '2026-11-18',
    recommended: 4, quantity: 6, unit: 'cases', reason: 'Sentinel game weekend', createdAt: NOW, ...fields,
  };
}

function rule(fields: Partial<RuleRecord>): RuleRecord {
  return {
    id: '0000000000000000000000e1', itemId: LAGER, delta: 2, unit: 'cases', situation: 'Sentinel game weekend', off: false,
    createdAt: NOW, ...fields,
  };
}

describe('the order tools’ inputs', () => {
  it('take no input for the board and the setup, and refuse any key', () => {
    for (const name of ['get_order_board', 'get_order_setup']) {
      expect(toolNamed(name)?.parse({}, TODAY)).toEqual({});
      // The board's old delivery input read the labeled sample; it is gone.
      for (const bad of [{ delivery: DELIVERY }, { itemId: LAGER }, null, 'board', []]) expect(toolNamed(name)?.parse(bad, TODAY)).toBeNull();
      expect(toolNamed(name)?.definition.input_schema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    }
  });

  it('take a setup item’s id, and a calendar date for a change, and nothing else: never a quantity', () => {
    expect(toolNamed('get_order_line')?.parse({ itemId: LAGER }, TODAY)).toEqual({ itemId: LAGER });
    expect(toolNamed('propose_order_rule')?.parse({ itemId: LAGER }, TODAY)).toEqual({ itemId: LAGER });
    expect(toolNamed('propose_order_change')?.parse({ itemId: LAGER, delivery: DELIVERY }, TODAY)).toEqual({ itemId: LAGER, delivery: DELIVERY });
    for (const name of ['get_order_line', 'propose_order_rule']) {
      for (const bad of [
        {}, { itemId: 'sample-lager' }, { itemId: LAGER.toUpperCase() }, { itemId: `${LAGER}0` }, { itemId: 42 },
        { itemId: LAGER, delivery: DELIVERY }, { itemId: LAGER, quantity: 6 },
      ]) expect(toolNamed(name)?.parse(bad, TODAY)).toBeNull();
    }
    for (const bad of [
      { itemId: LAGER }, { delivery: DELIVERY }, { itemId: LAGER, delivery: '2026-11-31' }, { itemId: LAGER, delivery: '11/12/2026' },
      { itemId: 'sample-lager', delivery: DELIVERY }, { itemId: LAGER, delivery: DELIVERY, quantity: 6 },
      { itemId: LAGER, delivery: DELIVERY, reason: 'Busy' },
    ]) expect(toolNamed('propose_order_change')?.parse(bad, TODAY)).toBeNull();
    for (const name of ['get_order_line', 'propose_order_change', 'propose_order_rule']) {
      expect(JSON.stringify(toolNamed(name)?.definition.input_schema)).not.toMatch(/quantity|reason|situation/);
    }
  });
});

describe('get_order_board', () => {
  it('returns the live board: each supplier’s next order with its deadline, and a line per item with its edit and rules', async () => {
    const board = json(await run('get_order_board', {}, context()));
    expect(board).toMatchObject({ available: true, missing: [] });
    const orders = board.orders as Record<string, unknown>[];
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      supplier: 'Sentinel Distributor', cutoff: '2026-11-11', cutoffTime: '17:00', delivery: DELIVERY, coversThrough: '2026-11-19',
      deadline: 'Order by Wed, Nov 11, 5:00pm. Thursday’s delivery lasts until next Thursday’s.',
    });
    const lines = orders[0]?.lines as Record<string, unknown>[];
    expect(lines.map((line) => line.itemId)).toEqual([LAGER, CIDER]);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual([
      'alternative', 'confidence', 'countAgeDays', 'edit', 'itemId', 'name', 'neverRunOut', 'onHand', 'par', 'recommended', 'rules', 'unit', 'why',
    ]);
    expect(lines[0]).toMatchObject({ name: 'Sentinel Lager', unit: 'cases', par: 3, onHand: 1.5, countAgeDays: 2, edit: null, rules: [] });
    expect(typeof lines[0]?.recommended).toBe('number');
  });

  // #68 second review N7: the line's par is the one it used; the owner's, as get_order_setup gives it, is named apart.
  it('names the owner’s par setupPar when a draft line’s par differs from it, and caps the line’s par at 999', async () => {
    const draft = (par: number): StoredSetup => ({
      ...SETUP, items: SETUP.items.map((item) => (item.id === LAGER ? { ...item, category: 'draft' as const, unit: 'kegs' as const, par } : item)),
    });
    const lineIn = (board: Record<string, unknown>, id: string): Record<string, unknown> | undefined =>
      (board.orders as { lines: Record<string, unknown>[] }[])[0]?.lines.find((row) => row.itemId === id);
    const board = json(await run('get_order_board', {}, context({ setup: draft(3) })));
    // About 12 servings a day over 8 days is more than one 24-serving keg: one more than the owner's par.
    expect(lineIn(board, LAGER)).toMatchObject({ par: 4, setupPar: 3 });
    expect(lineIn(board, CIDER)).not.toHaveProperty('setupPar');
    const line = json(await run('get_order_line', { itemId: LAGER }, context({ setup: draft(3) })));
    expect(line.line).toMatchObject({ par: 4, setupPar: 3 });
    const setup = json(await run('get_order_setup', {}, context({ setup: draft(3) })));
    expect((setup.items as Record<string, unknown>[])[0]).toMatchObject({ id: LAGER, par: 3 });
    const capped = lineIn(json(await run('get_order_board', {}, context({ setup: draft(999) }))), LAGER);
    expect(capped).toMatchObject({ par: 999 });
    expect(capped).not.toHaveProperty('setupPar');
  });

  it('never returns the labeled sample: with no setup it says what is missing', async () => {
    const content = await run('get_order_board', {}, context({ setup: null }));
    expect(json(content)).toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the supplier schedule', 'the items'] });
    const live = await run('get_order_board', {}, context());
    for (const answer of [content, live]) expect(answer).not.toMatch(/sample/i);
    const noItems = json(await run('get_order_board', {}, context({ setup: { ...SETUP, items: [] } })));
    expect(noItems).toEqual({ available: false, reason: ORDER_UNAVAILABLE, missing: ['the items'] });
  });
});

describe('get_order_line', () => {
  it('returns the item’s line with its math, its order’s dates, and its servings on the latest 28 covered days', async () => {
    const answer = json(await run('get_order_line', { itemId: LAGER }, context()));
    expect(answer).toMatchObject({
      available: true, missing: [],
      order: { supplier: 'Sentinel Distributor', cutoff: '2026-11-11', delivery: DELIVERY, coversThrough: '2026-11-19' },
      line: { itemId: LAGER, name: 'Sentinel Lager', onHand: 1.5, countAgeDays: 2, dealSize: null, coveredDays: 42, edit: null, rules: [] },
    });
    const line = answer.line as Record<string, unknown>;
    for (const key of ['mu', 'sigma', 'orderUpTo', 'target', 'recommended']) expect(typeof line[key]).toBe('number');
    // The same quantity the board gives.
    const board = json(await run('get_order_board', {}, context()));
    const onBoard = ((board.orders as { lines: Record<string, unknown>[] }[])[0]?.lines ?? []).find((row) => row.itemId === LAGER);
    expect(line.recommended).toBe(onBoard?.recommended);

    const days = answer.recentDays as { date: string; weekday: string; servings: number }[];
    expect(days).toHaveLength(28);
    expect(days[0]).toEqual({ date: '2026-10-13', weekday: 'Tue', servings: 12 });
    expect(days.at(-1)).toEqual({ date: '2026-11-09', weekday: 'Mon', servings: 12 });
    // A covered day the item did not sell on counts as none.
    expect(days.find((day) => day.date === '2026-11-08')).toEqual({ date: '2026-11-08', weekday: 'Sun', servings: 0 });
    expect(days.map((day) => day.date)).toEqual([...days.map((day) => day.date)].sort());
  });

  it('reads item sales once: the recent days are the ones the board was built from (A10)', async () => {
    const reads: { from: string; to: string }[] = [];
    const answer = json(await run('get_order_line', { itemId: LAGER }, context({ reads })));
    expect(answer).toMatchObject({ available: true });
    expect(reads).toEqual([{ from: '2026-03-11', to: '2026-11-09' }]);
  });

  it('answers available false for an item not on an order, and the board’s answer without a setup', async () => {
    const unknown = json(await run('get_order_line', { itemId: UNKNOWN }, context()));
    expect(unknown).toEqual({ available: false, reason: expect.stringContaining('ordering setup') as unknown });
    expect(Object.keys(unknown).sort()).toEqual(['available', 'reason']);
    // An item whose supplier has no delivery days has no order, so no line.
    const noDays = { ...SETUP, suppliers: [...SETUP.suppliers, { id: '0000000000000000000000a2', name: 'Other', deliveries: [] }],
      items: SETUP.items.map((item) => (item.id === CIDER ? { ...item, supplierId: '0000000000000000000000a2' } : item)) };
    expect(json(await run('get_order_line', { itemId: CIDER }, context({ setup: noDays })))).toMatchObject({ available: false });
    expect(json(await run('get_order_line', { itemId: LAGER }, context({ setup: null })))).toEqual({
      available: false, reason: ORDER_UNAVAILABLE, missing: ['the supplier schedule', 'the items'],
    });
  });
});

describe('get_order_setup', () => {
  it('returns suppliers with weekday names and order-by times, items with counts and sales days, and coverage, never point-of-sale names', async () => {
    const content = await run('get_order_setup', {}, context());
    expect(json(content)).toEqual({
      available: true,
      suppliers: [{ name: 'Sentinel Distributor', deliveries: [{ delivery: 'Thursday', orderBy: 'Wednesday', orderByTime: '5:00pm' }] }],
      items: [
        {
          id: LAGER, name: 'Sentinel Lager', supplier: 'Sentinel Distributor', category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24,
          par: 3, dealSize: null, neverRunOut: true, latestCount: { quantity: 1.5, date: '2026-11-08' },
          // Six weeks covered, less six Sundays with no sales.
          daysWithSales: 36,
        },
        {
          id: CIDER, name: 'Sentinel Cider', supplier: 'Sentinel Distributor', category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24,
          par: 2, dealSize: 5, neverRunOut: false, latestCount: null, daysWithSales: 0,
        },
      ],
      itemSalesCoverage: { firstDate: '2026-09-29', lastDate: '2026-11-09', dayCount: 42 },
    });
    expect(content).not.toContain(POS_NAME);
    expect(content).not.toMatch(/posNames|perSale/);
  });

  it('says what to set up and where when nothing is set up', async () => {
    const answer = json(await run('get_order_setup', {}, context({ setup: null })));
    expect(Object.keys(answer).sort()).toEqual(['available', 'reason']);
    expect(answer.available).toBe(false);
    expect(answer.reason).toContain('suppliers');
    expect(answer.reason).toContain('items');
    expect(answer.reason).toContain('Orders, then Ordering setup');
  });
});

describe('propose_order_change', () => {
  it('shows a card only for an item’s line on its supplier’s next delivery', async () => {
    expect(await run('propose_order_change', { itemId: LAGER, delivery: DELIVERY }, context())).toBe(ORDER_CHANGE_RESULT);
    for (const input of [{ itemId: LAGER, delivery: '2026-11-19' }, { itemId: LAGER, delivery: '2026-11-05' }, { itemId: UNKNOWN, delivery: DELIVERY }]) {
      const answer = json(await run('propose_order_change', input, context()));
      expect(answer).toEqual({ shown: false, reason: expect.stringContaining('next order') as unknown });
    }
    expect(json(await run('propose_order_change', { itemId: LAGER, delivery: DELIVERY }, context({ setup: null })))).toEqual({
      shown: false, reason: `Nothing was shown to the owner. ${ORDER_UNAVAILABLE}`,
    });
  });
});

describe('propose_order_rule', () => {
  it('shows a card only after a saved change that differs from the recommendation and has no rule yet', async () => {
    expect(await run('propose_order_rule', { itemId: LAGER }, context({ decision: decision({}) }))).toBe(ORDER_RULE_RESULT);
    for (const fakes of [
      {}, { decision: decision({ quantity: 4 }) }, { decision: decision({}), rule: rule({}) }, { decision: decision({}), rule: rule({ off: true }) },
    ]) {
      const answer = json(await run('propose_order_rule', { itemId: LAGER }, context(fakes)));
      expect(answer.shown).toBe(false);
      // Each reason says what a rule does.
      expect(answer.reason).toContain('every later order of the item');
      expect(answer.reason).not.toContain('Sentinel game weekend');
    }
  });

  // #68 second review N1: a rule saved in another unit applies to no line, so its reason is proposed again.
  it('shows a card when the change’s rule is in another unit, unless the owner turned it off', async () => {
    expect(await run('propose_order_rule', { itemId: LAGER }, context({ decision: decision({}), rule: rule({ unit: 'bottles' }) })))
      .toBe(ORDER_RULE_RESULT);
    const off = json(await run('propose_order_rule', { itemId: LAGER }, context({ decision: decision({}), rule: rule({ unit: 'bottles', off: true }) })));
    expect(off).toMatchObject({ shown: false, reason: expect.stringContaining('turned off') as unknown });
  });
});

describe('the order tools’ views', () => {
  const VIEW_KEYS = new Set([
    'available', 'orderCount', 'lineCount', 'cutoff', 'itemId', 'delivery', 'supplierCount', 'itemCount', 'countedItemCount',
    'itemSalesDayCount', 'shown',
  ]);

  function expectIdsDatesBooleansCounts(view: ToolView | null): void {
    for (const [key, value] of Object.entries(view ?? {})) {
      expect(VIEW_KEYS.has(key)).toBe(true);
      if (typeof value === 'number') {
        expect(key).toMatch(/Count$/);
        expect(Number.isInteger(value)).toBe(true);
      } else if (typeof value === 'string') {
        expect(value).toMatch(/^(?:\d{4}-\d{2}-\d{2}|[0-9a-f]{24})$/);
      } else {
        expect(typeof value).toBe('boolean');
      }
    }
  }

  it('show ids, dates, booleans and counts, never a name, a quantity or a reason', async () => {
    const tc = context({ decision: decision({}) });
    const board = await run('get_order_board', {}, tc);
    const line = await run('get_order_line', { itemId: LAGER }, tc);
    const setup = await run('get_order_setup', {}, tc);
    const views = {
      board: resultViewOf('get_order_board', result(board)),
      line: resultViewOf('get_order_line', result(line)),
      setup: resultViewOf('get_order_setup', result(setup)),
      change: resultViewOf('propose_order_change', result(await run('propose_order_change', { itemId: LAGER, delivery: DELIVERY }, tc))),
      rule: resultViewOf('propose_order_rule', result(await run('propose_order_rule', { itemId: LAGER }, tc))),
    };
    expect(views).toEqual({
      board: { available: true, orderCount: 1, lineCount: 2, cutoff: '2026-11-11' },
      line: { available: true, itemId: LAGER, delivery: DELIVERY },
      setup: { available: true, supplierCount: 1, itemCount: 2, countedItemCount: 1, itemSalesDayCount: 42 },
      change: { shown: true },
      rule: { shown: true },
    });
    const inputs = [
      inputViewOf('get_order_board', {}, TODAY), inputViewOf('get_order_setup', {}, TODAY),
      inputViewOf('get_order_line', { itemId: LAGER }, TODAY),
      inputViewOf('propose_order_change', { itemId: LAGER, delivery: DELIVERY }, TODAY),
      inputViewOf('propose_order_rule', { itemId: LAGER }, TODAY),
    ];
    expect(inputs).toEqual([null, null, { itemId: LAGER }, { itemId: LAGER, delivery: DELIVERY }, { itemId: LAGER }]);

    const unavailable = context({ setup: null });
    const empty = [
      resultViewOf('get_order_board', result(await run('get_order_board', {}, unavailable))),
      resultViewOf('get_order_line', result(await run('get_order_line', { itemId: UNKNOWN }, tc))),
      resultViewOf('get_order_setup', result(await run('get_order_setup', {}, unavailable))),
      resultViewOf('propose_order_change', result(await run('propose_order_change', { itemId: UNKNOWN, delivery: DELIVERY }, tc))),
      resultViewOf('propose_order_rule', result(await run('propose_order_rule', { itemId: LAGER }, context()))),
    ];
    expect(empty).toEqual([{ available: false }, { available: false }, { available: false }, { shown: false }, { shown: false }]);

    for (const view of [...Object.values(views), ...inputs, ...empty]) expectIdsDatesBooleansCounts(view);
    expect(JSON.stringify([views, inputs, empty])).not.toMatch(/Sentinel|cases|why|reason|1\.5/);
  });

  it('have no view for an unreadable result', () => {
    for (const name of ['get_order_board', 'get_order_line', 'get_order_setup', 'propose_order_change', 'propose_order_rule']) {
      expect(resultViewOf(name, result('not json'))).toBeNull();
      expect(resultViewOf(name, result(JSON.stringify({ other: 1 })))).toBeNull();
    }
  });
});
