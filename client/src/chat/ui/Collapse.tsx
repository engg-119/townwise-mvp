import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';

// The "Worked for" timeline's region on native (owner request, 2026-11-17: a smooth open and close that never
// flashes). Its height runs between 0 and the content's measured height (Animated, easeOut); while it moves the
// content is laid out unclipped in an absolute layer, so its height is known and a step arriving mid-move grows the
// target without starting over. Settled open, the region has no fixed height, so new steps simply grow it. Mounted
// open, it shows open at once. The content is mounted only while open or closing, and is hidden from assistive tech
// and touches once closing starts. Under Reduce Motion, and until the system answers, it opens and closes at once.
// Collapse.web.tsx is the web one.

export const COLLAPSE_MS = theme.motion.fade;

type Phase = 'open' | 'closed' | 'moving';

export function Collapse(props: { id: string; open: boolean; children: React.ReactNode }): React.JSX.Element {
  const { open } = props;
  const reduced = useReducedMotion() !== false;
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed');
  const [was, setWas] = useState(open);
  const [progress] = useState(() => new Animated.Value(open ? 1 : 0));
  const [height] = useState(() => new Animated.Value(0));
  const [shownHeight] = useState(() => Animated.multiply(progress, height));
  if (was !== open) {
    setWas(open);
    setPhase(reduced ? (open ? 'open' : 'closed') : 'moving');
  }
  useEffect(() => {
    if (phase !== 'moving') {
      progress.setValue(phase === 'open' ? 1 : 0);
      return undefined;
    }
    const [x1, y1, x2, y2] = theme.motion.easeOut;
    const move = Animated.timing(progress, {
      toValue: open ? 1 : 0, duration: COLLAPSE_MS, easing: Easing.bezier(x1, y1, x2, y2), useNativeDriver: false,
    });
    move.start(({ finished }) => { if (finished) setPhase(open ? 'open' : 'closed'); });
    return () => { move.stop(); };
  }, [phase, open, progress]);
  const settled = phase === 'open';
  return (
    <Animated.View nativeID={props.id} style={settled ? null : [styles.clip, { height: phase === 'closed' ? 0 : shownHeight }]}>
      {open || phase === 'moving' ? (
        <View
          style={settled ? null : styles.layer}
          onLayout={(event) => { height.setValue(event.nativeEvent.layout.height); }}
          importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
          accessibilityElementsHidden={!open}
          pointerEvents={open ? 'auto' : 'none'}
        >
          {props.children}
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  layer: { position: 'absolute', top: 0, left: 0, right: 0 },
});
