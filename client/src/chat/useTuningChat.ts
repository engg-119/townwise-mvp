import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client';
import { describeError } from '../ui';
import {
  actOnItemProposal, addNote as postNote, deleteConversation as removeConversation, dismissProposal, loadChat, loadConversation,
  loadItemProposal, saveProposal, sendTurn,
  type Budget, type ChatEvent, type ChatSummary, type ConversationSummary, type ItemProposal, type NoteProposal, type ProposalResult,
  type StoredMessage,
} from './api';
import { isHiddenTool, type ToolStep } from './tools';

// TownwiseAI's conversation state (spec P25; docs/portal/tuning-chat.md 2 and 3). A reply is an
// ordered list of parts, in the order they streamed: text, a group of tool calls, more text, a proposal card. Tool
// calls are kept by their id, so each card updates in place; proposal cards by the propose_note call's id.
//
// A proposal's actions go to the proposal route, which finds it only once its turn is stored (`done`, not a
// refusal). Until then a live card's actions wait; a card from a turn the server never kept offers the notes
// route instead (tuning-chat.md section 2). A proposal to keep text (propose_data_item, D28) is an item card: its
// title and text are never streamed, so the card reads them from its own route once the turn is stored, and a turn
// the server never kept has nothing to keep.

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

export type MessagePart =
  | { type: 'text'; key: string; text: string }
  | { type: 'tools'; key: string; steps: ToolStep[] }
  | { type: 'proposal'; key: string; card: ProposalCard }
  | { type: 'item'; key: string; card: ItemCard };

export interface ChatMessage {
  key: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  /** `streaming`: the reply being written. A stopped or failed turn is not saved on the server. */
  state: 'complete' | 'streaming' | 'stopped' | 'failed';
  /** A short line under a reply: why it stopped or ended early. */
  note: string | null;
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
  /** From Send until the stream ends. */
  streaming: boolean;
  /** Why the last send or conversation load failed. */
  error: string | null;
  draft: string;
}

type CardPatch = Partial<Pick<ProposalCard, 'status' | 'error' | 'edited' | 'gone'>>;

export type ChatAction =
  | { type: 'load' }
  | { type: 'loaded'; summary: ChatSummary }
  | { type: 'loadFailed'; notFound: boolean; error: string }
  | { type: 'summary'; summary: ChatSummary }
  | { type: 'draft'; text: string }
  | { type: 'new' }
  | { type: 'open'; id: string }
  | { type: 'opened'; id: string; messages: ChatMessage[] }
  | { type: 'openFailed'; id: string; error: string }
  | { type: 'send'; content: string; userKey: string; replyKey: string }
  | { type: 'event'; event: ChatEvent; key: string; at: string }
  | { type: 'ended' }
  | { type: 'stopped' }
  | { type: 'failed'; error: string | null; content: string; exhausted: boolean }
  | { type: 'discard'; id: string }
  | { type: 'removed'; id: string }
  | { type: 'drop'; replyKey: string }
  | { type: 'card'; cardId: string; patch: CardPatch };

export const NOT_SAVED = 'Your message and this reply weren’t saved.';
export const STOPPED = 'Stopped. Your message and this reply weren’t saved.';
export const CUT_OFF = 'The reply was cut off. Try again.';
export const REFUSED = 'TownwiseAI can’t help with that. Your message and this reply weren’t saved.';
export const BUDGET_SPENT = 'TownwiseAI stopped here because this month’s budget is used up.';
export const TIMED_OUT = 'The reply took too long. Try asking something shorter.';

/** The `done` stop reasons of a turn the server saved; any other (a refusal) saved nothing. */
const SAVED_STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'tool_limit', 'budget'];

/** Text deltas are drawn at most this often (spec P25), so native doesn't redraw the thread per token. */
export const FLUSH_MS = 32;

export function initialChatState(): TuningChatState {
  return {
    status: 'loading', loadError: null, enabled: false, budget: null, conversations: [],
    conversationId: null, conversationLoading: false, messages: [], streaming: false, error: null, draft: '',
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

/** Copy for a turn the server refused or a stream that failed before it finished. */
export function sendErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'chat_turn_in_progress') return 'You already have a reply in progress, maybe in another tab or location. Wait for it to finish, then try again.';
    if (error.code === 'conversation_full') return 'This conversation is full. Start a new chat.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t send messages.';
    if (error.status === 404) return 'This conversation or location wasn’t found.';
    if (error.status === 400) return 'That message couldn’t be sent.';
    if (error.status === 429) {
      return error.retryAfterSeconds === null
        ? 'You’ve sent a lot of messages. Try again later.'
        : `You’ve sent a lot of messages. Try again in ${minutes(error.retryAfterSeconds)}.`;
    }
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
      return part;
    }),
  };
}

/** A shown propose_data_item call: its item card, once. */
function withItem(message: ChatMessage, card: ItemCard, key: string): ChatMessage {
  if (message.parts.some((part) => part.type === 'item' && part.card.id === card.id)) return message;
  return { ...message, parts: [...message.parts, { type: 'item', key, card }] };
}

function endLive(state: TuningChatState, end: Pick<ChatMessage, 'state' | 'note'>): ChatMessage[] {
  return withLive(state, (message) => settleCards({ ...message, ...end }, 'lost'));
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

function withText(message: ChatMessage, delta: string, key: string): ChatMessage {
  const last = message.parts.at(-1);
  if (last?.type === 'text') return { ...message, parts: [...message.parts.slice(0, -1), { ...last, text: last.text + delta }] };
  return { ...message, parts: [...message.parts, { type: 'text', key, text: delta }] };
}

function hasContent(message: ChatMessage): boolean {
  return message.parts.length > 0;
}

export function chatReducer(state: TuningChatState, action: ChatAction): TuningChatState {
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
    case 'summary':
      return { ...state, enabled: action.summary.enabled, budget: action.summary.budget, conversations: action.summary.conversations };
    case 'draft':
      return { ...state, draft: action.text };
    case 'new':
      return { ...state, conversationId: null, conversationLoading: false, messages: [], error: null };
    case 'open':
      return { ...state, conversationId: action.id, conversationLoading: true, messages: [], error: null };
    case 'opened':
      if (state.conversationId !== action.id) return state;
      return { ...state, conversationLoading: false, messages: action.messages };
    case 'openFailed':
      if (state.conversationId !== action.id) return state;
      return { ...state, conversationLoading: false, error: action.error };
    case 'send':
      return {
        ...state, error: null, streaming: true,
        draft: state.draft.trim() === action.content ? '' : state.draft,
        messages: [
          ...state.messages,
          { key: action.userKey, role: 'user', parts: [{ type: 'text', key: `${action.userKey}t`, text: action.content }], state: 'complete', note: null },
          { key: action.replyKey, role: 'assistant', parts: [], state: 'streaming', note: null },
        ],
      };
    case 'event':
      return applyEvent(state, action.event, action.key, action.at);
    case 'ended':
      return {
        ...state, streaming: false,
        error: state.messages.some((message) => message.state === 'streaming') ? CUT_OFF : state.error,
        messages: endLive(state, { state: 'failed', note: NOT_SAVED }),
      };
    case 'stopped':
      return { ...state, streaming: false, messages: endLive(state, { state: 'stopped', note: STOPPED }) };
    case 'failed': {
      const at = state.messages.findIndex((message) => message.state === 'streaming');
      const live = state.messages[at];
      // The reply already ended with `done` or `error`; a late connection error changes nothing.
      if (live === undefined) return { ...state, streaming: false };
      const budget = action.exhausted && state.budget !== null ? { ...state.budget, exhausted: true } : state.budget;
      const base = { ...state, streaming: false, error: action.error, budget };
      // Nothing of the reply arrived (the server refused the turn, or the connection failed first): take the
      // turn back and return the text to the composer, unless something new was typed meanwhile.
      if (!hasContent(live)) {
        return {
          ...base,
          draft: state.draft === '' ? action.content : state.draft,
          messages: state.messages.filter((_, index) => index !== at && index !== at - 1),
        };
      }
      return { ...base, messages: endLive(state, { state: 'failed', note: NOT_SAVED }) };
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
        ...(open ? { conversationId: null, conversationLoading: false, messages: [], error: null } : {}),
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
  }
}

function applyEvent(state: TuningChatState, event: ChatEvent, key: string, at: string): TuningChatState {
  switch (event.type) {
    case 'conversation': {
      const known = state.conversations.some((conversation) => conversation.id === event.id);
      return {
        ...state,
        conversationId: event.id,
        conversations: known ? state.conversations : [{ id: event.id, title: event.title, updatedAt: at, turnCount: 0 }, ...state.conversations],
      };
    }
    case 'text':
      return { ...state, messages: withLive(state, (message) => withText(message, event.delta, key)) };
    case 'tool':
      // propose_data_item's calls show as their item card once done, if the owner was shown one.
      if (event.name === ITEM_TOOL) {
        return event.state === 'done' && event.result?.shown === true
          ? { ...state, messages: withLive(state, (message) => withItem(message, { id: event.id, conversationId: state.conversationId, stored: 'pending' }, key)) }
          : state;
      }
      // propose_note's calls show as their proposal card.
      if (isHiddenTool(event.name)) return state;
      return { ...state, messages: withLive(state, (message) => withTool(message, event, key)) };
    case 'proposal': {
      const card: ProposalCard = { id: event.id, proposal: event.proposal, status: 'open', stored: 'pending', edited: false, gone: false, error: null };
      return { ...state, messages: withLive(state, (message) => ({ ...message, parts: [...message.parts, { type: 'proposal', key, card }] })) };
    }
    case 'done': {
      // The budget ran out during the turn: the reply stays, and the chat shows the budget used up, as the GET would.
      const budget = event.stopReason === 'budget' && state.budget !== null ? { ...state.budget, exhausted: true } : state.budget;
      const saved = SAVED_STOP_REASONS.includes(event.stopReason);
      return {
        ...state, budget,
        messages: withLive(state, (message) => settleCards({ ...message, state: 'complete', note: doneNote(event.stopReason) }, saved ? 'kept' : 'lost')),
      };
    }
    case 'error':
      return { ...state, error: streamErrorText(event.code), messages: endLive(state, { state: 'failed', note: NOT_SAVED }) };
  }
}

export interface TuningChat {
  state: TuningChatState;
  setDraft: (text: string) => void;
  /** Sends the composer's text. */
  send: () => void;
  /** Sends `text` as it is (an Ask suggestion). */
  ask: (text: string) => void;
  stop: () => void;
  newConversation: () => void;
  openConversation: (id: string) => void;
  /** Deletes a conversation; rejects with the API's error, for the confirm dialog. */
  deleteConversation: (id: string) => Promise<void>;
  /** Save note, as shown. */
  save: (cardId: string) => void;
  /** Edit first's save: rejects with the API's error, for the note form. */
  saveEdited: (cardId: string, note: NoteProposal) => Promise<void>;
  edit: (cardId: string) => void;
  cancelEdit: (cardId: string) => void;
  /** Not now. */
  dismiss: (cardId: string) => void;
  /** "Show the note" on a card set aside. */
  reopen: (cardId: string) => void;
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
}

export function canSend(state: TuningChatState): boolean {
  return canStart(state) && state.draft.trim() !== '';
}

function canStart(state: TuningChatState): boolean {
  return state.status === 'ready' && state.enabled && state.budget?.exhausted !== true && !state.streaming && !state.conversationLoading;
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

/** `onNoteAdded` runs after each note a card saves, so the page can mark the location's notes count stale. */
export function useTuningChat(api: ApiClient, locationId: string, onNoteAdded?: () => void): TuningChat {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const [generation, setGeneration] = useState(0);
  const live = useRef<AbortController | null>(null);
  const opening = useRef(0);
  const acting = useRef(new Set<string>());
  const keys = useRef(0);
  // The text that arrived since the last draw, and the timer that draws it.
  const buffer = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: '', timer: null });
  // The state the last render drew, for writes and sends that start from a callback.
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });

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
    dispatch({ type: 'event', event: { type: 'text', delta }, key: nextKey(), at: '' });
  }

  useEffect(() => {
    let cancelled = false;
    void loadChat(api, locationId).then(
      (summary) => { if (!cancelled) dispatch({ type: 'loaded', summary }); },
      (error: unknown) => { if (!cancelled) dispatch({ type: 'loadFailed', notFound: isStatus(error, 404), error: describeError(error) }); },
    );
    const pending = buffer.current;
    return () => {
      cancelled = true;
      live.current?.abort();
      live.current = null;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
      pending.text = '';
    };
  }, [api, locationId, generation]);

  function refresh(): void {
    void loadChat(api, locationId).then((summary) => { dispatch({ type: 'summary', summary }); }, () => undefined);
  }

  function start(content: string): void {
    if (content === '' || !canStart(latest.current) || live.current !== null) return;
    const controller = new AbortController();
    live.current = controller;
    dispatch({ type: 'send', content, userKey: nextKey(), replyKey: nextKey() });
    const turn = { conversationId: latest.current.conversationId, content };
    // A first turn that saved nothing (an error, Stop, a cut-off stream or a refusal) left no conversation behind.
    let created: string | null = null;
    let saved = false;
    void sendTurn(api, locationId, turn, controller.signal, (event) => {
      if (controller.signal.aborted) return;
      if (event.type === 'text') {
        buffer.current.text += event.delta;
        buffer.current.timer ??= setTimeout(flush, FLUSH_MS);
        return;
      }
      // Any other event draws the text before it first, so the parts keep their order.
      flush();
      if (event.type === 'conversation') created = event.id;
      if (event.type === 'done' && SAVED_STOP_REASONS.includes(event.stopReason)) saved = true;
      dispatch({ type: 'event', event, key: nextKey(), at: new Date().toISOString() });
    }).then(
      () => {
        flush();
        dispatch({ type: 'ended' });
      },
      (error: unknown) => {
        flush();
        if (error instanceof ApiError && error.kind === 'aborted') {
          dispatch({ type: 'stopped' });
          return;
        }
        const exhausted = error instanceof ApiError && error.code === 'chat_budget_exhausted';
        dispatch({ type: 'failed', error: exhausted ? null : sendErrorText(error), content, exhausted });
      },
    ).finally(() => {
      if (live.current === controller) live.current = null;
      if (turn.conversationId === null && created !== null && !saved) dispatch({ type: 'discard', id: created });
      // The list, the budget and the off switch may all have changed with this turn.
      refresh();
    });
  }

  function openConversation(id: string): void {
    if (state.streaming) return;
    opening.current += 1;
    const token = opening.current;
    dispatch({ type: 'open', id });
    void loadConversation(api, locationId, id).then(
      (stored) => {
        if (token === opening.current) dispatch({ type: 'opened', id, messages: stored.map((message) => toMessage(message, id)) });
      },
      (error: unknown) => {
        if (token === opening.current) dispatch({ type: 'openFailed', id, error: describeError(error) });
      },
    );
  }

  function toMessage(stored: StoredMessage, conversationId: string): ChatMessage {
    const message: ChatMessage = { key: nextKey(), role: stored.role, parts: [], state: 'complete', note: null };
    if (stored.role === 'user' || stored.parts.length === 0) {
      message.parts = stored.text === '' ? [] : [{ type: 'text', key: nextKey(), text: stored.text }];
      return message;
    }
    for (const part of stored.parts) {
      const last = message.parts.at(-1);
      if (part.type === 'text') message.parts.push({ type: 'text', key: nextKey(), text: part.text });
      else if (part.type === 'tool') {
        // As while it streamed: a propose_data_item call the owner was shown is its item card.
        if (part.name === ITEM_TOOL) {
          if (part.state === 'done' && part.result?.shown === true) {
            message.parts.push({ type: 'item', key: nextKey(), card: { id: part.id, conversationId, stored: 'kept' } });
          }
          continue;
        }
        // As while it streamed: a propose_note call that got an error shows nothing.
        if (isHiddenTool(part.name)) continue;
        const step: ToolStep = { id: part.id, name: part.name, state: part.state, input: part.input, result: part.result };
        if (last?.type === 'tools') last.steps.push(step);
        else message.parts.push({ type: 'tools', key: nextKey(), steps: [step] });
      } else {
        const { id, status, kind, startDate, endDate, weekdays, effect, expectedGuests, detail } = part.proposal;
        const proposal: NoteProposal = { kind, startDate, endDate, weekdays, effect, expectedGuests, detail };
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

  return {
    state,
    setDraft: (text) => { dispatch({ type: 'draft', text }); },
    send: () => { start(state.draft.trim()); },
    ask: (text) => { start(text.trim()); },
    stop: () => { live.current?.abort(); },
    newConversation: () => {
      if (state.streaming) return;
      opening.current += 1;
      dispatch({ type: 'new' });
    },
    openConversation,
    deleteConversation: async (id) => {
      await removeConversation(api, locationId, id);
      if (latest.current.conversationId === id) opening.current += 1;
      dispatch({ type: 'removed', id });
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
    retry: (replyKey) => {
      const at = state.messages.findIndex((message) => message.key === replyKey);
      const asked = state.messages[at - 1];
      if (at < 1 || asked?.role !== 'user' || !canStart(state)) return;
      dispatch({ type: 'drop', replyKey });
      start(messageText(asked));
    },
    reload: () => {
      dispatch({ type: 'load' });
      setGeneration((value) => value + 1);
    },
    loadItem,
    keepItem,
    setItemAside,
  };
}
