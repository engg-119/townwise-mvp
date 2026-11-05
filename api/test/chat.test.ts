// The tuning chat's pricing and provider error codes (docs/portal/tuning-chat.md sections 4 and 5), without Docker.
import {
  AnthropicError, APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError,
  BadRequestError, InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
} from '@anthropic-ai/sdk';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { costMicroUsd, messageCostMicroUsd } from '../src/chat/pricing.ts';
import { SYSTEM_PROMPT, TOOLS } from '../src/chat/prompt.ts';
import { echoable, failureCode, requestParams } from '../src/chat/turn.ts';
import { message, text, thinking, toolUse, usage } from './helpers/chat-model.ts';

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

describe('pricing', () => {
  it('prices Claude Opus 5.5 at $4 and $20 per million tokens, cache reads at $0.20 and cache writes at 1.25 times input', () => {
    expect(costMicroUsd('claude-opus-5-5', tokens(1_000_000, 0))).toBe(4_000_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 1_000_000))).toBe(20_000_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 1_000_000))).toBe(200_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 0, 1_000_000))).toBe(5_000_000);
    expect(costMicroUsd('claude-opus-5-5', tokens(1000, 500, 10_000, 2000))).toBe(26_000);
  });

  it('rounds each call up to a whole micro-dollar, exactly', () => {
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 1))).toBe(1);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 5))).toBe(1);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 15))).toBe(3);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 16))).toBe(4);
    expect(costMicroUsd('claude-opus-5-5', tokens(0, 0, 0, 0))).toBe(0);
  });

  it('prices the fallback models at their own rates, and any other or unknown model at the most expensive row', () => {
    for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-future-9', '']) {
      expect(costMicroUsd(model, tokens(1000, 500, 10_000, 2000))).toBe(5000 + 12_500 + 5000 + 12_500);
    }
  });

  it('prices a call by usage.iterations when the server ran more than one attempt, each by the model that ran it', () => {
    const fellBack = message([], {
      model: 'claude-opus-5',
      usage: {
        input: 1000, output: 200,
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        ],
      },
    });
    expect(messageCostMicroUsd(fellBack)).toBe((1000 * 4 + 100 * 20) + (1000 * 5 + 200 * 25));
    expect(messageCostMicroUsd({ model: 'claude-opus-5-5', usage: usage({ input: 1000, output: 500, cacheRead: 10_000, cacheWrite: 2000 }) }))
      .toBe(26_000);
  });
});

describe('provider errors', () => {
  const body = (type: string) => ({ type: 'error', error: { type, message: 'no' } });
  const headers = new Headers();

  it('maps overloaded and rate limited to provider_overloaded, connection errors and 5xx to provider_unavailable, the rest to internal', () => {
    const cases: [unknown, string][] = [
      [new RateLimitError(429, body('rate_limit_error'), undefined, headers, 'rate_limit_error'), 'provider_overloaded'],
      [new InternalServerError(529, body('overloaded_error'), undefined, headers, 'overloaded_error'), 'provider_overloaded'],
      [new APIError(undefined, body('overloaded_error'), undefined, headers, 'overloaded_error'), 'provider_overloaded'],
      [new APIError(undefined, body('rate_limit_error'), undefined, headers, 'rate_limit_error'), 'provider_overloaded'],
      [new InternalServerError(500, body('api_error'), undefined, headers, 'api_error'), 'provider_unavailable'],
      [new InternalServerError(503, body('api_error'), undefined, headers, 'api_error'), 'provider_unavailable'],
      [new APIError(undefined, body('api_error'), undefined, headers, 'api_error'), 'provider_unavailable'],
      [new APIError(undefined, body('timeout_error'), undefined, headers, 'timeout_error'), 'provider_unavailable'],
      [new APIConnectionError({ message: 'Connection error.' }), 'provider_unavailable'],
      [new APIConnectionTimeoutError(), 'provider_unavailable'],
      [new BadRequestError(400, body('invalid_request_error'), undefined, headers, 'invalid_request_error'), 'internal'],
      [new AuthenticationError(401, body('authentication_error'), undefined, headers, 'authentication_error'), 'internal'],
      [new PermissionDeniedError(403, body('permission_error'), undefined, headers, 'permission_error'), 'internal'],
      [new NotFoundError(404, body('not_found_error'), undefined, headers, 'not_found_error'), 'internal'],
      [new APIUserAbortError(), 'internal'],
      [new AnthropicError('Unable to parse tool parameter JSON from model.'), 'internal'],
      [new TypeError('a bug'), 'internal'],
      ['a string', 'internal'],
    ];
    for (const [error, code] of cases) expect({ error: String(error), code: failureCode(error) }).toEqual({ error: String(error), code });
  });
});

describe('the request', () => {
  it('keeps one frozen prefix: the same system prompt and tools for every conversation, and no number in the prompt', () => {
    const one = requestParams([{ role: 'user', content: 'One' }]);
    const two = requestParams([{ role: 'user', content: 'Two' }, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Three' }]);
    expect(JSON.stringify([one.system, one.tools])).toBe(JSON.stringify([two.system, two.tools]));
    expect(SYSTEM_PROMPT).not.toMatch(/\d/);
    expect(TOOLS.map((tool) => tool.eager_input_streaming)).toEqual([true, true, true, true, true]);
  });
});

describe('a mid-reply fallback', () => {
  const boundary = (from: string, to: string): BetaContentBlock => ({
    type: 'fallback', from: { model: from }, to: { model: to }, trigger: { type: 'refusal', category: 'cyber' },
  });

  it('echoes a reply without a fallback block unchanged', () => {
    const content = [thinking('s1'), text('Hi'), toolUse('t1', 'list_notes', {})];
    expect(echoable(content)).toEqual(content);
  });

  it('keeps only text before the last fallback block, drops the block, and keeps everything after it', () => {
    const content = [
      thinking('declined-1'), text('Partial '), toolUse('t-declined', 'list_notes', {}),
      boundary('claude-opus-5-5', 'claude-opus-5'),
      thinking('declined-2'), text('more '),
      boundary('claude-opus-5', 'claude-opus-4-8'),
      thinking('kept'), text('Final'), toolUse('t-kept', 'list_notes', {}),
    ];
    expect(echoable(content)).toEqual([
      text('Partial '), text('more '), thinking('kept'), text('Final'), toolUse('t-kept', 'list_notes', {}),
    ]);
  });
});
