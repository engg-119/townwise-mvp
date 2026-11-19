// One research thread's two model calls (D66 design decisions 4 to 6): gather, with web search (and page fetch while
// TOWNWISE_RESEARCH_WEB_FETCH is on), then extract, with no tools and a JSON schema, over what the gather's own
// messages returned. runThread is the whole thread as a pure executor: it reads no store and writes nothing, so the
// runner (task 3.4) and the live eval (scripts/research-eval.ts) run the same code. It goes through the chat's model
// port (chat/model.ts), so no new Anthropic client is constructed.
//
// Every message is streamed and kept, and its cost tallied as it streams (pricing.ts runningSpend): a finished message
// costs what its usage says, a stream that throws what it had used, its started searches included. The runner reads
// the tally on each heartbeat and settles the thread's reservation to it. A paused gather (pause_turn) is resent
// unchanged at most MAX_CONTINUATIONS times, and only while the reservation still holds the extract's ceiling after
// what was spent, so the extract always runs on what was gathered.
//
// Failures: a 4xx other than 408, 409 or 429 is the API refusing the request, which a retry would not change
// (`request_refused`); while fetch is on, a 4xx naming web fetch is instead retried once without the fetch tool and
// turns fetch off for the process (FetchSwitch). Each request has RESEARCH_REQUEST_MS and the thread RESEARCH_THREAD_MS.
// The caller's own abort (a missed heartbeat, a shutdown) answers `aborted`. Nothing here logs: page text, queries,
// URLs and titles never leave the outcome, and the runner logs its counts and codes only.
import { APIError } from '@anthropic-ai/sdk';
import type {
  BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { ChatModel } from '../chat/model.ts';
import { messageCostMicroUsd, runningSpend, type RunningSpend } from '../chat/pricing.ts';
import { CHAT_MODEL, echoable, failureCode } from '../chat/turn.ts';
import { WEB_FETCH, WEB_SEARCH } from '../chat/web-search.ts';
import {
  EXTRACT_MAX_TOKENS, extractCallCeilingMicroUsd, FETCH_TOKENS, GATHER_MAX_TOKENS, MAX_CONTINUATIONS,
} from './budget.ts';
import { buildLedger } from './ledger.ts';
import { extractPrompt, gatherPrompt, type ExtractPrompt, type GatherInput, type GatherPrompt, type PromptTown } from './prompt.ts';
import { MAX_FETCHES } from './threads.ts';
import { EXTRACT_FORMAT, verifyExtract, type Verified } from './verify.ts';

/** One request's time limit, and the whole thread's (gather and extract). */
export const RESEARCH_REQUEST_MS = 150_000;
export const RESEARCH_THREAD_MS = 360_000;
/** The suggestions call's betas: the server-side refusal fallback. */
const BETAS = ['server-side-fallback-2026-07-01'];

/** Whether the fetch tool is sent. One per process: a request refused for naming web fetch turns it off for every thread. */
export interface FetchSwitch { on: boolean }

/** The search tool, called directly so its results come back at the top level, searching from the town. */
export function searchTool(maxUses: number, town: PromptTown): BetaToolUnion {
  return {
    type: 'web_search_20260209', name: WEB_SEARCH, max_uses: maxUses, allowed_callers: ['direct'],
    user_location: { type: 'approximate', city: town.name, region: town.state, country: 'US', timezone: town.timeZone },
  };
}

export const FETCH_TOOL: BetaToolUnion = {
  type: 'web_fetch_20260209', name: WEB_FETCH, max_uses: MAX_FETCHES, allowed_callers: ['direct'],
  max_content_tokens: FETCH_TOKENS, citations: { enabled: true },
};

/** A gather request: the prompt, then each paused message so far, resent unchanged. No output format: it would drop the citations. */
export function gatherRequest(
  prompt: GatherPrompt, options: { readonly maxSearches: number; readonly town: PromptTown; readonly fetch: boolean },
  paused: readonly BetaMessageParam[],
): BetaMessageStreamParams {
  return {
    model: CHAT_MODEL,
    max_tokens: GATHER_MAX_TOKENS,
    output_config: { effort: 'low' },
    betas: BETAS,
    fallbacks: 'default',
    system: prompt.system,
    tools: options.fetch ? [searchTool(options.maxSearches, options.town), FETCH_TOOL] : [searchTool(options.maxSearches, options.town)],
    messages: [{ role: 'user', content: prompt.user }, ...paused],
  };
}

/** The extract request: no tools, the answer held to verify.ts's schema. */
export function extractRequest(prompt: ExtractPrompt): BetaMessageStreamParams {
  return {
    model: CHAT_MODEL,
    max_tokens: EXTRACT_MAX_TOKENS,
    output_config: { effort: 'low', format: EXTRACT_FORMAT },
    betas: BETAS,
    fallbacks: 'default',
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  };
}

// ---- The spend tally -------------------------------------------------------------------------------------------------

/**
 * What a thread has spent so far: its finished messages and the stream in flight. The runner's heartbeat reads the
 * first three; only the calls below write it.
 */
export interface ThreadTally {
  costMicroUsd(): number;
  searches(): number;
  fetches(): number;
  begin(maxTokens: number): RunningSpend;
  finished(message: BetaMessage): void;
  failed(): void;
}

export function createThreadTally(now: () => Date): ThreadTally {
  let cost = 0;
  let searches = 0;
  let fetches = 0;
  let live: RunningSpend | null = null;
  return {
    costMicroUsd: () => cost + (live?.costMicroUsd() ?? 0),
    searches: () => searches + (live?.searches() ?? 0),
    fetches: () => fetches + (live?.fetches() ?? 0),
    begin(maxTokens) {
      live = runningSpend(now, maxTokens);
      return live;
    },
    finished(message) {
      cost += messageCostMicroUsd(message);
      searches += message.usage.server_tool_use?.web_search_requests ?? 0;
      fetches += message.usage.server_tool_use?.web_fetch_requests ?? 0;
      live = null;
    },
    failed() {
      if (live === null) return;
      cost += live.costMicroUsd();
      searches += live.searches();
      fetches += live.fetches();
      live = null;
    },
  };
}

// ---- Calls -----------------------------------------------------------------------------------------------------------

export type ThreadFailureCode =
  | 'request_refused' | 'refusal' | 'timeout' | 'bad_answer' | 'provider_overloaded' | 'provider_unavailable' | 'internal';

export type CallFailure =
  | { readonly kind: 'failed'; readonly code: ThreadFailureCode; readonly retry: boolean }
  | { readonly kind: 'aborted' };

/** What every call of one thread shares. */
interface CallContext {
  readonly model: ChatModel;
  readonly tally: ThreadTally;
  /** The caller's own abort: a missed heartbeat or a shutdown. */
  readonly signal: AbortSignal;
  /** The thread's time limit. */
  readonly deadline: AbortSignal;
  readonly requestMs: number;
}

/** The API refusing the request itself: a 4xx other than 408, 409 or 429. An abort has no status. */
function refusing(err: unknown): err is APIError {
  return err instanceof APIError && typeof err.status === 'number' && err.status >= 400 && err.status < 500
    && ![408, 409, 429].includes(err.status);
}

function namesWebFetch(err: APIError): boolean {
  return /web[_ ]fetch/i.test(err.message);
}

async function streamed(context: CallContext, params: BetaMessageStreamParams, maxTokens: number): Promise<BetaMessage> {
  const signal = AbortSignal.any([context.signal, context.deadline, AbortSignal.timeout(context.requestMs)]);
  const spend = context.tally.begin(maxTokens);
  try {
    const stream = context.model.stream(params, { signal });
    for await (const event of stream) spend.observe(event);
    const message = await stream.finalMessage();
    context.tally.finished(message);
    return message;
  } catch (err) {
    context.tally.failed();
    if (signal.aborted) throw new Aborted(context.signal.aborted);
    throw err;
  }
}

/** A call cut off by an abort: the caller's own, or a time limit. */
class Aborted extends Error {
  readonly byCaller: boolean;
  constructor(byCaller: boolean) {
    super(byCaller ? 'aborted' : 'timed out');
    this.byCaller = byCaller;
  }
}

function failureOf(err: unknown): CallFailure {
  if (err instanceof Aborted) return err.byCaller ? { kind: 'aborted' } : { kind: 'failed', code: 'timeout', retry: true };
  if (refusing(err)) return { kind: 'failed', code: 'request_refused', retry: false };
  return { kind: 'failed', code: failureCode(err), retry: true };
}

export type GatherResult =
  | { readonly kind: 'gathered'; readonly messages: readonly BetaMessage[]; readonly continuations: number }
  | (CallFailure & { readonly messages: readonly BetaMessage[] });

/**
 * The gather: the request, then each paused message resent unchanged while `mayContinue` says the reservation still
 * holds the extract, at most MAX_CONTINUATIONS times. A message cut at max_tokens, or paused once no continuation is
 * allowed, still counts as gathered: the extract reads what it holds.
 */
async function gather(context: CallContext, input: {
  readonly prompt: GatherPrompt;
  readonly maxSearches: number;
  readonly town: PromptTown;
  readonly fetch: FetchSwitch;
  readonly onFetchOff: () => void;
  readonly mayContinue: (messages: readonly BetaMessage[]) => boolean;
}): Promise<GatherResult> {
  const messages: BetaMessage[] = [];
  const paused: BetaMessageParam[] = [];
  // Decided once a thread, so a continuation never drops a tool its own conversation already used.
  let withFetch = input.fetch.on;
  let fetchRetried = false;
  for (;;) {
    const params = gatherRequest(input.prompt, { maxSearches: input.maxSearches, town: input.town, fetch: withFetch }, paused);
    let message: BetaMessage;
    try {
      message = await streamed(context, params, GATHER_MAX_TOKENS);
    } catch (err) {
      if (withFetch && !fetchRetried && refusing(err) && namesWebFetch(err)) {
        withFetch = false;
        fetchRetried = true;
        if (input.fetch.on) {
          input.fetch.on = false;
          input.onFetchOff();
        }
        continue;
      }
      return { ...failureOf(err), messages };
    }
    messages.push(message);
    if (message.stop_reason === 'refusal') return { kind: 'failed', code: 'refusal', retry: false, messages };
    const toolUse = message.content.some((block) => block.type === 'tool_use');
    if (message.stop_reason === 'pause_turn' && !toolUse && paused.length < MAX_CONTINUATIONS && input.mayContinue(messages)) {
      paused.push({ role: 'assistant', content: echoable(message.content) });
      continue;
    }
    return { kind: 'gathered', messages, continuations: paused.length };
  }
}

/** The extract's answer as JSON, or null when its text does not parse. */
function answerJson(message: BetaMessage): unknown {
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function extract(context: CallContext, prompt: ExtractPrompt): Promise<{ readonly kind: 'answered'; readonly output: unknown } | CallFailure> {
  let message: BetaMessage;
  try {
    message = await streamed(context, extractRequest(prompt), EXTRACT_MAX_TOKENS);
  } catch (err) {
    return failureOf(err);
  }
  if (message.stop_reason === 'refusal') return { kind: 'failed', code: 'refusal', retry: false };
  // An answer cut at max_tokens is cut JSON.
  if (message.stop_reason === 'max_tokens') return { kind: 'failed', code: 'bad_answer', retry: true };
  return { kind: 'answered', output: answerJson(message) };
}

// ---- The thread ------------------------------------------------------------------------------------------------------

export interface RunThreadInput {
  readonly model: ChatModel;
  /** Everything the gather prompt is built from (prompt.ts): the thread, the town, the window, known rows, seeds, the restaurant. */
  readonly gather: GatherInput;
  /** What the runner reserved for this thread (budget.ts reserveMicroUsd). */
  readonly reservedMicroUsd: number;
  readonly fetch: FetchSwitch;
  /** Called once when this thread turns fetch off for the process; the runner logs it. */
  readonly onFetchOff?: () => void;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  /** Read by the runner's heartbeat; one is made when absent. */
  readonly tally?: ThreadTally;
  /** Tests shorten them. */
  readonly limits?: { readonly requestMs: number; readonly threadMs: number };
}

interface Spent {
  readonly costMicroUsd: number;
  readonly searches: number;
  readonly fetches: number;
  /** The gather's messages, in order (the live eval records them; the runner keeps none). */
  readonly messages: readonly BetaMessage[];
  readonly continuations: number;
}

export type ThreadOutcome = Spent & (
  | { readonly kind: 'recorded'; readonly verified: Verified; readonly sources: number }
  /** The gather returned no page at all, so there was nothing to extract. */
  | { readonly kind: 'empty'; readonly code: 'no_sources' }
  | CallFailure
);

export async function runThread(input: RunThreadInput): Promise<ThreadOutcome> {
  const limits = input.limits ?? { requestMs: RESEARCH_REQUEST_MS, threadMs: RESEARCH_THREAD_MS };
  const given = input.tally ?? createThreadTally(input.now);
  const context: CallContext = {
    model: input.model, tally: given, signal: input.signal, deadline: AbortSignal.timeout(limits.threadMs), requestMs: limits.requestMs,
  };
  const { thread, window } = input.gather;
  const competitors = thread.id === 'competitors' ? input.gather.competitors : null;
  const extractPromptOf = (messages: readonly BetaMessage[]): ExtractPrompt => extractPrompt({
    messages, ledger: buildLedger(messages), window, thread, competitors,
  });
  const spent = (messages: readonly BetaMessage[], continuations: number): Spent => ({
    costMicroUsd: given.costMicroUsd(), searches: given.searches(), fetches: given.fetches(), messages, continuations,
  });

  const gathered = await gather(context, {
    prompt: gatherPrompt(input.gather),
    maxSearches: thread.maxSearches,
    town: input.gather.town,
    fetch: input.fetch,
    onFetchOff: () => { input.onFetchOff?.(); },
    mayContinue: (messages) => {
      const prompt = extractPromptOf(messages);
      return input.reservedMicroUsd - given.costMicroUsd() >= extractCallCeilingMicroUsd(prompt.system.length + prompt.user.length);
    },
  });
  if (gathered.kind !== 'gathered') {
    const { messages, ...failure } = gathered;
    return { ...spent(messages, 0), ...failure };
  }
  const { messages, continuations } = gathered;
  const ledger = buildLedger(messages);
  if (ledger.sources.length === 0) return { ...spent(messages, continuations), kind: 'empty', code: 'no_sources' };

  const answer = await extract(context, extractPromptOf(messages));
  if (answer.kind !== 'answered') return { ...spent(messages, continuations), ...answer };
  const verified = verifyExtract(answer.output, {
    ledger, window, competitors: (competitors ?? []).map((competitor) => competitor.n), now: input.now(),
  });
  if (verified === null) return { ...spent(messages, continuations), kind: 'failed', code: 'bad_answer', retry: true };
  return { ...spent(messages, continuations), kind: 'recorded', verified, sources: ledger.sources.length };
}
