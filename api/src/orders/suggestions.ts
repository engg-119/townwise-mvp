// Ordering setup suggestions a model wrote (spec D41, D56): the answer's schema, its caps, and the server's check of the
// answer. Two things use them: the setup read on Ordering setup (files/extract/setup-prompt.ts holds its prompt and
// re-exports these) and the chat's propose_order_setup tool (chat/tools/order-setup.ts). They sit here, importing
// nothing under files/, so chat code never reaches file code through this module (test/order-suggestions.test.ts).
// A suggestion never carries a par or never run out: neither is in the schema, and setupResult keeps only the fields
// below, so an answer that carries one loses it. setupResult checks the answer again, because the model's output is
// data like the content is: every list is capped, a malformed entry is dropped and a malformed field is null, items
// are deduplicated by name and deliveries by weekday, an email address or phone number in any name or note is
// replaced, and each item says whether its name is written in the content's text. Nothing here logs.
import { z } from 'zod';

import { entries, isRecord, oneOf, redacted } from '../model-answer.ts';
import { ORDER_CATEGORIES, ORDER_UNITS, type OrderCategory, type OrderUnit } from './setup.ts';

export const SETUP_SUPPLIERS_MAX = 20;
export const SETUP_DELIVERIES_MAX = 7;
export const SETUP_ITEMS_MAX = 150;
export const SETUP_POS_NAMES_MAX = 10;
/** The setup's own limits (orders/setup.ts setupInput). */
export const SUPPLIER_NAME_CHARS = 60;
export const ITEM_NAME_CHARS = 80;
export const POS_NAME_CHARS = 80;
export const ITEM_NOTE_CHARS = 120;

export const SETUP_CONTENT_KINDS = [
  'invoice', 'order_guide', 'price_list', 'product_mix', 'menu', 'delivery_schedule', 'message', 'other',
] as const;
export type SetupContentKind = (typeof SETUP_CONTENT_KINDS)[number];

/** The answer's schema as sent (structured output). Limits the API does not enforce travel as descriptions. */
export const setupAnswer = z.object({
  kind: z.enum(SETUP_CONTENT_KINDS),
  confidence: z.enum(['high', 'medium', 'low']),
  suppliers: z.array(z.object({
    name: z.string().max(SUPPLIER_NAME_CHARS),
    deliveries: z.array(z.object({
      deliveryWeekday: z.number().int().min(0).max(6),
      cutoffWeekday: z.number().int().min(0).max(6).nullable(),
      cutoffTime: z.string().nullable(),
    })).max(SETUP_DELIVERIES_MAX),
  })).max(SETUP_SUPPLIERS_MAX),
  items: z.array(z.object({
    name: z.string().max(ITEM_NAME_CHARS),
    supplier: z.string().nullable(),
    category: z.enum(ORDER_CATEGORIES).nullable(),
    unit: z.enum(ORDER_UNITS).nullable(),
    servingsPerUnit: z.number().nullable(),
    servingsEstimated: z.boolean(),
    dealSize: z.number().int().nullable(),
    posNames: z.array(z.object({ name: z.string().max(POS_NAME_CHARS), perSale: z.number() })).max(SETUP_POS_NAMES_MAX),
    note: z.string().max(ITEM_NOTE_CHARS),
  })).max(SETUP_ITEMS_MAX),
  itemsCut: z.boolean(),
});

export interface SuggestedDelivery {
  /** 0 = Sunday. */
  readonly deliveryWeekday: number;
  readonly cutoffWeekday: number | null;
  /** HH:MM, 24 hour. */
  readonly cutoffTime: string | null;
}

export interface SuggestedSupplier {
  readonly name: string;
  readonly deliveries: readonly SuggestedDelivery[];
}

export interface SuggestedPosName {
  readonly name: string;
  readonly perSale: number;
}

/** Never a par or never run out. */
export interface SuggestedItem {
  readonly name: string;
  readonly supplier: string | null;
  readonly category: OrderCategory | null;
  readonly unit: OrderUnit | null;
  readonly servingsPerUnit: number | null;
  /** TownwiseAI estimated `servingsPerUnit` (a standard container); false when it is null. */
  readonly servingsEstimated: boolean;
  readonly dealSize: number | null;
  readonly posNames: readonly SuggestedPosName[];
  readonly note: string;
  /** Whether the item's name is written in the content's text; null for a picture or a PDF with no text. */
  readonly inFile: boolean | null;
}

export interface SetupReadResult {
  readonly kind: SetupContentKind;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly suppliers: readonly SuggestedSupplier[];
  readonly items: readonly SuggestedItem[];
  /** The content held more items than the answer gives. */
  readonly itemsCut: boolean;
}

/** A name as the setup page matches it (client/src/portal/orders/setupDraft.ts normalizeName). */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A name of 1 to `max` characters once trimmed, its email addresses and phone numbers replaced. */
const name = (max: number) => z.string().trim().min(1).max(max).transform((text) => redacted(text, max));

const deliveryEntry = z.object({
  deliveryWeekday: z.number().int().min(0).max(6),
  cutoffWeekday: z.number().int().min(0).max(6).nullable().catch(null),
  cutoffTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().catch(null),
});

const supplierEntry = z.object({ name: name(SUPPLIER_NAME_CHARS), deliveries: z.unknown().optional() });

const posEntry = z.object({ name: name(POS_NAME_CHARS), perSale: z.number().positive().max(50).catch(1) });

/**
 * An item as kept: `z.object` drops every key it does not list, so a `par` or `neverRunOut` in the answer never
 * reaches the suggestion (test/setup-read.test.ts pins it). A field that does not pass is null.
 */
const itemEntry = z.object({
  name: name(ITEM_NAME_CHARS),
  supplier: name(SUPPLIER_NAME_CHARS).nullable().catch(null),
  category: z.enum(ORDER_CATEGORIES).nullable().catch(null),
  unit: z.enum(ORDER_UNITS).nullable().catch(null),
  servingsPerUnit: z.number().min(0.1).max(2000).nullable().catch(null),
  // A figure the model did not say it read is counted as its estimate.
  servingsEstimated: z.boolean().catch(true),
  dealSize: z.number().int().min(1).max(999).nullable().catch(null),
  posNames: z.unknown().optional(),
  // No length limit here: a long note keeps its start, and `redacted` reads only a bounded part of it.
  note: z.string().catch('').transform((text) => redacted(text.trim(), ITEM_NOTE_CHARS)),
});

/** The first of each key, in order. */
function uniqueBy<T>(list: readonly T[], key: (entry: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return list.filter((entry) => {
    const at = key(entry);
    if (seen.has(at)) return false;
    seen.add(at);
    return true;
  });
}

/**
 * The model's answer as Townwise answers it, or null when it is not an object at all. `sourceText` is the content's
 * text (a PDF's own text, the text sent) to say each item's `inFile` by, or null (a picture). An unknown kind reads as
 * `other` and an unknown confidence as `low`; a supplier or item without a usable name is dropped, as is a delivery
 * without a weekday, and any other field that does not pass is null (a note empty, a sale's servings 1). Suppliers and
 * items keep the first of each name (as the setup page matches names) and deliveries the first of each weekday, within
 * their caps; `itemsCut` when the answer had more items or said the content did. An item's supplier is one of the
 * suggested suppliers as kept (within their cap), in that supplier's spelling, or null: so items never bring more
 * suppliers than the cap. A servings figure that is null is never an estimate.
 */
export function setupResult(raw: unknown, sourceText: string | null): SetupReadResult | null {
  if (!isRecord(raw)) return null;
  const kind: SetupContentKind = oneOf(raw.kind, SETUP_CONTENT_KINDS, 'other');
  const confidence = oneOf(raw.confidence, ['high', 'medium', 'low'] as const, 'low');
  const suppliers: SuggestedSupplier[] = uniqueBy(entries(raw.suppliers, supplierEntry, Number.MAX_SAFE_INTEGER), (supplier) => nameKey(supplier.name))
    .slice(0, SETUP_SUPPLIERS_MAX)
    .map((supplier) => ({
      name: supplier.name,
      deliveries: uniqueBy(entries(supplier.deliveries, deliveryEntry, Number.MAX_SAFE_INTEGER), (delivery) => delivery.deliveryWeekday)
        .slice(0, SETUP_DELIVERIES_MAX),
    }));
  const spelling = new Map(suppliers.map((supplier) => [nameKey(supplier.name), supplier.name]));
  const text = sourceText === null || sourceText.trim() === '' ? null : nameKey(sourceText);
  const unique = uniqueBy(entries(raw.items, itemEntry, Number.MAX_SAFE_INTEGER), (item) => nameKey(item.name));
  const items: SuggestedItem[] = unique.slice(0, SETUP_ITEMS_MAX).map((item) => ({
    ...item,
    supplier: item.supplier === null ? null : spelling.get(nameKey(item.supplier)) ?? null,
    servingsEstimated: item.servingsPerUnit !== null && item.servingsEstimated,
    posNames: uniqueBy(entries(item.posNames, posEntry, Number.MAX_SAFE_INTEGER), (pos) => nameKey(pos.name)).slice(0, SETUP_POS_NAMES_MAX),
    inFile: text === null ? null : text.includes(nameKey(item.name)),
  }));
  return { kind, confidence, suppliers, items, itemsCut: raw.itemsCut === true || unique.length > SETUP_ITEMS_MAX };
}
