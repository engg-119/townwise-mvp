// list_data_items: what the owner's team has added for the location (Your data, D28). Only a ref, kind, how it arrived,
// the date it was added in the town, its size, whether it is on, its state and its days: never a file name or a title.
import { z } from 'zod';

import { listDataItems, readableByTownwiseAi, refString } from '../../data/library.ts';
import { localDay } from '../../time-zones.ts';
import type { ChatTool } from './registry.ts';
import { INVALID_INPUT, NO_INPUT, parseNoInput, viewOf } from './shared.ts';

const LIST_LIMIT = 50;

const listResult = z.object({ items: z.array(z.object({ enabled: z.boolean() })), more: z.boolean() });

export const listDataTool: ChatTool<Record<string, never>> = {
  definition: {
    name: 'list_data_items',
    description: 'What the owner\'s team has added for this location, newest first, at most 50: each item\'s ref, kind, how it arrived (browser, file, staff or townwise_ai), the date it was added in the town, its size in bytes, whether it is turned on, its state, its days (count, how many are still in use, first and last date) for a sales upload, and whether read_data_item can read it. Turned-off items are left out of every figure the other tools give. Never a file name or title.',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: parseNoInput,
  inputView: () => null,
  resultView: (content) => viewOf(content, listResult, ({ items }) => ({
    count: items.length, turnedOff: items.filter((item) => !item.enabled).length,
  })),
  async run(tc) {
    const { ctx, scope, location, timeZone } = tc;
    // No viewer: an unfinished upload is its uploader's alone to see, so none is listed.
    const { items, next } = await listDataItems(ctx, scope, { locationId: location.id, viewerId: '', after: null, limit: LIST_LIMIT });
    return {
      content: JSON.stringify({
        items: items.map((item) => ({
          ref: refString(item.ref),
          kind: item.kind,
          via: item.via,
          addedOn: localDay(item.addedAt, timeZone),
          sizeBytes: item.file?.sizeBytes ?? null,
          enabled: item.enabled,
          state: item.state,
          days: item.days,
          readable: readableByTownwiseAi(item, ctx.items.on),
        })),
        more: next !== null,
      }),
    };
  },
};
