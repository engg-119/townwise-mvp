// The file reader's models, as ports, and the only file of the file code that constructs a model client: the AI column
// step's (spec 11A), whose request holds only the redacted profile, and reading with TownwiseAI's (spec 11A.9), whose
// request (reader.ts) holds a file the person opted in. main.ts builds the real ones when ANTHROPIC_API_KEY is set; tests
// pass scripted fakes. Nothing here logs: a failure leaves as `failed` with the error's class and HTTP status, never
// its message or the request.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { messageCostMicroUsd } from '../../chat/pricing.ts';
import type { RedactedProfile } from './profile.ts';
import { columnsAnswer, EXTRACT_MAX_TOKENS, EXTRACT_MODEL, EXTRACT_TIMEOUT_MS, SYSTEM_PROMPT, type ColumnChoice } from './prompt.ts';
import type { FileReaderModel, ReaderAnswer } from './reader.ts';
import { READER_TIMEOUT_MS, readerAnswer } from './reader-prompt.ts';

export type ExtractResult =
  /** `choice` is null when the model declined or its answer did not parse; the call still cost what it cost. */
  | { readonly kind: 'answered'; readonly choice: ColumnChoice | null; readonly costMicroUsd: number }
  | { readonly kind: 'failed'; readonly errType: string; readonly status: number | null };

export interface ExtractModel {
  chooseColumns(profile: RedactedProfile, signal: AbortSignal): Promise<ExtractResult>;
}

/** The request the step sends, exactly: the frozen prompt and the profile as JSON. */
export function extractRequest(profile: RedactedProfile): {
  model: string; max_tokens: number; system: string; messages: { role: 'user'; content: string }[];
} {
  return {
    model: EXTRACT_MODEL,
    max_tokens: EXTRACT_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(profile) }],
  };
}

/**
 * The Anthropic API at low effort, non-streaming, with the server-side refusal fallback the chat uses. The SDK's own
 * logger is off; retries are the SDK's defaults and the timeout is 60 seconds.
 */
export function createAnthropicExtractModel(apiKey: string): ExtractModel {
  const client = anthropicClient(apiKey);
  return {
    async chooseColumns(profile, signal) {
      try {
        const message = await client.beta.messages.parse({
          ...extractRequest(profile),
          // Adaptive thinking is Opus 5.5's only mode, so `thinking` is omitted.
          output_config: { effort: 'low', format: betaZodOutputFormat(columnsAnswer) },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        }, { signal, timeout: EXTRACT_TIMEOUT_MS });
        const choice = message.stop_reason === 'refusal' ? null : message.parsed_output;
        return { kind: 'answered', choice, costMicroUsd: messageCostMicroUsd(message) };
      } catch (err) {
        return failed(err);
      }
    },
  };
}

/**
 * The client both models use: the SDK's own logger off, its retries the defaults unless `maxRetries` is given. Tests
 * pass a fake `fetch`.
 */
function anthropicClient(apiKey: string, opts: { fetch?: typeof globalThis.fetch; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({
    apiKey, logLevel: 'off', ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
  });
}

function failed(err: unknown): Extract<ReaderAnswer, { kind: 'failed' }> {
  const status: unknown = err instanceof Anthropic.APIError ? err.status : null;
  return { kind: 'failed', errType: err instanceof Error ? err.constructor.name : 'unknown', status: typeof status === 'number' ? status : null };
}

/** The answer's JSON from the message's text, or null when there is none or it does not parse. */
function answerJson(message: BetaMessage): unknown {
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The answer's JSON schema, as betaZodOutputFormat makes it (limits the API does not enforce become descriptions). */
export const READER_FORMAT = { type: 'json_schema', schema: betaZodOutputFormat(readerAnswer).schema } as const;

/**
 * Reading with TownwiseAI: the Anthropic API at medium effort, streamed (the answer may run to 64,000 tokens, which a
 * single response would not hold within the timeout), with the server-side refusal fallback the chat uses, structured
 * output, a 300-second timeout to the start of the answer and one SDK retry (the reader backs off and retries the rest itself). Not the parse
 * helpers: they throw on an answer outside the schema's limits or on a refusal's text, and the reader checks the
 * answer itself (reader-prompt.ts, readerResult), so a refusal is charged and an over-long fact is dropped instead of
 * failing the call. An answer cut at max_tokens is `too_long`.
 */
export function createAnthropicFileReaderModel(apiKey: string, fetch?: typeof globalThis.fetch): FileReaderModel {
  const client = anthropicClient(apiKey, { ...(fetch === undefined ? {} : { fetch }), maxRetries: 1 });
  return {
    async readFile(request, signal) {
      try {
        const message = await client.beta.messages.stream({
          ...request,
          // Adaptive thinking is Opus 5.5's only mode, so `thinking` is omitted.
          output_config: { effort: 'medium', format: READER_FORMAT },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        }, { signal, timeout: READER_TIMEOUT_MS }).finalMessage();
        const costMicroUsd = messageCostMicroUsd(message);
        if (message.stop_reason === 'refusal') return { kind: 'refused', costMicroUsd };
        if (message.stop_reason === 'max_tokens') return { kind: 'too_long', costMicroUsd };
        return { kind: 'answered', output: answerJson(message), costMicroUsd };
      } catch (err) {
        return failed(err);
      }
    },
  };
}
