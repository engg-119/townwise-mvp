import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { ApiClient } from '../../api/client';
import { usePortal } from '../PortalProvider';
import { fetchProfile, saveProfile, type Profile } from './api';

// One read of the profile per person, shared by every caller (Home's greeting, Settings).
// Kept in memory only, keyed by the person whose name it is: under view-as that is the target, so a staff member's
// own name is never shown as theirs.

type Entry = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; profile: Profile };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const LOADING: Entry = { status: 'loading' };

function put(key: string, entry: Entry): void {
  entries.set(key, entry);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function load(key: string, api: ApiClient): void {
  put(key, LOADING);
  fetchProfile(api).then(
    (profile) => { put(key, { status: 'ready', profile }); },
    () => { put(key, { status: 'failed' }); },
  );
}

/** Forgets every stored profile (tests). */
export function resetProfiles(): void {
  entries.clear();
  for (const listener of listeners) listener();
}

export interface ProfileState {
  status: 'loading' | 'ready' | 'failed';
  profile: Profile | null;
  /** Stores the name (null for none) and shows the answer; rejects when the API refuses. */
  save: (displayName: string | null) => Promise<void>;
  reload: () => void;
}

export function useProfile(): ProfileState {
  const { me, api } = usePortal();
  const key = me.viewAs?.target.userId ?? me.user.id;
  const entry = useSyncExternalStore(subscribe, () => entries.get(key), () => undefined);
  const missing = entry === undefined;
  useEffect(() => { if (missing) load(key, api); }, [missing, key, api]);
  const save = useCallback(async (displayName: string | null) => {
    put(key, { status: 'ready', profile: await saveProfile(api, displayName) });
  }, [key, api]);
  const reload = useCallback(() => { load(key, api); }, [key, api]);
  const current = entry ?? LOADING;
  return { status: current.status, profile: current.status === 'ready' ? current.profile : null, save, reload };
}
