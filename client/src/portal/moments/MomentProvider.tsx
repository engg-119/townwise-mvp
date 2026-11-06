import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { spokenStatement, type Statement } from './moments';
import { StatementOverlay } from './StatementOverlay';

// The one player of statement moments (spec 15.8). It plays one at a time, a play while one is up is dropped, and
// it says the whole statement once: on web through a polite status region that exists before any moment, on
// native through announceForAccessibility. On native with a screen reader running there are no visuals at all: the
// statement is announced and the moment ends at once, since an opaque layer would catch VoiceOver's activation.
// On web, a moment that would start in a hidden tab keeps its ground up and waits until the tab is visible.
//
// It always renders {children}{overlay}{live region} in that order, so the children never remount.

export interface MomentApi {
  /** True from the commit a moment is decided until its layer is gone (native with a screen reader: announced). */
  playing: boolean;
  /** Plays a statement now unless one is playing (then it is dropped). */
  play: (statement: Statement) => void;
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
  const [current, setCurrent] = useState<Statement | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const play = useCallback((statement: Statement) => {
    setCurrent((playing) => playing ?? statement);
  }, []);

  const onStart = useCallback(() => {
    if (current === null) return;
    const text = spokenStatement(current);
    if (Platform.OS === 'web') setAnnouncement(text);
    else AccessibilityInfo.announceForAccessibility(text);
  }, [current]);

  const onDone = useCallback(() => {
    setCurrent(null);
    setAnnouncement('');
  }, []);

  const api = useMemo<MomentApi>(() => ({ playing: current !== null, play }), [current, play]);

  let overlay: React.ReactNode = null;
  if (current !== null) {
    overlay = screenReader === true
      ? <AnnounceOnly onStart={onStart} onDone={onDone} />
      : (
        <StatementOverlay
          statement={current}
          reduced={screenReader === null ? null : reduced}
          waiting={hidden}
          onStart={onStart}
          onDone={onDone}
        />
      );
  }
  return (
    <MomentContext.Provider value={api}>
      {props.children}
      {overlay}
      {Platform.OS === 'web' ? (
        <View role="status" aria-live="polite" style={styles.unseen}>
          {announcement === '' ? null : <Text>{announcement}</Text>}
        </View>
      ) : null}
    </MomentContext.Provider>
  );
}

const styles = StyleSheet.create({
  unseen: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
