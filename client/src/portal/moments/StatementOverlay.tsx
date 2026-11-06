import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, BackHandler, Easing, Platform, StyleSheet, Text, View, type TextStyle,
} from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Wrap } from '../ui/layout';
import { wordsOf, timeline, CLICK_WAIT_MS, GRACE_MS, type Timeline } from './timing';
import type { Statement } from './moments';
import { WordReveal } from './WordReveal';

// The statement layer (spec 15.8): the ground over the whole portal frame, the wordmark where the top bar draws it,
// and the statement flush left in the content column, revealed word by word, held, then dissolved onto the page.
//
// - It never takes focus and is hidden from assistive tech; the provider announces the statement once.
// - A press, touch or wheel is absorbed (it never reaches the page under the opaque layer) and fades the layer out;
//   once that press is over, the layer lets presses through. A key removes it at once and still does its job on the
//   page. On web a press is over when its click has landed on the layer (or CLICK_WAIT_MS after it lifts): a touch's
//   click is hit-tested when the finger lifts, so letting presses through on pointerdown would hand it to the control
//   underneath. The same hold keeps the layer in place through an automatic exit while a press is down on it.
//   Input in the first GRACE_MS of the timeline is ignored, so the press that sent a request can't end its moment.
// - Android back dismisses it and is consumed.
// - The motion variant is fixed when the timeline starts; a later change of the setting is ignored.

const [x1, y1, x2, y2] = theme.motion.easeOut;
const EASE_OUT = Easing.bezier(x1, y1, x2, y2);
const NATIVE_DRIVER = Platform.OS !== 'web';
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

export interface StatementOverlayProps {
  statement: Statement;
  /** Null: the ground only, the timeline not started (the setting is not known yet). */
  reduced: boolean | null;
  /** True: the ground only (a hidden tab). Defaults to false. */
  waiting?: boolean;
  /** The timeline started: announce, record. */
  onStart: () => void;
  /** The layer is gone. */
  onDone: () => void;
}

function lineStyle(width: number): TextStyle {
  if (width >= 1024) return theme.type.h2;
  return width > 640 ? theme.type.h2Tablet : theme.type.h2Phone;
}

const HIDDEN_FROM_ASSISTIVE_TECH = Platform.OS === 'web'
  ? { 'aria-hidden': true }
  : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

export function StatementOverlay(props: StatementOverlayProps): React.JSX.Element {
  const { statement, reduced } = props;
  const waiting = props.waiting === true;
  const { width } = useBreakpoint();
  const [plan, setPlan] = useState<Timeline | null>(null);
  /** Once the layer is leaving and no press holds it, presses reach the page. */
  const [exiting, setExiting] = useState(false);
  const [clock] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(1));
  const [words] = useState(() => ({ lead: wordsOf(statement.lead), follow: wordsOf(statement.follow) }));
  const callbacks = useRef({ onStart: props.onStart, onDone: props.onDone });
  useEffect(() => { callbacks.current = { onStart: props.onStart, onDone: props.onDone }; });
  /**
   * What the timers and listeners share; never read during render. `pressed` counts presses down on the layer (web);
   * `liftTimer` runs from the last one lifting until its click lands.
   */
  const run = useRef({
    startedAt: null as number | null, exiting: false, faded: false, done: false, exitMs: 0,
    exitTimer: null as ReturnType<typeof setTimeout> | null, pressed: 0, liftTimer: null as ReturnType<typeof setTimeout> | null,
  });

  // The timeline starts once the motion setting is known and the tab is visible (adjusting state while rendering, so
  // the words and the start are in one commit).
  if (plan === null && reduced !== null && !waiting) {
    setPlan(timeline(statement, reduced));
  }

  const finish = useCallback(() => {
    const state = run.current;
    if (state.done) return;
    state.done = true;
    if (state.exitTimer !== null) clearTimeout(state.exitTimer);
    if (state.liftTimer !== null) clearTimeout(state.liftTimer);
    callbacks.current.onDone();
  }, []);

  /** Once the layer is leaving and no press holds it: removed if faded, otherwise lets presses through. */
  const settle = useCallback(() => {
    const state = run.current;
    if (state.done || !state.exiting || state.pressed > 0 || state.liftTimer !== null) return;
    if (state.faded) finish();
    else setExiting(true);
  }, [finish]);

  const leave = useCallback(() => {
    const state = run.current;
    if (state.exiting || state.done) return;
    state.exiting = true;
    if (state.exitMs === 0) {
      state.faded = true;
    } else {
      Animated.timing(fade, { toValue: 0, duration: state.exitMs, easing: EASE_OUT, useNativeDriver: NATIVE_DRIVER }).start();
      state.exitTimer = setTimeout(() => {
        state.exitTimer = null;
        state.faded = true;
        settle();
      }, state.exitMs);
    }
    settle();
  }, [fade, settle]);

  /** Input counts only after the timeline started and its grace period passed. */
  const inputCounts = useCallback((): boolean => {
    const { startedAt } = run.current;
    return startedAt !== null && Date.now() - startedAt >= GRACE_MS;
  }, []);

  useEffect(() => {
    if (plan === null) return undefined;
    const state = run.current;
    state.startedAt = Date.now();
    state.exitMs = plan.exitMs;
    callbacks.current.onStart();
    const reveal = plan.revealEndMs > 0
      ? Animated.timing(clock, { toValue: plan.revealEndMs, duration: plan.revealEndMs, easing: (t: number) => t, useNativeDriver: NATIVE_DRIVER })
      : null;
    reveal?.start();
    const exitAt = setTimeout(leave, plan.exitAtMs);
    return () => {
      clearTimeout(exitAt);
      reveal?.stop();
    };
  }, [plan, clock, leave]);

  useEffect(() => () => {
    const { exitTimer, liftTimer } = run.current;
    if (exitTimer !== null) clearTimeout(exitTimer);
    if (liftTimer !== null) clearTimeout(liftTimer);
  }, []);

  // Web keyboard: any key but a repeat or a lone modifier removes the layer at once (nothing animates on keyboard
  // input). Passive, so the key still moves focus or activates the focused control on the page.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || MODIFIER_KEYS.has(event.key) || !inputCounts()) return;
      finish();
    };
    window.addEventListener('keydown', onKey, { passive: true });
    return () => { window.removeEventListener('keydown', onKey); };
  }, [finish, inputCounts]);

  // Android back: dismisses and is consumed while the layer is up.
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (run.current.startedAt !== null) leave();
      return true;
    });
    return () => { subscription.remove(); };
  }, [leave]);

  // Web: the end of a press on the layer, heard on window so a press released anywhere still ends. Its click ends the
  // hold (bubbling, so after it has reached the layer); a lift waits CLICK_WAIT_MS for that click; a cancel (a scroll
  // took over) sends none.
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const state = run.current;
    const release = (): void => {
      if (state.liftTimer !== null) clearTimeout(state.liftTimer);
      state.liftTimer = null;
      settle();
    };
    const onUp = (event: Event): void => {
      if (state.pressed === 0) return;
      state.pressed -= 1;
      if (state.pressed > 0) return;
      if (event.type === 'pointercancel') {
        release();
        return;
      }
      if (state.liftTimer !== null) clearTimeout(state.liftTimer);
      state.liftTimer = setTimeout(release, CLICK_WAIT_MS);
    };
    const onClick = (): void => {
      if (state.pressed === 0 && state.liftTimer === null) return;
      state.pressed = 0;
      release();
    };
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('click', onClick);
    };
  }, [settle]);

  // Web wheel: react-native-web forwards no onWheel, so it is a DOM listener on the layer.
  const surface = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = surface.current as unknown as HTMLElement | null;
    if (node === null) return undefined;
    const onWheel = (): void => { if (inputCounts()) leave(); };
    node.addEventListener('wheel', onWheel, { passive: true });
    return () => { node.removeEventListener('wheel', onWheel); };
  }, [inputCounts, leave]);

  const onPress = (): void => {
    if (inputCounts()) leave();
  };
  const pressProps = Platform.OS === 'web'
    ? {
      // Every press down on the layer holds it, a press in the grace period too.
      onPointerDown: () => {
        const state = run.current;
        state.pressed += 1;
        if (state.liftTimer !== null) clearTimeout(state.liftTimer);
        state.liftTimer = null;
        onPress();
      },
      // Keeps focus where the page put it: a press on a plain element would otherwise blur it.
      onMouseDown: (event: { preventDefault: () => void }) => { event.preventDefault(); },
    }
    : { onTouchStart: onPress };

  const type = lineStyle(width);
  const shown = plan !== null;
  const motion = plan !== null && plan.revealEndMs > 0 ? clock : null;
  return (
    <Animated.View
      {...HIDDEN_FROM_ASSISTIVE_TECH}
      {...pressProps}
      testID="statement-layer"
      style={[StyleSheet.absoluteFill, styles.layer, { opacity: fade, pointerEvents: exiting ? 'none' : 'auto' }]}
    >
      <View ref={surface} style={styles.surface}>
        <Wrap>
          {/* Must match TopBar.tsx: styles.row minHeight 64 and styles.wordmark. */}
          <View style={styles.bar}>
            <Text style={styles.wordmark}>Townwise</Text>
          </View>
        </Wrap>
        <View style={styles.middle}>
          <Wrap>
            <View style={[styles.block, shown ? null : styles.unshown]}>
              <WordReveal words={words.lead} delays={plan?.lead ?? []} clock={motion} style={{ ...type, color: theme.color.white }} />
              <View style={styles.followGap} />
              <WordReveal words={words.follow} delays={plan?.follow ?? []} clock={motion} style={{ ...type, color: theme.color.text2 }} />
            </View>
          </Wrap>
        </View>
      </View>
    </Animated.View>
  );
}

const c = theme.color;
/** The top bar's row height (TopBar.tsx styles.row). */
const BAR_HEIGHT = 64;

const styles = StyleSheet.create({
  layer: { backgroundColor: c.ground, zIndex: 10 },
  surface: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: BAR_HEIGHT },
  // Must match TopBar.tsx styles.wordmark (its Link's text decoration aside).
  wordmark: { ...theme.type.wordmark, color: c.white, minHeight: 44, lineHeight: 44 },
  // Centered in the whole layer: the padding below balances the bar above.
  middle: { flex: 1, justifyContent: 'center', paddingBottom: BAR_HEIGHT },
  block: { maxWidth: 760 },
  unshown: { opacity: 0 },
  followGap: { height: theme.space[3] },
});
