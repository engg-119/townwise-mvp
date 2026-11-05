// The one number formatter (design system README, "The one number formatter"): every printed index value,
// gap and percentage goes through these. One decimal, rounded half up on the magnitude; negatives take the
// true minus U+2212, and the sign comes from the rounded value, so a value that rounds to zero has none.
// The 1e-7 guard keeps half-up stable when a scaled value lands a hair under .5 in binary.

const MINUS = '\u2212';

export function fmt1(v: number): string {
  const r = Math.round(Math.abs(v) * 10 + 1e-7) / 10;
  return (v < 0 && r > 0 ? MINUS : '') + r.toFixed(1);
}

export function fmtSigned(v: number): string {
  const r = Math.round(Math.abs(v) * 10 + 1e-7) / 10;
  return (r === 0 ? '' : v < 0 ? MINUS : '+') + r.toFixed(1);
}

// Whole numbers, where the copy calls for them.
export function fmt0(v: number): string {
  const r = Math.round(Math.abs(v) + 1e-7);
  return (v < 0 && r > 0 ? MINUS : '') + String(r);
}

// The label word for a gap, from the rounded value, so it always agrees with fmtSigned.
export function side(v: number): 'above' | 'below' | 'level with' {
  const sign = fmtSigned(v).charAt(0);
  return sign === '+' ? 'above' : sign === MINUS ? 'below' : 'level with';
}
