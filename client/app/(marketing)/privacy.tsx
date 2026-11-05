import { A, Code, Div, H1, H2, Li, Nav, P, Section, Span, Strong, Table, Tbody, Td, Th, Thead, Tr, Ul } from '../../src/marketing/html';
import { CONTACT_HREF } from '../../src/marketing/links';
import { MarketingShell } from '../../src/marketing/MarketingShell';

const Mail = (): React.JSX.Element => <A href={CONTACT_HREF}>hello@townwise.tech</A>;

const sections: { id: string; title: string; className?: string; body: React.ReactNode }[] = [
  {
    id: 'short',
    title: 'The short version',
    className: 'sec sum',
    body: (
      <Ul className="bul">
        <Li>You sign in with Google. We keep your email address, your Google account ID and the date your account was created. That is the whole account record.</Li>
        <Li>Two cookies keep you signed in. There are no advertising or analytics cookies.</Li>
        <Li>Our server logs each request: the address it came from, the browser or app that sent it, the page asked for and the result. The request log does not record your email address, your sign-in tokens, your cookies or what you send us.</Li>
        <Li>The Townwise app sends no telemetry: no analytics, no tracking, no crash reports. The sign-in page loads Google’s sign-in script, so Google sees that visit.</Li>
        <Li>The Townwise app has no place to upload sales data yet. Point-of-sale exports you send us directly are covered under “Your restaurant’s sales data” below.</Li>
      </Ul>
    ),
  },
  {
    id: 'who',
    title: 'Who we are',
    body: (
      <P>Townwise is a student project built in ENGG 119 at Dartmouth’s Thayer School of Engineering, in Hanover, NH. The operator responsible for your data is <Span className="chip">[OPERATOR LEGAL NAME]</Span>. Write to us at <Mail />.</P>
    ),
  },
  {
    id: 'signin',
    title: 'What we keep when you sign in',
    body: (
      <>
        <P>Townwise signs in with Google only. When you choose your Google account, Google gives the app a signed token that says who you are. Our server checks that token, then keeps three things in your account record:</P>
        <Div className="tbl" role="region" aria-label="What we keep in your account record" tabIndex={0}>
          <Table>
            <Thead><Tr><Th scope="col">What</Th><Th scope="col">Why</Th></Tr></Thead>
            <Tbody>
              <Tr><Td>Your email address, as Google reports it</Td><Td>To identify your account and to contact you about it</Td></Tr>
              <Tr><Td>Your Google account ID (a number Google assigns, not your password)</Td><Td>To recognize you the next time you sign in, even if your email changes</Td></Tr>
              <Tr><Td>The date your account was created</Td><Td>Record keeping</Td></Tr>
            </Tbody>
          </Table>
        </Div>
        <P>We do not keep your name, your photo or the Google token itself. The app holds the token only long enough to send it to our server once; the mobile app then clears Google’s sign-in session.</P>
        <P>Your account record is kept until it is deleted (see Your choices).</P>
        <P>Every sign-in needs a Google account whose email address Google says is verified. We create a new account, or link Google to an existing one, only for a Gmail address or a Google Workspace account. If the email on your Google account changes and Google is the authority for it, we update the email we keep at your next sign-in.</P>
        <P>On the web, the sign-in page loads Google’s sign-in script from accounts.google.com as soon as the page opens, so Google sees your visit to that page even if you never press the button. When you use the button, your browser talks to Google directly. Google’s own privacy policy covers both. Our server checks Google’s signature using Google’s published keys; it does not send your information back to Google.</P>
      </>
    ),
  },
  {
    id: 'sessions',
    title: 'Sessions',
    body: (
      <>
        <P>Each time you sign in, we create a session record so we can keep you signed in and let you sign out. It holds:</P>
        <Ul className="bul">
          <Li>your account ID and a session ID</Li>
          <Li>whether you signed in on the web or in the mobile app</Li>
          <Li>a one-way hash (SHA-256) of your current sign-in token and of the tokens it replaced, never the tokens themselves</Li>
          <Li>when the session started, when it was last used, when it expires, and, if it ended early, when and why (for example, you signed out)</Li>
        </Ul>
        <P>We do not store your IP address or your browser details in the session record.</P>
        <P>A session ends after 14 days without use, and in any case 30 days after you signed in. You then sign in again. Session records and the replaced-token hashes are deleted automatically one week after the session’s 30-day limit.</P>
      </>
    ),
  },
  {
    id: 'codes',
    title: 'Optional sign-in codes',
    body: (
      <>
        <P>The sign-in service supports a second step with codes from an authenticator app. If you turn it on, the code secret is stored encrypted (AES-256-GCM) and your recovery codes are stored only as one-way hashes. Recovery codes are shown to you once and are not kept anywhere in readable form. The record also notes when codes were turned on and which time step was used last, so an old code cannot be used twice.</P>
        <P>There is no way to turn codes off in the app yet. Write to us at <Mail /> from the email address on your account; we will confirm it is you before removing them. We keep the record until codes are removed or your account is deleted. An unconfirmed set-up is replaced if you start again and is otherwise kept until your account is deleted; it is not deleted automatically.</P>
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies',
    body: (
      <>
        <P>On the web, Townwise sets two cookies, both on our own domain, both to keep you signed in. Neither can be read by scripts on the page, and both are sent only over HTTPS.</P>
        <Div className="tbl wide" role="region" aria-label="Cookies Townwise sets" tabIndex={0}>
          <Table>
            <Thead><Tr><Th scope="col">Cookie</Th><Th scope="col">What it does</Th><Th scope="col">How long it lasts</Th><Th scope="col">Settings</Th></Tr></Thead>
            <Tbody>
              <Tr><Td><Code>__Host-access</Code></Td><Td>Proves to our server that you are signed in</Td><Td>10 minutes</Td><Td>HttpOnly, Secure, SameSite=Lax, Path=/</Td></Tr>
              <Tr><Td><Code>__Host-refresh</Code></Td><Td>Gets a fresh <Code>__Host-access</Code> cookie so you stay signed in</Td><Td>Until your session’s 30-day limit</Td><Td>HttpOnly, Secure, SameSite=Strict, Path=/</Td></Tr>
            </Tbody>
          </Table>
        </Div>
        <P>There are no advertising, analytics or tracking cookies. Signing out clears both cookies.</P>
        <P>The mobile app uses no cookies. It keeps its sign-in token in your device’s secure storage (the iOS Keychain or Android Keystore), keeps the short-lived token in memory only, and clears a leftover token the first time it runs after a fresh install.</P>
      </>
    ),
  },
  {
    id: 'logs',
    title: 'What our server logs',
    body: (
      <>
        <P>Every request to the Townwise server, except automated health checks, writes one log line with:</P>
        <Ul className="bul">
          <Li>a random request ID</Li>
          <Li>the request method and URL, with sensitive values in the URL (such as tokens, codes, keys and signatures) replaced before the line is written</Li>
          <Li>your IP address</Li>
          <Li>your user agent (the short text your browser or app sends to describe itself)</Li>
          <Li>the response status code and how long the response took</Li>
        </Ul>
        <P>Sign-in events (signed in, signed out, account created, code checks) also log your internal account ID or the session ID, the sign-in method and whether you used the web or the app.</P>
        <P>When a request fails because of a fault on our side, the server also logs the error: its type, its message, any error code and a stack trace (the lines of our code that were running), together with the request URL with sensitive values replaced. The logging code removes known sensitive details from database error messages, such as the duplicate value in a duplicate-key error.</P>
        <P>The request logger records only the fixed list of fields above. On top of that, the logging code removes fields named token, password, secret, recovery code, cookie and authorization from the top level of a log entry and one level down. The sign-in service never logs request bodies, and its own log lines carry your account ID, never your email address.</P>
        <P>Logs are written to the server’s standard output and kept by <Span className="chip">[HOSTING PROVIDER]</Span> for <Span className="chip">[LOG RETENTION PERIOD]</Span>.</P>
      </>
    ),
  },
  {
    id: 'rate',
    title: 'Rate limiting',
    body: (
      <>
        <P>To stop abuse, the server counts requests from each IP address: one limit for the whole service and a tighter one for sign-in, both over one-minute windows. Before a counter is stored, the key it belongs to (an IP address, an account ID or an email address) is replaced with a SHA-256 hash, so the store holds hashes, not addresses. IPv6 addresses are counted by their first half (the /64 network). Each counter is deleted when its window ends, counted from the first request in that window.</P>
        <P>If the email-link route is used (see Email), the request is also counted per IP address (hashed) for one hour, and per email address (hashed) for 15 minutes and for 24 hours.</P>
        <P>If you use authenticator codes, every code attempt is also counted per account, as a hash of your account ID, for 15 minutes and for 24 hours.</P>
        <P>A hash of an IP address is not anonymous: anyone who tries every possible address can match it. We treat these counters as personal data. The longest any IP-address counter is kept is one hour; the longest any account or email counter is kept is 24 hours.</P>
      </>
    ),
  },
  {
    id: 'telemetry',
    title: 'No telemetry',
    body: (
      <P>The Townwise app includes no analytics, tracking pixels, advertising SDKs or crash reporting. It does not log tokens, emails or request bodies, and it writes error details to the console only in development builds.</P>
    ),
  },
  {
    id: 'email',
    title: 'Email',
    body: (
      <>
        <P>Townwise does not send sign-in emails. If you write to <Mail />, we keep your message and address in <Span className="chip">[EMAIL PROVIDER]</Span> to reply to you and to manage early access.</P>
        <P>The sign-in service still includes an email-link route that Townwise does not use. If an email address is submitted to it, the service stores that address with a hashed one-time token, the platform and timestamps, and deletes the record automatically shortly after its 15 minutes are up, counts the attempt per IP address (hashed) for one hour and under a keyed hash of the address for up to 24 hours, and sends nothing.</P>
      </>
    ),
  },
  {
    id: 'sales',
    title: 'Your restaurant’s sales data',
    body: (
      <>
        <P>The Townwise app has no place to upload point-of-sale data today: the service mounts only sign-in. Forecasts are designed to be calibrated with each restaurant’s own sales history.</P>
        <P><Strong>Exports you send us directly.</Strong> During early access, a restaurant may send us point-of-sale exports outside the app. <Span className="chip">[DECISION NEEDED: how exports are stored, who can see them, how long they are kept, and whether they are shared or used for other restaurants]</Span></P>
        <P>Before any upload exists in the app, this section will also state what the app collects, where it is stored, who can see it and how long it is kept. <Span className="chip">[DECISION NEEDED]</Span></P>
      </>
    ),
  },
  {
    id: 'where',
    title: 'Where your data lives',
    body: (
      <P>Account, session, authenticator and email-link records are stored in a MongoDB database. Rate-limit counters are stored in a Redis-compatible store. Both are hosted by <Span className="chip">[HOSTING PROVIDER]</Span> in <Span className="chip">[HOSTING REGION]</Span>.</P>
    ),
  },
  {
    id: 'others',
    title: 'Who else sees it',
    body: (
      <>
        <Ul className="bul">
          <Li><Strong>Google</Strong>, when you open the sign-in page (its sign-in script loads there) and when you sign in with your Google account, under Google’s privacy policy.</Li>
          <Li><Strong><Span className="chip">[HOSTING PROVIDER]</Span></Strong>, which runs our servers and stores our database and logs.</Li>
          <Li><Strong><Span className="chip">[EMAIL PROVIDER]</Span></Strong>, if you write to us.</Li>
          <Li><Strong>Anthropic</Strong>, which provides the AI model behind the tuning chat. When you use the chat, Anthropic receives the messages you send and the location data the assistant reads to answer them: the location’s name and town, its sales totals and daily figures, its notes and its town profile. <Span className="chip">[DECISION NEEDED: how long Anthropic keeps chat data, and whether it may be used to train models]</Span></Li>
        </Ul>
        <P>Apart from Google’s sign-in script on the sign-in page, the Townwise app and server send your account and sign-in information to no one else. Sales data exports are covered under “Your restaurant’s sales data”. <Span className="chip">[DECISION NEEDED: commit in writing that Townwise does not sell personal data.]</Span></P>
      </>
    ),
  },
  {
    id: 'choices',
    title: 'Your choices',
    body: (
      <>
        <Ul className="bul">
          <Li><Strong>Sign out</Strong> at any time; that ends the session and clears the cookies.</Li>
          <Li><Strong>Delete your account:</Strong> there is no self-serve deletion yet. Write to <Mail /> and we will delete your account record, sessions and any authenticator record within <Span className="chip">[DELETION TIMEFRAME]</Span>. Log lines expire on the retention schedule above.</Li>
          <Li><Strong>If your access ends:</Strong> <Span className="chip">[DECISION NEEDED: whether account data is deleted automatically when early access ends or an account is closed, and on what schedule, or only on request]</Span></Li>
          <Li><Strong>Questions or corrections:</Strong> <Mail />.</Li>
        </Ul>
        <P><Span className="chip">[DECISION NEEDED: rights under specific laws, age limits, and the process for requests]</Span></P>
      </>
    ),
  },
  {
    id: 'changes',
    title: 'Changes',
    body: (
      <P>If we change how Townwise handles your data, we will update this page and the date at the top before the change takes effect. <Span className="chip">[DECISION NEEDED: whether to email account holders about material changes.]</Span></P>
    ),
  },
];

export default function Privacy(): React.JSX.Element {
  return (
    <MarketingShell title="Townwise Privacy">
      <Div className="pg-privacy">
        <Div className="wrap">
          <Div className="g12 hd">
            <Div className="hd-l">
              <H1 className="h1">Privacy</H1>
              <P className="sub">Effective <Span className="chip">[EFFECTIVE DATE]</Span>. Last updated <Span className="chip">[LAST UPDATED DATE]</Span>.</P>
            </Div>
            <Nav className="hd-r" aria-labelledby="h-toc">
              <P id="h-toc" className="eyebrow">On this page</P>
              <Ul className="toc">
                {sections.map((section) => <Li key={section.id}><A href={`#${section.id}`}>{section.title}</A></Li>)}
              </Ul>
            </Nav>
          </Div>
        </Div>
        {/* Heading ids carry a pv- prefix: screens stay mounted in the stack, and About and Security use h-who, h-where, h-signin and h-sessions. */}
        {sections.map((section) => (
          <Section key={section.id} id={section.id} className={section.className ?? 'sec'} aria-labelledby={`pv-${section.id}`} tabIndex={-1}>
            <Div className="wrap">
              <Div className="g12">
                <Div className="c-l"><H2 id={`pv-${section.id}`} className="h3">{section.title}</H2></Div>
                <Div className="c-r"><Div className="prose">{section.body}</Div></Div>
              </Div>
            </Div>
          </Section>
        ))}
      </Div>
    </MarketingShell>
  );
}
