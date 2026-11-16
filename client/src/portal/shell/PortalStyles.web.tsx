import { useLayoutEffect } from 'react';

import { theme } from '../../theme';
import { useThemeMode } from './themeMode';

// The focus ring for every portal control (spec 15.7: a 2px `mint` outline offset 2px), scoped to the portal's
// root (#tw-portal) and to every Modal (a popover, ConfirmDialog), which react-native-web renders at the end of the
// body, outside #tw-portal, in an element with aria-modal="true" (no public page has one); grayscale antialiasing as
// the boards and the marketing pages (`.tw`) set it, and the reduced-motion switch. One React-rendered <style>, as the
// marketing pages do, so it is covered by the existing `style-src 'unsafe-inline'` and needs no header change.
// Scrollbars are styled for every page in public/index.html.
const css = [
  '#tw-portal{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}',
  `#tw-portal :focus-visible{outline:2px solid ${theme.color.focusRing};outline-offset:2px}`,
  '#tw-portal :focus:not(:focus-visible){outline:none}',
  `[aria-modal="true"] :focus-visible{outline:2px solid ${theme.color.focusRing};outline-offset:2px}`,
  '[aria-modal="true"] :focus:not(:focus-visible){outline:none}',
  // A control inside a box that draws its own ring (the chat composer's rounded box) opts out with data-ring="box",
  // or a square ring is drawn inside the round one.
  '#tw-portal [data-ring="box"]:focus-visible{outline:none}',
  '[aria-modal="true"] [data-ring="box"]:focus-visible{outline:none}',
  // The row of actions under a message: the newest message's always shows (data-actions="always"); the rest are
  // transparent until the pointer is over the message or focus is in it, and stay in the tab order. No hover, no hiding.
  '#tw-portal [data-actions="hover"]{opacity:0}',
  '#tw-portal [data-msg]:hover [data-actions="hover"],#tw-portal [data-msg]:focus-within [data-actions="hover"]{opacity:1}',
  '@media (hover:none){#tw-portal [data-actions="hover"]{opacity:1}}',
  '@media (prefers-reduced-motion:reduce){#tw-portal *{transition-duration:0ms !important;animation:none !important}}',
].join('\n');

export function PortalStyles(): React.JSX.Element {
  return <style href="townwise-portal" precedence="default">{css}</style>;
}

/**
 * The site's mode (themeMode.ts: the person's pick, or else the system's setting) on every page, public or not:
 * html[data-theme] names it ("light" swaps in the light --tw-* colors public/index.html defines, "dark" keeps the dark
 * ones even on a system that asks for light), and each theme-color meta takes its ground. A layout effect, so a change
 * never paints a frame in the old palette. Rendered once, at the root of the app (RootStack in app/_layout.tsx), so
 * it holds on every screen and nothing ever takes it off: one pick, from the public header or the portal's top bar,
 * is the mode everywhere.
 */
export function SiteTheme(): null {
  const mode = useThemeMode();
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute('content', theme.palette[mode].ground);
    }
  }, [mode]);
  return null;
}
