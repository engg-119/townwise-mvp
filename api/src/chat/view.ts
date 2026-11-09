// What GET /api/org/locations/:locationId/chat/:conversationId shows of a stored conversation (section 2): one entry
// per message the person wrote, and one per run of TownwiseAI's replies to it, with the tool-result messages between
// them folded in. A reply's `parts` replay it in order: text, tool calls (as the cards the stream showed) and note
// proposals. Thinking blocks and raw tool results are never returned, and neither are calls that never ran.
import type {
  BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { readNoteContent } from '../handlers/notes.ts';
import type { FeedbackReason } from '../stores/chat-conversations.ts';
import type { NoteContent } from '../stores/notes.ts';
import { inputViewOf, resultViewOf, toolNamed, type ToolView } from './tools/registry.ts';
import type { ChatNode } from './tree.ts';
import { NOT_RUN } from './turn.ts';

/** What the author did with a proposal (tw_chat_proposals). `noteId` is the saved note's id, else null. */
export interface ProposalState {
  readonly status: 'open' | 'saved' | 'dismissed';
  readonly noteId: string | null;
}

export const OPEN: ProposalState = { status: 'open', noteId: null };

/** A note proposal shown to the owner, with the id of the propose_note call that made it. */
export interface ShownProposal extends NoteContent {
  readonly id: string;
}

export type ProposalView = ShownProposal & ProposalState;

/** A reply's rating as the author sees it. */
export interface FeedbackView { rating: 'up' | 'down'; reason: FeedbackReason | null }

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'done' | 'error'; input: ToolView | null; result: ToolView | null }
  | { type: 'proposal'; proposal: ProposalView };

export interface ChatMessageView {
  /** The tree node the entry came from (src/chat/tree.ts). */
  nodeId: string;
  role: 'user' | 'assistant';
  /** When the entry's first stored message was produced. */
  at: string;
  /** Every text part, joined by a blank line (for clients that read only text). */
  text: string;
  /** Every proposal part's proposal, in order (for clients that read only proposals). */
  proposals: ProposalView[];
  /** The reply in order; empty for the person's own message. */
  parts: ChatPart[];
  /** The author's rating of the reply; null when unrated and for the person's own message. */
  feedback: FeedbackView | null;
}

function blocksOf(param: BetaMessageParam): readonly BetaContentBlockParam[] {
  if (param.role === 'system') return [];
  return typeof param.content === 'string' ? [{ type: 'text', text: param.content }] : param.content;
}

/** The part for one tool call, or null for a call that never ran, has no result, or names no registered tool. */
function partOf(
  block: BetaToolUseBlockParam, result: BetaToolResultBlockParam | undefined, today: string, stateOf: (proposal: ShownProposal) => ProposalState,
): ChatPart | null {
  if (result === undefined || toolNamed(block.name) === undefined) return null;
  const error = result.is_error === true;
  if (error && typeof result.content === 'string' && result.content.startsWith(NOT_RUN)) return null;
  if (block.name === 'propose_note' && !error) {
    // A proposal was shown when its call got a result that is not an error.
    const note = readNoteContent(block.input, today);
    if (note === null) return null;
    const shown = { ...note, id: block.id };
    return { type: 'proposal', proposal: { ...shown, ...stateOf(shown) } };
  }
  return {
    type: 'tool', id: block.id, name: block.name, state: error ? 'error' : 'done',
    input: inputViewOf(block.name, block.input, today), result: resultViewOf(block.name, result),
  };
}

function entry(nodeId: string, role: 'user' | 'assistant', at: Date, parts: ChatPart[], feedback: FeedbackView | null): ChatMessageView {
  const texts = parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  return {
    nodeId, role, at: at.toISOString(), text: texts.join('\n\n'),
    proposals: parts.flatMap((part) => (part.type === 'proposal' ? [part.proposal] : [])),
    parts: role === 'user' ? [] : parts,
    feedback: role === 'user' ? null : feedback,
  };
}

/**
 * `path` is the nodes shown, root to leaf. `today` (the day the caller's tools read dates against) re-reads each call's
 * input, which was valid when it ran, through the same rules. `stateOf` says what became of each proposal; without it
 * every proposal reads as open. `feedbackOf` says how the author rated a reply (default: unrated). A node with nothing visible has no entry.
 */
export function chatMessageViews(
  path: readonly ChatNode[], today: string, stateOf: (proposal: ShownProposal) => ProposalState = () => OPEN,
  feedbackOf: (nodeId: string) => FeedbackView | null = () => null,
): ChatMessageView[] {
  const messages = path.map((node) => ({
    node, items: node.messages.map((message) => ({ at: message.at, param: JSON.parse(message.param) as BetaMessageParam })),
  }));
  const results = new Map<string, BetaToolResultBlockParam>();
  for (const { items } of messages) {
    for (const { param } of items) {
      for (const block of blocksOf(param)) if (block.type === 'tool_result') results.set(block.tool_use_id, block);
    }
  }
  const views: ChatMessageView[] = [];
  for (const { node, items } of messages) {
    const first = items[0];
    if (first === undefined) continue;
    if (node.role === 'user') {
      const text = blocksOf(first.param).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      if (text !== '') views.push(entry(node.id, 'user', first.at, [{ type: 'text', text }], null));
      continue;
    }
    const parts: ChatPart[] = [];
    for (const { param } of items) {
      if (param.role !== 'assistant') continue;
      for (const block of blocksOf(param)) {
        const last = parts.at(-1);
        if (block.type === 'text') {
          if (block.text === '') continue;
          if (last?.type === 'text') last.text += block.text;
          else parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          const part = partOf(block, results.get(block.id), today, stateOf);
          if (part !== null) parts.push(part);
        }
      }
    }
    if (parts.length > 0) views.push(entry(node.id, 'assistant', first.at, parts, feedbackOf(node.id)));
  }
  return views;
}
