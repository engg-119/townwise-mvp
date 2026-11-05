import { useCallback, useState } from 'react';

import { useLoad, type LoadState } from '../hooks';

// A read that refreshes in place after a write (P21): `refresh()` reads again and swaps the answer in, so the
// page keeps what it shows (and its open forms) instead of going back to its loading line. `reload()` is the
// Try again of a failed read. A refresh that fails rejects, and the write's own error line says so.

export function useRefreshable<T>(load: () => Promise<T>): { state: LoadState<T>; reload: () => void; refresh: () => Promise<void> } {
  const { state, reload: loadAgain } = useLoad(load);
  const [fresh, setFresh] = useState<{ load: () => Promise<T>; data: T } | null>(null);
  const refresh = useCallback(async () => {
    const data = await load();
    setFresh({ load, data });
  }, [load]);
  const reload = useCallback(() => {
    setFresh(null);
    loadAgain();
  }, [loadAgain]);
  const shown: LoadState<T> = state.status === 'ready' && fresh?.load === load ? { status: 'ready', data: fresh.data } : state;
  return { state: shown, reload, refresh };
}
