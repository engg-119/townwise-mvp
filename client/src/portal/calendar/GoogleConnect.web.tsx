import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { gis, gisLoaded, loadGis, type CodeResponse } from '../../auth/gis.web';
import { Actions, Button } from '../ui/Button';
import { Messages } from '../ui/feedback';
import { Small } from '../ui/text';
import { GOOGLE_COPY } from './calendars';
import type { GoogleConnectProps } from './GoogleConnect';

// Connecting a Google account on web (P28; connect-google-calendar design decisions 2, 3 and 15), inside the Google
// section of the "Your calendars" popover (YourCalendars.tsx), which posts the code. It loads Google's script through
// the shared loader (auth/gis.web.ts) only when it mounts, so Google sees nothing of the Calendar until the person opens
// "Add a Google calendar": "Continue to Google" reads "Loading Google…", disabled in place, until the script has loaded,
// and a load that fails says "Google’s sign-in didn’t load. Try again." with Try again. Each press of "Continue to
// Google" makes a fresh `state` of 128 random bits (crypto.getRandomValues) and, inside the press so Google's window
// comes from a user gesture, sets up Google's code client and calls `requestCode()`. A code client is set up for each
// press, since `requestCode()` takes no arguments and `state` is part of the client's config (Google's reference,
// read 2026-11-16): `initCodeClient` with the list's client id, exactly the scopes `openid`,
// `calendar.calendarlist.readonly` and `calendar.events.readonly`, `ux_mode: 'popup'`, `include_granted_scopes: false`
// (the token Townwise keeps grants these three alone, not sign-in's) and the person's email as `login_hint`. An answer
// counts only while its press's `state` is the one YourCalendars waits on (`expectedStateRef`): one whose `state`
// differs, or that arrives after "Stop waiting", is dropped and nothing is posted. Every answer for the current press
// ends the wait: a code is handed on (`onCode`); `popup_closed` and `access_denied` end it with no message
// (`onCancel`); `popup_failed_to_open` says the pop-up words; any other error, from the callback or the error
// callback's `unknown`, says "Google didn’t connect Townwise. Try again." and never Google's own `error_description`
// (`onRefusal`). While Google's window is open it shows "Waiting for Google…" and "Stop waiting", which forgets the
// press, so a window that never answers can't hold the popover; while the code is posted the line reads "Connecting
// your Google account…" and "Stop waiting" stays in place, disabled, so focus stays on it until the picker or the
// explainer takes it. "Continue to Google" (and "Loading Google…" before it) is described by the explainer, since its
// press is the person's agreement and focus lands on it past the explainer. Native has its own file (GoogleConnect.tsx).

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
].join(' ');

type Load = 'loading' | 'ready' | 'failed';

/** Whether Google's script is ready: loaded, with its OAuth part, which a `google` without counts as not loaded. */
function readyOrFailed(): Load {
  return gis()?.accounts.oauth2 === undefined ? 'failed' : 'ready';
}

function initialLoad(): Load {
  return gisLoaded() ? readyOrFailed() : 'loading';
}

/** A press's `state`: 128 random bits, as hex. */
function freshState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What Google's answer to the current press means. */
type Outcome = { kind: 'code'; code: string } | { kind: 'cancel' } | { kind: 'refusal'; words: string };

/** The code client's callback: a code, the person's no, or any other error, whose description is never read. */
function outcomeOfResponse(response: CodeResponse): Outcome {
  if (response.error === undefined && typeof response.code === 'string' && response.code !== '') return { kind: 'code', code: response.code };
  if (response.error === 'access_denied') return { kind: 'cancel' };
  return { kind: 'refusal', words: GOOGLE_COPY.notConnected };
}

/** The error callback: `popup_closed`, `popup_failed_to_open`, or `unknown` and anything Google adds later. */
function outcomeOfError(type: string): Outcome {
  if (type === 'popup_closed') return { kind: 'cancel' };
  if (type === 'popup_failed_to_open') return { kind: 'refusal', words: GOOGLE_COPY.popupBlocked };
  return { kind: 'refusal', words: GOOGLE_COPY.notConnected };
}

export function GoogleConnect(props: GoogleConnectProps): React.JSX.Element {
  const { expectedStateRef } = props;
  const [load, setLoad] = useState<Load>(initialLoad);
  // The latest props, for Google's callbacks, which a press set up with the props of its own render.
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });

  useEffect(() => {
    if (load !== 'loading') return;
    let live = true;
    loadGis().then(
      () => { if (live) setLoad(readyOrFailed()); },
      () => { if (live) setLoad('failed'); },
    );
    return () => { live = false; };
  }, [load]);

  /** Hands on an answer for `state` while it is still the press the section waits on; drops any other. */
  function settle(state: string, outcome: Outcome): void {
    if (expectedStateRef.current !== state) return;
    expectedStateRef.current = null;
    const current = latest.current;
    if (outcome.kind === 'code') current.onCode(outcome.code);
    else if (outcome.kind === 'cancel') current.onCancel();
    else current.onRefusal(outcome.words);
  }

  function press(): void {
    const oauth2 = gis()?.accounts.oauth2;
    if (oauth2 === undefined) {
      setLoad('failed');
      return;
    }
    const state = freshState();
    expectedStateRef.current = state;
    const client = oauth2.initCodeClient({
      client_id: props.clientId,
      scope: SCOPES,
      ux_mode: 'popup',
      include_granted_scopes: false,
      login_hint: props.loginHint,
      state,
      callback: (response) => { if (response.state === state) settle(state, outcomeOfResponse(response)); },
      error_callback: (error) => { settle(state, outcomeOfError(error.type)); },
    });
    // Waiting first: a blocked window may answer inside requestCode, and that answer must end this wait.
    props.onWait();
    client.requestCode();
  }

  function stopWaiting(): void {
    expectedStateRef.current = null;
    props.onCancel();
  }

  if (props.waiting || props.connecting) {
    return (
      <>
        <Small white>{props.connecting ? GOOGLE_COPY.connecting : GOOGLE_COPY.waiting}</Small>
        <Actions>
          <Button variant="link" label={GOOGLE_COPY.stopWaiting} disabled={props.connecting} focusOnMount onPress={stopWaiting} />
        </Actions>
      </>
    );
  }
  if (load === 'failed') {
    return (
      <>
        <Messages live="alert" items={[GOOGLE_COPY.loadFailed]} />
        <Actions>
          <Button variant="outline" label="Try again" focusOnMount onPress={() => { setLoad('loading'); }} />
          <Button variant="link" label="Cancel" onPress={props.onClose} />
        </Actions>
      </>
    );
  }
  return (
    <Actions>
      <Button
        variant="outline"
        label={load === 'ready' ? GOOGLE_COPY.continue : GOOGLE_COPY.loadingGoogle}
        disabled={load !== 'ready'}
        describedBy={props.describedBy}
        focusOnMount={props.focusContinue}
        onPress={press}
      />
      <Button variant="link" label="Cancel" onPress={props.onClose} />
    </Actions>
  );
}
