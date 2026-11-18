import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';

// A History row's sign that TownwiseAI is still replying in that conversation (spec P25 build note, 2026-11-18; owner:
// "if a chat is responding, there should be some spinner to see what is going"): a 10px ring turning once a second,
// then the word "Replying". Under Reduce Motion, and until the system answers, the ring is a still 6px mint square, as
// StatusTag's In progress. The words are the row's own text, so a screen reader reads them with the row.

const TURN_MS = 1000;

export function Replying(): React.JSX.Element {
  const reduced = useReducedMotion();
  const spin = reduced === false;
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    turn.setValue(0);
    if (!spin) return undefined;
    const loop = Animated.loop(Animated.timing(turn, {
      toValue: 1, duration: TURN_MS, easing: (t: number) => Easing.linear(t), useNativeDriver: Platform.OS !== 'web',
    }));
    loop.start();
    return () => { loop.stop(); };
  }, [spin, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View testID="chat-replying" style={styles.row}>
      {spin
        ? <Animated.View aria-hidden testID="chat-replying-spinner" style={[styles.ring, { transform: [{ rotate }] }]} />
        : <View aria-hidden testID="chat-replying-still" style={styles.square} />}
      <Text style={styles.words}>Replying</Text>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', columnGap: theme.space[1] },
  ring: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: c.border, borderTopColor: c.mint },
  square: { width: 6, height: 6, marginHorizontal: 2, backgroundColor: c.mint },
  words: { ...theme.type.mono, color: c.text2 },
});
