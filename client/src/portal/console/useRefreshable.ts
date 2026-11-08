import { useCallback, useRef, useState } from 'react';

import { useLoad, type LoadState } from '../hooks';

// A read that refreshes in place after a write (P21): `refresh()` reads again and swaps the answer in, so the
// page keeps what it shows (and its open forms) instead of going back to its loading line. `reload()` is the
// Try again of a failed first read. A refresh never fails the write before it: it always resolves, and a failed
// one sets `refreshError`, which the page shows with a Try again of its own that calls `refresh()` again.
// Only the newest read counts: an answer that lands after a newer refresh or reload began is dropped, so an older
// read can never show over a newer one.

export function useRefreshable<T>(load: () => Promise<T>): {
  state: LoadState<T>;
  reload: () => void;
  /**
   * Resolves to null when the read went through, or to why it failed, so the caller can act on it at once. A read
   * dropped for a newer one resolves to null: the newer one decides what shows.
   */
  refresh: () => Promise<{ error: unknown } | null>;
  /** Why the last refresh failed, until one succeeds; null otherwise. */
  refreshError: unknown;
} {
  const { state, reload: loadAgain } = useLoad(load);
  const [fresh, setFresh] = useState<{ load: () => Promise<T>; data: T } | null>(null);
  const [failed, setFailed] = useState<{ load: () => Promise<T>; error: unknown } | null>(null);
  /** Bumped by each refresh and reload; an answer whose number isn't the newest is dropped. */
  const newest = useRef(0);
  const refresh = useCallback(async () => {
    newest.current += 1;
    const run = newest.current;
    try {
      const data = await load();
      if (run !== newest.current) return null;
      setFresh({ load, data });
      setFailed(null);
      return null;
    } catch (error) {
      if (run !== newest.current) return null;
      setFailed({ load, error });
      return { error };
    }
  }, [load]);
  const reload = useCallback(() => {
    newest.current += 1;
    setFresh(null);
    setFailed(null);
    loadAgain();
  }, [loadAgain]);
  const shown: LoadState<T> = state.status === 'ready' && fresh?.load === load ? { status: 'ready', data: fresh.data } : state;
  return { state: shown, reload, refresh, refreshError: state.status === 'ready' && failed?.load === load ? failed.error : null };
}
