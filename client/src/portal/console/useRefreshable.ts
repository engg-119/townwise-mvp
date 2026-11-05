import { useCallback, useState } from 'react';

import { useLoad, type LoadState } from '../hooks';

// A read that refreshes in place after a write (P21): `refresh()` reads again and swaps the answer in, so the
// page keeps what it shows (and its open forms) instead of going back to its loading line. `reload()` is the
// Try again of a failed first read. A refresh never fails the write before it: it always resolves, and a failed
// one sets `refreshError`, which the page shows with a Try again of its own that calls `refresh()` again.

export function useRefreshable<T>(load: () => Promise<T>): {
  state: LoadState<T>;
  reload: () => void;
  /** Resolves to null when the read went through, or to why it failed, so the caller can act on it at once. */
  refresh: () => Promise<{ error: unknown } | null>;
  /** Why the last refresh failed, until one succeeds; null otherwise. */
  refreshError: unknown;
} {
  const { state, reload: loadAgain } = useLoad(load);
  const [fresh, setFresh] = useState<{ load: () => Promise<T>; data: T } | null>(null);
  const [failed, setFailed] = useState<{ load: () => Promise<T>; error: unknown } | null>(null);
  const refresh = useCallback(async () => {
    try {
      const data = await load();
      setFresh({ load, data });
      setFailed(null);
      return null;
    } catch (error) {
      setFailed({ load, error });
      return { error };
    }
  }, [load]);
  const reload = useCallback(() => {
    setFresh(null);
    setFailed(null);
    loadAgain();
  }, [loadAgain]);
  const shown: LoadState<T> = state.status === 'ready' && fresh?.load === load ? { status: 'ready', data: fresh.data } : state;
  return { state: shown, reload, refresh, refreshError: state.status === 'ready' && failed?.load === load ? failed.error : null };
}
