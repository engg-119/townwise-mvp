// TownwiseAI's web search (spec D37, docs/portal/tuning-chat.md sections 2 to 5) through the API, with
// TOWNWISE_CHAT_WEB_SEARCH on and a scripted model: the tool sent last, the cost, the stream's search cards and the
// done event's sources, the blocks stored and sent back byte for byte, the conversation view, pause_turn, a search cut
// off at tool_limit never saved, a failed search, start_calibration's web_turn refusal, and audit events and logs that
// carry a count only. chat.int.test.ts pins the switch off (exactly the registry's tools). Synthetic pages only.
import { randomUUID } from 'node:crypto';

import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOOLS } from '../src/chat/tools/registry.ts';
import { WEB_SEARCH_TOOL } from '../src/chat/web-search.ts';
import type { ConversationView } from '../src/handlers/chat.ts';
import {
  bareText, cited, message, messagesOf, scriptedModel, text, thinking, toolUse, webError, webResults, webSearch, type ScriptedModel, type Step,
} from './helpers/chat-model.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { call, logLines, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const FAIR = 'https://www.example.com/fair/2026';
const ROAD = 'https://news.example.org/road-closure';
const NEXT = { prompts: ['When is the fair?', 'Is the road open?', 'What else is on?'] };
const SECRETS = /Sentinel-(query|title|encrypted|cited|index)|example\.(com|org)/;

let server: TownwiseTestServer;
let model: ScriptedModel;
let orgId: string;
let locationId: string;
let author: TestSession;
let admin: TestSession;

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model, env: { TOWNWISE_CHAT_WEB_SEARCH: 'true' } });
  orgId = await createOrg(server, { name: 'Search Tavern' });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  author = await signIn(server, `author-${randomUUID().slice(0, 8)}@example.test`);
  await addSeat(server, { orgId, userId: author.userId, email: `author-${author.userId}@example.test`, role: 'member' });
  admin = await signIn(server, `admin-${randomUUID().slice(0, 8)}@example.test`);
  await addSeat(server, { orgId, userId: admin.userId, email: `admin-${admin.userId}@example.test`, role: 'org_admin' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  await server.connection.collection('tw_chat_usage').deleteMany({});
  model.calls.length = 0;
  server.logs.length = 0;
});
afterEach(() => {
  expect(model.remaining()).toBe(0);
});

interface SseEvent { event: string; data: unknown }

function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return event === undefined || data === undefined ? [] : [{ event, data: JSON.parse(data) as unknown }];
  });
}

/** One turn the model answers with `steps`. Resolves its events and its conversation's id. */
async function turn(json: Record<string, unknown>, steps: Step[], who = author): Promise<{ events: SseEvent[]; id: string; replyNodeId: string }> {
  model.script(...steps);
  const res = await call(server, `/api/org/locations/${locationId}/chat/turns`, { session: who, json });
  expect(res.status).toBe(200);
  const events = parseSse(await res.text());
  const first = events[0]?.data as { id: string; replyNodeId: string };
  return { events, id: first.id, replyNodeId: first.replyNodeId };
}

function eventData(events: SseEvent[], name: string): unknown[] {
  return events.filter((e) => e.event === name).map((e) => e.data);
}

async function storedJson(id: string): Promise<string[]> {
  const doc = await server.connection.collection('tw_chat_conversations').findOne({ _id: new Types.ObjectId(id) });
  return (doc?.messages as { param: string }[]).map((m) => m.param);
}

async function view(id: string): Promise<ConversationView> {
  const res = await call(server, `/api/org/locations/${locationId}/chat/${id}`, { session: author });
  expect(res.status).toBe(200);
  return await res.json() as ConversationView;
}

function resultsOf(param: BetaMessageParam | undefined): BetaToolResultBlockParam[] {
  if (param === undefined || param.role === 'system' || typeof param.content === 'string') return [];
  return param.content.filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result');
}

/** Every server_tool_use id in `params`, and every web_search_tool_result's. */
function searchIds(params: BetaMessageParam[]): { calls: string[]; results: string[] } {
  const blocks = params.flatMap((param) => (param.role === 'assistant' && typeof param.content !== 'string' ? param.content : []));
  return {
    calls: blocks.flatMap((block) => (block.type === 'server_tool_use' ? [block.id] : [])),
    results: blocks.flatMap((block) => (block.type === 'web_search_tool_result' ? [block.tool_use_id] : [])),
  };
}

describe('a turn that searches the web', () => {
  it('sends the tool last, streams its card and the reply’s sources, charges the search, and saves, shows and resends every block', async () => {
    // As S0 measured a reply after a search: thinking, then the answer split into text blocks, only the cited ones with
    // citations (whose cited_text is page text: stored, never logged, audited or shown).
    const answer = message([
      thinking('sig-web'), webSearch('s1'), webResults('s1', [FAIR, ROAD]),
      bareText('Yes: '), cited('the fair is on Saturday', [FAIR]), bareText('.'), toolUse('n1', 'suggest_next', NEXT),
    ], { usage: { input: 1000, output: 100, searches: 1 } });
    const { events, id, replyNodeId } = await turn({ content: 'Anything on in town this weekend?' }, [{ kind: 'message', message: answer }]);

    const tools = model.calls[0]?.params.tools ?? [];
    expect(JSON.stringify(tools)).toBe(JSON.stringify([...TOOLS, WEB_SEARCH_TOOL]));
    const card = { pages: 2, sources: [{ host: 'www.example.com', url: FAIR }, { host: 'news.example.org', url: ROAD }] };
    expect(eventData(events, 'tool')).toEqual([
      { id: 's1', name: 'web_search', state: 'running', input: null, result: null },
      { id: 's1', name: 'web_search', state: 'done', input: null, result: card },
      { id: 'n1', name: 'suggest_next', state: 'running', input: null, result: null },
      { id: 'n1', name: 'suggest_next', state: 'done', input: null, result: null },
    ]);
    // 1000 x $4 + 100 x $20 per million tokens, and $0.01 for the search.
    expect(events.at(-1)).toEqual({
      event: 'done', data: { stopReason: 'end_turn', costUsd: 0.016, leafId: replyNodeId, sources: [{ host: 'www.example.com', url: FAIR }] },
    });
    const usage = await server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(orgId) });
    expect(usage?.costMicroUsd).toBe(16_000);

    // Stored exactly as received: encrypted_content, page_age, caller and citations.
    const stored = await storedJson(id);
    expect(stored[1]).toBe(JSON.stringify({ role: 'assistant', content: answer.content }));
    const shown = await view(id);
    expect(shown.messages[0]?.sources).toEqual([]);
    expect(shown.messages[1]).toMatchObject({
      parts: [{ type: 'tool', id: 's1', name: 'web_search', state: 'done', input: null, result: card }, { type: 'text', text: 'Yes: the fair is on Saturday.' }],
      next: NEXT.prompts, sources: [{ host: 'www.example.com', url: FAIR }],
    });
    expect(JSON.stringify(shown)).not.toMatch(/Sentinel-(query|title|encrypted|cited|index)/);
    expect(stored[1]).toContain('Sentinel-cited words from the page');

    // The next turn sends the stored blocks back byte for byte.
    await turn({ conversationId: id, content: 'Thanks' }, [{ kind: 'message', message: message([text('You’re welcome.')]) }]);
    expect(messagesOf(model.calls[1]).slice(0, 3).map((param) => JSON.stringify(param))).toEqual(stored);

    // A count only: never the query, a title, a URL, encrypted content or cited words.
    const event = (await auditEvents(server)).find((e) => e.action === 'chat.turn_completed' && (e.target as { id: string }).id === id);
    expect(event?.details).toEqual({
      locationId, conversationId: id, model: 'claude-opus-5-5', calls: 1, inputTokens: 1000, outputTokens: 100, stopReason: 'end_turn', webSearches: 1,
    });
    expect(logLines(server).filter((line) => line.msg === 'townwise.chat_turn').map((line) => line.webSearches)).toEqual([1, undefined]);
    const later = (await auditEvents(server)).filter((e) => e.action === 'chat.turn_completed').at(-1);
    expect(later?.details).not.toHaveProperty('webSearches');
    expect(JSON.stringify(await auditEvents(server)) + server.logs.join('\n')).not.toMatch(SECRETS);
  });

  it('a failed search is an error card with the API’s code, streamed and stored', async () => {
    const { events, id } = await turn({ content: 'Is the road open?' }, [
      { kind: 'message', message: message([webSearch('s1'), webError('s1', 'unavailable'), text('I couldn’t search the web just now.')]) },
    ]);
    const failed = { id: 's1', name: 'web_search', state: 'error', input: null, result: { code: 'unavailable' } };
    expect(eventData(events, 'tool')).toEqual([{ id: 's1', name: 'web_search', state: 'running', input: null, result: null }, failed]);
    expect((await view(id)).messages[1]?.parts[0]).toEqual({ type: 'tool', ...failed });
  });
});

describe('pause_turn and a search cut off', () => {
  it('resumes a paused turn; at tool_limit the last search, with no result, is not saved, and the next request is valid', async () => {
    const paused = Array.from({ length: 8 }, (_, i) => message(
      [...(i === 0 ? [] : [webResults(`s${String(i)}`, [FAIR])]), webSearch(`s${String(i + 1)}`)], { stopReason: 'pause_turn' },
    ));
    const { events, id } = await turn({ content: 'Search everything.' }, paused.map((step) => ({ kind: 'message' as const, message: step })));
    expect(model.calls).toHaveLength(8);
    // Each resumed call ends with the paused message, unchanged.
    for (let i = 1; i < 8; i += 1) {
      expect(JSON.stringify(messagesOf(model.calls[i]).at(-1))).toBe(JSON.stringify({ role: 'assistant', content: paused[i - 1]?.content }));
    }
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { stopReason: 'tool_limit' } });
    const stored = (await storedJson(id)).map((param) => JSON.parse(param) as BetaMessageParam);
    expect(searchIds(stored)).toEqual({ calls: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], results: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] });

    await turn({ conversationId: id, content: 'And?' }, [{ kind: 'message', message: message([text('That is all.')]) }]);
    const sent = searchIds(messagesOf(model.calls[8]));
    expect(sent.calls).toEqual(sent.results);
  });
});

describe('start_calibration after a search', () => {
  const WEB_TURN = {
    started: false, code: 'web_turn',
    message: 'A calibration can’t start in a conversation that read web pages. Ask the owner to ask for it in a new conversation.',
  };
  const calibrated = (): unknown => JSON.parse(resultsOf(messagesOf(model.calls.at(-1)).at(-1))[0]?.content as string);

  it('refuses in the turn that searched and in a later turn of that conversation, and not in a new conversation', async () => {
    const first = await turn({ content: 'Look up the fair, then calibrate the forecast' }, [
      { kind: 'message', message: message([webSearch('s1'), webResults('s1', [FAIR]), toolUse('c1', 'start_calibration', {})]) },
      { kind: 'message', message: message([text('I can’t start it here.')]) },
    ], admin);
    expect(calibrated()).toEqual(WEB_TURN);
    await turn({ conversationId: first.id, content: 'Calibrate the forecast' }, [
      { kind: 'message', message: message([toolUse('c2', 'start_calibration', {})]) },
      { kind: 'message', message: message([text('Start a new conversation for it.')]) },
    ], admin);
    expect(calibrated()).toEqual(WEB_TURN);
    // A new conversation read no web page, so the guard is not what answers (the lab is off here).
    await turn({ content: 'Calibrate the forecast' }, [
      { kind: 'message', message: message([toolUse('c3', 'start_calibration', {})]) },
      { kind: 'message', message: message([text('The lab is off.')]) },
    ], admin);
    expect(calibrated()).toMatchObject({ started: false, code: 'lab_unavailable' });
    expect(await server.connection.collection('tw_calibrations').countDocuments({})).toBe(0);
  });
});
