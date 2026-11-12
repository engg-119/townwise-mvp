// Reading with TownwiseAI's real model client (spec 11A.9) over a fake fetch: no call leaves the test. It streams the
// request with medium effort, structured output and the server-side refusal fallback, retries at most once, and
// answers a parsed answer, a refusal, an answer cut at max_tokens or a failure, each with what the call cost.
import { describe, expect, it } from 'vitest';

import { createAnthropicFileReaderModel, READER_FORMAT } from '../../src/files/extract/model.ts';
import { readerRequest } from '../../src/files/extract/reader.ts';

const ANSWER = { kind: 'other', confidence: 'low', summary: 'A list.', facts: [], events: [], days: [], daysCut: false };
const REQUEST = readerRequest({ type: 'text', form: 'text', text: 'Date,Guests', cut: false }, { today: '2026-06-01', timeZone: 'America/New_York' });

/** A streamed message as the API sends it: its text in one delta, then how it stopped and what it used. */
function events(text: string, stopReason = 'end_turn'): string {
  const sse = (event: Record<string, unknown>): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  return [
    sse({
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 200 } }),
    sse({ type: 'message_stop' }),
  ].join('');
}

type Reply = { stream: string } | { status: number; json: Record<string, unknown> };

function fakeFetch(...replies: Reply[]): {
  fetch: typeof globalThis.fetch; seen: { url: string; headers: Headers; body: Record<string, unknown> }[];
} {
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(body) as Record<string, unknown> });
    const reply = replies[Math.min(seen.length, replies.length) - 1];
    if (reply === undefined || 'stream' in reply) {
      return Promise.resolve(new Response(reply?.stream ?? '', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    return Promise.resolve(new Response(JSON.stringify(reply.json), {
      status: reply.status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
    }));
  };
  return { fetch, seen };
}

const read = (fetch: typeof globalThis.fetch) => createAnthropicFileReaderModel('test-key', fetch).readFile(REQUEST, new AbortController().signal);

describe('the reader’s model client', () => {
  it('streams the request at medium effort with structured output and the refusal fallback, and answers the parsed JSON and its cost', async () => {
    const { fetch, seen } = fakeFetch({ stream: events(JSON.stringify(ANSWER)) });
    expect(await read(fetch)).toEqual({ kind: 'answered', output: ANSWER, costMicroUsd: 8000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('/v1/messages');
    expect(seen[0]?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(seen[0]?.body).toEqual({
      model: 'claude-opus-5-5', max_tokens: 64_000, system: REQUEST.system, messages: REQUEST.messages,
      output_config: { effort: 'medium', format: READER_FORMAT }, fallbacks: 'default', stream: true,
    });
  });

  it('answers a refusal through the whole chain as refused, with its cost', async () => {
    const { fetch } = fakeFetch({ stream: events('I can’t help with that.', 'refusal') });
    expect(await read(fetch)).toEqual({ kind: 'refused', costMicroUsd: 8000 });
  });

  it('answers an answer cut at max_tokens as too long, with its cost, and text that is not JSON as an answer with no output', async () => {
    expect(await read(fakeFetch({ stream: events('{"kind":"sa', 'max_tokens') }).fetch)).toEqual({ kind: 'too_long', costMicroUsd: 8000 });
    expect(await read(fakeFetch({ stream: events('not json') }).fetch)).toEqual({ kind: 'answered', output: null, costMicroUsd: 8000 });
  });

  it('answers an API error as failed with its class and status only, retrying an overloaded API once, never a refused request', async () => {
    const refused = fakeFetch({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Zqxj secret detail' } } });
    expect(await read(refused.fetch)).toEqual({ kind: 'failed', errType: 'BadRequestError', status: 400 });
    expect(refused.seen).toHaveLength(1);
    const busy = fakeFetch({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    expect(await read(busy.fetch)).toEqual({ kind: 'failed', errType: 'InternalServerError', status: 529 });
    expect(busy.seen).toHaveLength(2);
  });

  it('sends a strict schema, with the limits the API does not enforce as descriptions', () => {
    const schema = READER_FORMAT.schema as { additionalProperties: unknown; required: string[]; properties: Record<string, { description?: string }> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(['confidence', 'days', 'daysCut', 'events', 'facts', 'kind', 'summary']);
    expect(schema.properties.summary?.description).toContain('600');
    expect(JSON.stringify(schema.properties.days)).toContain('1500');
    expect(JSON.stringify(schema)).not.toContain('"maxLength"');
  });
});
