// One parse thread at a time per process (spec 11A, 11A.9): the sales reader's thread and the TownwiseAI reader's
// text thread wait for the slot in the order they asked, so their heaps are never held at once. Files are synthetic.
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { extractAiText } from '../../src/files/parse/ai-text.ts';
import { runParse } from '../../src/files/parse/run.ts';
import { inThreadSlot } from '../../src/files/parse/thread-slot.ts';

/** Holds the slot until the returned release is called. */
function holdSlot(): { release: () => void; held: Promise<void> } {
  let release: () => void = () => undefined;
  const held = inThreadSlot(() => new Promise<void>((resolve) => { release = resolve; }));
  return { release: () => { release(); }, held };
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
});
