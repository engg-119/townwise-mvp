// The ordering setup's input rules (orders/setup.ts, the order-setup spec): limits, an item's supplier by id or by a
// new supplier's key, and the ids the server mints for new rows.
import { describe, expect, it } from 'vitest';

import { checkSetup, mintIds, setupInput, type SetupInput } from '../src/orders/setup.ts';

const SUPPLIER_ID = 'a'.repeat(24);
const ITEM_ID = 'b'.repeat(24);
const HEX = /^[0-9a-f]{24}$/;

const delivery = { deliveryWeekday: 3, cutoffWeekday: 1, cutoffTime: '14:00' };

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Lager', supplierId: SUPPLIER_ID, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 4, dealSize: 5,
    neverRunOut: true, posNames: [{ name: 'Lager 12oz' }], ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { suppliers: [{ id: SUPPLIER_ID, name: 'Valley Beverage', deliveries: [delivery] }], items: [item()], ...overrides };
}

function parsed(input: unknown): SetupInput {
  return setupInput.parse(input);
}

describe('setupInput', () => {
  it('trims names and defaults servings per sale to 1', () => {
    const input = parsed(body({ items: [item({ name: '  Lager  ', posNames: [{ name: ' Lager 12oz ' }, { name: 'Lager pitcher', perSale: 4 }] })] }));
    expect(input.items[0]).toMatchObject({ name: 'Lager', posNames: [{ name: 'Lager 12oz', perSale: 1 }, { name: 'Lager pitcher', perSale: 4 }] });
  });

  it('lowercases a stored row’s id, so an item id is always a field name item sales and counts accept', () => {
    const input = parsed(body({ items: [item({ id: 'B'.repeat(24) })] }));
    expect(input.items[0]?.id).toBe(ITEM_ID);
  });

  it('refuses rows past the limits, unknown keys, and bad times or weekdays', () => {
    const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
    const bad: unknown[] = [
      body({ suppliers: many(21, (i) => ({ key: `s${String(i)}`, name: `S${String(i)}`, deliveries: [delivery] })) }),
      body({ items: many(301, () => item()) }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'Valley', deliveries: [] }] }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'Valley', deliveries: many(8, (i) => ({ ...delivery, deliveryWeekday: i % 7 })) }] }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'x'.repeat(61), deliveries: [delivery] }] }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'Valley', deliveries: [{ ...delivery, cutoffTime: '24:00' }] }] }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'Valley', deliveries: [{ ...delivery, cutoffTime: '9:00' }] }] }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'Valley', deliveries: [{ ...delivery, deliveryWeekday: 7 }] }] }),
      body({ suppliers: [{ id: 'not-hex', name: 'Valley', deliveries: [delivery] }] }),
      body({ items: [item({ name: '   ' })] }),
      body({ items: [item({ name: 'x'.repeat(81) })] }),
      body({ items: [item({ category: 'wine' })] }),
      body({ items: [item({ unit: 'pallets' })] }),
      body({ items: [item({ servingsPerUnit: 0 })] }),
      body({ items: [item({ servingsPerUnit: 2001 })] }),
      body({ items: [item({ par: 1000 })] }),
      body({ items: [item({ par: 1.5 })] }),
      body({ items: [item({ dealSize: 0 })] }),
      body({ items: [item({ posNames: many(11, (i) => ({ name: `Name ${String(i)}` })) })] }),
      body({ items: [item({ posNames: [{ name: 'Lager', perSale: 51 }] })] }),
      body({ items: [item({ posNames: [{ name: 'Lager', perSale: 0 }] })] }),
      body({ items: [item({ price: 3 })] }),
      body({ extra: true }),
    ];
    for (const input of bad) expect(setupInput.safeParse(input).success).toBe(false);
    expect(setupInput.safeParse(body({ items: [item({ dealSize: null, par: 0, servingsPerUnit: 2000 })] })).success).toBe(true);
  });
});

describe('checkSetup', () => {
  it('accepts an item naming its supplier by id, or a new supplier by its key', () => {
    expect(checkSetup(parsed(body()))).toBeNull();
    const withNew = body({
      suppliers: [{ id: SUPPLIER_ID, name: 'Valley', deliveries: [delivery] }, { key: 'new-1', name: 'Brewery', deliveries: [delivery] }],
      items: [item(), item({ name: 'IPA keg', supplierId: 'new-1', unit: 'kegs' })],
    });
    expect(checkSetup(parsed(withNew))).toBeNull();
  });

  it('refuses an unknown supplier, repeated ids or keys, two deliveries on one day and a repeated point-of-sale name', () => {
    const refused = [
      body({ items: [item({ supplierId: 'c'.repeat(24) })] }),
      body({ items: [item({ supplierId: 'new-1' })] }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'A', deliveries: [delivery] }, { id: SUPPLIER_ID, name: 'B', deliveries: [delivery] }] }),
      body({ suppliers: [{ key: SUPPLIER_ID, name: 'A', deliveries: [delivery] }, { id: SUPPLIER_ID, name: 'B', deliveries: [delivery] }] }),
      body({ suppliers: [{ id: SUPPLIER_ID, name: 'A', deliveries: [delivery, { ...delivery, cutoffTime: '09:00' }] }] }),
      body({ items: [item({ id: ITEM_ID }), item({ id: ITEM_ID, name: 'Other' })] }),
      body({ items: [item({ posNames: [{ name: 'Lager' }, { name: 'LAGER' }] })] }),
    ];
    for (const input of refused) expect(checkSetup(parsed(input))).toEqual(expect.any(String));
  });
});

describe('mintIds', () => {
  it('keeps sent ids, mints one for each new row, and points items at their new supplier’s minted id', () => {
    const setup = mintIds(parsed(body({
      suppliers: [{ id: SUPPLIER_ID, name: 'Valley', deliveries: [delivery] }, { key: 'new-1', name: 'Brewery', deliveries: [delivery] }],
      items: [item({ id: ITEM_ID }), item({ name: 'IPA keg', supplierId: 'new-1', unit: 'kegs' })],
    })));
    const [kept, minted] = setup.suppliers;
    expect(kept).toEqual({ id: SUPPLIER_ID, name: 'Valley', deliveries: [delivery] });
    expect(minted?.id).toMatch(HEX);
    expect(minted).not.toHaveProperty('key');
    expect(setup.items[0]).toMatchObject({ id: ITEM_ID, supplierId: SUPPLIER_ID });
    expect(setup.items[1]?.id).toMatch(HEX);
    expect(setup.items[1]?.id).not.toBe(ITEM_ID);
    expect(setup.items[1]?.supplierId).toBe(minted?.id);
    expect(setup.items[1]).toEqual({
      id: setup.items[1]?.id, name: 'IPA keg', supplierId: minted?.id, category: 'bottles_cans', unit: 'kegs', servingsPerUnit: 24, par: 4,
      dealSize: 5, neverRunOut: true, posNames: [{ name: 'Lager 12oz', perSale: 1 }],
    });
  });
});
