// What GET /api/org/locations/:locationId/chat/:conversationId shows of a stored conversation (section 2): one entry
// per message the person wrote, and one per run of TownwiseAI's replies to it, with the tool-result messages between
// them folded in. A reply's `parts` replay it in order: thinking summaries, text, tool calls (as the cards the stream showed), note
// proposals and visuals; its `next` is the questions its last valid suggest_next showed. A thinking block is returned as
// its summary text only (never its signature), and one with no text (stored before summaries were asked for) is left
// out. Raw tool results are never returned, and neither are calls that never ran.
import type {
  BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { AttachmentKind } from '../files/items.ts';
import { readNoteContent } from '../handlers/notes.ts';
import type { FeedbackReason } from '../stores/chat-conversations.ts';
import type { NoteContent } from '../stores/notes.ts';
import { attachedTo } from './attachments.ts';
import { nextOf } from './tools/next.ts';
import { inputViewOf, resultViewOf, toolNamed, type ToolView } from './tools/registry.ts';
import { visualOf, type Visual } from './tools/visual.ts';
import type { ChatNode } from './tree.ts';
import { NOT_RUN } from './turn.ts';
import { isContextBlock } from './user-message.ts';

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

/**
 * A file on Your data now, as a person's message shows it (D36): its name (null under view-as, and once the file is
 * gone), and `on`, `off` (turned off) or `gone` (deleted, its original deleted, or stored files off).
 */
export interface AttachmentFile { name: string | null; state: 'on' | 'off' | 'gone' }

/** A file a person's message carries: its ref and kind from the stored block, joined with Your data at read time. */
export interface AttachmentView extends AttachmentFile { ref: string; kind: AttachmentKind }

const UNKNOWN_FILE: AttachmentFile = { name: null, state: 'gone' };

export type ChatPart =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'done' | 'error'; input: ToolView | null; result: ToolView | null }
  | { type: 'proposal'; proposal: ProposalView }
  | { type: 'visual'; id: string; visual: Visual };

export interface ChatMessageView {
  /** The tree node the entry came from (src/chat/tree.ts). */
  nodeId: string;
  role: 'user' | 'assistant';
  /** When the entry's first stored message was produced. */
  at: string;
  /**
   * When the entry's last stored message was produced: the end of a reply, so its time worked is `endedAt` less the
   * person's message's `at`. Equal to `at` for the person's own message.
   */
  endedAt: string;
  /** Every text part, joined by a blank line (for clients that read only text). */
  text: string;
  /** Every proposal part's proposal, in order (for clients that read only proposals). */
  proposals: ProposalView[];
  /** The reply in order; empty for the person's own message. */
  parts: ChatPart[];
  /** The author's rating of the reply; null when unrated and for the person's own message. */
  feedback: FeedbackView | null;
  /** The questions the reply's last valid suggest_next showed; null when it has none and for the person's own message. */
  next: string[] | null;
  /** The files the person's message carries, in order (D36); empty for a reply. */
  attachments: AttachmentView[];
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
  if (block.name === 'show_visual' && !error && typeof result.content === 'string') {
    // A visual was shown when its call's result holds one; one that showed nothing stays a tool part.
    const visual = visualOf(result.content);
    if (visual !== null) return { type: 'visual', id: block.id, visual };
  }
  // Shown questions are the reply's `next`, not a part.
  if (block.name === 'suggest_next' && !error) return null;
  return {
    type: 'tool', id: block.id, name: block.name, state: error ? 'error' : 'done',
    input: inputViewOf(block.name, block.input, today), result: resultViewOf(block.name, result),
  };
}

function entry(
  nodeId: string, role: 'user' | 'assistant', at: Date, endedAt: Date, parts: ChatPart[], feedback: FeedbackView | null, next: string[] | null,
  attachments: AttachmentView[] = [],
): ChatMessageView {
  const texts = parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  return {
    nodeId, role, at: at.toISOString(), endedAt: endedAt.toISOString(), text: texts.join('\n\n'),
    proposals: parts.flatMap((part) => (part.type === 'proposal' ? [part.proposal] : [])),
    parts: role === 'user' ? [] : parts,
    feedback: role === 'user' ? null : feedback,
    next: role === 'user' ? null : next,
    attachments: role === 'user' ? attachments : [],
  };
}

/**
 * `path` is the nodes shown, root to leaf. `today` (the day the caller's tools read dates against) re-reads each call's
 * input, which was valid when it ran, through the same rules. `stateOf` says what became of each proposal; without it
 * every proposal reads as open. `feedbackOf` says how the author rated a reply (default: unrated). `fileOf` says what
 * an attached file is on Your data now (default: gone, with no name). A node with nothing visible has no entry.
 */
export function chatMessageViews(
  path: readonly ChatNode[], today: string, stateOf: (proposal: ShownProposal) => ProposalState = () => OPEN,
  feedbackOf: (nodeId: string) => FeedbackView | null = () => null,
  fileOf: (ref: string) => AttachmentFile = () => UNKNOWN_FILE,
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
      // Only what the person typed: a business_rules or attachments block Townwise added before it is never shown back;
      // the attachments block's refs and kinds are, joined with Your data.
      const blocks = blocksOf(first.param);
      const text = blocks.flatMap((block, index) => (block.type === 'text' && !isContextBlock(blocks, index) ? [block.text] : [])).join('');
      const attachments = attachedTo(first.param).map(({ ref, kind }) => ({ ref, kind, ...fileOf(ref) }));
      if (text !== '') views.push(entry(node.id, 'user', first.at, first.at, [{ type: 'text', text }], null, null, attachments));
      continue;
    }
    const parts: ChatPart[] = [];
    let next: string[] | null = null;
    for (const { param } of items) {
      if (param.role !== 'assistant') continue;
      for (const block of blocksOf(param)) {
        const last = parts.at(-1);
        if (block.type === 'thinking') {
          if (block.thinking !== '') parts.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'text') {
          if (block.text === '') continue;
          if (last?.type === 'text') last.text += block.text;
          else parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          const result = results.get(block.id);
          if (block.name === 'suggest_next' && result !== undefined && result.is_error !== true) next = nextOf(block.input) ?? next;
          const part = partOf(block, result, today, stateOf);
          if (part !== null) parts.push(part);
        }
      }
    }
    if (parts.length > 0) views.push(entry(node.id, 'assistant', first.at, items.at(-1)?.at ?? first.at, parts, feedbackOf(node.id), next));
  }
  return views;
}
