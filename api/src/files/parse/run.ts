// Runs the parse thread (thread.ts) for one file with memory and time limits (spec 11A). The file is fed in pieces of
// at most 1 MiB, each transferred and acknowledged before the next, so the thread's input is bounded; a text file is
// fed twice when the thread asks. Out of memory or out of time terminates the thread and the file is kept as
// too_complex; the API process is untouched. The time limit covers the file's reads from storage too: a stalled read
// is aborted, so it never holds the replica's reader or the import's lease. A ZIP is not fed: the thread asks for the
// byte ranges it needs (its directory, then each entry), and this side answers each from storage, continuing one open
// download while the reads are in order. A reference item TownwiseAI reads (runItemRead) is posted to its own, smaller
// thread whole, one item at a time per replica: a PDF to count its pages, a Word document to take its text.
import { Worker, type ResourceLimits } from 'node:worker_threads';

import type { FileAnswers } from '../../stores/files.ts';
import type { RedactedProfile } from '../extract/profile.ts';
import type { ColumnChoice } from '../extract/prompt.ts';
import type { EntryRow } from './archive.ts';
import type { FamilyReport } from './families.ts';
import { ITEM_READ_TIME_MS, ITEM_THREAD_LIMITS, READ_TIME_MS, THREAD_CHUNK_BYTES, THREAD_LIMITS } from '../limits.ts';
import type { SalesDay } from './days.ts';
import type { KeptOutcome, QuestionDraft } from './mapping.ts';
import type { TableReport } from './table.ts';

/** A file's report (spec 11A): the primary table's, totals over every used sheet, and each sheet's fate. */
export type FileReport = TableReport & {
  sheets: { name: string; used: boolean; why: string }[];
  encoding: 'utf-8' | 'utf-16' | 'windows-1252' | null;
  /** A ZIP's tables by family. */
  families?: FamilyReport[];
};

/** A question about one file; for a ZIP, about one family of its tables (`family` is its signature). */
export type FileQuestion = QuestionDraft & { sheet: number; family?: string; familyLabel?: string };

export type FileOutcome =
  | { kind: 'kept'; outcome: KeptOutcome; report: null; entries?: EntryRow[] }
  | { kind: 'question'; question: FileQuestion }
  | { kind: 'days'; days: SalesDay[]; report: FileReport; entries?: EntryRow[] };

export type ParseKind = 'text' | 'xlsx' | 'pdf' | 'docx' | 'zip';

/**
 * A reference item TownwiseAI reads (openspec change connect-owner-calendar, design decision 9): a PDF's page count, or
 * a Word document's paragraph and table text, cut at `maxChars`.
 */
export type ItemJob = { readonly kind: 'pdf_pages' } | { readonly kind: 'word_text'; readonly maxChars: number };

export type ItemOutcome =
  | { kind: 'pages'; pages: number }
  | { kind: 'text'; text: string; truncated: boolean }
  /** Damaged, locked with a password, or not the kind of file it was taken for. */
  | { kind: 'cannot_open' }
  /** Over the Word reader's caps, or out of the thread's time or memory. */
  | { kind: 'too_large' };

export type ThreadIn =
  | {
    type: 'begin'; kind: ParseKind; sizeBytes: number; answers: FileAnswers; locationName: string;
    /** The last date the reader accepts (the server's UTC date plus one). */
    latest: string;
    /** An org admin's file: a later sheet's day replaces an earlier sheet's. */
    replace: boolean;
  }
  | { type: 'chunk'; data: ArrayBuffer }
  | { type: 'end' }
  /** The bytes a `read` asked for (fewer only at the end of the file). */
  | { type: 'bytes'; id: number; data: ArrayBuffer }
  /** The AI column step's answer to a `model` request; null when there is none (off, over budget, failed, declined). */
  | { type: 'choice'; id: number; choice: ColumnChoice | null }
  /** A reference item's job, with the whole item. */
  | { type: 'item'; job: ItemJob; data: ArrayBuffer };

export type ThreadOut =
  | { type: 'ack' }
  | { type: 'again' }
  | { type: 'progress'; done: number; total: number | null }
  /** A ZIP's thread asks for `count` bytes from `offset`. */
  | { type: 'read'; id: number; offset: number; count: number }
  /** The thread asks the AI column step about one table; only the redacted profile crosses. */
  | { type: 'model'; id: number; profile: RedactedProfile }
  | { type: 'result'; outcome: FileOutcome }
  | { type: 'item'; outcome: ItemOutcome };

export interface ParseInput {
  readonly kind: ParseKind;
  readonly sizeBytes: number;
  readonly answers: FileAnswers;
  readonly locationName: string;
  readonly latest: string;
  readonly replace: boolean;
  /** The file's bytes, from the start; called once per pass. `signal` aborts at the time limit. */
  readonly open: (signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  /** The file's bytes from `offset` to its end (a ZIP's ranged reads). Required for a ZIP. */
  readonly openAt?: (offset: number, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  readonly onProgress: (done: number, total: number | null) => void;
  /** The AI column step (the worker applies its bounds and budget); absent, the thread asks the person instead. */
  readonly chooseColumns?: (profile: RedactedProfile) => Promise<ColumnChoice | null>;
  readonly signal?: AbortSignal;
  /** Tests shorten these. */
  readonly timeMs?: number;
  readonly resourceLimits?: ResourceLimits;
}

const THREAD_URL = new URL('./thread.ts', import.meta.url);

const THREAD_OUT_TYPES: ReadonlySet<string> = new Set<ThreadOut['type']>(['ack', 'again', 'progress', 'read', 'model', 'result', 'item']);

/**
 * True for the parse thread's own messages. Node can post others on a worker's port: under `node --watch` (the api's
 * `npm run dev`) each module the thread loads arrives as `{ 'watch:import': [...] }`, some mid-file, since the thread
 * loads its PDF and archive readers on demand.
 */
export function isThreadOut(message: unknown): message is ThreadOut {
  return typeof message === 'object' && message !== null && 'type' in message
    && typeof message.type === 'string' && THREAD_OUT_TYPES.has(message.type);
}

/** The worker events the inbox listens to. */
export interface InboxSource {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

/** A queue of the thread's messages, read one at a time; any other message on the port is dropped. */
export function inbox(worker: InboxSource): { next(): Promise<ThreadOut> } {
  const waiting: ((message: ThreadOut | Error) => void)[] = [];
  const queued: (ThreadOut | Error)[] = [];
  const deliver = (message: ThreadOut | Error): void => {
    const take = waiting.shift();
    if (take === undefined) queued.push(message);
    else take(message);
  };
  worker.on('message', (message: unknown) => {
    if (isThreadOut(message)) deliver(message);
  });
  worker.on('error', (err: Error) => { deliver(err); });
  worker.on('exit', (code) => { deliver(new Error(`parse thread exited (${String(code)})`)); });
  return {
    next() {
      const message = queued.shift();
      const result = message === undefined ? new Promise<ThreadOut | Error>((resolve) => { waiting.push(resolve); }) : Promise.resolve(message);
      return result.then((value) => {
        if (value instanceof Error) throw value;
        return value;
      });
    },
  };
}

class TimeLimit extends Error {}

/**
 * Answers a thread's ranged reads from storage. Reads in order continue one open download; a read elsewhere opens a
 * new one from its offset.
 */
class RangeServer {
  private iterator: AsyncIterator<Uint8Array> | null = null;
  private position = -1;
  private leftover: Buffer = Buffer.alloc(0);
  private readonly openAt: (offset: number, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  private readonly signal: AbortSignal;

  constructor(openAt: (offset: number, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>, signal: AbortSignal) {
    this.openAt = openAt;
    this.signal = signal;
  }

  async read(offset: number, count: number): Promise<Buffer> {
    if (this.iterator === null || offset !== this.position) {
      await this.close();
      this.iterator = (await this.openAt(offset, this.signal))[Symbol.asyncIterator]();
      this.position = offset;
      this.leftover = Buffer.alloc(0);
    }
    const parts: Buffer[] = [this.leftover];
    let have = this.leftover.length;
    while (have < count) {
      const next = await this.iterator.next();
      if (next.done === true) break;
      const part = Buffer.from(next.value);
      parts.push(part);
      have += part.length;
    }
    const all = Buffer.concat(parts);
    const out = all.subarray(0, count);
    this.leftover = Buffer.from(all.subarray(count));
    this.position = offset + out.length;
    return out;
  }

  async close(): Promise<void> {
    const iterator = this.iterator;
    this.iterator = null;
    await iterator?.return?.().catch(() => undefined);
  }
}

function isTooComplex(err: unknown): boolean {
  if (err instanceof TimeLimit) return true;
  return err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY';
}

/** One file through the parse thread. Any other thread failure rejects (the worker counts it as an attempt). */
export async function runParse(input: ParseInput): Promise<FileOutcome> {
  const worker = new Worker(THREAD_URL, { resourceLimits: input.resourceLimits ?? THREAD_LIMITS });
  const messages = inbox(worker);
  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeLimit());
      stop.abort();
    }, input.timeMs ?? READ_TIME_MS);
  });
  // Raced below; this keeps a rejection while nothing is racing it from going unhandled.
  timeout.catch(() => undefined);
  const openAt = input.openAt;
  const ranges = openAt === undefined ? null : new RangeServer(openAt, stop.signal);
  // Progress is reported and ranged reads are answered here; every other message is returned.
  const nextReply = async (): Promise<Exclude<ThreadOut, { type: 'progress' | 'read' | 'model' }>> => {
    for (;;) {
      const message = await Promise.race([messages.next(), timeout]);
      if (message.type === 'progress') {
        input.onProgress(message.done, message.total);
        continue;
      }
      if (message.type === 'model') {
        const choose = input.chooseColumns;
        const choice = choose === undefined ? null : await Promise.race([choose(message.profile), timeout]);
        worker.postMessage({ type: 'choice', id: message.id, choice } satisfies ThreadIn);
        continue;
      }
      if (message.type === 'read') {
        if (ranges === null) throw new Error('parse thread asked for a range of a file it was fed');
        const bytes = await Promise.race([ranges.read(message.offset, message.count), timeout]);
        const data = new Uint8Array(bytes).buffer;
        worker.postMessage({ type: 'bytes', id: message.id, data } satisfies ThreadIn, [data]);
        continue;
      }
      return message;
    }
  };
  const pass = async (): Promise<void> => {
    for await (const piece of await input.open(stop.signal)) {
      input.signal?.throwIfAborted();
      for (let at = 0; at < piece.length; at += THREAD_CHUNK_BYTES) {
        const data = new Uint8Array(piece.subarray(at, at + THREAD_CHUNK_BYTES)).buffer;
        worker.postMessage({ type: 'chunk', data } satisfies ThreadIn, [data]);
        const reply = await nextReply();
        if (reply.type !== 'ack') throw new Error('parse thread out of step');
      }
    }
    worker.postMessage({ type: 'end' } satisfies ThreadIn);
  };
  // A pass waits on storage as well as on the thread, so it races the time limit as a whole.
  const feed = (): Promise<void> => {
    const fed = pass();
    fed.catch(() => undefined);
    return Promise.race([fed, timeout]);
  };
  try {
    worker.postMessage({
      type: 'begin', kind: input.kind, sizeBytes: input.sizeBytes, answers: input.answers, locationName: input.locationName,
      latest: input.latest, replace: input.replace,
    } satisfies ThreadIn);
    if (input.kind !== 'zip') await feed();
    for (;;) {
      const reply = await nextReply();
      if (reply.type === 'result') return reply.outcome;
      if (reply.type === 'again') await feed();
    }
  } catch (err) {
    if (isTooComplex(err)) return { kind: 'kept', outcome: 'too_complex', report: null };
    throw err;
  } finally {
    clearTimeout(timer);
    stop.abort();
    await ranges?.close();
    await worker.terminate();
  }
}

export interface ItemReadInput {
  readonly job: ItemJob;
  /** The whole item; a copy is sent, so the caller keeps these bytes. */
  readonly bytes: Uint8Array;
  /** Tests shorten these. */
  readonly timeMs?: number;
  readonly resourceLimits?: ResourceLimits;
}

/** The replica's item reads, in order: each starts when the one before it has settled. */
let itemReads: Promise<unknown> = Promise.resolve();

/**
 * One reference item through the parse thread, for TownwiseAI. Item reads run one at a time on a replica, each in a
 * thread with ITEM_THREAD_LIMITS, so chat reads add at most one small thread to the file reader's; a read's time limit
 * starts when its turn comes. Out of time or memory answers too_large.
 */
export function runItemRead(input: ItemReadInput): Promise<ItemOutcome> {
  const read = itemReads.then(() => readItem(input));
  // A read that fails never holds up the next.
  itemReads = read.catch(() => undefined);
  return read;
}

async function readItem(input: ItemReadInput): Promise<ItemOutcome> {
  const worker = new Worker(THREAD_URL, { resourceLimits: input.resourceLimits ?? ITEM_THREAD_LIMITS });
  const messages = inbox(worker);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new TimeLimit()); }, input.timeMs ?? ITEM_READ_TIME_MS);
  });
  // Raced below; this keeps a rejection while nothing is racing it from going unhandled.
  timeout.catch(() => undefined);
  try {
    const data = new Uint8Array(input.bytes).buffer;
    worker.postMessage({ type: 'item', job: input.job, data } satisfies ThreadIn, [data]);
    const reply = await Promise.race([messages.next(), timeout]);
    if (reply.type !== 'item') throw new Error('parse thread out of step');
    return reply.outcome;
  } catch (err) {
    if (isTooComplex(err)) return { kind: 'too_large' };
    throw err;
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}
