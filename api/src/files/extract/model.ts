// The file reader's models, as ports, and the only file of the file code that constructs a model client: the AI column
// step's (spec 11A), whose request holds only the redacted profile, reading with TownwiseAI's (spec 11A.9), whose
// request (reader.ts) holds a file the person opted in, and reading the ordering setup's (spec D41), whose request
// (setup-reader.ts) holds the file or text the person gave it. main.ts builds the real ones when ANTHROPIC_API_KEY is
// set; tests pass scripted fakes. Nothing here logs: a failure leaves as `failed` with the error's class and HTTP status, never
// its message or the request (and, for a reader's stream that had begun, the cost of what it had reported).
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaMessage, BetaRawContentBlockDelta, BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { costMicroUsd, messageCostMicroUsd, tokensOf, type TokenCounts } from '../../chat/pricing.ts';
import type { RedactedProfile } from './profile.ts';
import { columnsAnswer, EXTRACT_MAX_TOKENS, EXTRACT_MODEL, EXTRACT_TIMEOUT_MS, SYSTEM_PROMPT, type ColumnChoice } from './prompt.ts';
import type { FileReaderModel, ReaderAnswer } from './reader.ts';
import { READER_TIMEOUT_MS, readerAnswer } from './reader-prompt.ts';
import { SETUP_EFFORT, SETUP_READ_TIME_MS, setupAnswer } from './setup-prompt.ts';

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

function failed(err: unknown, streamedMicroUsd?: number): Extract<ReaderAnswer, { kind: 'failed' }> {
  const status: unknown = err instanceof Anthropic.APIError ? err.status : null;
  return {
    kind: 'failed', errType: err instanceof Error ? err.constructor.name : 'unknown', status: typeof status === 'number' ? status : null,
    ...(streamedMicroUsd === undefined ? {} : { streamedMicroUsd }),
  };
}

/** About how many characters an output token is, to estimate the output a stream that ended early had written. */
const CHARS_PER_TOKEN = 3;

/** The characters a delta streams: text, thinking, or a tool's JSON. */
function deltaChars(delta: BetaRawContentBlockDelta): number {
  switch (delta.type) {
    case 'text_delta': return delta.text.length;
    case 'thinking_delta': return delta.thinking.length;
    case 'input_json_delta': return delta.partial_json.length;
    default: return 0;
  }
}

/**
 * What a stream has reported so far, kept as its events arrive: the answering model (a refusal fallback's once it
 * takes over), the input tokens from message_start, and the output, the larger of what it counted and the characters
 * streamed at CHARS_PER_TOKEN. `costMicroUsd()` is that at the model's list prices, or undefined before message_start.
 */
function streamTally(): { onEvent: (event: BetaRawMessageStreamEvent) => void; costMicroUsd: () => number | undefined } {
  let model: string | null = null;
  let tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let chars = 0;
  return {
    onEvent(event) {
      if (event.type === 'message_start') {
        model = event.message.model;
        tokens = tokensOf(event.message.usage);
      } else if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
        model = event.content_block.to.model;
      } else if (event.type === 'content_block_delta') {
        chars += deltaChars(event.delta);
      } else if (event.type === 'message_delta') {
        tokens = { ...tokens, output: event.usage.output_tokens };
      }
    },
    costMicroUsd() {
      if (model === null) return undefined;
      return costMicroUsd(model, { ...tokens, output: Math.max(tokens.output, Math.ceil(chars / CHARS_PER_TOKEN)) });
    },
  };
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

/** Reading the ordering setup's answer schema (setup-prompt.ts), made the same way. */
export const SETUP_FORMAT = { type: 'json_schema', schema: betaZodOutputFormat(setupAnswer).schema } as const;

/**
 * A TownwiseAI reader's model: the Anthropic API streamed, with the server-side refusal fallback the chat uses,
 * structured output, `timeoutMs` to the start of the answer and one SDK retry. Not the parse helpers: they throw on an
 * answer outside the schema's limits or on a refusal's text, and each reader checks the answer itself (readerResult,
 * setupResult), so a refusal is charged and an over-long entry is dropped instead of failing the call. An answer cut
 * at max_tokens is `too_long`. A call that fails once its stream has begun (aborted, or an error mid-stream) says what
 * the stream had reported (streamTally), as `streamedMicroUsd`; one that fails before any stream event says nothing.
 */
function streamedReaderModel(
  apiKey: string, call: { effort: 'low' | 'medium'; format: typeof READER_FORMAT | typeof SETUP_FORMAT; timeoutMs: number },
  fetch: typeof globalThis.fetch | undefined,
): FileReaderModel {
  const client = anthropicClient(apiKey, { ...(fetch === undefined ? {} : { fetch }), maxRetries: 1 });
  return {
    async readFile(request, signal) {
      const tally = streamTally();
      try {
        const message = await client.beta.messages.stream({
          ...request,
          // Adaptive thinking is Opus 5.5's only mode, so `thinking` is omitted.
          output_config: { effort: call.effort, format: call.format },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        }, { signal, timeout: call.timeoutMs }).on('streamEvent', tally.onEvent).finalMessage();
        const costMicroUsd = messageCostMicroUsd(message);
        if (message.stop_reason === 'refusal') return { kind: 'refused', costMicroUsd };
        if (message.stop_reason === 'max_tokens') return { kind: 'too_long', costMicroUsd };
        return { kind: 'answered', output: answerJson(message), costMicroUsd };
      } catch (err) {
        return failed(err, tally.costMicroUsd());
      }
    },
  };
}

/**
 * Reading with TownwiseAI (spec 11A.9): medium effort, streamed (the answer may run to 64,000 tokens, which a single
 * response would not hold within the timeout), a 300-second timeout to the start of the answer and one SDK retry (the
 * reader backs off and retries the rest itself).
 */
export function createAnthropicFileReaderModel(apiKey: string, fetch?: typeof globalThis.fetch): FileReaderModel {
  return streamedReaderModel(apiKey, { effort: 'medium', format: READER_FORMAT, timeoutMs: READER_TIMEOUT_MS }, fetch);
}

/**
 * Reading the ordering setup with TownwiseAI (spec D41): SETUP_EFFORT, streamed, one SDK retry, and the read's whole
 * time as the timeout; the handler's signal ends the call SETUP_READ_TIME_MS after the request began.
 */
export function createAnthropicSetupReaderModel(apiKey: string, fetch?: typeof globalThis.fetch): FileReaderModel {
  return streamedReaderModel(apiKey, { effort: SETUP_EFFORT, format: SETUP_FORMAT, timeoutMs: SETUP_READ_TIME_MS }, fetch);
}
