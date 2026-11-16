// One parse thread at a time in this process (spec 11A, 11A.9): the sales reader's thread (run.ts) and the TownwiseAI
// reader's text thread (ai-text.ts) each take most of a replica's memory at their heap limits, so a thread starts only
// once the one before it, of either kind, has ended. Each waits its turn in the order it asked; a thread's time limit
// starts once it has the slot. A chat turn reading an attached file (D36) waits only so long: one that gives up never
// runs, and its place passes to the next at once.

let last: Promise<unknown> = Promise.resolve();

/** A run that gave up waiting for the slot (inThreadSlot's `waitMs`): it never ran. */
export class SlotBusy extends Error {}

/**
 * Runs `run` once every earlier run here has settled, and holds the slot until it settles. With `waitMs`, a run that
 * hasn't got the slot by then rejects with SlotBusy and never runs; without it, a run waits as long as it takes.
 */
export function inThreadSlot<T>(run: () => Promise<T>, waitMs?: number): Promise<T> {
  // The queue keeps only this, never `run` itself, and drops it when the run starts or gives up waiting, so what `run`
  // holds (a file's bytes) isn't kept alive by the queue while the runs ahead of it finish.
  let pending: (() => Promise<T>) | null = run;
  let timer: NodeJS.Timeout | undefined;
  const turn = (): Promise<T> => {
    clearTimeout(timer);
    const job = pending;
    pending = null;
    return job === null ? Promise.reject(new SlotBusy()) : job();
  };
  const mine = last.then(turn, turn);
  last = mine.catch(() => undefined);
  if (waitMs === undefined) return mine;
  const gaveUp = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      pending = null;
      reject(new SlotBusy());
    }, waitMs);
  });
  return Promise.race([mine, gaveUp]);
}
