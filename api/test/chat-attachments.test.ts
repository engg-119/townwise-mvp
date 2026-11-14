// Files attached to a person's message (spec D36, docs/portal/tuning-chat.md section 3), without Docker: the attachments
// block's words, where it sits in the stored message, how the turn's content is built and capped (tokens, a message's
// pictures, a replica's bytes in flight), what a turn sends against what it saves, and start_calibration's refusal in a
// turn that read a file.
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_BYTES_IN_FLIGHT, ATTACHMENT_TOKEN_CAP, attachedTo, attachmentsBlock, bytesToRead, createByteGate, estimatedTokens, expandedMessage,
  MESSAGE_PICTURE_BYTES, PICTURE_TOKENS, readAttachments, refusalOf, turnAttachments, type AttachmentCheck, type AttachmentRead, type FileRead,
} from '../src/chat/attachments.ts';
import { startCalibrationTool } from '../src/chat/tools/calibration.ts';
import type { ToolContext } from '../src/chat/tools/registry.ts';
import { runTurn } from '../src/chat/turn.ts';
import { historyForModel, isContextBlock, REPLACED_RULES_BLOCK, rulesBlock, userMessageOf } from '../src/chat/user-message.ts';
import type { ItemForModel } from '../src/files/items.ts';
import { message, messagesOf, scriptedModel, text, thinking } from './helpers/chat-model.ts';

const A = `f_${'a'.repeat(24)}`;
const B = `f_${'b'.repeat(24)}`;
const C = `f_${'c'.repeat(24)}`;
const D = `f_${'d'.repeat(24)}`;
const E = `f_${'e'.repeat(24)}`;

const LEAD = 'Townwise added this before the person\'s message; they didn\'t type it. The person attached these files from Your data to this message. Their content follows for this turn only; to read one again in a later turn, call read_data_item with its ref.';

const read = (ref: string, value: FileRead): AttachmentRead => ({ ref, kind: null, read: value });
const check = (ref: string, value: ItemForModel): AttachmentCheck => ({ ref, kind: null, check: value });
const textRead = (value: string, truncated = false): FileRead => ({ status: 'text', text: value, truncated });
const PICTURE: FileRead = { status: 'picture', mediaType: 'image/png', base64: 'iVBORw0KGgo=' };
/** A file the checks found the turn can send, `bytes` long; `reads` counts its reads. */
function readable(kind: 'text' | 'picture', bytes: number, reads: { count: number } = { count: 0 }): ItemForModel {
  return {
    status: 'readable', kind, bytes,
    read: () => {
      reads.count += 1;
      return Promise.resolve(kind === 'text' ? { status: 'text', text: 'Fall menu', truncated: false } : PICTURE as Extract<FileRead, { status: 'picture' }>);
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
    const read = await readAttachments([...checks.slice(0, 4), check(`f_${'9'.repeat(24)}`, readable('text', 5, reads)), off]);
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
