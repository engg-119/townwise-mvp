import { A, Code, Div, H1, H2, Li, P, Section, Span, Strong, Ul } from '../../src/marketing/html';
import { MarketingShell } from '../../src/marketing/MarketingShell';

const parts: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: 'h-think',
    title: 'How we think about it',
    body: (
      <Div className="prose">
        <P className="lede">Townwise is early, and small. We keep as little as we can, and we built sign-in on a module that lists each threat it defends against next to the automated test that checks it. The sign-in service is in beta until its remaining manual security checks are done.</P>
      </Div>
    ),
  },
  {
    id: 'h-signin',
    title: 'Sign-in',
    body: (
      <Ul className="pts">
        <Li><P><Strong>Google only.</Strong> There are no Townwise passwords to steal or reuse.</P></Li>
        <Li><P><Strong>One way to check a Google token.</Strong> Our server accepts a Google sign-in token only if it was issued by Google, signed with Google’s RS256 keys, made for Townwise’s own client ID, and carries a verified email. A token made for any other app is refused.</P></Li>
        <Li><P><Strong>Accounts follow your Google account ID,</Strong> not just your email address, and we link or update an email only when Google is the authority for it (Gmail or Google Workspace).</P></Li>
        <Li><P><Strong>Optional authenticator codes.</Strong> The service supports a second step with codes from an authenticator app, with limits on guesses (counted before each check), no reuse of an old code, and one-time recovery codes.</P></Li>
      </Ul>
    ),
  },
  {
    id: 'h-sessions',
    title: 'Sessions',
    body: (
      <Ul className="pts">
        <Li><P><Strong>Short-lived access.</Strong> The token that proves you are signed in lasts 10 minutes.</P></Li>
        <Li><P><Strong>Rotating refresh tokens.</Strong> The longer-lived token is replaced every time it is used. If a replaced token is presented again after a short grace period (there to cover a reply lost on a bad connection), or if an older one ever is, we treat it as stolen and end the session.</P></Li>
        <Li><P><Strong>Checked on every request.</Strong> A session you sign out of stops working on the next request, not when a token happens to expire.</P></Li>
        <Li><P><Strong>Hard limits.</Strong> A session ends after 14 days unused, and 30 days after sign-in no matter what.</P></Li>
        <Li><P><Strong>An outage doesn’t sign you out.</Strong> If our database is unreachable, requests fail with a server error instead of ending your session.</P></Li>
      </Ul>
    ),
  },
  {
    id: 'h-browser',
    title: 'In your browser',
    body: (
      <Ul className="pts">
        <Li><P>Session tokens live only in two <Code>__Host-</Code> cookies that page scripts cannot read, sent only over HTTPS. On the web, no session token is ever placed in page storage or in a response body.</P></Li>
        <Li><P>Browser requests that change anything must come from an allowed Townwise origin, checked by exact match, which blocks cross-site request forgery.</P></Li>
      </Ul>
    ),
  },
  {
    id: 'h-mobile',
    title: 'In the mobile app',
    body: (
      <Ul className="pts">
        <Li><P>The sign-in token is kept in the iOS Keychain or Android Keystore, available only on that device. The short-lived token stays in memory.</P></Li>
        <Li><P>The app never relies on the phone’s cookie jar, and it sends its credentials only to the Townwise server.</P></Li>
        <Li><P>The app sends no telemetry.</P></Li>
      </Ul>
    ),
  },
  {
    id: 'h-stored',
    title: 'Stored data',
    body: (
      <Ul className="pts">
        <Li><P>Refresh tokens are stored only as SHA-256 hashes, so a copy of the database contains no working sign-in tokens.</P></Li>
        <Li><P>Authenticator secrets are encrypted with AES-256-GCM, bound to the account they belong to. Recovery codes are stored as hashes.</P></Li>
        <Li><P>Signing and encryption keys can be rotated without signing anyone out.</P></Li>
        <Li><P>Rate-limit counters store a SHA-256 hash of the IP address, not the address.</P></Li>
      </Ul>
    ),
  },
  {
    id: 'h-server',
    title: 'The server',
    body: (
      <Ul className="pts">
        <Li><P>Every request body is checked against a schema before it is used; database queries are sanitized against operator injection.</P></Li>
        <Li><P>The server refuses to start in production with insecure settings, such as plain-HTTP or localhost addresses.</P></Li>
        <Li><P>Error responses never include stack traces or internal messages.</P></Li>
        <Li><P>Logs record only a fixed list of request fields, remove tokens, secrets, cookies and credential headers by name, and replace tokens and codes in URLs before a line is written.</P></Li>
        <Li><P>Requests are rate limited per IP address across the whole service, with tighter limits on sign-in.</P></Li>
      </Ul>
    ),
  },
  {
    id: 'h-hosting',
    title: 'Hosting',
    body: (
      <Div className="prose">
        <P>Hosting has not been chosen. When it is, this section will say where the servers run, how data is encrypted at rest and in transit there, and who has access. <Span className="chip">[DECISION NEEDED]</Span></P>
      </Div>
    ),
  },
  {
    id: 'h-report',
    title: 'Report a problem',
    body: (
      <Div className="prose">
        <P>If you think you’ve found a security issue, write to <Span className="chip">[SECURITY CONTACT]</Span>. Tell us what you found and how to reproduce it. Please give us a chance to fix it before you share it. We are students and will answer as fast as we can; we do not offer a bug bounty.</P>
        <P>This page does not give permission to test the service. The <A href="/terms">Terms</A> forbid security testing without our written permission.</P>
        <P><Span className="chip">[DECISION NEEDED: security contact, security.txt, response time, safe harbor]</Span></P>
      </Div>
    ),
  },
];

export default function PublicSecurity(): React.JSX.Element {
  return (
    <MarketingShell title="Townwise Security">
      <Div className="pg-security">
        <Section className="pg" aria-labelledby="h-hero">
          <Div className="wrap">
            <Div className="g12 hd">
              <Div className="hd-l">
                <P className="eyebrow">Townwise</P>
                <Div className="h1w"><H1 id="h-hero" className="h1">Security</H1></Div>
                <P className="eyebrow updated">Last updated <Span className="chip">[LAST UPDATED DATE]</Span></P>
                <P className="settings"><A className="tl" href="/settings/security">Two-factor settings</A></P>
              </Div>
            </Div>
          </Div>
        </Section>
        {parts.map((part, index) => (
          <Section key={part.id} className="sec" aria-labelledby={part.id}>
            <Div className="wrap">
              <Div className="g12">
                <Div className="c-l lead-l">
                  <P className="eyebrow">{String(index + 1).padStart(2, '0')}</P>
                  <H2 id={part.id} className="h2">{part.title}</H2>
                </Div>
                <Div className="c-r">{part.body}</Div>
              </Div>
            </Div>
          </Section>
        ))}
      </Div>
    </MarketingShell>
  );
}
