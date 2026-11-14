// A scripted stand-in for the Anthropic API behind the ChatModel port (src/chat/model.ts). Each model call takes the
// next step of the script and streams the events the API would send for it (message_start, content_block_start,
// text, thinking, signature and input_json deltas, content_block_stop, message_delta, message_stop), then resolves
// finalMessage() with the message, or fails with one of the SDK's own error classes. Tests never call the real API.
import { APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlock, BetaIterationsUsage, BetaMessage, BetaMessageParam, BetaMessageStreamParams,
  BetaRawMessageStreamEvent, BetaStopReason, BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { ChatModel, ModelStream } from '../../src/chat/model.ts';

export interface UsageInput {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  iterations?: BetaIterationsUsage;
  /** Web searches the call ran (usage.server_tool_use); none when absent. */
  searches?: number;
}

export function usage(u: UsageInput = {}): BetaUsage {
  return {
    input_tokens: u.input ?? 100,
    output_tokens: u.output ?? 20,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
    cache_creation: null,
    fallback_credit: null,
    inference_geo: null,
    iterations: u.iterations ?? null,
    output_tokens_details: null,
    server_tool_use: u.searches === undefined ? null : { web_search_requests: u.searches, web_fetch_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

export function text(value: string): BetaContentBlock {
  return { type: 'text', text: value, citations: null };
}

/** Claude Opus 5.5 omits the thinking text by default: an empty `thinking` and an opaque signature. */
export function thinking(signature: string, value = ''): BetaContentBlock {
  return { type: 'thinking', thinking: value, signature };
}

export function toolUse(id: string, name: string, input: unknown): BetaContentBlock {
  return { type: 'tool_use', id, name, input };
}

/** A web search Anthropic runs (a server tool): the query is the model's. */
export function webSearch(id: string, query: string): BetaContentBlock {
  return { type: 'server_tool_use', id, name: 'web_search', input: { query } };
}

/** What a web search found, one page per url; an error code instead makes it a failed search. */
export function webResults(id: string, urls: string[] | { error: 'unavailable' | 'max_uses_exceeded' }): BetaContentBlock {
  return {
    type: 'web_search_tool_result', tool_use_id: id,
    content: Array.isArray(urls)
      ? urls.map((url, i) => ({ type: 'web_search_result', url, title: `Page ${String(i + 1)}`, encrypted_content: `enc-${String(i)}`, page_age: null }))
      : { type: 'web_search_tool_result_error', error_code: urls.error },
  };
}

/** Text that cites web pages, as the API returns it after a search. */
export function cited(value: string, urls: string[]): BetaContentBlock {
  return {
    type: 'text', text: value,
    citations: urls.map((url) => ({ type: 'web_search_result_location', url, title: 'A page', cited_text: value, encrypted_index: 'idx' })),
  };
}

let messageCount = 0;

export function message(
  content: BetaContentBlock[],
  opts: { stopReason?: BetaStopReason; usage?: UsageInput; model?: string } = {},
): BetaMessage {
  messageCount += 1;
  const stopReason = opts.stopReason ?? (content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return {
    id: `msg_test_${String(messageCount)}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-opus-5-5',
    content,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: stopReason === 'refusal'
      ? {
        type: 'refusal', category: 'cyber', explanation: null, fallback_credit_token: null, fallback_has_prefill_claim: null,
        recommended_model: null,
      }
      : null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage(opts.usage),
  };
}

/** Splits a string into pieces of at most `size` characters, as the API streams deltas. */
function pieces(value: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

/** The raw events the API streams for `final`, in order. */
export function eventsOf(final: BetaMessage): BetaRawMessageStreamEvent[] {
  const events: BetaRawMessageStreamEvent[] = [{
    type: 'message_start',
    message: {
      ...final, content: [], stop_reason: null, stop_details: null,
      usage: { ...final.usage, output_tokens: 1, iterations: null },
    },
  }];
  final.content.forEach((block, index) => {
    switch (block.type) {
      case 'text':
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } });
        for (const piece of pieces(block.text)) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
        }
        break;
      case 'thinking':
        events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        for (const piece of pieces(block.thinking)) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece, estimated_tokens: null } });
        }
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
        break;
      case 'tool_use':
        events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
        for (const piece of pieces(JSON.stringify(block.input))) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
        }
        break;
      default:
        events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    context_management: null,
    delta: { container: null, stop_details: final.stop_details, stop_reason: final.stop_reason, stop_sequence: null },
    usage: {
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
      cache_read_input_tokens: final.usage.cache_read_input_tokens,
      cache_creation_input_tokens: final.usage.cache_creation_input_tokens,
      fallback_credit: null,
      iterations: final.usage.iterations,
      output_tokens_details: null,
      server_tool_use: final.usage.server_tool_use,
    },
  });
  events.push({ type: 'message_stop' });
  return events;
}

/**
 * One model call. `message`: streams it and resolves it. `error`: streams `before` (raw events), then throws.
 * `hang`: streams `before`, then waits until the call is aborted. `gate`: waits for the promise before streaming.
 */
export type Step =
  | { kind: 'message'; message: BetaMessage; gate?: Promise<void> }
  | { kind: 'error'; error: unknown; before?: BetaRawMessageStreamEvent[] }
  | { kind: 'hang'; before: BetaRawMessageStreamEvent[] };

export interface RecordedCall {
  /** A deep copy of what the turn sent, as the SDK would serialize it. */
  params: BetaMessageStreamParams;
  signal: AbortSignal;
}

export interface ScriptedModel extends ChatModel {
  readonly calls: RecordedCall[];
  /** Appends steps; each model call takes the next one. */
  script(...steps: Step[]): void;
  /** Steps not yet taken. */
  remaining(): number;
}

function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new APIUserAbortError());
    signal.addEventListener('abort', () => { reject(new APIUserAbortError()); }, { once: true });
  });
}

export function scriptedModel(): ScriptedModel {
  const steps: Step[] = [];
  const calls: RecordedCall[] = [];
  return {
    calls,
    script(...more) { steps.push(...more); },
    remaining: () => steps.length,
    stream(params, options): ModelStream {
      calls.push({ params: JSON.parse(JSON.stringify(params)) as BetaMessageStreamParams, signal: options.signal });
      const step = steps.shift();
      if (step === undefined) throw new Error('the scripted model has no step left for this call');
      const { signal } = options;
      const events = step.kind === 'message' ? eventsOf(step.message) : step.before ?? [];
      let outcome: Promise<BetaMessage> | undefined;
      const run = async function* (): AsyncGenerator<BetaRawMessageStreamEvent> {
        if (step.kind === 'message' && step.gate !== undefined) await Promise.race([step.gate, abortedBy(signal)]);
        for (const event of events) {
          await tick();
          if (signal.aborted) throw new APIUserAbortError();
          yield event;
        }
        if (step.kind === 'error') throw step.error;
        if (step.kind === 'hang') await abortedBy(signal);
      };
      const iterator = run();
      return {
        [Symbol.asyncIterator]: () => iterator,
        finalMessage() {
          outcome ??= (async () => {
            // Drains what the caller did not read, as the SDK's stream does.
            for (;;) {
              const next = await iterator.next();
              if (next.done === true) break;
            }
            if (step.kind !== 'message') throw new Error('unreachable');
            return JSON.parse(JSON.stringify(step.message)) as BetaMessage;
          })();
          return outcome;
        },
      };
    },
  };
}

/** The message params of a recorded call. */
export function messagesOf(call: RecordedCall | undefined): BetaMessageParam[] {
  if (call === undefined) throw new Error('no such call');
  return call.params.messages;
}
