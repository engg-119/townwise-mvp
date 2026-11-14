// The skeleton's pulse (spec 15.6, 15.7): opacity only, from 1 down to `low` and back over `cycleMs`, with the
// ease-in-out curve, for as long as the skeleton shows. Nothing moves, grows or shimmers. Under reduced motion, and
// on native until the system says, the skeleton is still at full opacity.

export const PULSE = { low: 0.5, cycleMs: 1600 } as const;

/** The web pulse's keyframes: one property, opacity. */
export const PULSE_KEYFRAMES = {
  '0%': { opacity: 1 },
  '50%': { opacity: PULSE.low },
  '100%': { opacity: 1 },
} as const;
