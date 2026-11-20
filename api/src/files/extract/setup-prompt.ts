// Reading the ordering setup with TownwiseAI (spec D41): the frozen prompt and the read's limits. The model reads one
// file or pasted text a member gave Ordering setup (P31) and suggests suppliers, with their delivery and order-by days
// where the content states them, and items. The answer's schema, its caps and the server's check of the answer
// (setupResult) live in orders/suggestions.ts, which the chat's propose_order_setup shares (D56); they are re-exported
// here, so there is one of each. Nothing here logs.
import { CONTENT_IS_DATA } from './reader-prompt.ts';

export {
  ITEM_NAME_CHARS, ITEM_NOTE_CHARS, nameKey, POS_NAME_CHARS, SETUP_CONTENT_KINDS, SETUP_DELIVERIES_MAX, SETUP_ITEMS_MAX,
  SETUP_POS_NAMES_MAX, SETUP_SUPPLIERS_MAX, setupAnswer, setupResult, SUPPLIER_NAME_CHARS,
} from '../../orders/suggestions.ts';
export type {
  SetupContentKind, SetupReadResult, SuggestedDelivery, SuggestedItem, SuggestedPosName, SuggestedSupplier,
} from '../../orders/suggestions.ts';

/**
 * Streamed (the answer is up to 150 items). Thinking counts toward max_tokens.
 */
export const SETUP_MAX_TOKENS = 20_000;
export const SETUP_EFFORT = 'low';
/** From the request's start: the read answers, or fails `extract_failed`, by then. */
export const SETUP_READ_TIME_MS = 150_000;

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
