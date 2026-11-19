import { useEffect, useState } from 'react';

import { viewStore } from './viewStore';

// How Your data shows its list (D61): "Organized", in folders (the default), or "Newest first", one list. The pick is
// remembered per person who signed in (the staff member under view-as, not the person viewed as): in this browser's
// localStorage on web (viewStore.web.ts) and the device's secure store on iOS and Android (viewStore.ts). Only the
// view's word is kept, never anything of the data. Storage that is missing, throws or holds anything else reads as
// Organized.

export type DataView = 'organized' | 'newest';

/** Where the pick is kept: read at once where storage allows it (web), read later, and written without waiting. */
export interface ViewStore {
  readNow(key: string): string | null;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): void;
}

/** The key for one signed-in person, in the characters a secure store key allows. */
export function dataViewKey(userId: string): string {
  return `townwise.dataView.${userId.replace(/[^A-Za-z0-9-]/g, '_')}`;
}

function parsed(raw: string | null): DataView {
  return raw === 'newest' ? 'newest' : 'organized';
}

/** The person's view and a setter that remembers it. */
export function useDataView(userId: string): [DataView, (view: DataView) => void] {
  const key = dataViewKey(userId);
  const [state, setState] = useState(() => ({ key, view: parsed(viewStore.readNow(key)), picked: false }));
  if (state.key !== key) setState({ key, view: parsed(viewStore.readNow(key)), picked: false });
  useEffect(() => {
    let live = true;
    void viewStore.read(key).then((raw) => {
      // A pick made before the read landed wins.
      if (live) setState((current) => (current.key !== key || current.picked ? current : { ...current, view: parsed(raw) }));
    });
    return () => { live = false; };
  }, [key]);
  const set = (view: DataView): void => {
    setState({ key, view, picked: true });
    viewStore.write(key, view);
  };
  return [state.view, set];
}
