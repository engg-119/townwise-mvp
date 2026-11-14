// A location's ordering setup (design Decision 3, the order-setup spec): its suppliers with their delivery days and
// order-by times, and its items. Pure, shared by stores/order-setups.ts and the setup handler.
//
// How an item names its supplier: every row may come without an `id` (a new row), and the server mints one. A new
// supplier carries a `key` instead, any short string the client picks, and an item's `supplierId` names its supplier
// by that supplier's `id` or, for a new one, its `key`. `mintIds` then swaps each key for the minted id, so the stored
// setup holds ids only. `checkSetup` runs first and refuses an item whose supplier is not in the setup.
import { objectId } from '@ckeith26/mongo';
import { Types } from 'mongoose';
import { z } from 'zod';

export const ORDER_CATEGORIES = ['bottles_cans', 'draft', 'liquor', 'cocktail_ingredient'] as const;
export const ORDER_UNITS = ['cases', 'kegs', 'bottles', 'units'] as const;

export type OrderCategory = (typeof ORDER_CATEGORIES)[number];
export type OrderUnit = (typeof ORDER_UNITS)[number];

export interface Delivery {
  /** 0 = Sunday. */
  readonly deliveryWeekday: number;
  /** The order-by day, 0 = Sunday. */
  readonly cutoffWeekday: number;
  /** HH:MM, 24 hour, in the town's zone. */
  readonly cutoffTime: string;
}

export interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly deliveries: readonly Delivery[];
}

export interface PosName {
  readonly name: string;
  /** Servings one sale of this point-of-sale item uses. */
  readonly perSale: number;
}

export interface SetupItem {
  readonly id: string;
  readonly name: string;
  readonly supplierId: string;
  readonly category: OrderCategory;
  readonly unit: OrderUnit;
  readonly servingsPerUnit: number;
  readonly par: number;
  readonly dealSize: number | null;
  readonly neverRunOut: boolean;
  readonly posNames: readonly PosName[];
}

export interface OrderSetup {
  readonly suppliers: readonly Supplier[];
  readonly items: readonly SetupItem[];
}

const weekday = z.number().int().min(0).max(6);

const deliveryInput = z.strictObject({
  deliveryWeekday: weekday,
  cutoffWeekday: weekday,
  cutoffTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});

/** A stored row's id, lowercased: item ids become field names in item sales and counts, which take lowercase hex only. */
const rowId = objectId.transform((id) => id.toLowerCase());

const supplierInput = z.strictObject({
  id: rowId.optional(),
  /** A new supplier's name for itself in this request, for its items' `supplierId`. */
  key: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(60),
  deliveries: z.array(deliveryInput).min(1).max(7),
});

const itemInput = z.strictObject({
  id: rowId.optional(),
  name: z.string().trim().min(1).max(80),
  /** The supplier's `id`, or a new supplier's `key`. */
  supplierId: z.string().trim().min(1).max(40),
  category: z.enum(ORDER_CATEGORIES),
  unit: z.enum(ORDER_UNITS),
  servingsPerUnit: z.number().positive().max(2000),
  par: z.number().int().min(0).max(999),
  dealSize: z.number().int().min(1).max(999).nullable(),
  neverRunOut: z.boolean(),
  posNames: z.array(z.strictObject({
    name: z.string().trim().min(1).max(80),
    perSale: z.number().positive().max(50).default(1),
  })).max(10),
});

/** The setup as a request sends it, before `checkSetup` and `mintIds`. */
export const setupInput = z.strictObject({
  suppliers: z.array(supplierInput).max(20),
  items: z.array(itemInput).max(300),
});

export type SetupInput = z.infer<typeof setupInput>;

/**
 * Why the setup cannot be stored, or null when it can: two suppliers or two items with one id, two suppliers with one
 * key (or a key equal to another supplier's id), two deliveries on one weekday for one supplier, an item whose
 * supplier is not in the setup, or one point-of-sale name twice on an item (trimmed, case-folded).
 */
export function checkSetup(input: SetupInput): string | null {
  const suppliers = new Set<string>();
  for (const supplier of input.suppliers) {
    for (const ref of [supplier.id, supplier.key]) {
      if (ref === undefined) continue;
      if (suppliers.has(ref)) return 'Two suppliers have the same id';
      suppliers.add(ref);
    }
    const days = new Set(supplier.deliveries.map((delivery) => delivery.deliveryWeekday));
    if (days.size !== supplier.deliveries.length) return 'A supplier has two deliveries on the same day';
  }
  const items = new Set<string>();
  for (const item of input.items) {
    if (item.id !== undefined) {
      if (items.has(item.id)) return 'Two items have the same id';
      items.add(item.id);
    }
    if (!suppliers.has(item.supplierId)) return 'An item names a supplier that is not in the setup';
    const names = new Set(item.posNames.map((pos) => pos.name.toLowerCase()));
    if (names.size !== item.posNames.length) return 'An item lists the same point-of-sale name twice';
  }
  return null;
}

function newId(): string {
  return new Types.ObjectId().toHexString();
}

/** The setup as stored: every row without an id gets a new one, and each item's supplier key becomes that id. */
export function mintIds(input: SetupInput): OrderSetup {
  const idOf = new Map<string, string>();
  const suppliers = input.suppliers.map((supplier): Supplier => {
    const id = supplier.id ?? newId();
    idOf.set(id, id);
    if (supplier.key !== undefined) idOf.set(supplier.key, id);
    return { id, name: supplier.name, deliveries: supplier.deliveries.map((delivery) => ({ ...delivery })) };
  });
  const items = input.items.map((item): SetupItem => {
    const supplierId = idOf.get(item.supplierId);
    if (supplierId === undefined) throw new Error('mintIds needs a setup checkSetup accepted');
    return {
      id: item.id ?? newId(), name: item.name, supplierId, category: item.category, unit: item.unit,
      servingsPerUnit: item.servingsPerUnit, par: item.par, dealSize: item.dealSize, neverRunOut: item.neverRunOut,
      posNames: item.posNames.map((pos) => ({ name: pos.name, perSale: pos.perSale })),
    };
  });
  return { suppliers, items };
}
