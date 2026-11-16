import { createElement, useEffect, useState } from 'react';

import { Message } from '../ui';
import { gis, loadGis, resetGis } from './gis.web';
import type { GoogleButtonProps } from './GoogleButton';

// Google's script loads through gis.web.ts, the one loader it shares with the Calendar's Google connect, so the page
// holds one script tag whichever ran first.

let initialized = false;
let handler: ((idToken: string) => void) | null = null;

/** For tests: forgets the button's own state and, through resetGis, removes Google's script. */
export function resetGoogleButtonState(): void {
  resetGis();
  initialized = false;
  handler = null;
}

// Google first draws a placeholder as wide as the container, then swaps in its own button in an iframe: the plain
// one at its own width, or "Continue as <name>" for someone who signed in before. So the button gets the
// container's width (Google takes 200 to 400px), the container is fixed at the iframe's 44px (for a moment WebKit
// shows the placeholder and the iframe together), and it stays hidden behind a skeleton until the iframe has its
// size, then shows at once. The iframe takes a size only when Google has a personalized button to swap in; otherwise
// it loads and stays 0 wide and the placeholder is the button, so SWAP_GRACE_MS after the iframe loads with no size
// it shows. If neither happens (the iframe is blocked, or Google changes its markup), it shows after REVEAL_MS.
export const REVEAL_MS = 3000;
export const SWAP_GRACE_MS = 300;
const BUTTON_HEIGHT = 44;

function buttonWidth(node: HTMLElement): number | null {
  const width = node.clientWidth;
  return width > 0 ? Math.round(Math.min(400, Math.max(200, width))) : null;
}

// Calls `done` once an iframe inside `node` has a width, SWAP_GRACE_MS after one loads with none, or after
// REVEAL_MS; returns the cleanup. Without the observers it calls `done` at once.
function whenSettled(node: HTMLElement, done: () => void): () => void {
  if (typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') {
    done();
    return () => undefined;
  }
  let finished = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const watched = new Set<HTMLIFrameElement>();
  const sizes = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.contentRect.width > 0)) finish();
  });
  const loaded = (): void => {
    grace ??= setTimeout(() => { finish(); }, SWAP_GRACE_MS);
  };
  const watchFrames = (): void => {
    for (const frame of node.querySelectorAll('iframe')) {
      if (!watched.has(frame)) {
        watched.add(frame);
        sizes.observe(frame);
        frame.addEventListener('load', loaded);
      }
    }
  };
  const added = new MutationObserver(watchFrames);
  const timer = setTimeout(() => { finish(); }, REVEAL_MS);
  function stop(): void {
    clearTimeout(timer);
    if (grace !== null) clearTimeout(grace);
    sizes.disconnect();
    added.disconnect();
    for (const frame of watched) frame.removeEventListener('load', loaded);
  }
  function finish(): void {
    if (finished) return;
    finished = true;
    stop();
    done();
  }
  added.observe(node, { childList: true, subtree: true });
  watchFrames();
  return stop;
}

export function GoogleButton(props: GoogleButtonProps): React.JSX.Element | null {
  const [unavailable, setUnavailable] = useState(false);
  const [settled, setSettled] = useState(false);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const { google, onIdToken } = props;

  useEffect(() => {
    handler = (token) => { onIdToken(token); };
    if (google === null || node === null) return () => { handler = null; };
    const clientId = google.webClientId;
    let cancelled = false;
    let unwatch = (): void => undefined;
    void loadGis().then(() => {
      const accounts = gis();
      if (cancelled || accounts === undefined) return;
      if (!initialized) {
        accounts.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (typeof response.credential === 'string' && response.credential !== '') handler?.(response.credential);
          },
        });
        initialized = true;
      }
      // New and returning users take the same path, so the button reads "Continue with Google" (or Google's own
      // "Continue as <name>").
      const width = buttonWidth(node);
      unwatch = whenSettled(node, () => { if (!cancelled) setSettled(true); });
      accounts.accounts.id.renderButton(node, width === null ? { text: 'continue_with' } : { text: 'continue_with', width });
    }).catch(() => {
      if (!cancelled) setUnavailable(true);
    });
    return () => {
      cancelled = true;
      handler = null;
      unwatch();
    };
  }, [google, node, onIdToken]);

  if (google === null) return null;
  if (unavailable) {
    return <Message tone="error">Google sign-in didn’t load. Check your connection, turn off any blocker for accounts.google.com, and reload.</Message>;
  }
  // Until Google's button is ready, a copy of Google's own placeholder (its white 40px button with the G and "Continue
  // with Google", at the width Google is given) holds its place from the first frame; then Google's button replaces it
  // at once, with no fade. For a visitor without a Google session the swap is invisible; for one with a session the
  // label becomes "Continue as <name>" in the same box.
  const skeleton = settled ? null : createElement('div', { 'aria-hidden': true, 'data-skeleton': 'google', style: SKELETON },
    createElement('div', { style: SKELETON_ROW },
      createElement('svg', { viewBox: '0 0 48 48', width: 18, height: 18, style: SKELETON_LOGO },
        ...G_LOGO.map(([fill, d]) => createElement('path', { key: fill, fill, d }))),
      createElement('span', { style: SKELETON_LABEL }, 'Continue with Google')));
  const drawn = createElement('div', { ref: setNode, style: settled ? { height: BUTTON_HEIGHT } : { height: BUTTON_HEIGHT, visibility: 'hidden' as const } });
  return createElement('div', { style: { position: 'relative' as const, height: BUTTON_HEIGHT } }, skeleton, drawn);
}

// Google's placeholder for { text: 'continue_with' }, as its own styles compute (read from the GIS script on
// townwise.tech, 2026-11-15). The font stack is Google's; the CSP's font-src 'self' keeps Google Sans out, so both fall
// back to Arial alike.
const SKELETON = {
  position: 'absolute' as const, top: 0, left: 0, boxSizing: 'border-box' as const, width: '100%', minWidth: 200, maxWidth: 400,
  height: 40, borderRadius: 4, border: '1px solid #dadce0', backgroundColor: '#ffffff', pointerEvents: 'none' as const,
  paddingLeft: 12, paddingRight: 12, color: '#3c4043', fontFamily: '"Google Sans", arial, sans-serif', fontSize: 14,
  letterSpacing: '0.25px',
};
const SKELETON_ROW = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '100%' };
const SKELETON_LOGO = { flexShrink: 0, marginRight: 8 };
const SKELETON_LABEL = {
  flexGrow: 1, textAlign: 'center' as const, fontWeight: 500, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
};
// Google's G, the paths its own button draws.
const G_LOGO = [
  ['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
  ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
  ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
  ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z'],
] as const;
