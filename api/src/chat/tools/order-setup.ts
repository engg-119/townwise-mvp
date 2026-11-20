// propose_order_setup (spec D56): the chat model turns a file attached to the conversation (D36) into ordering setup
// suggestions, shown to the owner as a card. The model writes the suggestions as this tool's input; the tool reads no
// file, reserves no bytes and saves nothing. `parse` is the one check of that input, used by `run` and by the card's
// GET (handlers/chat-order-proposals.ts), so the tool's counts and the card cannot disagree: an attached file's ref,
// then the setup read's own check (orders/suggestions.ts setupResult: caps, malformed entries dropped, an email
// address or phone number replaced, never a par or never run out), at most 60 items, and every point-of-sale name
// emptied, since get_order_setup keeps those out of chat too. Unknown keys are dropped, as the setup read drops them:
// a rejected call is stored like an accepted one, so refusing an extra key would keep nothing out of the conversation.
// `run` shows a card only for a file attached on the path whose content this turn's requests carry (`sent`), and says
// which item names are not written in that text. Views carry the ref and counts, never a name. Nothing here logs.
import { z } from 'zod';

import { nameKey, setupResult, SETUP_CONTENT_KINDS, type SetupReadResult } from '../../orders/suggestions.ts';
import { ORDER_CATEGORIES, ORDER_UNITS } from '../../orders/setup.ts';
import { ATTACHMENT_REF } from '../attachments.ts';
import type { ChatTool, ToolRun } from './registry.ts';
import { viewOf } from './shared.ts';

/**
 * The most items one card carries. A chat call has 16,000 output tokens, thinking included, and a call cut at
 * max_tokens never runs its tool, so this is well under the setup read's 150. Unmeasured: the timing spike planned for
 * it was skipped.
 */
export const ORDER_SETUP_ITEMS_MAX = 60;

/** The suggestions as checked: `posNames` always empty, and `inFile` null (the card's GET lays it over). */
export interface OrderSetupInput extends SetupReadResult {
  /** The attached file the suggestions come from. */
  readonly ref: string;
}

const NOT_ATTACHED = 'Nothing was shown to the owner. ref is not a file attached to this conversation, and suggestions come only from one. The owner attaches a file to a message on the web.';
const NOT_SENT = 'Nothing was shown to the owner. This reply has not read that file’s content. Call read_data_item with the ref first, then call this again. If the file cannot be read, say so and point the owner to Read a file with TownwiseAI on Ordering setup, on the web.';
const NOTHING_FOUND = 'Nothing was shown to the owner. The input has no supplier and no item to suggest.';

const WEEKDAY = { type: 'integer', minimum: 0, maximum: 6 } as const;

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: 'The attached file’s ref from the attachments block: f_ followed by 24 hex characters.' },
    kind: { type: 'string', enum: [...SETUP_CONTENT_KINDS], description: 'What the file is. order_guide is a supplier’s list of what can be ordered; product_mix is a register’s sales by item; message is an email or a note.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high only when the file makes what you report clear.' },
    suppliers: {
      type: 'array',
      maxItems: 20,
      description: 'The companies the drinks come from, each once, named as the file names it, or as the setup spells it when it is already there.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'At most 60 characters.' },
          deliveries: {
            type: 'array',
            maxItems: 7,
            description: 'At most one a weekday, only the days the file states; none when it states none.',
            items: {
              type: 'object',
              properties: {
                deliveryWeekday: { ...WEEKDAY, description: '0 for Sunday to 6 for Saturday.' },
                cutoffWeekday: { anyOf: [WEEKDAY, { type: 'null' }], description: 'The last day to order for that delivery, or null when the file does not state it.' },
                cutoffTime: { type: ['string', 'null'], description: 'That day’s time to order by, HH:MM on a 24-hour clock, or null.' },
              },
              required: ['deliveryWeekday', 'cutoffWeekday', 'cutoffTime'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'deliveries'],
        additionalProperties: false,
      },
    },
    items: {
      type: 'array',
      maxItems: ORDER_SETUP_ITEMS_MAX,
      description: 'At most 60 drinks and drink ingredients the bar orders, each once: beer, cider and seltzer in bottles, cans or kegs, liquor, and cocktail ingredients. Leave out food, supplies, fees, deposits, credits, taxes and freight.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'At most 80 characters: the product as the file names it, or exactly as the setup spells it when it is already there.' },
          supplier: { type: ['string', 'null'], description: 'The item’s supplier, written as in suppliers, or null.' },
          category: { anyOf: [{ type: 'string', enum: [...ORDER_CATEGORIES] }, { type: 'null' }], description: 'draft is kegs; null when unclear.' },
          unit: { anyOf: [{ type: 'string', enum: [...ORDER_UNITS] }, { type: 'null' }], description: 'What one order of it is; null when unclear.' },
          servingsPerUnit: { type: ['number', 'null'], description: 'The servings in one unit as the file states it (a case of 24 bottles is 24). When it does not, estimate only for a standard container and set servingsEstimated true: a half-barrel keg is about 124 pints, a sixth-barrel about 41, a 750 ml bottle of liquor about 17 pours of 1.5 oz, a 1 liter bottle about 22. Else null.' },
          servingsEstimated: { type: 'boolean', description: 'true only when servingsPerUnit is your estimate.' },
          dealSize: { type: ['integer', 'null'], description: 'How many units make a price break, only when the file states one; else null.' },
          note: { type: 'string', description: 'At most 120 characters, only when something about the item needs saying; else "".' },
        },
        required: ['name', 'supplier', 'category', 'unit', 'servingsPerUnit', 'servingsEstimated', 'dealSize', 'note'],
        additionalProperties: false,
      },
    },
    itemsCut: { type: 'boolean', description: 'true only when the file holds more items than the items you gave.' },
  },
  required: ['ref', 'kind', 'confidence', 'suppliers', 'items', 'itemsCut'],
  additionalProperties: false,
} as const;

const refInput = z.object({ ref: z.string().regex(ATTACHMENT_REF) });

/**
 * The model's input as the card takes it, or null: an attached file's ref, then setupResult's check, the first 60 items
 * (`itemsCut` when there were more) and no point-of-sale names. The one check, for `run` and for the card's GET.
 */
function parse(raw: unknown): OrderSetupInput | null {
  const ref = refInput.safeParse(raw);
  const result = ref.success ? setupResult(raw, null) : null;
  if (!ref.success || result === null) return null;
  return {
    ref: ref.data.ref,
    kind: result.kind,
    confidence: result.confidence,
    suppliers: result.suppliers,
    // Point-of-sale names stay out of chat: they are how the bar's register names things, and may name a person.
    items: result.items.slice(0, ORDER_SETUP_ITEMS_MAX).map((item) => ({ ...item, posNames: [] })),
    itemsCut: result.itemsCut || result.items.length > ORDER_SETUP_ITEMS_MAX,
  };
}

const notShownResult = z.object({ shown: z.literal(false) });
const shownResult = z.object({
  shown: z.literal(true),
  supplierCount: z.number(),
  itemCount: z.number(),
  /** False for a picture: its names can't be looked for. */
  namesChecked: z.boolean(),
  /** The items whose name is not written in the text sent, each as nameKey gives it. */
  notInFile: z.array(z.string()),
  /** The text sent was cut, so the file holds more than was read. */
  partial: z.boolean(),
  itemsCut: z.boolean(),
  /** The turn's requests carried web pages when the card was shown. */
  readWeb: z.boolean(),
});

function notShown(reason: string): ToolRun {
  return { content: JSON.stringify({ shown: false, reason }) };
}

export interface ShownOrderSetup {
  readonly ref: string;
  /** The suggestions as the setup read answers them (the client's setupReadSchema): never a par, never a point-of-sale name. */
  readonly read: SetupReadResult & { readonly partial: boolean };
  readonly readWeb: boolean;
}

/**
 * A stored call as its card shows it, or null when it showed nothing: the input through `parse`, each item's `inFile`
 * from the result the model read (null when names were not checked), and that result's `partial` and `readWeb`.
 */
export function shownOrderSetup(input: unknown, content: unknown): ShownOrderSetup | null {
  const proposal = parse(input);
  if (proposal === null || typeof content !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  const result = shownResult.safeParse(raw);
  if (!result.success) return null;
  const { ref, ...read } = proposal;
  const missing = new Set(result.data.notInFile);
  return {
    ref,
    readWeb: result.data.readWeb,
    read: {
      ...read,
      items: read.items.map((item) => ({ ...item, inFile: result.data.namesChecked ? !missing.has(nameKey(item.name)) : null })),
      partial: result.data.partial,
    },
  };
}

export const proposeOrderSetupTool: ChatTool<OrderSetupInput> = {
  definition: {
    name: 'propose_order_setup',
    description: 'Shows the owner a card of ordering setup suggestions you found in one file attached to this conversation: its suppliers, with the delivery and order-by days the file states, and the drinks it lists. The card shows what would be added and what would change, and opens Ordering setup with the suggestions in the unsaved draft, where the owner sets each par and saves. It saves nothing, so never say anything was saved. The file’s content must be in this reply: call read_data_item with the ref first when it is not. Call get_order_setup first, and write a supplier or item already in the setup exactly as the setup spells it. Never write a person’s name, an email address, a phone number, a register (point-of-sale) name, a par or whether an item may run out. It shows nothing for a file that is not attached to this conversation, a file this reply has not read, or no supplier and no item.',
    input_schema: INPUT_SCHEMA,
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was shown to the owner: the input is an object whose ref is the attached file’s ref, f_ followed by 24 hex characters.',
  parse: (raw) => parse(raw),
  inputView: (input) => ({ ref: input.ref, supplierCount: input.suppliers.length, itemCount: input.items.length }),
  resultView: (content) => viewOf(content, z.union([shownResult, notShownResult]), (result) => (result.shown
    ? {
      shown: true, supplierCount: result.supplierCount, itemCount: result.itemCount, notInFileCount: result.notInFile.length,
      partial: result.partial,
    }
    : { shown: false })),
  run(tc, input) {
    if (!tc.files.attached.has(input.ref)) return Promise.resolve(notShown(NOT_ATTACHED));
    // No entry covers every way a file is not read (off, deleted, a scan, too large, busy, not allowed): none has one.
    const sent = tc.files.sent.get(input.ref);
    if (sent === undefined) return Promise.resolve(notShown(NOT_SENT));
    if (input.suppliers.length === 0 && input.items.length === 0) return Promise.resolve(notShown(NOTHING_FOUND));
    // The same check again, now with the text: it is idempotent, and it is what says each name's inFile.
    const text = 'text' in sent && sent.text.trim() !== '' ? sent.text : null;
    const checked = text === null ? null : setupResult(input, text);
    return Promise.resolve({
      content: JSON.stringify({
        shown: true,
        supplierCount: input.suppliers.length,
        itemCount: input.items.length,
        namesChecked: checked !== null,
        notInFile: (checked?.items ?? []).filter((item) => item.inFile === false).map((item) => nameKey(item.name)),
        partial: 'text' in sent && sent.truncated,
        itemsCut: input.itemsCut,
        readWeb: tc.turn.readWeb,
      } satisfies z.infer<typeof shownResult>),
    });
  },
};
