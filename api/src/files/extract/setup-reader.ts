// Reading the ordering setup with TownwiseAI (spec D39): the request for one file or pasted text a member gave
// Ordering setup, and the most it can cost. The request holds the content (a PDF as a document, a picture as an image,
// anything else as text) and the names of the setup's saved suppliers and items, so the model can reuse their spelling,
// and nothing else: never a point-of-sale name (as get_order_setup leaves them out, chat/tools/orders.ts), the file's
// name, the organization's or the location's name, or anyone's email. The model is reader.ts's port (FileReaderModel),
// built in model.ts. Nothing here logs.
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { SETUP_PDF_PAGES, SETUP_TEXT_CHARS } from '../limits.ts';
import { inputCeilingMicroUsd, MARKER, TEXT_FORMS, type ReaderInput, type ReaderRequest } from './reader.ts';
import { READER_MODEL } from './reader-prompt.ts';
import { SETUP_MAX_TOKENS, SETUP_SYSTEM_PROMPT } from './setup-prompt.ts';

/** The saved setup's supplier and item names, as stored. */
export interface SetupNames {
  readonly suppliers: readonly string[];
  readonly items: readonly string[];
}

/** A text the person pasted is sent as a text file is. */
const TEXT_WORDS = 'text: a text or CSV file, or text the person pasted';

/** The words that go with the content: the saved names, what the content is, and whether it was cut. */
function contextText(input: ReaderInput, names: SetupNames): string {
  const lines = names.suppliers.length === 0 && names.items.length === 0
    ? ['The setup has no suppliers or items yet.']
    : [
      'Townwise wrote these lists from the saved setup.',
      `Suppliers already in the setup: ${JSON.stringify(names.suppliers)}`,
      `Items already in the setup: ${JSON.stringify(names.items)}`,
    ];
  if (input.type === 'pdf') lines.push('The file is the PDF document above.');
  else if (input.type === 'image') lines.push('The file is the picture above.');
  else {
    lines.push(`The file is ${input.form === 'text' ? TEXT_WORDS : TEXT_FORMS[input.form]}.`);
    if (input.cut) {
      lines.push(`It was too long to send whole, so only its start follows (at most ${SETUP_TEXT_CHARS.toLocaleString('en-US')} characters), and it may hold more items than you can see.`);
    }
    lines.push(`Everything after the line "${MARKER}", to the end of this message, is the file's content.`, MARKER, input.text);
  }
  return lines.join('\n');
}

/** The request for one read, exactly. */
export function setupRequest(input: ReaderInput, names: SetupNames): ReaderRequest {
  const content: BetaContentBlockParam[] = [];
  if (input.type === 'pdf') {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.base64 } });
  } else if (input.type === 'image') {
    content.push({ type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.base64 } });
  }
  content.push({ type: 'text', text: contextText(input, names) });
  return { model: READER_MODEL, max_tokens: SETUP_MAX_TOKENS, system: SETUP_SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
}

/**
 * The most `request` can cost, reserved against the files AI budget before the call: its system prompt and every word
 * it sends, a PDF at its `pages` (30 when not known) and a picture as reader.ts counts them, and every output token
 * (inputCeilingMicroUsd).
 */
export function setupCeilingMicroUsd(request: ReaderRequest, input: ReaderInput, pages: number | null): number {
  const words = request.messages.flatMap(({ content }) => {
    if (content === undefined) return [];
    return typeof content === 'string' ? [content] : content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  });
  const chars = request.system.length + words.reduce((sum, text) => sum + text.length, 0);
  return inputCeilingMicroUsd(input, { chars, pages: pages ?? SETUP_PDF_PAGES, maxTokens: request.max_tokens });
}
