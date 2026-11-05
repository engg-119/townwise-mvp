import { act, renderHook, waitFor } from '@testing-library/react-native';

import { ApiError } from '../../src/api/client';
import {
  BUDGET_SPENT, canSend, chatReducer, CUT_OFF, initialChatState, NOT_SAVED, STOPPED, TIMED_OUT, useTuningChat,
  type TuningChat, type TuningChatState,
} from '../../src/chat/useTuningChat';
import { CONVERSATION, fakeChatApi, PROPOSAL, refusal, SUMMARY, type FakeChatApi, type LiveTurn } from '../helpers/chat';

async function ready(api: FakeChatApi): Promise<{ current: TuningChat }> {
  const { result } = await renderHook(() => useTuningChat(api, 'l1'));
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

function reply(chat: { current: TuningChat }) {
  const last = chat.current.state.messages.at(-1);
  if (last?.role !== 'assistant') throw new Error('no reply');
  return last;
}

test('loads the location’s name, the budget and the conversations', async () => {
  const chat = await ready(fakeChatApi());
  expect(chat.current.state).toMatchObject({
    locationName: 'Main Street Bar',
    enabled: true,
    budget: SUMMARY.budget,
    conversations: SUMMARY.conversations,
    conversationId: null,
    messages: [],
  });
  expect(canSend(chat.current.state)).toBe(false);
  await act(() => { chat.current.setDraft('  hi  '); });
  expect(canSend(chat.current.state)).toBe(true);
});

test('send shows the message, then streams the text, the tool status, a proposal and done', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, '  Closed Christmas week  ');
  const live = turn(api);
  expect(live.path).toBe('/api/org/locations/l1/chat/turns');
  expect(live.body).toEqual({ content: 'Closed Christmas week' });
  expect(chat.current.state).toMatchObject({ streaming: true, draft: '' });
  expect(chat.current.state.messages.map((message) => [message.role, message.text, message.state])).toEqual([
    ['user', 'Closed Christmas week', 'complete'],
    ['assistant', '', 'streaming'],
  ]);
  expect(canSend(chat.current.state)).toBe(false);

  await act(() => { live.emit('conversation', { id: 'c2', title: 'Closed Christmas week' }); });
  expect(chat.current.state.conversationId).toBe('c2');
  expect(chat.current.state.conversations.map((item) => item.id)).toEqual(['c2', 'c1']);

  await act(() => { live.emit('tool', { name: 'get_sales_days', state: 'running' }); });
  expect(chat.current.state.tool).toBe('Reading sales history');
  await act(() => { live.emit('tool', { name: 'get_sales_days', state: 'done' }); });
  expect(chat.current.state.tool).toBeNull();

  await act(() => {
    live.emit('text', { delta: 'You were ' });
    live.emit('text', { delta: 'closed.' });
    live.emit('proposal', { proposal: PROPOSAL });
  });
  expect(reply(chat).text).toBe('You were closed.');
  expect(reply(chat).proposals).toEqual([expect.objectContaining({ proposal: PROPOSAL, status: 'open', error: null })]);

  await act(() => { live.emit('done', { stopReason: 'end_turn', costUsd: 0.02 }); });
  expect(reply(chat)).toMatchObject({ state: 'complete', note: null });
  const loadsBefore = api.summaryLoads;
  await act(() => { live.end(); });
  expect(chat.current.state).toMatchObject({ streaming: false, error: null, tool: null });
  await waitFor(() => { expect(api.summaryLoads).toBe(loadsBefore + 1); });

  await send(chat, 'And New Year’s Day?');
  expect(turn(api, 1).body).toEqual({ conversationId: 'c2', content: 'And New Year’s Day?' });
});

test('a reply that ends early says why', () => {
  const rows: [string, string | null][] = [
    ['end_turn', null],
    ['max_tokens', 'The reply hit its length limit.'],
    ['refusal', 'The assistant can’t help with that. Your message and this reply weren’t saved.'],
    ['tool_limit', 'The assistant stopped after too many lookups. Ask again to continue.'],
    ['budget', 'The assistant stopped here because this month’s chat budget is used up.'],
  ];
  for (const [stopReason, note] of rows) {
    let state: TuningChatState = { ...initialChatState(), status: 'ready', enabled: true };
    state = chatReducer(state, { type: 'send', content: 'x', userKey: 'u', replyKey: 'r' });
    state = chatReducer(state, { type: 'event', event: { type: 'done', stopReason }, key: 'k', at: '' });
    expect(state.messages.at(-1)).toMatchObject({ state: 'complete', note });
  }
});

test('an error event marks the reply failed and unsaved, and says why', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('text', { delta: 'Partly' });
    turn(api).emit('error', { code: 'provider_overloaded' });
    turn(api).end();
  });
  expect(reply(chat)).toMatchObject({ text: 'Partly', state: 'failed', note: NOT_SAVED });
  expect(chat.current.state).toMatchObject({ streaming: false, error: 'The assistant is busy. Try again in a minute.' });
});

test('a turn past the server’s time limit is marked unsaved and asks for something shorter', () => {
  let state: TuningChatState = { ...initialChatState(), status: 'ready', enabled: true };
  state = chatReducer(state, { type: 'send', content: 'x', userKey: 'u', replyKey: 'r' });
  state = chatReducer(state, { type: 'event', event: { type: 'text', delta: 'Partly' }, key: 'k1', at: '' });
  state = chatReducer(state, { type: 'event', event: { type: 'error', code: 'timeout' }, key: 'k2', at: '' });
  expect(state.messages.at(-1)).toMatchObject({ text: 'Partly', state: 'failed', note: NOT_SAVED });
  expect(state.error).toBe(TIMED_OUT);
  expect(TIMED_OUT).toBe('The reply took too long. Try asking something shorter.');
});

test('Stop aborts the stream and keeps the partial reply, marked stopped', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('tool', { name: 'list_notes', state: 'running' });
    turn(api).emit('text', { delta: 'Half a rep' });
  });
  expect(chat.current.state.tool).toBe('Reading your notes');
  await act(() => { chat.current.stop(); });
  expect(turn(api).signal?.aborted).toBe(true);
  await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
  expect(reply(chat)).toMatchObject({ text: 'Half a rep', state: 'stopped', note: STOPPED });
  expect(chat.current.state).toMatchObject({ tool: null, error: null });
  expect(chat.current.state.messages[0]?.text).toBe('Hello');
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
  expect(chat.current.state.conversations.map((item) => item.id)).toEqual(['c2', 'c1']);

  await finish(chat, turn(api));
  await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
  expect(chat.current.state.conversationId).toBeNull();
  expect(chat.current.state.conversations.map((item) => item.id)).toEqual(['c1']);
  expect(reply(chat).text).toBe('Partly');

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
  expect(reply(chat)).toMatchObject({ text: 'Some', state: 'failed', note: NOT_SAVED });
  expect(chat.current.state.error).toBe("Can't reach the server.");

  await send(chat, 'Again');
  await act(() => { turn(api, 1).fail(new ApiError('network', 'The network request failed.')); });
  expect(chat.current.state.messages).toHaveLength(2);
  expect(chat.current.state.draft).toBe('Again');
});

test('a refused turn is taken back and its text returns to the composer', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  const rows: [ApiError, string][] = [
    [refusal(409, 'chat_turn_in_progress'), 'You already have a reply in progress, maybe in another tab or location. Wait for it to finish, then try again.'],
    [refusal(409, 'conversation_full'), 'This conversation is full. Start a new conversation.'],
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

test('budget used up: the GET turns Send off, and a 409 turns the budget to used up', async () => {
  const api = fakeChatApi();
  api.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, usedUsd: 20, exhausted: true } };
  const spent = await ready(api);
  await act(() => { spent.current.setDraft('Hello'); });
  expect(canSend(spent.current.state)).toBe(false);
  await act(() => { spent.current.send(); });
  expect(api.turns).toHaveLength(0);

  const fresh = fakeChatApi();
  const chat = await ready(fresh);
  fresh.refuse = refusal(409, 'chat_budget_exhausted');
  // The re-read after the turn fails, so only the 409 can mark the budget used up.
  fresh.chatError = new ApiError('network', 'The network request failed.');
  await send(chat, 'Hello');
  await waitFor(() => { expect(chat.current.state.budget?.exhausted).toBe(true); });
  expect(chat.current.state).toMatchObject({ error: null, draft: 'Hello', messages: [] });
  expect(canSend(chat.current.state)).toBe(false);
});

test('a reply that ends with budget stays, shows the budget used up as the GET would, and turns Send off', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  // The re-read after the turn fails, so only the done event can mark the budget used up.
  api.chatError = new ApiError('network', 'The network request failed.');
  await send(chat, 'Hello');
  await act(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'Hello' });
    turn(api).emit('text', { delta: 'Here is what I found.' });
    turn(api).emit('done', { stopReason: 'budget', costUsd: 0.02 });
    turn(api).end();
  });
  await waitFor(() => { expect(chat.current.state.streaming).toBe(false); });
  expect(reply(chat)).toMatchObject({ text: 'Here is what I found.', state: 'complete', note: BUDGET_SPENT });
  expect(chat.current.state).toMatchObject({ conversationId: 'c2', error: null, budget: { ...SUMMARY.budget, exhausted: true } });
  await act(() => { chat.current.setDraft('More'); });
  expect(canSend(chat.current.state)).toBe(false);
  await act(() => { chat.current.send(); });
  expect(api.turns).toHaveLength(1);
});

test('off: the GET says disabled, and a 503 re-reads it', async () => {
  const off = fakeChatApi();
  off.summary = { ...SUMMARY, enabled: false };
  const disabled = await ready(off);
  expect(disabled.current.state.enabled).toBe(false);
  await act(() => { disabled.current.setDraft('Hello'); });
  expect(canSend(disabled.current.state)).toBe(false);

  const api = fakeChatApi();
  const chat = await ready(api);
  api.refuse = refusal(503, null);
  api.summary = { ...SUMMARY, enabled: false };
  await send(chat, 'Hello');
  await waitFor(() => { expect(chat.current.state.enabled).toBe(false); });
  expect(chat.current.state.error).toBe('The tuning chat isn’t available right now.');
});

test('Add note posts the proposal as the note body and shows the result; Dismiss hides a card', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await send(chat, 'Holidays');
  await act(() => {
    turn(api).emit('proposal', { proposal: PROPOSAL });
    turn(api).emit('proposal', { proposal: { ...PROPOSAL, kind: 'private_event', effect: 'more_guests', expectedGuests: 120 } });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  const message = reply(chat);
  const [first, second] = message.proposals;
  if (first === undefined || second === undefined) throw new Error('two proposals expected');

  let release: (response: Response) => void = () => undefined;
  api.noteResult = () => new Promise<Response>((resolve) => { release = resolve; });
  await act(() => { chat.current.addNote(message.key, first.key); });
  expect(reply(chat).proposals[0]?.status).toBe('adding');
  await act(() => { chat.current.addNote(message.key, first.key); });
  expect(api.requests).toHaveLength(1);
  expect(api.requests[0]).toEqual({ path: '/api/org/locations/l1/notes', opts: { method: 'POST', body: PROPOSAL } });
  await act(() => { release({ ok: true, status: 201 } as Response); });
  expect(reply(chat).proposals[0]).toMatchObject({ status: 'added', error: null });

  api.noteResult = () => Promise.reject(refusal(409, 'note_limit'));
  await act(() => { chat.current.addNote(message.key, second.key); });
  await waitFor(() => {
    expect(reply(chat).proposals[1]).toMatchObject({ status: 'open', error: 'This location has 1,000 notes. Delete old ones to add more.' });
  });
  api.noteResult = () => Promise.reject(refusal(400, 'invalid_request'));
  await act(() => { chat.current.addNote(message.key, second.key); });
  await waitFor(() => { expect(reply(chat).proposals[1]?.error).toBe('Townwise couldn’t accept this note. Ask the assistant to fix it.'); });

  await act(() => { chat.current.dismiss(message.key, second.key); });
  expect(reply(chat).proposals[1]?.status).toBe('dismissed');
});

test('opening a conversation loads its messages and proposals; New conversation clears them', async () => {
  const api = fakeChatApi();
  const chat = await ready(api);
  await act(() => { chat.current.openConversation('c1'); });
  await waitFor(() => { expect(chat.current.state.conversationLoading).toBe(false); });
  expect(chat.current.state.conversationId).toBe('c1');
  expect(chat.current.state.messages.map((message) => [message.role, message.text, message.proposals.length])).toEqual(
    CONVERSATION.messages.map((message) => [message.role, message.text, message.proposals.length]),
  );
  await send(chat, 'One more');
  expect(turn(api).body).toEqual({ conversationId: 'c1', content: 'One more' });
  await act(() => { chat.current.newConversation(); });
  expect(chat.current.state.messages).toHaveLength(4);
  await act(() => { turn(api).end(); });
  await act(() => { chat.current.newConversation(); });
  expect(chat.current.state).toMatchObject({ conversationId: null, messages: [] });
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
  await act(() => { result.current.retry(); });
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
