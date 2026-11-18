import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'expo-router';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { inlineTarget } from './text';

// Toasts (spec 15.7, D55): what an action the person just took did ("Saved.", "Deleted the note."), at the bottom of
// the window, over the page, on every signed-in screen. <ToastHost> is mounted once, around the portal
// (app/(gate)/(app)/_layout.tsx); a <Notice> under it shows here and draws no row in the page (ui/feedback.tsx).
// Errors, and anything the person has to read to fix something, never come here: they stay in the page.
//
// - One polite live region, there before the first toast, so a screen reader says each one as it arrives; iOS is
//   told too, since the toast arrives away from focus. A toast never takes focus.
// - Each leaves by itself: 6 seconds, 10 with a link. The time waits while the pointer is over it or focus is in
//   it, and starts over after. Its Dismiss button, or Escape with focus in it, takes it away at once.
// - The newest is on top. Three show at most; the rest wait, and each waiting one gets its full time once it shows.
// - The same words again within a second are ignored (a double effect, a double press). The same words again while
//   their toast is still up keep the one toast and start its time over, so two identical toasts never stack.
// - It slides up 8px and fades in over `fade`; with reduced motion, or before native has answered what the setting
//   is, it is simply there. Nothing animates on the way out.
// - It is drawn in the page's own layer, so it is under an open dialog or popover (each a Modal). A result that
//   arrives while a popover stays open stays a line in that popover.

export interface ToastLink { label: string; href: string }

export interface ToastNotice {
  text: string;
  /** A link after the text, ended with a full stop. */
  link?: ToastLink;
}

interface Toast extends ToastNotice {
  id: number;
  /** Counts the times its words changed or came again; each starts its time over and has it said again. */
  version: number;
}

export interface ToastApi {
  /**
   * Shows a toast and returns its id. `replaces`: the toast this one takes the place of while that one is still up,
   * for a notice whose words change ("Saved." and then what the save did). `result`: the action result the words
   * are for; one result's words are shown once, however often they are offered (a notice that mounts again), and
   * again only when they change.
   */
  show: (notice: ToastNotice, from?: { replaces?: number; result?: object }) => number;
}

const ToastContext = createContext<ToastApi | null>(null);

/** The toast host around this component, or null where none is mounted (a component rendered alone in a test). */
export function useToast(): ToastApi | null {
  return useContext(ToastContext);
}

const MAX_SHOWN = 3;
const SHOWN_MS = 6000;
const SHOWN_WITH_LINK_MS = 10000;
const REPEAT_MS = 1000;
/** On the screens that fill the window (TownwiseAI), the toasts sit above the composer docked at its bottom. */
const RAISED = 144;
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

const [x1, y1, x2, y2] = theme.motion.easeOut;
const EASE_OUT = Easing.bezier(x1, y1, x2, y2);

// `role="status"` is atomic unless told otherwise: every toast up would be read again with each new one. Web only,
// and by the older name: react-native-web 0.21 drops `aria-atomic` (createDOMProps reads the wrong variable).
const NOT_ATOMIC = Platform.OS === 'web' ? ({ accessibilityAtomic: false } as object) : {};

function sameNotice(a: ToastNotice, b: ToastNotice): boolean {
  return a.text === b.text && a.link?.href === b.link?.href && a.link?.label === b.link?.label;
}

export function ToastHost(props: { children: React.ReactNode; raised?: boolean }): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  // The list as the last show or dismiss left it: show answers with an id before the next render.
  const list = useRef<readonly Toast[]>([]);
  const nextId = useRef(1);
  const last = useRef<{ id: number; notice: ToastNotice; at: number } | null>(null);
  /** What was last shown for each result. */
  const [results] = useState(() => new WeakMap<object, ToastNotice>());
  // Outside a SafeAreaProvider (a unit test) there are no insets.
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  const reduced = useReducedMotion() !== false;

  const commit = useCallback((next: readonly Toast[]) => {
    list.current = next;
    setToasts(next);
  }, []);

  const show = useCallback<ToastApi['show']>((notice, from) => {
    if (from?.result !== undefined) {
      const before = results.get(from.result);
      if (before !== undefined && sameNotice(before, notice)) return from.replaces ?? 0;
      results.set(from.result, notice);
    }
    const now = Date.now();
    const recent = last.current;
    if (recent !== null && now - recent.at < REPEAT_MS && sameNotice(recent.notice, notice)) return recent.id;
    const replaced = from?.replaces === undefined ? undefined : list.current.find((toast) => toast.id === from.replaces);
    const up = replaced ?? list.current.find((toast) => sameNotice(toast, notice));
    const id = up?.id ?? nextId.current;
    if (up === undefined) {
      nextId.current += 1;
      commit([...list.current, { ...notice, id, version: 0 }]);
    } else {
      commit(list.current.map((toast) => (toast === up ? { ...notice, id, version: up.version + 1 } : toast)));
    }
    last.current = { id, notice, at: now };
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(notice.text);
    return id;
  }, [commit, results]);

  const dismiss = useCallback((id: number) => {
    commit(list.current.filter((toast) => toast.id !== id));
  }, [commit]);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);
  const bottom = insets.bottom + theme.space[6] + (props.raised === true ? RAISED : 0);
  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <View testID="toasts" role="status" aria-live="polite" {...NOT_ATOMIC} style={[styles.region, { bottom }]}>
        {toasts.slice(0, MAX_SHOWN).reverse().map((toast) => (
          <ToastCard key={toast.id} toast={toast} reduced={reduced} onDismiss={dismiss} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

function ToastCard(props: { toast: Toast; reduced: boolean; onDismiss: (id: number) => void }): React.JSX.Element {
  const { toast, onDismiss } = props;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // The motion setting as the toast arrived; a later change is ignored.
  const [still] = useState(props.reduced);
  const [enter] = useState(() => new Animated.Value(still ? 1 : 0));
  useEffect(() => {
    if (still) return;
    Animated.timing(enter, { toValue: 1, duration: theme.motion.fade, easing: EASE_OUT, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [enter, still]);

  const held = hovered || focused;
  const linked = toast.link !== undefined;
  useEffect(() => {
    if (held) return undefined;
    const timer = setTimeout(() => { onDismiss(toast.id); }, linked ? SHOWN_WITH_LINK_MS : SHOWN_MS);
    return () => { clearTimeout(timer); };
  }, [held, linked, toast.id, toast.version, onDismiss]);

  // React Native types these props with its own events; on web react-native-web hands over the DOM's.
  const web = Platform.OS !== 'web' ? {} : ({
    onMouseEnter: () => { setHovered(true); },
    onMouseLeave: () => { setHovered(false); },
    onFocus: () => { setFocused(true); },
    onBlur: () => { setFocused(false); },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { if (event.key === 'Escape') onDismiss(toast.id); },
  } as object);
  const motion = still ? null : { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] };
  return (
    <Animated.View testID="toast" {...web} style={[styles.card, motion]}>
      {/* A new key when the words come again, so the live region says them again. */}
      <Text key={toast.version} testID="toast-text" style={styles.text}>
        {toast.text}
        {toast.link === undefined ? null : (
          <>
            {' '}
            <Link href={toast.link.href} style={styles.link}>{toast.link.label}</Link>
            .
          </>
        )}
      </Text>
      <Pressable role="button" aria-label="Dismiss" onPress={() => { onDismiss(toast.id); }} style={styles.dismiss}>
        <Text aria-hidden style={styles.cross}>×</Text>
      </Pressable>
    </Animated.View>
  );
}

const c = theme.color;

// Over the page wherever it has scrolled: fixed to the window on web, to the screen's own box on native.
// React Native's types have no `fixed`; react-native-web passes it on.
const PINNED = (Platform.OS === 'web' ? 'fixed' : 'absolute') as 'absolute';

const styles = StyleSheet.create({
  // box-none: a press beside or between the toasts reaches the page under them.
  region: {
    position: PINNED, left: 0, right: 0, zIndex: 30, alignItems: 'center', rowGap: theme.space[2],
    paddingHorizontal: theme.space.gutterPhone, pointerEvents: 'box-none',
  },
  card: {
    width: '100%', maxWidth: 480, minHeight: 44, flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.raised, borderWidth: 1, borderColor: c.border, borderRadius: 0, boxShadow: `0 12px 32px ${c.shadow}`,
  },
  text: { ...theme.type.small, color: c.white, flex: 1, minWidth: 0, paddingVertical: theme.space[3], paddingLeft: theme.space[4] },
  link: { ...inlineTarget, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  dismiss: { width: 44, minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  cross: { ...theme.type.sub, color: c.text2 },
});
