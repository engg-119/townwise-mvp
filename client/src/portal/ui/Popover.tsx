import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
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
// a `panel` fill with a 1px `border` outline, the `shadow` token, square, 16px padding, its heading row (the heading and
// Close) at its top and the rest scrolling under it. The heading row is outside the scroll view, and on web the card's
// first control takes focus as it opens (focusFirstControl), since Chrome lets a scroll view whose content overflows
// take focus and the trap would otherwise give it to that unnamed region before Close or the note form's Kind. For the
// same reason the card takes Tab and Shift+Tab itself on web (tabWithin), moving between its enabled controls and
// wrapping past either end, so the trap's own wrap never runs, and the scroll view hands back any focus it is given
// (refuseFocus).
// The backdrop under it is transparent and is neither a tab stop nor a screen reader stop (a plain View, never a
// Pressable, which is always focusable on web); it takes presses and closes the popover only where the popover allows
// that, and on web a press on it keeps focus in the card. Placement (placePopover) is measured on open, on every window size change and every keyboard show or hide: from
// 641px wide the card opens 8px under its opener, or 8px above it when the room below is short, edge-aligned with it;
// below 641px it is pinned to the top of the window, since its text fields would sit under the keyboard lower down. The
// window's bottom is the keyboard's top while it shows, so the card never runs under it. Card and backdrop sit in a box
// as tall as the height placement used (on web the layout viewport's, which a phone's keyboard does not shrink, though
// react-native-web's window height is the visual viewport's), so a card placed by its `bottom` lands where placePopover
// put it whatever size the Modal is. `busy` holds it open (Close disabled in place, Escape, back and outside presses
// doing nothing) while an action runs, so its answer always lands in the open popover. Nothing animates.

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
  /** The height of the box the card is placed in, from whose bottom a card above its opener is placed. */
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
 * Above an opener the keyboard covers, it ends 16px above the keyboard's top instead, so no part of it is under the
 * keyboard. Below 641px, or with no opener to measure, it is pinned 16px from the usable top and either side, at most
 * the usable height less 32px tall; below 641px it is the window's width less 32px.
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
  const end = Math.min(anchor.y - GAP, window.bottom - MARGIN);
  return { width, left, bottom: window.height - end, maxHeight: Math.max(0, end - window.top - MARGIN) };
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

type Host = React.ComponentRef<typeof View>;

/** A control in the tab order: react-native-web draws a pressable as a <button> or with tabindex 0. */
const CONTROL = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * On web, focus to the card's first control that takes it: Close where the popover has one, else its content's first
 * (the note form's Kind). Run as the Modal shows, after its focus trap noted the opener to give focus back to and
 * before the trap looks for a first element, which then finds focus already inside the card and leaves it there.
 */
function focusFirstControl(card: Host | null): void {
  const node = card as unknown as HTMLElement | null;
  for (const control of node?.querySelectorAll<HTMLElement>(CONTROL) ?? []) {
    control.focus();
    if (document.activeElement === control) return;
  }
}

/** A control disabled in place (a Button, which keeps its focus with aria-disabled) or a disabled field. */
const DISABLED = ':disabled, [aria-disabled="true"]';

/**
 * On web, Tab and Shift+Tab inside the card move between its enabled controls alone, from the focused element to the
 * next (or previous) one, wrapping past either end. Left to the browser, Tab past the last control (Shift+Tab before
 * the first) leaves the card for react-native-web's focus bracket, and the trap's search for where to bring focus back
 * can stop on the scroll view, which Chrome lets a script focus. Keys from a dialog the card opened (Your calendars'
 * Remove), another Modal outside the card's DOM, still come here through React's tree and are left alone.
 */
function tabWithin(card: Host | null, event: React.KeyboardEvent<HTMLElement>): void {
  const node = card as unknown as HTMLElement | null;
  const from = event.target;
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (node === null || !(from instanceof Node) || !node.contains(from)) return;
  event.preventDefault();
  const controls = [...node.querySelectorAll<HTMLElement>(CONTROL)].filter((control) => !control.matches(DISABLED));
  const after = controls.filter((control) => (from.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const before = controls.filter((control) => control !== from && !after.includes(control));
  const order = event.shiftKey ? [...before.toReversed(), ...after.toReversed()] : [...after, ...before];
  for (const control of order) {
    control.focus();
    if (document.activeElement === control) return;
  }
}

/**
 * On web, the scroll view never keeps focus. Chrome lets a press on its blank space, or a script, focus it (the trap,
 * when focus leaves the card, tries each element of the card in turn), so focus goes back to the element in the card
 * it came from, or else to the card's first control; the trap's search, finding the scroll view refused, goes on into it.
 */
function refuseFocus(card: Host | null, event: React.FocusEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) return;
  const node = card as unknown as HTMLElement | null;
  const from = event.relatedTarget;
  if (from instanceof HTMLElement && node?.contains(from) === true) from.focus();
  if (document.activeElement === event.target) focusFirstControl(card);
}

export function Popover(props: PopoverProps): React.JSX.Element {
  const busy = props.busy === true;
  const card = useRef<Host>(null);
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="none"
      // Android: the card is placed in the same window coordinates its opener is measured in.
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => { if (!busy) props.onClose(); }}
      {...(Platform.OS === 'web' ? { onShow: () => { focusFirstControl(card.current); } } : {})}
      {...(props.onDismiss === undefined ? {} : { onDismiss: props.onDismiss })}
    >
      {props.visible ? <Card {...props} ref={card} /> : null}
    </Modal>
  );
}

/**
 * The keyboard's top in window coordinates while it shows (native's keyboard events, both iOS and Android), or the
 * visual viewport's bottom (web, which a phone's keyboard raises); null without either.
 */
function useKeyboardTop(): number | null {
  const [top, setTop] = useState<number | null>(readKeyboardTop);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const viewport = visualViewport();
      if (viewport === null) return;
      // A resize when the keyboard shows or hides; a scroll when the browser pans the visual viewport to a field.
      const onChange = (): void => { setTop(viewportBottom(viewport)); };
      viewport.addEventListener('resize', onChange);
      viewport.addEventListener('scroll', onChange);
      return () => {
        viewport.removeEventListener('resize', onChange);
        viewport.removeEventListener('scroll', onChange);
      };
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

/**
 * The visual viewport's bottom in the layout viewport's coordinates, which the opener is measured in and the card is
 * placed in: its pan plus its height, scaled as react-native-web scales the window, so a pinch zoom shrinks nothing.
 */
function viewportBottom(viewport: VisualViewport): number {
  return viewport.offsetTop + viewport.height * viewport.scale;
}

function readKeyboardTop(): number | null {
  if (Platform.OS === 'web') {
    const viewport = visualViewport();
    return viewport === null ? null : viewportBottom(viewport);
  }
  return Keyboard.isVisible() ? Keyboard.metrics()?.screenY ?? null : null;
}

const NO_INSETS = { top: 0, bottom: 0 };

/**
 * On web, the backdrop's mousedown is cancelled, so a press outside a popover that stays open (the note form's) keeps
 * focus where it was in the card instead of moving it to the body, as a press on a plain element would.
 */
const KEEP_FOCUS = Platform.OS === 'web' ? { onMouseDown: (event: { preventDefault: () => void }) => { event.preventDefault(); } } : {};

/** In place of the opener's box when the popover opened with no opener to measure: the card is pinned at the top. */
const NOTHING = 'nothing';

function Card({ ref, ...props }: PopoverProps & { ref: RefObject<Host | null> }): React.JSX.Element {
  const { anchor, onClose } = props;
  const busy = props.busy === true;
  const dimensions = useWindowDimensions();
  const { width } = dimensions;
  // The box the card is placed in. On web react-native-web's window height is the visual viewport's, which a phone's
  // keyboard shrinks while the Modal stays the layout viewport's size, so the layout viewport's height is used.
  const height = Platform.OS === 'web' ? document.documentElement.clientHeight : dimensions.height;
  // Outside a SafeAreaProvider (a unit test) there are no insets.
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  const keyboardTop = useKeyboardTop();
  const bottom = Math.min(height - insets.bottom, keyboardTop ?? height);
  const anchored = width >= ANCHORED_FROM;
  // The card mounts as the popover opens, so this is whether it opened with an opener to measure.
  const [rect, setRect] = useState<PopoverRect | typeof NOTHING | null>(() => (anchor.current === null ? NOTHING : null));
  // Measured again whenever the window or the keyboard changes; the last place holds until the new one answers.
  useEffect(() => {
    if (!anchored) return;
    let live = true;
    anchor.current?.measureInWindow((x, y, w, h) => { if (live) setRect({ x, y, width: w, height: h }); });
    return () => { live = false; };
  }, [anchor, anchored, width, height, bottom]);
  const measured = anchored && rect !== NOTHING ? rect : null;
  const placement = placePopover(measured, { width, height, top: insets.top, bottom }, props.maxWidth);
  // From 641px the card shows once its opener is measured, so it never flashes at the window's top first.
  const unplaced = anchored && rect === null;
  const outside = props.dismissOnOutsidePress && !busy;
  const web = Platform.OS === 'web';
  return (
    <View style={[styles.frame, { height }]}>
      <View
        ref={ref}
        role="dialog"
        aria-modal
        aria-label={props.label}
        nativeID={props.nativeID}
        // React Native types these props with its own events; on web react-native-web hands over the DOM's.
        {...(web ? ({ onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { tabWithin(ref.current, event); } } as object) : {})}
        style={[styles.card, placement, unplaced ? styles.unplaced : null]}
      >
        <View style={styles.head}>
          <Heading style={styles.heading}>{props.label}</Heading>
          {props.closeButton === true ? <Button variant="link" label="Close" disabled={busy} onPress={onClose} /> : null}
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          {...(web ? ({ onFocus: (event: React.FocusEvent<HTMLElement>) => { refuseFocus(ref.current, event); } } as object) : {})}
        >
          {props.children}
        </ScrollView>
      </View>
      <View
        aria-hidden
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        onStartShouldSetResponder={() => true}
        onResponderRelease={() => { if (outside) onClose(); }}
        {...KEEP_FOCUS}
        style={styles.backdrop}
      />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  // The box placement measures in: the window's width, `height` tall from its top.
  frame: { position: 'absolute', top: 0, left: 0, right: 0 },
  card: {
    position: 'absolute', zIndex: 1, backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: 0,
    boxShadow: `0 12px 32px ${c.shadow}`,
  },
  unplaced: { opacity: 0 },
  // The heading row keeps the card's 16px padding above and beside it, and the content 12px under it, as one column did.
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', columnGap: theme.space[3],
    paddingTop: theme.space[4], paddingHorizontal: theme.space[4],
  },
  content: { paddingTop: theme.space[3], paddingHorizontal: theme.space[4], paddingBottom: theme.space[4], gap: theme.space[3] },
  heading: { flexShrink: 1 },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'transparent' },
});
