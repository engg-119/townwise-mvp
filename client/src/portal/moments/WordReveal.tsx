import { useMemo } from 'react';
import { Animated, Easing, Platform, StyleSheet, View, type TextStyle } from 'react-native';

import { theme } from '../../theme';
import { FADE_MS } from './timing';

// One line of a statement moment (spec 15.8). Every word is laid out at full size from the first frame and only its
// opacity animates, so wrapping and line boxes are settled before the first word shows. Each word is its own view in
// a wrapping row with a column gap, not a trailing space, which web and native collapse differently. The parent
// hides the words from assistive tech; the provider announces the whole statement once.

const [x1, y1, x2, y2] = theme.motion.easeOut;
const EASE_OUT = Easing.bezier(x1, y1, x2, y2);

export function WordReveal(props: {
  words: readonly string[];
  /** Each word's start on `clock`, in ms. */
  delays: readonly number[];
  /** Runs 0 to the reveal's end, in ms; null shows every word at once. */
  clock: Animated.Value | null;
  style: TextStyle;
}): React.JSX.Element {
  const { words, delays, clock } = props;
  const opacities = useMemo(() => words.map((_word, index) => {
    if (clock === null) return 1;
    const at = delays[index] ?? 0;
    return clock.interpolate({ inputRange: [at, at + FADE_MS], outputRange: [0, 1], extrapolate: 'clamp', easing: EASE_OUT });
  }), [words, delays, clock]);
  const gap = Math.round((props.style.fontSize ?? 16) * 0.25);
  return (
    <View style={[styles.line, { columnGap: gap }]}>
      {words.map((word, index) => (
        <Animated.Text key={`${String(index)}-${word}`} style={[props.style, styles.word, { opacity: opacities[index] ?? 1 }]}>
          {word}
        </Animated.Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', flexWrap: 'wrap' },
  // A word longer than the line (a long unbroken name on a phone) breaks inside itself instead of scrolling.
  word: Platform.OS === 'web' ? { maxWidth: '100%', overflowWrap: 'anywhere' } as TextStyle : { maxWidth: '100%' },
});
