// TownwiseAI's item reads through the parse thread (openspec change connect-owner-calendar, design decision 9): one at
// a time on a replica, each in a thread with ITEM_THREAD_LIMITS, so chat reads add at most one small thread beside the
// file reader's in the replica's 0.5 GiB. The Worker class is wrapped to count the threads alive at once.
import type * as WorkerThreads from 'node:worker_threads';

import { describe, expect, it, vi } from 'vitest';

import { ITEM_THREAD_LIMITS } from '../../src/files/limits.ts';
import { runItemRead } from '../../src/files/parse/run.ts';
import { pdfOf } from '../helpers/pdf.ts';

const threads = vi.hoisted(() => ({ alive: 0, most: 0, limits: [] as unknown[], failNext: false }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof WorkerThreads>();
  class CountedWorker extends real.Worker {
    constructor(url: string | URL, options?: WorkerThreads.WorkerOptions) {
      if (threads.failNext) {
        threads.failNext = false;
        throw new Error('thread could not start');
      }
      super(url, options);
      threads.alive += 1;
      threads.most = Math.max(threads.most, threads.alive);
      threads.limits.push(options?.resourceLimits);
      this.once('exit', () => { threads.alive -= 1; });
    }
  }
  return { ...real, Worker: CountedWorker };
});

describe('item reads', () => {
  it('run one at a time, each in a thread with the item limits', async () => {
    threads.most = 0;
    threads.limits.length = 0;
    const pdf = pdfOf([{}, {}]);
    const reads = await Promise.all([1, 2, 3].map(() => runItemRead({ job: { kind: 'pdf_pages' }, bytes: pdf })));
    expect(reads).toEqual([1, 2, 3].map(() => ({ kind: 'pages', pages: 2 })));
    expect(threads.most).toBe(1);
    expect(threads.limits).toEqual([ITEM_THREAD_LIMITS, ITEM_THREAD_LIMITS, ITEM_THREAD_LIMITS]);
  }, 30_000);

  it('never let a read that fails hold up the next', async () => {
    threads.failNext = true;
    const pdf = pdfOf([{}]);
    const [failed, next] = await Promise.allSettled([
      runItemRead({ job: { kind: 'pdf_pages' }, bytes: pdf }),
      runItemRead({ job: { kind: 'pdf_pages' }, bytes: pdf }),
    ]);
    expect(failed).toMatchObject({ status: 'rejected', reason: { message: 'thread could not start' } });
    expect(next).toEqual({ status: 'fulfilled', value: { kind: 'pages', pages: 1 } });
  }, 30_000);
});
