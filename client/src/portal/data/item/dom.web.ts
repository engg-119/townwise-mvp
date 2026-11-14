import { theme } from '../../../theme';

// The inline styles the item page's DOM views share (P27): the portal's mono and reading type, and a scroll region
// that keeps a long or wide file inside its own box (a focusable region, so the keyboard can scroll it) instead of
// scrolling the page sideways. The focus ring is the portal's (shell/PortalStyles.web.tsx).

const C = theme.color;

export const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' } as const;

export const reading = { fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px', color: C.text2 } as const;

/** A box at most 640px tall that scrolls inside itself, both ways. */
export const region = {
  border: `1px solid ${C.border}`, background: C.panel, maxHeight: 640, overflow: 'auto', minWidth: 0, boxSizing: 'border-box',
} as const;

export const cellBorder = `1px solid ${C.border}`;
