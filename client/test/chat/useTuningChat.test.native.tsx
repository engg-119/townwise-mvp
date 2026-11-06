import { act, renderHook, waitFor } from '@testing-library/react-native';

import { ApiError } from '../../src/api/client';
import {
  BUDGET_SPENT, canSend, chatReducer, CUT_OFF, FLUSH_MS, initialChatState, messageText, NOT_SAVED, STOPPED, stepsOf, TIMED_OUT,
  useTuningChat, type ChatMessage, type ProposalCard, type TuningChat, type TuningChatState,
} from '../../src/chat/useTuningChat';
import { CONVERSATION, fakeChatApi, PROPOSAL, PROPOSAL_ID, refusal, SALES_STEP, SUMMARY, type FakeChatApi, type LiveTurn } from '../helpers/chat';

async function ready(api: FakeChatApi, onNoteAdded?: () => void): Promise<{ current: TuningChat }> {
  const { result } = await renderHook(() => useTuningChat(api, 'l1', onNoteAdded));
  await waitFor(() => { expect(result.current.state.status).toBe('ready'); });
  return result;
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
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
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

  await act(() => { live.emit('conversation', { id: 'c2', title: 'Closed Christmas week' }); });
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

  await act(() => { live.emit('done', { stopReason: 'end_turn', costUsd: 0.02 }); });
  expect(reply(chat)).toMatchObject({ state: 'complete', note: null });
  expect(cards(reply(chat))[0]?.stored).toBe('kept');
  const loadsBefore = api.summaryLoads;
  await act(() => { live.end(); });
  expect(chat.current.state).toMatchObject({ streaming: false, error: null });
  await waitFor(() => { expect(api.summaryLoads).toBe(loadsBefore + 1); });

  await send(chat, 'And New Year’s Day?');
  expect(turn(api, 1).body).toEqual({ conversationId: 'c2', content: 'And New Year’s Day?' });
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
    state = chatReducer(state, { type: 'send', content: 'x', userKey: 'u', replyKey: 'r' });
    state = chatReducer(state, { type: 'event', event: { type: 'proposal', id: 'p1', proposal: PROPOSAL }, key: 'k', at: '' });
    state = chatReducer(state, { type: 'event', event: { type: 'done', stopReason }, key: 'k', at: '' });
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
  state = chatReducer(state, { type: 'send', content: 'x', userKey: 'u', replyKey: 'r' });
  state = chatReducer(state, { type: 'event', event: { type: 'text', delta: 'Partly' }, key: 'k1', at: '' });
  state = chatReducer(state, { type: 'event', event: { type: 'error', code: 'timeout' }, key: 'k2', at: '' });
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
    const chat = await ready(api, added);
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

test('opening a conversation replays its parts and what became of each proposal; New conversation clears them', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await act(() => { chat.current.openConversation('c1'); });
  await waitFor(() => { expect(chat.current.state.conversationLoading).toBe(false); });
  const [asked, answered] = chat.current.state.messages;
  expect(asked === undefined ? null : messageText(asked)).toBe(CONVERSATION.messages[0]?.text);
  expect(answered?.parts.map((part) => part.type)).toEqual(['text', 'tools', 'text', 'proposal']);
  expect(answered === undefined ? [] : stepsOf(answered)).toEqual([{ ...SALES_STEP, state: 'done' }]);
  expect(answered === undefined ? [] : cards(answered)).toEqual([expect.objectContaining({ id: PROPOSAL_ID, status: 'open', stored: 'kept', proposal: PROPOSAL })]);

  await send(chat, 'One more');
  expect(turn(api).body).toEqual({ conversationId: 'c1', content: 'One more' });
  await act(() => { chat.current.newConversation(); });
  expect(chat.current.state.messages).toHaveLength(4);
  await act(() => { turn(api).end(); });
  await act(() => { chat.current.newConversation(); });
  expect(chat.current.state).toMatchObject({ conversationId: null, messages: [] });
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
  const { result: notFound } = await renderHook(() => useTuningChat(missing, 'l1'));
  await waitFor(() => { expect(notFound.current.state.status).toBe('not_found'); });

  const api = fakeChatApi();
  api.chatError = new ApiError('network', 'The network request failed.');
  const { result } = await renderHook(() => useTuningChat(api, 'l1'));
  await waitFor(() => { expect(result.current.state.status).toBe('failed'); });
  expect(result.current.state.loadError).toBe("Can't reach the server.");
  api.chatError = null;
  await act(() => { result.current.reload(); });
  await waitFor(() => { expect(result.current.state.status).toBe('ready'); });
});

test('leaving the screen aborts a live turn', async () => {
  const api = fakeChatApi();
  const { result, unmount } = await renderHook(() => useTuningChat(api, 'l1'));
  await waitFor(() => { expect(result.current.state.status).toBe('ready'); });
  await act(() => { result.current.setDraft('Hello'); });
  await act(() => { result.current.send(); });
  await unmount();
  expect(turn(api).signal?.aborted).toBe(true);
});
