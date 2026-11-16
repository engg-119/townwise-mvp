// One parse thread at a time per process (spec 11A, 11A.9): the sales reader's thread and the TownwiseAI reader's
// text thread wait for the slot in the order they asked, so their heaps are never held at once, and a chat read (D36)
// that gives up waiting never runs. Files are synthetic.
import { Readable } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { extractAiText } from '../../src/files/parse/ai-text.ts';
import { runParse } from '../../src/files/parse/run.ts';
import { inThreadSlot, SlotBusy } from '../../src/files/parse/thread-slot.ts';

/** Holds the slot until the returned release is called; `started` settles once it has the slot. */
function holdSlot(): { release: () => void; held: Promise<void>; started: Promise<void> } {
  let release: () => void = () => undefined;
  let start: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const held = inThreadSlot(() => new Promise<void>((resolve) => {
    release = resolve;
    start();
  }));
  return { release: () => { release(); }, held, started };
}

/** A full garbage collection, so a WeakRef to something nothing holds empties (node's own flag, set for this test file). */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, ms); })]);
}

describe('the parse-thread slot', () => {
  it('runs one at a time, in the order asked, and a failure does not hold it', async () => {
    const order: string[] = [];
    const first = holdSlot();
    const failing = inThreadSlot(() => {
      order.push('failing');
      return Promise.reject(new Error('thread failed'));
    });
    const last = inThreadSlot(() => {
      order.push('last');
      return Promise.resolve('done');
    });
    expect(await settlesWithin(last, 50)).toBe(false);
    expect(order).toEqual([]);
    first.release();
    await expect(failing).rejects.toThrow('thread failed');
    expect(await last).toBe('done');
    expect(order).toEqual(['failing', 'last']);
  });

  it('holds the TownwiseAI text thread and the sales parse thread until the slot is free', async () => {
    const slot = holdSlot();
    const text = extractAiText({ kind: 'docx', bytes: Buffer.from('not a word file'), maxChars: 100 });
    const csv = Buffer.from('Date,Guests\n2026-05-01,120\n');
    const sales = runParse({
      kind: 'text', sizeBytes: csv.length, answers: {}, locationName: 'Room', latest: '2026-06-02', replace: true,
      open: () => Promise.resolve(Readable.from([csv])), onProgress: () => undefined,
    });
    expect(await settlesWithin(Promise.all([text, sales]), 300)).toBe(false);
    slot.release();
    expect(await text).toEqual({ kind: 'kept', outcome: 'not_readable' });
    expect((await sales).kind).toBe('days');
  });

  it('a run that waits past its waitMs rejects SlotBusy, never runs, and passes its place on at once', async () => {
    const ran: string[] = [];
    const slot = holdSlot();
    const impatient = inThreadSlot(() => {
      ran.push('impatient');
      return Promise.resolve('read');
    }, 20);
    const patient = inThreadSlot(() => {
      ran.push('patient');
      return Promise.resolve('done');
    });
    await expect(impatient).rejects.toBeInstanceOf(SlotBusy);
    expect(ran).toEqual([]);
    slot.release();
    expect(await patient).toBe('done');
    // The abandoned run was skipped: only the run behind it ran, and the slot is free again.
    expect(ran).toEqual(['patient']);
    expect(await inThreadSlot(() => Promise.resolve('free'), 1_000)).toBe('free');
    expect(ran).toEqual(['patient']);
  });

  it('a run that gave up waiting is no longer held by the queue, so what it holds can go while the runs ahead finish', async () => {
    const slot = holdSlot();
    await slot.started;
    let ran = false;
    const { bytes, waiting } = ((): { bytes: WeakRef<Uint8Array>; waiting: Promise<number> } => {
      // A file's bytes, held only by the run.
      const held = new Uint8Array(1024 * 1024);
      return {
        bytes: new WeakRef(held),
        waiting: inThreadSlot(() => {
          ran = true;
          return Promise.resolve(held.length);
        }, 20),
      };
    })();
    await expect(waiting).rejects.toBeInstanceOf(SlotBusy);
    // A new task, so the WeakRef no longer keeps its target for the task that made it; the slot is still held.
    await new Promise((resolve) => { setImmediate(resolve); });
    collectGarbage();
    expect(bytes.deref()).toBeUndefined();
    slot.release();
    await slot.held;
    expect(ran).toBe(false);
  });

  it('a run that gets the slot within its waitMs runs to the end, past its waitMs', async () => {
    const slot = holdSlot();
    await slot.started;
    const run = inThreadSlot(() => new Promise<string>((resolve) => { setTimeout(() => { resolve('slow'); }, 300); }), 50);
    // Freed before any timer can fire: the run starts, and its wait no longer counts.
    slot.release();
    expect(await run).toBe('slow');
  });

  it('extractAiText with a waitMs rejects SlotBusy while the slot stays taken', async () => {
    const slot = holdSlot();
    try {
      await expect(extractAiText({ kind: 'docx', bytes: Buffer.from('not a word file'), maxChars: 100, waitMs: 20 })).rejects.toBeInstanceOf(SlotBusy);
    } finally {
      slot.release();
    }
  });
});
