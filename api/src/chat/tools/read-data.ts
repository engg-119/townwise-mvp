// read_data_item: the text of one item kept for reference, through ctx.items (chat/* imports no file code). The item's
// text is the owner's data, never instructions. Never a sales file, a title or a file name. D36: a picture, PDF, Word
// (.docx) or Excel (.xlsx) file is read too, only when a message on the turn's path attached it (ToolContext.files),
// through ctx.items.readForModel as the caller, as its attachment was read: a document as its text, a picture as an
// image block after the result's text. Its bytes are held against the replica's cap first; a picture's stay held for
// the turn, whose pictures stay within a message's, and a document is read only while the turn has time for it. The content reaches the model only in the turn that read it: the saved
// conversation keeps a stub (`saved`), so a later turn reads again through ctx.items, which refuses an item turned off,
// deleted or purged since. A read that hands back text or a picture marks the turn as having read a file
// (ToolContext.turn), so start_calibration refuses for the rest of it (D36).
import { AppError } from '@ckeith26/server-core';
import { z } from 'zod';

import { parseRef } from '../../data/library.ts';
import { MESSAGE_PICTURE_BYTES } from '../attachments.ts';
import type { ItemContent, ItemForModel, ItemText } from '../../files/items.ts';
import type { ChatTool, ToolContext, ToolRun } from './registry.ts';
import { viewOf } from './shared.ts';

export interface ReadDataInput { ref: string }

/** Why nothing was read, by the status the read answered. */
const REASONS = {
  files_off: 'Townwise can’t read saved items yet.',
  not_readable: 'TownwiseAI can read text items added for reference, and a picture, PDF, Word (.docx) or Excel (.xlsx) file attached to a message in this conversation. It can’t read sales files, old Word or Excel files, ZIP files or other files.',
  turned_off: 'That item is turned off. The owner can turn it on in Your data.',
  gone: 'That item’s file was deleted.',
  not_found: 'No item with that ref at this location.',
  not_allowed: 'Only the person who added that file or an org admin can have TownwiseAI read it.',
  too_large: 'That file is too large for TownwiseAI to read.',
  too_many_pixels: 'That picture is too large in pixels for TownwiseAI to read.',
  encrypted: 'That file has a password, so TownwiseAI can’t read it.',
  damaged: 'That file couldn’t be opened. It may be damaged.',
  too_complex: 'That file is too complex to turn into text.',
  busy: 'TownwiseAI was busy reading another file. Try again in a moment.',
  files_busy: 'TownwiseAI is reading a lot of files right now. Try again in a moment.',
  too_much: 'Too much at once: this reply already has as many pictures as one message can carry. Ask about it in a new message.',
  no_time: 'There isn’t enough time left in this reply to read that file. Ask about it in a new message.',
  no_text: 'That PDF has no text, so it may be a scan. TownwiseAI reads only a PDF’s text.',
  empty: 'That file is empty.',
} as const;

type Reason = keyof typeof REASONS;

/** What a later turn reads in place of the text (docs/portal/tuning-chat.md section 3). */
const ELIDED = 'Read in an earlier turn; call read_data_item again for its current text.';
/** What a later turn reads in place of a picture. */
const PICTURE_ELIDED = 'Seen in an earlier turn; call read_data_item again to see it.';

const readText = z.object({ ref: z.string(), text: z.string(), truncated: z.boolean() });
const readPicture = z.object({ ref: z.string(), picture: z.literal(true) });
const readResult = z.union([
  readText,
  // A picture read, and its saved stub.
  readPicture,
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

function refused(reason: Reason): ToolRun {
  return { content: JSON.stringify({ available: false, reason: REASONS[reason] }) };
}

/** Why a check found nothing to send: one not on Your data here reads as no such item, a sales file as not readable. */
function checkReason(check: Exclude<ItemForModel, { readonly status: 'readable' }>): Reason {
  switch (check.status) {
    case 'not_reference': case 'not_ready': return 'not_readable';
    default: return check.status;
  }
}

/**
 * A file attached on the path, read as its attachment was read (D36), as the caller. A picture past the turn's
 * MESSAGE_PICTURE_BYTES, or one whose bytes the replica can't hold, is refused before anything is read. A picture's
 * bytes stay held for the rest of the turn, whose every later request carries it; a document's only while it is read.
 */
async function readAttached(tc: ToolContext, ref: string, fileId: string): Promise<ToolRun> {
  const check = await tc.ctx.items.readForModel(tc.scope, tc.location.id, fileId, { userId: tc.actor.actorUserId, role: tc.role });
  if (check.status !== 'readable') return refused(checkReason(check));
  const picture = check.kind === 'picture';
  if (picture && tc.turn.pictureBytes + check.bytes > MESSAGE_PICTURE_BYTES) return refused('too_much');
  if (!tc.files.bytes.reserve(check.bytes)) return refused('files_busy');
  let read: ItemContent;
  try {
    read = await check.read(tc.files.by);
  } finally {
    if (!picture) tc.files.bytes.release(check.bytes);
  }
  if (read.status === 'picture') {
    tc.turn.pictureBytes += check.bytes;
    tc.turn.readUntrusted = true;
    return { content: JSON.stringify({ ref, picture: true }), picture: { mediaType: read.mediaType, base64: read.base64 } };
  }
  // A picture that turned out not to be sendable holds nothing.
  if (picture) tc.files.bytes.release(check.bytes);
  if (read.status !== 'text') return refused(read.status === 'not_readable' ? 'damaged' : read.status);
  if (read.text.trim() === '') return refused(read.kind === 'pdf' ? 'no_text' : 'empty');
  tc.turn.readUntrusted = true;
  return { content: JSON.stringify({ ref, text: read.text, truncated: read.truncated }) };
}

export const readDataTool: ChatTool<ReadDataInput> = {
  definition: {
    name: 'read_data_item',
    description: 'One item the owner added for reference, by its ref from list_data_items or an attachments block. A text item: its text, at most the first 20,000 characters, with truncated true when there is more. A picture, PDF, Word (.docx) or Excel (.xlsx) file can be read only when a message in this conversation attached it: a PDF, Word or Excel file as its text, the same way, and a picture as the picture itself. Sales files, old Word and Excel files, ZIP files and turned-off items cannot be read.',
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
    if ('picture' in value) return { ref: value.ref, available: true, picture: true };
    if ('elided' in value) return { ref: value.ref, available: true, chars: value.chars, truncated: value.truncated };
    return { available: false, chars: 0, truncated: false };
  }),
  // A read that succeeded keeps its ref and length only (a picture, its ref only); a refusal holds no text and is kept
  // as it is.
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
    const picture = readPicture.safeParse(raw);
    if (picture.success) return JSON.stringify({ ref: picture.data.ref, picture: true, elided: true, reason: PICTURE_ELIDED });
    return content;
  },
  async run(tc, { ref }) {
    const parsed = parseRef(ref);
    // A sales upload is never read.
    const read: ItemText = parsed.type === 'upload'
      ? { status: 'not_readable' }
      : await tc.ctx.items.readText(tc.scope, tc.location.id, parsed.id);
    if (read.status === 'ok') {
      tc.turn.readUntrusted = true;
      return { content: JSON.stringify({ ref, text: read.text, truncated: read.truncated }) };
    }
    // Not a text item: a picture, PDF, Word or Excel file attached on this path (never a sales upload's `u_` ref) is read
    // as its attachment was.
    if (read.status === 'not_readable' && tc.files.attached.has(ref)) return readAttached(tc, ref, parsed.id);
    return refused(read.status);
  },
};
