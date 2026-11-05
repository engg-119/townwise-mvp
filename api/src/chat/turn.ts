// One tuning chat turn (docs/portal/tuning-chat.md sections 3 and 4): a manual streaming loop. Stream a model call,
// take its finalMessage(), run its tool calls, append, repeat, for at most 8 calls. Every assistant message is kept
// exactly as received, thinking blocks included, except what a mid-reply fallback requires dropping (echoable). The
// turn's messages are returned for one save; a failed or aborted turn returns nothing to save, only its cost, which is
// charged after every call either way.
import { AnthropicError, APIConnectionError, APIError, InternalServerError, RateLimitError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaRawMessageStreamEvent, BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { NoteContent } from '../stores/notes.ts';
import type { StoredMessage } from '../stores/chat-conversations.ts';
import type { ChatModel } from './model.ts';
import { costMicroUsd, messageCostMicroUsd, tokensOf, type TokenCounts } from './pricing.ts';
import { SYSTEM_PROMPT, TOOLS, type ToolName } from './prompt.ts';
import { runTool, type ToolContext } from './tools.ts';

export const CHAT_MODEL = 'claude-opus-5-5';
export const MAX_CALLS_PER_TURN = 8;
/** Consecutive retries of a call whose tool input the SDK could not parse at all. */
const MAX_JSON_RETRIES = 2;

export type DoneReason = 'end_turn' | 'max_tokens' | 'refusal' | 'tool_limit';
export type FailureCode = 'internal' | 'provider_unavailable' | 'provider_overloaded';

/** What the turn streams to the client between `conversation` and `done` or `error`. */
export type TurnEvent =
  | { type: 'text'; data: { delta: string } }
  | { type: 'tool'; data: { name: ToolName; state: 'running' | 'done' | 'error' } }
  | { type: 'proposal'; data: { proposal: NoteContent } };

export type TurnResult =
  | {
    kind: 'done'; stopReason: DoneReason; messages: StoredMessage[]; calls: number; model: string;
    inputTokens: number; outputTokens: number; costMicroUsd: number;
  }
  | { kind: 'failed'; code: FailureCode; errType: string; status: number | null; calls: number; costMicroUsd: number }
  | { kind: 'aborted'; calls: number; costMicroUsd: number };

export interface TurnInput {
  readonly model: ChatModel;
  readonly tools: ToolContext;
  /** The conversation so far, exactly as stored. */
  readonly history: readonly BetaMessageParam[];
  readonly userMessage: BetaMessageParam;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly emit: (event: TurnEvent) => void;
  /** Adds one call's cost to the organization's month. */
  readonly charge: (costMicroUsd: number) => Promise<void>;
}

const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/** Every request: the frozen prefix (system, tools), then the conversation. */
export function requestParams(messages: BetaMessageParam[]): BetaMessageStreamParams {
  return {
    model: CHAT_MODEL,
    max_tokens: 16_000,
    output_config: { effort: 'low' },
    // Adaptive thinking is Opus 5.5's only mode, so `thinking` is omitted.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    cache_control: { type: 'ephemeral' },
    system: SYSTEM_PROMPT,
    tools: [...TOOLS],
    messages,
  };
}

/** Section 4: overloaded or rate limited, then connection errors and 5xx, then anything else. */
export function failureCode(err: unknown): FailureCode {
  if (err instanceof RateLimitError) return 'provider_overloaded';
  if (err instanceof InternalServerError) {
    return err.status === 529 || err.type === 'overloaded_error' ? 'provider_overloaded' : 'provider_unavailable';
  }
  if (err instanceof APIConnectionError) return 'provider_unavailable';
  if (err instanceof APIError) {
    // An `error` event in the middle of a stream has no HTTP status, only the API's error type.
    if (err.type === 'overloaded_error' || err.type === 'rate_limit_error') return 'provider_overloaded';
    if (err.type === 'api_error' || err.type === 'timeout_error') return 'provider_unavailable';
  }
  return 'internal';
}

/**
 * The SDK's error for a tool input it could not parse as JSON at all. It has no class of its own: it is a plain
 * AnthropicError, while every failure the API reports is an APIError (aborts included).
 */
function isUnparseableToolInput(err: unknown): boolean {
  return err instanceof AnthropicError && !(err instanceof APIError);
}

/** What a call that never finished used so far, from message_start and message_delta, for its cost. */
function usageTracker(): { observe(event: BetaRawMessageStreamEvent): void; costMicroUsd(): number } {
  let model: string | null = null;
  let tokens: TokenCounts | null = null;
  return {
    observe(event) {
      if (event.type === 'message_start') {
        model = event.message.model;
        tokens = tokensOf(event.message.usage);
      } else if (event.type === 'message_delta' && tokens !== null) {
        tokens = {
          input: event.usage.input_tokens ?? tokens.input,
          output: event.usage.output_tokens,
          cacheRead: event.usage.cache_read_input_tokens ?? tokens.cacheRead,
          cacheWrite: event.usage.cache_creation_input_tokens ?? tokens.cacheWrite,
        };
      }
    },
    costMicroUsd: () => (model === null || tokens === null ? 0 : costMicroUsd(model, tokens)),
  };
}

/**
 * Answers for tool calls that will not run (a refusal, or a reply cut off at max_tokens), so the stored history
 * stays a valid request: the API rejects a tool_use with no tool_result after it.
 */
function notRun(blocks: readonly BetaToolUseBlock[]): BetaMessageParam {
  return {
    role: 'user',
    content: blocks.map((block): BetaToolResultBlockParam => ({
      type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'Not run: the reply stopped before this call could run.',
    })),
  };
}

/**
 * The blocks of a reply that are sent back and acted on. After a server-side fallback in the middle of a reply, the
 * declined model's blocks before the last `fallback` block are echoed back only as text: its thinking, redacted
 * thinking, tool calls and any other model-internal blocks are dropped, and its tool calls never run. The `fallback`
 * block itself is an audit marker and is dropped too. Everything after the boundary is kept unchanged.
 */
export function echoable(content: readonly BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.findLastIndex((block) => block.type === 'fallback');
  if (boundary === -1) return [...content];
  return content.filter((block, index) => index > boundary || block.type === 'text');
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const turn: BetaMessageParam[] = [];
  const stored: StoredMessage[] = [];
  const append = (param: BetaMessageParam): void => {
    turn.push(param);
    stored.push({ at: input.now(), param: JSON.stringify(param) });
  };
  let calls = 0;
  let spent = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let model = CHAT_MODEL;
  const charge = async (cost: number): Promise<void> => {
    if (cost <= 0) return;
    spent += cost;
    await input.charge(cost);
  };
  const done = (stopReason: DoneReason): TurnResult => ({
    kind: 'done', stopReason, messages: stored, calls, model, inputTokens, outputTokens, costMicroUsd: spent,
  });

  // A function, not a property read: the signal changes under the loop, which narrowing cannot see.
  const aborted = (): boolean => input.signal.aborted;

  append(input.userMessage);
  try {
    let jsonRetries = 0;
    for (;;) {
      if (calls === MAX_CALLS_PER_TURN) return done('tool_limit');
      if (aborted()) return { kind: 'aborted', calls, costMicroUsd: spent };
      calls += 1;
      const usage = usageTracker();
      let message: BetaMessage;
      try {
        const stream = input.model.stream(requestParams([...input.history, ...turn]), { signal: input.signal });
        for await (const event of stream) {
          usage.observe(event);
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            input.emit({ type: 'text', data: { delta: event.delta.text } });
          }
        }
        message = await stream.finalMessage();
      } catch (err) {
        await charge(usage.costMicroUsd());
        if (!aborted() && isUnparseableToolInput(err) && jsonRetries < MAX_JSON_RETRIES) {
          // The tool_use block never completed, so there is no id to answer: re-issue the same call.
          jsonRetries += 1;
          continue;
        }
        throw err;
      }
      jsonRetries = 0;
      await charge(messageCostMicroUsd(message));
      const tokens = tokensOf(message.usage);
      inputTokens += tokens.input + tokens.cacheRead + tokens.cacheWrite;
      outputTokens += tokens.output;
      model = message.model;
      const content = echoable(message.content);
      // A refusal before any output has no content; an empty assistant message would make the next request invalid.
      if (content.length > 0) append({ role: 'assistant', content });

      const toolUses = content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      const stop = message.stop_reason;
      if (stop === 'refusal' || stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
        // A refusal can cut a tool call off mid-input, and so can max_tokens: never run that call.
        if (toolUses.length > 0) append(notRun(toolUses));
        return done(stop === 'refusal' ? 'refusal' : 'max_tokens');
      }
      if (toolUses.length === 0) return done('end_turn');

      const results: BetaToolResultBlockParam[] = [];
      for (const block of toolUses) {
        const name = TOOL_NAMES.includes(block.name) ? block.name as ToolName : null;
        if (name !== null) input.emit({ type: 'tool', data: { name, state: 'running' } });
        const outcome = await runTool(input.tools, block);
        results.push(outcome.result);
        if (outcome.proposal !== null) input.emit({ type: 'proposal', data: { proposal: outcome.proposal } });
        if (name !== null) input.emit({ type: 'tool', data: { name, state: outcome.result.is_error === true ? 'error' : 'done' } });
      }
      append({ role: 'user', content: results });
    }
  } catch (err) {
    if (aborted()) return { kind: 'aborted', calls, costMicroUsd: spent };
    return {
      kind: 'failed', code: failureCode(err), calls, costMicroUsd: spent,
      errType: err instanceof Error ? err.constructor.name : typeof err,
      status: err instanceof APIError && typeof err.status === 'number' ? err.status : null,
    };
  }
}
