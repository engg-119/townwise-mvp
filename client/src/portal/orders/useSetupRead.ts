import { useEffect, useRef, useState } from 'react';

import { usePortal } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { readSetupWithAi, type SetupRead as SetupReadAnswer, type SetupReadSource } from './api';
import { importProposal, type ProposalImport, type ReadFrom } from './proposal';
import type { ReadSlot } from './SetupEditor';
import { onlyLinks, READ_COPY, readError } from './setupReadWords';

// Reading the ordering setup with TownwiseAI (D41, P31), shared by the web (SetupRead.web.tsx) and the native apps
// (SetupRead.tsx): the chosen file, the pasted text, what the section shows, and one read at a time. Each platform
// chooses the file and turns it into what is sent (`build`); this sends it once, merges the answer into the unsaved
// draft, and holds an answer that comes while the editor is locked until the lock lifts, so a save never drops it.
// Cancel stops the request and nothing is added. Nothing here logs or keeps the file or text.

export type Shown =
  | { kind: 'idle' }
  | { kind: 'refused'; message: string }
  | { kind: 'reading'; from: ReadFrom }
  | { kind: 'done'; from: ReadFrom; result: ProposalImport }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' };

/** What a platform sends for the chosen file, or why it couldn't, in words. */
export type Built = SetupReadSource | { problem: string };

export interface SetupReading<F> {
  readonly file: F | null;
  readonly setFile: (file: F | null) => void;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly shown: Shown;
  readonly reading: boolean;
  /** Chooses `file` and clears what was shown. */
  readonly choose: (file: F) => void;
  readonly refuse: (message: string) => void;
  /** Sends what `build` resolves, once; `current` says whether this read is still the one shown. */
  readonly start: (from: ReadFrom, build: (current: () => boolean) => Promise<Built>) => Promise<void>;
  readonly readText: () => void;
  readonly cancel: () => void;
}

export function useSetupRead<F>(props: ReadSlot): SetupReading<F> {
  const { api } = usePortal();
  const { location } = useLocation();
  const latest = useRef(props.draft);
  const run = useRef(0);
  const stop = useRef<AbortController | null>(null);
  const locked = useRef(props.locked);
  /** An answer that came while the editor was locked, merged once it isn't. */
  const held = useRef<{ answer: SetupReadAnswer; from: ReadFrom } | null>(null);
  const [file, setFile] = useState<F | null>(null);
  const [text, setText] = useState('');
  const [shown, setShown] = useState<Shown>({ kind: 'idle' });
  const reading = shown.kind === 'reading';

  useEffect(() => { latest.current = props.draft; }, [props.draft]);
  // After every render, so it sees the draft a save left (the effect above runs first).
  useEffect(() => {
    locked.current = props.locked;
    const waiting = held.current;
    if (props.locked || waiting === null) return;
    held.current = null;
    land(waiting.answer, waiting.from);
  });
  useEffect(() => () => {
    run.current += 1;
    stop.current?.abort();
  }, []);

  function land(answer: SetupReadAnswer, from: ReadFrom): void {
    const result = importProposal(answer, latest.current, from);
    props.apply(result);
    if (from === 'file') setFile(null);
    else setText('');
    setShown({ kind: 'done', from, result });
  }

  async function start(from: ReadFrom, build: (current: () => boolean) => Promise<Built>): Promise<void> {
    if (props.locked || reading) return;
    run.current += 1;
    const mine = run.current;
    const current = (): boolean => run.current === mine;
    const controller = new AbortController();
    stop.current = controller;
    setShown({ kind: 'reading', from });
    try {
      const source = await build(current);
      if (!current()) return;
      if ('problem' in source) {
        setShown({ kind: 'failed', message: source.problem });
        return;
      }
      const answer = await readSetupWithAi(api, location.id, source, controller.signal);
      if (!current()) return;
      if (locked.current) held.current = { answer, from };
      else land(answer, from);
    } catch (error) {
      if (current()) setShown({ kind: 'failed', message: readError(error) });
    } finally {
      if (stop.current === controller) stop.current = null;
    }
  }

  function readText(): void {
    if (props.locked || reading) return;
    if (onlyLinks(text)) {
      setShown({ kind: 'refused', message: READ_COPY.link });
      return;
    }
    void start('text', () => Promise.resolve({ type: 'text', text }));
  }

  function cancel(): void {
    run.current += 1;
    held.current = null;
    stop.current?.abort();
    stop.current = null;
    setShown({ kind: 'stopped' });
  }

  return {
    file,
    setFile,
    text,
    setText,
    shown,
    reading,
    choose: (next) => {
      setFile(next);
      setShown({ kind: 'idle' });
    },
    refuse: (message) => { setShown({ kind: 'refused', message }); },
    start,
    readText,
    cancel,
  };
}
