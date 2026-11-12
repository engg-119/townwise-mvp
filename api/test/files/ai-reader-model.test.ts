// Reading with TownwiseAI's real model client (spec 11A.9) over a fake fetch: no call leaves the test. It sends the
// request with medium effort, structured output and the server-side refusal fallback, and answers a parsed answer, a
// refusal or a failure, each with what the call cost.
import { describe, expect, it } from 'vitest';

import { createAnthropicFileReaderModel, READER_FORMAT } from '../../src/files/extract/model.ts';
import { readerRequest } from '../../src/files/extract/reader.ts';

const ANSWER = { kind: 'other', confidence: 'low', summary: 'A list.', facts: [], events: [], days: [] };
const REQUEST = readerRequest({ type: 'text', form: 'text', text: 'Date,Guests', cut: false }, { today: '2026-06-01', timeZone: 'America/New_York' });

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(ANSWER) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...over,
  };
}

function fakeFetch(reply: Record<string, unknown>, status = 200): {
  fetch: typeof globalThis.fetch; seen: { url: string; headers: Headers; body: Record<string, unknown> }[];
} {
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(body) as Record<string, unknown> });
    return Promise.resolve(new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetch, seen };
}

describe('the reader’s model client', () => {
  it('sends the request at medium effort with structured output and the refusal fallback, and answers the parsed JSON and its cost', async () => {
    const { fetch, seen } = fakeFetch(message());
    const answer = await createAnthropicFileReaderModel('test-key', fetch).readFile(REQUEST, new AbortController().signal);
    expect(answer).toEqual({ kind: 'answered', output: ANSWER, costMicroUsd: 8000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('/v1/messages');
    expect(seen[0]?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(seen[0]?.body).toEqual({
      model: 'claude-opus-5-5', max_tokens: 16_000, system: REQUEST.system, messages: REQUEST.messages,
      output_config: { effort: 'medium', format: READER_FORMAT }, fallbacks: 'default',
    });
  });

  it('answers a refusal through the whole chain as refused, with its cost', async () => {
    const { fetch } = fakeFetch(message({ stop_reason: 'refusal', content: [{ type: 'text', text: 'I can’t help with that.' }] }));
    expect(await createAnthropicFileReaderModel('test-key', fetch).readFile(REQUEST, new AbortController().signal))
      .toEqual({ kind: 'refused', costMicroUsd: 8000 });
  });

  it('answers text that is not JSON as an answer with no output, and an API error as failed with its class and status only', async () => {
    const cut = fakeFetch(message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"kind":"sa' }] }));
    expect(await createAnthropicFileReaderModel('test-key', cut.fetch).readFile(REQUEST, new AbortController().signal))
      .toEqual({ kind: 'answered', output: null, costMicroUsd: 8000 });
    const refused = fakeFetch({ type: 'error', error: { type: 'invalid_request_error', message: 'Zqxj secret detail' } }, 400);
    expect(await createAnthropicFileReaderModel('test-key', refused.fetch).readFile(REQUEST, new AbortController().signal))
      .toEqual({ kind: 'failed', errType: 'BadRequestError', status: 400 });
  });

  it('sends a strict schema, with the limits the API does not enforce as descriptions', () => {
    const schema = READER_FORMAT.schema as { additionalProperties: unknown; required: string[]; properties: Record<string, { description?: string }> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(['confidence', 'days', 'events', 'facts', 'kind', 'summary']);
    expect(schema.properties.summary?.description).toContain('600');
    expect(JSON.stringify(schema)).not.toContain('"maxLength"');
  });
});
