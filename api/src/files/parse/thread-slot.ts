// One parse thread at a time in this process (spec 11A, 11A.9): the sales reader's thread (run.ts) and the TownwiseAI
// reader's text thread (ai-text.ts) each take most of a replica's memory at their heap limits, so a thread starts only
// once the one before it, of either kind, has ended. Each waits its turn in the order it asked; a thread's time limit
// starts once it has the slot.

let last: Promise<unknown> = Promise.resolve();

/** Runs `run` once every earlier run here has settled, and holds the slot until it settles. */
export function inThreadSlot<T>(run: () => Promise<T>): Promise<T> {
  const mine = last.then(run, run);
  last = mine.catch(() => undefined);
  return mine;
}
