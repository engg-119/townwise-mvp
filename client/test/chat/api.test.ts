import {
  chatEventOf, endsTurn, followTurn, loadChat, loadConversation, rateReply, renameConversation, sendTurn, seqOf, setActiveVersion, stopTurn,
  TURN_INTERRUPTED, type ChatEvent,
} from '../../src/chat/api';
import { CONVERSATION, fakeChatApi, SUMMARY } from '../helpers/chat';
import { daily } from './visuals-fixtures';

// TownwiseAI's client API for conversation trees, ratings and visuals (docs/portal/tuning-chat.md 2 and 3). Every
// field the redesign added reads with a default, so an answer from a server without it still loads.

const BASE = '/api/org/locations/l1/chat';

function sse(event: string, data: unknown): { event: string; data: string } {
  return { event, data: JSON.stringify(data) };
}

it('reads the new event fields with old-server defaults, and drops a visual that does not parse', () => {
  expect(chatEventOf({ event: 'conversation', data: '{"id":"c","title":"t"}' })).toEqual({
    type: 'conversation', id: 'c', title: 't', userNodeId: null, replyNodeId: null, parentId: null, turnId: null,
  });
  expect(chatEventOf({ event: 'visual', data: '{"id":"v","visual":{"kind":"pie"}}' })).toBeNull();

  expect(chatEventOf(sse('conversation', { id: 'c', title: 't', userNodeId: 'u2', replyNodeId: 'a2', parentId: 'a1' })))
    .toEqual({ type: 'conversation', id: 'c', title: 't', userNodeId: 'u2', replyNodeId: 'a2', parentId: 'a1', turnId: null });
  // A regenerate has no new message of the person's.
  expect(chatEventOf(sse('conversation', { id: 'c', title: 't', userNodeId: null, replyNodeId: 'a2b', parentId: 'u2' })))
    .toMatchObject({ userNodeId: null, replyNodeId: 'a2b', parentId: 'u2' });
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', costUsd: 0.01 }))).toEqual({ type: 'done', stopReason: 'end_turn', leafId: null, sources: [] });
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', costUsd: 0.01, leafId: 'a2' }))).toEqual({ type: 'done', stopReason: 'end_turn', leafId: 'a2', sources: [] });

  expect(chatEventOf(sse('visual', { id: 'toolu_v1', visual: daily }))).toEqual({ type: 'visual', id: 'toolu_v1', visual: daily });
  expect(chatEventOf(sse('visual', { id: 'toolu_v1' }))).toBeNull();
  expect(chatEventOf(sse('thinking', { delta: 'Weighing it.' }))).toEqual({ type: 'thinking', delta: 'Weighing it.' });
  expect(chatEventOf(sse('thinking', { text: 'wrong field' }))).toBeNull();
  expect(chatEventOf(sse('aside', {}))).toEqual({ type: 'aside' });
  expect(chatEventOf(sse('suggestions', { id: 'toolu_n1', prompts: ['How did Monday go?', 'Any events next week?', 'Show last month'] })))
    .toEqual({ type: 'suggestions', id: 'toolu_n1', prompts: ['How did Monday go?', 'Any events next week?', 'Show last month'] });
  expect(chatEventOf(sse('suggestions', { id: 'toolu_n1', prompts: 'not a list' }))).toBeNull();
});

it('loads a conversation’s tree, its shown leaf and each message’s node, rating and next questions', async () => {
  const api = fakeChatApi();
  api.conversation = {
    ...CONVERSATION,
    messages: [
      CONVERSATION.messages[0],
      {
        ...CONVERSATION.messages[1],
        feedback: { rating: 'down', reason: 'made_up' },
        next: ['How did Monday go?', 'Any events next week?', 'Show last month'],
        parts: [
          { type: 'text', text: 'Here it is.' },
          { type: 'visual', id: 'toolu_v1', visual: daily },
          // A visual this client can't draw is left out; the rest of the reply still loads.
          { type: 'visual', id: 'toolu_v2', visual: { kind: 'pie' } },
          { type: 'text', text: 'Busy weekend.' },
        ],
      },
    ],
  };
  const load = await loadConversation(api, 'l1', 'c1');
  expect(load.activeLeafId).toBe('a1');
  expect(load.tree).toEqual([{ id: 'u1', parentId: null, role: 'user' }, { id: 'a1', parentId: 'u1', role: 'assistant' }]);
  expect(load.messages.map((message) => [message.nodeId, message.feedback, message.next])).toEqual([
    ['u1', null, null],
    ['a1', { rating: 'down', reason: 'made_up' }, ['How did Monday go?', 'Any events next week?', 'Show last month']],
  ]);
  expect(load.messages[1]?.parts).toEqual([
    { type: 'text', text: 'Here it is.' }, { type: 'visual', id: 'toolu_v1', visual: daily }, { type: 'text', text: 'Busy weekend.' },
  ]);
});

it('an answer from a server without trees loads as one path with no node ids', async () => {
  const api = fakeChatApi();
  api.conversation = {
    id: CONVERSATION.id, title: CONVERSATION.title, updatedAt: CONVERSATION.updatedAt,
    messages: CONVERSATION.messages.map(({ role, text, proposals, parts, at }) => ({ role, text, proposals, parts, at })),
  };
  const load = await loadConversation(api, 'l1', 'c1');
  expect(load).toMatchObject({ activeLeafId: null, tree: [] });
  expect(load.messages.map((message) => [message.nodeId, message.feedback, message.next])).toEqual([[null, null, null], [null, null, null]]);
});

it('reads another version with ?node=, and switching one stores it', async () => {
  const api = fakeChatApi();
  await loadConversation(api, 'l1', 'c1', 'u2b');
  expect(api.conversationReads).toEqual([`${BASE}/c1?node=u2b`]);
  await setActiveVersion(api, 'l1', 'c1', 'u2b');
  expect(api.writes).toEqual([{ method: 'POST', path: `${BASE}/c1/active`, body: { nodeId: 'u2b' } }]);
});

it('renames a conversation and rates a reply, sending a reason only with Not helpful', async () => {
  const api = fakeChatApi();
  expect(await renameConversation(api, 'l1', 'c1', 'Holidays')).toEqual({ id: 'c1', title: 'Holidays' });
  expect(await rateReply(api, 'l1', 'c1', 'a1', 'up', null)).toEqual({ rating: 'up', reason: null });
  expect(await rateReply(api, 'l1', 'c1', 'a1', 'down', 'too_long')).toEqual({ rating: 'down', reason: 'too_long' });
  expect(await rateReply(api, 'l1', 'c1', 'a1', null, null)).toBeNull();
  expect(api.writes).toEqual([
    { method: 'PATCH', path: `${BASE}/c1`, body: { title: 'Holidays' } },
    { method: 'POST', path: `${BASE}/c1/feedback/a1`, body: { rating: 'up' } },
    { method: 'POST', path: `${BASE}/c1/feedback/a1`, body: { rating: 'down', reason: 'too_long' } },
    { method: 'POST', path: `${BASE}/c1/feedback/a1`, body: { rating: null } },
  ]);
});

it('sends a turn: a new conversation’s first message, a message after a node, and a regenerate', async () => {
  const api = fakeChatApi();
  const signal = new AbortController().signal;
  const sent = [
    sendTurn(api, 'l1', { conversationId: null, content: 'First' }, signal, () => undefined),
    sendTurn(api, 'l1', { conversationId: 'c1', content: 'Next', parentId: 'a1' }, signal, () => undefined),
    sendTurn(api, 'l1', { conversationId: 'c1', content: 'First, edited', parentId: null }, signal, () => undefined),
    sendTurn(api, 'l1', { conversationId: 'c1', content: 'After the stored leaf' }, signal, () => undefined),
    sendTurn(api, 'l1', { conversationId: 'c1', replyTo: 'u1' }, signal, () => undefined),
  ];
  expect(api.turns.map((turn) => turn.body)).toEqual([
    { content: 'First' },
    { conversationId: 'c1', content: 'Next', parentId: 'a1' },
    { conversationId: 'c1', content: 'First, edited', parentId: null },
    { conversationId: 'c1', content: 'After the stored leaf' },
    { conversationId: 'c1', replyTo: 'u1' },
  ]);
  for (const turn of api.turns) turn.end();
  await Promise.all(sent);
});

it('reads the files a person’s message carries (D36): an unknown kind is a file, an unknown state is gone, an entry with no ref is left out', async () => {
  const api = fakeChatApi();
  const [asked, answered] = CONVERSATION.messages;
  api.conversation = {
    ...CONVERSATION,
    messages: [
      {
        ...asked,
        attachments: [
          { ref: 'f_0123456789abcdef01234567', kind: 'picture', name: 'patio.png', state: 'on' },
          { ref: 'f_1111111111111111aaaaaaaa', kind: 'hologram', name: null, state: 'off' },
          { ref: 'f_2222222222222222bbbbbbbb', kind: 'pdf', name: 'menu.pdf', state: 'archived' },
          { kind: 'text', name: 'no-ref.txt', state: 'on' },
        ],
      },
      // A reply never carries files, whatever the answer says.
      { ...answered, attachments: [{ ref: 'f_3333333333333333cccccccc', kind: 'text', name: 'x.txt', state: 'on' }] },
    ],
  };
  const load = await loadConversation(api, 'l1', 'c1');
  expect(load.messages[0]?.attachments).toEqual([
    { ref: 'f_0123456789abcdef01234567', kind: 'picture', name: 'patio.png', state: 'on' },
    { ref: 'f_1111111111111111aaaaaaaa', kind: 'file', name: null, state: 'off' },
    { ref: 'f_2222222222222222bbbbbbbb', kind: 'pdf', name: 'menu.pdf', state: 'gone' },
  ]);
  expect(load.messages[1]?.attachments).toEqual([]);
  // A server from before attachments sends none.
  api.conversation = CONVERSATION;
  expect((await loadConversation(api, 'l1', 'c1')).messages.map((message) => message.attachments)).toEqual([[], []]);
});

it('sends a message’s files as refs only when there are any, and a regenerate never', async () => {
  const api = fakeChatApi();
  const signal = new AbortController().signal;
  const refs = ['f_0123456789abcdef01234567'];
  const sent = [
    sendTurn(api, 'l1', { conversationId: null, content: 'Read this', attachments: refs }, signal, () => undefined),
    sendTurn(api, 'l1', { conversationId: 'c1', content: 'And this', parentId: 'a1', attachments: refs }, signal, () => undefined),
    sendTurn(api, 'l1', { conversationId: 'c1', content: 'No files', attachments: [] }, signal, () => undefined),
    sendTurn(api, 'l1', { conversationId: 'c1', replyTo: 'u1' }, signal, () => undefined),
  ];
  expect(api.turns.map((turn) => turn.body)).toEqual([
    { content: 'Read this', attachments: refs },
    { conversationId: 'c1', content: 'And this', parentId: 'a1', attachments: refs },
    { conversationId: 'c1', content: 'No files' },
    { conversationId: 'c1', replyTo: 'u1' },
  ]);
  for (const turn of api.turns) turn.end();
  await Promise.all(sent);
});

// D37: the shapes B1's API sends (api/src/chat/web-search.ts, docs/portal/tuning-chat.md 2 and 3). Synthetic pages.
const FOUND = { pages: 9, sources: [{ host: 'www.example.com', url: 'https://www.example.com/fair' }, { host: 'example.org', url: 'https://example.org/road' }] };
const CITED = [{ host: 'www.example.com', url: 'https://www.example.com/fair' }, { host: 'example.org', url: 'https://example.org/road?day=2' }];
// Anything but an https source is left out: an http or javascript link, and an entry missing its host.
const NOT_LINKS = [{ host: 'example.net', url: 'http://example.net/a' }, { host: 'example.net', url: 'javascript:alert(1)' }, { url: 'https://example.net/b' }, 'https://example.net/c'];

it('reads a web search’s card events as tool events, never with an input (D37)', () => {
  expect(chatEventOf(sse('tool', { id: 'srvtoolu_01', name: 'web_search', state: 'running', input: null, result: null })))
    .toEqual({ type: 'tool', id: 'srvtoolu_01', name: 'web_search', state: 'running', input: null, result: null });
  expect(chatEventOf(sse('tool', { id: 'srvtoolu_01', name: 'web_search', state: 'done', input: null, result: FOUND })))
    .toEqual({ type: 'tool', id: 'srvtoolu_01', name: 'web_search', state: 'done', input: null, result: FOUND });
  expect(chatEventOf(sse('tool', { id: 'srvtoolu_02', name: 'web_search', state: 'error', input: null, result: { code: 'max_uses_exceeded' } })))
    .toEqual({ type: 'tool', id: 'srvtoolu_02', name: 'web_search', state: 'error', input: null, result: { code: 'max_uses_exceeded' } });
});

it('reads done’s sources (D37): https links only, none from an API before them, and a list that isn’t one never drops the done', () => {
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', costUsd: 0.026, leafId: 'a2', sources: CITED })))
    .toEqual({ type: 'done', stopReason: 'end_turn', leafId: 'a2', sources: CITED });
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', leafId: 'a2', sources: [...NOT_LINKS, ...CITED] })))
    .toEqual({ type: 'done', stopReason: 'end_turn', leafId: 'a2', sources: CITED });
  expect(chatEventOf(sse('done', { stopReason: 'refusal', leafId: null, sources: [] }))).toEqual({ type: 'done', stopReason: 'refusal', leafId: null, sources: [] });
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', leafId: 'a2', sources: 'none' }))).toEqual({ type: 'done', stopReason: 'end_turn', leafId: 'a2', sources: [] });
});

it('loads each reply’s sources and its search parts (D37); the person’s entry has none, and an API before them sends none', async () => {
  const api = fakeChatApi();
  const [asked, answered] = CONVERSATION.messages;
  api.conversation = {
    ...CONVERSATION,
    messages: [
      // The person's entry never lists sources, whatever the answer says.
      { ...asked, sources: CITED },
      {
        ...answered,
        sources: [...NOT_LINKS, ...CITED],
        parts: [
          { type: 'tool', id: 'srvtoolu_01', name: 'web_search', state: 'done', input: null, result: FOUND },
          { type: 'tool', id: 'srvtoolu_02', name: 'web_search', state: 'error', input: null, result: { code: 'unavailable' } },
          { type: 'text', text: 'The fair is on Saturday.' },
        ],
      },
    ],
  };
  const load = await loadConversation(api, 'l1', 'c1');
  expect(load.messages.map((message) => message.sources)).toEqual([[], CITED]);
  expect(load.messages[1]?.parts).toEqual([
    { type: 'tool', id: 'srvtoolu_01', name: 'web_search', state: 'done', input: null, result: FOUND },
    { type: 'tool', id: 'srvtoolu_02', name: 'web_search', state: 'error', input: null, result: { code: 'unavailable' } },
    { type: 'text', text: 'The fair is on Saturday.' },
  ]);
  // A list that isn't one reads as none and the conversation still loads.
  api.conversation = { ...CONVERSATION, messages: [asked, { ...answered, sources: { url: 'https://example.org/road' } }] };
  expect((await loadConversation(api, 'l1', 'c1')).messages.map((message) => message.sources)).toEqual([[], []]);
  api.conversation = CONVERSATION;
  expect((await loadConversation(api, 'l1', 'c1')).messages.map((message) => message.sources)).toEqual([[], []]);
});

// resumable-chat-turns: a turn's numbered events, its live turn on both GETs, and the calls that read it back and stop it.
const LIVE = {
  turnId: 'turn-0001', state: 'running', startedAt: '2026-11-02T15:00:00.000Z', userNodeId: 'u2', replyNodeId: 'a2', parentId: 'a1',
  message: { nodeId: 'u2', role: 'user', text: 'And January?', proposals: [], parts: [], at: '2026-11-02T15:00:00.000Z', attachments: [] },
};

it('reads a turn’s id on conversation, its stopped and interrupted endings, and each event’s number', () => {
  expect(chatEventOf(sse('conversation', { id: 'c', title: 't', userNodeId: 'u2', replyNodeId: 'a2', parentId: 'a1', turnId: 'turn-0001' })))
    .toMatchObject({ type: 'conversation', turnId: 'turn-0001' });
  expect(chatEventOf(sse('stopped', {}))).toEqual({ type: 'stopped' });
  expect(chatEventOf({ event: 'stopped', data: 'not json' })).toBeNull();
  expect(chatEventOf(sse('error', { code: 'interrupted' }))).toEqual({ type: 'error', code: TURN_INTERRUPTED });
  const ends: ChatEvent[] = [{ type: 'stopped' }, { type: 'error', code: 'interrupted' }, { type: 'done', stopReason: 'end_turn', leafId: null, sources: [] }];
  expect(ends.every(endsTurn)).toBe(true);
  expect(endsTurn({ type: 'text', delta: 'x' })).toBe(false);
  expect(seqOf({ event: 'text', data: '{}', id: '42' })).toBe(42);
  for (const id of [undefined, '', '0', '07', '-1', '1.5', 'x']) {
    expect(seqOf({ event: 'text', data: '{}', ...(id === undefined ? {} : { id }) })).toBeNull();
  }
});

it('reads liveTurn on both GETs, as none from an API before it or one that does not parse', async () => {
  const api = fakeChatApi();
  expect((await loadChat(api, 'l1')).liveTurn).toBeNull();
  api.summary = { ...SUMMARY, liveTurn: { conversationId: 'c1', turnId: 'turn-0001' } };
  expect((await loadChat(api, 'l1')).liveTurn).toEqual({ conversationId: 'c1', turnId: 'turn-0001' });
  api.summary = { ...SUMMARY, liveTurn: { conversationId: 7 } };
  expect((await loadChat(api, 'l1')).liveTurn).toBeNull();

  expect((await loadConversation(api, 'l1', 'c1')).liveTurn).toBeNull();
  api.conversation = { ...CONVERSATION, liveTurn: LIVE };
  expect((await loadConversation(api, 'l1', 'c1')).liveTurn).toEqual({
    turnId: 'turn-0001', state: 'running', startedAt: Date.parse('2026-11-02T15:00:00.000Z'), userNodeId: 'u2', replyNodeId: 'a2', parentId: 'a1',
    message: {
      role: 'user', text: 'And January?', parts: [], at: Date.parse('2026-11-02T15:00:00.000Z'), endedAt: Date.parse('2026-11-02T15:00:00.000Z'),
      nodeId: 'u2', feedback: null, next: null, attachments: [], sources: [],
    },
  });
  // A regenerate has no message of the person's; POST .../active answers the same view.
  api.conversation = { ...CONVERSATION, liveTurn: { ...LIVE, state: 'interrupted', userNodeId: null, message: null } };
  expect((await setActiveVersion(api, 'l1', 'c1', 'a1')).liveTurn).toMatchObject({ state: 'interrupted', userNodeId: null, message: null });
  api.conversation = { ...CONVERSATION, liveTurn: { ...LIVE, state: 'finished' } };
  expect((await loadConversation(api, 'l1', 'c1')).liveTurn).toBeNull();
});

it('reads a turn back with a GET after a cursor, each event with its number, and stops it with an empty POST', async () => {
  const api = fakeChatApi();
  const seen: [ChatEvent, number | null][] = [];
  const following = followTurn(api, 'l1', { conversationId: 'c1', turnId: 'turn-0001' }, 41, new AbortController().signal, (event, seq) => {
    seen.push([event, seq]);
  });
  const [tail] = api.turns;
  expect(tail).toMatchObject({ path: `${BASE}/c1/turns/turn-0001?after=41`, method: 'GET', body: undefined });
  tail?.emit('text', { delta: 'more' }, 42);
  tail?.emit('stopped', {}, 43);
  tail?.end();
  await following;
  expect(seen).toEqual([[{ type: 'text', delta: 'more' }, 42], [{ type: 'stopped' }, 43]]);

  api.autoStop = false;
  expect(await stopTurn(api, 'l1', { conversationId: 'c1', turnId: 'turn-0001' })).toBe('running');
  api.respond[`${BASE}/c1/turns/turn-0001/stop`] = () => ({ state: 'done' });
  expect(await stopTurn(api, 'l1', { conversationId: 'c1', turnId: 'turn-0001' })).toBe('done');
  expect(api.writes).toEqual([
    { method: 'POST', path: `${BASE}/c1/turns/turn-0001/stop`, body: {} },
    { method: 'POST', path: `${BASE}/c1/turns/turn-0001/stop`, body: {} },
  ]);
});

it('D59 slice 4: reads a proposal TownwiseAI saved itself, streamed with `saved` and stored with `auto`; an older answer has neither', async () => {
  const note = {
    kind: 'private_event', startDate: '2026-12-20', endDate: '2026-12-20', weekdays: null, effect: 'more_guests', expectedGuests: 40, detail: null,
    title: 'Dinner',
  } as const;
  expect(chatEventOf(sse('proposal', { id: 'p1', proposal: note, saved: { noteId: 'n1', changeId: 'ch1' } })))
    .toMatchObject({ type: 'proposal', id: 'p1', saved: { noteId: 'n1', changeId: 'ch1' } });
  expect(chatEventOf(sse('proposal', { id: 'p1', proposal: note }))).not.toHaveProperty('saved');

  const api = fakeChatApi();
  const auto = { changeId: 'ch1', status: 'undone', undoable: false } as const;
  const shown = { ...note, id: 'p1', status: 'saved', noteId: 'n1' } as const;
  const [asked, replied] = CONVERSATION.messages;
  const withPart = (proposal: unknown): unknown => ({ ...CONVERSATION, messages: [asked, { ...replied, proposals: [], parts: [{ type: 'proposal', proposal }] }] });
  api.conversation = withPart({ ...shown, auto });
  expect((await loadConversation(api, 'l1', 'c1')).messages[1]?.parts).toEqual([{ type: 'proposal', proposal: { ...shown, auto } }]);
  api.conversation = withPart(shown);
  expect((await loadConversation(api, 'l1', 'c1')).messages[1]?.parts).toEqual([{ type: 'proposal', proposal: shown }]);
});

it('D66: a conversation holding correct_calendar_event tool parts loads with the current schema, each part as stored', async () => {
  const api = fakeChatApi();
  const applied = {
    type: 'tool', id: 'toolu_c1', name: 'correct_calendar_event', state: 'done', input: { eventId: `l-${'a'.repeat(24)}`, change: 'hide' },
    result: { applied: true, code: null, eventId: `l-${'a'.repeat(24)}`, changeId: 'c1', proposed: null },
  };
  const proposed = {
    type: 'tool', id: 'toolu_c2', name: 'correct_calendar_event', state: 'done', input: { eventId: `t-${'b'.repeat(24)}`, change: 'edit' },
    result: { applied: false, code: 'needs_tap', eventId: `t-${'b'.repeat(24)}`, changeId: null, proposed: { change: 'edit', fields: { startTime: '20:00' } } },
  };
  api.conversation = {
    ...CONVERSATION,
    messages: [CONVERSATION.messages[0], { ...CONVERSATION.messages[1], parts: [{ type: 'text', text: 'Done.' }, applied, proposed] }],
  };
  const load = await loadConversation(api, 'l1', 'c1');
  expect(load.messages[1]?.parts).toEqual([{ type: 'text', text: 'Done.' }, applied, proposed]);
});

it('D66: the budget reads research’s part of the month, and an API before it reads without one', async () => {
  const api = fakeChatApi();
  api.summary = { ...SUMMARY, budget: { month: '2026-11', usedUsd: 4.26, limitUsd: 20, exhausted: false, researchUsd: 3.55 } };
  expect((await loadChat(api, 'l1')).budget).toEqual({ month: '2026-11', usedUsd: 4.26, limitUsd: 20, exhausted: false, researchUsd: 3.55 });
  api.summary = { ...SUMMARY, budget: { month: '2026-11', usedUsd: 4.26, limitUsd: 20, exhausted: false } };
  expect((await loadChat(api, 'l1')).budget).toEqual({ month: '2026-11', usedUsd: 4.26, limitUsd: 20, exhausted: false });
});
