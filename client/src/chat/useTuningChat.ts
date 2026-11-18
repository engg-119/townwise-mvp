import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client';
import { describeError } from '../ui';
import {
  actOnItemProposal, addNote as postNote, deleteConversation as removeConversation, dismissProposal, endsTurn, followTurn, loadChat,
  loadConversation, loadItemProposal, rateReply, renameConversation, saveProposal, sendTurn, setActiveVersion, stopTurn, TURN_INTERRUPTED,
  type Budget, type ChatEvent, type ChatSummary, type ConversationLoad, type ConversationSummary, type Feedback, type FeedbackReason,
  type ItemProposal, type LiveTurnLoad, type MessageAttachment, type NoteProposal, type ProposalResult, type StoredMessage, type TurnListener,
  type TurnRequest,
} from './api';
import { draftKey, readDraft, writeDraft } from './drafts';
import { forgetChat, lastChatKey, recallChat, rememberChat, type LastChatStore } from './lastChat';
import { lastChatStore, onPageLeave } from './lastChatStore';
import { isHiddenTool, type SourceLink, type ToolStep } from './tools';
import { siblingAt, withTurn, type TreeNode } from './tree';
import type { Visual } from './visuals/schema';
import { onWake } from './wake';

// TownwiseAI's conversation state (spec P25; docs/portal/tuning-chat.md 2 and 3). A reply is an
// ordered list of parts, in the order they streamed: text, a group of tool calls, more text, a visual, a proposal
// card. Tool calls are kept by their id, so each card updates in place; proposal cards by the propose_note call's id.
//
// A proposal's actions go to the proposal route, which finds it only once its turn is stored (`done`, not a
// refusal). Until then a live card's actions wait; a card from a turn the server never kept offers the notes
// route instead (tuning-chat.md section 2). A proposal to keep text (propose_data_item, D28) is an item card: its
// title and text are never streamed, so the card reads them from its own route once the turn is stored, and a turn
// the server never kept has nothing to keep.
//
// A conversation is a tree (tuning-chat.md 2): the page shows one path of it, and `leafId` is that path's last saved
// node, where the next message goes. An edit sends the edited message again under its parent; a regenerate asks
// for a sibling of the newest reply; either one's new nodes join `tree` only once the turn is saved. A version
// switch reads the path through another sibling (and stores it as the one shown, except under view-as).
//
// A message may carry files of Your data (D36): the composer hands them to `send` with a callback for a turn taken
// back (the files go back to the composer, as the text does); an edit sends the edited message's files again (all
// but those gone from Your data), Try again sends its message's, and a regenerate sends none.
//
// A turn runs on the server whatever its connection does (resumable-chat-turns). Its events are numbered, so a
// dropped stream is read again from the last number (`followTurn`): at once on a wake (src/chat/wake), else after 1, 2
// and 4 seconds, then every 4, until the turn's last event or until the conversation shows it no longer live. Opening
// a conversation with a live turn (on load after a refresh, or in a second tab) shows the person's message and follows
// the reply from its first event, then reads the conversation again once it is saved. Stop asks the server to stop
// the turn and waits for its `stopped`; closing the stream never stops it.
//
// New chat and History work while a reply streams (owner request, 2026-11-18): leaving the conversation only stops
// following its turn, which runs on and is saved on the server (D45). A person has one running turn across chats and
// locations, so a send elsewhere meanwhile answers 409 `chat_turn_in_progress`: the text stays in the composer, the
// page names the chat still replying (`runningElsewhere`) with a link to it, and reads the list every 3 seconds until
// that turn ends, when the notice goes and a send can go.
//
// Leaving the page on a conversation and coming back within 5 minutes opens it again (lastChat.ts), reattaching to a
// turn still live in it; after that, or for a conversation the server no longer has, the page opens on a new chat.

export type CardStatus = 'open' | 'editing' | 'saving' | 'saved' | 'dismissed';

export interface ProposalCard {
  /** The propose_note call's id. */
  id: string;
  proposal: NoteProposal;
  status: CardStatus;
  /** `pending`: its turn hasn't ended; `kept`: stored, so the proposal route has it; `lost`: the turn was never saved. */
  stored: 'pending' | 'kept' | 'lost';
  /** Saved with the author's changes ("Edit first"). */
  edited: boolean;
  /** The server no longer has it (a 404): the card shows as unavailable. */
  gone: boolean;
  error: string | null;
}

/** A propose_data_item call the owner was shown (its result view says `shown`). */
export interface ItemCard {
  /** The propose_data_item call's id. */
  id: string;
  /** The conversation it is in; null only if the stream never named one (nothing is kept then). */
  conversationId: string | null;
  /** As a note card's: `pending` until its turn ends, then `kept` (its route has it) or `lost`. */
  stored: 'pending' | 'kept' | 'lost';
}

/** The tool whose calls show as item cards. */
export const ITEM_TOOL = 'propose_data_item';
export const ORDER_CHANGE_TOOL = 'propose_order_change';
export const ORDER_RULE_TOOL = 'propose_order_rule';
export const ORDER_SETUP_TOOL = 'propose_order_setup';

export interface OrderCard {
  id: string;
  conversationId: string | null;
  stored: 'pending' | 'kept' | 'lost';
  /** A propose_order_setup card (D56), which says so while it loads. */
  setup?: true;
}

export type MessagePart =
  /** The reply's thinking summary, as it streamed (or as it was stored): shown in the timeline and under "Worked for". */
  | { type: 'thinking'; key: string; text: string }
  | { type: 'text'; key: string; text: string }
  | { type: 'tools'; key: string; steps: ToolStep[] }
  | { type: 'proposal'; key: string; card: ProposalCard }
  /** A chart, table or totals Townwise drew from its own data (show_visual); `id` is the call's id. */
  | { type: 'visual'; key: string; id: string; visual: Visual }
  | { type: 'item'; key: string; card: ItemCard }
  | { type: 'order'; key: string; card: OrderCard };

export interface ChatMessage {
  key: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  /** `streaming`: the reply being written. A stopped or failed turn is not saved on the server. */
  state: 'complete' | 'streaming' | 'stopped' | 'failed';
  /** A short line under a reply: why it stopped or ended early. */
  note: string | null;
  /** Its node in the conversation's tree; null until its turn is saved, so never for a stopped, failed or refused one. */
  nodeId: string | null;
  /**
   * The node it hangs under: the reply a message follows (null for a first message), or the message a reply answers
   * (known for a regenerate from the start, for a new reply once its turn is saved).
   */
  parentId: string | null;
  /** The author's rating of a reply; null for none, and for the person's messages. */
  feedback: Feedback | null;
  /** Why the last rating didn't save; the rating shown went back to what it was. */
  ratingError: string | null;
  /** The three questions TownwiseAI suggested after this reply; null when it gave none. */
  next: string[] | null;
  /** The turn a reply streamed from: what Try again sends again. Null for a message read from the server. */
  request: TurnRequest | null;
  /**
   * A reply's time worked, in ms since the epoch: from the person sending the message to the reply's end. A streaming
   * reply has only `startedAt`; a stored one has both (from the stored times); null when not known, such as a
   * regenerated reply read back from the server, whose start was not stored.
   */
  startedAt: number | null;
  endedAt: number | null;
  /** The time shown under a message, in ms since the epoch: when the person sent it, or when a reply ended; null when not known. */
  at: number | null;
  /** The files the person's message carries (D36): as sent, or as the server shows them now; [] for a reply. */
  attachments: MessageAttachment[];
  /**
   * The pages a reply cites from its web searches (D37), from its `done` or the conversation's GET: listed under it
   * as its Sources. [] for none, for a reply still streaming and for the person's messages.
   */
  sources: SourceLink[];
}

/** The path a conversation shows: its messages, every node, and the path's leaf. */
export interface ShownPath { messages: ChatMessage[]; tree: TreeNode[]; leafId: string | null }

/** What the chat keeps of the turn that is streaming, until it ends. */
export interface LiveTurn {
  kind: 'send' | 'edit' | 'regenerate';
  /** The turn's new nodes, from its `conversation` event: they join `tree` once the turn is saved. */
  nodes: { user: string | null; reply: string | null; parentId: string | null } | null;
  /** A regenerate's earlier reply and the leaf shown with it, put back when the new reply isn't saved. */
  earlier: { message: ChatMessage; leafId: string | null } | null;
}

export interface TuningChatState {
  status: 'loading' | 'ready' | 'not_found' | 'failed';
  loadError: string | null;
  enabled: boolean;
  budget: Budget | null;
  conversations: ConversationSummary[];
  /** The open conversation; null for a new one. */
  conversationId: string | null;
  conversationLoading: boolean;
  messages: ChatMessage[];
  /** Every node of the open conversation, every version, in creation order; empty for a new conversation. */
  tree: TreeNode[];
  /** The last saved node of the path shown, where the next message goes; null for a new conversation. */
  leafId: string | null;
  /** From Send until the stream ends. */
  streaming: boolean;
  /** Another version is being read. */
  switching: boolean;
  /** Why the last send, conversation load or version switch failed. */
  error: string | null;
  draft: string;
  turn: LiveTurn | null;
  /**
   * A send was refused because the person's one running turn is in this conversation of the list (409
   * `chat_turn_in_progress`): the page says so with a link to it, until the list shows that turn ended. Null otherwise.
   */
  runningElsewhere: string | null;
}

type CardPatch = Partial<Pick<ProposalCard, 'status' | 'error' | 'edited' | 'gone'>>;

export type ChatAction =
  | { type: 'load' }
  | { type: 'loaded'; summary: ChatSummary }
  | { type: 'loadFailed'; notFound: boolean; error: string }
  | { type: 'summary'; summary: ChatSummary }
  /**
   * A send refused with 409 `chat_turn_in_progress`, and the list read after it (null when that read failed): the chat
   * running names the notice, else `error` shows.
   */
  | { type: 'held'; summary: ChatSummary | null; error: string }
  | { type: 'draft'; text: string }
  /** `draft`: the one kept for where it leads. */
  | { type: 'new'; draft: string }
  | { type: 'open'; id: string; draft: string }
  | { type: 'opened'; id: string; shown: ShownPath }
  | { type: 'openFailed'; id: string; error: string }
  | { type: 'send'; content: string; attachments: MessageAttachment[]; userKey: string; replyKey: string; request: TurnRequest }
  | { type: 'edit'; messageKey: string; content: string; attachments: MessageAttachment[]; userKey: string; replyKey: string; request: TurnRequest }
  | { type: 'regenerate'; replyKey: string; newKey: string; request: TurnRequest }
  | { type: 'event'; event: ChatEvent; key: string; at: string }
  | { type: 'ended' }
  | { type: 'stopped' }
  | { type: 'failed'; error: string | null; content: string; exhausted: boolean }
  | { type: 'discard'; id: string }
  | { type: 'removed'; id: string; draft: string }
  | { type: 'drop'; replyKey: string }
  | { type: 'card'; cardId: string; patch: CardPatch }
  | { type: 'switch' }
  | { type: 'switched'; id: string; shown: ShownPath }
  | { type: 'switchFailed'; id: string }
  | { type: 'rated'; key: string; feedback: Feedback | null; error: string | null }
  | { type: 'renamed'; id: string; title: string }
  /**
   * A conversation opened with a turn live in it: its path, the person's message (null for a regenerate) and the reply
   * that streams, read back from the turn's events.
   */
  | { type: 'reattach'; id: string; shown: ShownPath; asked: ChatMessage | null; replyKey: string; request: TurnRequest | null; live: LiveTurnLoad }
  | { type: 'stopFailed'; error: string };

export const NOT_SAVED = 'Your message and this reply weren’t saved.';
export const STOPPED = 'Stopped. Your message and this reply weren’t saved.';
export const CUT_OFF = 'The reply was cut off. Try again.';
export const REFUSED = 'TownwiseAI can’t help with that. Your message and this reply weren’t saved.';
export const BUDGET_SPENT = 'TownwiseAI stopped here because this month’s budget is used up.';
export const TIMED_OUT = 'The reply took too long. Try asking something shorter.';
export const REGENERATE_FAILED = 'That reply didn’t finish, so your earlier reply is back.';
export const VERSION_FAILED = 'Couldn’t show that version. Try again.';
export const RATING_FAILED = 'Couldn’t save your rating. Try again.';
/** A turn whose server stopped mid-turn (a restart): it is not continued, and the person sends again. */
export const INTERRUPTED = 'TownwiseAI was interrupted. Your message and this reply weren’t saved. Try again.';
/** Stop's request didn't reach the server: the reply goes on. */
export const STOP_FAILED = 'Couldn’t stop the reply. Try again.';
/** Why a question card's message (Something else…) can't go, once the month's budget is used up. */
export const TELL_BUDGET = 'This month’s budget is used up, so TownwiseAI can’t answer in the chat.';
const TELL_WAIT = 'Wait for TownwiseAI’s reply to finish, then try again.';
/** A question card's message whose conversation the person left before its reply ended: its answer wasn't saved. */
export const TELL_LEFT = 'You left the conversation before TownwiseAI replied, so your answer wasn’t saved. Try again.';

/** The `done` stop reasons of a turn the server saved; any other (a refusal) saved nothing. */
const SAVED_STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'tool_limit', 'budget'];

/** Text deltas are drawn at most this often (spec P25), so native doesn't redraw the thread per token. */
export const FLUSH_MS = 32;

/**
 * Stop and send: the server lets go of a stopped turn's claim before its `stopped`, so a 409 `chat_turn_in_progress`
 * is only a backstop, tried again this many times, this far apart.
 */
const CLAIM_RETRIES = 3;
const CLAIM_RETRY_MS = 500;

/** A dropped turn's stream is read again after these waits, then every last one, unless a wake comes first. */
export const RESUME_MS: readonly number[] = [1000, 2000, 4000];

/**
 * While a send waits on a turn running in another chat, or History is open with a conversation replying, the list is
 * read this often until that turn ends.
 */
export const LIST_POLL_MS = 3000;

/** The list, with the conversation whose reply streams marked running when the person leaves it for `to`. */
function leftRunning(state: TuningChatState, to: string | null): TuningChatState['conversations'] {
  const left = state.conversationId;
  if (!state.streaming || left === null || left === to) return state.conversations;
  return state.conversations.map((conversation) => (conversation.id === left ? { ...conversation, running: true } : conversation));
}

/** The conversation of the list holding the person's running turn at this location, else null. */
export function runningIn(summary: ChatSummary): string | null {
  const marked = summary.conversations.find((conversation) => conversation.running)?.id;
  if (marked !== undefined) return marked;
  const id = summary.liveTurn?.conversationId ?? null;
  return id !== null && summary.conversations.some((conversation) => conversation.id === id) ? id : null;
}

export function initialChatState(): TuningChatState {
  return {
    status: 'loading', loadError: null, enabled: false, budget: null, conversations: [],
    conversationId: null, conversationLoading: false, messages: [], tree: [], leafId: null, streaming: false, switching: false,
    error: null, draft: '', turn: null, runningElsewhere: null,
  };
}

function doneNote(stopReason: string): string | null {
  switch (stopReason) {
    case 'max_tokens': return 'The reply hit its length limit.';
    case 'refusal': return REFUSED;
    case 'tool_limit': return 'TownwiseAI stopped after too many lookups. Ask again to continue.';
    case 'budget': return BUDGET_SPENT;
    default: return null;
  }
}

function streamErrorText(code: string): string {
  if (code === 'provider_overloaded') return 'TownwiseAI is busy. Try again in a minute.';
  if (code === 'provider_unavailable') return 'Can’t reach TownwiseAI. Try again.';
  if (code === 'timeout') return TIMED_OUT;
  return 'Something went wrong with that reply. Try again.';
}

function minutes(seconds: number): string {
  const count = Math.max(1, Math.ceil(seconds / 60));
  return count === 1 ? '1 minute' : `${String(count)} minutes`;
}

/**
 * Copy for a turn the server refused or a stream that failed before it finished. `attached`: the message carried files
 * (D36), so a 404 or a 400 may be about one of them.
 */
export function sendErrorText(error: unknown, attached = false): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'chat_turn_in_progress') return 'You already have a reply in progress, maybe in another tab or location. Wait for it to finish, then try again.';
    if (error.code === 'conversation_full') return 'This conversation is full. Start a new chat.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t send messages.';
    if (error.code === 'files_unavailable') return 'File storage is off right now, so files can’t be attached. Remove them to send your message.';
    if (error.code === 'attachment_not_ready') return 'An attached file is still uploading. Send your message once it’s ready.';
    // D36: attaching takes the right to download the original, so a teammate's file (one already on Your data that a
    // chip found again, among them) is theirs or an org admin's to attach.
    if (error.code === 'attachment_not_allowed') {
      return 'Only the person who added a file to Your data, or an org admin, can attach it. Remove the files a teammate added to send your message.';
    }
    if (error.code === 'attachments_busy') return 'TownwiseAI is reading a lot of files right now. Try again in a moment.';
    if (error.status === 404 && attached) return 'An attached file isn’t on Your data for this location anymore, or this conversation was deleted.';
    if (error.status === 404) return 'This conversation or location wasn’t found.';
    if (error.status === 400 && attached) return 'That message couldn’t be sent with these files. Only files kept on Your data can be attached.';
    if (error.status === 400) return 'That message couldn’t be sent.';
    if (error.status === 429) {
      return error.retryAfterSeconds === null
        ? 'You’ve sent a lot of messages. Try again later.'
        : `You’ve sent a lot of messages. Try again in ${minutes(error.retryAfterSeconds)}.`;
    }
    // resumable-chat-turns: a replica shutting down takes no new turn; TownwiseAI is still on.
    if (error.code === 'chat_restarting') return 'TownwiseAI is restarting. Try again in a moment.';
    if (error.status === 503) return 'TownwiseAI isn’t turned on yet.';
  }
  return describeError(error);
}

/** A proposal card's error, in place on the card (spec P25). */
export function noteErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'note_limit') return 'This location has 1,000 notes. Delete old ones to add more.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t save notes.';
    if (error.status === 400) return 'Townwise couldn’t accept this note. Edit it or ask TownwiseAI to fix it.';
    if (error.status === 404) return 'This conversation or note wasn’t found.';
    if (error.status === 429) return describeError(error);
  }
  return 'Couldn’t save the note. Try again.';
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === status;
}

function withLive(state: TuningChatState, update: (message: ChatMessage) => ChatMessage): ChatMessage[] {
  return state.messages.map((message) => (message.state === 'streaming' ? update(message) : message));
}

/** Every pending card of a reply becomes `stored`. */
function settleCards(message: ChatMessage, stored: 'kept' | 'lost'): ChatMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === 'proposal' && part.card.stored === 'pending') return { ...part, card: { ...part.card, stored } };
      if (part.type === 'item' && part.card.stored === 'pending') return { ...part, card: { ...part.card, stored } };
      if (part.type === 'order' && part.card.stored === 'pending') return { ...part, card: { ...part.card, stored } };
      return part;
    }),
  };
}

/** A shown propose_data_item call: its item card, once. */
function withItem(message: ChatMessage, card: ItemCard, key: string): ChatMessage {
  if (message.parts.some((part) => part.type === 'item' && part.card.id === card.id)) return message;
  return { ...message, parts: [...message.parts, { type: 'item', key, card }] };
}

function withOrder(message: ChatMessage, card: OrderCard, key: string): ChatMessage {
  if (message.parts.some((part) => part.type === 'order' && part.card.id === card.id)) return message;
  return { ...message, parts: [...message.parts, { type: 'order', key, card }] };
}

function endLive(state: TuningChatState, end: Pick<ChatMessage, 'state' | 'note'>, now: number): ChatMessage[] {
  return withLive(state, (message) => settleCards({ ...message, ...end, endedAt: now }, 'lost'));
}

/** A regenerate that saved nothing: the earlier reply and its leaf come back in the new one's place. */
function putBack(state: TuningChatState, earlier: NonNullable<LiveTurn['earlier']>, error: string | null): TuningChatState {
  return {
    ...state, error, turn: null, leafId: earlier.leafId,
    messages: state.messages.map((message) => (message.state === 'streaming' ? earlier.message : message)),
  };
}

/** The person's message text. */
export function messageText(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
}

/** Every tool call of a reply, in order. */
export function stepsOf(message: ChatMessage): ToolStep[] {
  return message.parts.flatMap((part) => (part.type === 'tools' ? part.steps : []));
}

/** A tool event: the call's card updates in place by id, else joins the group in progress, else starts one. */
function withTool(message: ChatMessage, event: Extract<ChatEvent, { type: 'tool' }>, key: string): ChatMessage {
  const step: ToolStep = { id: event.id, name: event.name, state: event.state, input: event.input, result: event.result };
  if (message.parts.some((part) => part.type === 'tools' && part.steps.some((item) => item.id === event.id))) {
    return {
      ...message,
      parts: message.parts.map((part) => (part.type !== 'tools' ? part : {
        ...part, steps: part.steps.map((item) => (item.id === event.id ? { ...step, input: step.input ?? item.input } : item)),
      })),
    };
  }
  const last = message.parts.at(-1);
  if (last?.type === 'tools') return { ...message, parts: [...message.parts.slice(0, -1), { ...last, steps: [...last.steps, step] }] };
  return { ...message, parts: [...message.parts, { type: 'tools', key, steps: [step] }] };
}

function withThinking(message: ChatMessage, delta: string, key: string): ChatMessage {
  const last = message.parts.at(-1);
  if (last?.type === 'thinking') return { ...message, parts: [...message.parts.slice(0, -1), { ...last, text: last.text + delta }] };
  return { ...message, parts: [...message.parts, { type: 'thinking', key, text: delta }] };
}

function withText(message: ChatMessage, delta: string, key: string): ChatMessage {
  const last = message.parts.at(-1);
  if (last?.type === 'text') return { ...message, parts: [...message.parts.slice(0, -1), { ...last, text: last.text + delta }] };
  return { ...message, parts: [...message.parts, { type: 'text', key, text: delta }] };
}

/** The reply's last text, written ahead of a tool call, filed as thinking: the stream's `aside` event. */
function withAside(message: ChatMessage): ChatMessage {
  const last = message.parts.at(-1);
  if (last?.type !== 'text') return message;
  return { ...message, parts: [...message.parts.slice(0, -1), { type: 'thinking', key: last.key, text: last.text }] };
}

/** Whether anything but its thinking summary arrived: a reply with only that is nothing the person would keep. */
function hasContent(message: ChatMessage): boolean {
  return message.parts.some((part) => part.type !== 'thinking');
}

function blankMessage(key: string, role: ChatMessage['role']): ChatMessage {
  return {
    key, role, parts: [], state: 'complete', note: null, nodeId: null, parentId: null, feedback: null, ratingError: null, next: null, request: null,
    startedAt: null, endedAt: null, at: null, attachments: [], sources: [],
  };
}

/** A turn's new pair: the person's message under the node the request names, and the reply that streams. */
function turnPair(
  action: { content: string; attachments: MessageAttachment[]; userKey: string; replyKey: string; request: TurnRequest }, now: number,
): ChatMessage[] {
  const parentId = 'parentId' in action.request ? action.request.parentId ?? null : null;
  return [
    {
      ...blankMessage(action.userKey, 'user'), parentId, at: now, attachments: action.attachments,
      parts: [{ type: 'text', key: `${action.userKey}t`, text: action.content }],
    },
    { ...blankMessage(action.replyKey, 'assistant'), state: 'streaming', request: action.request, startedAt: now },
  ];
}

function shownState(state: TuningChatState, shown: ShownPath): TuningChatState {
  return { ...state, messages: shown.messages, tree: shown.tree, leafId: shown.leafId };
}

/**
 * The path read again after a turn (`reread`): a message already on the page keeps its key, and each part the key of
 * the part of the same type in its place, so the page keeps drawing it rather than drawing it anew (owner request,
 * 2026-11-17: the reply's "Worked for" never flashes). A message is the same by its node, or, for the reply that
 * streamed, by the node its turn named.
 */
function keptKeys(state: TuningChatState, shown: ShownPath): ShownPath {
  const nodeOf = (message: ChatMessage): string | null => message.nodeId ?? (message.state === 'streaming' ? state.turn?.nodes?.reply ?? null : null);
  return {
    ...shown,
    messages: shown.messages.map((message) => {
      const was = message.nodeId === null ? undefined : state.messages.find((item) => nodeOf(item) === message.nodeId);
      if (was === undefined) return message;
      return {
        ...message, key: was.key,
        parts: message.parts.map((part, index) => {
          const before = was.parts[index];
          return before?.type === part.type ? { ...part, key: before.key } : part;
        }),
      };
    }),
  };
}

/** `now` (ms since the epoch) stamps when a reply starts and ends. */
export function chatReducer(state: TuningChatState, action: ChatAction, now: number): TuningChatState {
  switch (action.type) {
    case 'load':
      return { ...initialChatState(), draft: state.draft };
    case 'loaded':
      return {
        ...state, status: 'ready', loadError: null, enabled: action.summary.enabled,
        budget: action.summary.budget, conversations: action.summary.conversations,
      };
    case 'loadFailed':
      return { ...state, status: action.notFound ? 'not_found' : 'failed', loadError: action.error };
    case 'summary': {
      // The notice stays only while the list still shows that conversation's turn running.
      const still = state.runningElsewhere !== null && runningIn(action.summary) === state.runningElsewhere;
      return {
        ...state, enabled: action.summary.enabled, budget: action.summary.budget, conversations: action.summary.conversations,
        runningElsewhere: still ? state.runningElsewhere : null,
      };
    }
    case 'held': {
      const id = action.summary === null ? null : runningIn(action.summary);
      const listed = action.summary === null ? {} : {
        enabled: action.summary.enabled, budget: action.summary.budget, conversations: action.summary.conversations,
      };
      return id === null ? { ...state, ...listed, error: action.error } : { ...state, ...listed, error: null, runningElsewhere: id };
    }
    case 'draft':
      return { ...state, draft: action.text };
    // Leaving a conversation whose reply streams only stops following it (useTuningChat letGo): the turn runs on, so
    // the list marks it running (the new chat page's Previous chats, History's Replying) until a read of it says not.
    case 'new':
      return {
        ...state, conversations: leftRunning(state, null), conversationId: null, conversationLoading: false, messages: [], tree: [], leafId: null, switching: false, error: null,
        draft: action.draft, streaming: false, turn: null, runningElsewhere: null,
      };
    case 'open':
      return {
        ...state, conversations: leftRunning(state, action.id), conversationId: action.id, conversationLoading: true, messages: [], tree: [], leafId: null, switching: false, error: null,
        draft: action.draft, streaming: false, turn: null, runningElsewhere: null,
      };
    case 'opened':
      if (state.conversationId !== action.id) return state;
      return { ...shownState(state, keptKeys(state, action.shown)), conversationLoading: false };
    case 'openFailed':
      if (state.conversationId !== action.id) return state;
      return { ...state, conversationLoading: false, error: action.error };
    case 'send':
      return {
        ...state, error: null, streaming: true, runningElsewhere: null,
        draft: state.draft.trim() === action.content ? '' : state.draft,
        turn: { kind: 'send', nodes: null, earlier: null },
        messages: [...state.messages, ...turnPair(action, now)],
      };
    case 'edit': {
      // The edited message and everything after it go; the edit hangs under the edited message's parent.
      const at = state.messages.findIndex((message) => message.key === action.messageKey);
      if (at < 0) return state;
      return {
        ...state, error: null, streaming: true, runningElsewhere: null,
        leafId: 'parentId' in action.request ? action.request.parentId ?? null : null,
        turn: { kind: 'edit', nodes: null, earlier: null },
        messages: [...state.messages.slice(0, at), ...turnPair(action, now)],
      };
    }
    case 'regenerate': {
      const earlier = state.messages.at(-1);
      if (earlier?.key !== action.replyKey) return state;
      return {
        ...state, error: null, streaming: true, runningElsewhere: null, leafId: earlier.parentId,
        turn: { kind: 'regenerate', nodes: null, earlier: { message: earlier, leafId: state.leafId } },
        messages: [
          ...state.messages.slice(0, -1),
          { ...blankMessage(action.newKey, 'assistant'), state: 'streaming', parentId: earlier.parentId, request: action.request, startedAt: now },
        ],
      };
    }
    case 'event':
      return applyEvent(state, action.event, action.key, action.at, now);
    case 'ended': {
      const cut = state.messages.some((message) => message.state === 'streaming');
      if (cut && state.turn?.earlier) return { ...putBack(state, state.turn.earlier, REGENERATE_FAILED), streaming: false };
      return {
        ...state, streaming: false, turn: null,
        error: cut ? CUT_OFF : state.error,
        messages: endLive(state, { state: 'failed', note: NOT_SAVED }, now),
      };
    }
    case 'stopped':
      if (state.turn?.earlier) return { ...putBack(state, state.turn.earlier, REGENERATE_FAILED), streaming: false };
      return { ...state, streaming: false, turn: null, messages: endLive(state, { state: 'stopped', note: STOPPED }, now) };
    case 'failed': {
      const at = state.messages.findIndex((message) => message.state === 'streaming');
      const live = state.messages[at];
      // The reply already ended with `done` or `error`; a late connection error changes nothing.
      if (live === undefined) return { ...state, streaming: false, turn: null };
      const budget = action.exhausted && state.budget !== null ? { ...state.budget, exhausted: true } : state.budget;
      const base = { ...state, streaming: false, error: action.error, budget, turn: null };
      // A regenerate puts the earlier reply back: with the server's reason when it refused the turn outright.
      if (state.turn?.earlier) return putBack(base, state.turn.earlier, hasContent(live) ? REGENERATE_FAILED : action.error);
      // Nothing of the reply arrived (the server refused the turn, or the connection failed first): take the
      // turn back and return the text to the composer, unless something new was typed meanwhile. An edit was never
      // in the composer, so it stays in place, with Try again.
      if (!hasContent(live) && state.turn?.kind !== 'edit') {
        return {
          ...base,
          draft: state.draft === '' ? action.content : state.draft,
          messages: state.messages.filter((_, index) => index !== at && index !== at - 1),
        };
      }
      return { ...base, messages: endLive(state, { state: 'failed', note: NOT_SAVED }, now) };
    }
    case 'discard':
      // The server kept no conversation for this id: the next send starts a new one instead of getting a 404.
      return {
        ...state,
        conversationId: state.conversationId === action.id ? null : state.conversationId,
        conversations: state.conversations.filter((conversation) => conversation.id !== action.id),
      };
    case 'removed': {
      const open = state.conversationId === action.id;
      return {
        ...state,
        conversations: state.conversations.filter((conversation) => conversation.id !== action.id),
        ...(open ? {
          conversationId: null, conversationLoading: false, messages: [], tree: [], leafId: null, switching: false, error: null, draft: action.draft,
        } : {}),
      };
    }
    case 'drop': {
      // Try again: the failed reply and the message it answered go, and the message is sent again as a new turn.
      const at = state.messages.findIndex((message) => message.key === action.replyKey);
      return at < 0 ? state : { ...state, messages: state.messages.filter((_, index) => index !== at && index !== at - 1) };
    }
    case 'card':
      return {
        ...state,
        messages: state.messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) => (part.type === 'proposal' && part.card.id === action.cardId
            ? { ...part, card: { ...part.card, ...action.patch } }
            : part)),
        })),
      };
    case 'switch':
      return { ...state, switching: true, error: null };
    case 'switched':
      if (state.conversationId !== action.id) return state;
      return { ...shownState(state, action.shown), switching: false };
    case 'switchFailed':
      if (state.conversationId !== action.id) return state;
      return { ...state, switching: false, error: VERSION_FAILED };
    case 'rated':
      return {
        ...state,
        messages: state.messages.map((message) => (message.key === action.key ? { ...message, feedback: action.feedback, ratingError: action.error } : message)),
      };
    case 'renamed':
      return {
        ...state,
        conversations: state.conversations.map((conversation) => (conversation.id === action.id ? { ...conversation, title: action.title } : conversation)),
      };
    case 'reattach': {
      if (state.conversationId !== action.id) return state;
      const { live } = action;
      // As a send's pair (turnPair): the message has no node until the turn is saved; a regenerate's reply hangs under
      // the message it answers from the start.
      const asked = action.asked === null ? [] : [{ ...action.asked, nodeId: null, parentId: live.parentId }];
      const reply: ChatMessage = {
        ...blankMessage(action.replyKey, 'assistant'), state: 'streaming', parentId: live.message === null ? live.parentId : null,
        request: action.request, startedAt: live.startedAt,
      };
      return {
        ...shownState(state, action.shown), conversationLoading: false, streaming: true, error: null,
        turn: { kind: live.message === null ? 'regenerate' : 'send', nodes: { user: live.userNodeId, reply: live.replyNodeId, parentId: live.parentId }, earlier: null },
        messages: [...action.shown.messages, ...asked, reply],
      };
    }
    case 'stopFailed':
      return { ...state, error: action.error };
  }
}

/**
 * A saved turn's `done`: the live reply completes, the person's message and the reply take their node ids, the
 * nodes join the tree and the leaf moves. The reply has a node only when the server stored some of it (`leafId` is
 * then the reply's node); a reply with nothing in it leaves the person's message as the leaf.
 */
function savedTurn(state: TuningChatState, event: Extract<ChatEvent, { type: 'done' }>, complete: (message: ChatMessage) => ChatMessage): TuningChatState {
  const nodes = state.turn?.nodes ?? null;
  const at = state.messages.findIndex((message) => message.state === 'streaming');
  const replyNode = nodes !== null && nodes.reply !== null && event.leafId === nodes.reply ? nodes.reply : null;
  const replyParent = nodes === null ? null : nodes.user ?? nodes.parentId;
  const added: TreeNode[] = [];
  if (nodes?.user != null) added.push({ id: nodes.user, parentId: nodes.parentId, role: 'user' });
  if (replyNode !== null) added.push({ id: replyNode, parentId: replyParent, role: 'assistant' });
  return {
    ...state, turn: null, tree: withTurn(state.tree, added), leafId: event.leafId,
    messages: state.messages.map((message, index) => {
      if (index === at) return nodes === null ? complete(message) : { ...complete(message), nodeId: replyNode, parentId: replyParent };
      if (index === at - 1 && nodes?.user != null) return { ...message, nodeId: nodes.user, parentId: nodes.parentId };
      return message;
    }),
  };
}

function applyEvent(state: TuningChatState, event: ChatEvent, key: string, at: string, now: number): TuningChatState {
  switch (event.type) {
    case 'conversation': {
      const known = state.conversations.some((conversation) => conversation.id === event.id);
      return {
        ...state,
        conversationId: event.id,
        conversations: known ? state.conversations : [{ id: event.id, title: event.title, updatedAt: at, turnCount: 0, running: false }, ...state.conversations],
        turn: state.turn === null ? null : { ...state.turn, nodes: { user: event.userNodeId, reply: event.replyNodeId, parentId: event.parentId } },
      };
    }
    case 'text':
      return { ...state, messages: withLive(state, (message) => withText(message, event.delta, key)) };
    case 'thinking':
      return { ...state, messages: withLive(state, (message) => withThinking(message, event.delta, key)) };
    case 'aside':
      return { ...state, messages: withLive(state, withAside) };
    case 'tool':
      // propose_data_item's calls show as their item card once done, if the owner was shown one.
      if (event.name === ITEM_TOOL) {
        return event.state === 'done' && event.result?.shown === true
          ? { ...state, messages: withLive(state, (message) => withItem(message, { id: event.id, conversationId: state.conversationId, stored: 'pending' }, key)) }
          : state;
      }
      if (event.name === ORDER_CHANGE_TOOL || event.name === ORDER_RULE_TOOL || event.name === ORDER_SETUP_TOOL) {
        return event.state === 'done' && event.result?.shown === true
          ? { ...state, messages: withLive(state, (message) => withOrder(message, { id: event.id, conversationId: state.conversationId, stored: 'pending', ...(event.name === ORDER_SETUP_TOOL ? { setup: true as const } : {}) }, key)) }
          : state;
      }
      // propose_note, show_visual and suggest_next show as their card, visual and next questions.
      if (isHiddenTool(event.name)) return state;
      return { ...state, messages: withLive(state, (message) => withTool(message, event, key)) };
    case 'proposal': {
      const card: ProposalCard = { id: event.id, proposal: event.proposal, status: 'open', stored: 'pending', edited: false, gone: false, error: null };
      return { ...state, messages: withLive(state, (message) => ({ ...message, parts: [...message.parts, { type: 'proposal', key, card }] })) };
    }
    case 'visual':
      return { ...state, messages: withLive(state, (message) => ({ ...message, parts: [...message.parts, { type: 'visual', key, id: event.id, visual: event.visual }] })) };
    case 'suggestions':
      return { ...state, messages: withLive(state, (message) => ({ ...message, next: event.prompts })) };
    case 'done': {
      // The budget ran out during the turn: the reply stays, and the chat shows the budget used up, as the GET would.
      const budget = event.stopReason === 'budget' && state.budget !== null ? { ...state.budget, exhausted: true } : state.budget;
      const saved = SAVED_STOP_REASONS.includes(event.stopReason);
      if (!saved && state.turn?.earlier) return putBack({ ...state, budget }, state.turn.earlier, REGENERATE_FAILED);
      const complete = (message: ChatMessage): ChatMessage => settleCards({
        ...message, state: 'complete', note: doneNote(event.stopReason), endedAt: now, at: now, sources: event.sources,
      }, saved ? 'kept' : 'lost');
      if (saved) return savedTurn({ ...state, budget }, event, complete);
      return { ...state, budget, turn: null, messages: withLive(state, complete) };
    }
    case 'error':
      if (state.turn?.earlier) return putBack(state, state.turn.earlier, REGENERATE_FAILED);
      // Its words are the reply's own line, as a stopped reply's are.
      if (event.code === TURN_INTERRUPTED) return { ...state, turn: null, messages: endLive(state, { state: 'failed', note: INTERRUPTED }, now) };
      return { ...state, error: streamErrorText(event.code), turn: null, messages: endLive(state, { state: 'failed', note: NOT_SAVED }, now) };
    case 'stopped':
      // resumable-chat-turns: the turn stopped on the server, and saved nothing.
      if (state.turn?.earlier) return putBack(state, state.turn.earlier, REGENERATE_FAILED);
      return { ...state, turn: null, messages: endLive(state, { state: 'stopped', note: STOPPED }, now) };
  }
}

export interface TuningChat {
  state: TuningChatState;
  setDraft: (text: string) => void;
  /**
   * Sends the composer's text, with the files attached to it (D36). `returned` runs if the turn is taken back (it never
   * went, or the server refused it before anything arrived), so the page can put the files back with the text.
   */
  send: (attachments?: readonly MessageAttachment[], returned?: () => void) => void;
  /** Sends `text` as it is (an Ask suggestion). */
  ask: (text: string) => void;
  /**
   * Sends `text` as Ask does, for a question card's Something else… (spec P25). Try again under its reply sends it again
   * the same way, and `telling.ended` hears each try's end. A turn taken back never puts the text in the composer; the
   * card keeps it.
   */
  tell: (text: string, telling: Telling) => void;
  stop: () => void;
  /**
   * While a reply streams: stops it (it saves nothing, as Stop), then sends the composer's text after the leaf, with
   * its files, as `send` does.
   */
  stopAndSend: (attachments?: readonly MessageAttachment[], returned?: () => void) => void;
  newConversation: () => void;
  openConversation: (id: string) => void;
  /** Deletes a conversation; rejects with the API's error, for the confirm dialog. */
  deleteConversation: (id: string) => Promise<void>;
  /** Renames a conversation; rejects with the API's error, for the rename field. */
  rename: (conversationId: string, title: string) => Promise<void>;
  /** Save note, as shown. */
  save: (cardId: string) => void;
  /** Edit first's save: rejects with the API's error, for the note form. */
  saveEdited: (cardId: string, note: NoteProposal) => Promise<void>;
  /** A proposal card's Edit first. */
  edit: (cardId: string) => void;
  cancelEdit: (cardId: string) => void;
  /** Not now. */
  dismiss: (cardId: string) => void;
  /** "Show the note" on a card set aside. */
  reopen: (cardId: string) => void;
  /**
   * Edits a saved message of the person's: it and everything after it leave the page, and the edit is sent under the
   * message's parent, as a second version of it.
   */
  editMessage: (messageKey: string, content: string) => void;
  /** The newest reply again: a second version of it, streamed in its place. If that one isn't saved, the first comes back. */
  regenerate: (replyKey: string) => void;
  /** Shows the version of a message or reply one step before (-1) or after (1) it, and the path through it. */
  showVersion: (messageKey: string, step: -1 | 1) => void;
  /** Rates a reply (null clears it); shown at once, and back as it was with `ratingError` if it doesn't save. */
  rate: (replyKey: string, rating: 'up' | 'down' | null, reason?: FeedbackReason | null) => void;
  /** Try again under a failed or stopped reply: sends its message again as a new turn. */
  retry: (replyKey: string) => void;
  /** An item card's own GET; rejects with the API's error. Stable across renders. */
  loadItem: (card: ItemCard) => Promise<ItemProposal>;
  /** Keep on Your data; rejects with the API's error. */
  keepItem: (card: ItemCard) => Promise<ItemProposal>;
  /** Not now; rejects with the API's error. */
  setItemAside: (card: ItemCard) => Promise<ItemProposal>;
  /** Reads the page again after it failed to load. */
  reload: () => void;
  /**
   * Whether the page watches the list (History open, or the new chat page in view): while it does and a conversation
   * is replying, the list is read every 3 seconds.
   */
  watchList: (open: boolean) => void;
}

/** How a question card's message goes (TuningChat.tell). */
export interface Telling {
  /** Its turn started: the first event arrived (not on a Try again). */
  started?: () => void;
  /** A try ended: null once its turn is saved (`done` with a saved stop reason), else the chat's own words for why not. */
  ended: (failure: string | null) => void;
}

export interface TuningChatOptions {
  /** The signed-in person (the staff member during view-as): drafts are kept per person. */
  userId: string;
  /** View-as (spec 15.5): a version switch reads the other version instead of storing it as the one shown. */
  readOnly: boolean;
  /** Runs after each note a card saves, so the page can mark the location's notes count stale. */
  onNoteAdded?: () => void;
  /** The view-as target's user id (spec 15.5), else null: the conversation the page closed on is kept per target. */
  viewAsId?: string | null;
  /** Where that is kept (lastChat.ts); the platform's own store by default. */
  lastChat?: LastChatStore;
}

export function canSend(state: TuningChatState): boolean {
  return canStart(state) && state.draft.trim() !== '';
}

function canStart(state: TuningChatState): boolean {
  return state.status === 'ready' && state.enabled && state.budget?.exhausted !== true && !state.streaming && !state.conversationLoading && !state.switching;
}

/** An item card's route ids; rejects for a card no conversation holds (nothing was kept for it). */
function itemIds(card: ItemCard): { conversationId: string; proposalId: string } {
  if (card.conversationId === null) throw new Error('This card is in no saved conversation');
  return { conversationId: card.conversationId, proposalId: card.id };
}

function cardOf(state: TuningChatState, cardId: string): ProposalCard | undefined {
  for (const message of state.messages) {
    for (const part of message.parts) if (part.type === 'proposal' && part.card.id === cardId) return part.card;
  }
  return undefined;
}

/**
 * The turn the page follows, from Send (or opening a conversation with a live turn) until it ends
 * (resumable-chat-turns).
 */
interface TurnHandle {
  /** Aborted only when the page lets go of the turn (it unmounts or reloads): the turn runs on, on the server. */
  controller: AbortController;
  /** The open stream's own: a wake closes it, so it is read again from `cursor`. */
  connection: AbortController | null;
  conversationId: string | null;
  /** From its `conversation` event; until then the turn can be neither read back nor stopped. */
  turnId: string | null;
  /** The number of the last event read: a stream read again starts after it, so nothing shows twice. */
  cursor: number;
  /** Its last event arrived. */
  ended: boolean;
  /** It ended with a saved `done`. */
  saved: boolean;
  /** Stop was pressed; the request goes once the turn id is known. */
  stopping: boolean;
  /** Ends the wait before the stream is read again. */
  wake: (() => void) | null;
  /** The person left its conversation (New chat, another one opened): the page stopped following it; it runs on. */
  left: boolean;
}

function handleFor(conversationId: string | null): TurnHandle {
  return {
    controller: new AbortController(), connection: null, conversationId, turnId: null, cursor: 0, ended: false, saved: false, stopping: false,
    wake: null, left: false,
  };
}

/** A new connection for the turn's stream, closed with the turn's own controller too. */
function connect(handle: TurnHandle): AbortSignal {
  const connection = new AbortController();
  handle.connection = connection;
  const { signal } = handle.controller;
  if (signal.aborted) connection.abort();
  else signal.addEventListener('abort', () => { connection.abort(); }, { once: true });
  return connection.signal;
}

/** Waits `ms` before a stream is read again; a wake ends it early, and the page letting go of the turn rejects it. */
function rest(handle: TurnHandle, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const { signal } = handle.controller;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stopped);
      handle.wake = null;
    };
    const stopped = (): void => {
      done();
      reject(new ApiError('aborted', 'The request was stopped.'));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    handle.wake = () => {
      done();
      resolve();
    };
    if (signal.aborted) stopped();
    else signal.addEventListener('abort', stopped, { once: true });
  });
}

/** A stream closed by the page itself: a wake (the turn's own controller is checked first). */
function woken(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'aborted';
}

/** A send's stream lost on the way (not the server's refusal, not the page's own stop): the turn may run all the same. */
function lostOnTheWay(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout');
}

/** Whether a conversation's live turn is the one `request` sent: its message, or for a regenerate the message it answers. */
function isTurnOf(turn: LiveTurnLoad, request: TurnRequest): boolean {
  if ('replyTo' in request) return turn.message === null && turn.parentId === request.replyTo;
  return turn.message !== null && turn.message.text === request.content;
}

function isClaimHeld(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.code === 'chat_turn_in_progress';
}

/** Waits `ms`; a stop meanwhile ends the wait as a stopped request. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = (): void => {
      clearTimeout(timer);
      reject(new ApiError('aborted', 'The request was stopped.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stopped);
      resolve();
    }, ms);
    if (signal.aborted) stopped();
    else signal.addEventListener('abort', stopped, { once: true });
  });
}

export function useTuningChat(api: ApiClient, locationId: string, options: TuningChatOptions): TuningChat {
  const { userId, readOnly, onNoteAdded } = options;
  const store = options.lastChat ?? lastChatStore;
  const returnKey = lastChatKey(userId, locationId, options.viewAsId ?? null);
  const [state, setState] = useState(() => ({ ...initialChatState(), draft: readDraft(draftKey(userId, locationId, null)) }));
  const [generation, setGeneration] = useState(0);
  // The state after the last action, ahead of the render that draws it: a send that follows a stop builds on it.
  const latest = useRef(state);
  const live = useRef<TurnHandle | null>(null);
  // The live turn's end, for Stop and send; and the send waiting for it.
  const turnEnd = useRef<Promise<void> | null>(null);
  const waiting = useRef<{ content: string; returned: (() => void) | undefined } | null>(null);
  const opening = useRef(0);
  const acting = useRef(new Set<string>());
  const ratings = useRef(new Map<string, number>());
  // A question card's turns, by reply key: Try again under one tells the card how it ended, as its first try did.
  const told = useRef(new Map<string, Telling['ended']>());
  const keys = useRef(0);
  // The text (or thinking summary) that arrived since the last draw, and the timer that draws it.
  const buffer = useRef<{ text: string; kind: 'text' | 'thinking'; timer: ReturnType<typeof setTimeout> | null }>({ text: '', kind: 'text', timer: null });

  const dispatch = useCallback((action: ChatAction): void => {
    const before = latest.current;
    const after = chatReducer(before, action, Date.now());
    latest.current = after;
    setState(after);
    // The composer's text is kept under the open conversation's key (drafts.ts). Opening, starting a new one or
    // deleting the open one read the draft kept for where they lead; a new conversation's first turn moves it to the
    // id the server gave, and a turn that left no conversation moves it back.
    if (after.conversationId !== before.conversationId && action.type !== 'open' && action.type !== 'new') {
      writeDraft(draftKey(userId, locationId, before.conversationId), '');
    }
    if (after.draft !== before.draft || after.conversationId !== before.conversationId) {
      writeDraft(draftKey(userId, locationId, after.conversationId), after.draft);
    }
  }, [userId, locationId]);

  function draftFor(conversationId: string | null): string {
    return readDraft(draftKey(userId, locationId, conversationId));
  }

  function nextKey(): string {
    keys.current += 1;
    return `m${String(keys.current)}`;
  }

  function flush(): void {
    const pending = buffer.current;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.text === '') return;
    const delta = pending.text;
    pending.text = '';
    dispatch({ type: 'event', event: { type: pending.kind, delta }, key: nextKey(), at: '' });
  }

  // The newest render's openConversation, for the load below: the conversation the page closed on, or a turn still
  // live here, opens.
  const reopen = useRef<(id: string, recalled: boolean) => void>(() => undefined);
  useEffect(() => {
    reopen.current = openConversation;
  });

  useEffect(() => {
    let cancelled = false;
    // The conversation the page closed on within 5 minutes, read beside the list (a store that fails is nothing kept).
    void Promise.all([loadChat(api, locationId), recallChat(store, returnKey, Date.now()).catch(() => null)]).then(
      ([summary, recalled]) => {
        if (cancelled) return;
        dispatch({ type: 'loaded', summary });
        // Back within 5 minutes: that conversation, reattached if its turn is live. Else a refresh mid-reply, or a
        // second tab: the turn's conversation opens and its reply is followed.
        if (recalled !== null) reopen.current(recalled, true);
        else if (summary.liveTurn !== null) reopen.current(summary.liveTurn.conversationId, false);
      },
      (error: unknown) => { if (!cancelled) dispatch({ type: 'loadFailed', notFound: isStatus(error, 404), error: describeError(error) }); },
    );
    const pending = buffer.current;
    return () => {
      cancelled = true;
      waiting.current = null;
      live.current?.controller.abort();
      live.current = null;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      pending.text = '';
    };
  }, [api, locationId, generation, dispatch, store, returnKey]);

  // The page closing (its unmount, or on web the tab closing or reloading) keeps the conversation it shows, or forgets
  // the one kept when it shows a new chat; a page that never loaded changes nothing.
  useEffect(() => {
    const leave = (): void => {
      const now = latest.current;
      if (now.status === 'ready') void rememberChat(store, returnKey, now.conversationId, Date.now());
    };
    const stopListening = onPageLeave(leave);
    return () => {
      stopListening();
      leave();
    };
  }, [store, returnKey]);

  // A wake reads a dropped stream again at once, and closes an open one to read it again from its cursor (it may be
  // dead after the app or tab was suspended). A turn without its id yet is left alone: it can't be read back.
  useEffect(() => onWake(() => {
    const handle = live.current;
    if (handle === null || handle.ended || handle.turnId === null) return;
    if (handle.wake !== null) handle.wake();
    else handle.connection?.abort();
  }), []);

  function refresh(): void {
    void loadChat(api, locationId).then((summary) => { dispatch({ type: 'summary', summary }); }, () => undefined);
  }

  // The list is read every 3 seconds while a send waits on a turn running in another chat, or while the page watches
  // it (History open, or the new chat page in view, for its Previous chats) with a conversation replying, until the
  // list shows none; nothing is read while nothing runs.
  const [watching, setWatching] = useState(false);
  const polling = state.runningElsewhere !== null || (watching && state.conversations.some((conversation) => conversation.running));
  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => {
      void loadChat(api, locationId).then((summary) => { dispatch({ type: 'summary', summary }); }, () => undefined);
    }, LIST_POLL_MS);
    return () => { clearInterval(timer); };
  }, [api, locationId, dispatch, polling]);

  /** A send refused because the person's running turn holds the claim: the list says which chat it is in. */
  function held(error: string): void {
    void loadChat(api, locationId).then(
      (summary) => { dispatch({ type: 'held', summary, error }); },
      () => { dispatch({ type: 'held', summary: null, error }); },
    );
  }

  /**
   * The person leaves the conversation whose turn the page follows (New chat, or another conversation opened): the
   * page stops following it and draws nothing more of it; the turn runs on, and is saved, on the server (D45). A send
   * waiting on it (Stop and send) is taken back.
   */
  function letGo(): void {
    const handle = live.current;
    if (handle === null) return;
    handle.left = true;
    live.current = null;
    turnEnd.current = null;
    waiting.current?.returned?.();
    waiting.current = null;
    handle.controller.abort();
    const pending = buffer.current;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.text = '';
  }

  /** The turn's stream; with `retries`, a 409 `chat_turn_in_progress` is tried again after a pause. */
  async function stream(request: TurnRequest, signal: AbortSignal, onEvent: TurnListener, retries: number): Promise<void> {
    try {
      await sendTurn(api, locationId, request, signal, onEvent);
    } catch (error: unknown) {
      if (retries === 0 || !isClaimHeld(error)) throw error;
      await pause(CLAIM_RETRY_MS, signal);
      await stream(request, signal, onEvent, retries - 1);
    }
  }

  /**
   * A turn's events, into the reducer: each one once (by its number), text and thinking drawn in batches. `seen` hears
   * each event first.
   */
  function listener(handle: TurnHandle, seen: (event: ChatEvent) => void): TurnListener {
    return (event, seq) => {
      if (handle.controller.signal.aborted) return;
      if (seq !== null) {
        if (seq <= handle.cursor) return;
        handle.cursor = seq;
      }
      seen(event);
      if (event.type === 'conversation') {
        handle.conversationId = event.id;
        if (event.turnId !== null) handle.turnId = event.turnId;
        if (handle.stopping) askToStop(handle);
      }
      if (event.type === 'done' && SAVED_STOP_REASONS.includes(event.stopReason)) handle.saved = true;
      if (endsTurn(event)) handle.ended = true;
      if (event.type === 'text' || event.type === 'thinking') {
        // Text and thinking keep their order: a change from one to the other draws what the first had gathered.
        if (buffer.current.kind !== event.type) flush();
        buffer.current.kind = event.type;
        buffer.current.text += event.delta;
        buffer.current.timer ??= setTimeout(flush, FLUSH_MS);
        return;
      }
      // Any other event draws the text before it first, so the parts keep their order.
      flush();
      dispatch({ type: 'event', event, key: nextKey(), at: new Date().toISOString() });
    };
  }

  /**
   * Reads a turn's events after its cursor until its last one. `dropped`: its stream just dropped, so the first read
   * waits too. Each read after a drop waits the RESUME_MS waits (cut short by a wake), and first checks that the
   * conversation still shows the turn live; a read after a wake closed the stream, or after one that brought something
   * (it ends on its own after 200 seconds), goes at once. Resolves true once the turn's last event arrived, false once
   * the turn is no longer live (its read answers 404, or the conversation shows no live turn of it); rejects when the
   * page lets go of it.
   */
  async function follow(handle: TurnHandle, ids: { conversationId: string; turnId: string }, onEvent: TurnListener, dropped: boolean): Promise<boolean> {
    let tries = 0;
    let wait = dropped;
    for (;;) {
      if (wait) {
        if (!(await stillLive(ids))) return false;
        await rest(handle, RESUME_MS[Math.min(tries, RESUME_MS.length - 1)] ?? 0);
        tries += 1;
      }
      wait = true;
      const before = handle.cursor;
      try {
        await followTurn(api, locationId, ids, handle.cursor, connect(handle), onEvent);
        if (handle.ended) return true;
        if (handle.cursor > before) {
          tries = 0;
          wait = false;
        }
      } catch (error: unknown) {
        if (handle.controller.signal.aborted) throw error;
        if (handle.ended) return true;
        if (isStatus(error, 404)) return false;
        // A wake closed it.
        if (woken(error)) {
          tries = 0;
          wait = false;
        }
      } finally {
        handle.connection = null;
      }
    }
  }

  /** Whether the conversation still shows the turn as live; a read that fails is no answer, so it may be. */
  async function stillLive(ids: { conversationId: string; turnId: string }): Promise<boolean> {
    try {
      return (await loadConversation(api, locationId, ids.conversationId)).liveTurn?.turnId === ids.turnId;
    } catch (error: unknown) {
      return !isStatus(error, 404);
    }
  }

  /**
   * After a turn this page followed without sending it, or one whose end it never saw: the conversation as the server
   * keeps it now. A turn that ended without saving stays as its stream left it, as in the tab that sent it. Answers
   * whether the conversation is there; one the server no longer has is let go, so the next send starts a new one.
   */
  async function reread(handle: TurnHandle): Promise<boolean> {
    flush();
    const id = handle.conversationId;
    if (id === null) return false;
    try {
      const load = await loadConversation(api, locationId, id);
      if (!handle.ended || handle.saved) dispatch({ type: 'opened', id, shown: shownOf(load, id) });
      return true;
    } catch (error: unknown) {
      if (!isStatus(error, 404)) return true;
      dispatch({ type: 'discard', id });
      return false;
    }
  }

  /**
   * After a send's stream was lost before its `conversation` event: the turn the server is running for it, if the
   * request reached the server. A new conversation's turn is found from the chat's GET; either way the conversation's
   * GET must show it running with this send's message. Any read that fails is no turn.
   */
  async function sentTurn(request: TurnRequest): Promise<{ conversationId: string; turnId: string } | null> {
    try {
      const conversationId = request.conversationId ?? (await loadChat(api, locationId)).liveTurn?.conversationId;
      if (conversationId === undefined) return null;
      const turn = (await loadConversation(api, locationId, conversationId)).liveTurn;
      return turn?.state === 'running' && isTurnOf(turn, request) ? { conversationId, turnId: turn.turnId } : null;
    } catch {
      return null;
    }
  }

  /** Stop: the server stops the turn and every stream of it ends with `stopped`; a turn without its id yet waits for it. */
  function askToStop(handle: TurnHandle): void {
    const { conversationId, turnId } = handle;
    if (conversationId === null || turnId === null || handle.ended) return;
    void stopTurn(api, locationId, { conversationId, turnId }).then(() => undefined, (error: unknown) => {
      // A turn that is gone (404) ended already; its stream says how.
      if (handle.ended || live.current !== handle || isStatus(error, 404)) return;
      handle.stopping = false;
      dispatch({ type: 'stopFailed', error: STOP_FAILED });
    });
  }

  function stop(): void {
    const handle = live.current;
    if (handle === null || handle.ended || handle.stopping) return;
    handle.stopping = true;
    askToStop(handle);
  }

  /**
   * Streams a turn: `action` puts it on the page, `request` goes to the server. `telling`, for a question card, hears
   * when it starts and how it ended; `returned`, for the composer's files, runs if a send is taken back.
   */
  function run(
    action: Extract<ChatAction, { type: 'send' | 'edit' | 'regenerate' }>, request: TurnRequest, retries = 0, telling?: Telling, returned?: () => void,
  ): void {
    const attached = 'attachments' in request && request.attachments.length > 0;
    const handle = handleFor(request.conversationId);
    live.current = handle;
    dispatch(action);
    // A first turn that saved nothing (an error, Stop, a cut-off stream or a refusal) left no conversation behind.
    let created: string | null = null;
    let saved = false;
    let started = false;
    // The conversation read again after a turn whose end this page never saw is still there.
    let found = false;
    // Why it saved nothing, in the words the chat shows for it.
    let failure: string | null = null;
    // The server refused it because the person's one running turn holds the claim (409 chat_turn_in_progress): its words.
    let claimHeld: string | null = null;
    const onEvent = listener(handle, (event) => {
      if (!started) {
        started = true;
        telling?.started?.();
      }
      if (event.type === 'conversation') created = event.id;
      if (event.type === 'done' && SAVED_STOP_REASONS.includes(event.stopReason)) saved = true;
      else if (event.type === 'done') failure = doneNote(event.stopReason) ?? NOT_SAVED;
      if (event.type === 'error') failure = event.code === TURN_INTERRUPTED ? INTERRUPTED : streamErrorText(event.code);
      if (event.type === 'stopped') failure = STOPPED;
    });
    // A stream lost before the turn's `conversation` event may still have started the turn on the server: if the server
    // runs it for this send, it is followed from its first event; if not, the send failed as before.
    const recovered = async (): Promise<boolean> => {
      if (created !== null || handle.ended || handle.controller.signal.aborted) return false;
      const ids = await sentTurn(request);
      if (ids === null) return false;
      handle.conversationId = ids.conversationId;
      handle.turnId = ids.turnId;
      return true;
    };
    const follows = async (): Promise<void> => {
      // A stream that closed without the turn's last event dropped, unless a wake closed it.
      let dropped = true;
      try {
        await stream(request, connect(handle), onEvent, retries);
        if (handle.turnId === null && (await recovered())) dropped = false;
      } catch (error: unknown) {
        // Once the turn has its id, a dropped (or woken) stream is read back from its last number; before that, the
        // failure is the turn's, unless the server is running it all the same.
        if (!handle.ended && (handle.turnId === null || handle.controller.signal.aborted)) {
          if (!lostOnTheWay(error) || !(await recovered())) throw error;
          dropped = false;
        } else {
          dropped = !woken(error);
        }
      } finally {
        handle.connection = null;
      }
      const { conversationId, turnId } = handle;
      if (handle.ended || conversationId === null || turnId === null) return;
      if (!(await follow(handle, { conversationId, turnId }, onEvent, dropped))) found = await reread(handle);
    };
    turnEnd.current = follows().then(
      () => {
        if (handle.left) return;
        flush();
        dispatch({ type: 'ended' });
        failure ??= CUT_OFF;
      },
      (error: unknown) => {
        // The person left the conversation: nothing of the turn is drawn.
        if (handle.left) return;
        flush();
        if (error instanceof ApiError && error.kind === 'aborted') {
          dispatch({ type: 'stopped' });
          failure ??= STOPPED;
          return;
        }
        const exhausted = error instanceof ApiError && error.code === 'chat_budget_exhausted';
        failure ??= exhausted ? TELL_BUDGET : sendErrorText(error, attached);
        // A card's words stay in the card, never in the composer.
        const content = telling === undefined && 'content' in request ? request.content : '';
        const draftBefore = latest.current.draft;
        // The person's running turn is in another chat: the list read next says which, in place of the error.
        if (isClaimHeld(error)) claimHeld = sendErrorText(error, attached);
        dispatch({ type: 'failed', error: exhausted || claimHeld !== null ? null : sendErrorText(error, attached), content, exhausted });
        // The turn was taken back (its message left the page) and its text went back to the composer, so its files go
        // back with it. Text typed meanwhile stays, and so do the composer's files as the person left them.
        const takenBack = action.type === 'send' && !latest.current.messages.some((message) => message.key === action.userKey);
        if (takenBack && draftBefore === '' && content !== '') returned?.();
      },
    ).finally(() => {
      if (live.current === handle) live.current = null;
      // A turn the person left runs on: its conversation stays in the list.
      if (!handle.left && request.conversationId === null && created !== null && !saved && !found) dispatch({ type: 'discard', id: created });
      // The list, the budget and the off switch may all have changed with this turn.
      if (claimHeld === null) refresh();
      else held(claimHeld);
      // A card whose conversation the person left hears so: its answer waits for a reply the page no longer follows.
      telling?.ended(saved ? null : handle.left ? TELL_LEFT : failure ?? NOT_SAVED);
    });
  }

  /**
   * Follows a turn live in a conversation just opened (a refresh mid-reply, a second tab): the person's message and the
   * reply from its first event, through the same reducer, then the conversation read again.
   */
  function reattach(id: string, load: ConversationLoad, turn: LiveTurnLoad): void {
    const handle = handleFor(id);
    handle.turnId = turn.turnId;
    live.current = handle;
    const asked = turn.message === null ? null : toMessage(turn.message, load.tree, undefined, id);
    // What Try again sends, if the turn doesn't save.
    let request: TurnRequest | null = null;
    if (turn.message !== null) request = { conversationId: id, content: turn.message.text, parentId: turn.parentId };
    else if (turn.parentId !== null) request = { conversationId: id, replyTo: turn.parentId };
    dispatch({ type: 'reattach', id, shown: shownOf(load, id), asked, replyKey: nextKey(), request, live: turn });
    const onEvent = listener(handle, () => undefined);
    turnEnd.current = follow(handle, { conversationId: id, turnId: turn.turnId }, onEvent, false).then(() => reread(handle)).then(
      () => {
        if (handle.left) return;
        flush();
        dispatch({ type: 'ended' });
      },
      // The page let go of it.
      () => { flush(); },
    ).finally(() => {
      if (live.current === handle) live.current = null;
      refresh();
    });
  }

  /**
   * A message after the path shown: a new conversation's first one names neither a conversation nor a parent. With no
   * tree known (the conversation didn't open, or the server keeps none) it names no parent, so the server adds it after
   * the leaf it has stored; a null parent would start a second first message. `attachments` go with it (D36); if it
   * can't go, `returned` runs at once.
   */
  function start(content: string, retries = 0, telling?: Telling, attachments: readonly MessageAttachment[] = [], returned?: () => void): void {
    const current = latest.current;
    if (content === '' || !canStart(current) || live.current !== null) {
      telling?.ended(current.budget?.exhausted === true ? TELL_BUDGET : TELL_WAIT);
      returned?.();
      return;
    }
    const refs = attachments.map((attachment) => attachment.ref);
    let request: TurnRequest = { conversationId: null, content };
    if (current.conversationId !== null) {
      request = current.tree.length === 0
        ? { conversationId: current.conversationId, content }
        : { conversationId: current.conversationId, content, parentId: current.leafId };
    }
    if (refs.length > 0) request = { ...request, attachments: refs };
    const userKey = nextKey();
    const replyKey = nextKey();
    if (telling !== undefined) told.current.set(replyKey, telling.ended);
    run({ type: 'send', content, attachments: [...attachments], userKey, replyKey, request }, request, retries, telling, returned);
  }

  /** `recalled`: the conversation the page closed on; one the server no longer has opens a new chat instead. */
  function openConversation(id: string, recalled = false): void {
    // The conversation whose reply the page follows is open already.
    if (live.current !== null && latest.current.conversationId === id) return;
    const leaving = live.current !== null;
    letGo();
    opening.current += 1;
    const token = opening.current;
    dispatch({ type: 'open', id, draft: draftFor(id) });
    void loadConversation(api, locationId, id).then(
      (load) => {
        if (token !== opening.current) return;
        if (load.liveTurn !== null && live.current === null) reattach(id, load, load.liveTurn);
        else dispatch({ type: 'opened', id, shown: shownOf(load, id) });
      },
      (error: unknown) => {
        if (token !== opening.current) return;
        if (recalled && isStatus(error, 404)) {
          void forgetChat(store, returnKey);
          opening.current += 1;
          dispatch({ type: 'new', draft: draftFor(null) });
          return;
        }
        dispatch({ type: 'openFailed', id, error: describeError(error) });
      },
    );
    // The list shows the conversation left as it is now.
    if (leaving) refresh();
  }

  function shownOf(load: ConversationLoad, conversationId: string): ShownPath {
    return {
      messages: load.messages.map((stored, index) => toMessage(stored, load.tree, load.messages[index - 1], conversationId)),
      tree: load.tree, leafId: load.activeLeafId,
    };
  }

  function toMessage(stored: StoredMessage, tree: readonly TreeNode[], asked: StoredMessage | undefined, conversationId: string): ChatMessage {
    const parentId = stored.nodeId === null ? null : tree.find((node) => node.id === stored.nodeId)?.parentId ?? null;
    const message: ChatMessage = {
      ...blankMessage(nextKey(), stored.role), nodeId: stored.nodeId, parentId, feedback: stored.feedback, next: stored.next,
      at: stored.role === 'user' ? stored.at : stored.endedAt, attachments: stored.role === 'user' ? stored.attachments : [],
      sources: stored.sources,
    };
    if (stored.role === 'assistant') {
      // Time worked runs from the person's message to the reply's end. Only a message's first reply can say so: a
      // later version (a regenerate) started after the message was sent, at a time that was not stored.
      const firstReply = parentId !== null && tree.find((node) => node.parentId === parentId && node.role === 'assistant')?.id === stored.nodeId;
      if (asked?.role === 'user' && asked.at !== null && stored.endedAt !== null && firstReply) {
        message.startedAt = asked.at;
        message.endedAt = stored.endedAt;
      }
    }
    if (stored.role === 'user' || stored.parts.length === 0) {
      message.parts = stored.text === '' ? [] : [{ type: 'text', key: nextKey(), text: stored.text }];
      return message;
    }
    for (const part of stored.parts) {
      const last = message.parts.at(-1);
      if (part.type === 'thinking') message.parts.push({ type: 'thinking', key: nextKey(), text: part.text });
      else if (part.type === 'text') message.parts.push({ type: 'text', key: nextKey(), text: part.text });
      else if (part.type === 'visual') message.parts.push({ type: 'visual', key: nextKey(), id: part.id, visual: part.visual });
      else if (part.type === 'tool') {
        // As while it streamed: a propose_data_item call the owner was shown is its item card.
        if (part.name === ITEM_TOOL) {
          if (part.state === 'done' && part.result?.shown === true) {
            message.parts.push({ type: 'item', key: nextKey(), card: { id: part.id, conversationId, stored: 'kept' } });
          }
          continue;
        }
        if (part.name === ORDER_CHANGE_TOOL || part.name === ORDER_RULE_TOOL || part.name === ORDER_SETUP_TOOL) {
          if (part.state === 'done' && part.result?.shown === true) {
            message.parts.push({ type: 'order', key: nextKey(), card: { id: part.id, conversationId, stored: 'kept', ...(part.name === ORDER_SETUP_TOOL ? { setup: true as const } : {}) } });
          }
          continue;
        }
        // As while it streamed: a hidden tool's call shows nothing (a propose_note call that got an error, say).
        if (isHiddenTool(part.name)) continue;
        const step: ToolStep = { id: part.id, name: part.name, state: part.state, input: part.input, result: part.result };
        if (last?.type === 'tools') last.steps.push(step);
        else message.parts.push({ type: 'tools', key: nextKey(), steps: [step] });
      } else {
        const { id, status, kind, startDate, endDate, weekdays, effect, expectedGuests, detail, title } = part.proposal;
        const proposal: NoteProposal = { kind, startDate, endDate, weekdays, effect, expectedGuests, detail, title };
        message.parts.push({
          type: 'proposal', key: nextKey(), card: { id, proposal, status, stored: 'kept', edited: false, gone: false, error: null },
        });
      }
    }
    return message;
  }

  function settled(cardId: string, result: ProposalResult): void {
    const saved = result.proposal.status === 'saved';
    dispatch({ type: 'card', cardId, patch: { status: result.proposal.status, edited: result.proposal.edited, error: null } });
    if (saved) onNoteAdded?.();
  }

  /** One write per card at a time. Resolves when it is done; `reject` passes the API's error on. */
  async function write(cardId: string, note: NoteProposal | undefined, rethrow: boolean): Promise<void> {
    const card = cardOf(latest.current, cardId);
    const conversationId = latest.current.conversationId;
    if (card === undefined || card.status === 'saved' || card.stored === 'pending' || card.gone || acting.current.has(cardId)) return;
    const back: CardStatus = card.status === 'editing' ? 'editing' : 'open';
    acting.current.add(cardId);
    dispatch({ type: 'card', cardId, patch: { status: 'saving', error: null } });
    try {
      if (card.stored === 'lost' || conversationId === null) {
        await postNote(api, locationId, note ?? card.proposal);
        dispatch({ type: 'card', cardId, patch: { status: 'saved', edited: note !== undefined, error: null } });
        onNoteAdded?.();
      } else {
        settled(cardId, await saveProposal(api, locationId, { conversationId, proposalId: cardId }, note));
      }
    } catch (error: unknown) {
      const gone = card.stored === 'kept' && isStatus(error, 404);
      dispatch({ type: 'card', cardId, patch: { status: back, gone, error: rethrow ? null : noteErrorText(error) } });
      if (rethrow) throw error;
    } finally {
      acting.current.delete(cardId);
    }
  }

  // An item card's calls, in the conversation the card is in.
  const loadItem = useCallback((card: ItemCard) => loadItemProposal(api, locationId, itemIds(card)), [api, locationId]);
  const keepItem = useCallback((card: ItemCard) => actOnItemProposal(api, locationId, itemIds(card), 'save'), [api, locationId]);
  const setItemAside = useCallback((card: ItemCard) => actOnItemProposal(api, locationId, itemIds(card), 'dismiss'), [api, locationId]);

  function dismiss(cardId: string): void {
    const card = cardOf(latest.current, cardId);
    const conversationId = latest.current.conversationId;
    if (card === undefined || card.status === 'saved' || card.status === 'saving' || card.stored === 'pending' || acting.current.has(cardId)) return;
    dispatch({ type: 'card', cardId, patch: { status: 'dismissed', error: null } });
    // A card the server never kept, or no longer has, is set aside here only.
    if (card.stored !== 'kept' || card.gone || conversationId === null) return;
    acting.current.add(cardId);
    void dismissProposal(api, locationId, { conversationId, proposalId: cardId }).then(
      (result) => { settled(cardId, result); },
      (error: unknown) => { dispatch({ type: 'card', cardId, patch: { status: 'open', gone: isStatus(error, 404), error: noteErrorText(error) } }); },
    ).finally(() => { acting.current.delete(cardId); });
  }

  function editMessage(messageKey: string, text: string): void {
    const current = latest.current;
    const content = text.trim();
    const message = current.messages.find((item) => item.key === messageKey);
    // Only a saved message of the person's, with something in it.
    if (content === '' || message?.role !== 'user' || message.nodeId === null || current.conversationId === null) return;
    if (!canStart(current) || live.current !== null) return;
    // The edit carries the message's files again (D36), but not one gone from Your data: the server would refuse it.
    const attachments = message.attachments.filter((attachment) => attachment.state !== 'gone');
    const refs = attachments.map((attachment) => attachment.ref);
    const request: TurnRequest = {
      conversationId: current.conversationId, content, parentId: message.parentId, ...(refs.length > 0 ? { attachments: refs } : {}),
    };
    run({ type: 'edit', messageKey, content, attachments, userKey: nextKey(), replyKey: nextKey(), request }, request);
  }

  function regenerate(replyKey: string): void {
    const current = latest.current;
    const reply = current.messages.at(-1);
    // The newest reply only, once its turn is saved: regenerating an older one would drop the path after it.
    if (reply?.key !== replyKey || reply.role !== 'assistant' || reply.state !== 'complete' || reply.parentId === null) return;
    if (current.conversationId === null || !canStart(current) || live.current !== null) return;
    const request: TurnRequest = { conversationId: current.conversationId, replyTo: reply.parentId };
    run({ type: 'regenerate', replyKey, newKey: nextKey(), request }, request);
  }

  function showVersion(messageKey: string, step: -1 | 1): void {
    const current = latest.current;
    const conversationId = current.conversationId;
    const nodeId = current.messages.find((item) => item.key === messageKey)?.nodeId ?? null;
    const sibling = nodeId === null ? null : siblingAt(current.tree, nodeId, step);
    if (sibling === null || conversationId === null || current.streaming || current.switching || current.conversationLoading) return;
    opening.current += 1;
    const token = opening.current;
    dispatch({ type: 'switch' });
    // Under view-as the version is only read (`?node=`); otherwise it is stored as the one shown.
    const read = readOnly ? loadConversation(api, locationId, conversationId, sibling) : setActiveVersion(api, locationId, conversationId, sibling);
    void read.then(
      (load) => { if (token === opening.current) dispatch({ type: 'switched', id: conversationId, shown: shownOf(load, conversationId) }); },
      () => { if (token === opening.current) dispatch({ type: 'switchFailed', id: conversationId }); },
    );
  }

  function rate(replyKey: string, rating: 'up' | 'down' | null, reason: FeedbackReason | null = null): void {
    const current = latest.current;
    const conversationId = current.conversationId;
    const reply = current.messages.find((item) => item.key === replyKey);
    if (reply?.role !== 'assistant' || reply.nodeId === null || conversationId === null) return;
    const feedback: Feedback | null = rating === null ? null : { rating, reason: rating === 'down' ? reason : null };
    const before = reply.feedback;
    // Only the newest press on a reply settles it.
    const press = (ratings.current.get(replyKey) ?? 0) + 1;
    ratings.current.set(replyKey, press);
    dispatch({ type: 'rated', key: replyKey, feedback, error: null });
    void rateReply(api, locationId, conversationId, reply.nodeId, rating, feedback?.reason ?? null).then(
      (stored) => { if (ratings.current.get(replyKey) === press) dispatch({ type: 'rated', key: replyKey, feedback: stored, error: null }); },
      () => { if (ratings.current.get(replyKey) === press) dispatch({ type: 'rated', key: replyKey, feedback: before, error: RATING_FAILED }); },
    );
  }

  function stopAndSend(attachments: readonly MessageAttachment[] = [], returned?: () => void): void {
    const content = latest.current.draft.trim();
    const ending = turnEnd.current;
    if (content === '') {
      returned?.();
      return;
    }
    if (live.current === null || ending === null) {
      start(content, 0, undefined, attachments, returned);
      return;
    }
    // The send waits for the stopped turn's last event, so it goes after the leaf as the stop left it. A second press
    // meanwhile takes its place, and the first one's files go back.
    const queued = { content, returned };
    waiting.current?.returned?.();
    waiting.current = queued;
    stop();
    void ending.then(() => {
      if (waiting.current !== queued) return;
      waiting.current = null;
      start(content, CLAIM_RETRIES, undefined, attachments, returned);
    });
  }

  return {
    state,
    setDraft: (text) => { dispatch({ type: 'draft', text }); },
    send: (attachments = [], returned) => { start(state.draft.trim(), 0, undefined, attachments, returned); },
    ask: (text) => { start(text.trim()); },
    tell: (text, telling) => { start(text.trim(), 0, telling); },
    stop,
    stopAndSend,
    newConversation: () => {
      const leaving = live.current !== null;
      // New chat forgets the conversation kept for coming back.
      void forgetChat(store, returnKey);
      letGo();
      opening.current += 1;
      dispatch({ type: 'new', draft: draftFor(null) });
      if (leaving) refresh();
    },
    openConversation: (id) => { openConversation(id); },
    deleteConversation: async (id) => {
      await removeConversation(api, locationId, id);
      if (latest.current.conversationId === id) opening.current += 1;
      dispatch({ type: 'removed', id, draft: draftFor(null) });
    },
    rename: async (conversationId, title) => {
      const renamed = await renameConversation(api, locationId, conversationId, title);
      dispatch({ type: 'renamed', id: renamed.id, title: renamed.title });
    },
    save: (cardId) => { void write(cardId, undefined, false); },
    saveEdited: (cardId, note) => write(cardId, note, true),
    edit: (cardId) => {
      const card = cardOf(state, cardId);
      if (card !== undefined && (card.status === 'open' || card.status === 'dismissed')) dispatch({ type: 'card', cardId, patch: { status: 'editing', error: null } });
    },
    cancelEdit: (cardId) => {
      if (cardOf(state, cardId)?.status === 'editing') dispatch({ type: 'card', cardId, patch: { status: 'open', error: null } });
    },
    dismiss,
    reopen: (cardId) => {
      if (cardOf(state, cardId)?.status === 'dismissed') dispatch({ type: 'card', cardId, patch: { status: 'open', error: null } });
    },
    editMessage,
    regenerate,
    showVersion,
    rate,
    retry: (replyKey) => {
      const at = state.messages.findIndex((message) => message.key === replyKey);
      const asked = state.messages[at - 1];
      if (at < 1 || asked?.role !== 'user' || !canStart(state)) return;
      const request = state.messages[at]?.request ?? null;
      // A regenerate followed from another tab or a refresh: asked again in the failed reply's place, which comes back
      // if this one doesn't save either.
      if (request !== null && 'replyTo' in request) {
        if (live.current === null) run({ type: 'regenerate', replyKey, newKey: nextKey(), request }, request);
        return;
      }
      dispatch({ type: 'drop', replyKey });
      // A question card's message goes again as the card sent it: its words never reach the composer, and once saved
      // the card answers its question.
      const ended = told.current.get(replyKey);
      told.current.delete(replyKey);
      // Sent again from where the conversation is now: after the leaf, like any message, with the files it carried,
      // except one gone from Your data, as an edit sends them (the server would refuse it).
      const attachments = asked.attachments.filter((attachment) => attachment.state !== 'gone');
      start(request !== null && 'content' in request ? request.content : messageText(asked), 0, ended === undefined ? undefined : { ended }, attachments);
    },
    reload: () => {
      dispatch({ type: 'load' });
      setGeneration((value) => value + 1);
    },
    loadItem,
    keepItem,
    setItemAside,
    watchList: setWatching,
  };
}
