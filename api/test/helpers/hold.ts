// Deterministic interleavings: holds every call to one model method (TwMember's unless another model is named) until the
// test releases it, so a test can run another request between two steps of a handler (its write and its recount, say)
// in an exact order. Only for call sites that await the query directly: a held call resolves to a promise, so a chained
// `.lean()` would not work.
import { vi } from 'vitest';

import type { TownwiseTestServer } from './server.ts';

type HeldMethod = 'countDocuments' | 'findOneAndUpdate' | 'bulkWrite' | 'updateOne' | 'deleteOne' | 'create' | 'deleteMany';

export interface Hold {
  /** Resolves when the nth call (from 1, in arrival order) has arrived and is waiting. */
  arrived(n: number): Promise<void>;
  /** Lets the nth call run, now or as soon as it arrives. */
  release(n: number): void;
  /** Lets every call run, now and from now on. */
  open(): void;
  /** Opens the hold and puts the method back. */
  restore(): void;
}

interface Latch { readonly promise: Promise<void>; readonly resolve: () => void }

function latch(): Latch {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function holdCalls(server: TownwiseTestServer, method: HeldMethod, modelName = 'TwMember'): Hold {
  const model = server.connection.models[modelName] as unknown as Record<HeldMethod, (...args: unknown[]) => unknown>;
  const real = model[method].bind(model);
  const arrivals = new Map<number, Latch>();
  const releases = new Map<number, Latch>();
  const at = (latches: Map<number, Latch>, n: number): Latch => {
    const found = latches.get(n) ?? latch();
    latches.set(n, found);
    return found;
  };
  let calls = 0;
  let opened = false;
  const spy = vi.spyOn(model, method).mockImplementation(async (...args: unknown[]) => {
    calls += 1;
    const n = calls;
    at(arrivals, n).resolve();
    if (!opened) await at(releases, n).promise;
    return real(...args);
  });
  const open = (): void => {
    opened = true;
    for (const pending of releases.values()) pending.resolve();
  };
  return {
    arrived: (n) => at(arrivals, n).promise,
    release: (n) => { at(releases, n).resolve(); },
    open,
    restore: () => {
      open();
      spy.mockRestore();
    },
  };
}
