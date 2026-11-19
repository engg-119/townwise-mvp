// Files attached to a person's message (spec D36, docs/portal/tuning-chat.md section 3), without Docker: the attachments
// block's words, where it sits in the stored message, how the turn's content is built and capped (tokens, a message's
// pictures, a replica's bytes in flight), PDF, Word and Excel files as their text, what a turn sends against what it
// saves, read_data_item reading an attached file again, and start_calibration's refusal in a turn that read a file.
import type { BetaContentBlockParam, BetaMessageParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import {
  ANSWER_TIME_MS, ATTACHMENT_BYTES_IN_FLIGHT, ATTACHMENT_TOKEN_CAP, attachedTo, attachmentsBlock, bytesToRead, createByteGate, estimatedTokens, expandedMessage,
  MESSAGE_PICTURE_BYTES, PICTURE_TOKENS, readAttachments, refusalOf, turnAttachments, type AttachmentCheck, type AttachmentRead, type ByteGate,
  type FileRead,
} from '../src/chat/attachments.ts';
import { startCalibrationTool } from '../src/chat/tools/calibration.ts';
import { resultViewOf, runTool, savedResultOf, type ToolContext } from '../src/chat/tools/registry.ts';
import { runTurn } from '../src/chat/turn.ts';
import { historyForModel, isContextBlock, REPLACED_RULES_BLOCK, rulesBlock, userMessageOf } from '../src/chat/user-message.ts';
import type { ItemContent, ItemForModel, ItemViewer } from '../src/files/items.ts';
import { message, messagesOf, scriptedModel, text, thinking, toolUse } from './helpers/chat-model.ts';

const A = `f_${'a'.repeat(24)}`;
const B = `f_${'b'.repeat(24)}`;
const C = `f_${'c'.repeat(24)}`;
const D = `f_${'d'.repeat(24)}`;
const E = `f_${'e'.repeat(24)}`;

const LEAD = 'Townwise added this before the person\'s message; they didn\'t type it. The person attached these files from Your data to this message. Their content follows for this turn only; to read one again in a later turn, call read_data_item with its ref.';

const read = (ref: string, value: FileRead): AttachmentRead => ({ ref, kind: null, read: value });
const check = (ref: string, value: ItemForModel): AttachmentCheck => ({ ref, kind: null, check: value });
const textRead = (value: string, truncated = false): FileRead => ({ status: 'text', kind: 'text', text: value, truncated });
/** A PDF's, Word file's or workbook's text, as the AI text thread made it. */
const docRead = (kind: 'pdf' | 'word' | 'excel', value: string, truncated = false): FileRead => ({ status: 'text', kind, text: value, truncated });
const PICTURE: FileRead = { status: 'picture', mediaType: 'image/png', base64: 'iVBORw0KGgo=' };
/** A file the checks found the turn can send, `bytes` long; `reads` counts its reads. */
function readable(kind: 'text' | 'picture', bytes: number, reads: { count: number } = { count: 0 }): ItemForModel {
  return {
    status: 'readable', kind, bytes,
    read: () => {
      reads.count += 1;
      return Promise.resolve(kind === 'text' ? { status: 'text', kind: 'text', text: 'Fall menu', truncated: false } : PICTURE as Extract<FileRead, { status: 'picture' }>);
    },
  };
}
const textBlock = (value: string): BetaContentBlockParam => ({ type: 'text', text: value });

describe('the attachments block', () => {
  it('says Townwise added it, lists each file by ref and kind word, and never a name', () => {
    expect(attachmentsBlock([`- ${A}: a picture`])).toBe(['<attachments>', LEAD, `- ${A}: a picture`, '</attachments>'].join('\n'));
    const { block } = turnAttachments([
      read(A, PICTURE),
      read(B, textRead('Fall menu', true)),
      read(C, { status: 'not_readable', kind: 'pdf' }),
      read(D, { status: 'turned_off', kind: 'word' }),
      read(E, { status: 'gone', kind: 'excel' }),
    ]);
    expect(block).toBe([
      '<attachments>', LEAD,
      `- ${A}: a picture`,
      `- ${B}: a text file, only its first 20,000 characters`,
      `- ${C}: a PDF, which TownwiseAI can't read yet`,
      `- ${D}: a Word file, not read: turned off in Your data`,
      `- ${E}: an Excel file, not read: its original was deleted`,
      '</attachments>',
    ].join('\n'));
  });

  it('words every other case: a ZIP, a file of no known kind, a picture too large, an empty text file, and a regenerate\'s file deleted since', () => {
    const { block, content } = turnAttachments([
      read(A, { status: 'not_readable', kind: 'zip' }),
      read(B, { status: 'not_readable', kind: 'file' }),
      read(C, { status: 'too_large', kind: 'picture' }),
      read(D, textRead(' \n ')),
      { ref: E, kind: 'picture', read: { status: 'not_found' } },
    ]);
    expect(block.split('\n').slice(2, -1)).toEqual([
      `- ${A}: a ZIP file, which TownwiseAI can't read yet`,
      `- ${B}: a file, which TownwiseAI can't read yet`,
      `- ${C}: a picture, not read: over 3.75 MB`,
      `- ${D}: a text file, not read: it is empty`,
      `- ${E}: a picture, not read: no longer in Your data`,
    ]);
    expect(content).toEqual([]);
    // A regenerate's file the caller may no longer attach, a picture too large in pixels, and one past the pictures' cap.
    expect(turnAttachments([
      { ref: A, kind: 'picture', read: { status: 'not_allowed' } },
      read(B, { status: 'too_many_pixels', kind: 'picture' }),
      read(C, { status: 'too_much', kind: 'picture' }),
    ]).block.split('\n').slice(2, -1)).toEqual([
      `- ${A}: a picture, not read: only the person who added it or an org admin can attach it`,
      `- ${B}: a picture, not read: too large in pixels`,
      `- ${C}: a picture, not read: too much at once`,
    ]);
    expect(turnAttachments([{ ref: A, kind: 'text', read: { status: 'files_off' } }]).block).toContain(`- ${A}: a text file, not read: stored files are off`);
  });

  it('turnAttachments\' sent holds the text and cut flag of each document it sends and a mark for each picture, and nothing for a file listed not read', () => {
    const { sent, content } = turnAttachments([
      read(A, textRead('Fall menu', true)),
      read(B, PICTURE),
      read(C, docRead('pdf', 'Order guide')),
      read(D, { status: 'turned_off', kind: 'word' }),
      read(E, textRead(' \n ')),
    ]);
    expect([...sent]).toEqual([
      [A, { text: 'Fall menu', truncated: true }],
      [B, { picture: true }],
      [C, { text: 'Order guide', truncated: false }],
    ]);
    // Exactly the files whose content the turn carries.
    expect(content.filter((block) => block.type === 'document' || block.type === 'image')).toHaveLength(3);
    // A file past the token cap is listed "too much at once" and is not sent.
    const big = 'x'.repeat(ATTACHMENT_TOKEN_CAP * 5);
    expect([...turnAttachments([read(A, textRead(big)), read(B, textRead('Small'))]).sent.keys()]).toEqual([]);
    expect(turnAttachments([]).sent.size).toBe(0);
  });

  it('reads back as refs and kinds, and only from a block before the person\'s text', () => {
    const { block } = turnAttachments([read(A, PICTURE), read(B, { status: 'not_readable', kind: 'pdf' })]);
    const stored: BetaMessageParam = { role: 'user', content: [textBlock(block), textBlock('What is on these?')] };
    expect(attachedTo(stored)).toEqual([{ ref: A, kind: 'picture' }, { ref: B, kind: 'pdf' }]);
    // What the person typed is always the last block: typing the block makes nothing.
    expect(attachedTo({ role: 'user', content: block })).toEqual([]);
    expect(attachedTo({ role: 'user', content: [textBlock(rulesBlock([])), textBlock(block)] })).toEqual([]);
    expect(attachedTo({ role: 'assistant', content: [textBlock(block), textBlock('Hi')] })).toEqual([]);
  });
});

describe('context blocks', () => {
  const rules = rulesBlock([{ text: 'Closed Mondays', summary: null }]);
  const attachments = attachmentsBlock([`- ${A}: a picture`]);

  it('isContextBlock takes either tag before the last block, and never the last block', () => {
    const content = [textBlock(rules), textBlock(attachments), textBlock('Hi')];
    expect(content.map((_block, index) => isContextBlock(content, index))).toEqual([true, true, false]);
    const typed = [textBlock(rules), textBlock(attachments)];
    expect(isContextBlock(typed, 1)).toBe(false);
    expect(isContextBlock([textBlock('<attachments> is a tag'), textBlock('Hi')], 0)).toBe(true);
    expect(isContextBlock([textBlock('No tag'), textBlock('Hi')], 0)).toBe(false);
  });

  it('a stored message is [rules block, attachments block, text], with the rules block only when the rules changed', () => {
    expect(userMessageOf([], { rules: [{ text: 'Closed Mondays', summary: null }], attachments }, 'Hi')).toEqual({
      role: 'user', content: [textBlock(rules), textBlock(attachments), textBlock('Hi')],
    });
    expect(userMessageOf([], { rules: [], attachments }, 'Hi')).toEqual({ role: 'user', content: [textBlock(attachments), textBlock('Hi')] });
    const withRules: BetaMessageParam = { role: 'user', content: [textBlock(rules), textBlock('First')] };
    expect(userMessageOf([withRules], { rules: [{ text: 'Closed Mondays', summary: null }], attachments }, 'Hi')).toEqual({
      role: 'user', content: [textBlock(attachments), textBlock('Hi')],
    });
    expect(userMessageOf([], { rules: [], attachments: null }, 'Hi')).toEqual({ role: 'user', content: 'Hi' });
  });

  it('historyForModel stubs replaced rules blocks only, never an attachments block', () => {
    const first: BetaMessageParam = { role: 'user', content: [textBlock(rules), textBlock(attachments), textBlock('First')] };
    const reply: BetaMessageParam = { role: 'assistant', content: [textBlock('Noted.')] };
    const next: BetaMessageParam = { role: 'user', content: [textBlock(rulesBlock([])), textBlock('Second')] };
    expect(historyForModel([first, reply], next)).toEqual([
      { role: 'user', content: [textBlock(REPLACED_RULES_BLOCK), textBlock(attachments), textBlock('First')] }, reply,
    ]);
    expect(historyForModel([first, reply], { role: 'user', content: 'Second' })).toEqual([first, reply]);
  });
});

describe('the turn\'s content and its cap', () => {
  it('estimates 5,000 tokens a picture and a token for every 3 characters of text, and nothing for a file not sent', () => {
    expect(PICTURE_TOKENS).toBe(5000);
    expect(ATTACHMENT_TOKEN_CAP).toBe(150_000);
    expect(estimatedTokens(PICTURE)).toBe(5000);
    expect(estimatedTokens(textRead('x'.repeat(20_000)))).toBe(6667);
    expect(estimatedTokens(textRead('abc'))).toBe(1);
    expect(estimatedTokens({ status: 'not_readable', kind: 'pdf' })).toBe(0);
    expect(estimatedTokens({ status: 'turned_off', kind: 'text' })).toBe(0);
  });

  it('sends text as a document titled by its ref and a picture as a line naming it then the image, in the message\'s order', () => {
    const { content, counts } = turnAttachments([read(A, textRead('Fall menu')), read(B, PICTURE), read(C, { status: 'not_readable', kind: 'pdf' })]);
    expect(content).toEqual([
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Fall menu' }, title: A },
      { type: 'text', text: `The picture ${B}:` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    expect(counts).toEqual({ text: 1, picture: 1, pdf: 1 });
  });

  it('past about 150,000 estimated tokens, every later file with content is listed "not read: too much at once"', () => {
    const { block, content } = turnAttachments([
      read(A, textRead('x'.repeat(240_000))), // 80,000
      read(B, textRead('y'.repeat(210_000))), // 70,000: exactly the cap, which fits
      read(C, PICTURE),
      read(D, { status: 'not_readable', kind: 'pdf' }),
      read(E, textRead('z')),
    ]);
    expect(block.split('\n').slice(2, -1)).toEqual([
      `- ${A}: a text file`,
      `- ${B}: a text file`,
      `- ${C}: a picture, not read: too much at once`,
      `- ${D}: a PDF, which TownwiseAI can't read yet`,
      `- ${E}: a text file, not read: too much at once`,
    ]);
    expect(content.map((block) => (block.type === 'document' ? block.title : block.type))).toEqual([A, B]);
  });

  it('a send refuses the first file it can\'t attach, in the message\'s order', () => {
    expect(refusalOf([check(A, readable('picture', 10)), check(B, { status: 'turned_off', kind: 'text' })])).toBeNull();
    expect(refusalOf([check(A, readable('picture', 10)), check(B, { status: 'not_ready' }), check(C, { status: 'not_found' })])).toBe('not_ready');
    expect(refusalOf([check(A, { status: 'not_reference' })])).toBe('not_reference');
    expect(refusalOf([check(A, { status: 'not_allowed' }), check(B, { status: 'not_found' })])).toBe('not_allowed');
  });

  it('reads the files only when asked, and at most 7.5 MB of pictures a message: that picture and every file with content after it are too much', async () => {
    expect(MESSAGE_PICTURE_BYTES).toBe(7_500_000);
    const reads = { count: 0 };
    const off = check(E, { status: 'turned_off', kind: 'text' });
    const checks = [
      check(A, readable('picture', 3_750_000, reads)),
      check(B, readable('text', 65_536, reads)),
      check(C, readable('picture', 3_750_000, reads)), // exactly 7.5 MB of pictures: fits
      check(D, readable('picture', 1, reads)),
      off,
    ];
    expect(bytesToRead(checks)).toBe(3_750_000 + 65_536 + 3_750_000);
    expect(reads.count).toBe(0);
    const read = await readAttachments([...checks.slice(0, 4), check(`f_${'9'.repeat(24)}`, readable('text', 5, reads)), off], Date.now() + 60_000, createByteGate(ATTACHMENT_BYTES_IN_FLIGHT));
    expect(reads.count).toBe(3);
    expect(read.map((file) => file.read.status)).toEqual(['picture', 'text', 'picture', 'too_much', 'too_much', 'turned_off']);
    expect(turnAttachments(read).block.split('\n').slice(2, -1)[3]).toBe(`- ${D}: a picture, not read: too much at once`);
  });

  it('a replica holds at most 64 MB of attached files for its turns at once, and each release gives back what was held', () => {
    expect(ATTACHMENT_BYTES_IN_FLIGHT).toBe(64_000_000);
    const gate = createByteGate(10);
    expect(gate.reserve(6)).toBe(true);
    expect(gate.reserve(5)).toBe(false);
    expect(gate.held).toBe(6);
    expect(gate.reserve(4)).toBe(true);
    // A turn with nothing to read always goes.
    expect(gate.reserve(0)).toBe(true);
    gate.release(6);
    expect(gate.reserve(5)).toBe(true);
    gate.release(100);
    expect(gate.held).toBe(0);
  });

  it('expands a stored message with the block as the turn wrote it and the content after it, leaving the stored one as it was', () => {
    const rules = rulesBlock([]);
    const stale = attachmentsBlock([`- ${A}: a picture`]);
    const stored: BetaMessageParam = { role: 'user', content: [textBlock(rules), textBlock(stale), textBlock('What is this?')] };
    const copy = structuredClone(stored);
    const turn = turnAttachments([read(A, PICTURE)]);
    expect(expandedMessage(stored, turn)).toEqual({
      role: 'user', content: [textBlock(rules), textBlock(turn.block), ...turn.content, textBlock('What is this?')],
    });
    expect(stored).toEqual(copy);
    expect(expandedMessage({ role: 'user', content: 'Plain' }, turn)).toBeNull();
    // Nothing read and the block as stored: the turn sends the stored message, so its thinking is kept.
    const unread = turnAttachments([read(A, { status: 'turned_off', kind: 'picture' })]);
    const asStored: BetaMessageParam = { role: 'user', content: [textBlock(unread.block), textBlock('What is this?')] };
    expect(expandedMessage(asStored, unread)).toBeNull();
    // A regenerate whose file was turned off since sends the block as it is now, with no content.
    expect(expandedMessage(stored, unread)).toEqual({ role: 'user', content: [textBlock(rules), textBlock(unread.block), textBlock('What is this?')] });
  });
});

describe('PDF, Word and Excel files, sent as their text', () => {
  it('sends each as a document titled by its ref after the block, says when its text was cut, and counts each kind', () => {
    const { block, content, counts } = turnAttachments([
      read(A, docRead('pdf', 'Events for June')),
      read(B, docRead('word', 'Spring menu', true)),
      read(C, docRead('excel', 'Sheet: Daily\nDate\tGuests')),
    ]);
    expect(block.split('\n').slice(2, -1)).toEqual([
      `- ${A}: a PDF`,
      `- ${B}: a Word file, only its first 20,000 characters`,
      `- ${C}: an Excel file`,
    ]);
    expect(content).toEqual([
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Events for June' }, title: A },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Spring menu' }, title: B },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Sheet: Daily\nDate\tGuests' }, title: C },
    ]);
    expect(counts).toEqual({ pdf: 1, word: 1, excel: 1 });
    // A token for every 3 characters, as for a text file.
    expect(estimatedTokens(docRead('pdf', 'x'.repeat(20_000)))).toBe(6667);
  });

  it('lists one the thread refused, couldn\'t get to, or found no text in as not read, with its reason; a picture too large keeps its words', () => {
    const { block, content, counts } = turnAttachments([
      read(A, { status: 'encrypted', kind: 'pdf' }),
      read(B, { status: 'damaged', kind: 'word' }),
      read(C, { status: 'too_complex', kind: 'excel' }),
      read(D, { status: 'busy', kind: 'pdf' }),
      read(E, docRead('pdf', ' \n\n ')),
    ]);
    expect(block.split('\n').slice(2, -1)).toEqual([
      `- ${A}: a PDF, not read: it has a password`,
      `- ${B}: a Word file, not read: it couldn't be opened`,
      `- ${C}: an Excel file, not read: too complex to turn into text`,
      `- ${D}: a PDF, not read: TownwiseAI was busy reading another file; try again in a moment`,
      `- ${E}: a PDF, not read: it has no text, so it may be a scan`,
    ]);
    expect(content).toEqual([]);
    expect(counts).toEqual({ pdf: 3, word: 1, excel: 1 });
    expect(turnAttachments([
      read(A, { status: 'too_large', kind: 'pdf' }),
      read(B, { status: 'too_large', kind: 'picture' }),
      read(C, docRead('excel', '')),
    ]).block.split('\n').slice(2, -1)).toEqual([
      `- ${A}: a PDF, not read: too large`,
      `- ${B}: a picture, not read: over 3.75 MB`,
      `- ${C}: an Excel file, not read: it is empty`,
    ]);
  });
});

describe('a message\'s PDF, Word and Excel files, read one after another', () => {
  /** A document check whose read the test settles; each read records when it started and ended, and the `by` it got. */
  function documentCheck(kind: 'pdf' | 'word' | 'excel', log: string[], outcome: ItemContent, ms = 20): ItemForModel {
    return {
      status: 'readable', kind, bytes: 10,
      read: async (by) => {
        log.push(`start ${kind} ${String(by)}`);
        await new Promise((resolve) => { setTimeout(resolve, ms); });
        log.push(`end ${kind}`);
        return outcome;
      },
    };
  }

  it('reads each document only after the one before it ended, so a message\'s own files never wait on each other', async () => {
    const log: string[] = [];
    const reads = { count: 0 };
    const by = Date.now() + 120_000;
    const read = await readAttachments([
      check(A, documentCheck('pdf', log, { status: 'text', kind: 'pdf', text: 'June', truncated: false })),
      check(B, readable('picture', 10, reads)),
      check(C, documentCheck('word', log, { status: 'text', kind: 'word', text: 'Menu', truncated: false })),
      check(D, documentCheck('excel', log, { status: 'text', kind: 'excel', text: 'Sheet', truncated: false })),
    ], by, createByteGate(ATTACHMENT_BYTES_IN_FLIGHT));
    expect(log).toEqual([`start pdf ${String(by)}`, 'end pdf', `start word ${String(by)}`, 'end word', `start excel ${String(by)}`, 'end excel']);
    expect(read.map((file) => file.read.status)).toEqual(['text', 'picture', 'text', 'text']);
    // The picture didn't wait for the documents.
    expect(reads.count).toBe(1);
  });

  it('lists a document the turn hasn\'t the time for as too much at once, and after one found the thread busy, the rest busy without reading', async () => {
    const log: string[] = [];
    const by = Date.now() + 120_000;
    const read = await readAttachments([
      check(A, documentCheck('pdf', log, { status: 'no_time', kind: 'pdf' })),
      check(B, documentCheck('word', log, { status: 'busy', kind: 'word' })),
      check(C, documentCheck('excel', log, { status: 'text', kind: 'excel', text: 'Sheet', truncated: false })),
    ], by, createByteGate(ATTACHMENT_BYTES_IN_FLIGHT));
    expect(read.map((file) => file.read)).toEqual([
      { status: 'too_much', kind: 'pdf' }, { status: 'busy', kind: 'word' }, { status: 'busy', kind: 'excel' },
    ]);
    // The Excel file was never read.
    expect(log).toEqual([`start pdf ${String(by)}`, 'end pdf', `start word ${String(by)}`, 'end word']);
    expect(turnAttachments(read).block.split('\n').slice(2, -1)).toEqual([
      `- ${A}: a PDF, not read: too much at once`,
      `- ${B}: a Word file, not read: TownwiseAI was busy reading another file; try again in a moment`,
      `- ${C}: an Excel file, not read: TownwiseAI was busy reading another file; try again in a moment`,
    ]);
  });

  it('reads no later document once a read failed: none opens its original or starts the thread', async () => {
    const log: string[] = [];
    const failing: ItemForModel = {
      status: 'readable', kind: 'pdf', bytes: 10,
      read: async () => {
        log.push('start failing');
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        throw new Error('storage down');
      },
    };
    const gate = createByteGate(ATTACHMENT_BYTES_IN_FLIGHT);
    await expect(readAttachments([
      check(A, failing),
      check(B, documentCheck('word', log, { status: 'text', kind: 'word', text: 'Menu', truncated: false })),
      check(C, documentCheck('excel', log, { status: 'text', kind: 'excel', text: 'Sheet', truncated: false })),
    ], Date.now() + 120_000, gate)).rejects.toThrow('storage down');
    // Long enough for the chain behind it to have run, had it read.
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(log).toEqual(['start failing']);
  });

  it('gives a document\'s bytes back once it is read, so another turn\'s file fits; a picture\'s stay held for the turn', async () => {
    const reads = { count: 0 };
    const document = { ...documentCheck('pdf', [], { status: 'text', kind: 'pdf', text: 'June', truncated: false }), bytes: 9_000_000 } as ItemForModel;
    const checks = [check(A, document), check(B, readable('picture', 1_000_000, reads))];
    // A replica with room for this turn's 10 MB and nothing more.
    const gate = createByteGate(10_000_000);
    expect(bytesToRead(checks)).toBe(10_000_000);
    expect(gate.reserve(bytesToRead(checks))).toBe(true);
    expect(gate.reserve(9_000_000)).toBe(false);
    await readAttachments(checks, Date.now() + 120_000, gate);
    expect(gate.held).toBe(1_000_000);
    // Another turn's 9 MB document now fits.
    expect(gate.reserve(9_000_000)).toBe(true);
  });

  it('counts the bytes of the pictures it sends, for the turn\'s cap on pictures', () => {
    const big: FileRead = { status: 'picture', mediaType: 'image/png', base64: Buffer.alloc(3000).toString('base64') };
    expect(turnAttachments([read(A, big), read(B, PICTURE), read(C, textRead('Menu'))]).pictureBytes).toBe(3000 + Buffer.from('iVBORw0KGgo=', 'base64').length);
    expect(turnAttachments([read(A, textRead('Menu'))]).pictureBytes).toBe(0);
    expect(ANSWER_TIME_MS).toBe(30_000);
  });
});

describe('read_data_item reading an attached file again (D36)', () => {
  const PNG_DATA = 'iVBORw0KGgo=';
  /**
   * A turn's tools whose items reader answers `check` for any file that isn't a text item, with the replica's bytes in a
   * gate of `room` bytes; `pictureBytes` is what the turn's pictures already hold.
   */
  function toolsFor(check: ItemForModel, attached: readonly string[], opts: { room?: number; pictureBytes?: number; by?: number } = {}): {
    tc: ToolContext; viewers: ItemViewer[]; gate: ByteGate;
  } {
    const viewers: ItemViewer[] = [];
    const gate = createByteGate(opts.room ?? ATTACHMENT_BYTES_IN_FLIGHT);
    const items = {
      on: true,
      readText: () => Promise.resolve({ status: 'not_readable' }),
      readForModel: (_scope: unknown, _location: string, _fileId: string, viewer: ItemViewer) => {
        viewers.push(viewer);
        return Promise.resolve(check);
      },
    };
    const tc = {
      ctx: { items }, scope: {}, location: { id: 'l1' }, role: 'org_admin', actor: { actorUserId: 'u1' },
      turn: { readUntrusted: false, readWeb: false, pictureBytes: opts.pictureBytes ?? 0 },
      files: { attached: new Set(attached), by: opts.by ?? Date.now() + 120_000, bytes: gate, sent: new Map() },
    } as unknown as ToolContext;
    return { tc, viewers, gate };
  }
  const call = (ref: string): BetaToolUseBlock => ({ type: 'tool_use', id: 't1', name: 'read_data_item', input: { ref } } as unknown as BetaToolUseBlock);
  const readsAs = (content: ItemContent, reads: { count: number; by?: number } = { count: 0 }): ItemForModel => ({
    status: 'readable', kind: 'pdf', bytes: 10,
    read: (by) => {
      reads.count += 1;
      reads.by = by;
      return Promise.resolve(content);
    },
  });
  const picture = (bytes: number, reads: { count: number } = { count: 0 }): ItemForModel => ({
    status: 'readable', kind: 'picture', bytes,
    read: () => {
      reads.count += 1;
      return Promise.resolve({ status: 'picture', mediaType: 'image/png', base64: PNG_DATA });
    },
  });
  const reasonOf = async (tc: ToolContext, ref = A): Promise<string> => (JSON.parse((await runTool(tc, call(ref))).result.content as string) as { reason: string }).reason;

  it('sends a picture as an image block after the result\'s text, marks the turn read, and saves only its stub', async () => {
    const { tc, viewers } = toolsFor({ status: 'readable', kind: 'picture', bytes: 10, read: () => Promise.resolve({ status: 'picture', mediaType: 'image/png', base64: PNG_DATA }) }, [A]);
    const { result } = await runTool(tc, call(A));
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ ref: A, picture: true }) },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_DATA } },
    ]);
    expect(viewers).toEqual([{ userId: 'u1', role: 'org_admin' }]);
    expect(tc.turn.readUntrusted).toBe(true);
    expect(resultViewOf('read_data_item', result)).toEqual({ ref: A, available: true, picture: true });
    const saved = savedResultOf('read_data_item', result);
    expect(saved.content).toBe(JSON.stringify({ ref: A, picture: true, elided: true, reason: 'Seen in an earlier turn; call read_data_item again to see it.' }));
    expect(JSON.stringify(saved)).not.toContain(PNG_DATA);
    // The stub reads as the same card.
    expect(resultViewOf('read_data_item', saved)).toEqual({ ref: A, available: true, picture: true });
  });

  it('hands back a PDF\'s text as a text item\'s, and saves the same stub', async () => {
    const { tc } = toolsFor(readsAs({ status: 'text', kind: 'pdf', text: 'Events for June', truncated: true }), [A]);
    const { result } = await runTool(tc, call(A));
    expect(result.content).toBe(JSON.stringify({ ref: A, text: 'Events for June', truncated: true }));
    expect(tc.turn.readUntrusted).toBe(true);
    expect(savedResultOf('read_data_item', result).content)
      .toBe(JSON.stringify({ ref: A, chars: 15, truncated: true, elided: true, reason: 'Read in an earlier turn; call read_data_item again for its current text.' }));
  });

  it('read_data_item adds what it hands back to the turn\'s sent, and a refusal adds nothing', async () => {
    const pdf = toolsFor(readsAs({ status: 'text', kind: 'pdf', text: 'Events for June', truncated: true }), [A]);
    await runTool(pdf.tc, call(A));
    expect([...pdf.tc.files.sent]).toEqual([[A, { text: 'Events for June', truncated: true }]]);
    const shot = toolsFor(picture(10), [A]);
    await runTool(shot.tc, call(A));
    expect([...shot.tc.files.sent]).toEqual([[A, { picture: true }]]);
    // A text item, attached or not, is read through readText.
    const item = toolsFor({ status: 'not_found' }, []);
    (item.tc.ctx.items as { readText: unknown }).readText = () => Promise.resolve({ status: 'ok', text: 'Fall menu', truncated: false });
    await runTool(item.tc, call(B));
    expect([...item.tc.files.sent]).toEqual([[B, { text: 'Fall menu', truncated: false }]]);
    for (const refusedBy of [
      toolsFor({ status: 'not_allowed' }, [A]),
      toolsFor(readsAs({ status: 'busy', kind: 'pdf' }), [A]),
      toolsFor(readsAs({ status: 'text', kind: 'pdf', text: '\n\n', truncated: false }), [A]),
      toolsFor(readsAs({ status: 'text', kind: 'pdf', text: 'Sentinel', truncated: false }), [B]),
    ]) {
      await runTool(refusedBy.tc, call(A));
      expect(refusedBy.tc.files.sent.size).toBe(0);
      expect(refusedBy.tc.turn.readUntrusted).toBe(false);
    }
  });

  it('reads no file the path didn\'t attach, and refuses one it can\'t send with its reason, without marking the turn read', async () => {
    const notAttached = toolsFor(readsAs({ status: 'text', kind: 'pdf', text: 'Sentinel', truncated: false }), [B]);
    expect(JSON.parse((await runTool(notAttached.tc, call(A))).result.content as string)).toEqual({
      available: false,
      reason: 'TownwiseAI can read text items added for reference, and a picture, calendar (.ics), PDF, Word (.docx) or Excel (.xlsx) file attached to a message in this conversation. It can’t read sales files, old Word or Excel files, ZIP files or other files.',
    });
    expect(notAttached.viewers).toEqual([]);
    const reasons = await Promise.all([
      toolsFor({ status: 'not_allowed' }, [A]),
      toolsFor(readsAs({ status: 'busy', kind: 'pdf' }), [A]),
      toolsFor(readsAs({ status: 'text', kind: 'pdf', text: '\n\n', truncated: false }), [A]),
      toolsFor(readsAs({ status: 'encrypted', kind: 'excel' }), [A]),
    ].map(async ({ tc }) => {
      const parsed = JSON.parse((await runTool(tc, call(A))).result.content as string) as { reason: string };
      expect(tc.turn.readUntrusted).toBe(false);
      return parsed.reason;
    }));
    expect(reasons).toEqual([
      'Only the person who added that file or an org admin can have TownwiseAI read it.',
      'TownwiseAI was busy reading another file. Try again in a moment.',
      'That PDF has no text, so it may be a scan. TownwiseAI reads only a PDF’s text.',
      'That file has a password, so TownwiseAI can’t read it.',
    ]);
  });

  it('keeps a turn\'s pictures within a message\'s: one that would pass 7.5 MB is too much at once, and nothing is read or held', async () => {
    const reads = { count: 0 };
    const full = toolsFor(picture(600_000, reads), [A], { pictureBytes: 7_000_000 });
    expect(await reasonOf(full.tc)).toBe('Too much at once: this reply already has as many pictures as one message can carry. Ask about it in a new message.');
    expect([reads.count, full.gate.held, full.tc.turn.readUntrusted]).toEqual([0, 0, false]);
    // One that fits is read, its bytes held for the rest of the turn and counted toward its pictures.
    const fits = toolsFor(picture(500_000, reads), [A], { pictureBytes: 7_000_000 });
    await runTool(fits.tc, call(A));
    expect([reads.count, fits.gate.held, fits.tc.turn.pictureBytes]).toEqual([1, 500_000, 7_500_000]);
  });

  it('holds a re-read\'s bytes against the replica\'s cap: past it nothing is read; a document\'s go back once it is read', async () => {
    const reads = { count: 0 };
    const crowded = toolsFor(picture(500_000, reads), [A], { room: 400_000 });
    expect(await reasonOf(crowded.tc)).toBe('TownwiseAI is reading a lot of files right now. Try again in a moment.');
    expect([reads.count, crowded.gate.held]).toEqual([0, 0]);
    const document = toolsFor(readsAs({ status: 'text', kind: 'pdf', text: 'June', truncated: false }, reads), [A], { room: 400_000 });
    await runTool(document.tc, call(A));
    expect([reads.count, document.gate.held]).toEqual([1, 0]);
    // A picture that turned out not to be sendable holds nothing either.
    const broken = toolsFor({ status: 'readable', kind: 'picture', bytes: 10, read: () => Promise.resolve({ status: 'too_many_pixels', kind: 'picture' }) }, [A]);
    expect(await reasonOf(broken.tc)).toBe('That picture is too large in pixels for TownwiseAI to read.');
    expect(broken.gate.held).toBe(0);
  });

  it('reads by the turn\'s deadline, and one with too little time left reads nothing and says so', async () => {
    const reads: { count: number; by?: number } = { count: 0 };
    const by = Date.now() + 50_000;
    const late = toolsFor(readsAs({ status: 'no_time', kind: 'pdf' }, reads), [A], { by });
    expect(await reasonOf(late.tc)).toBe('There isn’t enough time left in this reply to read that file. Ask about it in a new message.');
    expect(reads.by).toBe(by);
    expect([late.tc.turn.readUntrusted, late.gate.held]).toEqual([false, 0]);
  });
});

describe('a turn with attachments', () => {
  const stored: BetaMessageParam = { role: 'user', content: [textBlock(attachmentsBlock([`- ${A}: a text file`])), textBlock('What is on it?')] };
  const expanded = expandedMessage(stored, turnAttachments([read(A, textRead('Sentinel-file-text'))])) ?? stored;
  const noTools = {} as unknown as ToolContext;
  const base = {
    tools: noTools, signal: new AbortController().signal, now: () => new Date('2026-06-01T12:00:00.000Z'), emit: () => undefined,
    charge: () => Promise.resolve(), budgetSpent: () => Promise.resolve(false),
  };

  it('sends the expanded message in every request, saves the stored one, and saves none of the turn\'s thinking', async () => {
    const model = scriptedModel();
    model.script({ kind: 'message', message: message([thinking('sig-attached'), text('It lists the fall menu.')]) });
    const result = await runTurn({
      ...base, model, history: [], userMessage: stored, expanded,
      nodes: { user: { id: 'u1', parentId: null }, reply: { id: 'a1', parentId: 'u1' } },
    });
    expect(messagesOf(model.calls[0])).toEqual([expanded]);
    expect(result.kind).toBe('done');
    const saved = result.kind === 'done' ? result.messages.map((m) => JSON.parse(m.param) as BetaMessageParam) : [];
    expect(saved).toEqual([stored, { role: 'assistant', content: [{ type: 'text', text: 'It lists the fall menu.', citations: null }] }]);
    expect(JSON.stringify(saved)).not.toMatch(/Sentinel-file-text|sig-attached/);
  });

  it('a regenerate sends the history\'s last message expanded, and the rest as it is', async () => {
    const model = scriptedModel();
    model.script({ kind: 'message', message: message([thinking('sig-again'), text('Again.')]) });
    const before: BetaMessageParam[] = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: [textBlock('Hi.')] }];
    const result = await runTurn({
      ...base, model, history: [...before, stored], userMessage: null, expanded,
      nodes: { user: null, reply: { id: 'a2', parentId: 'u1' } },
    });
    expect(messagesOf(model.calls[0])).toEqual([...before, expanded]);
    const saved = result.kind === 'done' ? result.messages.map((m) => m.param).join('') : '';
    expect(saved).toContain('Again.');
    expect(saved).not.toContain('sig-again');
  });

  it('runs no more of a message\'s tool calls once the turn is stopped or past its time limit', async () => {
    const stop = new AbortController();
    let reads = 0;
    const tools = {
      ctx: {
        items: {
          on: true,
          readText: () => {
            reads += 1;
            stop.abort();
            return Promise.resolve({ status: 'turned_off' });
          },
        },
      },
      scope: {}, location: { id: 'l1' }, today: '2026-06-01', timeZone: 'America/New_York',
      turn: { readUntrusted: false, readWeb: false, pictureBytes: 0 }, files: { attached: new Set(), by: 0, bytes: createByteGate(0), sent: new Map() },
    } as unknown as ToolContext;
    const model = scriptedModel();
    model.script({ kind: 'message', message: message([toolUse('r1', 'read_data_item', { ref: A }), toolUse('r2', 'read_data_item', { ref: B })]) });
    const result = await runTurn({
      ...base, tools, signal: stop.signal, model, history: [], userMessage: { role: 'user', content: 'Read both' }, expanded: null,
      nodes: { user: { id: 'u1', parentId: null }, reply: { id: 'a1', parentId: 'u1' } },
    });
    expect(result.kind).toBe('aborted');
    expect(reads).toBe(1);
  });

  it('start_calibration refuses in a turn that read a file, before anything is looked up', async () => {
    const tc = { role: 'org_admin', turn: { readUntrusted: true } } as unknown as ToolContext;
    expect(JSON.parse((await startCalibrationTool.run(tc, { regimeStart: null })).content)).toEqual({
      started: false, code: 'file_turn',
      message: 'A calibration can’t start in a turn that read a file from Your data. Ask the owner to confirm in a new message.',
    });
    // A member hears the role rule first.
    const member = { role: 'member', turn: { readUntrusted: true } } as unknown as ToolContext;
    expect(JSON.parse((await startCalibrationTool.run(member, { regimeStart: null })).content)).toMatchObject({ code: 'org_admin_only' });
  });
});
