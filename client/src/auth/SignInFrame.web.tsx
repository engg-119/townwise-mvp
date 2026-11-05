import { useId } from 'react';

import { MarketingShell } from '../marketing/MarketingShell.web';
import type { SignInFrameProps } from './SignInFrame';

// Web sign-in inside the site's header and footer (SignIn.dc.html): the wordmark, title and lead on the
// left with the card beside them from 1220px, then the early-access line and the legal links. Its CSS is
// the .pg-signin block of styles.web.ts.
export function SignInFrame(props: SignInFrameProps): React.JSX.Element {
  const id = useId();
  return (
    <MarketingShell title="Townwise Sign in">
      <section className="pg-signin" aria-labelledby={`${id}h`}>
        <div className="wrap">
          <div className="g12 hd">
            <div className="hd-l">
              <div className="wm-row"><a className="wm" href="/">Townwise</a></div>
              <h1 id={`${id}h`} className="h1">{props.title}</h1>
              <p className="sub">{props.lead}</p>
            </div>
            <div className="hd-r"><div className="card">{props.children}</div></div>
            <div className="c-all">
              <div className="access">
                {props.note === undefined ? null : <p>{props.note}</p>}
              </div>
              <ul className="legal-row" aria-label="Legal">
                <li><a className="tl" href="/privacy">Privacy</a></li>
                <li><a className="tl" href="/terms">Terms</a></li>
                <li><a className="tl" href="/security">Security</a></li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
