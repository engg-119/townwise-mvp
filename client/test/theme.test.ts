import { Platform } from 'react-native';

import { theme } from '../src/theme';

// WCAG 2 relative luminance and contrast ratio for #rrggbb colors.
function luminance(hex: string): number {
  const linear = (at: number): number => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The key colors are the dark palette's: on web theme.color holds var(--tw-<token>) references to it
// (test/portal/theme-palette.test.ts).
const dark = theme.palette.dark;

test('pins the key colors', () => {
  expect(dark.mint).toBe('#7bd2b4');
  expect(dark.cta).toBe('#eff2f6');
  expect(dark.ctaHover).toBe('#b5bbc2');
  expect(dark.ground).toBe('#080a0d');
  expect(dark.onCta).toBe(dark.ground);
});

test('the contrast helper matches the WCAG extremes', () => {
  expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
  expect(contrast('#7bd2b4', '#7bd2b4')).toBe(1);
});

test.each(['dark', 'light'] as const)('the primary button label meets 4.5:1 at rest and on hover, %s', (mode) => {
  const palette = theme.palette[mode];
  expect(contrast(palette.onCta, palette.cta)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(palette.onCta, palette.ctaHover)).toBeGreaterThanOrEqual(4.5);
});

test('motion uses the agreed curves and interface durations under 300ms', () => {
  expect(theme.motion.easeOut).toEqual([0.23, 1, 0.32, 1]);
  expect(theme.motion.easeInOut).toEqual([0.77, 0, 0.175, 1]);
  const { select, fade, cursor, zoom } = theme.motion;
  expect(Math.max(select, fade, cursor, zoom)).toBeLessThan(300);
});

test('type names the self-hosted faces on web and the system face on native', () => {
  const families = new Set(Object.values(theme.type).map((style) => style.fontFamily));
  expect(families).toEqual(Platform.OS === 'web' ? new Set([theme.font.sans, theme.font.mono]) : new Set([undefined]));
});
