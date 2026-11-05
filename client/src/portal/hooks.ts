import { useCallback, useEffect, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';

// Small hooks every portal page uses: a read with loading, error and reload state, a single-flight write, and
// the layout breakpoints of spec 15.2. Plain React, no data library.

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'failed'; error: unknown }
  | { status: 'ready'; data: T };

/**
 * Runs `load` on mount and whenever its identity changes (wrap it in useCallback with its inputs), and again on
 * `reload()`. The state reads `loading` until the newest call settles; an older call's answer is dropped.
 */
export function useLoad<T>(load: () => Promise<T>): { state: LoadState<T>; reload: () => void } {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ load: () => Promise<T>; tick: number; state: LoadState<T> } | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => { if (live) setResult({ load, tick, state: { status: 'ready', data } }); },
      (error: unknown) => { if (live) setResult({ load, tick, state: { status: 'failed', error } }); },
    );
    return () => { live = false; };
  }, [load, tick]);
  const reload = useCallback(() => { setTick((value) => value + 1); }, []);
  const state: LoadState<T> = result !== null && result.load === load && result.tick === tick ? result.state : { status: 'loading' };
  return { state, reload };
}

export interface Action<A extends unknown[]> {
  /** Starts the action unless one is already running; a second press while it runs does nothing. */
  run: (...args: A) => void;
  pending: boolean;
  /** What the last run threw, until the next run starts. */
  error: unknown;
}

/** A write behind a button: one at a time, with its pending flag and its error. */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<void>): Action<A> {
  const inflight = useRef(false);
  const latest = useRef(action);
  useEffect(() => { latest.current = action; }, [action]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback((...args: A) => {
    if (inflight.current) return;
    inflight.current = true;
    setPending(true);
    setError(null);
    latest.current(...args).then(
      () => { inflight.current = false; setPending(false); },
      (caught: unknown) => { inflight.current = false; setPending(false); setError(caught); },
    );
  }, []);
  return { run, pending, error };
}

export interface Breakpoint {
  width: number;
  /** 640px and below: one column, 16px margins, stacked tables. */
  phone: boolean;
  /** 1024px and up: 12 columns and split page headers. */
  desktop: boolean;
  /** Below 900px the client nav takes a second row (below 1024px for the console's). */
  narrowNav: boolean;
  /** The page's side margin (spec 15.2 grid). */
  margin: number;
}

export function breakpointOf(width: number): Breakpoint {
  const phone = width <= 640;
  const desktop = width >= 1024;
  const margin = phone ? 16 : desktop ? Math.min(80, Math.max(16, Math.round(width * 0.0555))) : 32;
  return { width, phone, desktop, narrowNav: width < 900, margin };
}

export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  return breakpointOf(width);
}
