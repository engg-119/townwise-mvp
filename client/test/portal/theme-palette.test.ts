import { Platform } from 'react-native';

import { colorVar, theme, type ColorToken } from '../../src/theme';

// The two palettes (src/theme.ts) in both projects: on web theme.color is a var(--tw-<token>) reference for every
// token, so the style sheets switch with html[data-theme]; on native it is the dark palette itself. The dark palette
// is the design system's, byte for byte, and the light one meets the contrast the portal's text, controls and
// charts need.

/** The design system's colors before the light mode, which the dark palette must keep exactly. */
const DESIGN_SYSTEM = {
  ground: '#080a0d', panel: '#101317', raised: '#181c21', state: '#23272c', border: '#34383e', line: '#7b8187',
  white: '#eff2f6', text2: '#b5bbc2', text3: '#9a9fa6', mint: '#7bd2b4', mintRing: 'rgba(123, 210, 180, 0.4)',
  error: '#f2716a', warning: '#f8c655',
  scrim: 'rgba(8, 10, 13, 0.8)', shadow: 'rgba(0, 0, 0, 0.6)',
  cta: '#eff2f6', ctaHover: '#b5bbc2', onCta: '#080a0d', onMint: '#080a0d', focusRing: '#7bd2b4',
  seriesNortheast: '#9a9fa6', seriesCounty: '#7bd2b4', deltaAbove: '#7bd2b4', deltaBelow: '#7b8187',
  // Added for the source chips' logos (refine-calendar-and-home design decision 6), the same in both palettes.
  logoGround: '#f5f6f8',
};

const TOKENS = Object.keys(DESIGN_SYSTEM) as ColorToken[];

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

test('the dark palette is the design system’s colors, unchanged (mint stays #7bd2b4)', () => {
  expect(theme.palette.dark).toEqual(DESIGN_SYSTEM);
});

test('both palettes name the same tokens', () => {
  expect(Object.keys(theme.palette.light).sort()).toEqual([...TOKENS].sort());
  expect(Object.keys(theme.color).sort()).toEqual([...TOKENS].sort());
});

test('each token has its own custom property, in kebab case', () => {
  expect(colorVar('ground')).toBe('--tw-ground');
  expect(colorVar('mintRing')).toBe('--tw-mint-ring');
  expect(colorVar('seriesNortheast')).toBe('--tw-series-northeast');
  expect(new Set(TOKENS.map(colorVar)).size).toBe(TOKENS.length);
});

test('theme.color is a var() reference on web and the dark hex on native', () => {
  for (const token of TOKENS) {
    expect(theme.color[token]).toBe(Platform.OS === 'web' ? `var(${colorVar(token)})` : DESIGN_SYSTEM[token]);
  }
});

const light = theme.palette.light;
const SURFACES = ['ground', 'panel', 'raised'] as const;

test.each([
  // Text: the primary, secondary and tertiary text, mint where it is a link or a figure, and the error line.
  ['white', 4.5], ['text2', 4.5], ['text3', 4.5], ['mint', 4.5], ['error', 4.5], ['warning', 4.5],
  // Lines and fills: control boundaries, the focus ring, the chart series and the deltas.
  ['line', 3], ['focusRing', 3], ['seriesCounty', 3], ['seriesNortheast', 3], ['deltaAbove', 3], ['deltaBelow', 3],
] as const)('light: %s meets %d:1 on ground, panel and raised', (token, ratio) => {
  for (const surface of SURFACES) expect(contrast(light[token], light[surface])).toBeGreaterThanOrEqual(ratio);
});

test('light: labels on the primary button and on mint meet 4.5:1, and the border stays subtle', () => {
  expect(contrast(light.onCta, light.cta)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(light.onCta, light.ctaHover)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(light.onMint, light.mint)).toBeGreaterThanOrEqual(4.5);
  for (const surface of SURFACES) expect(contrast(light.border, light[surface])).toBeLessThan(2);
});

test('light: aliased as dark is, so a token keeps its role in both', () => {
  const pairs: [ColorToken, ColorToken][] = [
    ['cta', 'white'], ['ctaHover', 'text2'], ['onCta', 'ground'], ['focusRing', 'mint'], ['seriesCounty', 'mint'],
    ['deltaAbove', 'mint'], ['deltaBelow', 'line'],
  ];
  for (const [token, alias] of pairs) {
    expect(theme.palette.dark[token]).toBe(theme.palette.dark[alias]);
    expect(light[token]).toBe(light[alias]);
  }
  // The Northeast series is text3 in dark; in light it is the lighter line gray (src/theme.ts says why).
  expect(theme.palette.dark.seriesNortheast).toBe(theme.palette.dark.text3);
  expect(light.seriesNortheast).toBe(light.line);
  // A source chip's logo sits on the same light backing in both.
  expect(light.logoGround).toBe(theme.palette.dark.logoGround);
  // mintRing is mint at 40%.
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(light.mint.slice(at, at + 2), 16));
  expect(light.mintRing).toBe(`rgba(${String(r)}, ${String(g)}, ${String(b)}, 0.4)`);
});
