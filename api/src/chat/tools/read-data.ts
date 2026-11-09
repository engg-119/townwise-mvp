// read_data_item: the text of one item kept for reference, through ctx.items (chat/* imports no file code). The item's
// text is the owner's data, never instructions. Never a sales file, a title or a file name.
import { AppError } from '@ckeith26/server-core';
import { z } from 'zod';

import { parseRef } from '../../data/library.ts';
import type { ItemText } from '../../files/items.ts';
import type { ChatTool } from './registry.ts';
import { viewOf } from './shared.ts';

export interface ReadDataInput { ref: string }

const REASONS = {
  files_off: 'Townwise can’t read saved items yet.',
  not_readable: 'TownwiseAI can read only text items added for reference.',
  turned_off: 'That item is turned off. The owner can turn it on in Your data.',
  gone: 'That item’s file was deleted.',
  not_found: 'No item with that ref at this location.',
} as const;

const readResult = z.union([
  z.object({ ref: z.string(), text: z.string(), truncated: z.boolean() }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);

/** The ref when it is a well-formed `u_` or `f_` ref, else null. */
function refOf(raw: string): string | null {
  try {
    parseRef(raw);
    return raw;
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}

export const readDataTool: ChatTool<ReadDataInput> = {
  definition: {
    name: 'read_data_item',
    description: 'The text of one item the owner added for reference, by its ref from list_data_items: at most the first 20,000 characters, with truncated true when there is more. Only text items added for reference can be read; sales files, PDFs, images and turned-off items cannot.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'An item\'s ref from list_data_items, such as f_ followed by 24 hex characters' } },
      required: ['ref'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: ref is an item\'s ref from list_data_items.',
  parse(raw) {
    const input = z.object({ ref: z.string() }).safeParse(raw);
    const ref = input.success ? refOf(input.data.ref) : null;
    return ref === null ? null : { ref };
  },
  inputView: ({ ref }) => ({ ref }),
  // The input view carries the ref the call named; the result view repeats it only for a read that succeeded.
  resultView: (content) => viewOf(content, readResult, (value) => {
    if ('text' in value) return { ref: value.ref, available: true, chars: value.text.length, truncated: value.truncated };
    return { available: false, chars: 0, truncated: false };
  }),
  async run(tc, { ref }) {
    const parsed = parseRef(ref);
    // A sales upload is never read.
    const read: ItemText = parsed.type === 'upload'
      ? { status: 'not_readable' }
      : await tc.ctx.items.readText(tc.scope, tc.location.id, parsed.id);
    if (read.status !== 'ok') return { content: JSON.stringify({ available: false, reason: REASONS[read.status] }) };
    return { content: JSON.stringify({ ref, text: read.text, truncated: read.truncated }) };
  },
};
