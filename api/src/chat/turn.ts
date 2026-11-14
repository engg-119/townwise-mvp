// One tuning chat turn (docs/portal/tuning-chat.md sections 3 and 4): a manual streaming loop. Stream a model call,
// take its finalMessage(), run its tool calls, append, repeat, for at most 8 calls. Every assistant message is kept
// exactly as received, thinking blocks included, except what a mid-reply fallback requires dropping (echoable). The
// turn's messages are returned for one save (savedTurn: an item's text is kept only as a stub, and an attached file's
// content is sent but never saved); a failed, aborted or refused turn returns nothing to save, only its cost, which is
// charged after every call either way.
import { AnthropicError, APIConnectionError, APIError, InternalServerError, RateLimitError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaRawContentBlockDelta, BetaRawMessageStreamEvent,
  BetaToolResultBlockParam, BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { NoteContent } from '../stores/notes.ts';
import type { StoredMessage } from '../stores/chat-conversations.ts';
import type { ChatModel } from './model.ts';
import { costMicroUsd, messageCostMicroUsd, searchCostMicroUsd, tokensOf, type TokenCounts } from './pricing.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { UNANSWERED_RESULT } from './tools/next.ts';
import { inputViewOf, resultViewOf, runTool, savedResultOf, toolNamed, TOOLS, type ToolContext, type ToolView } from './tools/registry.ts';
import type { Visual } from './tools/visual.ts';
import { citedSources, searchFound, searchResultView, WEB_SEARCH, WEB_SEARCH_TOOL, type SourceLink } from './web-search.ts';

export const CHAT_MODEL = 'claude-opus-5-5';
export const MAX_TOKENS = 16_000;
export const MAX_CALLS_PER_TURN = 8;
/** Tool calls run from one assistant message; the rest are answered without running. */
export const MAX_TOOLS_PER_MESSAGE = 5;
/**
 * A whole turn's time limit. The Container Apps ingress closes an HTTP request at about 240 seconds, and a live-turn
 * claim goes stale at 3 minutes, so a turn ends well before either.
 */
export const TURN_TIME_LIMIT_MS = 150_000;
/** Consecutive retries of a call whose tool input the SDK could not parse at all. */
const MAX_JSON_RETRIES = 2;

/** Why a saved turn ended. A refusal is not one: a refused turn saves nothing. */
export type DoneReason = 'end_turn' | 'max_tokens' | 'tool_limit' | 'budget';
export type FailureCode = 'internal' | 'provider_unavailable' | 'provider_overloaded';

/**
 * What the turn streams to the client between `conversation` and `done` or `error`. `id` is the tool_use block's id.
 * A tool event's `input` is its input view on every state; `result` is its result view, on `done` only.
 */
export type TurnEvent =
  | { type: 'text'; data: { delta: string } }
  /** A piece of the reply's thinking summary: text only, never the signature. Same class as message text, never logged. */
  | { type: 'thinking'; data: { delta: string } }
  | {
    type: 'tool';
    data: { id: string; name: string; state: 'running' | 'done' | 'error'; input: ToolView | null; result: ToolView | null };
  }
  | { type: 'proposal'; data: { id: string; proposal: NoteContent } }
  | { type: 'visual'; data: { id: string; visual: Visual } }
  | { type: 'suggestions'; data: { id: string; prompts: string[] } };

/** How every answer to a tool call that never ran begins; GET .../chat/:conversationId leaves those calls out. */
export const NOT_RUN = 'Not run: ';

export type TurnResult =
  | {
    kind: 'done'; stopReason: DoneReason; messages: StoredMessage[]; calls: number; model: string;
    inputTokens: number; outputTokens: number; costMicroUsd: number;
    /** The reply node when it stored an assistant message, else the user node, else the reply's parent. */
    leafId: string;
    /** The pages the reply's text cites from its web searches (web-search.ts), shown with it. */
    sources: SourceLink[];
  }
  | { kind: 'refused'; calls: number; model: string; costMicroUsd: number }
  | { kind: 'failed'; code: FailureCode; errType: string; status: number | null; calls: number; costMicroUsd: number }
  | { kind: 'aborted'; calls: number; costMicroUsd: number };

/** A tree node the turn writes (src/chat/tree.ts). */
export interface TurnNode { readonly id: string; readonly parentId: string | null }

/** One message of a turn as it ran, with the tree node it is stored under (absent only in savedTurn's own tests). */
export interface TurnMessage { readonly at: Date; readonly param: BetaMessageParam; readonly nodeId?: string; readonly parentId?: string | null }

export interface TurnInput {
  readonly model: ChatModel;
  readonly tools: ToolContext;
  /** The path the turn continues, root to the turn's parent, exactly as stored. */
  readonly history: readonly BetaMessageParam[];
  /** Null for a regenerate: the history already ends with the person's message. */
  readonly userMessage: BetaMessageParam | null;
  /**
   * The person's message as every request of this turn sends it, when that differs from the stored one
   * (chat/attachments.ts expandedMessage): with its files' content, which is never saved, or a regenerate's block
   * written again. It stands in for `userMessage`, or for a regenerate for the history's last message. Null when the
   * message is sent as stored; then the turn's thinking is saved as usual.
   */
  readonly expanded: BetaMessageParam | null;
  /** The nodes the turn's messages are stored under: `user` is null for a regenerate, and `reply.parentId` is the user node. */
  readonly nodes: { readonly user: TurnNode | null; readonly reply: { readonly id: string; readonly parentId: string } };
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly emit: (event: TurnEvent) => void;
  /** Adds one call's cost to the organization's month. */
  readonly charge: (costMicroUsd: number) => Promise<void>;
  /** True when the organization's budget for the month is spent. Asked before every model call after the first. */
  readonly budgetSpent: () => Promise<boolean>;
}

/** Every request: the frozen prefix (system, the registry's tools, then web search), then the conversation. */
export function requestParams(messages: BetaMessageParam[]): BetaMessageStreamParams {
  return {
    model: CHAT_MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: 'low' },
    // Adaptive is Opus 5.5's only thinking mode (`disabled` and `budget_tokens` both 400). `display` changes what the
    // stream shows, not what is billed: Opus 5.5 omits the thinking text by default, so ask for its summary.
    // A stored thinking block is valid only against the system prompt and tools it was made with, so a release that
    // changes either invalidates every earlier conversation's blocks. drop_block drops those blocks and answers, where
    // the default (enforced for newer Anthropic accounts) would refuse every later turn of those conversations.
    thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
    fallbacks: 'default',
    cache_control: { type: 'ephemeral' },
    system: SYSTEM_PROMPT,
    tools: [...TOOLS, WEB_SEARCH_TOOL],
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

/** The characters a content delta streams: text, thinking and tool input. */
function streamedCharacters(delta: BetaRawContentBlockDelta): number {
  switch (delta.type) {
    case 'text_delta': return delta.text.length;
    case 'thinking_delta': return delta.thinking.length;
    case 'input_json_delta': return delta.partial_json.length;
    default: return 0;
  }
}

/**
 * What a call that never finished used so far, for its cost. Input tokens come from message_start and output tokens
 * only from message_delta. A call aborted or failed after message_start but before message_delta is charged an output
 * estimate instead of the token or so message_start reports:
 *
 *   min(max_tokens, max(ceil(streamed characters / 3), ceil(seconds since message_start x 150)))
 *
 * at the price of the model that was answering. Streamed characters are those of text, thinking and tool input
 * deltas; the time term covers thinking that is billed but not streamed (a summary is shorter than the thinking behind it).
 * Each web search whose result came back with pages is charged too, or the count message_delta reports once it has.
 */
function usageTracker(now: () => Date): { observe(event: BetaRawMessageStreamEvent): void; costMicroUsd(): number } {
  let model: string | null = null;
  let tokens: TokenCounts | null = null;
  let startedAt = 0;
  let characters = 0;
  let searches = 0;
  let outputReported = false;
  return {
    observe(event) {
      if (event.type === 'message_start') {
        model = event.message.model;
        tokens = tokensOf(event.message.usage);
        startedAt = now().getTime();
      } else if (event.type === 'content_block_start' && event.content_block.type === 'web_search_tool_result') {
        if (searchFound(event.content_block.content)) searches += 1;
      } else if (event.type === 'content_block_delta') {
        characters += streamedCharacters(event.delta);
      } else if (event.type === 'message_delta' && tokens !== null) {
        outputReported = true;
        searches = event.usage.server_tool_use?.web_search_requests ?? searches;
        tokens = {
          input: event.usage.input_tokens ?? tokens.input,
          output: event.usage.output_tokens,
          cacheRead: event.usage.cache_read_input_tokens ?? tokens.cacheRead,
          cacheWrite: event.usage.cache_creation_input_tokens ?? tokens.cacheWrite,
        };
      }
    },
    costMicroUsd() {
      if (model === null || tokens === null) return 0;
      if (outputReported) return costMicroUsd(model, tokens) + searchCostMicroUsd(searches);
      const seconds = (now().getTime() - startedAt) / 1000;
      const output = Math.min(MAX_TOKENS, Math.max(Math.ceil(characters / 3), Math.ceil(seconds * 150)));
      return costMicroUsd(model, { ...tokens, output }) + searchCostMicroUsd(searches);
    },
  };
}

/**
 * The card of a web search as it streams: running when the model starts one, then done with its result view, or an
 * error when it failed. Never its query (web-search.ts). Null for every other event.
 */
function searchCard(event: BetaRawMessageStreamEvent): TurnEvent | null {
  if (event.type !== 'content_block_start') return null;
  const block = event.content_block;
  if (block.type === 'server_tool_use' && block.name === WEB_SEARCH) {
    return { type: 'tool', data: { id: block.id, name: WEB_SEARCH, state: 'running', input: null, result: null } };
  }
  if (block.type !== 'web_search_tool_result') return null;
  const result = searchResultView(block.content);
  return { type: 'tool', data: { id: block.tool_use_id, name: WEB_SEARCH, state: result === null ? 'error' : 'done', input: null, result } };
}

/**
 * Answers for tool calls that will not run (a reply cut off at max_tokens), so the stored history stays a valid
 * request: the API rejects a tool_use with no tool_result after it.
 */
function notRun(blocks: readonly BetaToolUseBlock[]): BetaMessageParam {
  return {
    role: 'user',
    content: blocks.map((block): BetaToolResultBlockParam => ({
      type: 'tool_result', tool_use_id: block.id, is_error: true, content: `${NOT_RUN}the reply stopped before this call could run.`,
    })),
  };
}

/** The answer for a tool call past the per-message cap. */
function tooMany(block: BetaToolUseBlock): BetaToolResultBlockParam {
  return {
    type: 'tool_result', tool_use_id: block.id, is_error: true,
    content: `${NOT_RUN}the reply asked for too many tool calls at once. At most ${MAX_TOOLS_PER_MESSAGE} run from one reply; ask for the rest in the next one.`,
  };
}

/**
 * Whether the turn wrote text the owner sees after its last tool call other than suggest_next: the answer. Text before
 * that call is an aside written ahead of the work ("Next week, presumably."), not an answer to it, and Opus 5.5
 * returns text written before a tool call in the same message as thinking, which the owner never sees as a reply.
 */
function wroteText(turn: readonly BetaMessageParam[]): boolean {
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const param = turn[index];
    if (param?.role !== 'assistant' || typeof param.content === 'string') continue;
    // A message that calls a tool other than suggest_next did work after any text it holds: that text came first.
    if (param.content.some((block) => block.type === 'tool_use' && block.name !== 'suggest_next')) return false;
    if (param.content.some((block) => block.type === 'text' && block.text.trim() !== '')) return true;
  }
  return false;
}

/** A suggest_next result that also asks for the answer the turn has not written; an error result stays as it is. */
function askForAnswer(result: BetaToolResultBlockParam): BetaToolResultBlockParam {
  return result.is_error === true ? result : { ...result, content: UNANSWERED_RESULT };
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

/**
 * What one finished turn saves (section 3): its messages as the model read them, except a result its tool keeps only a
 * stub of (read_data_item, D28), so a later turn never resends an item's text after it is turned off, deleted or
 * purged. A thinking block's signature binds everything before it (preserved thinking), so every thinking block after
 * the first stubbed result is dropped too; blocks before it stay valid, and an assistant message left with nothing is
 * dropped. The turn's own later calls already read the whole result. The saved history is append-only from then on.
 * `expanded` (the turn sent the person's message other than as stored, D36): every thinking block of the turn comes
 * after content that is never saved, so none is.
 */
export function savedTurn(turn: readonly TurnMessage[], expanded = false): StoredMessage[] {
  const names = new Map<string, string>();
  let stubbed = expanded;
  const saved: StoredMessage[] = [];
  for (const { param, ...placed } of turn) {
    let kept = param;
    if (typeof param.content !== 'string' && param.role === 'assistant') {
      for (const block of param.content) if (block.type === 'tool_use') names.set(block.id, block.name);
      if (stubbed) {
        const content = param.content.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking');
        if (content.length === 0) continue;
        kept = { ...param, content };
      }
    } else if (typeof param.content !== 'string' && param.role === 'user') {
      const content: typeof param.content = [];
      for (const block of param.content) {
        const result = block.type === 'tool_result' ? savedResultOf(names.get(block.tool_use_id) ?? '', block) : block;
        if (result !== block) stubbed = true;
        content.push(result);
      }
      kept = { ...param, content };
    }
    // Its time and its tree node, unchanged: a dropped message never moves another one to a different node.
    saved.push({ ...placed, param: JSON.stringify(kept) });
  }
  return saved;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const turn: BetaMessageParam[] = [];
  const timed: TurnMessage[] = [];
  const { user, reply } = input.nodes;
  const append = (param: BetaMessageParam, node: TurnNode = reply): void => {
    turn.push(param);
    timed.push({ at: input.now(), param, nodeId: node.id, parentId: node.parentId });
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
  const done = (stopReason: DoneReason): TurnResult => {
    const messages = savedTurn(timed, input.expanded !== null);
    return {
      kind: 'done', stopReason, messages, calls, model, inputTokens, outputTokens, costMicroUsd: spent,
      // A reply's messages start with an assistant message, so the last one stored names the deepest node written.
      leafId: messages.at(-1)?.nodeId ?? reply.parentId,
      sources: citedSources(turn.flatMap((param) => (param.role === 'assistant' && typeof param.content !== 'string' ? param.content : []))),
    };
  };

  // A function, not a property read: the signal changes under the loop, which narrowing cannot see.
  const aborted = (): boolean => input.signal.aborted;

  // Every request: the history and the turn so far, with the person's message (a regenerate's is the history's last)
  // sent as `expanded` when it carries attachments. What is saved is `turn`, which holds the stored form.
  const personAt = input.userMessage === null ? input.history.length - 1 : input.history.length;
  const requestMessages = (): BetaMessageParam[] => {
    const messages = [...input.history, ...turn];
    if (input.expanded !== null) messages[personAt] = input.expanded;
    return messages;
  };

  if (input.userMessage !== null && user !== null) append(input.userMessage, user);
  try {
    let jsonRetries = 0;
    for (;;) {
      if (calls === MAX_CALLS_PER_TURN) return done('tool_limit');
      if (aborted()) return { kind: 'aborted', calls, costMicroUsd: spent };
      // The handler checked the budget before the first call. A later call that finds it spent is not made: the turn
      // ends after its last complete step, whose tool calls all have results, so the saved history stays valid.
      if (calls > 0 && await input.budgetSpent()) return done('budget');
      calls += 1;
      const usage = usageTracker(input.now);
      let message: BetaMessage;
      try {
        const stream = input.model.stream(requestParams(requestMessages()), { signal: input.signal });
        for await (const event of stream) {
          usage.observe(event);
          const card = searchCard(event);
          if (card !== null) input.emit(card);
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            input.emit({ type: 'text', data: { delta: event.delta.text } });
          } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
            input.emit({ type: 'thinking', data: { delta: event.delta.thinking } });
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
      const stop = message.stop_reason;
      // A refused turn saves nothing, as a failed one: no user message, no partial reply, no results for its calls.
      if (stop === 'refusal') return { kind: 'refused', calls, model, costMicroUsd: spent };
      const content = echoable(message.content);
      // An empty assistant message would make the next request invalid.
      if (content.length > 0) append({ role: 'assistant', content });

      const toolUses = content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
        // max_tokens can cut a tool call off mid-input: never run that call.
        if (toolUses.length > 0) append(notRun(toolUses));
        return done('max_tokens');
      }
      // The API paused a long web search turn: the paused reply, sent back unchanged as the last message, resumes it.
      if (stop === 'pause_turn' && toolUses.length === 0) continue;
      if (toolUses.length === 0) return done('end_turn');

      const results: BetaToolResultBlockParam[] = [];
      for (const [index, block] of toolUses.entries()) {
        if (index >= MAX_TOOLS_PER_MESSAGE) {
          results.push(tooMany(block));
          continue;
        }
        // Only a registered tool gets events; an unknown name is answered as an error without any.
        const known = toolNamed(block.name) !== undefined;
        const { id, name } = block;
        const view = inputViewOf(name, block.input, input.tools.today);
        if (known) input.emit({ type: 'tool', data: { id, name, state: 'running', input: view, result: null } });
        const outcome = await runTool(input.tools, block);
        results.push(outcome.result);
        if (outcome.proposal !== null) input.emit({ type: 'proposal', data: { id, proposal: outcome.proposal } });
        if (outcome.visual !== null) input.emit({ type: 'visual', data: { id, visual: outcome.visual } });
        if (outcome.prompts !== null) input.emit({ type: 'suggestions', data: { id, prompts: outcome.prompts } });
        if (known) {
          const state = outcome.result.is_error === true ? 'error' : 'done';
          input.emit({ type: 'tool', data: { id, name, state, input: view, result: resultViewOf(name, outcome.result) } });
        }
      }
      // suggest_next is a reply's last step: a message that called only it is answered and ends the turn without
      // another model call, valid or not (the client then picks its own three). The saved reply ends with its results.
      // The model often calls it right after thinking out its answer, having written no text: the owner sees none of
      // its thinking, so then its result asks for the answer and the loop goes on.
      const onlyNext = toolUses.every((block) => block.name === 'suggest_next');
      const unanswered = onlyNext && !wroteText(turn);
      append({ role: 'user', content: unanswered ? results.map(askForAnswer) : results });
      if (onlyNext && !unanswered) return done('end_turn');
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
