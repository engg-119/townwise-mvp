import { createElement, useEffect, useState } from 'react';

import { Message } from '../ui';
import type { GoogleButtonProps } from './GoogleButton';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface Gis {
  accounts: {
    id: {
      initialize: (config: { client_id: string; callback: (response: { credential?: string }) => void }) => void;
      renderButton: (parent: HTMLElement, options: { text: 'continue_with' }) => void;
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

export function GoogleButton(props: GoogleButtonProps): React.JSX.Element | null {
  const [unavailable, setUnavailable] = useState(false);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const { google, onIdToken } = props;

  useEffect(() => {
    handler = (token) => { onIdToken(token); };
    if (google === null || node === null) return () => { handler = null; };
    const clientId = google.webClientId;
    let cancelled = false;
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
      // New and returning users take the same path, so the button reads "Continue with Google".
      accounts.accounts.id.renderButton(node, { text: 'continue_with' });
    }).catch(() => {
      if (!cancelled) setUnavailable(true);
    });
    return () => {
      cancelled = true;
      handler = null;
    };
  }, [google, node, onIdToken]);

  if (google === null) return null;
  if (unavailable) {
    return <Message tone="error">Google sign-in didn’t load. Check your connection, turn off any blocker for accounts.google.com, and reload.</Message>;
  }
  return createElement('div', { ref: setNode });
}
