import { A, Code, Div, H1, H2, Li, Nav, P, Section, Strong, Table, Tbody, Td, Th, Thead, Tr, Ul } from '../../src/marketing/html';
import { CONTACT_EMAIL, CONTACT_HREF } from '../../src/marketing/links';
import { MarketingShell } from '../../src/marketing/MarketingShell';

const Mail = (): React.JSX.Element => <A href={CONTACT_HREF}>{CONTACT_EMAIL}</A>;

// Anthropic's own terms for API data (checked 2026-11-05: “Anthropic may not train models on Customer Content
// from Services”, where Customer Content is the inputs and outputs).
const ANTHROPIC_TERMS_HREF = 'https://www.anthropic.com/legal/commercial-terms';

const sections: { id: string; title: string; className?: string; body: React.ReactNode }[] = [
  {
    id: 'short',
    title: 'The short version',
    className: 'sec sum',
    body: (
      <Ul className="bul">
        <Li>You sign in with Google. Your account record holds your email address, your Google account ID and the date it was created.</Li>
        <Li>Two cookies keep you signed in. There are no advertising or analytics cookies.</Li>
        <Li>Our server logs each request: the address it came from, the browser or app that sent it, the page asked for and the result. The request log does not record your email address, your sign-in tokens, your cookies or what you send us.</Li>
        <Li>The Townwise app sends no telemetry: no analytics, no tracking, no crash reports. The sign-in page loads Google’s sign-in script, so Google sees that visit.</Li>
        <Li>Townwise sends two emails, each only to the person it concerns: one when we receive your access request and one when you’re approved. Open and click tracking is off.</Li>
        <Li>You add sales history one of two ways. Drop your files, and we store them privately for your organization and read the date, guest count and net sales for each day on our server. Or have your browser read a CSV, and it sends us only those three values a day; that file never reaches our server.</Li>
        <Li>Your sales data is used only to provide Townwise to your restaurant: its own forecasts and TownwiseAI, its AI assistant. It is not shared with or used for other restaurants, and it is not used to train AI models.</Li>
        <Li>Townwise does not sell personal data.</Li>
      </Ul>
    ),
  },
  {
    id: 'who',
    title: 'Who we are',
    body: (
      <P>Townwise is a student project. The operator responsible for your data is the Townwise team, a group of students in ENGG 119, AI in the Real World, at Dartmouth’s Thayer School of Engineering in Hanover, NH. Townwise is not an official Dartmouth product. Write to us at <Mail />.</P>
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
              <Tr><Td>Your email address, as Google reports it</Td><Td data-l="Why">To identify your account and to contact you about it</Td></Tr>
              <Tr><Td>Your Google account ID (a number Google assigns, not your password)</Td><Td data-l="Why">To recognize you the next time you sign in, even if your email changes</Td></Tr>
              <Tr><Td>The date your account was created</Td><Td data-l="Why">Record keeping</Td></Tr>
            </Tbody>
          </Table>
        </Div>
        <P>We do not keep the name or photo on your Google account, or the Google token itself. The app holds the token only long enough to send it to our server once; the mobile app then clears Google’s sign-in session.</P>
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
              <Tr><Td><Code>__Host-access</Code></Td><Td data-l="What it does">Proves to our server that you are signed in</Td><Td data-l="How long it lasts">10 minutes</Td><Td data-l="Settings">HttpOnly, Secure, SameSite=Lax, Path=/</Td></Tr>
              <Tr><Td><Code>__Host-refresh</Code></Td><Td data-l="What it does">Gets a fresh <Code>__Host-access</Code> cookie so you stay signed in</Td><Td data-l="How long it lasts">Until your session’s 30-day limit</Td><Td data-l="Settings">HttpOnly, Secure, SameSite=Strict, Path=/</Td></Tr>
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
        <P>The app’s own log lines, for actions such as uploads and view-as, carry ids and counts only, never your email address, names, sales figures or note text.</P>
        <P>Logs are written to the server’s standard output and kept by Microsoft Azure for 30 days. Members of our Townwise administrators and developers groups can read them.</P>
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
        <P>When you are signed in, some actions are also counted per account, as a hash of your account ID: every change for 10 minutes; uploads, TownwiseAI messages and staff view-as for one hour; and access requests for 24 hours.</P>
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
        <P>Townwise sends two emails, each only to the person it concerns: “request received”, after you send an access request, and “you’re in”, after Townwise staff approve it. They come from no-reply@townwise.tech through Microsoft’s Azure Communication Services, with open and click tracking off. Each holds your organization’s name, its town and the address you sign in with, never sales figures, files or notes. Townwise sends no other email, for sign-in, invitations or anything else.</P>
        <P>Townwise keeps nothing about a send except one line in our server log: which email it was, the ids of the access request and, for “you’re in”, the organization, and an error code if it failed, never your address. Microsoft keeps its own delivery records. If you reply to one of these emails or write to <Mail />, we keep your message and address to reply to you.</P>
        <P>The sign-in service still includes an email-link route that Townwise does not use. If an email address is submitted to it, the service stores that address with a hashed one-time token, the platform and timestamps, and deletes the record automatically shortly after its 15 minutes are up, counts the attempt per IP address (hashed) for one hour and under a keyed hash of the address for up to 24 hours, and sends nothing.</P>
      </>
    ),
  },
  {
    id: 'org',
    title: 'Your organization and team',
    body: (
      <Ul className="bul">
        <Li><Strong>Access requests.</Strong> To request access, you sign in with Google and fill in a short form: your organization’s name, your name, your role, your town, how many locations you have and an optional note. We keep it with your email address at the time and the request’s status. Townwise staff read it to decide on it. If they turn it down, they may add a message, which you see.</Li>
        <Li><Strong>Your team.</Strong> An org admin can add teammates by email address, each with a role. We keep each address on the team, with its role and who added it, even before that person signs in. Townwise does not email them. Org admins can see the team; members cannot.</Li>
        <Li><Strong>Locations.</Strong> Each location’s name and town and, if you picked the business on Google, Google’s id for that place. We don’t keep its address or anything else Google sends.</Li>
        <Li><Strong>The welcome.</Strong> When you first open Townwise after approval, we note that we showed you the welcome, and when. It’s deleted with your organization or your account.</Li>
        <Li><Strong>Your name.</Strong> If you tell Townwise what to call you, we keep that name with your account and use it only to greet you in the app. Until you do, we use the first name from your access request, if you sent one. Change or clear it in Settings. It’s deleted with your account.</Li>
        <Li><Strong>Notes.</Strong> Notes about unusual days: the kind, the dates and weekdays, the expected effect and number of guests, a detail of up to 280 characters, and who wrote it. Everyone on your organization’s team can see them. Home and Analytics show them beside your days, and TownwiseAI reads them.</Li>
        <Li><Strong>TownwiseAI conversations.</Strong> If you use TownwiseAI, we keep your conversations for each location. They are private to you, except that Townwise staff using view-as as you can read them. If you rate a reply, we keep the rating with the conversation: helpful or not, and a reason you pick from a short list. We keep them until your account or your organization is deleted. When TownwiseAI proposes a note, we also keep whether you saved it or set it aside; the proposal’s wording stays only in your conversation, and in your notes if you save it.</Li>
        <Li><Strong>TownwiseAI’s questions.</Strong> TownwiseAI asks about days with no sales, worked out from the location’s sales days and notes. When someone on your team answers, we keep the answer for that location, and answering that you were closed saves a closure note. Answers are deleted with the location’s sales data, the location or the organization.</Li>
        <Li><Strong>The audit record.</Strong> We record changes: who did what and when, such as who added a teammate, uploaded sales, wrote a note or started a view-as, with the reason given. It holds email addresses, organization and location names, and view-as reasons. It never holds sales figures, note text, request notes or decision messages. Org admins can see every Townwise staff action on their organization. Audit records are not deleted; when a person or an organization is deleted, their email address or names in it are replaced.</Li>
      </Ul>
    ),
  },
  {
    id: 'sales',
    title: 'Your restaurant’s sales data',
    body: (
      <>
        <P><Strong>What an upload sends.</Strong> There are two ways to add a location’s history in the app.</P>
        <Ul className="bul">
          <Li><Strong>Drop your files.</Strong> You can drop many files at once: point-of-sale exports, spreadsheets, ZIP archives, PDFs and Word documents. Each file goes as it is, over HTTPS, to our server, which stores it privately for your organization. The file’s name travels only inside the upload, never in a web address, and it is not logged. Our server opens ZIP archives and reads tables from PDFs and Word documents, and takes from them only the date, guest count and net sales for each day. Notes and other text in your files are stored but never read. A file Townwise can’t use is kept and listed as “kept, not used” with the reason.</Li>
          <Li><Strong>Read it in your browser.</Strong> Your browser reads a CSV export and sends us only the date, guest count and net sales for each day, for one location. That file never reaches our server, and neither do its name or its other columns.</Li>
        </Ul>
        <P><Strong>What we keep.</Strong> For each location, one record per day with the date, guests and net sales. For each upload, who sent it, when, how many days it added or replaced, and its first and last dates. For a file you drop, we also keep the original as you sent it, a cleaned copy with only the date, guests and net sales, its name (shown only to your organization), and a short report of the column headings and counts it found, never the values in its rows. For a ZIP, we keep the names of the files inside and what happened to each. A file read in your browser leaves no name with us.</P>
        <P><Strong>Your files are personal data too.</Strong> Point-of-sale exports can hold diner names and phone numbers, server names and card details. We never read those fields, and only the three values a day leave a file. Originals sit in a private Azure storage account that has no public internet address: only our server can reach it, and every read, write and delete there is recorded.</P>
        <P><Strong>How we use it.</Strong> Your sales data is used only to provide Townwise to your restaurant: its own forecasts and TownwiseAI, its AI assistant. It is not shared with or used for other restaurants, and it is not used to train AI models.</P>
        <P><Strong>Who can see it.</Strong></P>
        <Ul className="bul">
          <Li>The members and org admins of your organization.</Li>
          <Li>Townwise staff, in the staff console, see your organization’s name, its locations’ names and towns, team email addresses, counts and the dates your data covers. They do not see the sales figures or your location notes there, and these console views are not recorded.</Li>
          <Li>Townwise staff can see the sales figures and your location notes only through view-as: a read-only view of the app as one of your team sees it. It needs a reason, lasts at most 30 minutes, is recorded, and is shown to your organization’s admins.</Li>
          <Li>Members of our Townwise administrators group, who manage the production systems, can reach the database outside the app. Townwise’s audit record does not include those reads.</Li>
        </Ul>
        <P><Strong>How long we keep it.</Strong> Until an org admin deletes it (in the app, an org admin can delete all sales data for a location), or until we delete your organization’s account on request (see Your choices). Our nightly backups keep copies for 30 days. For files you drop: we delete each original 365 days after it was sent, or sooner when you delete it; cleaned copies stay until you delete them, the location’s sales data or your organization; an upload that never finishes is discarded after 24 hours, and a file dropped but never sent for reading after 30 days. Deleting all sales data for a location deletes its files too.</P>
      </>
    ),
  },
  {
    id: 'where',
    title: 'Where your data lives',
    body: (
      <P>Account, session, authenticator and email-link records, and everything the app keeps for your organization, are stored in a MongoDB-compatible database, Azure DocumentDB. Rate-limit counters are kept in memory by a Redis-compatible store (Valkey) that runs beside our server and saves nothing to disk. Both run on Microsoft Azure, in its East US region, and the database’s nightly backups are stored there too. Files you drop are stored in a private Azure storage account in the same region, in a space of their own for each organization.</P>
    ),
  },
  {
    id: 'others',
    title: 'Who else sees it',
    body: (
      <>
        <Ul className="bul">
          <Li><Strong>Google</Strong>, when you open the sign-in page (its sign-in script loads there) and when you sign in with your Google account, under Google’s privacy policy. When you search for your business, on the access request or when adding or changing a location, our server sends Google the text you type and the place you pick, and checks the picked place’s town with Google once more when a location is saved. Google sees our server, not your device. When a found place shows a map, your browser or app loads the map image straight from Google, so Google sees your IP address. We keep only Google’s id for the place.</Li>
          <Li><Strong>Microsoft Azure</Strong>, which runs our servers and stores our database, its backups, our logs and the files you drop, and delivers our two emails through Azure Communication Services, which receives your address and the email’s content.</Li>
          <Li><Strong>Anthropic</Strong>, which provides the AI model behind TownwiseAI, the assistant on each location’s TownwiseAI page. Nothing is sent to Anthropic unless you use it. When you do, Anthropic receives the messages you send and the location data the assistant reads to answer them: the location’s name and town, its sales totals and daily figures, its notes, its town profile and public facts about its town (its calendar, and who is likely in town, with the public sources behind them). TownwiseAI never reads your files, and Townwise never sends it your team’s names or email addresses. Separately, when you drop a file and Townwise’s own rules can’t find its guest or net sales columns, our server may send Anthropic the file’s column headings and the kinds of values in each column, never its rows, its name or your restaurant’s name, to suggest which is which; otherwise it asks you. Anthropic processes them under its <A href={ANTHROPIC_TERMS_HREF}>Commercial Terms of Service</A>, which say Anthropic may not train models on that content.</Li>
        </Ul>
        <P>Apart from Google’s sign-in script on the sign-in page and the two emails Microsoft delivers, the Townwise app and server send your account and sign-in information to no one else. Townwise does not sell personal data.</P>
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
          <Li><Strong>Delete your account:</Strong> there is no self-serve deletion yet. Write to <Mail /> and we will delete your account and its data within 30 days: your account record, your name, sessions, any authenticator record, your access requests and invitations, your place on a team and your TownwiseAI conversations. Notes and uploads you added stay with your organization. In the audit record, your email address is replaced with “deleted person”. Log lines expire on the retention schedule above.</Li>
          <Li><Strong>Delete your organization:</Strong> an org admin can ask us the same way to delete the organization’s account and its data, and we will do it within 30 days: its locations, sales data, uploads, notes, team, TownwiseAI conversations and answers to TownwiseAI’s questions. In the audit record, its name and its locations’ names are replaced.</Li>
          <Li><Strong>Your files:</Strong> on Sales data your team can download a file’s original or its cleaned copy and, where your role allows, delete the original or the whole file; an org admin can delete all originals for a location at once and keep the cleaned daily totals. If someone whose details appear in your files, such as a diner, asks us to delete them, we delete your organization’s originals and keep the cleaned totals. Townwise staff using view-as see your files’ kinds and dates, not their names, and cannot download them.</Li>
          <Li><Strong>Backups:</Strong> our nightly backups are kept for 30 days and then deleted, so deleted data can remain in a backup until then. A deleted file can be recovered by us for 7 days, then it is gone.</Li>
          <Li><Strong>If your access ends:</Strong> your account record and your organization’s data are not deleted automatically. You can ask us to delete them, and we will within 30 days, as above.</Li>
          <Li><Strong>Questions or corrections:</Strong> <Mail />.</Li>
        </Ul>
        <P>To ask what data we hold about you, or to have it corrected or deleted, write to <Mail />. We will answer within 30 days. Townwise is for businesses, used by people 18 or older acting for them.</P>
      </>
    ),
  },
  {
    id: 'changes',
    title: 'Changes',
    body: (
      <P>If we change how Townwise handles your data, we will update this page and the date at the top before the change takes effect.</P>
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
              <P className="sub">Effective November 5, 2026. Last updated November 9, 2026.</P>
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
