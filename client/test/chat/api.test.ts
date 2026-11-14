import { chatEventOf, loadConversation, rateReply, renameConversation, sendTurn, setActiveVersion } from '../../src/chat/api';
import { CONVERSATION, fakeChatApi } from '../helpers/chat';
import { daily } from './visuals-fixtures';

// TownwiseAI's client API for conversation trees, ratings and visuals (docs/portal/tuning-chat.md 2 and 3). Every
// field the redesign added reads with a default, so an answer from a server without it still loads.

const BASE = '/api/org/locations/l1/chat';

function sse(event: string, data: unknown): { event: string; data: string } {
  return { event, data: JSON.stringify(data) };
}

it('reads the pages a reply cites, keeping only https links that parse, so one bad link never loses the turn’s done', async () => {
  const sources = [
    { host: 'hanover.org', url: 'https://www.hanover.org/fair' }, { host: 'insecure.test', url: 'http://insecure.test/x' },
    { host: 'bad.test' }, 'not a link', { host: 'town.gov', url: 'https://town.gov/roads' },
  ];
  const kept = [{ host: 'hanover.org', url: 'https://www.hanover.org/fair' }, { host: 'town.gov', url: 'https://town.gov/roads' }];
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', costUsd: 0.01, leafId: 'a2', sources })))
    .toEqual({ type: 'done', stopReason: 'end_turn', leafId: 'a2', sources: kept });
  const api = fakeChatApi();
  api.conversation = { ...CONVERSATION, messages: [CONVERSATION.messages[0], { ...CONVERSATION.messages[1], sources }] };
  const load = await loadConversation(api, 'l1', 'c1');
  expect(load.messages.map((message) => message.sources)).toEqual([[], kept]);
});

it('reads the new event fields with old-server defaults, and drops a visual that does not parse', () => {
  expect(chatEventOf({ event: 'conversation', data: '{"id":"c","title":"t"}' })).toEqual({ type: 'conversation', id: 'c', title: 't', userNodeId: null, replyNodeId: null, parentId: null });
  expect(chatEventOf({ event: 'visual', data: '{"id":"v","visual":{"kind":"pie"}}' })).toBeNull();

  expect(chatEventOf(sse('conversation', { id: 'c', title: 't', userNodeId: 'u2', replyNodeId: 'a2', parentId: 'a1' })))
    .toEqual({ type: 'conversation', id: 'c', title: 't', userNodeId: 'u2', replyNodeId: 'a2', parentId: 'a1' });
  // A regenerate has no new message of the person's.
  expect(chatEventOf(sse('conversation', { id: 'c', title: 't', userNodeId: null, replyNodeId: 'a2b', parentId: 'u2' })))
    .toMatchObject({ userNodeId: null, replyNodeId: 'a2b', parentId: 'u2' });
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', costUsd: 0.01 }))).toEqual({ type: 'done', stopReason: 'end_turn', leafId: null, sources: [] });
  expect(chatEventOf(sse('done', { stopReason: 'end_turn', costUsd: 0.01, leafId: 'a2' }))).toEqual({ type: 'done', stopReason: 'end_turn', leafId: 'a2', sources: [] });

  expect(chatEventOf(sse('visual', { id: 'toolu_v1', visual: daily }))).toEqual({ type: 'visual', id: 'toolu_v1', visual: daily });
  expect(chatEventOf(sse('visual', { id: 'toolu_v1' }))).toBeNull();
  expect(chatEventOf(sse('thinking', { delta: 'Weighing it.' }))).toEqual({ type: 'thinking', delta: 'Weighing it.' });
  expect(chatEventOf(sse('thinking', { text: 'wrong field' }))).toBeNull();
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
