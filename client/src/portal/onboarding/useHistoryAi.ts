import { useEffect, useRef, useState } from 'react';

import { cantReadLine, optInLine, type OptInState } from '../data/aiCopy';
import { readWithAi } from '../data/api';
import { hasCode } from '../errors';
import type { FileView } from '../files/api';
import type { QueuedUpload } from '../files/uploadQueue';
import { usePortal } from '../PortalProvider';
import { aiRefOf } from './history';

// The TownwiseAI opt-in under step 3's drop (D34, spec 11A.9), off by default, as under Your data's Add a file
// (data/AddFile.tsx): a file that finishes uploading while the box is checked is sent once to TownwiseAI to read,
// unless TownwiseAI can't read its kind; one that finished while it was unchecked never is. A dropped file is read for
// sales first, and asking before that is done answers 400, so each one waits until the import's status read (the
// step's one poller, files/useImport) lists it read, kept or failed, then asks through its Your data item (aiRefOf).
// How each went shows on its row, and a refusal never undoes the upload. The box hides once a request answers 503
// ai_unavailable, for as long as the step is open.

/** A file this screen uploaded with the box checked: its stored file, the item asked through, and how it went. */
interface Asked {
  fileId: string;
  /** Set once the sales reader is done with the file. */
  ref: string | null;
  ai: OptInState | { state: 'waiting' };
}

export interface HistoryAi {
  optIn: boolean;
  setOptIn: (next: boolean) => void;
  /** A request answered 503 ai_unavailable: the box is hidden. */
  off: boolean;
  /** Each asked file's line, by its stored file's id: none while it waits for the sales reader, or never sent. */
  lines: ReadonlyMap<string, string>;
}

/** `files`: the files of the import the step shows, as the server last listed them. */
export function useHistoryAi(locationId: string, items: readonly QueuedUpload[], files: readonly FileView[]): HistoryAi {
  const { api } = usePortal();
  const [optIn, setOptIn] = useState(false);
  const [off, setOff] = useState(false);
  // Each finished upload, by its queue key, once looked at: null when it finished with the box unchecked (never sent).
  const [asked, setAsked] = useState<Readonly<Record<string, Asked | null>>>({});
  const fresh = items.filter((item) => item.state === 'done' && item.fileId !== null && !Object.hasOwn(asked, item.key));
  const byId = new Map(files.map((file) => [file.id, file]));
  const ready: [key: string, ref: string][] = [];
  for (const [key, entry] of Object.entries(asked)) {
    const file = entry?.ai.state === 'waiting' ? byId.get(entry.fileId) : undefined;
    const ref = file === undefined ? null : aiRefOf(file);
    if (ref !== null) ready.push([key, ref]);
  }
  if (fresh.length > 0 || ready.length > 0) {
    setAsked((current) => {
      const next = { ...current };
      for (const item of fresh) {
        if (!optIn || off || item.fileId === null) {
          next[item.key] = null;
          continue;
        }
        const why = item.file === null ? null : cantReadLine({ kind: item.file.kind, name: item.file.name ?? item.name });
        next[item.key] = { fileId: item.fileId, ref: null, ai: why === null ? { state: 'waiting' } : { state: 'not_read', why } };
      }
      for (const [key, ref] of ready) {
        const entry = next[key];
        if (entry?.ai.state === 'waiting') next[key] = { ...entry, ref, ai: { state: 'asking' } };
      }
      return next;
    });
  }
  // Each file marked `asking` is sent once.
  const sent = useRef(new Set<string>());
  useEffect(() => {
    const mark = (key: string, entry: Asked, ai: OptInState): void => { setAsked((current) => ({ ...current, [key]: { ...entry, ai } })); };
    for (const [key, entry] of Object.entries(asked)) {
      if (entry?.ai.state !== 'asking' || entry.ref === null || sent.current.has(key)) continue;
      sent.current.add(key);
      readWithAi(api, locationId, entry.ref).then(
        () => { mark(key, entry, { state: 'asked' }); },
        (error: unknown) => {
          if (hasCode(error, 409, 'ai_read_running')) {
            mark(key, entry, { state: 'asked' });
            return;
          }
          if (hasCode(error, 503, 'ai_unavailable')) {
            setOff(true);
            setOptIn(false);
          }
          mark(key, entry, { state: 'refused', error });
        },
      );
    }
  }, [asked, api, locationId]);

  const lines = new Map<string, string>();
  for (const entry of Object.values(asked)) {
    if (entry !== null && entry.ai.state !== 'waiting') lines.set(entry.fileId, optInLine(entry.ai));
  }
  return { optIn, setOptIn, off, lines };
}
