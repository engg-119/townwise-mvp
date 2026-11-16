import { Mono } from '../ui/text';
import { CALENDARS_COPY } from './calendars';

// Connecting a Google calendar on native (P28; connect-google-calendar design decision 15): native connects nowhere in
// this change. It lists, refreshes and removes Google calendars, and YourCalendars.tsx never offers "Add a Google
// calendar" there, so this file only answers the import web resolves to GoogleConnect.web.tsx, which takes the same
// props, and shows the line that points to the web if it is ever rendered. The siblings share only this type: on web a
// value exported here would resolve to the .web file itself, so their words are in calendars.ts.
// [CONFIRM: connecting a Google calendar on the web only]

export interface GoogleConnectProps {
  /** The public OAuth client id the calendar list answered (`google.clientId`), so Google's code is for the server's client. */
  clientId: string;
  /** The person's own email address, Google's `login_hint`: it goes only to Google's window, never a Townwise URL. */
  loginHint: string;
  /**
   * The `state` of the press Google's answer must carry, kept by YourCalendars: set in each press of "Continue to
   * Google", and null once an answer, "Stop waiting" or leaving the page has ended the wait, so a late answer is dropped.
   */
  expectedStateRef: { current: string | null };
  /** Google's window is open: "Waiting for Google…" and "Stop waiting" in place of "Continue to Google" and Cancel. */
  waiting: boolean;
  /** "Continue to Google" takes focus as it mounts: the section just opened, or a wait just ended. */
  focusContinue: boolean;
  /** Inside the press of "Continue to Google", before Google's window opens: the section waits. */
  onWait: () => void;
  /** Google's code for the current press, to post to the connect route. */
  onCode: (code: string) => void;
  /** Google's window closed or denied, or "Stop waiting": the explainer again, with no message. */
  onCancel: () => void;
  /** Google refused or its window was blocked: the explainer again, with these words. */
  onRefusal: (words: string) => void;
  /** The explainer's Cancel: the section closes. */
  onClose: () => void;
}

export const GoogleConnect: (props: GoogleConnectProps) => React.JSX.Element = () => <Mono>{CALENDARS_COPY.nativeLine}</Mono>;
