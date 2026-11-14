import { StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { PULSE, PULSE_KEYFRAMES } from './timing';

// The skeleton's shapes in the browser, hidden from assistive tech, pulsing in opacity with a CSS animation
// (react-native-web compiles `animationKeyframes` into a @keyframes rule, as its ActivityIndicator does), so no
// script runs per frame. Still under prefers-reduced-motion; the portal's reduced-motion switch (PortalStyles)
// would stop it too. `data-pulse` says which.

const [x1, y1, x2, y2] = theme.motion.easeInOut;

// react-native-web's own style keys, which React Native's style types don't list (so the object is typed as having
// none of theirs).
const pulse: Record<string, unknown> = {
  animationKeyframes: [PULSE_KEYFRAMES],
  animationDuration: `${String(PULSE.cycleMs)}ms`,
  animationTimingFunction: `cubic-bezier(${String(x1)}, ${String(y1)}, ${String(x2)}, ${String(y2)})`,
  animationIterationCount: 'infinite',
};

const styles = StyleSheet.create({ pulse: pulse as Record<string, never> });

export function Pulse(props: { children: React.ReactNode }): React.JSX.Element {
  const reduced = useReducedMotion() !== false;
  const mark = { dataSet: { pulse: reduced ? 'off' : 'on' } };
  return (
    <View aria-hidden testID="skeleton-shapes" {...mark} style={reduced ? null : styles.pulse}>
      {props.children}
    </View>
  );
}
