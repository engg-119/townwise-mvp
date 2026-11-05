import { useState } from 'react';

// Hover for a Pressable that is the child of expo-router's <Link asChild>. The link's Slot merges the child's
// `style` into one object (`{ ...linkStyle, ...childStyle }`, in @radix-ui/react-slot behind
// node_modules/expo-router/build/ui/Slot.js), so a function style is dropped and, in development, an array style
// throws. Such a child takes one flattened plain object (StyleSheet.flatten) and tracks hover with this instead of
// reading it from a style function. test/portal/link-child.test.ts keeps it that way.

export interface Hover {
  hovered: boolean;
  onHoverIn: () => void;
  onHoverOut: () => void;
}

export function useHover(): Hover {
  const [hovered, setHovered] = useState(false);
  return { hovered, onHoverIn: () => { setHovered(true); }, onHoverOut: () => { setHovered(false); } };
}
