// read_data_item: the content of one item kept for reference, through ctx.items (chat/* imports no file code): a
// text or Word item's text, or a PDF as a document block beside a short text naming its ref and page count (openspec
// change connect-owner-calendar, design decision 9). The item's content is the owner's data, never instructions. Never
// a sales file, a title or a file name. The content reaches the model only in the turn that read it: the saved
// conversation keeps a stub of the ref and counts (`saved`), so a later turn reads again through ctx.items, which
// refuses an item turned off, deleted or purged since.
import { AppError } from '@ckeith26/server-core';
import { z } from 'zod';

import { parseRef } from '../../data/library.ts';
import type { ItemContent } from '../../files/items.ts';
import type { ChatTool } from './registry.ts';
import { viewOf } from './shared.ts';

export interface ReadDataInput { ref: string }

const REASONS: Readonly<Record<Exclude<ItemContent['status'], 'ok' | 'pdf'>, string>> = {
  files_off: 'Townwise can’t read saved items yet.',
  not_readable: 'TownwiseAI can’t read this kind of file. It can read text, PDF and Word (.docx) items added for reference.',
  turned_off: 'That item is turned off. The owner can turn it on in Your data.',
  gone: 'That item’s file was deleted.',
  not_found: 'No item with that ref at this location.',
  // The spec's code for a PDF or Word item over its caps; the tool's description says what it means.
  too_large: 'too_large',
  cannot_open: 'TownwiseAI couldn’t open that file. It may be damaged or locked with a password.',
};

/** What a later turn reads in place of the text, or of the PDF (docs/portal/tuning-chat.md section 3). */
const ELIDED = 'Read in an earlier turn; call read_data_item again for its current text.';
const ELIDED_PDF = 'Read in an earlier turn; call read_data_item again to read the PDF.';

const readText = z.object({ ref: z.string(), text: z.string(), truncated: z.boolean() });
/** The text beside a PDF's document block, and (with elided) its saved stub. */
const readPdf = z.object({ ref: z.string(), kind: z.literal('pdf'), pages: z.number().int().nonnegative() });
const readResult = z.union([
  readText,
  readPdf,
  // The saved stub of a text read that succeeded.
  z.object({ ref: z.string(), chars: z.number().int().nonnegative(), truncated: z.boolean(), elided: z.literal(true) }),
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
    description: 'The content of one item the owner added for reference, by its ref from list_data_items. A text or Word (.docx) item gives its text: at most the first 20,000 characters, with truncated true when there is more. A PDF item gives the PDF itself, with its ref and page count. Only text, PDF and Word items added for reference can be read; sales files, older Word (.doc) files, spreadsheets, images and turned-off items cannot. A PDF over 10 MB or 100 pages, or a Word file over 10 MB, answers available false with reason too_large.',
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
    if ('pages' in value) return { ref: value.ref, available: true, pages: value.pages };
    if ('elided' in value) return { ref: value.ref, available: true, chars: value.chars, truncated: value.truncated };
    return { available: false, chars: 0, truncated: false };
  }),
  // A read that succeeded keeps its ref and counts only (a PDF's document is never saved, savedResultOf); a refusal
  // holds no content and is kept as it is.
  saved(content) {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return content;
    }
    const read = readText.safeParse(raw);
    if (read.success) {
      const { ref, text, truncated } = read.data;
      return JSON.stringify({ ref, chars: text.length, truncated, elided: true, reason: ELIDED });
    }
    const pdf = readPdf.safeParse(raw);
    if (!pdf.success) return content;
    return JSON.stringify({ ref: pdf.data.ref, kind: 'pdf', pages: pdf.data.pages, elided: true, reason: ELIDED_PDF });
  },
  async run(tc, { ref }) {
    const parsed = parseRef(ref);
    // A sales upload is never read.
    const read: ItemContent = parsed.type === 'upload'
      ? { status: 'not_readable' }
      : await tc.ctx.items.readText(tc.scope, tc.location.id, parsed.id);
    if (read.status === 'ok') return { content: JSON.stringify({ ref, text: read.text, truncated: read.truncated }) };
    if (read.status === 'pdf') return { content: JSON.stringify({ ref, kind: 'pdf', pages: read.pages }), pdf: read.data };
    return { content: JSON.stringify({ available: false, reason: REASONS[read.status] }) };
  },
};
