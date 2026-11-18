import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { useOptionalPortal } from '../PortalProvider';
import type { MeResponse } from '../schemas';
import { momentFor, spokenStatement, type MomentKind, type Statement } from './moments';
import { useToast } from '../ui/toast';
import { StatementOverlay } from './StatementOverlay';

// The one player of statement moments (spec 15.8). It plays one at a time, a play while one is up is dropped, and
// it says the whole statement once: on web through a polite live region that exists before any moment, on
// native through announceForAccessibility. On native with a screen reader running there are no visuals at all: the
// statement is announced and the moment ends at once, since an opaque layer would catch VoiceOver's activation.
// On web, a moment that would start in a hidden tab keeps its ground up and waits until the tab is visible.
//
// Under the portal (PortalGate mounts it once GET /api/me has answered) it also decides the two named moments from
// each new access answer (moments.ts momentFor), during render, so the layer and `playing: true` are in the same
// commit as the answer: the welcome covers the first page before it paints, and request received covers the
// redirect to Waiting. A decided moment is marked played when it starts, so it plays once in this session; the
// welcome also posts /api/me/welcome then (once, errors swallowed), after which the server answers welcome null on
// every device. Nothing is decided under view-as, and nothing is stored on the device.
//
// It always renders {children}{overlay}{live region} in that order, so the children never remount. Each play has its
// own id, the overlay's key, so a moment that follows another in the same commit starts fresh instead of keeping the
// last one's words and finished timeline.

export interface MomentApi {
  /** True from the commit a moment is decided until its layer is gone (native with a screen reader: announced). */
  playing: boolean;
  /** Plays a statement now unless one is playing (then it is dropped). */
  play: (statement: Statement) => void;
}

/** The moment up now. `id` keys its overlay; `key` and `kind` are set for a moment decided from GET /api/me. */
interface Playing {
  statement: Statement;
  id: string;
  key: string | null;
  kind: MomentKind | null;
}

const OUTSIDE: MomentApi = { playing: false, play: () => undefined };
const MomentContext = createContext<MomentApi>(OUTSIDE);

/** The moment player; outside a MomentProvider, `{ playing: false, play: no-op }`. */
export function useMoment(): MomentApi {
  return useContext(MomentContext);
}

function subscribeVisibility(onChange: () => void): () => void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', onChange);
  return () => { document.removeEventListener('visibilitychange', onChange); };
}

function tabHidden(): boolean {
  return Platform.OS === 'web' && typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Web: false. Native: null until the system answers, then whether a screen reader is running, kept current. */
function useScreenReader(): boolean | null {
  const [running, setRunning] = useState<boolean | null>(Platform.OS === 'web' ? false : null);
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let live = true;
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', (value) => { setRunning(value); });
    AccessibilityInfo.isScreenReaderEnabled().then(
      (value) => { if (live) setRunning((current) => current ?? value); },
      () => { if (live) setRunning((current) => current ?? false); },
    );
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return running;
}

/** Native with a screen reader: no layer; announce, then end at once. */
function AnnounceOnly(props: { onStart: () => void; onDone: () => void }): null {
  const { onStart, onDone } = props;
  useEffect(() => {
    onStart();
    onDone();
  }, [onStart, onDone]);
  return null;
}

export function MomentProvider(props: { children: React.ReactNode }): React.JSX.Element {
  const reduced = useReducedMotion();
  const screenReader = useScreenReader();
  const hidden = useSyncExternalStore(subscribeVisibility, tabHidden, () => false);
  const portal = useOptionalPortal();
  const me = portal?.me ?? null;
  const portalApi = portal?.api ?? null;
  const [current, setCurrent] = useState<Playing | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [lastMe, setLastMe] = useState<MeResponse | null>(null);
  const [played, setPlayed] = useState<ReadonlySet<string>>(() => new Set());
  const plays = useRef(0);
  /** The welcomes posted in this session: one attempt each, whatever re-runs a start. */
  const posted = useRef(new Set<string>());

  // A new access answer: decide during render (adjusting state when a prop changes). One moment at a time, so a
  // decision while one is up is dropped.
  if (me !== lastMe) {
    setLastMe(me);
    const decided = me === null ? null : momentFor(lastMe, me, played);
    if (decided !== null && current === null) {
      setCurrent({ statement: decided.statement, id: decided.key, key: decided.key, kind: decided.kind });
    }
  }

  const play = useCallback((statement: Statement) => {
    plays.current += 1;
    const id = `play:${String(plays.current)}`;
    setCurrent((playing) => playing ?? { statement, id, key: null, kind: null });
  }, []);

  const onStart = useCallback(() => {
    if (current === null) return;
    const text = spokenStatement(current.statement);
    if (Platform.OS === 'web') setAnnouncement(text);
    else AccessibilityInfo.announceForAccessibility(text);
    const { key, kind } = current;
    if (key === null) return;
    setPlayed((seen) => (seen.has(key) ? seen : new Set(seen).add(key)));
    if (kind === 'welcome' && portalApi !== null && !posted.current.has(key)) {
      posted.current.add(key);
      portalApi.request('/api/me/welcome', { method: 'POST' }).catch(() => undefined);
    }
  }, [current, portalApi]);

  const onDone = useCallback(() => {
    setCurrent(null);
    setAnnouncement('');
  }, []);

  const moment = useMemo<MomentApi>(() => ({ playing: current !== null, play }), [current, play]);

  // Toasts wait while a moment covers the frame (ui/toast.tsx), so "You joined {org}." never draws over the welcome.
  // A layout effect, so the hold is in place before the frame with the layer is painted.
  const holdToasts = useToast()?.hold;
  const playing = current !== null;
  useLayoutEffect(() => {
    if (!playing) return undefined;
    holdToasts?.(true);
    return () => { holdToasts?.(false); };
  }, [playing, holdToasts]);

  let overlay: React.ReactNode = null;
  if (current !== null) {
    overlay = screenReader === true
      ? <AnnounceOnly key={current.id} onStart={onStart} onDone={onDone} />
      : (
        <StatementOverlay
          key={current.id}
          statement={current.statement}
          reduced={screenReader === null ? null : reduced}
          waiting={hidden}
          onStart={onStart}
          onDone={onDone}
        />
      );
  }
  return (
    <MomentContext.Provider value={moment}>
      {props.children}
      {overlay}
      {Platform.OS === 'web' ? (
        // aria-live without role="status": the region sits around every portal page, so it must not compete with a
        // page's own status notice for that role.
        <View aria-live="polite" testID="moment-live-region" style={styles.unseen}>
          {announcement === '' ? null : <Text>{announcement}</Text>}
        </View>
      ) : null}
    </MomentContext.Provider>
  );
}

const styles = StyleSheet.create({
  unseen: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
