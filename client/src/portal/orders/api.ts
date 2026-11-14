import { z } from 'zod';

import type { ApiClient } from '../../api/client';

// The order routes (api/src/access/routes.ts, handlers/orders.ts and order-setup.ts): the board, one next order per
// supplier (api/src/orders/board.ts); the ordering setup with its item-sales coverage and latest counts; item sales,
// matched in the browser and sent by range; counts; and a line's saved edit and rules. Nothing here is sent to a
// distributor.

export const ORDER_UNITS = ['cases', 'kegs', 'bottles', 'units'] as const;
export const ORDER_CATEGORIES = ['bottles_cans', 'draft', 'liquor', 'cocktail_ingredient'] as const;

export const orderUnitSchema = z.enum(ORDER_UNITS);
export const orderCategorySchema = z.enum(ORDER_CATEGORIES);
export type OrderUnit = z.infer<typeof orderUnitSchema>;
export type OrderCategory = z.infer<typeof orderCategorySchema>;

const editSchema = z.object({ quantity: z.number(), reason: z.string() }).nullable();
const ruleSchema = z.object({ id: z.string(), delta: z.number(), situation: z.string() });
export type OrderRule = z.infer<typeof ruleSchema>;

export const orderLineSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  supplier: z.string(),
  unit: orderUnitSchema,
  neverRunOut: z.boolean(),
  recommended: z.number(),
  alternative: z.number().nullable(),
  par: z.number(),
  /** Window demand in purchase units; null without item sales for the window's weekdays. */
  mu: z.number().nullable(),
  /** Spread of past window errors; null under 2 past windows. */
  sigma: z.number().nullable(),
  /** The order-up-to level; null without mu. */
  orderUpTo: z.number().nullable(),
  /** The chance of not running out the quantity aims for. */
  target: z.number(),
  onHand: z.number().nullable(),
  countAgeDays: z.number().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  dealSize: z.number().nullable(),
  /** Covered item-sales days in the 8 weeks before today. */
  coveredDays: z.number(),
  why: z.string(),
  sample: z.boolean(),
  edit: editSchema,
  /** Every active rule for the item, each turned off on its own. */
  rules: z.array(ruleSchema),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const supplierOrderSchema = z.object({
  supplierId: z.string(),
  supplier: z.string(),
  /** The order-by date and its time (HH:MM, the town's zone). */
  cutoff: z.string(),
  cutoffTime: z.string(),
  delivery: z.string(),
  /** The supplier's following delivery, which this order lasts until. */
  coversThrough: z.string(),
  deadline: z.string(),
  lines: z.array(orderLineSchema),
});
export type SupplierOrder = z.infer<typeof supplierOrderSchema>;

/** The board, or what the ordering setup lacks ('the supplier schedule', 'the items'). */
export const orderBoardSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string(), missing: z.array(z.string()) }),
  z.object({
    available: z.literal(true),
    sample: z.boolean(),
    /** What the board lacks: 'item sales', 'a recent count'. */
    missing: z.array(z.string()),
    /** By cutoff. */
    orders: z.array(supplierOrderSchema),
  }),
]);
export type OrderBoard = z.infer<typeof orderBoardSchema>;
export type LiveBoard = Extract<OrderBoard, { available: true }>;

function locationPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/orders`;
}

/** The location's board, or the labeled sample when `sample` is set. */
export function fetchOrderBoard(api: ApiClient, locationId: string, sample = false): Promise<OrderBoard> {
  return api.json(sample ? `${locationPath(locationId)}?sample=true` : locationPath(locationId), orderBoardSchema);
}

// The ordering setup (design Decision 3, the order-setup spec).

const weekdaySchema = z.number().int().min(0).max(6);

export const deliverySchema = z.object({
  /** 0 = Sunday. */
  deliveryWeekday: weekdaySchema,
  /** The order-by day, 0 = Sunday. */
  cutoffWeekday: weekdaySchema,
  /** HH:MM, 24 hour, in the town's zone. */
  cutoffTime: z.string(),
});
export type Delivery = z.infer<typeof deliverySchema>;

export const supplierSchema = z.object({ id: z.string(), name: z.string(), deliveries: z.array(deliverySchema) });
export type Supplier = z.infer<typeof supplierSchema>;

export const posNameSchema = z.object({
  name: z.string(),
  /** Servings one sale of this point-of-sale item uses. */
  perSale: z.number(),
});
export type PosName = z.infer<typeof posNameSchema>;

export const setupItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  supplierId: z.string(),
  category: orderCategorySchema,
  unit: orderUnitSchema,
  servingsPerUnit: z.number(),
  par: z.number(),
  dealSize: z.number().nullable(),
  neverRunOut: z.boolean(),
  posNames: z.array(posNameSchema),
});
export type SetupItem = z.infer<typeof setupItemSchema>;

export const orderSetupSchema = z.object({
  suppliers: z.array(supplierSchema),
  items: z.array(setupItemSchema),
  /** What `saveOrderSetup` sends back as `expectedVersion`. */
  version: z.number(),
  updatedAt: z.string(),
});
export type OrderSetup = z.infer<typeof orderSetupSchema>;

export const itemSalesCoverageSchema = z.object({ firstDate: z.string(), lastDate: z.string(), dayCount: z.number() });
export type ItemSalesCoverage = z.infer<typeof itemSalesCoverageSchema>;

/**
 * GET .../orders/setup: the setup (null when none was saved), item-sales coverage (null with none stored), each item's
 * covered days with any servings in the last 8 weeks, and each item's latest count in the last 90 days.
 */
export const orderSetupAnswerSchema = z.object({
  setup: orderSetupSchema.nullable(),
  coverage: itemSalesCoverageSchema.nullable(),
  itemCoverage: z.record(z.string(), z.number()),
  counts: z.record(z.string(), z.object({ quantity: z.number(), date: z.string() })),
});
export type OrderSetupAnswer = z.infer<typeof orderSetupAnswerSchema>;

export function fetchOrderSetup(api: ApiClient, locationId: string): Promise<OrderSetupAnswer> {
  return api.json(`${locationPath(locationId)}/setup`, orderSetupAnswerSchema);
}

/** A supplier as PUT sends it: a stored one by its `id`, a new one with a `key` its items name it by. */
export interface SetupSupplierInput {
  readonly id?: string;
  readonly key?: string;
  readonly name: string;
  readonly deliveries: readonly Delivery[];
}

/** An item as PUT sends it: `id` absent for a new one, `supplierId` a supplier's `id` or a new supplier's `key`. */
export interface SetupItemInput {
  readonly id?: string;
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

export interface OrderSetupInput {
  readonly suppliers: readonly SetupSupplierInput[];
  readonly items: readonly SetupItemInput[];
}

/**
 * PUT .../orders/setup: the whole setup, saved only over `expectedVersion`, the version the editor loaded (0 when the
 * location had none). Resolves the stored setup with every row's id. Someone else's save in between rejects with
 * ApiError 409 `setup_changed`; a setup the server refuses (two items with one id, an item whose supplier is not in
 * it) with 400 `invalid_request`.
 */
export async function saveOrderSetup(api: ApiClient, locationId: string, expectedVersion: number, setup: OrderSetupInput): Promise<OrderSetup> {
  const body = await api.json(`${locationPath(locationId)}/setup`, z.object({ setup: orderSetupSchema }), {
    method: 'PUT', body: { expectedVersion, setup },
  });
  return body.setup;
}

export interface ItemSalesDay {
  readonly date: string;
  /** Servings per setup item id. */
  readonly items: Readonly<Record<string, number>>;
}

export interface ItemSalesChunk {
  /** The range, at most 31 days, ending by the town's today: sent days replace stored ones, unsent ones are deleted. */
  readonly from: string;
  readonly to: string;
  /** At most 31 days, each inside [from, to] and sent once, with at most 500 items. */
  readonly days: readonly ItemSalesDay[];
}

const appliedSchema = z.object({ stored: z.number(), removed: z.number() });

/** POST .../orders/item-sales. 400 `unknown_item` names an item no longer in the setup. */
export function uploadItemSales(api: ApiClient, locationId: string, chunk: ItemSalesChunk): Promise<z.infer<typeof appliedSchema>> {
  return api.json(`${locationPath(locationId)}/item-sales`, appliedSchema, { method: 'POST', body: chunk });
}

/** DELETE .../orders/item-sales, org admins only: every item-sales day of the location. The setup and counts stay. */
export function deleteItemSales(api: ApiClient, locationId: string): Promise<{ removed: number }> {
  return api.json(`${locationPath(locationId)}/item-sales`, z.object({ removed: z.number() }), { method: 'DELETE' });
}

export interface CountInput {
  /** From 14 days before the town's today through today. */
  readonly date: string;
  /** 1 to 300 items, each 0 to 9,999 purchase units in steps of 0.5. */
  readonly items: Readonly<Record<string, number>>;
}

/** POST .../orders/counts: each sent item's quantity on hand that day. Items counted before stay. */
export async function saveCount(api: ApiClient, locationId: string, count: CountInput): Promise<void> {
  await api.request(`${locationPath(locationId)}/counts`, { method: 'POST', body: count });
}

const decisionSchema = z.object({
  decision: z.object({ itemId: z.string(), delivery: z.string(), quantity: z.number(), reason: z.string(), recommended: z.number() }),
});
const savedRuleSchema = z.object({
  rule: z.object({ id: z.string(), itemId: z.string(), delta: z.number(), situation: z.string(), off: z.boolean() }),
});

/** Saves the owner's quantity for one line. The server keeps the recommended quantity. */
export function saveOrderDecision(
  api: ApiClient, locationId: string, body: { itemId: string; delivery: string; quantity: number; reason: string },
): Promise<unknown> {
  return api.json(`${locationPath(locationId)}/decisions`, decisionSchema, { method: 'POST', body });
}

/**
 * Remembers the latest saved edit as a rule: its change is added to every later order of the item until turned off.
 * The server computes the difference. 409 `rule_off` when that rule was turned off.
 */
export function saveOrderRule(api: ApiClient, locationId: string, body: { itemId: string; situation: string }): Promise<unknown> {
  return api.json(`${locationPath(locationId)}/rules`, savedRuleSchema, { method: 'POST', body });
}

/** Turns a rule off. The row stays, so the same reason is not proposed again. */
export async function turnOffOrderRule(api: ApiClient, locationId: string, ruleId: string): Promise<void> {
  await api.request(`${locationPath(locationId)}/rules/off`, { method: 'POST', body: { ruleId } });
}
