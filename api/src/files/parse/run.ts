// Runs the parse thread (thread.ts) for one file with memory and time limits (spec 11A). The file is fed in pieces of
// at most 1 MiB, each transferred and acknowledged before the next, so the thread's input is bounded; a text file is
// fed twice when the thread asks. Out of memory or out of time terminates the thread and the file is kept as
// too_complex; the API process is untouched. The time limit covers the file's reads from storage too: a stalled read
// is aborted, so it never holds the replica's reader or the import's lease.
import { Worker, type ResourceLimits } from 'node:worker_threads';

import type { FileAnswers } from '../../stores/files.ts';
import { READ_TIME_MS, THREAD_CHUNK_BYTES, THREAD_LIMITS } from '../limits.ts';
import type { SalesDay } from './days.ts';
import type { KeptOutcome, QuestionDraft } from './mapping.ts';
import type { TableReport } from './table.ts';

/** A file's report (spec 11A): the primary table's, totals over every used sheet, and each sheet's fate. */
export type FileReport = TableReport & {
  sheets: { name: string; used: boolean; why: string }[];
  encoding: 'utf-8' | 'utf-16' | 'windows-1252' | null;
};

export type FileOutcome =
  | { kind: 'kept'; outcome: KeptOutcome; report: null }
  | { kind: 'question'; question: QuestionDraft & { sheet: number } }
  | { kind: 'days'; days: SalesDay[]; report: FileReport };

export type ThreadIn =
  | {
    type: 'begin'; kind: 'text' | 'xlsx'; sizeBytes: number; answers: FileAnswers; locationName: string;
    /** The last date the reader accepts (the server's UTC date plus one). */
    latest: string;
    /** An org admin's file: a later sheet's day replaces an earlier sheet's. */
    replace: boolean;
  }
  | { type: 'chunk'; data: ArrayBuffer }
  | { type: 'end' };

export type ThreadOut =
  | { type: 'ack' }
  | { type: 'again' }
  | { type: 'progress'; done: number; total: number | null }
  | { type: 'result'; outcome: FileOutcome };

export interface ParseInput {
  readonly kind: 'text' | 'xlsx';
  readonly sizeBytes: number;
  readonly answers: FileAnswers;
  readonly locationName: string;
  readonly latest: string;
  readonly replace: boolean;
  /** The file's bytes, from the start; called once per pass. `signal` aborts at the time limit. */
  readonly open: (signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  readonly onProgress: (done: number, total: number | null) => void;
  readonly signal?: AbortSignal;
  /** Tests shorten these. */
  readonly timeMs?: number;
  readonly resourceLimits?: ResourceLimits;
}

const THREAD_URL = new URL('./thread.ts', import.meta.url);

/** A queue of the thread's messages, read one at a time. */
function inbox(worker: Worker): { next(): Promise<ThreadOut> } {
  const waiting: ((message: ThreadOut | Error) => void)[] = [];
  const queued: (ThreadOut | Error)[] = [];
  const deliver = (message: ThreadOut | Error): void => {
    const take = waiting.shift();
    if (take === undefined) queued.push(message);
    else take(message);
  };
  worker.on('message', deliver);
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
  // Every message the thread sends but the acks and the final answer is progress.
  const nextReply = async (): Promise<Exclude<ThreadOut, { type: 'progress' }>> => {
    for (;;) {
      const message = await Promise.race([messages.next(), timeout]);
      if (message.type !== 'progress') return message;
      input.onProgress(message.done, message.total);
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
    await feed();
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
    await worker.terminate();
  }
}
