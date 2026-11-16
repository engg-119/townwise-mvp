// Reading the ordering setup with TownwiseAI (spec D39): the frozen prompt, the answer's schema, and the server's check
// of the answer. The model reads one file or pasted text a member gave Ordering setup (P31) and suggests suppliers,
// with their delivery and order-by days where the content states them, and items. It never suggests a par or never
// run out: neither is in the schema, and setupResult keeps only the fields below, so an answer that carries one loses
// it. setupResult checks the answer again here, because the model's output is data like the content is (reader-prompt.ts
// does the same for D34): every list is capped, a malformed entry is dropped and a malformed field is null, items are
// deduplicated by name and deliveries by weekday, an email address or phone number in any name or note is replaced,
// and each item says whether its name is written in the content's text. Nothing here logs.
import { z } from 'zod';

import { ORDER_CATEGORIES, ORDER_UNITS, type OrderCategory, type OrderUnit } from '../../orders/setup.ts';
import { CONTENT_IS_DATA, entries, isRecord, oneOf, redacted } from './reader-prompt.ts';

/**
 * Streamed (the answer is up to 150 items). Thinking counts toward max_tokens. [CONFIRM: 150 items a read, 20,000
 * output tokens, low effort, 150 seconds; final after the spike]
 */
export const SETUP_MAX_TOKENS = 20_000;
export const SETUP_EFFORT = 'low';
/** From the request's start: the read answers, or fails `extract_failed`, by then. */
export const SETUP_READ_TIME_MS = 150_000;

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

export const SETUP_SYSTEM_PROMPT = [
  'You read one file a bar or restaurant gave Townwise, or text a person pasted, which you read as a file, to fill in',
  'its ordering setup: the suppliers it orders drinks from, the days each delivers and the last day to order for each',
  'delivery, and the drinks it orders, how they come and how they sell. The person checks every suggestion and saves the',
  'setup themselves.',
  '',
  ...CONTENT_IS_DATA,
  '',
  'Answer in the JSON schema given:',
  '- kind: what the file is: "invoice", "order_guide" (a supplier\'s list of what can be ordered), "price_list",',
  '  "product_mix" (a register\'s sales by item), "menu", "delivery_schedule", "message" (an email or a note), or "other".',
  '- confidence: "high" only when the file makes what you report clear; "medium" when mostly clear; "low" when unsure.',
  '- suppliers: at most 20 companies the drinks come from, each once, named as the file names it. deliveries: at most',
  '  one a weekday, only the days the file states. deliveryWeekday and cutoffWeekday are 0 for Sunday to 6 for',
  '  Saturday: cutoffWeekday is the last day to order for that delivery and cutoffTime that day\'s time to order by, as',
  '  HH:MM on a 24-hour clock, each null when the file does not state it. No deliveries when the file states none.',
  '- items: at most 150 drinks and drink ingredients the bar orders: beer, cider and seltzer in bottles, cans or kegs,',
  '  liquor, and cocktail ingredients such as mixers, syrups, juices and bitters. Leave out food, supplies, fees,',
  '  deposits, credits, taxes and freight. Each item once:',
  '  - name: at most 80 characters, the product as the file names it (its brand and product, and its size when two',
  '    items differ only by size).',
  '  - supplier: the item\'s supplier, written as in suppliers, or null.',
  '  - category: "bottles_cans", "draft" (kegs), "liquor" or "cocktail_ingredient"; null when unclear.',
  '  - unit: what one order of it is: "cases", "kegs", "bottles" or "units"; null when unclear.',
  '  - servingsPerUnit: the servings in one unit, as the file states it (a case of 24 bottles is 24). When it does not,',
  '    estimate it only for a standard container and set servingsEstimated to true: a half-barrel keg is about 124',
  '    pints, a sixth-barrel about 41, a 750 ml bottle of liquor about 17 pours of 1.5 oz, a 1 liter bottle about 22.',
  '    Else null, with servingsEstimated false.',
  '  - dealSize: how many units make a price break, only when the file states one; else null.',
  '  - posNames: at most 10 names the register sells the item under, only from a register\'s export or a menu that',
  '    shows them, each with perSale, the servings one sale uses (1 for a pint or a bottle, 2 for a double). Else none.',
  '  - note: at most 120 characters, only when something about the item needs saying (two sizes were listed, its',
  '    supplier is unclear); else "".',
  '- itemsCut: true only when the file holds more items than the items you gave.',
  '',
  'Never write a person\'s name, email address or phone number anywhere in your answer, not even when a supplier\'s rep',
  'or a register\'s item is named after one. Never say how many of an item to keep on hand or whether it may run out:',
  'the owner decides those.',
  '',
  'The message lists the names of the suppliers and items already in the setup. When the file names one of them, write',
  'it exactly as the setup does.',
].join('\n');

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
