import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, useWindowDimensions } from 'react-native';

// Small hooks every portal page uses: a read with loading, error and reload state, a single-flight write, the
// layout breakpoints of spec 15.2, and (D65) the running-and-done pattern: a quiet re-read while something runs in
// the background and a callback once when it ends. Plain React, no data library.

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

/** D65: the pages' re-read while a forecast updates (design decision 4). */
export const WHILE_RUNNING_MS = 30_000;
/** After a failed re-read, the next one waits this long. */
export const AFTER_ERROR_MS = 10_000;

function inBackground(): boolean {
  return AppState.currentState === 'background' || AppState.currentState === 'inactive';
}

/**
 * Calls `onDone` once when `running` turns false after this mount saw it true (AiSection's `sawRunning`): a page that
 * opens on a finished run never calls it, and a run seen again later calls it again when that one ends.
 */
export function useWhenDone(running: boolean, onDone: (() => void) | undefined): void {
  const saw = useRef(false);
  const latest = useRef(onDone);
  useEffect(() => { latest.current = onDone; }, [onDone]);
  useEffect(() => {
    if (running) {
      saw.current = true;
      return;
    }
    if (!saw.current) return;
    saw.current = false;
    latest.current?.();
  }, [running]);
}

/**
 * D65, the running-and-done pattern (design decisions 4 and 10): while `running`, calls `refresh` every `everyMs`
 * (30 seconds by default), waiting while the app is in the background or the tab hidden (as files/useImport.ts) and
 * 10 seconds after a refresh that rejected; never while `running` is false. `onDone` runs once when `running` turns
 * false after it was seen true in this mount. Any background work an owner waits for (D66's research runs) uses it.
 */
export function useWhileRunning(
  running: boolean, refresh: () => Promise<unknown>, options: { everyMs?: number; onDone?: () => void } = {},
): void {
  const everyMs = options.everyMs ?? WHILE_RUNNING_MS;
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);
  useWhenDone(running, options.onDone);
  useEffect(() => {
    if (!running) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let due = false;
    function schedule(delay: number): void {
      timer = setTimeout(() => { void poll(); }, delay);
    }
    async function poll(): Promise<void> {
      timer = null;
      if (inBackground()) {
        due = true;
        return;
      }
      let failed = false;
      try {
        await latest.current();
      } catch {
        failed = true;
      }
      if (live) schedule(failed ? AFTER_ERROR_MS : everyMs);
    }
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && due && live) {
        due = false;
        void poll();
      }
    });
    schedule(everyMs);
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      subscription.remove();
    };
  }, [running, everyMs]);
}
