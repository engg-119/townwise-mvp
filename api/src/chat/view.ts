// What GET /api/org/locations/:locationId/chat/:conversationId shows of a stored conversation (section 2): one entry
// per message with text or a note proposal. Thinking blocks, tool calls and tool results are never returned.
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { readNoteContent } from '../handlers/notes.ts';
import type { StoredMessage } from '../stores/chat-conversations.ts';
import type { NoteContent } from '../stores/notes.ts';

export interface ChatMessageView {
  role: 'user' | 'assistant';
  text: string;
  proposals: NoteContent[];
  at: string;
}

function blocksOf(param: BetaMessageParam): readonly BetaContentBlockParam[] {
  if (param.role === 'system') return [];
  return typeof param.content === 'string' ? [{ type: 'text', text: param.content }] : param.content;
}

/** `today` (UTC) only re-reads each proposal, which was valid when it was shown, through the notes rules. */
export function chatMessageViews(stored: readonly StoredMessage[], today: string): ChatMessageView[] {
  const messages = stored.map((message) => ({ at: message.at, param: JSON.parse(message.param) as BetaMessageParam }));
  // A proposal was shown when its propose_note call got a result that is not an error.
  const shown = new Set<string>();
  for (const { param } of messages) {
    for (const block of blocksOf(param)) {
      if (block.type === 'tool_result' && block.is_error !== true) shown.add(block.tool_use_id);
    }
  }
  const views: ChatMessageView[] = [];
  for (const { at, param } of messages) {
    if (param.role === 'system') continue;
    const blocks = blocksOf(param);
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    const proposals = blocks.flatMap((block) => {
      if (param.role !== 'assistant' || block.type !== 'tool_use' || block.name !== 'propose_note' || !shown.has(block.id)) return [];
      const note = readNoteContent(block.input, today);
      return note === null ? [] : [note];
    });
    if (text === '' && proposals.length === 0) continue;
    views.push({ role: param.role, text, proposals, at: at.toISOString() });
  }
  return views;
}
