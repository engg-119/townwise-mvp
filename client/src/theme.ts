import { Platform } from 'react-native';

// The Townwise design system tokens (tokens.json, aliases resolved): the one source for React
// Native styles and the marketing page's CSS. Sizes are px (points on native); letterSpacing is
// the token's em times its font size; durations are ms; curves are cubic-bezier control points.

const font = {
  sans: '"Instrument Sans", "Helvetica Neue", Arial, system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  wordmark: '"Instrument Sans", "Arial Narrow", "Helvetica Neue", sans-serif',
} as const;

// public/index.html loads the faces on web. Native bundles no brand font, so it keeps the system face.
const sans = Platform.OS === 'web' ? font.sans : undefined;
const mono = Platform.OS === 'web' ? font.mono : undefined;

export const theme = {
  color: {
    ground: '#080a0d', panel: '#101317', raised: '#181c21', state: '#23272c', border: '#34383e', line: '#7b8187',
    white: '#eff2f6', text2: '#b5bbc2', text3: '#9a9fa6', mint: '#7bd2b4', mintRing: 'rgba(123, 210, 180, 0.4)',
    // Proposed in the design system, not yet adopted.
    error: '#f2716a', warning: '#f8c655',
    cta: '#eff2f6', ctaHover: '#b5bbc2', onCta: '#080a0d', onMint: '#080a0d', focusRing: '#7bd2b4',
    seriesNortheast: '#9a9fa6', seriesCounty: '#7bd2b4', deltaAbove: '#7bd2b4', deltaBelow: '#7b8187',
  },
  space: {
    1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64, 24: 96,
    gutter: 20, gutterPhone: 16, marginWide: 80, marginTablet: 32, marginPhone: 16,
  },
  radius: { none: 0, frame: 8 },
  stroke: { state: 0.75, hairline: 1, emph: 1.5, series: 2 },
  font,
  type: {
    h1Wide: { fontFamily: sans, fontSize: 52, lineHeight: 56, fontWeight: 600, letterSpacing: -1.3 },
    h1Col7: { fontFamily: sans, fontSize: 44, lineHeight: 48, fontWeight: 600, letterSpacing: -1.1 },
    h1Tablet: { fontFamily: sans, fontSize: 40, lineHeight: 44, fontWeight: 600, letterSpacing: -1 },
    h1Phone: { fontFamily: sans, fontSize: 34, lineHeight: 40, fontWeight: 600, letterSpacing: -0.85 },
    h2: { fontFamily: sans, fontSize: 40, lineHeight: 44, fontWeight: 600, letterSpacing: -0.8 },
    h2Tablet: { fontFamily: sans, fontSize: 32, lineHeight: 36, fontWeight: 600, letterSpacing: -0.64 },
    h2Phone: { fontFamily: sans, fontSize: 28, lineHeight: 32, fontWeight: 600, letterSpacing: -0.56 },
    h3: { fontFamily: sans, fontSize: 22, lineHeight: 28, fontWeight: 600, letterSpacing: -0.22 },
    h3Phone: { fontFamily: sans, fontSize: 20, lineHeight: 24, fontWeight: 600, letterSpacing: -0.2 },
    body: { fontFamily: sans, fontSize: 17, lineHeight: 28, fontWeight: 400 },
    bodyPhone: { fontFamily: sans, fontSize: 16, lineHeight: 24, fontWeight: 400 },
    sub: { fontFamily: sans, fontSize: 16, lineHeight: 24, fontWeight: 400 },
    ui: { fontFamily: sans, fontSize: 14, lineHeight: 20, fontWeight: 500 },
    small: { fontFamily: sans, fontSize: 14, lineHeight: 20, fontWeight: 400 },
    button: { fontFamily: sans, fontSize: 15, lineHeight: 20, fontWeight: 600 },
    wordmark: { fontFamily: sans, fontSize: 18, lineHeight: 24, fontWeight: 600, letterSpacing: -0.18 },
    label: { fontFamily: mono, fontSize: 12, lineHeight: 16, fontWeight: 400, letterSpacing: 0.48, textTransform: 'uppercase' },
    mono: { fontFamily: mono, fontSize: 12, lineHeight: 16, fontWeight: 400 },
    monoValue: { fontFamily: mono, fontSize: 12, lineHeight: 16, fontWeight: 500 },
    monoUi: { fontFamily: mono, fontSize: 14, lineHeight: 20, fontWeight: 400 },
    value: { fontFamily: mono, fontSize: 56, lineHeight: 56, fontWeight: 500, letterSpacing: -1.12 },
    valuePhone: { fontFamily: mono, fontSize: 40, lineHeight: 40, fontWeight: 500, letterSpacing: -0.8 },
    code: { fontFamily: mono, fontSize: 16, lineHeight: 24, fontWeight: 400, letterSpacing: 1.28 },
  },
  // easeOut for entering, easeInOut for movement on screen, ease for hover and color; never ease-in.
  // Interface durations stay under 300ms.
  motion: {
    easeOut: [0.23, 1, 0.32, 1], easeInOut: [0.77, 0, 0.175, 1], ease: [0.25, 0.1, 0.25, 1],
    select: 150, fade: 200, cursor: 220, zoom: 280,
  },
} as const;
