import { useContext, useEffect, useState } from 'react';
import { Keyboard, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View, type MeasureInWindowOnSuccessCallback } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { theme } from '../../theme';
import { Button } from './Button';
import { Heading } from './text';

// The popover (spec 15.7, refine-calendar-and-home design decision 1), one file for web and native: a card that floats
// over the page, anchored to the button that opened it, so nothing under it moves. It is React Native's Modal,
// transparent and with no animation, as ConfirmDialog's: on web react-native-web traps focus in it, focusing its first
// control on open (the card comes before the backdrop, so that control is the card's), Escape closes it, and focus
// returns to the opener on close; on Android the back button closes it. The card is `role="dialog"` named by its heading,
// a `panel` fill with a 1px `border` outline, the `shadow` token, square, 16px padding, its content scrolling inside it.
// The backdrop under it is transparent and is neither a tab stop nor a screen reader stop (a plain View, never a
// Pressable, which is always focusable on web); it takes presses and closes the popover only where the popover allows
// that. Placement (placePopover) is measured on open, on every window size change and every keyboard show or hide: from
// 641px wide the card opens 8px under its opener, or 8px above it when the room below is short, edge-aligned with it;
// below 641px it is pinned to the top of the window, since its text fields would sit under the keyboard lower down. The
// window's bottom is the keyboard's top while it shows, so the card never runs under it. `busy` holds it open (Close
// disabled in place, Escape, back and outside presses doing nothing) while an action runs, so its answer always lands
// in the open popover. Nothing animates.

/** The opener's box in window coordinates, from its measureInWindow. */
export interface PopoverRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The window: its size, and the band a card may use, between the safe area's top and the keyboard's top or the bottom. */
export interface PopoverWindow {
  width: number;
  height: number;
  /** The usable top: the safe area's top inset (0 on web). */
  top: number;
  /** The usable bottom: the keyboard's top while it shows, else the window's bottom less its safe area. */
  bottom: number;
}

/** Where the card goes: its width, left edge and tallest height, and its top, or its bottom when it opens above. */
export type PopoverPlacement = { width: number; left: number; maxHeight: number } & ({ top: number } | { bottom: number });

/** From this width the card is anchored to its opener; below it, pinned to the top of the window. */
const ANCHORED_FROM = 641;
/** Between the opener and the card. */
const GAP = 8;
/** From every window edge. */
const MARGIN = 16;
/** The room under the opener that is always enough to open below it. */
const ROOM = 320;

/**
 * The card's place. From 641px, with the opener measured: below it by 8px when the room below (to the usable bottom)
 * is at least 320px or at least the room above, else above it by 8px; at most that room less 24px tall (the gap and a
 * 16px margin); its right edge on the opener's when the opener's center is in the window's right half, else its left
 * edge on the opener's; at least 16px from either window edge, and at most `min(maxWidth, window width - 32)` wide.
 * Below 641px, or before the opener is measured, it is pinned 16px from the usable top and either side, at most the
 * usable height less 32px tall; below 641px it is the window's width less 32px.
 */
export function placePopover(anchor: PopoverRect | null, window: PopoverWindow, maxWidth: number): PopoverPlacement {
  const anchored = window.width >= ANCHORED_FROM;
  const width = anchored ? Math.min(maxWidth, window.width - 2 * MARGIN) : window.width - 2 * MARGIN;
  if (!anchored || anchor === null) {
    return { width, left: MARGIN, top: window.top + MARGIN, maxHeight: Math.max(0, window.bottom - window.top - 2 * MARGIN) };
  }
  const right = anchor.x + anchor.width / 2 > window.width / 2;
  const aligned = right ? anchor.x + anchor.width - width : anchor.x;
  const left = Math.min(Math.max(aligned, MARGIN), window.width - MARGIN - width);
  const below = window.bottom - (anchor.y + anchor.height);
  const above = anchor.y - window.top;
  if (below >= ROOM || below >= above) {
    return { width, left, top: anchor.y + anchor.height + GAP, maxHeight: Math.max(0, below - GAP - MARGIN) };
  }
  return { width, left, bottom: window.height - anchor.y + GAP, maxHeight: Math.max(0, above - GAP - MARGIN) };
}

/** What a popover's anchor must have: a host view (a Button's `ref`), measured in window coordinates. */
export interface PopoverAnchor {
  readonly current: { measureInWindow: (callback: MeasureInWindowOnSuccessCallback) => void } | null;
}

export interface PopoverProps {
  visible: boolean;
  /** The button that opened it, which places it from 641px. */
  anchor: PopoverAnchor;
  /** The heading's words, which also name the dialog. */
  label: string;
  /** The card's id (nativeID), which the opener's aria-controls names while it is open (web). */
  nativeID?: string;
  /** The card's widest, before the window's width less 32px caps it. */
  maxWidth: number;
  /** Whether a press outside the card closes it. */
  dismissOnOutsidePress: boolean;
  /** A "Close" text button beside the heading. */
  closeButton?: boolean;
  /** While an action runs: Close is disabled in place, and Escape, Android's back button and a press outside do nothing. */
  busy?: boolean;
  /** Close, Escape (web), the back button (Android) and, where allowed, a press outside. */
  onClose: () => void;
  /**
   * Once the popover has gone, after it returned focus to its opener (web): for an outcome that took the opener away,
   * so focus can move elsewhere. iOS also calls it; Android does not.
   */
  onDismiss?: () => void;
  children: React.ReactNode;
}

export function Popover(props: PopoverProps): React.JSX.Element {
  const busy = props.busy === true;
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="none"
      // Android: the card is placed in the same window coordinates its opener is measured in.
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => { if (!busy) props.onClose(); }}
      {...(props.onDismiss === undefined ? {} : { onDismiss: props.onDismiss })}
    >
      {props.visible ? <Card {...props} /> : null}
    </Modal>
  );
}

/**
 * The keyboard's top in window coordinates while it shows (native's keyboard events, both iOS and Android), or the
 * visual viewport's height (web, which shrinks while a phone's keyboard shows); null without either.
 */
function useKeyboardTop(): number | null {
  const [top, setTop] = useState<number | null>(readKeyboardTop);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const viewport = visualViewport();
      if (viewport === null) return;
      const onResize = (): void => { setTop(viewport.height); };
      viewport.addEventListener('resize', onResize);
      return () => { viewport.removeEventListener('resize', onResize); };
    }
    const shown = Keyboard.addListener('keyboardDidShow', (event) => { setTop(event.endCoordinates.screenY); });
    const hidden = Keyboard.addListener('keyboardDidHide', () => { setTop(null); });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return top;
}

/** The visual viewport, which older browsers and jsdom lack, though lib.dom types it as always there. */
function visualViewport(): VisualViewport | null {
  return 'visualViewport' in window ? window.visualViewport : null;
}

function readKeyboardTop(): number | null {
  if (Platform.OS === 'web') return visualViewport()?.height ?? null;
  return Keyboard.isVisible() ? Keyboard.metrics()?.screenY ?? null : null;
}

const NO_INSETS = { top: 0, bottom: 0 };

function Card(props: PopoverProps): React.JSX.Element {
  const { anchor, onClose } = props;
  const busy = props.busy === true;
  const { width, height } = useWindowDimensions();
  // Outside a SafeAreaProvider (a unit test) there are no insets.
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  const keyboardTop = useKeyboardTop();
  const bottom = Math.min(height - insets.bottom, keyboardTop ?? height);
  const anchored = width >= ANCHORED_FROM;
  const [rect, setRect] = useState<PopoverRect | null>(null);
  // Measured again whenever the window or the keyboard changes; the last place holds until the new one answers.
  useEffect(() => {
    if (!anchored) return;
    let live = true;
    anchor.current?.measureInWindow((x, y, w, h) => { if (live) setRect({ x, y, width: w, height: h }); });
    return () => { live = false; };
  }, [anchor, anchored, width, height, bottom]);
  const placement = placePopover(anchored ? rect : null, { width, height, top: insets.top, bottom }, props.maxWidth);
  // From 641px the card shows once its opener is measured, so it never flashes at the window's top first.
  const unplaced = anchored && rect === null;
  const outside = props.dismissOnOutsidePress && !busy;
  return (
    <>
      <View
        role="dialog"
        aria-modal
        aria-label={props.label}
        nativeID={props.nativeID}
        style={[styles.card, placement, unplaced ? styles.unplaced : null]}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.head}>
            <Heading style={styles.heading}>{props.label}</Heading>
            {props.closeButton === true ? <Button variant="link" label="Close" disabled={busy} onPress={onClose} /> : null}
          </View>
          {props.children}
        </ScrollView>
      </View>
      <View
        aria-hidden
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        onStartShouldSetResponder={() => true}
        onResponderRelease={() => { if (outside) onClose(); }}
        style={styles.backdrop}
      />
    </>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  card: {
    position: 'absolute', zIndex: 1, backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: 0,
    boxShadow: `0 12px 32px ${c.shadow}`,
  },
  unplaced: { opacity: 0 },
  content: { padding: theme.space[4], gap: theme.space[3] },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', columnGap: theme.space[3] },
  heading: { flexShrink: 1 },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'transparent' },
});
