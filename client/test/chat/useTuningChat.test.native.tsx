import { act, renderHook, waitFor } from '@testing-library/react-native';

import { ApiError } from '../../src/api/client';
import { versionsOf } from '../../src/chat/tree';
import {
  BUDGET_SPENT, canSend, chatReducer, CUT_OFF, FLUSH_MS, initialChatState, messageText, NOT_SAVED, RATING_FAILED, REGENERATE_FAILED, STOPPED,
  stepsOf, TIMED_OUT, useTuningChat, VERSION_FAILED, type ChatMessage, type ItemCard, type ProposalCard, type TuningChat, type TuningChatState,
} from '../../src/chat/useTuningChat';
import { CONVERSATION, fakeChatApi, PROPOSAL, PROPOSAL_ID, refusal, SALES_STEP, SUMMARY, type FakeChatApi, type LiveTurn } from '../helpers/chat';
import { daily } from './visuals-fixtures';

interface Who { onNoteAdded?: () => void; readOnly?: boolean; userId?: string }

// Drafts live in memory for the whole test file, so each hook is a different person unless a test names one.
let people = 0;

function hook(api: FakeChatApi, who: Who = {}): () => TuningChat {
  people += 1;
  const userId = who.userId ?? `user-${String(people)}`;
  const options = { userId, readOnly: who.readOnly ?? false, ...(who.onNoteAdded === undefined ? {} : { onNoteAdded: who.onNoteAdded }) };
  return () => useTuningChat(api, 'l1', options);
}

async function ready(api: FakeChatApi, who: Who = {}): Promise<{ current: TuningChat }> {
  const { result } = await renderHook(hook(api, who));
  await waitFor(() => { expect(result.current.state.status).toBe('ready'); });
  return result;
}

async function opened(chat: { current: TuningChat }, id = 'c1'): Promise<void> {
  await act(() => { chat.current.openConversation(id); });
  await waitFor(() => { expect(chat.current.state.conversationLoading).toBe(false); });
}

/** Jest's fake timers moved on, with the promises they release settled in between. */
async function advance(ms: number): Promise<void> {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}

async function send(chat: { current: TuningChat }, text: string): Promise<void> {
  await act(() => { chat.current.setDraft(text); });
  await act(() => { chat.current.send(); });
}

function turn(api: FakeChatApi, index = 0): LiveTurn {
  const live = api.turns[index];
  if (live === undefined) throw new Error(`no turn ${String(index)}`);
  return live;
}

function reply(chat: { current: TuningChat }): ChatMessage {
  const last = chat.current.state.messages.at(-1);
  if (last?.role !== 'assistant') throw new Error('no reply');
  return last;
}

function cards(message: ChatMessage): ProposalCard[] {
  return message.parts.flatMap((part) => (part.type === 'proposal' ? [part.card] : []));
}

function card(chat: { current: TuningChat }, id: string): ProposalCard {
  for (const message of chat.current.state.messages) {
    const found = cards(message).find((item) => item.id === id);
    if (found !== undefined) return found;
  }
  throw new Error(`no card ${id}`);
}

const PROPOSAL_EVENT = { id: PROPOSAL_ID, proposal: PROPOSAL };

/** A finished turn with one proposal, stored by the server. */
async function proposed(api: FakeChatApi, chat: { current: TuningChat }): Promise<void> {
  await send(chat, 'Holidays');
  await act(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'Holidays' });
    turn(api).emit('proposal', PROPOSAL_EVENT);
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: null });
    turn(api).end();
  });
  await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
}

test('loads the budget and the conversations', async () => {
  const chat = await ready(fakeChatApi());
  expect(chat.current.state).toMatchObject({ enabled: true, budget: SUMMARY.budget, conversations: SUMMARY.conversations, conversationId: null, messages: [] });
  expect(canSend(chat.current.state)).toBe(false);
  await act(() => { chat.current.setDraft('  hi  '); });
  expect(canSend(chat.current.state)).toBe(true);
});

test('a reply streams as ordered parts: text, a group of tool calls updated in place by id, more text, a proposal', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, '  Closed Christmas week  ');
  const live = turn(api);
  expect(live.path).toBe('/api/org/locations/l1/chat/turns');
  expect(live.body).toEqual({ content: 'Closed Christmas week' });
  expect(chat.current.state).toMatchObject({ streaming: true, draft: '' });
  expect(chat.current.state.messages.map((message) => [message.role, messageText(message), message.state])).toEqual([
    ['user', 'Closed Christmas week', 'complete'],
    ['assistant', '', 'streaming'],
  ]);

  await act(() => { live.emit('conversation', { id: 'c2', title: 'Closed Christmas week', userNodeId: 'u1', replyNodeId: 'a1', parentId: null }); });
  expect(chat.current.state.conversationId).toBe('c2');
  expect(chat.current.state.conversations.map((item) => item.id)).toEqual(['c2', 'c1']);

  await act(() => {
    live.emit('text', { delta: 'Let me ' });
    live.emit('text', { delta: 'look.' });
    live.emit('tool', { id: 't1', name: 'get_sales_days', state: 'running', input: SALES_STEP.input, result: null });
    live.emit('tool', { id: 't2', name: 'list_notes', state: 'running', input: null, result: null });
  });
  // The tool event drew the text before it, so the order holds.
  expect(reply(chat).parts.map((part) => part.type)).toEqual(['text', 'tools']);
  expect(stepsOf(reply(chat)).map((step) => [step.id, step.state])).toEqual([['t1', 'running'], ['t2', 'running']]);

  await act(() => {
    live.emit('tool', { id: 't1', name: 'get_sales_days', state: 'done', input: SALES_STEP.input, result: SALES_STEP.result });
    live.emit('tool', { id: 't2', name: 'list_notes', state: 'error', input: null, result: null });
    // propose_note's own tool events never make a card: its proposal does.
    live.emit('tool', { id: PROPOSAL_ID, name: 'propose_note', state: 'running', input: null, result: null });
    live.emit('text', { delta: 'You were closed.' });
    live.emit('proposal', PROPOSAL_EVENT);
  });
  expect(stepsOf(reply(chat)).map((step) => [step.id, step.state])).toEqual([['t1', 'done'], ['t2', 'error']]);
  expect(stepsOf(reply(chat))[0]?.result).toEqual(SALES_STEP.result);
  expect(reply(chat).parts.map((part) => part.type)).toEqual(['text', 'tools', 'text', 'proposal']);
  // Until the turn is stored, the card's actions wait.
  expect(cards(reply(chat))).toEqual([expect.objectContaining({ id: PROPOSAL_ID, proposal: PROPOSAL, status: 'open', stored: 'pending' })]);

  await act(() => { live.emit('done', { stopReason: 'end_turn', costUsd: 0.02, leafId: 'a1' }); });
  expect(reply(chat)).toMatchObject({ state: 'complete', note: null });
  expect(cards(reply(chat))[0]?.stored).toBe('kept');
  const loadsBefore = api.summaryLoads;
  await act(() => { live.end(); });
  expect(chat.current.state).toMatchObject({ streaming: false, error: null });
  await waitFor(() => { expect(api.summaryLoads).toBe(loadsBefore + 1); });

  await send(chat, 'And New Year’s Day?');
  expect(turn(api, 1).body).toEqual({ conversationId: 'c2', content: 'And New Year’s Day?', parentId: 'a1' });
});

test('text deltas are drawn at most every 32ms, and any other event draws them first', async () => {
  jest.useFakeTimers();
  try {
    const api = fakeChatApi();
    const chat = await ready(api);
    await send(chat, 'Hello');
    await act(() => { for (const word of ['One ', 'two ', 'three.']) turn(api).emit('text', { delta: word }); });
    expect(reply(chat).parts).toEqual([]);
    await act(() => { jest.advanceTimersByTime(FLUSH_MS); });
    expect(reply(chat).parts.map((part) => (part.type === 'text' ? part.text : part.type))).toEqual(['One two three.']);
    await act(() => {
      turn(api).emit('text', { delta: ' More.' });
      turn(api).emit('tool', { id: 't1', name: 'list_notes', state: 'running', input: null, result: null });
    });
    expect(reply(chat).parts.map((part) => (part.type === 'text' ? part.text : part.type))).toEqual(['One two three. More.', 'tools']);
  } finally {
    jest.useRealTimers();
  }
});

test('thinking deltas join one thinking part before the text, stamp the reply’s start and end, and are not message text', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  const live = turn(api);
  await act(() => {
    live.emit('thinking', { delta: 'Weighing ' });
    live.emit('thinking', { delta: 'the weekend.' });
    live.emit('text', { delta: 'Busy.' });
  });
  await waitFor(() => { expect(reply(chat).parts.map((part) => part.type)).toEqual(['thinking', 'text']); });
  expect(reply(chat).parts[0]).toMatchObject({ type: 'thinking', text: 'Weighing the weekend.' });
  expect(messageText(reply(chat))).toBe('Busy.');
  expect(reply(chat).startedAt).not.toBeNull();
  expect(reply(chat).endedAt).toBeNull();
  await act(() => {
    live.emit('done', { stopReason: 'end_turn', costUsd: 0 });
    live.end();
  });
  expect(reply(chat).endedAt).not.toBeNull();
});

test('a reply that ends early says why', () => {
  const rows: [string, string | null][] = [
    ['end_turn', null],
    ['max_tokens', 'The reply hit its length limit.'],
    ['refusal', 'TownwiseAI can’t help with that. Your message and this reply weren’t saved.'],
    ['tool_limit', 'TownwiseAI stopped after too many lookups. Ask again to continue.'],
    ['budget', 'TownwiseAI stopped here because this month’s budget is used up.'],
  ];
  for (const [stopReason, note] of rows) {
    let state: TuningChatState = { ...initialChatState(), status: 'ready', enabled: true };
    state = chatReducer(state, { type: 'send', content: 'x', attachments: [], userKey: 'u', replyKey: 'r', request: { conversationId: null, content: 'x' } }, 0);
    state = chatReducer(state, { type: 'event', event: { type: 'proposal', id: 'p1', proposal: PROPOSAL }, key: 'k', at: '' }, 0);
    state = chatReducer(state, { type: 'event', event: { type: 'done', stopReason, leafId: null }, key: 'k', at: '' }, 0);
    expect(state.messages.at(-1)).toMatchObject({ state: 'complete', note });
    // A refused turn was never stored, so its proposal is not either.
    const last = state.messages.at(-1);
    expect(last === undefined ? null : cards(last)[0]?.stored).toBe(stopReason === 'refusal' ? 'lost' : 'kept');
  }
});

test('an error event marks the reply failed and unsaved, and says why', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('text', { delta: 'Partly' });
    turn(api).emit('proposal', PROPOSAL_EVENT);
    turn(api).emit('error', { code: 'provider_overloaded' });
    turn(api).end();
  });
  expect(reply(chat)).toMatchObject({ state: 'failed', note: NOT_SAVED });
  expect(messageText(reply(chat))).toBe('Partly');
  expect(cards(reply(chat))[0]?.stored).toBe('lost');
  expect(chat.current.state).toMatchObject({ streaming: false, error: 'TownwiseAI is busy. Try again in a minute.' });
});

test('a turn past the server’s time limit is marked unsaved and asks for something shorter', () => {
  let state: TuningChatState = { ...initialChatState(), status: 'ready', enabled: true };
  state = chatReducer(state, { type: 'send', content: 'x', attachments: [], userKey: 'u', replyKey: 'r', request: { conversationId: null, content: 'x' } }, 0);
  state = chatReducer(state, { type: 'event', event: { type: 'text', delta: 'Partly' }, key: 'k1', at: '' }, 0);
  state = chatReducer(state, { type: 'event', event: { type: 'error', code: 'timeout' }, key: 'k2', at: '' }, 0);
  expect(state.messages.at(-1)).toMatchObject({ state: 'failed', note: NOT_SAVED });
  expect(state.error).toBe(TIMED_OUT);
});

test('Stop aborts the stream and keeps the partial reply, marked stopped', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('tool', { id: 't1', name: 'list_notes', state: 'running', input: null, result: null });
    turn(api).emit('text', { delta: 'Half a rep' });
  });
  await act(() => { chat.current.stop(); });
  expect(turn(api).signal?.aborted).toBe(true);
  await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
  expect(reply(chat)).toMatchObject({ state: 'stopped', note: STOPPED });
  expect(messageText(reply(chat))).toBe('Half a rep');
  expect(chat.current.state.error).toBeNull();
  const [asked] = chat.current.state.messages;
  expect(asked === undefined ? null : messageText(asked)).toBe('Hello');
});

test('a stream that closes without done is cut off', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('text', { delta: 'Some' });
    turn(api).end();
  });
  expect(reply(chat)).toMatchObject({ state: 'failed', note: NOT_SAVED });
  expect(chat.current.state.error).toBe(CUT_OFF);
});

const UNSAVED_FIRST_TURNS: [string, (chat: { current: TuningChat }, live: LiveTurn) => Promise<void>][] = [
  ['Stop', async (chat) => { await act(() => { chat.current.stop(); }); }],
  ['provider_overloaded', async (_chat, live) => {
    await act(() => {
      live.emit('error', { code: 'provider_overloaded' });
      live.end();
    });
  }],
  ['a refusal', async (_chat, live) => {
    await act(() => {
      live.emit('done', { stopReason: 'refusal', costUsd: 0.01 });
      live.end();
    });
  }],
];

test.each(UNSAVED_FIRST_TURNS)('a first turn ended by %s saved nothing: its conversation goes, and the next send starts a new one', async (_how, finish) => {
  const api = fakeChatApi();
  const chat = await ready(api);
  // The re-read after the turn fails, so only the hook itself can drop the conversation from the list.
  api.chatError = new ApiError('network', 'The network request failed.');
  await send(chat, 'Closed Monday');
  await act(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'Closed Monday' });
    turn(api).emit('text', { delta: 'Partly' });
  });
  expect(chat.current.state.conversationId).toBe('c2');

  await finish(chat, turn(api));
  await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
  expect(chat.current.state.conversationId).toBeNull();
  expect(chat.current.state.conversations.map((item) => item.id)).toEqual(['c1']);
  expect(messageText(reply(chat))).toBe('Partly');

  await send(chat, 'Closed Tuesday');
  expect(turn(api, 1).body).toEqual({ content: 'Closed Tuesday' });
});

test('a dropped connection keeps the partial reply as failed; one before any reply takes the turn back', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('text', { delta: 'Some' });
    turn(api).fail(new ApiError('network', 'The connection closed before the reply finished.'));
  });
  expect(reply(chat)).toMatchObject({ state: 'failed', note: NOT_SAVED });
  expect(messageText(reply(chat))).toBe('Some');
  expect(chat.current.state.error).toBe("Can't reach the server.");

  await send(chat, 'Again');
  await act(() => { turn(api, 1).fail(new ApiError('network', 'The network request failed.')); });
  expect(chat.current.state.messages).toHaveLength(2);
  expect(chat.current.state.draft).toBe('Again');
});

test('Try again sends a failed reply’s message again as a new turn, in its place', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Closed Monday');
  await act(() => {
    turn(api).emit('text', { delta: 'Some' });
    turn(api).emit('error', { code: 'provider_unavailable' });
    turn(api).end();
  });
  await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
  await act(() => { chat.current.setDraft('Something new'); });
  await act(() => { chat.current.retry(reply(chat).key); });
  expect(turn(api, 1).body).toEqual({ content: 'Closed Monday' });
  expect(chat.current.state.messages.map((message) => [message.role, messageText(message), message.state])).toEqual([
    ['user', 'Closed Monday', 'complete'],
    ['assistant', '', 'streaming'],
  ]);
  // What the person was typing stays.
  expect(chat.current.state.draft).toBe('Something new');
});

test('a refused turn is taken back and its text returns to the composer', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  const rows: [ApiError, string][] = [
    [refusal(409, 'chat_turn_in_progress'), 'You already have a reply in progress, maybe in another tab or location. Wait for it to finish, then try again.'],
    [refusal(409, 'conversation_full'), 'This conversation is full. Start a new chat.'],
    [refusal(403, 'view_as_read_only'), 'View-as is read-only, so you can’t send messages.'],
    [new ApiError('http', 'The request was refused.', { status: 429, code: 'rate_limited', retryAfterSeconds: 90 }), 'You’ve sent a lot of messages. Try again in 2 minutes.'],
  ];
  for (const [error, text] of rows) {
    api.refuse = error;
    await send(chat, 'Closed Monday');
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(chat.current.state).toMatchObject({ messages: [], draft: 'Closed Monday', error: text });
  }
});

test('budget used up: the GET turns Send off, a 409 turns the budget to used up, and so does done budget', async () => {
  const api = fakeChatApi();
  api.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 20, exhausted: true } };
  const spent = await ready(api);
  await act(() => { spent.current.setDraft('Hello'); });
  expect(canSend(spent.current.state)).toBe(false);
  await act(() => { spent.current.send(); });
  await act(() => { spent.current.ask('How did last week go?'); });
  expect(api.turns).toHaveLength(0);

  const fresh = fakeChatApi();
  const chat = await ready(fresh);
  fresh.refuse = refusal(409, 'chat_budget_exhausted');
  fresh.chatError = new ApiError('network', 'The network request failed.');
  await send(chat, 'Hello');
  await waitFor(() => { expect(chat.current.state.budget?.exhausted).toBe(true); });
  expect(chat.current.state).toMatchObject({ error: null, draft: 'Hello', messages: [] });

  const later = fakeChatApi();
  const ending = await ready(later);
  later.chatError = new ApiError('network', 'The network request failed.');
  await send(ending, 'Hello');
  await act(() => {
    turn(later).emit('text', { delta: 'Here is what I found.' });
    turn(later).emit('done', { stopReason: 'budget', costUsd: 0.02 });
    turn(later).end();
  });
  await waitFor(() => { expect(ending.current.state.streaming).toBe(false); });
  expect(reply(ending)).toMatchObject({ state: 'complete', note: BUDGET_SPENT });
  expect(ending.current.state.budget?.exhausted).toBe(true);
});

test('off: the GET says disabled, and a 503 re-reads it', async () => {
  const off = fakeChatApi();
  off.summary = { ...SUMMARY, enabled: false };
  const disabled = await ready(off);
  expect(disabled.current.state.enabled).toBe(false);

  const api = fakeChatApi();
  const chat = await ready(api);
  api.refuse = refusal(503, null);
  api.summary = { ...SUMMARY, enabled: false };
  await send(chat, 'Hello');
  await waitFor(() => { expect(chat.current.state.enabled).toBe(false); });
  expect(chat.current.state.error).toBe('TownwiseAI isn’t turned on yet.');
});

describe('proposal cards', () => {
  test('a live card waits for its turn to be stored', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await send(chat, 'Holidays');
    await act(() => { turn(api).emit('proposal', PROPOSAL_EVENT); });
    await act(() => {
      chat.current.save(PROPOSAL_ID);
      chat.current.dismiss(PROPOSAL_ID);
    });
    expect(api.writes).toEqual([]);
    expect(card(chat, PROPOSAL_ID).status).toBe('open');
  });

  test('Save note saves the proposal as shown through the proposal route, once', async () => {
    const api = fakeChatApi();
    const added = jest.fn();
    const chat = await ready(api, { onNoteAdded: added });
    await proposed(api, chat);
    let release: (value: unknown) => void = () => undefined;
    const path = `/api/org/locations/l1/chat/c2/proposals/${PROPOSAL_ID}`;
    api.respond[path] = () => new Promise((resolve) => { release = resolve; });
    await act(() => { chat.current.save(PROPOSAL_ID); });
    expect(card(chat, PROPOSAL_ID).status).toBe('saving');
    await act(() => { chat.current.save(PROPOSAL_ID); });
    expect(api.writes).toEqual([{ method: 'POST', path, body: { action: 'save' } }]);
    await act(() => {
      release({ proposal: { id: PROPOSAL_ID, status: 'saved', noteId: 'n1', edited: false }, note: null });
    });
    expect(card(chat, PROPOSAL_ID)).toMatchObject({ status: 'saved', edited: false, error: null });
    expect(added).toHaveBeenCalledTimes(1);
  });

  test('Edit first saves the person’s edit through the same route; a refusal goes back to the form', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await proposed(api, chat);
    await act(() => { chat.current.edit(PROPOSAL_ID); });
    expect(card(chat, PROPOSAL_ID).status).toBe('editing');
    const edit = { ...PROPOSAL, endDate: '2026-12-27', weekdays: null };
    const path = `/api/org/locations/l1/chat/c2/proposals/${PROPOSAL_ID}`;
    api.respond[path] = () => refusal(409, 'note_limit');
    let failure: unknown = null;
    await act(async () => { await chat.current.saveEdited(PROPOSAL_ID, edit).catch((error: unknown) => { failure = error; }); });
    expect(failure).toMatchObject({ code: 'note_limit' });
    // The form shows its own error; the card keeps none.
    expect(card(chat, PROPOSAL_ID)).toMatchObject({ status: 'editing', error: null });
    Reflect.deleteProperty(api.respond, path);
    await act(() => chat.current.saveEdited(PROPOSAL_ID, edit));
    expect(api.writes.at(-1)).toEqual({ method: 'POST', path, body: { action: 'save', note: edit } });
    expect(card(chat, PROPOSAL_ID)).toMatchObject({ status: 'saved', edited: true });
  });

  test('Not now is recorded, and the card can be shown and saved later', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await proposed(api, chat);
    await act(() => { chat.current.dismiss(PROPOSAL_ID); });
    const path = `/api/org/locations/l1/chat/c2/proposals/${PROPOSAL_ID}`;
    expect(api.writes).toEqual([{ method: 'POST', path, body: { action: 'dismiss' } }]);
    await waitFor(() => { expect(card(chat, PROPOSAL_ID).status).toBe('dismissed'); });
    await act(() => { chat.current.reopen(PROPOSAL_ID); });
    expect(card(chat, PROPOSAL_ID).status).toBe('open');
    await act(() => { chat.current.save(PROPOSAL_ID); });
    await waitFor(() => { expect(card(chat, PROPOSAL_ID).status).toBe('saved'); });
  });

  test('errors stay on the card: the note limit, a bad note, and a proposal the server no longer has', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await proposed(api, chat);
    const path = `/api/org/locations/l1/chat/c2/proposals/${PROPOSAL_ID}`;
    const rows: [ApiError, string][] = [
      [refusal(409, 'note_limit'), 'This location has 1,000 notes. Delete old ones to add more.'],
      [refusal(400, 'invalid_request'), 'Townwise couldn’t accept this note. Edit it or ask TownwiseAI to fix it.'],
      [new ApiError('network', 'The network request failed.'), 'Couldn’t save the note. Try again.'],
    ];
    for (const [error, text] of rows) {
      api.respond[path] = () => error;
      await act(() => { chat.current.save(PROPOSAL_ID); });
      await waitFor(() => { expect(card(chat, PROPOSAL_ID)).toMatchObject({ status: 'open', error: text, gone: false }); });
    }
    api.respond[path] = () => refusal(404, 'not_found');
    await act(() => { chat.current.save(PROPOSAL_ID); });
    await waitFor(() => { expect(card(chat, PROPOSAL_ID)).toMatchObject({ gone: true, error: 'This conversation or note wasn’t found.' }); });
  });

  test('a card from a reply the server never kept saves through the notes route', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await send(chat, 'Holidays');
    await act(() => {
      turn(api).emit('conversation', { id: 'c2', title: 'Holidays' });
      turn(api).emit('proposal', PROPOSAL_EVENT);
      turn(api).emit('error', { code: 'internal' });
      turn(api).end();
    });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(card(chat, PROPOSAL_ID).stored).toBe('lost');
    await act(() => { chat.current.save(PROPOSAL_ID); });
    await waitFor(() => { expect(card(chat, PROPOSAL_ID).status).toBe('saved'); });
    expect(api.writes).toEqual([{ method: 'POST', path: '/api/org/locations/l1/notes', body: PROPOSAL }]);
  });
});

describe('item cards (D28)', () => {
  const ITEM_ID = 'toolu_item_0001';
  const shownCall = (id: string, shown: boolean, state: 'running' | 'done'): Record<string, unknown> => ({
    id, name: 'propose_data_item', state, input: { chars: 21 }, result: state === 'done' ? { shown } : null,
  });

  function items(message: ChatMessage): ItemCard[] {
    return message.parts.flatMap((part) => (part.type === 'item' ? [part.card] : []));
  }

  test('a shown propose_data_item call is an item card that waits for its turn; one that showed nothing is no card and no row', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await send(chat, 'Keep this list');
    await act(() => {
      turn(api).emit('conversation', { id: 'c2', title: 'Keep this list' });
      turn(api).emit('tool', shownCall(ITEM_ID, true, 'running'));
      turn(api).emit('tool', shownCall(ITEM_ID, true, 'done'));
      turn(api).emit('tool', shownCall('toolu_item_0002', false, 'done'));
    });
    expect(items(reply(chat))).toEqual([{ id: ITEM_ID, conversationId: 'c2', stored: 'pending' }]);
    // Neither call is a tool row, so neither is in the Based on line.
    expect(stepsOf(reply(chat))).toEqual([]);
    await act(() => {
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(items(reply(chat))).toEqual([{ id: ITEM_ID, conversationId: 'c2', stored: 'kept' }]);
  });

  test('a reply the server never kept leaves its item card with nothing to keep', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await send(chat, 'Keep this list');
    await act(() => {
      turn(api).emit('conversation', { id: 'c2', title: 'Keep this list' });
      turn(api).emit('tool', shownCall(ITEM_ID, true, 'done'));
    });
    await act(() => { chat.current.stop(); });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(items(reply(chat))).toEqual([{ id: ITEM_ID, conversationId: 'c2', stored: 'lost' }]);
  });

  test('opening a conversation replays a shown call as its item card, and the card reads and keeps through its own route', async () => {
    const api = fakeChatApi();
    const path = `/api/org/locations/l1/chat/c1/item-proposals/${ITEM_ID}`;
    const view = { id: ITEM_ID, title: 'Catering list', text: 'Party of 40 on Dec 12', status: 'open', item: null };
    api.reads[path] = () => ({ proposal: view });
    api.respond[path] = () => ({ proposal: { ...view, status: 'dismissed' } });
    api.conversation = {
      ...CONVERSATION,
      messages: [
        { role: 'user', text: 'Keep this list.', proposals: [], parts: [], at: '2026-11-02T14:59:00.000Z' },
        {
          role: 'assistant', text: 'I showed it to you.', proposals: [], at: '2026-11-02T15:00:00.000Z',
          parts: [{ type: 'tool', ...shownCall(ITEM_ID, true, 'done') }, { type: 'tool', ...shownCall('toolu_item_0002', false, 'done') }, { type: 'text', text: 'I showed it to you.' }],
        },
      ],
    };
    const chat = await ready(api);
    await act(() => { chat.current.openConversation('c1'); });
    await waitFor(() => { expect(chat.current.state.conversationLoading).toBe(false); });
    const [itemCard] = items(reply(chat));
    expect(items(reply(chat))).toEqual([{ id: ITEM_ID, conversationId: 'c1', stored: 'kept' }]);
    if (itemCard === undefined) throw new Error('no item card');
    expect(stepsOf(reply(chat))).toEqual([]);
    expect(await chat.current.loadItem(itemCard)).toEqual(view);
    expect(await chat.current.setItemAside(itemCard)).toMatchObject({ status: 'dismissed' });
    expect(api.writes).toEqual([{ method: 'POST', path, body: { action: 'dismiss' } }]);
  });
});

test('opening a conversation replays its parts and what became of each proposal; New conversation clears them', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await act(() => { chat.current.openConversation('c1'); });
  await waitFor(() => { expect(chat.current.state.conversationLoading).toBe(false); });
  const [asked, answered] = chat.current.state.messages;
  expect(asked === undefined ? null : messageText(asked)).toBe(CONVERSATION.messages[0]?.text);
  expect(answered?.parts.map((part) => part.type)).toEqual(['thinking', 'text', 'tools', 'text', 'proposal']);
  expect(answered === undefined ? [] : stepsOf(answered)).toEqual([{ ...SALES_STEP, state: 'done' }]);
  expect(answered === undefined ? [] : cards(answered)).toEqual([expect.objectContaining({ id: PROPOSAL_ID, status: 'open', stored: 'kept', proposal: PROPOSAL })]);

  await send(chat, 'One more');
  expect(turn(api).body).toEqual({ conversationId: 'c1', content: 'One more', parentId: 'a1' });
  await act(() => { chat.current.newConversation(); });
  expect(chat.current.state.messages).toHaveLength(4);
  await act(() => { turn(api).end(); });
  await act(() => { chat.current.newConversation(); });
  expect(chat.current.state).toMatchObject({ conversationId: null, messages: [] });
});

test('a propose_note call that got an error replays hidden, as it streamed', async () => {
  const api = fakeChatApi();
  const failed = { type: 'tool', id: 'toolu_test_0003', name: 'propose_note', state: 'error', input: null, result: null };
  const [asked] = CONVERSATION.messages;
  api.conversation = {
    ...CONVERSATION,
    messages: [asked, {
      role: 'assistant', text: 'Last December you were open every day.', proposals: [], at: '2026-11-02T15:00:00.000Z',
      parts: [
        { type: 'text', text: 'Last December you were open every day.' }, { type: 'tool', state: 'done', ...SALES_STEP }, failed,
        { type: 'text', text: 'I couldn’t write that note.' }, failed,
      ],
    }],
  };
  const chat = await ready(api);
  await act(() => { chat.current.openConversation('c1'); });
  await waitFor(() => { expect(chat.current.state.conversationLoading).toBe(false); });
  const answered = chat.current.state.messages[1];
  expect(answered?.parts.map((part) => part.type)).toEqual(['text', 'tools', 'text']);
  expect(answered === undefined ? [] : stepsOf(answered)).toEqual([{ ...SALES_STEP, state: 'done' }]);
});

test('deleting a conversation removes it from the list, and deleting the open one starts a new one', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await act(() => { chat.current.openConversation('c1'); });
  await waitFor(() => { expect(chat.current.state.messages).toHaveLength(2); });
  await act(() => chat.current.deleteConversation('c1'));
  expect(api.writes).toEqual([{ method: 'DELETE', path: '/api/org/locations/l1/chat/c1', body: undefined }]);
  expect(chat.current.state).toMatchObject({ conversationId: null, messages: [], conversations: [] });

  const failing = fakeChatApi();
  const kept = await ready(failing);
  failing.respond['/api/org/locations/l1/chat/c1'] = () => refusal(404, 'not_found');
  let failure: unknown = null;
  await act(async () => { await kept.current.deleteConversation('c1').catch((error: unknown) => { failure = error; }); });
  expect(failure).toMatchObject({ status: 404 });
  expect(kept.current.state.conversations).toHaveLength(1);
});

test('a location outside the organization is not found; other failures can be retried', async () => {
  const missing = fakeChatApi();
  missing.chatError = refusal(404, 'not_found');
  const { result: notFound } = await renderHook(hook(missing));
  await waitFor(() => { expect(notFound.current.state.status).toBe('not_found'); });

  const api = fakeChatApi();
  api.chatError = new ApiError('network', 'The network request failed.');
  const { result } = await renderHook(hook(api));
  await waitFor(() => { expect(result.current.state.status).toBe('failed'); });
  expect(result.current.state.loadError).toBe("Can't reach the server.");
  api.chatError = null;
  await act(() => { result.current.reload(); });
  await waitFor(() => { expect(result.current.state.status).toBe('ready'); });
});

test('leaving the screen aborts a live turn', async () => {
  const api = fakeChatApi();
  const { result, unmount } = await renderHook(hook(api));
  await waitFor(() => { expect(result.current.state.status).toBe('ready'); });
  await act(() => { result.current.setDraft('Hello'); });
  await act(() => { result.current.send(); });
  await unmount();
  expect(turn(api).signal?.aborted).toBe(true);
});

// Conversation trees (docs/portal/tuning-chat.md 2 and 3): the shown path, edits, regenerates and versions.

const AT = '2026-11-02T15:00:00.000Z';

function stored(nodeId: string, role: 'user' | 'assistant', text: string): Record<string, unknown> {
  return { nodeId, role, text, proposals: [], parts: role === 'assistant' ? [{ type: 'text', text }] : [], at: AT };
}

const U1 = stored('u1', 'user', 'first');
const A1 = stored('a1', 'assistant', 'reply 1');
const U2 = stored('u2', 'user', 'second');
const A2 = stored('a2', 'assistant', 'reply 2');

/** u1 → a1 → u2 → a2, shown. */
const PATH = {
  id: 'c1', title: 'Earlier chat', updatedAt: AT, activeLeafId: 'a2',
  tree: [
    { id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' },
    { id: 'u2', parentId: 'a1', role: 'user' }, { id: 'a2', parentId: 'u2', role: 'assistant' },
  ],
  messages: [U1, A1, U2, A2],
};

/** PATH with u2 edited once (u2b → a2b); a2's path is shown. */
const BRANCHED = {
  ...PATH,
  tree: [...PATH.tree, { id: 'u2b', parentId: 'a1', role: 'user' }, { id: 'a2b', parentId: 'u2b', role: 'assistant' }],
};
const EDITED_PATH = { ...BRANCHED, activeLeafId: 'a2b', messages: [U1, A1, stored('u2b', 'user', 'second, edited'), stored('a2b', 'assistant', 'reply 2b')] };

const THREE = ['How did Monday go?', 'Any events next week?', 'Show last month'];

function shown(chat: { current: TuningChat }): [string, string, ChatMessage['state']][] {
  return chat.current.state.messages.map((message) => [message.role, messageText(message), message.state]);
}

function at(chat: { current: TuningChat }, index: number): ChatMessage {
  const message = chat.current.state.messages[index];
  if (message === undefined) throw new Error(`no message ${String(index)}`);
  return message;
}

describe('versions', () => {
  test('sends after the shown leaf, and records the new nodes and leaf on done', async () => {
    const api = fakeChatApi();
    api.conversation = PATH;
    const chat = await ready(api);
    await opened(chat);
    expect(chat.current.state).toMatchObject({ leafId: 'a2', tree: PATH.tree, switching: false });
    expect(chat.current.state.messages.map((message) => [message.nodeId, message.parentId])).toEqual([['u1', null], ['a1', 'u1'], ['u2', 'a1'], ['a2', 'u2']]);

    await send(chat, 'third');
    expect(turn(api).body).toEqual({ conversationId: 'c1', content: 'third', parentId: 'a2' });
    await act(() => {
      turn(api).emit('conversation', { id: 'c1', title: 'Earlier chat', userNodeId: 'u3', replyNodeId: 'a3', parentId: 'a2' });
      turn(api).emit('text', { delta: 'reply 3' });
    });
    // Nothing is stored until the turn ends with a saved stop.
    expect(chat.current.state.tree).toHaveLength(4);
    expect(chat.current.state.messages.slice(-2).map((message) => message.nodeId)).toEqual([null, null]);
    await act(() => {
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: 'a3' });
      turn(api).end();
    });
    expect(chat.current.state.leafId).toBe('a3');
    expect(chat.current.state.tree.map((node) => node.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    expect(chat.current.state.messages.slice(-2).map((message) => [message.nodeId, message.parentId])).toEqual([['u3', 'a2'], ['a3', 'u3']]);

    // A refused turn stores nothing: the tree and the leaf stay.
    await send(chat, 'fourth');
    expect(turn(api, 1).body).toEqual({ conversationId: 'c1', content: 'fourth', parentId: 'a3' });
    await act(() => {
      turn(api, 1).emit('conversation', { id: 'c1', title: 'Earlier chat', userNodeId: 'u4', replyNodeId: 'a4', parentId: 'a3' });
      turn(api, 1).emit('done', { stopReason: 'refusal', costUsd: 0, leafId: null });
      turn(api, 1).end();
    });
    expect(chat.current.state).toMatchObject({ leafId: 'a3', streaming: false });
    expect(chat.current.state.tree).toHaveLength(6);

    // A reply with nothing in it stores the person's message only, and the leaf is that message.
    await send(chat, 'fifth');
    expect(turn(api, 2).body).toEqual({ conversationId: 'c1', content: 'fifth', parentId: 'a3' });
    await act(() => {
      turn(api, 2).emit('conversation', { id: 'c1', title: 'Earlier chat', userNodeId: 'u5', replyNodeId: 'a5', parentId: 'a3' });
      turn(api, 2).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: 'u5' });
      turn(api, 2).end();
    });
    expect(chat.current.state.leafId).toBe('u5');
    expect(chat.current.state.tree.map((node) => node.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u5']);
    expect(chat.current.state.messages.slice(-2).map((message) => message.nodeId)).toEqual(['u5', null]);
  });

  test('with no tree known, a send names no parent, so the server adds it after the leaf it has stored', async () => {
    // The conversation didn't open, so the page shows none of its path; a null parent would start a second first message.
    const api = fakeChatApi();
    api.conversation = new ApiError('network', 'The network request failed.');
    const chat = await ready(api);
    await opened(chat);
    expect(chat.current.state).toMatchObject({ conversationId: 'c1', messages: [], tree: [], leafId: null });
    await send(chat, 'after the stored leaf');
    expect(turn(api).body).toEqual({ conversationId: 'c1', content: 'after the stored leaf' });

    // A server without trees: its conversation reads as one path with no node ids, and a send names no parent either.
    const old = fakeChatApi();
    old.conversation = {
      id: CONVERSATION.id, title: CONVERSATION.title, updatedAt: CONVERSATION.updatedAt,
      messages: CONVERSATION.messages.map(({ role, text, proposals, parts, at }) => ({ role, text, proposals, parts, at })),
    };
    const earlier = await ready(old);
    await opened(earlier);
    expect(earlier.current.state.messages.map((message) => message.nodeId)).toEqual([null, null]);
    await send(earlier, 'one more');
    expect(turn(old).body).toEqual({ conversationId: 'c1', content: 'one more' });
    await act(() => {
      turn(old).emit('conversation', { id: 'c1', title: 'Earlier chat' });
      turn(old).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(old).end();
    });
    expect(earlier.current.state).toMatchObject({ tree: [], leafId: null, streaming: false });
    await send(earlier, 'and another');
    expect(turn(old, 1).body).toEqual({ conversationId: 'c1', content: 'and another' });
  });

  test('edit drops the later messages, sends with the edited message’s parent, and the edited message gets a second version', async () => {
    const api = fakeChatApi();
    api.conversation = PATH;
    const chat = await ready(api);
    await opened(chat);
    await act(() => { chat.current.setDraft('kept in the composer'); });

    // Only a saved message of the person's, with something in it, while nothing streams.
    await act(() => { chat.current.editMessage(at(chat, 1).key, 'a reply'); });
    await act(() => { chat.current.editMessage(at(chat, 2).key, '   '); });
    expect(api.turns).toHaveLength(0);

    await act(() => { chat.current.editMessage(at(chat, 2).key, '  second, edited  '); });
    expect(turn(api).body).toEqual({ conversationId: 'c1', content: 'second, edited', parentId: 'a1' });
    expect(shown(chat)).toEqual([
      ['user', 'first', 'complete'], ['assistant', 'reply 1', 'complete'], ['user', 'second, edited', 'complete'], ['assistant', '', 'streaming'],
    ]);
    expect(chat.current.state).toMatchObject({ leafId: 'a1', draft: 'kept in the composer' });
    expect(at(chat, 3).request).toEqual({ conversationId: 'c1', content: 'second, edited', parentId: 'a1' });

    await act(() => {
      turn(api).emit('conversation', { id: 'c1', title: 'Earlier chat', userNodeId: 'u2b', replyNodeId: 'a2b', parentId: 'a1' });
      turn(api).emit('text', { delta: 'reply 2b' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: 'a2b' });
      turn(api).end();
    });
    expect(at(chat, 2)).toMatchObject({ nodeId: 'u2b', parentId: 'a1' });
    expect(versionsOf(chat.current.state.tree, 'u2b')).toEqual({ index: 2, count: 2, ids: ['u2', 'u2b'] });
    expect(chat.current.state.leafId).toBe('a2b');

    // Editing the first message starts a second root.
    await act(() => { chat.current.editMessage(at(chat, 0).key, 'first, edited'); });
    expect(turn(api, 1).body).toEqual({ conversationId: 'c1', content: 'first, edited', parentId: null });
    expect(shown(chat)).toEqual([['user', 'first, edited', 'complete'], ['assistant', '', 'streaming']]);
    expect(chat.current.state.leafId).toBeNull();
  });

  test('an edit the server refuses stays in place with Try again, which sends the edit again', async () => {
    const api = fakeChatApi();
    api.conversation = PATH;
    const chat = await ready(api);
    await opened(chat);
    api.refuse = refusal(409, 'chat_turn_in_progress');
    await act(() => { chat.current.editMessage(at(chat, 2).key, 'second, edited'); });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(shown(chat)).toEqual([
      ['user', 'first', 'complete'], ['assistant', 'reply 1', 'complete'], ['user', 'second, edited', 'complete'], ['assistant', '', 'failed'],
    ]);
    expect(chat.current.state).toMatchObject({ draft: '', leafId: 'a1' });
    expect(chat.current.state.error).toMatch(/already have a reply in progress/);

    api.refuse = null;
    await act(() => { chat.current.retry(at(chat, 3).key); });
    expect(turn(api).body).toEqual({ conversationId: 'c1', content: 'second, edited', parentId: 'a1' });
    expect(chat.current.state.messages).toHaveLength(4);
  });

  test('regenerate streams a sibling reply; a stopped regenerate puts the earlier reply back with the reason', async () => {
    const api = fakeChatApi();
    api.conversation = PATH;
    const chat = await ready(api);
    await opened(chat);

    // The newest reply only.
    await act(() => { chat.current.regenerate(at(chat, 1).key); });
    await act(() => { chat.current.regenerate(at(chat, 2).key); });
    expect(api.turns).toHaveLength(0);

    await act(() => { chat.current.regenerate(at(chat, 3).key); });
    expect(turn(api).body).toEqual({ conversationId: 'c1', replyTo: 'u2' });
    expect(shown(chat)).toEqual([
      ['user', 'first', 'complete'], ['assistant', 'reply 1', 'complete'], ['user', 'second', 'complete'], ['assistant', '', 'streaming'],
    ]);
    expect(at(chat, 3)).toMatchObject({ parentId: 'u2', nodeId: null });
    expect(chat.current.state.leafId).toBe('u2');
    await act(() => {
      turn(api).emit('conversation', { id: 'c1', title: 'Earlier chat', userNodeId: null, replyNodeId: 'a2b', parentId: 'u2' });
      turn(api).emit('text', { delta: 'reply 2, again' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: 'a2b' });
      turn(api).end();
    });
    expect(at(chat, 3)).toMatchObject({ nodeId: 'a2b', parentId: 'u2', state: 'complete' });
    expect(versionsOf(chat.current.state.tree, 'a2b')).toEqual({ index: 2, count: 2, ids: ['a2', 'a2b'] });
    expect(chat.current.state).toMatchObject({ leafId: 'a2b', error: null });

    const earlier = at(chat, 3);
    await act(() => { chat.current.regenerate(earlier.key); });
    await act(() => { turn(api, 1).emit('text', { delta: 'Half a rep' }); });
    await act(() => { chat.current.stop(); });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(at(chat, 3)).toEqual(earlier);
    expect(chat.current.state.messages).toHaveLength(4);
    expect(chat.current.state).toMatchObject({ leafId: 'a2b', error: REGENERATE_FAILED });
    expect(chat.current.state.tree).toHaveLength(5);

    // So does one that fails or is refused.
    await act(() => { chat.current.regenerate(earlier.key); });
    await act(() => {
      turn(api, 2).emit('error', { code: 'provider_overloaded' });
      turn(api, 2).end();
    });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(at(chat, 3)).toEqual(earlier);
    expect(chat.current.state.error).toBe(REGENERATE_FAILED);
    api.refuse = refusal(409, 'conversation_full');
    await act(() => { chat.current.regenerate(earlier.key); });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(at(chat, 3)).toEqual(earlier);
    expect(chat.current.state.error).toBe('This conversation is full. Start a new chat.');
  });

  test('showVersion replaces the shown path from the server and keeps the tree; under view-as it reads with ?node=', async () => {
    const api = fakeChatApi();
    api.conversation = BRANCHED;
    api.versions = { u2b: EDITED_PATH };
    const chat = await ready(api);
    await opened(chat);
    const path = '/api/org/locations/l1/chat/c1/active';
    let release: () => void = () => undefined;
    api.respond[path] = () => new Promise((resolve) => { release = () => { resolve(EDITED_PATH); }; });

    await act(() => { chat.current.showVersion(at(chat, 2).key, 1); });
    expect(api.writes).toEqual([{ method: 'POST', path, body: { nodeId: 'u2b' } }]);
    expect(chat.current.state.switching).toBe(true);
    await act(() => { chat.current.setDraft('Hello'); });
    expect(canSend(chat.current.state)).toBe(false);
    await act(() => { release(); });
    expect(chat.current.state).toMatchObject({ switching: false, leafId: 'a2b', tree: BRANCHED.tree, error: null });
    expect(shown(chat).map(([, text]) => text)).toEqual(['first', 'reply 1', 'second, edited', 'reply 2b']);
    expect(at(chat, 2)).toMatchObject({ nodeId: 'u2b', parentId: 'a1' });

    // Past either end, nothing is read.
    await act(() => { chat.current.showVersion(at(chat, 2).key, 1); });
    expect(api.writes).toHaveLength(1);

    api.respond[path] = () => refusal(500, null);
    const before = chat.current.state.messages;
    await act(() => { chat.current.showVersion(at(chat, 2).key, -1); });
    await waitFor(() => { expect(chat.current.state.switching).toBe(false); });
    expect(chat.current.state).toMatchObject({ error: VERSION_FAILED, leafId: 'a2b' });
    expect(chat.current.state.messages).toBe(before);

    const viewer = fakeChatApi();
    viewer.conversation = BRANCHED;
    viewer.versions = { u2b: EDITED_PATH };
    const staff = await ready(viewer, { readOnly: true });
    await opened(staff);
    await act(() => { staff.current.showVersion(at(staff, 2).key, 1); });
    await waitFor(() => { expect(staff.current.state.leafId).toBe('a2b'); });
    expect(viewer.writes).toEqual([]);
    expect(viewer.conversationReads).toEqual(['/api/org/locations/l1/chat/c1', '/api/org/locations/l1/chat/c1?node=u2b']);
    expect(shown(staff).map(([, text]) => text)).toEqual(['first', 'reply 1', 'second, edited', 'reply 2b']);
  });

  test('rate is optimistic, clears on null, and reverts with its message on failure', async () => {
    const api = fakeChatApi();
    api.conversation = PATH;
    const chat = await ready(api);
    await opened(chat);
    const path = '/api/org/locations/l1/chat/c1/feedback/a2';
    const replyKey = at(chat, 3).key;
    let release: () => void = () => undefined;
    api.respond[path] = () => new Promise((resolve) => { release = () => { resolve({ nodeId: 'a2', rating: 'up', reason: null }); }; });

    await act(() => { chat.current.rate(replyKey, 'up'); });
    expect(at(chat, 3).feedback).toEqual({ rating: 'up', reason: null });
    expect(api.writes).toEqual([{ method: 'POST', path, body: { rating: 'up' } }]);
    await act(() => { release(); });
    expect(at(chat, 3)).toMatchObject({ feedback: { rating: 'up', reason: null }, ratingError: null });

    Reflect.deleteProperty(api.respond, path);
    await act(() => { chat.current.rate(replyKey, 'down', 'missed_context'); });
    await waitFor(() => { expect(at(chat, 3).feedback).toEqual({ rating: 'down', reason: 'missed_context' }); });
    await act(() => { chat.current.rate(replyKey, null); });
    await waitFor(() => { expect(at(chat, 3).feedback).toBeNull(); });
    expect(api.writes.slice(1).map((write) => write.body)).toEqual([{ rating: 'down', reason: 'missed_context' }, { rating: null }]);

    // A person's message has no rating.
    await act(() => { chat.current.rate(at(chat, 2).key, 'up'); });
    expect(api.writes).toHaveLength(3);

    api.respond[path] = () => new ApiError('network', 'The network request failed.');
    await act(() => { chat.current.rate(replyKey, 'up'); });
    await waitFor(() => { expect(at(chat, 3).ratingError).toBe(RATING_FAILED); });
    expect(at(chat, 3).feedback).toBeNull();
    expect(chat.current.state.error).toBeNull();
  });

  test('rename changes the conversation’s title in the list, and rejects with the API’s error', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await act(() => chat.current.rename('c1', 'Holidays'));
    expect(api.writes).toEqual([{ method: 'PATCH', path: '/api/org/locations/l1/chat/c1', body: { title: 'Holidays' } }]);
    expect(chat.current.state.conversations.map((item) => [item.id, item.title])).toEqual([['c1', 'Holidays']]);

    api.respond['/api/org/locations/l1/chat/c1'] = () => refusal(400, 'invalid_request');
    let failure: unknown = null;
    await act(async () => { await chat.current.rename('c1', 'x'.repeat(61)).catch((error: unknown) => { failure = error; }); });
    expect(failure).toMatchObject({ status: 400 });
    expect(chat.current.state.conversations[0]?.title).toBe('Holidays');
  });
});

test('stop and send retries a 409 claim and keeps the text on a final failure', async () => {
  jest.useFakeTimers();
  try {
    const api = fakeChatApi();
    const chat = await ready(api);
    await opened(chat);
    await send(chat, 'Hello');
    await act(() => { turn(api).emit('text', { delta: 'Half a rep' }); });
    await act(() => { chat.current.setDraft('next'); });
    // The server releases the stopped turn's claim just after the connection closes.
    api.refusals = [refusal(409, 'chat_turn_in_progress'), refusal(409, 'chat_turn_in_progress')];
    await act(() => { chat.current.stopAndSend(); });
    // Tried at once and twice more, 500ms apart: the third try streams.
    await advance(999);
    expect(api.turns).toHaveLength(1);
    expect(api.refusals).toEqual([]);
    await advance(1);
    expect(turn(api).signal?.aborted).toBe(true);
    expect(api.turns).toHaveLength(2);
    expect(api.turns.at(-1)?.body).toMatchObject({ content: 'next', parentId: 'a1' });
    expect(shown(chat).slice(2)).toEqual([
      ['user', 'Hello', 'complete'], ['assistant', 'Half a rep', 'stopped'], ['user', 'next', 'complete'], ['assistant', '', 'streaming'],
    ]);
    expect(chat.current.state).toMatchObject({ draft: '', error: null });

    await act(() => { chat.current.setDraft('later'); });
    api.refusals = [1, 2, 3, 4].map(() => refusal(409, 'chat_turn_in_progress'));
    await act(() => { chat.current.stopAndSend(); });
    await advance(1500);
    expect(api.turns).toHaveLength(2);
    expect(api.refusals).toEqual([]);
    expect(chat.current.state).toMatchObject({ streaming: false, draft: 'later' });
    expect(chat.current.state.error).toMatch(/already have a reply in progress/);
    expect(shown(chat).at(-1)).toEqual(['assistant', '', 'stopped']);
  } finally {
    jest.useRealTimers();
  }
});

test('stop and send during a new conversation’s first reply starts the conversation again', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'Hello', userNodeId: 'u1', replyNodeId: 'a1', parentId: null });
    turn(api).emit('text', { delta: 'Half a rep' });
  });
  await act(() => { chat.current.setDraft('next'); });
  await act(() => { chat.current.stopAndSend(); });
  // The stopped turn saved nothing, so the server kept no conversation c2: the new send names none.
  await waitFor(() => { expect(api.turns).toHaveLength(2); });
  expect(turn(api, 1).body).toEqual({ content: 'next' });
  expect(chat.current.state).toMatchObject({ conversationId: null, leafId: null, draft: '' });
  expect(chat.current.state.conversations.map((item) => item.id)).toEqual(['c1']);
});

test('keeps a draft per conversation across opening another and coming back', async () => {
  const api = fakeChatApi();
  const who = { userId: 'drafts-person' };
  const first = await renderHook(hook(api, who));
  const chat = first.result;
  await waitFor(() => { expect(chat.current.state.status).toBe('ready'); });
  await act(() => { chat.current.setDraft('a new question'); });
  await opened(chat);
  expect(chat.current.state.draft).toBe('');
  await act(() => { chat.current.setDraft('about c1'); });
  await act(() => { chat.current.newConversation(); });
  expect(chat.current.state.draft).toBe('a new question');
  await opened(chat);
  expect(chat.current.state.draft).toBe('about c1');

  // Leaving the page and coming back in the same session.
  await first.unmount();
  const again = (await renderHook(hook(api, who))).result;
  await waitFor(() => { expect(again.current.state.status).toBe('ready'); });
  expect(again.current.state.draft).toBe('a new question');
  await opened(again);
  expect(again.current.state.draft).toBe('about c1');

  // What's typed while a new conversation's first reply streams belongs to that conversation once it has an id.
  await act(() => { again.current.newConversation(); });
  await send(again, 'a new question');
  expect(again.current.state.draft).toBe('');
  await act(() => { again.current.setDraft('typed while it streams'); });
  await act(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'A new question', userNodeId: 'u1', replyNodeId: 'a1', parentId: null });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: 'a1' });
    turn(api).end();
  });
  await waitFor(() => { expect(again.current.state.streaming).toBe(false); });
  await act(() => { again.current.newConversation(); });
  expect(again.current.state.draft).toBe('');
  await opened(again, 'c2');
  expect(again.current.state.draft).toBe('typed while it streams');

  // Another person on the same device starts with nothing.
  const someoneElse = await ready(api, { userId: 'another-person' });
  expect(someoneElse.current.state.draft).toBe('');
});

test('collects visual parts in order and next prompts on the reply', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Show me October');
  await act(() => {
    turn(api).emit('text', { delta: 'Here is October.' });
    turn(api).emit('tool', { id: 'toolu_v1', name: 'show_visual', state: 'running', input: null, result: null });
    turn(api).emit('tool', { id: 'toolu_v1', name: 'show_visual', state: 'done', input: null, result: null });
    turn(api).emit('visual', { id: 'toolu_v1', visual: daily });
    turn(api).emit('text', { delta: 'Busy weekend.' });
    turn(api).emit('tool', { id: 'toolu_n1', name: 'suggest_next', state: 'running', input: null, result: null });
    turn(api).emit('suggestions', { id: 'toolu_n1', prompts: THREE });
    turn(api).emit('tool', { id: 'toolu_n1', name: 'suggest_next', state: 'done', input: null, result: null });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: null });
    turn(api).end();
  });
  // The two tools show as the chart and the questions, never as tool rows.
  expect(reply(chat).parts.map((part) => part.type)).toEqual(['text', 'visual', 'text']);
  expect(reply(chat).parts[1]).toMatchObject({ type: 'visual', id: 'toolu_v1', visual: daily });
  expect(stepsOf(reply(chat))).toEqual([]);
  expect(reply(chat).next).toEqual(THREE);

  api.conversation = {
    ...PATH,
    messages: [U1, A1, U2, {
      ...A2, next: THREE,
      parts: [
        { type: 'text', text: 'Here is October.' }, { type: 'tool', id: 'toolu_v1', name: 'show_visual', state: 'done', input: null, result: null },
        { type: 'visual', id: 'toolu_v1', visual: daily }, { type: 'text', text: 'Busy weekend.' },
        { type: 'tool', id: 'toolu_n1', name: 'suggest_next', state: 'done', input: null, result: null },
      ],
    }],
  };
  await act(() => { chat.current.newConversation(); });
  await opened(chat);
  expect(reply(chat).parts.map((part) => part.type)).toEqual(['text', 'visual', 'text']);
  expect(reply(chat).next).toEqual(THREE);
  expect(at(chat, 1).next).toBeNull();
});

test('keeps text batching at FLUSH_MS: a burst of deltas draws within 32ms, with no pacing', async () => {
  jest.useFakeTimers();
  try {
    const api = fakeChatApi();
    const chat = await ready(api);
    await send(chat, 'Hello');
    const words = ['A ', 'long ', 'burst ', 'of ', 'words ', 'arriving ', 'at ', 'once.'];
    await act(() => { for (const word of words) turn(api).emit('text', { delta: word }); });
    expect(reply(chat).parts).toEqual([]);
    await advance(FLUSH_MS - 1);
    expect(reply(chat).parts).toEqual([]);
    // Everything that arrived is drawn in one go: no reveal paced over later frames.
    await advance(1);
    expect(messageText(reply(chat))).toBe(words.join(''));
  } finally {
    jest.useRealTimers();
  }
});

// Files on a message (D36): the composer hands them to send; a turn taken back gives them back; an edit sends the
// edited message's again, all but one gone from Your data; Try again sends its message's; a regenerate sends none.
describe('attachments', () => {
  const MENU = { ref: 'f_1111111111111111aaaaaaaa', kind: 'pdf', name: 'menu.pdf', state: 'on' } as const;
  const OLD = { ref: 'f_2222222222222222bbbbbbbb', kind: 'text', name: null, state: 'gone' } as const;
  const PATIO = { ref: 'f_3333333333333333cccccccc', kind: 'picture', name: 'patio.png', state: 'off' } as const;

  test('a send carries the files’ refs, and its message shows them', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    const returned = jest.fn();
    await act(() => { chat.current.setDraft('What does the menu say?'); });
    await act(() => { chat.current.send([MENU], returned); });
    expect(turn(api).body).toEqual({ content: 'What does the menu say?', attachments: [MENU.ref] });
    expect(at(chat, 0).attachments).toEqual([MENU]);
    expect(at(chat, 1).attachments).toEqual([]);
    await act(() => {
      turn(api).emit('conversation', { id: 'c2', title: 'What does the menu say?', userNodeId: 'u1', replyNodeId: 'a1', parentId: null });
      turn(api).emit('text', { delta: 'It lists brunch.' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0, leafId: 'a1' });
      turn(api).end();
    });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(returned).not.toHaveBeenCalled();
  });

  test('a turn taken back gives the files back with the text, and says why in words about the files', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    const returned = jest.fn();
    api.refuse = refusal(409, 'attachment_not_ready');
    await act(() => { chat.current.setDraft('Read this'); });
    await act(() => { chat.current.send([MENU], returned); });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(returned).toHaveBeenCalledTimes(1);
    expect(chat.current.state).toMatchObject({ messages: [], draft: 'Read this', error: 'An attached file is still uploading. Send your message once it’s ready.' });

    // A send that can't go at all gives them back at once.
    const busy = jest.fn();
    api.refuse = null;
    await act(() => { chat.current.send([MENU]); });
    await act(() => { chat.current.send([PATIO], busy); });
    expect(busy).toHaveBeenCalledTimes(1);
    expect(api.turns).toHaveLength(1);
  });

  test('a reply that fails after it started keeps the message, and Try again sends its files again', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    const returned = jest.fn();
    await act(() => { chat.current.setDraft('Read this'); });
    await act(() => { chat.current.send([MENU], returned); });
    await act(() => {
      turn(api).emit('text', { delta: 'Partly' });
      turn(api).emit('error', { code: 'provider_overloaded' });
      turn(api).end();
    });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    expect(returned).not.toHaveBeenCalled();
    await act(() => { chat.current.retry(at(chat, 1).key); });
    expect(turn(api, 1).body).toEqual({ content: 'Read this', attachments: [MENU.ref] });
    expect(at(chat, 0).attachments).toEqual([MENU]);
  });

  test('an edit sends the message’s files again, but not one gone from Your data; a regenerate sends none', async () => {
    const api = fakeChatApi();
    api.conversation = { ...PATH, messages: [U1, A1, { ...U2, attachments: [MENU, OLD, PATIO] }, A2] };
    const chat = await ready(api);
    await opened(chat);
    expect(at(chat, 2).attachments).toEqual([MENU, OLD, PATIO]);
    await act(() => { chat.current.regenerate(at(chat, 3).key); });
    expect(turn(api).body).toEqual({ conversationId: 'c1', replyTo: 'u2' });
    await act(() => { chat.current.stop(); });
    await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
    await act(() => { chat.current.editMessage(at(chat, 2).key, 'second, edited'); });
    expect(turn(api, 1).body).toEqual({ conversationId: 'c1', content: 'second, edited', parentId: 'a1', attachments: [MENU.ref, PATIO.ref] });
    expect(at(chat, 2).attachments).toEqual([MENU, PATIO]);
  });

  test('Stop and send carries the files, and a second press gives the first one’s back', async () => {
    const api = fakeChatApi();
    const chat = await ready(api);
    await send(chat, 'First');
    await act(() => { chat.current.setDraft('Now read this'); });
    const first = jest.fn();
    const second = jest.fn();
    await act(() => {
      chat.current.stopAndSend([MENU], first);
      chat.current.stopAndSend([PATIO], second);
    });
    expect(first).toHaveBeenCalledTimes(1);
    await waitFor(() => { expect(api.turns).toHaveLength(2); });
    expect(turn(api, 1).body).toEqual({ content: 'Now read this', attachments: [PATIO.ref] });
    expect(second).not.toHaveBeenCalled();
  });
});
