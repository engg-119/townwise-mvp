// The full live research eval (D66 task 10.1, design decision 18), run by scripts/research-eval.ts after its guard.
// It runs Hanover's six town threads through the pure thread executor (research/call.ts runThread) with the curated rows
// held out of `known` and the seeds, once with web fetch off (the shipping config) and once with it on, then one
// `neighborhood` and one `competitors` thread for a public Hanover restaurant that is not a Townwise customer, with
// Google names not allowed (the restaurant named by its own name, as an owner would type it). Each run is merged with
// the product's own planMerge, and scored against the hand-curated Hanover calendar.
//
// Spend: every thread is started only while the money already spent, plus the reservations of the threads in flight,
// plus its own reservation stays under --max-usd, so the eval cannot pass its cap even at every thread's ceiling.
//
// What it prints: counts, rates, costs and codes only (never a page's text, a URL, a title or a query). What it writes:
// `--out <file>` the full results as JSON (titles, dates and source URLs of public pages, for the hand-labeled precision
// sample; kept out of the repo), and `--record` the fixtures of the fetch-off threads under test/fixtures/research/,
// encrypted fields and signatures stripped, fetched page text cut to its cited quotes, and each `--redact` pattern
// (the restaurant's name) replaced, with the expectation computed by replaying the fixture itself.
import type {
  BetaContentBlock, BetaMessage, BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { ChatModel, ModelStream } from '../src/chat/model.ts';
import { reserveMicroUsd, threadLimits } from '../src/research/budget.ts';
import { runThread, type FetchSwitch, type ThreadOutcome } from '../src/research/call.ts';
import { jaccard, sameEvent, titleTokens, type Comparable } from '../src/research/dedupe.ts';
import { buildLedger, normalizeUrl } from '../src/research/ledger.ts';
import { planMerge, type MergePlan, type PlannedInsert, type StoredEvent, type ThreadFound } from '../src/research/merge.ts';
import { gatherPrompt, promptTown, type GatherInput, type PromptTown } from '../src/research/prompt.ts';
import { researchWindow, threadDef, TOWN_THREADS, type ResearchWindow, type ThreadDef, type ThreadId } from '../src/research/threads.ts';
import { EVENT_DROP_REASONS, type Finding, type Verified } from '../src/research/verify.ts';
import { townEvents, type TownEvent } from '../src/town-calendar.ts';
import { TOWNS } from '../src/towns.ts';

export const EVAL_GROUPS = ['town-off', 'town-on', 'location'] as const;
export type EvalGroup = typeof EVAL_GROUPS[number];

export interface FullEvalOptions {
  readonly groups: readonly EvalGroup[];
  /** The public restaurant's name as an owner would type it; the location threads are skipped without one. */
  readonly restaurant: string | null;
  readonly maxUsd: number;
  readonly concurrency: number;
  readonly sample: number;
  readonly record: boolean;
  /** Case-insensitive patterns replaced in recorded fixtures and in the --out file's sample titles. */
  readonly redact: readonly string[];
  /** Writes every thread's run (responses and outcome) here as soon as the threads end, before any scoring. */
  readonly saveRuns: string | null;
  /** Scores the runs saved by an earlier --save-runs instead of calling the model (no spend). */
  readonly fromRuns: string | null;
}

export interface FullEvalDeps {
  readonly model: ChatModel;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly writeJson: (path: string, value: unknown) => Promise<void>;
  readonly readJson: (path: string) => Promise<unknown>;
  readonly fixtureDir: string;
}

/** The latest day a curated Hanover row covers: the window never runs past what the curated calendar can score. */
const CURATED_END = '2028-06-11';
const TOWN_ID = 'hanover-nh';
const REDACTED = 'Redacted';

function hanover(): PromptTown {
  const record = TOWNS.find((town) => town.townId === TOWN_ID);
  if (record === undefined) throw new Error('hanover-nh is not one of the twelve towns');
  return promptTown({ townId: TOWN_ID, name: record.name, state: record.state });
}

export function evalWindow(now: Date, timeZone: string): ResearchWindow {
  const window = researchWindow(now, timeZone);
  return { from: window.from, to: window.to < CURATED_END ? window.to : CURATED_END };
}

// ---- Running threads -------------------------------------------------------------------------------------------------

interface Job {
  readonly group: EvalGroup;
  readonly thread: ThreadDef;
  readonly fetch: boolean;
  readonly input: GatherInput;
  readonly reservedMicroUsd: number;
}

export interface ThreadRun {
  readonly group: EvalGroup;
  readonly thread: ThreadId;
  readonly fetch: boolean;
  readonly reservedMicroUsd: number;
  readonly outcome: ThreadOutcome;
  readonly ms: number;
  /** Every message the model answered, in order: the gather's, then the extract's. */
  readonly responses: readonly BetaMessage[];
  readonly fetchSwitchedOff: boolean;
}

/** The model, keeping each answered message. */
function capturing(model: ChatModel, into: BetaMessage[]): ChatModel {
  return {
    stream(params, options): ModelStream {
      const stream = model.stream(params, options);
      return {
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
        async finalMessage() {
          const message = await stream.finalMessage();
          into.push(message);
          return message;
        },
      };
    },
  };
}

function jobFor(group: EvalGroup, thread: ThreadDef, base: Omit<GatherInput, 'thread'>, fetch: boolean): Job {
  const input: GatherInput = { ...base, thread };
  return { group, thread, fetch, input, reservedMicroUsd: reserveMicroUsd(threadLimits(thread, fetch, gatherPrompt(input))) };
}

async function runJob(job: Job, deps: FullEvalDeps): Promise<ThreadRun> {
  const responses: BetaMessage[] = [];
  const fetch: FetchSwitch = { on: job.fetch };
  let fetchSwitchedOff = false;
  const started = Date.now();
  const outcome = await runThread({
    model: capturing(deps.model, responses), gather: job.input, reservedMicroUsd: job.reservedMicroUsd, fetch,
    onFetchOff: () => { fetchSwitchedOff = true; }, signal: new AbortController().signal, now: deps.now,
  });
  return {
    group: job.group, thread: job.thread.id, fetch: job.fetch, reservedMicroUsd: job.reservedMicroUsd, outcome,
    ms: Date.now() - started, responses, fetchSwitchedOff,
  };
}

/**
 * Runs the jobs in order, at most `concurrency` at once, each started only while spent + in-flight reservations + its
 * own reservation stays within the cap. A job that cannot fit even with nothing in flight is skipped (null).
 */
async function runPool(jobs: readonly Job[], capMicroUsd: number, concurrency: number, deps: FullEvalDeps): Promise<(ThreadRun | null)[]> {
  const results: (ThreadRun | null)[] = jobs.map(() => null);
  let spent = 0;
  let held = 0;
  const inFlight = new Set<Promise<void>>();
  for (const [index, job] of jobs.entries()) {
    while (inFlight.size > 0 && (inFlight.size >= concurrency || spent + held + job.reservedMicroUsd > capMicroUsd)) {
      await Promise.race(inFlight);
    }
    if (spent + held + job.reservedMicroUsd > capMicroUsd) {
      deps.log(`  ${job.group} ${job.thread.id}: skipped, its reservation $${usd(job.reservedMicroUsd)} would pass the cap (spent $${usd(spent)})`);
      continue;
    }
    held += job.reservedMicroUsd;
    const task = runJob(job, deps).then((run) => {
      results[index] = run;
      spent += run.outcome.costMicroUsd;
      deps.log(`  ${run.group} ${run.thread}: ${run.outcome.kind}${'code' in run.outcome ? ` (${run.outcome.code})` : ''}, $${usd(run.outcome.costMicroUsd)}, ${String(run.outcome.searches)} searches, ${String(run.outcome.fetches)} fetches, ${String(Math.round(run.ms / 1000))} s; total spent $${usd(spent)}`);
    }).finally(() => {
      held -= job.reservedMicroUsd;
      inFlight.delete(task);
    });
    inFlight.add(task);
  }
  await Promise.all(inFlight);
  return results;
}

function usd(microUsd: number): string {
  return (microUsd / 1e6).toFixed(2);
}

// ---- Thread metrics ------------------------------------------------------------------------------------------------

interface FetchCheck {
  /** Successful direct fetch results. */
  readonly fetchedPages: number;
  /** The char_location citations' document_index values, each once, sorted. */
  readonly documentIndexes: readonly number[];
  readonly charCitations: number;
  /** char_location citations whose cited words appear in the page the ledger maps their index to. */
  readonly mappedAndFound: number;
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Whether the ledger's document_index mapping holds: each char_location citation's words are in the page it maps to. */
function fetchCheck(messages: readonly BetaMessage[]): FetchCheck {
  const ledger = buildLedger(messages);
  const blocks: BetaContentBlock[] = messages.flatMap((message) => message.content);
  const fetchedPages = blocks.filter((block) => block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result').length;
  const indexes = new Set<number>();
  let charCitations = 0;
  let mappedAndFound = 0;
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const citation of (block.citations ?? [])) {
      if (citation.type !== 'char_location') continue;
      charCitations += 1;
      indexes.add(citation.document_index);
      const id = ledger.idOfCitation(citation);
      const page = id === null ? undefined : ledger.byId(id);
      if (page?.fetchedText != null && squash(page.fetchedText).includes(squash(citation.cited_text))) mappedAndFound += 1;
    }
  }
  return { fetchedPages, documentIndexes: [...indexes].sort((a, b) => a - b), charCitations, mappedAndFound };
}

interface Iterations { readonly count: number; readonly searchGrowth: number | null; readonly searches: number; readonly fetches: number }

/**
 * Sampling iterations across the gather's messages, and the input growth between them: each iteration's whole input
 * less the previous iteration's input and output, which is the tool results that came between them. With no fetch,
 * that growth over the searches is the tokens one search adds (budget.ts SEARCH_TOKENS).
 */
function iterationsOf(gather: readonly BetaMessage[]): Iterations {
  let count = 0;
  let growth = 0;
  let previous: { full: number; output: number } | null = null;
  let searches = 0;
  let fetches = 0;
  for (const message of gather) {
    searches += message.usage.server_tool_use?.web_search_requests ?? 0;
    fetches += message.usage.server_tool_use?.web_fetch_requests ?? 0;
    for (const entry of message.usage.iterations ?? []) {
      count += 1;
      const cacheRead = 'cache_read_input_tokens' in entry ? entry.cache_read_input_tokens : 0;
      const cacheWrite = 'cache_creation_input_tokens' in entry ? entry.cache_creation_input_tokens : 0;
      const full = entry.input_tokens + cacheRead + cacheWrite;
      if (previous !== null) growth += full - previous.full - previous.output;
      previous = { full, output: entry.output_tokens };
    }
  }
  return { count, searchGrowth: searches > 0 && fetches === 0 ? growth / searches : null, searches, fetches };
}

export interface ThreadReport {
  readonly group: EvalGroup;
  readonly thread: ThreadId;
  readonly outcome: string;
  readonly code: string | null;
  readonly costMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly searches: number;
  readonly fetches: number;
  readonly iterations: number;
  readonly extractIterations: number;
  readonly ms: number;
  readonly continuations: number;
  readonly pauses: number;
  readonly sources: number;
  /** Events in the extract's answer before any check. */
  readonly extracted: number;
  readonly kept: number;
  readonly drops: Readonly<Record<string, number>>;
  readonly grounded: number;
  readonly confidence: Readonly<Record<string, number>>;
  readonly entities: number;
  readonly tokensPerSearch: number | null;
  readonly fetch: FetchCheck | null;
  readonly fetchSwitchedOff: boolean;
}

function threadReport(run: ThreadRun): ThreadReport {
  const { outcome } = run;
  const verified = outcome.kind === 'recorded' ? outcome.verified : null;
  const gather = outcome.messages;
  const extractMessages = run.responses.slice(gather.length);
  const drops: Readonly<Record<string, number>> = verified === null ? {} : verified.drops;
  const dropTotal = Object.values(drops).reduce((sum, n) => sum + n, 0);
  const confidence: Record<string, number> = { high: 0, medium: 0, low: 0 };
  for (const event of verified?.events ?? []) confidence[event.confidence] = (confidence[event.confidence] ?? 0) + 1;
  const iterations = iterationsOf(gather);
  return {
    group: run.group, thread: run.thread, outcome: outcome.kind, code: 'code' in outcome ? outcome.code : null,
    costMicroUsd: outcome.costMicroUsd, reservedMicroUsd: run.reservedMicroUsd, searches: outcome.searches, fetches: outcome.fetches,
    iterations: iterations.count,
    extractIterations: extractMessages.reduce((sum, message) => sum + Math.max(1, message.usage.iterations?.length ?? 1), 0),
    ms: run.ms, continuations: outcome.continuations, pauses: gather.filter((message) => message.stop_reason === 'pause_turn').length,
    sources: outcome.kind === 'recorded' ? outcome.sources : buildLedger(gather).sources.length,
    extracted: (verified?.events.length ?? 0) + dropTotal, kept: verified?.events.length ?? 0, drops,
    grounded: verified?.events.filter((event) => event.grounded).length ?? 0, confidence,
    entities: verified?.entities.length ?? 0, tokensPerSearch: iterations.searchGrowth,
    fetch: run.fetch ? fetchCheck(gather) : null, fetchSwitchedOff: run.fetchSwitchedOff,
  };
}

// ---- Scoring a run -------------------------------------------------------------------------------------------------

function findingComparable(event: Finding): Comparable {
  return { title: event.title, start: event.start, end: event.end, category: event.category, venueKey: null };
}

function curatedComparable(row: TownEvent): Comparable {
  return { title: row.title, start: row.start, end: row.end, category: null, venueKey: null };
}

export interface CuratedScore {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly kind: TownEvent['kind'];
  /** The threads that found it. */
  readonly foundBy: readonly ThreadId[];
}

/**
 * Recall against the curated town rows in the window (the national holidays are not research's to find). An event or
 * season row is found when a finding is the same happening (dedupe.ts sameEvent, the rule the merge drops curated
 * duplicates by); a term row when a finding starts or ends on its first or last day, or is the same happening.
 */
export function scoreCurated(curated: readonly TownEvent[], found: readonly ThreadFound[]): CuratedScore[] {
  return curated.filter((row) => row.scope === 'town').map((row) => {
    const foundBy = found.filter(({ events }) => events.some((event) => sameEvent(findingComparable(event), curatedComparable(row))
      || (row.kind === 'term' && [row.start, row.end].some((day) => day === event.start || day === event.end)))).map(({ thread }) => thread);
    return { title: row.title, start: row.start, end: row.end, kind: row.kind, foundBy };
  });
}

/** Pairs of stored rows close enough to be one happening the merge did not catch: dates within a day or overlapping, a third of the words shared. */
export function nearDuplicates(inserts: readonly PlannedInsert[]): [number, number][] {
  const pairs: [number, number][] = [];
  inserts.forEach((a, i) => {
    inserts.forEach((b, j) => {
      if (j <= i) return;
      const close = Math.abs(Date.parse(a.start) - Date.parse(b.start)) <= 86_400_000 || (a.start <= b.end && b.start <= a.end);
      if (close && jaccard(titleTokens(a.title), titleTokens(b.title)) >= 1 / 3) pairs.push([i, j]);
    });
  });
  return pairs;
}

/** Entity pairs that may be one entity under two keys: one name key inside the other, or half the words shared. */
export function nearDuplicateEntities(entities: MergePlan['entities']): [number, number][] {
  const pairs: [number, number][] = [];
  entities.forEach((a, i) => {
    entities.forEach((b, j) => {
      if (j <= i) return;
      const ka = a.key.nameKey;
      const kb = b.key.nameKey;
      const words = jaccard(new Set(ka.split(' ')), new Set(kb.split(' ')));
      if (ka === kb || ka.includes(kb) || kb.includes(ka) || words >= 0.5) pairs.push([i, j]);
    });
  });
  return pairs;
}

export interface RunScore {
  readonly group: EvalGroup;
  readonly threads: readonly ThreadReport[];
  readonly emptyOrFailed: number;
  readonly costMicroUsd: number;
  readonly found: number;
  readonly mergeDrops: MergePlan['drops'];
  readonly inserts: readonly PlannedInsert[];
  readonly entities: MergePlan['entities'];
  readonly threadEntities: number;
  readonly curated: readonly CuratedScore[];
  /** Stored sources whose URL is in a ledger of the run's threads, over all stored sources. */
  readonly validSources: number;
  readonly storedSources: number;
  readonly extracted: number;
  readonly unknownSource: number;
  readonly badDates: number;
  /** Events that reached the date check: extracted less the earlier drops. */
  readonly dateChecked: number;
  readonly grounded: number;
  readonly kept: number;
  readonly storedGrounded: number;
  readonly nearDuplicates: readonly [number, number][];
  readonly nearDuplicateEntities: readonly [number, number][];
}

function storedRow(insert: PlannedInsert, index: number): StoredEvent {
  return {
    id: `town-${String(index)}`, title: insert.title, start: insert.start, end: insert.end, category: insert.category,
    status: insert.status, confidence: insert.confidence, sources: insert.sources, seenCount: 1, lastRunId: 'eval-town',
    venueKey: insert.venue?.nameKey ?? null,
  };
}

function scoreRun(group: EvalGroup, runs: readonly ThreadRun[], curated: readonly TownEvent[], townRows: readonly StoredEvent[]): RunScore {
  const threads = runs.map(threadReport);
  const found: ThreadFound[] = runs.flatMap((run) => (run.outcome.kind === 'recorded'
    ? [{ thread: run.thread, events: run.outcome.verified.events, entities: run.outcome.verified.entities }]
    : []));
  const plan = planMerge({
    runId: `eval-${group}`, subject: group === 'location' ? 'location' : 'town', found, stored: [], storedEntities: [], curated,
    townRows, competitorPlaces: null,
  });
  const ledgerUrls = new Set(runs.flatMap((run) => buildLedger(run.outcome.messages).sources.map((source) => source.url)));
  const storedSources = plan.inserts.flatMap((insert) => insert.sources);
  const verifiedOf = (run: ThreadRun): Verified | null => (run.outcome.kind === 'recorded' ? run.outcome.verified : null);
  const sum = (pick: (verified: Verified) => number): number => runs.reduce((total, run) => {
    const verified = verifiedOf(run);
    return total + (verified === null ? 0 : pick(verified));
  }, 0);
  const extracted = threads.reduce((total, thread) => total + thread.extracted, 0);
  const beforeDates = sum((v) => v.drops.bad_shape + v.drops.over_cap + v.drops.no_source + v.drops.unknown_source);
  return {
    group, threads,
    emptyOrFailed: threads.filter((thread) => thread.outcome !== 'recorded' || thread.kept === 0).length,
    costMicroUsd: threads.reduce((total, thread) => total + thread.costMicroUsd, 0),
    found: plan.found, mergeDrops: plan.drops, inserts: plan.inserts, entities: plan.entities,
    threadEntities: found.reduce((total, thread) => total + thread.entities.length, 0),
    curated: scoreCurated(curated, found),
    validSources: storedSources.filter((source) => ledgerUrls.has(source.url)).length, storedSources: storedSources.length,
    extracted, unknownSource: sum((v) => v.drops.unknown_source), badDates: sum((v) => v.drops.bad_dates),
    dateChecked: extracted - beforeDates, grounded: sum((v) => v.events.filter((event) => event.grounded).length),
    kept: sum((v) => v.events.length), storedGrounded: plan.inserts.filter((insert) => insert.confidence !== 'low').length,
    nearDuplicates: nearDuplicates(plan.inserts), nearDuplicateEntities: nearDuplicateEntities(plan.entities),
  };
}

// ---- The precision sample -------------------------------------------------------------------------------------------

/** A small deterministic hash, so the sample is fixed by the stored rows and not picked by hand. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SampledEvent {
  readonly n: number;
  readonly group: EvalGroup;
  readonly thread: ThreadId;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly weekdays: readonly number[] | null;
  readonly confidence: string;
  readonly sources: readonly { readonly url: string; readonly quotes: readonly string[] }[];
}

/**
 * `size` stored rows: the location run's rows in proportion to its share of the stored rows (at least a quarter of the
 * sample, and every competitors row up to that share), the rest from the town run with fetch off, each part ordered
 * by a hash of its title and start.
 */
export function precisionSample(town: readonly PlannedInsert[], location: readonly PlannedInsert[], size: number): { group: EvalGroup; insert: PlannedInsert }[] {
  const order = (rows: readonly PlannedInsert[]): PlannedInsert[] => [...rows].sort((a, b) => hash(`${a.title}|${a.start}`) - hash(`${b.title}|${b.start}`));
  const total = town.length + location.length;
  if (total === 0) return [];
  const locationShare = Math.min(location.length, Math.max(Math.ceil(size / 4), Math.round((size * location.length) / total)));
  const competitors = order(location.filter((row) => row.thread === 'competitors'));
  const others = order(location.filter((row) => row.thread !== 'competitors'));
  const half = Math.min(competitors.length, Math.ceil(locationShare / 2));
  const fromLocation = [...competitors.slice(0, half), ...others.slice(0, locationShare - half)];
  const more = competitors.slice(half, half + (locationShare - fromLocation.length));
  const locationRows = [...fromLocation, ...more];
  const townRows = order(town).slice(0, size - locationRows.length);
  return [...townRows.map((insert) => ({ group: 'town-off' as const, insert })), ...locationRows.map((insert) => ({ group: 'location' as const, insert }))];
}

// ---- Fixtures --------------------------------------------------------------------------------------------------------

function redactor(patterns: readonly string[]): (value: string) => string {
  const regexes = patterns.map((pattern) => new RegExp(pattern, 'gi'));
  return (value) => regexes.reduce((out, regex) => out.replace(regex, REDACTED), value);
}

/**
 * A recorded response as a fixture keeps it: no encrypted_content, encrypted_index or signature, a fetched page's text
 * cut to the words the gather cited from it, and every string redacted.
 */
export function stripForFixture(messages: readonly BetaMessage[], redact: (value: string) => string): BetaMessage[] {
  const ledger = buildLedger(messages);
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'encrypted_content' || k === 'encrypted_index') continue;
      out[k] = k === 'signature' ? '' : walk(v);
    }
    return out;
  };
  return messages.map((message) => {
    const content = message.content.map((block) => {
      if (block.type !== 'web_fetch_tool_result' || block.content.type !== 'web_fetch_result') return block;
      const url = normalizeUrl(block.content.url);
      const page = ledger.sources.find((source) => source.url === url);
      const source = block.content.content.source;
      const quotes = (page?.quotes ?? []).join('\n');
      return source.type === 'text'
        ? { ...block, content: { ...block.content, content: { ...block.content.content, source: { ...source, data: quotes } } } }
        : block;
    });
    return walk({ ...message, content }) as BetaMessage;
  });
}

/** A model that answers each call with the next recorded message, streaming nothing before it. */
export function replayModel(responses: readonly BetaMessage[]): ChatModel {
  const queue = [...responses];
  return {
    stream(): ModelStream {
      const next = queue.shift();
      const events: BetaRawMessageStreamEvent[] = [];
      return {
        [Symbol.asyncIterator]: () => events[Symbol.iterator]() as unknown as AsyncIterator<BetaRawMessageStreamEvent>,
        finalMessage: () => (next === undefined ? Promise.reject(new Error('no recorded response left')) : Promise.resolve(structuredClone(next))),
      };
    },
  };
}

export interface ResearchFixture {
  readonly about: string;
  readonly thread: ThreadId;
  readonly fetch: boolean;
  readonly placesToAi: false;
  readonly now: string;
  readonly today: string;
  readonly window: ResearchWindow;
  readonly reservedMicroUsd: number;
  readonly responses: readonly BetaMessage[];
  readonly expected: {
    readonly kind: ThreadOutcome['kind'];
    readonly costMicroUsd: number;
    readonly searches: number;
    readonly fetches: number;
    readonly continuations: number;
    readonly sources: number | null;
    readonly verified: Verified | null;
  };
}

/** The gather input a fixture replays under: the request is not compared, so the restaurant is a stand-in. */
export function fixtureInput(fixture: Pick<ResearchFixture, 'thread' | 'today' | 'window'>): GatherInput {
  return {
    thread: threadDef(fixture.thread, { placesToAi: false }), town: hanover(), today: fixture.today, window: fixture.window,
    known: [], seeds: [], restaurant: { typed: true, name: 'Fixture Restaurant' }, competitors: null,
  };
}

export async function replayFixture(fixture: ResearchFixture): Promise<ThreadOutcome> {
  return runThread({
    model: replayModel(fixture.responses), gather: fixtureInput(fixture), reservedMicroUsd: fixture.reservedMicroUsd,
    fetch: { on: fixture.fetch }, signal: new AbortController().signal, now: () => new Date(fixture.now),
  });
}

export function expectationOf(outcome: ThreadOutcome): ResearchFixture['expected'] {
  return {
    kind: outcome.kind, costMicroUsd: outcome.costMicroUsd, searches: outcome.searches, fetches: outcome.fetches,
    continuations: outcome.continuations, sources: outcome.kind === 'recorded' ? outcome.sources : null,
    verified: outcome.kind === 'recorded' ? outcome.verified : null,
  };
}

async function recordFixture(run: ThreadRun, context: { now: Date; today: string; window: ResearchWindow }, options: FullEvalOptions, deps: FullEvalDeps): Promise<void> {
  const redact = redactor(options.redact);
  const base = {
    about: `D66 live eval recording (research-eval.ts --record), Hanover ${run.thread} thread, web fetch ${run.fetch ? 'on' : 'off'}, Google names not allowed. Encrypted fields and signatures stripped; the location's name redacted. Public pages only.`,
    thread: run.thread, fetch: run.fetch, placesToAi: false as const, now: context.now.toISOString(), today: context.today,
    window: context.window, reservedMicroUsd: run.reservedMicroUsd, responses: stripForFixture(run.responses, redact),
  };
  const replayed = await replayFixture({ ...base, expected: expectationOf(run.outcome) });
  const fixture: ResearchFixture = { ...base, expected: expectationOf(replayed) };
  const same = JSON.stringify(expectationOf(replayed)) === JSON.stringify(expectationOf(run.outcome));
  await deps.writeJson(`${deps.fixtureDir}/hanover-${run.thread}.json`, fixture);
  deps.log(`  recorded ${run.thread}: replay ${replayed.kind}, ${same ? 'equal to the live outcome' : 'differs from the live outcome (redaction or stripped page text)'}`);
}

// ---- The eval --------------------------------------------------------------------------------------------------------

export interface FullEvalResult {
  readonly now: string;
  readonly window: ResearchWindow;
  readonly maxUsd: number;
  readonly spentMicroUsd: number;
  readonly runs: readonly RunScore[];
  readonly sample: readonly SampledEvent[];
  readonly skipped: number;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function rate(part: number, whole: number): string {
  return whole === 0 ? 'n/a (n 0)' : `${(part / whole).toFixed(3)} (${String(part)}/${String(whole)})`;
}

function logScore(score: RunScore, log: (line: string) => void): void {
  log(`${score.group}: ${plural(score.threads.length, 'thread')}, ${String(score.emptyOrFailed)} empty or failed, cost $${usd(score.costMicroUsd)}`);
  for (const t of score.threads) {
    const drops = Object.entries(t.drops).filter(([, n]) => n > 0).map(([reason, n]) => `${reason} ${String(n)}`).join(', ') || 'none';
    log(`  ${t.thread}: ${t.outcome}${t.code === null ? '' : ` (${t.code})`}; $${usd(t.costMicroUsd)} of $${usd(t.reservedMicroUsd)} reserved; ${String(t.searches)} searches, ${String(t.fetches)} fetches, ${String(t.iterations)} gather iterations, ${String(t.pauses)} pauses, ${String(t.continuations)} continuations; ${String(Math.round(t.ms / 1000))} s; ${String(t.sources)} sources; extracted ${String(t.extracted)}, kept ${String(t.kept)} (grounded ${String(t.grounded)}; high ${String(t.confidence.high ?? 0)}, medium ${String(t.confidence.medium ?? 0)}, low ${String(t.confidence.low ?? 0)}), drops ${drops}; ${String(t.entities)} entities${t.tokensPerSearch === null ? '' : `; ${String(Math.round(t.tokensPerSearch))} tokens a search`}`);
    if (t.fetch !== null) log(`    fetch: ${String(t.fetch.fetchedPages)} pages, document_index values [${t.fetch.documentIndexes.join(', ')}], ${String(t.fetch.charCitations)} char_location citations, ${String(t.fetch.mappedAndFound)} found in the page their index maps to${t.fetchSwitchedOff ? '; fetch switched off by a refusal' : ''}`);
  }
  const events = score.curated.filter((row) => row.kind !== 'term');
  const terms = score.curated.filter((row) => row.kind === 'term');
  log(`  recall, curated event rows: ${rate(events.filter((row) => row.foundBy.length > 0).length, events.length)}; term rows: ${rate(terms.filter((row) => row.foundBy.length > 0).length, terms.length)}`);
  log(`  source validity ${rate(score.validSources, score.storedSources)}; unknown source ids before the filter ${rate(score.unknownSource, score.extracted)}; dates parse ${rate(score.dateChecked - score.badDates, score.dateChecked)}; grounded ${rate(score.grounded, score.kept)}`);
  log(`  merge: ${String(score.found)} found, ${String(score.mergeDrops.duplicate)} cross-thread duplicates, ${String(score.mergeDrops.curated_dupe)} curated, ${String(score.mergeDrops.town_dupe)} town; ${String(score.inserts.length)} stored (${String(score.storedGrounded)} medium or high); near-duplicate stored pairs ${String(score.nearDuplicates.length)}; entities ${String(score.threadEntities)} found, ${String(score.entities.length)} distinct, near-duplicate pairs ${String(score.nearDuplicateEntities.length)}`);
}

interface SavedRuns { readonly now: string; readonly runs: readonly ThreadRun[]; readonly skipped: number }

export async function runFullEval(options: FullEvalOptions, deps: FullEvalDeps): Promise<FullEvalResult> {
  const saved = options.fromRuns === null ? null : await deps.readJson(options.fromRuns) as SavedRuns;
  const now = saved === null ? deps.now() : new Date(saved.now);
  const town = hanover();
  const window = evalWindow(now, town.timeZone);
  const today = window.from;
  // Held out: no curated row in `known`, no curated source as a seed.
  const base: Omit<GatherInput, 'thread'> = { town, today, window, known: [], seeds: [], restaurant: null, competitors: null };
  const jobs: Job[] = [];
  const groups = new Set(options.groups);
  if (groups.has('town-off')) for (const id of TOWN_THREADS) jobs.push(jobFor('town-off', threadDef(id, { placesToAi: false }), base, false));
  if (groups.has('location')) {
    if (options.restaurant === null) {
      deps.log('location threads: skipped, no --restaurant given');
    } else {
      const located = { ...base, restaurant: { typed: true as const, name: options.restaurant } };
      for (const id of ['neighborhood', 'competitors'] as const) jobs.push(jobFor('location', threadDef(id, { placesToAi: false }), located, false));
    }
  }
  if (groups.has('town-on')) for (const id of TOWN_THREADS) jobs.push(jobFor('town-on', threadDef(id, { placesToAi: false }), base, true));

  const reserved = jobs.reduce((sum, job) => sum + job.reservedMicroUsd, 0);
  deps.log(`research-eval: ${plural(jobs.length, 'thread')} over ${window.from} to ${window.to}; reservations $${usd(reserved)} in all (a ceiling; expected spend is far lower), cap $${options.maxUsd.toFixed(2)}, ${String(options.concurrency)} at once`);
  let done: ThreadRun[];
  let skipped: number;
  if (saved === null) {
    const runs = await runPool(jobs, Math.round(options.maxUsd * 1e6), options.concurrency, deps);
    done = runs.filter((run): run is ThreadRun => run !== null);
    skipped = jobs.length - done.length;
    if (options.saveRuns !== null) await deps.writeJson(options.saveRuns, { now: now.toISOString(), runs: done, skipped } satisfies SavedRuns);
  } else {
    done = saved.runs.filter((run) => groups.has(run.group));
    skipped = saved.skipped;
    deps.log(`research-eval: scoring ${plural(done.length, 'saved thread')}, no model call`);
  }
  const curated = townEvents(TOWN_ID, window);

  const scores: RunScore[] = [];
  const of = (group: EvalGroup): ThreadRun[] => done.filter((run) => run.group === group);
  let townRows: StoredEvent[] = [];
  for (const group of ['town-off', 'town-on'] as const) {
    if (!groups.has(group) || of(group).length === 0) continue;
    const score = scoreRun(group, of(group), curated, []);
    if (group === 'town-off') townRows = score.inserts.map(storedRow);
    scores.push(score);
  }
  if (of('location').length > 0) scores.push(scoreRun('location', of('location'), curated, townRows));
  for (const score of scores) logScore(score, deps.log);

  // SEARCH_TOKENS from every fetch-off thread's searches.
  const perSearch = scores.flatMap((score) => score.threads.flatMap((t) => (t.tokensPerSearch === null ? [] : [{ tokens: t.tokensPerSearch * t.searches, searches: t.searches }])));
  const totalSearches = perSearch.reduce((sum, s) => sum + s.searches, 0);
  if (totalSearches > 0) {
    const values = scores.flatMap((score) => score.threads.flatMap((t) => (t.tokensPerSearch === null ? [] : [t.tokensPerSearch]))).sort((a, b) => a - b);
    deps.log(`tokens a search: mean ${String(Math.round(perSearch.reduce((sum, s) => sum + s.tokens, 0) / totalSearches))} over ${plural(totalSearches, 'search')}; per thread ${values.map((v) => String(Math.round(v))).join(', ')}`);
  }

  const ledgers = new Map(done.map((run) => [`${run.group}|${run.thread}`, buildLedger(run.outcome.messages)]));
  const quotesOf = (group: EvalGroup, thread: ThreadId, url: string): string[] => [...(ledgers.get(`${group}|${thread}`)?.byId(
    ledgers.get(`${group}|${thread}`)?.sources.find((source) => source.url === url)?.id ?? '',
  )?.quotes ?? [])];
  const townOff = scores.find((score) => score.group === 'town-off')?.inserts ?? [];
  const location = scores.find((score) => score.group === 'location')?.inserts ?? [];
  const redact = redactor(options.redact);
  const sample: SampledEvent[] = precisionSample(townOff, location, options.sample).map(({ group, insert }, index) => ({
    n: index + 1, group, thread: insert.thread, title: redact(insert.title), start: insert.start, end: insert.end,
    weekdays: insert.weekdays, confidence: insert.confidence,
    sources: insert.sources.map((source) => ({ url: source.url, quotes: quotesOf(group, insert.thread, source.url).map(redact) })),
  }));
  deps.log(`precision sample: ${plural(sample.length, 'stored row')} (${String(sample.filter((s) => s.group === 'location').length)} from the location run, ${String(sample.filter((s) => s.thread === 'competitors').length)} of them competitors)`);

  if (options.record) {
    for (const run of done) {
      if (run.fetch || run.outcome.kind !== 'recorded') continue;
      await recordFixture(run, { now, today, window }, options, deps);
    }
  }
  const spent = done.reduce((sum, run) => sum + run.outcome.costMicroUsd, 0);
  deps.log(`threads cost $${usd(spent)} in all; ${String(skipped)} skipped by the cap`);
  // The extract's own output, as a check on EXTRACT_MAX_TOKENS: the largest seen.
  const extractOut = done.flatMap((run) => run.responses.slice(run.outcome.messages.length).map((m) => m.usage.output_tokens));
  if (extractOut.length > 0) deps.log(`extract output tokens: max ${String(Math.max(...extractOut))} of 12,000; drops counted by reason: ${EVENT_DROP_REASONS.join(', ')}`);
  return { now: now.toISOString(), window, maxUsd: options.maxUsd, spentMicroUsd: spent, runs: scores, sample, skipped };
}
