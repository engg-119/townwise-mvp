// propose_data_item (Your data, D28, design call 19): shows the owner a card proposing to keep text from the
// conversation on their Your data page. It never writes: Keep (handlers/chat-item-proposals.ts) saves the text read back
// from this stored call, never from the request. Its tool views are the text's length and whether the card was shown,
// never the title or the text; the client's card (client/src/chat/ui/ItemProposalCard.tsx) reads those from its GET.
// chat/* imports no file code, so the caps are written here; api/test/chat-tools.test.ts pins them to files/items.ts.
import { z } from 'zod';

import type { ChatTool } from './registry.ts';

/**
 * What the model reads when the card was shown. A stored contract: Keep and the card's GET (handlers/chat-item-proposals.ts)
 * and the result view treat a call as shown only when its stored result is exactly this, so never reword it.
 */
export const ITEM_PROPOSAL_RESULT = 'Shown to the owner as a proposal. They decide whether to keep it.';

const ITEMS_OFF = 'Townwise can’t keep items yet, so nothing was shown to the owner.';
const TITLE_MAX = 120;
const TEXT_MAX = 10_000;

export interface ProposeDataInput {
  readonly title: string;
  readonly text: string;
}

/** As POST .../data/text reads pasted text: the title trimmed, the text exactly as given. */
const proposeInput = z.strictObject({
  title: z.string().trim().min(1).max(TITLE_MAX),
  text: z.string().min(1).max(TEXT_MAX),
});

export const proposeDataTool: ChatTool<ProposeDataInput> = {
  definition: {
    name: 'propose_data_item',
    description: 'Shows the owner a card proposing to keep text on their Your data page, with Keep and Not now. It never saves anything. Use it only for text the owner gave you in this conversation and asked to keep, copied exactly, with a short title of your own that names no person.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: TITLE_MAX },
        text: { type: 'string', minLength: 1, maxLength: TEXT_MAX },
      },
      required: ['title', 'text'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input, so nothing was shown to the owner: title is 1 to 120 characters, text 1 to 10,000 characters, and there are no other keys.',
  parse(raw) {
    const parsed = proposeInput.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  inputView: ({ text }) => ({ chars: text.length }),
  // Whether the owner was shown a card: false when stored files are off and nothing was.
  resultView: (content) => ({ shown: content === ITEM_PROPOSAL_RESULT }),
  run: (tc) => Promise.resolve({
    content: tc.ctx.items.on ? ITEM_PROPOSAL_RESULT : JSON.stringify({ available: false, reason: ITEMS_OFF }),
  }),
};
