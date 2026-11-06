import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { usePortal } from '../PortalProvider';
import { currentImport, getImport, type ImportView } from './api';

// An import's status, polled (storage 13.1, storage2 15.1): every 2 seconds while files are waiting or being
// read, every 10 seconds while it is open or waiting for an answer, and not at all once it is done. A poll that
// falls due while the page is hidden (web) or the app is in the background waits until it is back. After an error
// the next poll is 10 seconds later, and the error is returned until a poll succeeds.

export const FAST_POLL_MS = 2_000;
export const SLOW_POLL_MS = 10_000;

/** The wait before the next poll; null when there is nothing left to poll. */
export function pollDelay(view: ImportView | null, failed: boolean): number | null {
  if (failed) return SLOW_POLL_MS;
  if (view === null) return null;
  switch (view.status) {
    case 'queued':
    case 'reading':
      return FAST_POLL_MS;
    case 'open':
    case 'waiting':
      return SLOW_POLL_MS;
    case 'done':
      return null;
  }
}

function hidden(): boolean {
  return AppState.currentState === 'background' || AppState.currentState === 'inactive';
}

export interface ImportPoll {
  /** Null before the first answer, and when `current` finds no import. */
  import: ImportView | null;
  loading: boolean;
  /** The last poll's error, until a poll succeeds. */
  error: unknown;
  /** Reads again now (after Read my history, an answer, or a drop). */
  refresh: () => void;
}

/** `importId` is an import's id, or 'current' for the location's active (or just finished) import. */
export function useImport(locationId: string, importId: string): ImportPoll {
  const { api } = usePortal();
  const [tick, setTick] = useState(0);
  const key = `${locationId}:${importId}`;
  const [state, setState] = useState<{ key: string; view: ImportView | null; error: unknown; loaded: boolean }>({
    key: '', view: null, error: null, loaded: false,
  });

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let due = false;
    let view: ImportView | null = null;
    let failed = false;
    const read = (): Promise<ImportView | null> => (importId === 'current' ? currentImport(api, locationId) : getImport(api, locationId, importId));

    function schedule(): void {
      const delay = pollDelay(view, failed);
      if (delay !== null) timer = setTimeout(() => { void poll(); }, delay);
    }

    async function poll(): Promise<void> {
      timer = null;
      if (hidden()) {
        due = true;
        return;
      }
      try {
        const next = await read();
        if (!live) return;
        view = next;
        failed = false;
        setState({ key, view: next, error: null, loaded: true });
      } catch (error) {
        if (!live) return;
        failed = true;
        setState((previous) => ({ key, view: previous.key === key ? previous.view : null, error, loaded: true }));
      }
      schedule();
    }

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && due && live) {
        due = false;
        void poll();
      }
    });
    void poll();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      subscription.remove();
    };
  }, [api, locationId, importId, key, tick]);

  const refresh = useCallback(() => { setTick((value) => value + 1); }, []);
  const mine = state.key === key;
  return { import: mine ? state.view : null, loading: !mine || !state.loaded, error: mine ? state.error : null, refresh };
}
