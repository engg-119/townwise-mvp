import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

// Focus through the place search's steps. When one part replaces the part that had focus (the card replaces the
// field, the form replaces the card, the field comes back), focus on web, or the screen reader on native, moves to
// the new part, so a keyboard user doesn't start again from the top of the page.

/** On web an element takes focus from script only with tabIndex -1, which keeps it out of the tab order. */
export const SCRIPT_FOCUS: object = Platform.OS === 'web' ? { tabIndex: -1 } : {};

type AccessibilityTarget = Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0];

/** Moves focus (web) or the screen reader (native) to the ref's node once, when it mounts, if `enabled` then. */
export function useFocusOnMount<T>(enabled = true): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  // Only the value at mount counts: a part that is already showing never takes focus back.
  const atMount = useRef(enabled);
  useEffect(() => {
    const node = ref.current;
    if (!atMount.current || node === null) return;
    if (Platform.OS === 'web') {
      (node as unknown as { focus?: () => void }).focus?.();
      return;
    }
    AccessibilityInfo.sendAccessibilityEvent(node as unknown as AccessibilityTarget, 'focus');
  }, []);
  return ref;
}
