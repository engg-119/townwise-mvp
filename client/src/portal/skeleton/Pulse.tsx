import { useEffect, useState } from 'react';
import { Animated, Easing } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { PULSE } from './timing';

// The skeleton's shapes on iOS and Android, hidden from assistive tech, pulsing in opacity on the native driver.
// Still at full opacity under Reduce Motion, and until the system answers (useReducedMotion is null until then).
// Pulse.web.tsx is the browser's, in CSS.
export function Pulse(props: { children: React.ReactNode }): React.JSX.Element {
  const reduced = useReducedMotion();
  const on = reduced === false;
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    opacity.setValue(1);
    if (!on) return undefined;
    const [x1, y1, x2, y2] = theme.motion.easeInOut;
    const easing = Easing.bezier(x1, y1, x2, y2);
    const half = PULSE.cycleMs / 2;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: PULSE.low, duration: half, easing, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: half, easing, useNativeDriver: true }),
    ]));
    loop.start();
    return () => { loop.stop(); };
  }, [on, opacity]);
  return <Animated.View aria-hidden testID="skeleton-shapes" style={{ opacity }}>{props.children}</Animated.View>;
}
