import { useEffect, useReducer, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client';
import { loadOrg } from '../org';
import { describeError } from '../ui';
import {
  addNote as postNote, loadChat, loadConversation, sendTurn,
  type Budget, type ChatEvent, type ChatSummary, type ConversationSummary, type NoteProposal, type StoredMessage,
} from './api';
import { toolLabel } from './format';

export interface ProposalCard {
  key: string;
  proposal: NoteProposal;
  status: 'open' | 'adding' | 'added' | 'dismissed';
  error: string | null;
}

export interface ChatMessage {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  proposals: ProposalCard[];
  /** `streaming`: the reply being written. A stopped or failed turn is not saved on the server. */
  state: 'complete' | 'streaming' | 'stopped' | 'failed';
  /** A short line under a reply: why it stopped or ended early. */
  note: string | null;
}

export interface TuningChatState {
  status: 'loading' | 'ready' | 'not_found' | 'failed';
  loadError: string | null;
  locationName: string | null;
  enabled: boolean;
  budget: Budget | null;
  conversations: ConversationSummary[];
  /** The open conversation; null for a new one. */
  conversationId: string | null;
  conversationLoading: boolean;
  messages: ChatMessage[];
  /** From Send until the stream ends. */
  streaming: boolean;
  /** The one-line status while a tool runs. */
  tool: string | null;
  /** Why the last send or conversation load failed. */
  error: string | null;
  draft: string;
}

type CardPatch = Pick<ProposalCard, 'status' | 'error'>;

export type ChatAction =
  | { type: 'load' }
  | { type: 'loaded'; summary: ChatSummary; locationName: string | null }
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
  | { type: 'card'; messageKey: string; cardKey: string; patch: CardPatch };

export const NOT_SAVED = 'Your message and this reply weren’t saved.';
export const STOPPED = 'Stopped. Your message and this reply weren’t saved.';
export const CUT_OFF = 'The reply was cut off. Try again.';
export const REFUSED = 'The assistant can’t help with that. Your message and this reply weren’t saved.';
export const BUDGET_SPENT = 'The assistant stopped here because this month’s chat budget is used up.';
export const TIMED_OUT = 'The reply took too long. Try asking something shorter.';

/** The `done` stop reasons of a turn the server saved; any other (a refusal) saved nothing. */
const SAVED_STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'tool_limit', 'budget'];

export function initialChatState(): TuningChatState {
  return {
    status: 'loading', loadError: null, locationName: null, enabled: false, budget: null, conversations: [],
    conversationId: null, conversationLoading: false, messages: [], streaming: false, tool: null, error: null, draft: '',
  };
}

function doneNote(stopReason: string): string | null {
  switch (stopReason) {
    case 'max_tokens': return 'The reply hit its length limit.';
    case 'refusal': return REFUSED;
    case 'tool_limit': return 'The assistant stopped after too many lookups. Ask again to continue.';
    case 'budget': return BUDGET_SPENT;
    default: return null;
  }
}

function streamErrorText(code: string): string {
  if (code === 'provider_overloaded') return 'The assistant is busy. Try again in a minute.';
  if (code === 'provider_unavailable') return 'Can’t reach the assistant. Try again.';
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
    if (error.code === 'conversation_full') return 'This conversation is full. Start a new conversation.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t send messages.';
    if (error.status === 404) return 'This conversation or location wasn’t found.';
    if (error.status === 400) return 'That message couldn’t be sent.';
    if (error.status === 429) {
      return error.retryAfterSeconds === null
        ? 'You’ve sent a lot of messages. Try again later.'
        : `You’ve sent a lot of messages. Try again in ${minutes(error.retryAfterSeconds)}.`;
    }
    if (error.status === 503) return 'The tuning chat isn’t available right now.';
  }
  return describeError(error);
}

export function noteErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'note_limit') return 'This location has 1,000 notes. Delete old ones to add more.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t add notes.';
    if (error.status === 400) return 'Townwise couldn’t accept this note. Ask the assistant to fix it.';
    if (error.status === 404) return 'This location wasn’t found.';
    if (error.status === 429) return describeError(error);
  }
  return 'Couldn’t save the note. Try again.';
}

function withLive(state: TuningChatState, update: (message: ChatMessage) => ChatMessage): ChatMessage[] {
  return state.messages.map((message) => (message.state === 'streaming' ? update(message) : message));
}

export function chatReducer(state: TuningChatState, action: ChatAction): TuningChatState {
  switch (action.type) {
    case 'load':
      return { ...initialChatState(), draft: state.draft };
    case 'loaded':
      return {
        ...state, status: 'ready', loadError: null, locationName: action.locationName, enabled: action.summary.enabled,
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
        ...state, draft: '', error: null, streaming: true, tool: null,
        messages: [
          ...state.messages,
          { key: action.userKey, role: 'user', text: action.content, proposals: [], state: 'complete', note: null },
          { key: action.replyKey, role: 'assistant', text: '', proposals: [], state: 'streaming', note: null },
        ],
      };
    case 'event':
      return applyEvent(state, action.event, action.key, action.at);
    case 'ended':
      return {
        ...state, streaming: false, tool: null,
        error: state.messages.some((message) => message.state === 'streaming') ? CUT_OFF : state.error,
        messages: withLive(state, (message) => ({ ...message, state: 'failed', note: NOT_SAVED })),
      };
    case 'stopped':
      return { ...state, streaming: false, tool: null, messages: withLive(state, (message) => ({ ...message, state: 'stopped', note: STOPPED })) };
    case 'failed': {
      const at = state.messages.findIndex((message) => message.state === 'streaming');
      const live = state.messages[at];
      // The reply already ended with `done` or `error`; a late connection error changes nothing.
      if (live === undefined) return { ...state, streaming: false, tool: null };
      const budget = action.exhausted && state.budget !== null ? { ...state.budget, exhausted: true } : state.budget;
      const base = { ...state, streaming: false, tool: null, error: action.error, budget };
      // Nothing of the reply arrived (the server refused the turn, or the connection failed first): take the
      // turn back and return the text to the composer, unless something new was typed meanwhile.
      if (live.text === '' && live.proposals.length === 0) {
        return {
          ...base,
          draft: state.draft === '' ? action.content : state.draft,
          messages: state.messages.filter((_, index) => index !== at && index !== at - 1),
        };
      }
      return { ...base, messages: withLive(state, (message) => ({ ...message, state: 'failed', note: NOT_SAVED })) };
    }
    case 'discard':
      // The server kept no conversation for this id: the next send starts a new one instead of getting a 404.
      return {
        ...state,
        conversationId: state.conversationId === action.id ? null : state.conversationId,
        conversations: state.conversations.filter((conversation) => conversation.id !== action.id),
      };
    case 'card':
      return {
        ...state,
        messages: state.messages.map((message) => (message.key !== action.messageKey ? message : {
          ...message,
          proposals: message.proposals.map((card) => (card.key === action.cardKey ? { ...card, ...action.patch } : card)),
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
      return { ...state, messages: withLive(state, (message) => ({ ...message, text: message.text + event.delta })) };
    case 'tool':
      return { ...state, tool: event.state === 'running' ? toolLabel(event.name) : null };
    case 'proposal':
      return {
        ...state,
        messages: withLive(state, (message) => ({
          ...message,
          proposals: [...message.proposals, { key, proposal: event.proposal, status: 'open', error: null }],
        })),
      };
    case 'done': {
      // The budget ran out during the turn: the reply stays, and the chat shows the budget used up, as the GET would.
      const budget = event.stopReason === 'budget' && state.budget !== null ? { ...state.budget, exhausted: true } : state.budget;
      return {
        ...state, tool: null, budget,
        messages: withLive(state, (message) => ({ ...message, state: 'complete', note: doneNote(event.stopReason) })),
      };
    }
    case 'error':
      return {
        ...state, tool: null, error: streamErrorText(event.code),
        messages: withLive(state, (message) => ({ ...message, state: 'failed', note: NOT_SAVED })),
      };
  }
}

export interface TuningChat {
  state: TuningChatState;
  setDraft: (text: string) => void;
  send: () => void;
  stop: () => void;
  newConversation: () => void;
  openConversation: (id: string) => void;
  addNote: (messageKey: string, cardKey: string) => void;
  dismiss: (messageKey: string, cardKey: string) => void;
  retry: () => void;
}

export function canSend(state: TuningChatState): boolean {
  return state.status === 'ready' && state.enabled && state.budget?.exhausted !== true && !state.streaming
    && !state.conversationLoading && state.draft.trim() !== '';
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === status;
}

/** `onNoteAdded` runs after each note a card adds, so the page can mark the location's notes count stale. */
export function useTuningChat(api: ApiClient, locationId: string, onNoteAdded?: () => void): TuningChat {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const [generation, setGeneration] = useState(0);
  const live = useRef<AbortController | null>(null);
  const opening = useRef(0);
  const adding = useRef(new Set<string>());
  const keys = useRef(0);

  function nextKey(): string {
    keys.current += 1;
    return `m${String(keys.current)}`;
  }

  useEffect(() => {
    let cancelled = false;
    const name = loadOrg(api).then(
      (org) => org?.locations.find((location) => location.id === locationId)?.name ?? null,
      () => null,
    );
    void Promise.all([loadChat(api, locationId), name]).then(
      ([summary, locationName]) => { if (!cancelled) dispatch({ type: 'loaded', summary, locationName }); },
      (error: unknown) => { if (!cancelled) dispatch({ type: 'loadFailed', notFound: isStatus(error, 404), error: describeError(error) }); },
    );
    return () => {
      cancelled = true;
      live.current?.abort();
      live.current = null;
    };
  }, [api, locationId, generation]);

  function refresh(): void {
    void loadChat(api, locationId).then((summary) => { dispatch({ type: 'summary', summary }); }, () => undefined);
  }

  function send(): void {
    const content = state.draft.trim();
    if (!canSend(state) || live.current !== null) return;
    const controller = new AbortController();
    live.current = controller;
    dispatch({ type: 'send', content, userKey: nextKey(), replyKey: nextKey() });
    const turn = { conversationId: state.conversationId, content };
    // A first turn that saved nothing (an error, Stop, a cut-off stream or a refusal) left no conversation behind.
    let created: string | null = null;
    let saved = false;
    void sendTurn(api, locationId, turn, controller.signal, (event) => {
      if (event.type === 'conversation') created = event.id;
      if (event.type === 'done' && SAVED_STOP_REASONS.includes(event.stopReason)) saved = true;
      dispatch({ type: 'event', event, key: nextKey(), at: new Date().toISOString() });
    }).then(
      () => { dispatch({ type: 'ended' }); },
      (error: unknown) => {
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
        if (token === opening.current) dispatch({ type: 'opened', id, messages: stored.map(toMessage) });
      },
      (error: unknown) => {
        if (token === opening.current) dispatch({ type: 'openFailed', id, error: describeError(error) });
      },
    );
  }

  function toMessage(stored: StoredMessage): ChatMessage {
    return {
      key: nextKey(),
      role: stored.role,
      text: stored.text,
      proposals: stored.proposals.map((proposal) => ({ key: nextKey(), proposal, status: 'open', error: null })),
      state: 'complete',
      note: null,
    };
  }

  function addNote(messageKey: string, cardKey: string): void {
    const card = state.messages.find((message) => message.key === messageKey)?.proposals.find((item) => item.key === cardKey);
    if (card === undefined || card.status === 'added' || adding.current.has(cardKey)) return;
    adding.current.add(cardKey);
    dispatch({ type: 'card', messageKey, cardKey, patch: { status: 'adding', error: null } });
    void postNote(api, locationId, card.proposal).then(
      () => {
        dispatch({ type: 'card', messageKey, cardKey, patch: { status: 'added', error: null } });
        onNoteAdded?.();
      },
      (error: unknown) => { dispatch({ type: 'card', messageKey, cardKey, patch: { status: 'open', error: noteErrorText(error) } }); },
    ).finally(() => { adding.current.delete(cardKey); });
  }

  return {
    state,
    setDraft: (text) => { dispatch({ type: 'draft', text }); },
    send,
    stop: () => { live.current?.abort(); },
    newConversation: () => {
      if (state.streaming) return;
      opening.current += 1;
      dispatch({ type: 'new' });
    },
    openConversation,
    addNote,
    dismiss: (messageKey, cardKey) => { dispatch({ type: 'card', messageKey, cardKey, patch: { status: 'dismissed', error: null } }); },
    retry: () => {
      dispatch({ type: 'load' });
      setGeneration((value) => value + 1);
    },
  };
}
