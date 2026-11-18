import { useEffect, useState } from 'react';

// Whether a reply's "Working for" / "Worked for" timeline is open (owner request, 2026-11-17: closed on a new prompt,
// the person opens it). The choice is kept outside the reply, in a store the chat page makes once (AgentChat), so it
// outlives the reply ending, the reply being read again after its turn (with new keys) and the page following the
// turn again: by the reply's key and by its node ids. A reply nothing is stored for is closed. A new page starts
// with none, as its keys start again.

export interface WorkedOpen {
  get: (key: string, nodes: readonly (string | null)[]) => boolean;
  set: (key: string, nodes: readonly (string | null)[], open: boolean) => void;
}

export function workedOpenStore(): WorkedOpen {
  const byKey = new Map<string, boolean>();
  const byNode = new Map<string, boolean>();
  return {
    get: (key, nodes) => {
      const local = byKey.get(key);
      if (local !== undefined) return local;
      for (const node of nodes) {
        const value = node === null ? undefined : byNode.get(node);
        if (value !== undefined) return value;
      }
      return false;
    },
    set: (key, nodes, open) => {
      byKey.set(key, open);
      for (const node of nodes) if (node !== null) byNode.set(node, open);
    },
  };
}

/**
 * A reply's open state from `store`, read once when the reply mounts. Each change, and each id the reply gains (its
 * node once its turn is saved), is written back under every id, so a later mount by any of them reads the same.
 */
export function useWorkedOpen(store: WorkedOpen, key: string, nodes: readonly (string | null)[]): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => store.get(key, nodes));
  const ids = nodes.join(' ');
  useEffect(() => {
    store.set(key, ids.split(' ').map((node) => (node === '' ? null : node)), open);
  }, [store, key, ids, open]);
  return [open, setOpen];
}
