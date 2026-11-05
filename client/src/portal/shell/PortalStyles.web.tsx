import { theme } from '../../theme';

// The focus ring for every portal control (spec 15.7: a 2px `mint` outline offset 2px), scoped to the portal's
// root (#tw-portal), grayscale antialiasing as the boards and the marketing pages (`.tw`) set it, and the
// reduced-motion switch. One React-rendered <style>, as the marketing pages do, so it is covered by the existing
// `style-src 'unsafe-inline'` and needs no header change.
const css = [
  '#tw-portal{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}',
  `#tw-portal :focus-visible{outline:2px solid ${theme.color.focusRing};outline-offset:2px}`,
  '#tw-portal :focus:not(:focus-visible){outline:none}',
  '@media (prefers-reduced-motion:reduce){#tw-portal *{transition-duration:0ms !important;animation:none !important}}',
].join('\n');

export function PortalStyles(): React.JSX.Element {
  return <style href="townwise-portal" precedence="default">{css}</style>;
}
