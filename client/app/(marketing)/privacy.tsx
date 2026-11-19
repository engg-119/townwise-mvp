import { A, Code, Div, H1, H2, Li, Nav, P, Section, Strong, Table, Tbody, Td, Th, Thead, Tr, Ul } from '../../src/marketing/html';
import { CONTACT_EMAIL, CONTACT_HREF } from '../../src/marketing/links';
import { MarketingShell } from '../../src/marketing/MarketingShell';

const Mail = (): React.JSX.Element => <A href={CONTACT_HREF}>{CONTACT_EMAIL}</A>;

// [CONFIRM: wording of the training promise now that the lab retrains each location’s own forecast model] The “How we use it”
// sentence (here and in the short version) and Terms section 1 say the data trains only that location’s forecast model; the
// homepage answer (Home.web.tsx) still says “not used to train AI models” and is the owner’s call.
// [CONFIRM: wording for staff-imported forecasts] The Forecasts paragraph’s sentence on a forecast staff import (built on the
// team’s computers from exports the owner sent, its model kept by staff until deletion; infra/README.md, Forecasts).
// [CONFIRM: forecasts paragraph for autonomous forecasts, awaiting the owner] The Forecasts paragraph (forecasts on for every
// organization, weekly refits from 230 days, the model or the baseline, D42) and the Files you let TownwiseAI read sentence on
// when a forecast update goes live. docs/portal/estimates.md section 5 carries the same paragraph.
// [CONFIRM: Townwise keeps the dates on which each signed-in person used the app, for 180 days] The line in The short version
// and in What we keep when you sign in, and the dates in Delete your account (OpenSpec change staff-overview, design
// decision 6; the owner agreed 2026-11-17).
// [CONFIRM: privacy wording for files attached to a TownwiseAI message and for chat ordering setup suggestions, shipped
// unapproved by the owner on 2026-11-18] The “Files you attach to a TownwiseAI message” paragraph, the first sentences of
// “Files you let TownwiseAI read”, the last sentence of the TownwiseAI conversations item, the Anthropic item’s
// sentences on attached files and on names in what it reads, and what Your data says stays in a conversation after an
// item is turned off or its original deleted (spec D36 and D56; OpenSpec change propose-order-setup-in-chat, task 7.5).
// [CONFIRM: weekly suggestions wording, awaiting the owner before they run in production] The “TownwiseAI’s weekly
// suggestions” item and the Anthropic item’s sentence on them (OpenSpec change weekly-forecast-suggestions, task 3.3),
// drafted for the owner’s approval; docs/portal/estimates.md section 5 carries the same words.
// [CONFIRM: calendar event titles wording, awaiting the owner before titles are sent in production] The Your calendars,
// Google calendars and TownwiseAI’s weekly suggestions items, the Anthropic item’s sentence on the location calendars’
// titles, and the date (OpenSpec change calendar-event-suggestions, task 9.1), drafted for the owner’s approval. The
// Limited Use statement is unchanged; the weekly sending is disclosed here, in the Google connect explainer and on the
// file and link add screens (src/portal/calendar/calendars.ts), and a calendar added or connected on a screen that did
// not show those words (no stored titlesNotice) sends no titles weekly. [CONFIRM: the sentence on calendars added or
// connected on a screen that did not yet say titles go weekly]
// [CONFIRM: privacy wording for TownwiseAI working on its own] The first sentences of “Files you let TownwiseAI read” and
// what it saves, the “Changes TownwiseAI makes” item and the Anthropic item’s sentences on files it reads on its own
// (spec D59, OpenSpec change auto-apply-agent-reads, design decision 14, task 7.1), drafted for the owner's approval
// (owner question 1); production keeps TOWNWISE_AGENT_AUTO false until then.
// [CONFIRM: calendar CSV and booking labels wording, awaiting the owner before production] The Your calendars item's
// sentence on a calendar CSV export, the “Sorting bookings with TownwiseAI” item and the Anthropic item's sentence on a
// sort (spec D58, OpenSpec change learn-from-calendar-bookings, design decision 14, task 10.2), drafted for the owner's
// approval.

// Anthropic's own terms for API data (checked 2026-11-05: “Anthropic may not train models on Customer Content
// from Services”, where Customer Content is the inputs and outputs).
const ANTHROPIC_TERMS_HREF = 'https://www.anthropic.com/legal/commercial-terms';

// Google calendars (spec D39, OpenSpec change connect-google-calendar, design decision 17): Google's API Services User
// Data Policy asks for a privacy policy that "fully documents how your application interacts with user data" and an
// affirmative statement of Limited Use compliance. The statement below keeps the spec's words, which follow the form
// Google's policies give (checked 2026-11-16; connect-google-calendar design.md, decision 17).
const GOOGLE_USER_DATA_POLICY_HREF = 'https://developers.google.com/terms/api-services-user-data-policy';
const GOOGLE_CONNECTIONS_HREF = 'https://myaccount.google.com/connections';

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
        <Li>The Townwise app sends no telemetry: no analytics, no tracking, no crash reports. The sign-in page loads Google’s sign-in script, so Google sees that visit, and the Calendar loads it when you choose Add a Google calendar.</Li>
        <Li>Townwise keeps the dates on which each signed-in person used the app, for 180 days, to see whether the product is used. It keeps the date only: not the time, the page or what you did. Townwise staff see it by organization.</Li>
        <Li>If you connect a Google calendar, Townwise gets read-only access to it, keeps only each event’s title, dates, hours and Google’s ID for it, and ends that access when you remove your last Google calendar or leave your organization.</Li>
        <Li>Townwise sends two emails, each only to the person it concerns: one when we receive your access request and one when you’re approved. Open and click tracking is off.</Li>
        <Li>You add sales history one of two ways. Drop your files, and we store them privately for your organization and read the date, guest count and net sales for each day on our server. Or have your browser read a CSV, and it sends us only those three values a day; that file never reaches our server.</Li>
        <Li>Your sales data is used only to provide Townwise to your restaurant: its own forecasts and TownwiseAI, its AI assistant. It is not shared with or used for other restaurants. It trains only your own location’s forecast model, and it is never used to train AI models such as TownwiseAI’s.</Li>
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
        <P>We do not keep the name or photo on your Google account, or the sign-in token Google gives the app. The app holds that token only long enough to send it to our server once; the mobile app then clears Google’s sign-in session. If you connect a Google calendar, Townwise does keep a different token from Google, encrypted, which only our server uses, to list your Google calendars while you pick, to read the ones you picked and to ask Google to revoke it (see Google calendars, under Your organization and team).</P>
        <P>Your account record is kept until it is deleted (see Your choices).</P>
        <P>Townwise keeps the dates on which each signed-in person used the app, for 180 days, to see whether the product is used. It keeps the date only: not the time, the page or what you did. Townwise staff see it by organization.</P>
        <P>Every sign-in needs a Google account whose email address Google says is verified. We create a new account, or link Google to an existing one, only for a Gmail address or a Google Workspace account. If the email on your Google account changes and Google is the authority for it, we update the email we keep at your next sign-in.</P>
        <P>On the web, the sign-in page loads Google’s sign-in script from accounts.google.com as soon as the page opens, so Google sees your visit to that page even if you never press the button. The Calendar loads the same script only when you choose Add a Google calendar, so Google sees that visit too. When you use the button, your browser talks to Google directly. Google’s own privacy policy covers both. Our server checks Google’s signature using Google’s published keys; it does not send your information back to Google.</P>
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
        <P>When you are signed in, some actions are also counted per account, as a hash of your account ID: every change for 10 minutes; uploads, TownwiseAI messages, and staff view-as and open as admin for one hour; and access requests for 24 hours.</P>
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
        <Li><Strong>Access requests.</Strong> To request access, you sign in with Google and fill in a short form: your organization’s name, your name, your role, your town, how many locations you have and an optional note. We keep it with your email address at the time and the request’s status. Townwise staff read it to decide on it. If they turn it down, they may add a message, which you see. If you find your business on Google Maps, we also keep Google’s id, name and town for each place you check, not its address or the map.</Li>
        <Li><Strong>Your team.</Strong> An org admin can add teammates by email address, each with a role. We keep each address on the team, with its role and who added it, even before that person signs in. Townwise does not email them. Org admins can see the team; members cannot.</Li>
        <Li><Strong>Locations.</Strong> Each location’s name (which can start as Google’s name for the place you picked, until you change it) and town and, if you picked the business on Google, Google’s id for that place. We don’t keep its address or anything else Google sends. To place your locations on the map in Settings, we ask Google where each picked place is and keep that map position for up to 29 days in a short-lived cache, apart from your data, then ask again.</Li>
        <Li><Strong>The welcome.</Strong> When you first open Townwise after approval, we note that we showed you the welcome, and when. It’s deleted with your organization or your account.</Li>
        <Li><Strong>Your name.</Strong> If you tell Townwise what to call you, we keep that name with your account and use it only to greet you in the app. Until you do, we use the first name from your access request, if you sent one. Change or clear it in Settings. It’s deleted with your account.</Li>
        <Li><Strong>Notes.</Strong> Notes about unusual days: the kind, the dates and weekdays, the hours if you give them, the expected effect and number of guests, an optional event name of up to 120 characters, a detail of up to 280 characters, and who wrote it. Everyone on your organization’s team can see them. Home, the Calendar and Analytics show them beside your days, and TownwiseAI reads them. From today on, a private event with a number of guests, a buyout or a closure changes your location’s published forecast for its days; a note’s detail never goes into the forecast.</Li>
        <Li><Strong>Your calendars.</Strong> A location can keep its own calendars: a calendar file you import, a link to a calendar, such as your Google calendar’s secret address or a booking system’s feed, or a Google calendar you connect by signing in with Google (below). For each event we keep its title, its dates and its hours, never its description, its place or its guests; an imported file itself is not kept. From a calendar exported as a CSV, Townwise keeps each event’s title, dates and hours and its ID, and uses its status only to leave out canceled events; it never reads or keeps the file’s other columns, such as descriptions, places, organizers or guests. Townwise fetches a calendar link from our server when you add it and about every 6 hours after that, and keeps the link encrypted: after you add it, the app shows it only by the name you gave it and the site it comes from, and it is never logged. Everyone on your organization’s team can see the calendars and their events, and TownwiseAI reads them when you ask about your bookings and once a week for its suggestions (see TownwiseAI’s weekly suggestions, below). TownwiseAI conversations keep no copy of the calendar events it reads, only its replies that mention one. A note you make from an event with Make a note keeps which event it came from (the calendar, the event’s ID from that calendar, and its dates and hours, never its title), so Townwise can suggest moving or deleting the note when the event moves or leaves the calendar. Removing a calendar deletes its events, not the notes you made from them.</Li>
        <Li><Strong>Google calendars.</Strong> On the web, you can connect the Google account you sign in to Townwise with and pick which of its calendars to add to a location. Townwise asks Google only for read-only access to your list of calendars and to their events, and for your Google account ID, to check that the account is the one you sign in with. Our server keeps that access encrypted and uses it only to list your Google calendars while you pick, to read the calendars you picked (when you add one, about every 6 hours after that, and when someone presses Refresh now), and to ask Google to revoke it. From them it reads only each event’s ID, status, title, dates and hours, repeating events included, never an event’s description, place or guests; it uses the status to leave out canceled events, and keeps the title, dates and hours as for your other calendars, with Google’s ID for the event. A calendar is named by its name in your Google account, or “Google calendar” for your main calendar or a name with “@” in it; the list of your Google calendars that you pick from is shown only to you and never kept. Everyone on your organization’s team can see these calendars and their events, and TownwiseAI reads their names and their events’ titles when you ask about your bookings, and once a week reads their events’ titles, dates and hours, never their names, for its suggestions (see TownwiseAI’s weekly suggestions), so they reach Anthropic, which doesn’t train on them. Townwise staff see them only through view-as or with your organization open as its admin, and there only as “Google calendar event” in a calendar named “Google calendar”, without their names or titles, in TownwiseAI too, though under view-as they can read your team’s TownwiseAI conversations, which may mention one; you agree to that when you press Continue to Google. Townwise’s access ends when your last Google calendar goes, whether someone removes it or deletes the location or the organization that holds it, and when you leave your organization or are removed from it: your Google calendars and their events are deleted, and Townwise deletes its access and asks Google to revoke it. If you connect but add no calendar, that happens about a day later. Revoking it also ends the access you gave Townwise for sign-in, so Google asks you to agree again the next time you sign in. You can also remove Townwise’s access yourself at <A href={GOOGLE_CONNECTIONS_HREF}>myaccount.google.com/connections</A>; your Google calendars then stop updating until you connect again or remove them.</Li>
        <Li><Strong>Sorting bookings with TownwiseAI.</Strong> On a calendar file’s page in Your data, an org admin can press Sort with TownwiseAI. Only then, and once each time it is pressed, Townwise sends that calendar’s event titles, with email addresses and phone numbers removed, and their dates and hours to Anthropic, never the calendar’s name or anything else from the file, so TownwiseAI can suggest a label for each event: a buyout, a party, your own event, or not a booking. Townwise staff with your organization open as its admin can’t press it. Townwise keeps each event’s label, whether TownwiseAI or a person set it, and when, and no other words from TownwiseAI. The labels it suggests change nothing until an org admin confirms them with Use for forecasts; then Townwise learns from past buyouts and parties and makes notes for upcoming ones. Each sort uses your organization’s monthly TownwiseAI budget.</Li>
        <Li><Strong>Your data.</Strong> Anything your team adds for reference on Your data or keeps from TownwiseAI, as it was sent: files of any kind and text you paste, with the name or title you gave it. Everyone on your organization’s team can see them; the person who added one and your org admins can download it. Turning an item off leaves it out of your numbers, forecasts and TownwiseAI until someone turns it back on, except for what TownwiseAI already wrote from it in a conversation, such as its replies and any ordering setup it suggested: that stays in the conversation and goes back to Anthropic with later messages there until the conversation is deleted. We keep who turned it off and when.</Li>
        <Li><Strong>TownwiseAI conversations.</Strong> If you use TownwiseAI, we keep your conversations for each location. They are private to you, except that Townwise staff using view-as as you can read them. If you rate a reply, we keep the rating with the conversation: helpful or not, and a reason you pick from a short list. We keep them until your account or your organization is deleted. When TownwiseAI proposes a note, we also keep whether you saved it or set it aside; the proposal’s wording stays only in your conversation, and in your notes if you save it. When TownwiseAI proposes keeping text you pasted, the text stays in your conversation, and on Your data if you keep it. When TownwiseAI suggests an ordering setup from a file you attached, the suggestion stays in your conversation, with whether you set it aside; it goes into your ordering setup only if you save it there.</Li>
        <Li><Strong>Web searches by TownwiseAI.</Strong> TownwiseAI can search the web, through Anthropic, for public facts about your town that Townwise doesn’t have, such as an event’s dates or a road closure. Anthropic runs each search and sends it to its search provider; Townwise never opens the pages. TownwiseAI is told to put only your town’s name and the public fact in a search, never a guest’s or staff member’s name, your sales or other figures, or words from your notes, business rules, files or messages, but Townwise can’t check a search before it is sent. The pages it finds are public, and Townwise didn’t check them. Each reply that cites them lists them as its sources. A web page never changes your forecast, and TownwiseAI is told to suggest a note from one only when you confirm the event affects you. What a search found is kept with the conversation: each page’s title, web address and age, its text in a form only Anthropic can read, and the short passages a reply cites, up to 150 characters each. It goes back to Anthropic with each later message in that conversation and is deleted with it. Our logs and audit record count searches and never hold what was searched for or found.</Li>
        <Li><Strong>TownwiseAI’s questions.</Strong> TownwiseAI asks about days with no sales, worked out from the location’s sales days and notes. When someone on your team answers, we keep the answer for that location, and answering that you were closed saves a closure note. Answers are deleted with the location’s sales data, the location or the organization.</Li>
        <Li><Strong>TownwiseAI’s weekly suggestions.</Strong> Unless an org admin turns them off on the TownwiseAI page, once a week TownwiseAI reads the next 3 months of each location’s town calendar with that location’s notes and business rules, and suggests notes or business rules for those days. It also reads the titles, dates and hours of the next 3 months of events on the location’s own calendars, with email addresses and phone numbers removed and never a calendar’s name, to spot private events, such as a party or a buyout, and ask whether each takes the whole restaurant. An org admin can turn this part off on its own on the TownwiseAI page. A calendar added or connected on a screen that did not yet say this sends no titles to the weekly suggestions until it is added or connected again. A suggestion changes nothing until an org admin accepts it, which saves it as that admin’s note or rule. When an event you made a note from moves or leaves your calendar, Townwise suggests moving or deleting the note. That comparison runs on our server with no AI, sends nothing to Anthropic, and runs even with weekly suggestions off. We keep each suggestion, its reason and the calendar entries it names, and whether it was accepted or dismissed, until the location or the organization is deleted. A suggestion from your calendars keeps the event’s ID, dates and hours, never its title, and its card reads the title from your calendar each time it shows.</Li>
        <Li><Strong>Changes TownwiseAI makes.</Strong> Unless an org admin turns it off on the TownwiseAI page, TownwiseAI saves on its own what it’s sure of from a file you add: a note, a summary on Your data, or sales days you didn’t have. It never changes or deletes anything that exists. Each change shows in TownwiseAI’s activity with Undo, which removes what it added as long as nobody changed it since; once someone on your team changes it, it’s theirs. Every change, with TownwiseAI’s short reason, is listed on the TownwiseAI page’s log of its changes. Anything it isn’t sure of, or that disagrees with a note or rule your team made, waits for you. We keep each change, its reason and whether it was undone until the location or the organization is deleted, so a change someone undid is never made again. Our logs and audit record hold only which kind of change it was and where it came from, never its words.</Li>
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
          <Li><Strong>Drop your files.</Strong> You can drop many files at once: point-of-sale exports, spreadsheets, ZIP archives, PDFs and Word documents. Each file goes as it is, over HTTPS, to our server, which stores it privately for your organization. The file’s name travels only inside the upload, never in a web address, and it is not logged. Our server opens ZIP archives and reads tables from PDFs and Word documents, and takes from them only the date, guest count and net sales for each day. Notes and other text in your files are stored but never read, unless you let TownwiseAI read the file. A file Townwise can’t use is kept and listed as “kept, not used” with the reason.</Li>
          <Li><Strong>Read it in your browser.</Strong> Your browser reads a CSV export and sends us only the date, guest count and net sales for each day, for one location. That file never reaches our server, and neither do its name or its other columns.</Li>
        </Ul>
        <P><Strong>What we keep.</Strong> For each location, one record per day with the date, guests and net sales. For each upload, who sent it, when, how many days it added or replaced, and its first and last dates. For a file you drop, we also keep the original as you sent it, a cleaned copy with only the date, guests and net sales, its name (shown only to your organization), and a short report of the column headings and counts it found, never the values in its rows. For a ZIP, we keep the names of the files inside and what happened to each. A file read in your browser leaves no name with us.</P>
        <P><Strong>Your files are personal data too.</Strong> Point-of-sale exports can hold diner names and phone numbers, server names and card details. For a file you drop for your sales history, unless you let TownwiseAI read that file (below), we never read those fields, and only the three values a day leave it. Originals sit in a private Azure storage account that has no public internet address: only our server can reach it, and every read, write and delete there is recorded.</P>
        <P><Strong>Files you let TownwiseAI read.</Strong> Unless an org admin turns it off on the TownwiseAI page, TownwiseAI reads each file added to Your data on its own once Townwise has stored it, except a sales export Townwise read into days, a calendar export, and any file whose box under Add a file was unchecked. Otherwise Townwise sends a file you add to an AI model only when you ask: you let TownwiseAI read it, one file at a time (“Let TownwiseAI read this file” on the file’s page), you attach it to a message you send TownwiseAI (see Files you attach to a TownwiseAI message), or, for a text item, you ask TownwiseAI about it. When TownwiseAI reads a file, Townwise sends that whole file to Anthropic’s Claude (a picture without its metadata, such as where and when it was taken), with today’s date and your location’s time zone, and nothing else: not the file’s name, your organization’s or location’s name, or anyone’s email. A point-of-sale export sent this way can hold diner or staff names, and Claude reads all of it; TownwiseAI is told not to repeat a person’s name, email or phone number. TownwiseAI saves what it’s sure of to your account: dated events as notes, daily totals it can check against the file’s own text as sales days, and a summary on Your data it can read later (see Changes TownwiseAI makes, under Your organization and team). An event it isn’t sure of, or one that disagrees with a note or rule your team made, waits for someone on your team to add or dismiss it. When an org admin asks for a read, it may also start updating the forecast; a read TownwiseAI starts on its own starts no update, and Townwise refits the forecast by itself within about an hour when what it added changes past days. When the file states the days you’re regularly closed, or a closed season, TownwiseAI suggests them as business rules, which change nothing until someone on your team confirms them. Everything it adds can be undone from the file’s page, except a suggested rule someone has confirmed, which stays as your rule until you delete it. A forecast update it started keeps running, and goes live if it passes Townwise’s accuracy checks and your forecasts are on. What Claude found is kept with the file until you undo the read or the file’s original is deleted; the notes and sales days TownwiseAI added stay until you undo the read or delete them yourself, and its summary on Your data is kept like any item added for reference. Suggested rules wait on Business rules until someone confirms, edits or dismisses them; undoing the read removes the ones still waiting, and we keep whether each was confirmed or dismissed, so it isn’t suggested again, until the location is deleted.</P>
        <P><Strong>Files and text you give TownwiseAI for ordering.</Strong> On Ordering setup, on the web or in the app, you can choose one file, or paste text, for TownwiseAI to suggest your suppliers and items from. Nothing is sent until you press Read. Then Townwise sends it once to Anthropic’s Claude, with the names of the suppliers and items already in your setup, and nothing else: not the file’s name, your organization’s or location’s name, or anyone’s email. A picture is sent without its metadata, such as where and when it was taken. A PDF is sent as it is, so its document properties, which can hold a title or an author’s name, go with it. Townwise doesn’t keep what you gave it: it isn’t stored or added to Your data, and our logs and audit record hold only how many suppliers and items it suggested, never the content or a name from it. An invoice or an export can hold people’s names, and Claude reads all of it. Claude is told to leave out names, email addresses and phone numbers, and Townwise takes out an email address written in the usual form, or a phone number written like (603) 555-0123, that it writes anyway. Its suggestions go into your setup unsaved, for you to check, until you save it, and TownwiseAI never sets a par or never run out. A register export read this way sends its item names and quantities to Anthropic, unlike the item sales upload, which reads an export in your browser and sends only how many servings of each item sold each day.</P>
        <P><Strong>Files you attach to a TownwiseAI message.</Strong> On the web, you can attach up to 5 files from Your data to a message you send TownwiseAI. Each stays on Your data like any item added for reference. Townwise sends the file’s content to Anthropic’s Claude with that message, again if you regenerate the reply, and again when TownwiseAI reads the file later in that conversation: a text, PDF, Word or Excel file as its text, at most its first 20,000 characters, and a picture without its metadata; never the file’s name. The file itself is not kept in the conversation, but TownwiseAI’s replies and any ordering setup it suggested from the file are, and they can repeat the file’s words. If you ask TownwiseAI to suggest your ordering setup from an attached file, it shows the suppliers, delivery days and items it found as a card. TownwiseAI is told to leave out people’s names, register names, pars and never run out. Townwise takes out an email address written in the usual form, or a phone number written like (603) 555-0123, before showing the suggestion, and never puts a par, a never run out or a register name from it into your setup. The suggestion is kept in that conversation as TownwiseAI wrote it, before Townwise takes anything out, and goes back to Anthropic with each later message there. It stays even if the file is turned off or deleted, or its original is deleted, including when someone whose details appear in it asks us to delete them; it goes only when the conversation, the location, your account or your organization is deleted. Once the file is turned off or deleted, or you can no longer have TownwiseAI read it, Townwise stops showing the card. Nothing changes in your setup until you open the suggestions on Ordering setup, check them and save.</P>
        <P><Strong>How we use it.</Strong> Your sales data is used only to provide Townwise to your restaurant: its own forecasts and TownwiseAI, its AI assistant. It is not shared with or used for other restaurants. It trains only your own location’s forecast model, and it is never used to train AI models such as TownwiseAI’s.</P>
        <P><Strong>Forecasts.</Strong> Forecasts are on for every organization; if you don’t want them, ask Townwise staff to turn yours off. Once a location’s sales history spans at least 230 days, Townwise forecasts its daily guests up to three months ahead and keeps that forecast current by itself: each week, if anything has changed since the last fit, a background job on Townwise’s own servers refits it from that location’s own daily guest counts, the closures, private events and bookings in its notes and business rules, and the public town calendar. The job sees no other location’s days. Each forecast is made by Townwise’s trained demand model or, when the location’s history is too short for that model or a simpler baseline did better on its past weeks, by that baseline, built from its recent weeks and the town calendar; the app says which made it. A new forecast goes live only when it passes Townwise’s accuracy checks. What a forecast learns from your restaurant is used only for your restaurant: it is not used for other restaurants, and it never trains AI models such as TownwiseAI’s. Townwise keeps the results (a range of guests per day, the dates the forecast learned from, the settings it was made with, and how accurate it has been) and not the fitted model. When Townwise staff import a forecast instead, it was built on the team’s own computers from sales exports you sent us; that model and those exports stay with Townwise staff, are used only for your restaurant, and are deleted when your organization is deleted or when you ask. You and TownwiseAI see the results. Deleting your sales data or your organization deletes them.</P>
        <P><Strong>Who can see it.</Strong></P>
        <Ul className="bul">
          <Li>The members and org admins of your organization.</Li>
          <Li>Townwise staff, in the staff console, see your organization’s name, its locations’ names and towns, team email addresses, counts and the dates your data covers. They do not see the sales figures or your location notes there, and these console views are not recorded.</Li>
          <Li>Townwise staff helping you, with your consent, can open your organization as its admin, before or after anyone from it joins: they see and change what an admin can, except your team, for at most an hour each time. Once anyone has joined, they must give a reason first. Each time, with its reason, and every change they make is recorded and listed in your organization’s Townwise staff activity. There, a Google calendar’s events show as “Google calendar event”, without their calendars’ names or their titles, in TownwiseAI too.</Li>
          <Li>Otherwise, Townwise staff can see the sales figures, your location notes and your calendars with their events only through view-as: a read-only view of the app as one of your team sees it. It needs a reason, lasts at most 30 minutes, is recorded, and is shown to your organization’s admins. There, a Google calendar’s events show as “Google calendar event”, without their calendars’ names or their titles, though a TownwiseAI reply staff read there may mention one.</Li>
          <Li>Members of our Townwise administrators group, who manage the production systems, can reach the database outside the app. Townwise’s audit record does not include those reads.</Li>
        </Ul>
        <P><Strong>How long we keep it.</Strong> Until an org admin deletes it (in the app, an org admin can delete all sales data for a location), or until we delete your organization’s account on request (see Your choices). Our nightly backups keep copies for 30 days. For files you drop: we delete each original 365 days after it was sent, or sooner when you delete it; cleaned copies stay until you delete them, the location’s sales data or your organization; an upload that never finishes is discarded after 24 hours, and a file dropped but never sent for reading after 30 days. Deleting all sales data for a location deletes its files too. Items you add for reference follow the same rules: we delete each one 365 days after it was sent, or sooner when you delete it.</P>
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
          <Li><Strong>Google</Strong>, when you open the sign-in page (its sign-in script loads there) and when you sign in with your Google account, under Google’s privacy policy. If you connect a Google calendar, the Calendar loads that script when you choose Add a Google calendar, your browser opens Google’s window with your email address filled in, and our server then lists your Google calendars for you to pick from and reads the ones you picked (see Google calendars, under Your organization and team). When you search for your business, on the access request or when adding or changing a location, our server sends Google the text you type and the place you pick, and checks the picked place’s town with Google once more when a location is saved. Google sees our server, not your device. When a found place shows a map, your browser or app loads the map image straight from Google, so Google sees your IP address. We keep Google’s id for the place, and on an access request its name and town too.</Li>
          <Li><Strong>Microsoft Azure</Strong>, which runs our servers and stores our database, its backups, our logs and the files you drop, and delivers our two emails through Azure Communication Services, which receives your address and the email’s content.</Li>
          <Li><Strong>Anthropic</Strong>, which provides the AI model behind TownwiseAI, the assistant on each location’s TownwiseAI page. Apart from TownwiseAI’s weekly suggestions and the files it reads on its own (see Files you let TownwiseAI read, under Your restaurant’s sales data), nothing is sent to Anthropic unless you use it, or Townwise staff use it while they have your organization open as its admin (see Who can see it, under Your restaurant’s sales data). Unless an org admin turns weekly suggestions off, once a week for each location Anthropic receives the next 3 months of its town’s calendar, how the location’s past holidays and town events went (as percentages and counts of days, never a sales figure), its notes and business rules for those days as your team wrote them, the suggestions it made before and, unless an org admin turns that off too, the titles, dates and hours of the next 3 months of events on the location’s own calendars, with email addresses and phone numbers removed; never your team’s names or email addresses (apart from any written in a note, a rule or an event’s title), a calendar’s name, or your organization’s or location’s name. Each week’s suggestions use your organization’s monthly TownwiseAI budget. When either does, Anthropic receives the messages you send and the location data the assistant reads to answer them: the location’s name and town, its sales totals and daily figures, its notes, its forecast’s ranges and accuracy and its calibration results, its town profile and public facts about its town (its calendar, and who is likely in town, with the public sources behind them). TownwiseAI never reads a sales file Townwise read into days unless you let it read one. It reads a text item on Your data (text you pasted or a text file you added), or a picture, PDF, Word or Excel file you attached to a message, only when you ask, and never a file’s name. When it reads the location’s own calendars, Anthropic receives their names and their events’ titles, dates and hours. When an org admin presses Sort with TownwiseAI on a calendar file, Anthropic receives that calendar’s event titles, with email addresses and phone numbers removed, and their dates and hours, once, never the calendar’s name (see Sorting bookings with TownwiseAI). When TownwiseAI reads a file, on its own or because you let it, the whole file is sent to it (a picture without its metadata). When you have TownwiseAI read a file or text on Ordering setup, that file or text is sent to it once, with the names of the setup’s suppliers and items. When you attach a file to a message, its content is sent with that message, again if you regenerate the reply, and again when TownwiseAI reads the file later in that conversation; an ordering setup it suggested from the file goes back with each later message there. Townwise never sends it your team’s names or email addresses, apart from any in a file or text it reads (one you let it read, attach to a message, keep on Your data or give it on Ordering setup) or in what it wrote from one earlier in a conversation. When TownwiseAI searches the web, Anthropic sends the search TownwiseAI wrote to its search provider (see Web searches by TownwiseAI, under Your organization and team). Separately, when you, or Townwise staff helping you, drop a file and Townwise’s own rules can’t find its guest or net sales columns, our server may send Anthropic the file’s column headings and the kinds of values in each column, never its rows, its name or your restaurant’s name, to suggest which is which; otherwise it asks whoever dropped it. Anthropic processes them under its <A href={ANTHROPIC_TERMS_HREF}>Commercial Terms of Service</A>, which say Anthropic may not train models on that content.</Li>
        </Ul>
        <P><Strong>Google user data.</Strong> Townwise’s use and transfer of information received from Google APIs adheres to the <A href={GOOGLE_USER_DATA_POLICY_HREF}>Google API Services User Data Policy</A>, including the Limited Use requirements.</P>
        <P>Apart from Google’s sign-in script on the sign-in page, Google’s window when you connect a Google calendar (which gets your email address, so it opens on your account), and the two emails Microsoft delivers, the Townwise app and server send your account and sign-in information to no one else. Townwise does not sell personal data.</P>
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
          <Li><Strong>Delete your account:</Strong> there is no self-serve deletion yet. Write to <Mail /> and we will delete your account and its data within 30 days: your account record, your name, sessions, any authenticator record, your access requests and invitations, your place on a team, the dates on which you used the app and your TownwiseAI conversations. Notes, uploads and items on Your data that you added stay with your organization, including text you kept from TownwiseAI. In the audit record, your email address is replaced with “deleted person”. Log lines expire on the retention schedule above.</Li>
          <Li><Strong>Delete your organization:</Strong> an org admin can ask us the same way to delete the organization’s account and its data, and we will do it within 30 days: its locations, sales data, uploads, notes, calendars, team, TownwiseAI conversations and answers to TownwiseAI’s questions. In the audit record, its name and its locations’ names are replaced.</Li>
          <Li><Strong>Your data:</Strong> on Your data your team can see everything Townwise received for your locations and download a sales file’s cleaned copy. The person who added an item, or an org admin, can download its original, turn it off or on, and delete it; only an org admin can delete an upload, which deletes the days it still holds. For a sales file, they can instead delete just its original and keep its cleaned daily totals, and an org admin can delete all originals for a location at once and keep the cleaned daily totals; items added for reference stay. If someone whose details appear in your files, such as a diner, asks us to delete them, we delete your organization’s originals, items you added for reference included, and keep the cleaned totals. This doesn’t delete what TownwiseAI already wrote from a file in a conversation, such as an ordering setup it suggested: that stays until the conversation is deleted, which the person it belongs to can do on the TownwiseAI page. Townwise staff using view-as see your files’ kinds and dates, not their names, and cannot download them.</Li>
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
              <P className="sub">Effective November 5, 2026. Last updated November 19, 2026.</P>
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
