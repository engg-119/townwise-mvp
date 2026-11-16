// Google Identity Services on web: the one loader of Google's script (connect-google-calendar design decision 3), which
// sign-in's button (GoogleButton.web.tsx, `accounts.id`) and the Calendar's Google connect
// (portal/calendar/GoogleConnect.web.tsx, `accounts.oauth2.initCodeClient`) share, so the page holds one script tag
// whichever of them ran first. Nothing here loads until one of them mounts. A load that fails (the script's error, or
// no load within 10 seconds) removes its tag and forgets itself, so the next try loads it again. `resetGis` is for tests.

export const GIS_SRC = 'https://accounts.google.com/gsi/client';

const LOAD_TIMEOUT_MS = 10_000;

/** A code client's answer to one press (Google's CodeResponse): a code, or Google's error. */
export interface CodeResponse {
  code?: string;
  scope?: string;
  state?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

/** The code model's config (Google's CodeClientConfig), the fields Townwise sets. */
export interface CodeClientConfig {
  client_id: string;
  scope: string;
  ux_mode: 'popup';
  include_granted_scopes: boolean;
  login_hint: string;
  state: string;
  callback: (response: CodeResponse) => void;
  /** `type` is `popup_failed_to_open`, `popup_closed` or `unknown`. */
  error_callback: (error: { type: string }) => void;
}

/** Google's CodeClient: `requestCode()` opens Google's window, and takes no arguments. */
export interface CodeClient {
  requestCode: () => void;
}

export interface Gis {
  accounts: {
    id: {
      initialize: (config: { client_id: string; callback: (response: { credential?: string }) => void }) => void;
      renderButton: (parent: HTMLElement, options: { text: 'continue_with'; width?: number }) => void;
    };
    /** Google's script always has it; GoogleConnect treats a `google` without it as a script that didn't load. */
    oauth2?: {
      initCodeClient: (config: CodeClientConfig) => CodeClient;
    };
  };
}

let loader: Promise<void> | null = null;
let loaded = false;

/** Removes the script and forgets every load, so the next loadGis adds a fresh tag. */
export function resetGis(): void {
  loader = null;
  loaded = false;
  document.querySelectorAll(`script[src="${GIS_SRC}"]`).forEach((node) => { node.remove(); });
}

/** What Google's script put on `window`, if it has loaded. */
export function gis(): Gis | undefined {
  return (window as Window & { google?: Gis }).google;
}

/** Whether the script has loaded, so a part mounted again needn't wait for loadGis's promise. */
export function gisLoaded(): boolean {
  return loaded;
}

/** Loads Google's script once: every caller gets the same promise until a load fails. */
export function loadGis(): Promise<void> {
  if (loader !== null) return loader;
  loader = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    const timer = setTimeout(() => { fail(new Error('timeout')); }, LOAD_TIMEOUT_MS);
    function fail(error: Error): void {
      clearTimeout(timer);
      script.remove();
      loader = null;
      reject(error);
    }
    script.addEventListener('load', () => {
      clearTimeout(timer);
      loaded = true;
      resolve();
    });
    script.addEventListener('error', () => { fail(new Error('load')); });
    document.head.append(script);
  });
  return loader;
}
