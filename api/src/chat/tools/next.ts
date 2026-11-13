// suggest_next (docs/portal/tuning-chat.md section 4): exactly three short questions the owner might ask next, shown as
// buttons under the reply. The model calls it once, as a reply's last step and alone; a message that calls only it
// ends the turn without another model call once the turn has written text, and otherwise is answered with
// UNANSWERED_RESULT and the turn goes on (turn.ts). Its prompts are text, so its card has no views and they are
// never logged.
import { z } from 'zod';

import type { ChatTool } from './registry.ts';

export const SUGGESTIONS_RESULT = 'Shown to the owner as three buttons.';
/** suggest_next's result when the turn has written no text yet: the model often puts its answer in its thinking. */
export const UNANSWERED_RESULT = `${SUGGESTIONS_RESULT} The owner has not seen an answer yet: they see only text you write, never your thinking. Write your answer to the owner now, as text.`;

const MIN_PROMPT = 2;
const MAX_PROMPT = 80;

/** Trimmed, 2 to 80 characters (code points), on one line. */
const prompt = z.string().trim().refine((value) => {
  const { length } = Array.from(value);
  return length >= MIN_PROMPT && length <= MAX_PROMPT && !/[\r\n\u2028\u2029]/.test(value);
});

const suggestions = z.object({ prompts: z.tuple([prompt, prompt, prompt]) });

export interface Suggestions { prompts: [string, string, string] }

/** The three prompts of a suggest_next input, trimmed; null when it breaks a rule. */
export function nextOf(input: unknown): string[] | null {
  const parsed = suggestions.safeParse(input);
  return parsed.success ? [...parsed.data.prompts] : null;
}

export const suggestNextTool: ChatTool<Suggestions> = {
  definition: {
    name: 'suggest_next',
    description: 'Shows the owner exactly three short questions they might ask next, as buttons under your reply; pressing one sends it. Call it once at the end of every reply, as your last step and alone. Each question is 2 to 80 characters on one line, specific to this conversation and this location, and one your tools can answer.',
    input_schema: {
      type: 'object',
      properties: {
        prompts: { type: 'array', items: { type: 'string', minLength: MIN_PROMPT, maxLength: MAX_PROMPT }, minItems: 3, maxItems: 3 },
      },
      required: ['prompts'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: prompts is exactly three questions, each 2 to 80 characters on one line. Nothing was shown.',
  parse(raw) {
    const parsed = suggestions.safeParse(raw);
    return parsed.success ? { prompts: parsed.data.prompts } : null;
  },
  inputView: () => null,
  resultView: () => null,
  run: (_tc, input) => Promise.resolve({ content: SUGGESTIONS_RESULT, prompts: [...input.prompts] }),
};
