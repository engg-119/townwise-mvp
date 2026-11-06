import { createElement, useEffect, useState } from 'react';

import { Message } from '../ui';
import type { GoogleButtonProps } from './GoogleButton';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface Gis {
  accounts: {
    id: {
      initialize: (config: { client_id: string; callback: (response: { credential?: string }) => void }) => void;
      renderButton: (parent: HTMLElement, options: { text: 'continue_with'; width?: number }) => void;
    };
  };
}

let loader: Promise<void> | null = null;
let initialized = false;
let handler: ((idToken: string) => void) | null = null;

export function resetGoogleButtonState(): void {
  loader = null;
  initialized = false;
  handler = null;
  document.querySelectorAll(`script[src="${GIS_SRC}"]`).forEach((node) => { node.remove(); });
}

function gis(): Gis | undefined {
  return (window as Window & { google?: Gis }).google;
}

function loadGis(): Promise<void> {
  if (loader !== null) return loader;
  loader = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    const timer = setTimeout(() => { fail(new Error('timeout')); }, 10_000);
    function fail(error: Error): void {
      clearTimeout(timer);
      script.remove();
      loader = null;
      reject(error);
    }
    script.addEventListener('load', () => {
      clearTimeout(timer);
      resolve();
    });
    script.addEventListener('error', () => { fail(new Error('load')); });
    document.head.append(script);
  });
  return loader;
}

// Google first draws a placeholder as wide as the container, then swaps in its own button in an iframe: the plain
// one at its own width, or "Continue as <name>" for someone who signed in before. So the button gets the
// container's width (Google takes 200 to 400px), the container is fixed at the iframe's 44px (for a moment WebKit
// shows the placeholder and the iframe together), and it stays hidden until the iframe has its size, then fades
// in. If that never happens (the iframe is blocked, or Google changes its markup), it shows after REVEAL_MS.
export const REVEAL_MS = 3000;
const BUTTON_HEIGHT = 44;

function buttonWidth(node: HTMLElement): number | null {
  const width = node.clientWidth;
  return width > 0 ? Math.round(Math.min(400, Math.max(200, width))) : null;
}

// Calls `done` once an iframe inside `node` has a width, or after REVEAL_MS; returns the cleanup. Without the
// observers it calls `done` at once.
function whenSettled(node: HTMLElement, done: () => void): () => void {
  if (typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') {
    done();
    return () => undefined;
  }
  let finished = false;
  const watched = new Set<Element>();
  const sizes = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.contentRect.width > 0)) finish();
  });
  const watchFrames = (): void => {
    for (const frame of node.querySelectorAll('iframe')) {
      if (!watched.has(frame)) {
        watched.add(frame);
        sizes.observe(frame);
      }
    }
  };
  const added = new MutationObserver(watchFrames);
  const timer = setTimeout(() => { finish(); }, REVEAL_MS);
  function stop(): void {
    clearTimeout(timer);
    sizes.disconnect();
    added.disconnect();
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
  const style = settled
    ? { height: BUTTON_HEIGHT, opacity: 1, transition: 'opacity 200ms ease-out' }
    : { height: BUTTON_HEIGHT, opacity: 0, visibility: 'hidden' as const };
  return createElement('div', { ref: setNode, style });
}
