import { Platform } from 'react-native';

// The Townwise design system tokens (tokens.json, aliases resolved): the one source for React
// Native styles and the marketing page's CSS. Sizes are px (points on native); letterSpacing is
// the token's em times its font size; durations are ms; curves are cubic-bezier control points.
//
// Colors come in two palettes of the same tokens. Dark is the only one on native. On web every page, public or not,
// shows the site's one mode: the system's setting until the person picks with the switch (portal/shell/themeMode.ts).
// On web every theme.color value is a reference to a CSS custom property, var(--tw-<token>) (colorVar), so the
// style sheets that read theme.color once at load switch palettes with no re-render: public/index.html defines
// the dark values at :root and the light ones under html[data-theme="light"] and for a light system, and
// test/public/index-html.test.ts pins those to the palettes here. Native keeps the dark hex values. Code that needs a
// real color (to parse it, mix it or hand it to something outside CSS) reads theme.palette instead.

/** The dark palette: the design system's colors, unchanged. */
const dark = {
  ground: '#080a0d', panel: '#101317', raised: '#181c21', state: '#23272c', border: '#34383e', line: '#7b8187',
  white: '#eff2f6', text2: '#b5bbc2', text3: '#9a9fa6', mint: '#7bd2b4', mintRing: 'rgba(123, 210, 180, 0.4)',
  // Proposed in the design system, not yet adopted.
  error: '#f2716a', warning: '#f8c655',
  // The dim behind a modal, and the shadow under a floating list.
  scrim: 'rgba(8, 10, 13, 0.8)', shadow: 'rgba(0, 0, 0, 0.6)',
  cta: '#eff2f6', ctaHover: '#b5bbc2', onCta: '#080a0d', onMint: '#080a0d', focusRing: '#7bd2b4',
  seriesNortheast: '#9a9fa6', seriesCounty: '#7bd2b4', deltaAbove: '#7bd2b4', deltaBelow: '#7b8187',
  // The effect ramp: the color of Why's ▲ and ▼ by the size of a reason's effect on guests, step 1 to 3 (10 to 15%, 20
  // to 35%, 40% and over), each step greener or redder (more saturated) at about one hue, each at least 4.5:1 on ground,
  // panel and raised (refine-calendar-and-home design decision 8). Its own set of tokens: effectDown3 shares error's
  // value, but error stays unadopted and field messages stay white (spec 15.7's [CONFIRM], CONFIRM index item 34).
  effectUp1: '#9cc9ae', effectUp2: '#86cfa4', effectUp3: '#5fd98f',
  effectDown1: '#d1a39e', effectDown2: '#e09a93', effectDown3: '#f2716a',
  // The light backing of a source chip's logo, the same in both palettes, so a dark logo shows on the dark ground.
  logoGround: '#f5f6f8',
} as const;

export type ColorToken = keyof typeof dark;
export type Palette = Readonly<Record<ColorToken, string>>;

/**
 * The light palette, aliased as dark is: `white` is the primary text, so it is near black; the primary button
 * (`cta`) is dark with a light label; mint is darkened to read as text (4.5:1 on ground, panel and raised) and
 * carries white (`onMint`). text2 and text3 are 4.5:1 and `line` 3:1 on ground, panel and raised; `border` is subtle.
 * seriesNortheast is the lighter `line` gray, not text3: text3 has the luminance of the mint line (1.08:1 apart), so the
 * dashed Northeast line would read as the county's twin; at 1.6:1 from mint and 3.4:1 on raised it does not.
 */
const light: Palette = {
  ground: '#f5f6f8', panel: '#ffffff', raised: '#e9ecef', state: '#dce0e5', border: '#cfd4da', line: '#7a8088',
  white: '#0d1014', text2: '#3e444b', text3: '#5d636b', mint: '#136a53', mintRing: 'rgba(19, 106, 83, 0.4)',
  error: '#b42d25', warning: '#8a5b00',
  scrim: 'rgba(13, 16, 20, 0.4)', shadow: 'rgba(13, 16, 20, 0.18)',
  cta: '#0d1014', ctaHover: '#3e444b', onCta: '#f5f6f8', onMint: '#ffffff', focusRing: '#136a53',
  seriesNortheast: '#7a8088', seriesCounty: '#136a53', deltaAbove: '#136a53', deltaBelow: '#7a8088',
  effectUp1: '#426c54', effectUp2: '#2f6e4a', effectUp3: '#137a3a',
  effectDown1: '#7d504a', effectDown2: '#93453f', effectDown3: '#b42d25',
  logoGround: '#f5f6f8',
};

/** The CSS custom property that carries a color token on web: `mintRing` is `--tw-mint-ring`. */
export function colorVar(token: ColorToken): string {
  return `--tw-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

const tokens = Object.keys(dark) as ColorToken[];
const color: Palette = Platform.OS === 'web'
  ? Object.fromEntries(tokens.map((token) => [token, `var(${colorVar(token)})`])) as Palette
  : dark;

const font = {
  sans: '"Instrument Sans", "Helvetica Neue", Arial, system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  wordmark: '"Instrument Sans", "Arial Narrow", "Helvetica Neue", sans-serif',
} as const;

// public/index.html loads the faces on web. Native bundles no brand font, so it keeps the system face.
const sans = Platform.OS === 'web' ? font.sans : undefined;
const mono = Platform.OS === 'web' ? font.mono : undefined;

export const theme = {
  color,
  palette: { dark, light },
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
