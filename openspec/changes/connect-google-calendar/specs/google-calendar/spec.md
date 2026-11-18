## ADDED Requirements

### Requirement: Google calendars are off unless configured
The system SHALL offer Google calendars only when `TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID`, `TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET` and `TOWNWISE_CALENDAR_KEY` are all set. With any of them unset, the calendar list SHALL answer `google.available` false, every `org.google_calendars.*` route and every Google add or "Refresh now" SHALL answer 503 `google_calendar_unavailable`, a Google calendar's refresh SHALL record `google_unavailable` and keep its events, and files and links SHALL work as before. A client id that does not match Google's client id format, or is not one of `AUTH_GOOGLE_CLIENT_IDS`, SHALL refuse boot. The client secret SHALL be read only in `main.ts` and SHALL NOT be part of the parsed `config`.

#### Scenario: Client id without its secret
- **WHEN** the API runs with `TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID` and `TOWNWISE_CALENDAR_KEY` set and no client secret
- **THEN** it boots, the calendar list answers `google: { available: false, connected: false, clientId: null, canConnect: false }`, and a connect answers 503 `google_calendar_unavailable`

#### Scenario: Secret and id without the calendar key
- **WHEN** the client id and secret are set and `TOWNWISE_CALENDAR_KEY` is not
- **THEN** the API boots with Google calendars off

#### Scenario: A client id from another project
- **WHEN** `TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID` is a well-formed client id that is not in `AUTH_GOOGLE_CLIENT_IDS`
- **THEN** boot is refused with a `ConfigError` naming `TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID`

### Requirement: Connecting asks Google for read-only calendar access only
The web client SHALL ask Google, through Google Identity Services' code model in a popup, for exactly the scopes `openid`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and `https://www.googleapis.com/auth/calendar.events.readonly`, with `include_granted_scopes` false, a fresh random `state` on every press, and the person's own email as `login_hint`. The connect route SHALL answer 400 `google_scope_missing` and store nothing unless the token response grants both calendar scopes.

#### Scenario: The scopes requested
- **WHEN** a member presses "Continue to Google"
- **THEN** the code client is initialized with the three scopes above and no other, `ux_mode` popup and `include_granted_scopes` false, and `requestCode()` runs inside that press

#### Scenario: A box left unchecked
- **WHEN** the person grants the calendar list scope but not the events scope on Google's screen
- **THEN** the connect route answers 400 `google_scope_missing`, nothing is stored, and the popover says "Townwise needs to see your calendars and their events. Try again and leave both boxes checked."

#### Scenario: An answer from an abandoned window
- **WHEN** a code arrives with a `state` other than the one of the current press, or after the person pressed "Stop waiting"
- **THEN** the client drops it and posts nothing

### Requirement: The connect route exchanges the code on the server for the person's own account
`POST /api/org/locations/:locationId/google-calendars/connect` (`org.google_calendars.connect`, member, not `openAsAdmin`, body `2kb`, limiter `google_calendars`) SHALL take a strict `{ code, agreed: true }` with `code` of 1 to 512 characters, exchange the code at Google's token endpoint with the client id and client secret, check the ID token from that answer (`iss` Google's, `aud` the client id, `exp` in the future, a `sub`), and refuse with 409 `google_other_account`, storing nothing, unless `sub` equals the caller's `googleSubject`. An exchange Google refuses as `invalid_grant` SHALL answer 400 `google_code_invalid`. With no refresh token in Google's answer, the route SHALL keep the stored token only when the person's stored connection is not revoked and its token opens under the current key; otherwise (no connection, a revoked one, or one the key no longer opens) it SHALL revoke the access token it was given, store nothing, and answer 409 `google_connect_again`. Otherwise it SHALL store the connection, one per (organization, person), with its sealed refresh token, the granted scopes, `agreedAt` and `connectedAt`, clear `revokedAt`, set `nextRefreshAt` to now on that person's Google calendars in the organization, set the connection's check 24 hours on (or at once when, after storing, the caller no longer holds their seat in the organization), and answer 200 with the picker's choices. A failed calendar list read for those choices SHALL answer as the picker's list does, never 401.

#### Scenario: A first connect
- **WHEN** a member with no connection posts a code whose exchange returns a refresh token and an ID token for their own Google account
- **THEN** one `tw_google_connections` row exists for (organization, member) holding the refresh token only as ciphertext, with `agreedAt` set, and the answer is 200 `{ calendars }`

#### Scenario: Another Google account
- **WHEN** the ID token's `sub` is not the caller's `googleSubject`
- **THEN** the answer is 409 `google_other_account`, nothing is stored, and the popover says "Choose the Google account you sign in to Townwise with. To add another account’s calendar, share it with that account in Google Calendar first."

#### Scenario: No lasting access
- **WHEN** the exchange returns no refresh token and the caller has no connection
- **THEN** the route revokes the access token it was given, stores nothing, and answers 409 `google_connect_again`

#### Scenario: Reconnecting heals revoked calendars
- **WHEN** a member whose connection is revoked, with two Google calendars showing `google_revoked`, connects again and the exchange returns a refresh token
- **THEN** the stored token is replaced, `revokedAt` is null, and both calendars are due for refresh at once

#### Scenario: A dead connection reconnected without a refresh token
- **WHEN** a member whose connection is revoked, or whose stored token the key no longer opens, connects again and the exchange returns no refresh token
- **THEN** the route revokes the access token it was given, the stored connection is unchanged and still revoked, and the answer is 409 `google_connect_again`

#### Scenario: No agreement in the body
- **WHEN** a connect body has no `agreed: true`
- **THEN** the answer is 400 `invalid_request` and Google is not called

### Requirement: Google's access is sealed and never shown
The system SHALL store a connection's refresh token and each Google calendar's id only as AES-256-GCM ciphertext under `TOWNWISE_CALENDAR_KEY` (`calendar/secret.ts`), SHALL store no access token, and SHALL NOT answer, log or audit a refresh token, an access token, an authorization code or an ID token. A Google calendar's id SHALL appear only in the picker's answer to the person whose Google account it is and in that person's add request body, never in a URL path or query, a log line or an audit event. A token or id the key no longer opens SHALL give the calendar the status `key_mismatch`.

#### Scenario: Stored form
- **WHEN** a member connects and adds their primary Google calendar
- **THEN** the database holds the refresh token and the calendar's id only as `v1:` sealed strings, and no access token

#### Scenario: Another key
- **WHEN** the calendar key is changed and a Google calendar is refreshed
- **THEN** its status becomes `key_mismatch` and its events stay

### Requirement: The picker lists the person's own Google calendars
`GET /api/org/locations/:locationId/google-calendars` (`org.google_calendars.list`, member, not `openAsAdmin`, limiter `google_calendars`) SHALL refuse view-as with 403 `view_as_read_only`, answer 409 `google_not_connected` when the caller has no connection and 409 `google_reconnect` when it is revoked or a refresh is answered `invalid_grant`, and otherwise answer 200 `{ calendars: [{ id, name, primary, added }] }` from Google's calendar list (`minAccessRole=reader`, at most 250), the primary first, where `name` is the calendar's name in the person's Google account, never stored, and `added` says whether that calendar is already one of this location's. A calendar list read Google answers with 401 SHALL answer 409 `google_reconnect`, and in connect's answer SHALL also mark the connection revoked; a rate limit, a disabled Calendar API, a 5xx or any other failure SHALL answer 503 `google_unavailable`. Neither route SHALL answer 401. Like every GET (spec 7.3), the choices route SHALL write nothing, so Google's refusal there is recorded by the next add, connect or refresh.

#### Scenario: Choices with one already added
- **WHEN** a connected member whose primary calendar is on the location lists the choices
- **THEN** the primary comes first with `primary: true` and `added: true`, and a shared calendar follows with `added: false`

#### Scenario: Under view-as
- **WHEN** staff viewing as a connected member request the choices
- **THEN** the answer is 403 `view_as_read_only` and Google is not called

#### Scenario: Open as admin
- **WHEN** staff who opened an organization as admin request the choices or connect
- **THEN** the answer is 403 `open_as_admin_refused`

#### Scenario: Google's token rejected on the list
- **WHEN** a connected member requests the choices and Google answers the calendar list with 401
- **THEN** the answer is 409 `google_reconnect`, not 401, and nothing is written

#### Scenario: Google's token rejected in connect's answer
- **WHEN** a member connects and Google answers the calendar list for the choices with 401
- **THEN** the connection is marked revoked and the answer is 409 `google_reconnect`, not 401

### Requirement: Adding a Google calendar checks it before storing anything
`org.owner_calendars.create` SHALL take `{ kind: 'google', googleCalendarId }` (1 to 1,024 characters) and refuse, in this order: 403 `open_as_admin_refused` for staff opened as admin; 503 `google_calendar_unavailable`; 409 `google_not_connected` or `google_reconnect`; 409 `calendar_limit`; 429 `rate_limited` from the account's 12 adds that fetch an hour (`townwise:calendar-links`); 400 `google_not_found` when the calendar is not in the person's Google calendar list; 400 `google_forbidden` when the person may see only its free and busy times; 409 `calendar_already_added` when any Google calendar of the location has the calendar id Google's calendar list answered (the canonical id that is stored, so the `primary` alias matches the primary's real id); then it SHALL read the calendar's events and, on a failure, store nothing. A calendar the caller cannot see in their own Google calendar list SHALL answer 400 `google_not_found` whether or not it is on the location, so an add never tells a member which accounts' calendars the location holds. The calendar's name SHALL be its Google name cut to 60 characters, or "Google calendar" for the primary calendar and for any name containing "@". After storing, the add SHALL check the connection again and, if it was ended meanwhile, remove the new calendar and answer 409 `google_not_connected`. An add that stores while an end of the connection is revoking, its row not yet deleted, answers 201, and that end SHALL then remove the new calendar and its events with the connection. A success SHALL answer 201 with the calendar and audit `owner_calendar.added` with kind `google`.

#### Scenario: A full location costs no Google call
- **WHEN** a member adds a Google calendar to a location that has 5 calendars
- **THEN** the answer is 409 `calendar_limit` and no request reaches Google

#### Scenario: The same calendar twice
- **WHEN** a member adds a shared Google calendar that a teammate already added to this location
- **THEN** the answer is 409 `calendar_already_added` and nothing is stored

#### Scenario: A calendar the caller can't see
- **WHEN** a member posts the id of a calendar a teammate added to this location, which is not in the member's own Google calendar list
- **THEN** the answer is 400 `google_not_found`, never `calendar_already_added`, and nothing is stored

#### Scenario: The primary alias
- **WHEN** a member whose primary Google calendar is already on the location posts `googleCalendarId: 'primary'`
- **THEN** the answer is 409 `calendar_already_added` and nothing is stored

#### Scenario: Free and busy only
- **WHEN** the calendar list gives the calendar the access role `freeBusyReader`
- **THEN** the answer is 400 `google_forbidden` and nothing is stored

#### Scenario: The primary's name
- **WHEN** a member adds their primary calendar, whose Google name is their email address
- **THEN** it is stored as "Google calendar", and no email address is stored as a name

#### Scenario: A read that fails
- **WHEN** Google answers the events read with a 503
- **THEN** the add answers 503 `google_unavailable` and nothing is stored

### Requirement: A Google calendar is read with a fixed, minimal request
The system SHALL read a Google calendar by refreshing access once and listing its events with `singleEvents=true`, `orderBy=startTime`, `showDeleted=false`, `eventTypes=default`, the town's `timeZone`, `maxResults=500` and `fields=nextPageToken,items(id,status,summary,start,end)`, first the events ahead (`timeMin` the town's today less 1 day, `timeMax` today plus 401 days), following its pages up to 2,000 events, and then, with what is left of 2,000 events and 8 pages in all, the events before, newest first, in slices that begin 30, 90, 210 and 401 days before today (the first ending today, each other where the newer one begins), each read to its last page and left out when the page budget cuts it short, every bound at 00:00Z and an event read twice counted once. It SHALL keep each event's id as its UID, its title cut to 200 characters, its dates and its hours by the rules of `calendar/ics.ts` (an all-day event's end date exclusive, a timed event in the town's wall time, hours only when it ends on its start date or by 06:00 the next morning), skip canceled events, keep events within 400 days of the town's today, at most 2,000: those that end on or after the town's today first, by start, then the earlier ones read, the latest first. It SHALL keep each instance of a repeating event, and report no repeating events not imported.

#### Scenario: The events query
- **WHEN** a Google calendar of a Hanover location is read on 2026-11-15
- **THEN** the first events request carries exactly the parameters above with `timeMin=2026-11-14T00:00:00Z`, `timeMax=2027-12-21T00:00:00Z` and `timeZone=America/New_York`, and no description, location, attendee or organizer is requested

#### Scenario: A busy calendar keeps what is ahead
- **WHEN** a Google calendar holds 20 events a day across the whole window
- **THEN** 2,000 events are stored, none of them ending more than 2 days before the town's today, and no page of the events before was requested

#### Scenario: A busy past keeps the days just before today
- **WHEN** a Google calendar holds 4 events a day ahead and 3 a day before the town's today
- **THEN** 2,000 events are stored: the 1,604 ahead, and the 396 of the 132 days just before today, none older

#### Scenario: A weekly event
- **WHEN** a calendar holds a weekly event and Google answers 3 of its instances in the window
- **THEN** 3 single events are stored, each with its own UID, and the calendar's `skippedRepeating` is 0

#### Scenario: An all-day event
- **WHEN** Google answers an all-day event with `start.date` 2026-12-04 and `end.date` 2026-12-06
- **THEN** it is stored from 2026-12-04 to 2026-12-05 with no hours

### Requirement: Google calendars refresh on their own
The refresh loop SHALL claim due Google calendars with due links, one at a time under a lease, about every 6 hours, and replace their events by generation as for links. A refresh Google answers with `invalid_grant` SHALL record `google_revoked`, mark the connection revoked, and the connection's other calendars SHALL then record `google_revoked` without calling Google. A Google calendar whose connection no longer exists SHALL be removed with its events. Before reading, the loop and "Refresh now" SHALL confirm that the connection's person holds an active seat in the calendar's organization, and otherwise SHALL end that access (reason `seat_gone`) without reading Google; a seat removed in that organization less than a minute ago, which a removal refused as the last admin may still put back, SHALL be neither read nor ended until that minute has passed. Failures SHALL map to `google_revoked` (an `invalid_grant` or a 401), `google_rate_limited` (a 403 whose reason is `rateLimitExceeded`, `userRateLimitExceeded` or `quotaExceeded`, or a 429), `google_unavailable` with the logged code `api_disabled` (a 403 whose reason is `accessNotConfigured` or whose detail is `SERVICE_DISABLED`), `google_forbidden` (any other 403), `google_not_found` (a 404 or 410) and `google_unavailable` (a 5xx, a network failure, a timeout, an aborted call, an over-cap body, or the Google client off), keep the last good events, and back off as a link's do. Closing the loop SHALL abort a Google read in flight, which writes nothing and lets its lease run out.

#### Scenario: Access revoked at Google
- **WHEN** the person removed Townwise at Google and their first Google calendar is refreshed
- **THEN** its status becomes `google_revoked` and its events stay, and when their second Google calendar is refreshed it becomes `google_revoked` with no request to Google

#### Scenario: Google busy
- **WHEN** the events read answers 403 with reason `userRateLimitExceeded`
- **THEN** the calendar's status becomes `google_rate_limited` and it is tried again 6 hours later

#### Scenario: The Calendar API not enabled
- **WHEN** the events read answers 403 with reason `accessNotConfigured`
- **THEN** the calendar's status becomes `google_unavailable`, not `google_forbidden`, and `townwise.google_calendar_failed` carries `code: 'api_disabled'`

#### Scenario: A seat removed and access never ended
- **WHEN** a member's seat is removed and the request stops before their access is ended, and their Google calendar comes due
- **THEN** the refresh ends that access, removing the calendar and its events and deleting the connection, without reading Google's calendar

#### Scenario: Closing mid-read
- **WHEN** the API shuts down while a Google calendar's events pages are being read
- **THEN** the call in flight is aborted, no page after it is requested, the calendar's events and status are unchanged, and a later look refreshes it

### Requirement: Townwise's access ends when it is no longer needed
The system SHALL end a connection, by marking it for a check, removing the Google calendars it backs in the organization (events first), revoking the grant at Google (best effort, 10 seconds, a 200 or a 400 `invalid_token` counting as done), deleting the connection whether or not the revoke worked, and then removing the calendars it backs once more (one an add stored while the revoke ran), when: the last Google calendar it backs is removed, whoever removes it; the picker's Cancel drops it unused (`DELETE /api/org/google-connection`, `org.google_calendars.disconnect`: 204, 409 `google_connection_in_use` when it backs a calendar, 404 when there is none); it is still unused 24 hours after a connect; its person loses their seat in the organization (removed, left or removed by staff); and its organization is deleted. Deleting a location SHALL end every connection left backing no calendar. A crash part way SHALL be completed by the refresh loop's connection check: every connection SHALL be due for a check at least once a day, and at once after any step that may leave it unused or unowned, which marks it before it acts (a seat's removal marks the person's connection before the seat is removed; a location's deletion marks the connections backing its Google calendars before the location is deleted; the refresh loop marks a Google calendar's connection before removing a calendar whose location is gone; a connect that, after storing, finds its person no longer holds their seat marks the connection it stored). The check SHALL end a connection whose person holds no active seat in the organization or that backs no calendar, and otherwise push its next check 24 hours on. The revoke SHALL need only the stored token and the calendar key, so access ends with the grant revoked while Google calendars are switched off too.

#### Scenario: The last Google calendar removed
- **WHEN** a member removes the only Google calendar their connection backs
- **THEN** Google's revoke endpoint is called with the refresh token, the connection is deleted, and `google_calendar.disconnected` is audited with reason `last_calendar`

#### Scenario: A member removed from the team
- **WHEN** an org admin removes a member who added two Google calendars
- **THEN** both calendars and their events leave the location, the grant is revoked, and the connection is deleted
- **AND** when the removal is refused as the last admin, nothing about the connection changes

#### Scenario: A revoke that fails
- **WHEN** Google's revoke endpoint times out while access ends
- **THEN** the connection is still deleted, and `townwise.google_revoke_failed` is logged with the status only

#### Scenario: Connected but never used
- **WHEN** a member connects, adds nothing and closes the browser
- **THEN** about 24 hours later the refresh loop revokes and deletes the connection

#### Scenario: Interrupted end
- **WHEN** the API stops after removing a departed member's Google calendars but before revoking
- **THEN** the refresh loop's connection check finds the connection due, revokes it and deletes it

#### Scenario: Interrupted seat removal
- **WHEN** the API stops after an org admin's removal of a member took the seat away but before that member's access was ended
- **THEN** the connection was already marked, and the next connection check finds no seat, removes the member's Google calendars, revokes the grant and deletes the connection

#### Scenario: Removed while connecting
- **WHEN** an org admin removes a member while that member's connect is exchanging its code at Google
- **THEN** the connection the connect stores is due for a check at once, and the connection check, finding no seat, revokes the grant and deletes the connection

#### Scenario: Interrupted location deletion
- **WHEN** the API stops after a location's row is deleted but before its calendars are, and the refresh loop then removes its Google calendar
- **THEN** the connection that backed it was marked before the location was deleted, and the next connection check, finding it backs nothing, revokes and deletes it

#### Scenario: Removed while Google calendars are off
- **WHEN** Google calendars are switched off (no client secret, the calendar key still set) and a member removes their last Google calendar
- **THEN** Google's revoke endpoint is still called with the refresh token, and the connection is deleted

#### Scenario: A connection in use is looked at daily
- **WHEN** a connection backs a calendar and its person keeps their seat
- **THEN** the connection check looks at it about every 24 hours and leaves it in place each time

### Requirement: A revoke never ends another connection
Because Google's revoke ends every grant the account gave the project, the system SHALL revoke a connection's grant only when the same person has no connection in another organization, and SHALL otherwise delete the row without revoking.

#### Scenario: A leftover row in a former organization
- **WHEN** a person's connection in organization A is ended while they hold a live connection in organization B
- **THEN** A's row is deleted, Google's revoke endpoint is not called, and B's calendars keep refreshing

### Requirement: Google calls are bounded
Townwise's Google client SHALL call only `https://oauth2.googleapis.com` (token and revoke) and `https://www.googleapis.com/calendar/v3`, each call with a 10 second timeout, redirects refused, and at most 2 MB read, and SHALL report failures as a code and Google's HTTP status only. A revoke SHALL send the token in an `application/x-www-form-urlencoded` body, never in the URL. The three `org.google_calendars.*` routes SHALL share the limiter `townwise:google-calendars`, 30 calls an account an hour, refusing when the store is down.

#### Scenario: Thirty-first call in an hour
- **WHEN** an account makes a 31st connect or choices call within an hour
- **THEN** the answer is 429 `rate_limited` and Google is not called

#### Scenario: A redirect from Google
- **WHEN** a Google endpoint answers with a redirect
- **THEN** it is not followed, and the read fails with `google_unavailable`

#### Scenario: The revoke request
- **WHEN** Townwise revokes a grant
- **THEN** it POSTs to `https://oauth2.googleapis.com/revoke` with no query string and the token as the form body's `token`

### Requirement: Google connections are audited and logged without content
Connecting SHALL audit `google_calendar.connected { connectionId }` and dropping an unused connection or removing its last calendar SHALL audit `google_calendar.disconnected { connectionId, calendarCount, reason }` (target type `google_connection`). Ending access because of a lost seat, a deleted location or organization, or the connection check SHALL write no audit event and SHALL log `townwise.google_access_ended { connectionId, calendars, reason }`. Google failures, from the refresh loop, "Refresh now", the add, connect and the picker's list, SHALL log `townwise.google_calendar_failed { op, status, code }` through one helper, with exactly those fields: `op` one of `token`, `calendar_list`, `calendar`, `events`, `revoke`, `status` Google's HTTP status or null, and `code` from the Google client's fixed list of codes, never Google's `error`, `error_description`, message or body. No audit event or log line SHALL carry an authorization code, a token, a Google calendar id, an email address, a calendar name or an event title, a URL, or any part of Google's error body.

#### Scenario: Audit on connect
- **WHEN** a member connects
- **THEN** `google_calendar.connected` carries the connection id and nothing from Google

#### Scenario: A failed token refresh
- **WHEN** Google's token endpoint answers 400 `invalid_client` with an `error_description`
- **THEN** one `townwise.google_calendar_failed` line with exactly `op: 'token'`, `status: 400` and `code: 'invalid_client'` is logged, nothing of the description is logged, and the calendar records `google_unavailable`

### Requirement: Staff never connect, and view-as shows no Google calendar's name or event title
Staff opened as admin SHALL NOT connect, list choices, disconnect or add a Google calendar (403 `open_as_admin_refused`), and, while Google calendars are on, the calendar list SHALL answer them `google: { available: true, connected: false, clientId: null, canConnect: false }`. Under view-as staff SHALL NOT list the target's choices and the calendar list SHALL answer `google.connected` and `google.canConnect` false. Staff SHALL see "Add a Google calendar" in place, disabled, opening nothing, with the line "Members of this organization connect their own Google calendars. Staff can’t connect one." under the actions, and SHALL get no Reconnect (owner decision, 2026-11-17). Under view-as and open as admin alike (open as admin outlasts the first join, D25), the calendar list, the events read and "Refresh now"'s answer SHALL show each Google calendar with the label "Google calendar" and each of its events with the title "Google calendar event", with their dates and hours, and in a TownwiseAI turn staff run open as admin `get_owner_calendar` SHALL list each Google calendar's events with the calendar "Google calendar" and the title "Google calendar event"; files and links SHALL show as they do today. The connect section SHALL say "Townwise staff never see these events’ titles on the Calendar. Under view-as, a recorded, read-only view shown to your organization’s admins, they can read your team’s TownwiseAI conversations, which may mention one." before "Continue to Google", whose press is the person's agreement, recorded as the connection's `agreedAt`.

#### Scenario: View-as reads
- **WHEN** staff view as a member whose location has a Google calendar named "Bookings" with an event "Holiday party" on 2026-12-05
- **THEN** the Calendar shows the event on 2026-12-05 read-only as "Google calendar event" from "Google calendar", no answer carries "Bookings" or "Holiday party", "Add a Google calendar" is disabled in place, and no choices are requested

#### Scenario: Staff see the Google option disabled
- **WHEN** staff open as admin an organization while Google calendars are on, and open Your calendars on web
- **THEN** the list answers `google` with `available` true, `clientId` null and `canConnect` false, "Add a Google calendar" shows disabled with "Members of this organization connect their own Google calendars. Staff can’t connect one.", pressing it opens nothing, and every Google route and a Google add still answer 403 `open_as_admin_refused`

#### Scenario: Files and links under view-as
- **WHEN** staff view as a member whose location also has a link calendar
- **THEN** the link's events show with their own titles and the link's name, as today

#### Scenario: Open as admin after people joined
- **WHEN** staff open as admin an organization whose member added a Google calendar named "Bookings" with an event "Holiday party" on 2026-12-05, after that member joined
- **THEN** the calendar list, the events read and a "Refresh now" of that calendar show it as "Google calendar" and the event as "Google calendar event" on 2026-12-05, a link calendar keeps its own name and titles, and no answer carries "Bookings" or "Holiday party"

#### Scenario: TownwiseAI open as admin
- **WHEN** staff with the organization open as its admin ask TownwiseAI about that location's bookings and it calls `get_owner_calendar`
- **THEN** the result lists the Google calendar's event as "Google calendar event" from "Google calendar", with its dates and hours, and holds neither "Bookings" nor "Holiday party"

### Requirement: The Your calendars popover connects and picks Google calendars
On web, when `google.available` is true, the Your calendars popover SHALL show "Add a Google calendar" after "Add a link". Pressing it SHALL replace it with the Google section, whose state SHALL survive closing the popover. With no connection the section SHALL show the explainer "Sign in with Google to pick calendars from your Google account. Townwise reads each event’s title, dates and hours, and nothing else, about every 6 hours, repeating events included. Everyone on your team can see these events, and TownwiseAI reads their titles when you ask about your bookings, so they reach Anthropic, which doesn’t train on them. Townwise staff never see these events’ titles on the Calendar. Under view-as, a recorded, read-only view shown to your organization’s admins, they can read your team’s TownwiseAI conversations, which may mention one. Removing your last Google calendar, or leaving your organization, ends Townwise’s access to your Google account. Google may warn that Townwise isn’t verified yet while Google reviews it." with "Continue to Google" and "Cancel"; with one it SHALL read the choices first. Google's script SHALL load only when the section opens. While Google's window is open the section SHALL say "Waiting for Google…" with "Stop waiting"; while reading a connected person's choices, waiting, connecting or adding, Close SHALL be disabled and Escape, Android's back button and a press outside SHALL do nothing. The picker SHALL say "Choose the calendars to add to {location}.", list one checkbox row per calendar (the primary first, with "Your main calendar"; one already added checked, disabled and marked "Added"), say "This location can add {k} more." and cap the checks at k, say "To add another Google account’s calendar, share it with this account in Google Calendar first.", and end with "Add {n} calendars" ("Add calendar" for one) and "Cancel". Adds SHALL post one at a time, each with its own line, then read the list and the stored events once. Cancel after a fresh connect with nothing added SHALL drop the connection. A closed or denied Google window SHALL show nothing; a blocked one SHALL say "Your browser blocked Google’s window. Allow pop-ups for townwise.tech and try again."; any other error Google answers for the current press, and an `unknown` error, SHALL end the wait and say "Google didn’t connect Townwise. Try again." without Google's own description; a script that fails to load SHALL say "Google’s sign-in didn’t load. Try again.". Refusals SHALL show plain words: 503 `google_calendar_unavailable` "Google calendars aren’t available right now. You can still add a link or import a file."; `google_connect_again` "Google didn’t give Townwise lasting access. Press Continue to Google again."; `google_code_invalid` "Google’s sign-in expired. Try again."; `google_reconnect` the explainer with "Connect your Google account again to add calendars."; `calendar_already_added` "This calendar is already on this location."; `google_not_found` "That calendar is no longer in your Google account."; `google_forbidden` "Google won’t share that calendar’s events with Townwise."; `google_unavailable` "Townwise couldn’t reach Google. Try again in a few minutes."; `calendar_limit` and `rate_limited` as for links. A Google calendar's row SHALL read "Google calendar, {n} events" with its "Updated" time, and its status words SHALL be: `google_revoked` the words of "The person who added a revoked Google calendar can reconnect it"; `google_not_found` "Couldn’t refresh: this Google calendar was deleted or is no longer shared with the account that added it."; `google_forbidden` "Couldn’t refresh: Google refused to share this calendar’s events."; `google_rate_limited` "Couldn’t refresh: Google was busy. Townwise tries again later."; `google_unavailable` "Couldn’t refresh: Townwise couldn’t reach Google."; `key_mismatch` "Townwise can’t open this Google connection any more. Remove the calendar and add it again."; any other "Couldn’t refresh this calendar.".

#### Scenario: Connect and pick
- **WHEN** a member with no connection presses "Add a Google calendar", then "Continue to Google", grants access, checks two calendars and presses "Add 2 calendars"
- **THEN** the page posts the code with `agreed: true`, shows the picker, posts two adds one after the other, shows "Added {name}: {n} events." for each, reads the list and the stored events once, and moves focus to the messages line

#### Scenario: Google's script waits for the person
- **WHEN** the Calendar loads and the popover opens
- **THEN** no script from accounts.google.com is in the document until "Add a Google calendar" is pressed

#### Scenario: The popover waits for Google
- **WHEN** Google's window is open and the member presses Escape, then outside the popover
- **THEN** the popover stays open with Close disabled, and "Stop waiting" ends the wait and enables Close

#### Scenario: The window closed
- **WHEN** the person closes Google's window without choosing
- **THEN** the section shows the explainer again with no message

#### Scenario: Another error from Google
- **WHEN** Google's callback answers the current press with `error: 'admin_policy_enforced'`, or the error callback reports type `unknown`
- **THEN** the wait ends, Close is enabled, the section shows the explainer with "Google didn’t connect Townwise. Try again.", and nothing is posted

#### Scenario: Cancel after connecting
- **WHEN** a member connects and presses Cancel in the picker with nothing added
- **THEN** the page sends `DELETE /api/org/google-connection` and the section closes

#### Scenario: Room for two more
- **WHEN** the location has 3 calendars and the picker lists 4 not yet added
- **THEN** it says "This location can add 2 more." and a third check is disabled until one is unchecked

#### Scenario: Native
- **WHEN** a member opens Your calendars on native with Google calendars available
- **THEN** there is no "Add a Google calendar", the line "To import a calendar file or connect a Google calendar, open Townwise on the web." shows, and Google calendars' rows offer "Refresh now" and "Remove"

### Requirement: The person who added a revoked Google calendar can reconnect it
Every calendar in the calendar list, add and Refresh now answers SHALL carry `mine`: true only for a Google calendar the caller added, which their own connection reads, and false for a file, a link, another member's Google calendar, and to staff under view-as or open as admin. A Google calendar whose status is `google_revoked` SHALL say "Couldn’t refresh: Google no longer lets Townwise read this calendar. Reconnect, or remove it." to the person who added it on web, "Couldn’t refresh: Google no longer lets Townwise read this calendar. Reconnect on the web, or remove it." to them on native, and "Couldn’t refresh: Google no longer lets Townwise read this calendar. Ask whoever added it to reconnect, or remove it." to anyone else. On web, while `google.available` is true, its row SHALL offer "Reconnect" between "Refresh now" and "Remove" when `mine` is true, and no row SHALL offer it otherwise; `key_mismatch` keeps its words and no Reconnect, since a new token cannot open calendar ids sealed under an old key. Reconnect SHALL open the Google section on its explainer in place of every Reconnect and of "Add a Google calendar". A connect started from Reconnect SHALL NOT show the picker: the page SHALL run "Refresh now" on each Google calendar of the location with `mine` true, one at a time while the popover waits, then the section SHALL close, the messages line SHALL say "Reconnected to Google." followed by "Your Google calendars are up to date." when every one was read, or by "Townwise reads your Google calendars again within 15 minutes." when a refresh was refused, and take focus, and the list and the stored events SHALL be read again; a calendar still failing SHALL show its row's own words. Its refusals SHALL show as any connect's, and its Cancel SHALL give focus back to that row's Reconnect. "Remove" SHALL stay on every row. Staff, under view-as or open as admin, SHALL NOT get a Reconnect.

#### Scenario: Mine
- **WHEN** a member who added a Google calendar, a teammate and an org admin each read the calendar list
- **THEN** that calendar is `mine` only for the member who added it, also while their connection is revoked, and a link is `mine` for no one

#### Scenario: Never mine to staff
- **WHEN** staff view as the member who added a Google calendar, or open the organization as its admin
- **THEN** the list answers that calendar with `mine` false

#### Scenario: Reconnect without the picker
- **WHEN** on web the member who added a `google_revoked` Google calendar presses its "Reconnect", then "Continue to Google", and Google gives a code
- **THEN** the page posts the code with `agreed: true`, shows no picker, posts "Refresh now" for that calendar, says "Reconnected to Google. Your Google calendars are up to date." with focus on it once it is read, and reads the list and the stored events again, so the row shows no "Couldn’t refresh" words

#### Scenario: A teammate's revoked calendar
- **WHEN** a member opens Your calendars with a teammate's `google_revoked` Google calendar
- **THEN** its row says "Couldn’t refresh: Google no longer lets Townwise read this calendar. Ask whoever added it to reconnect, or remove it." and offers "Refresh now" and "Remove" only

### Requirement: The privacy page says what Townwise reads from Google
The public privacy page SHALL say that a connected Google calendar's access is kept encrypted and used only by Townwise's server, to list the person's Google calendars while they pick, to read the calendars picked and to revoke it, that only each event's id, status, title, dates and hours are read and only its title, dates, hours and Google's id for it are kept (repeating events included), who can see them (the team, TownwiseAI and so Anthropic, the calendars' names included, and Townwise staff only through view-as or with the organization open as its admin, which show Google calendars' events without their calendars' names or their titles, though a TownwiseAI conversation staff read under view-as may mention one), that TownwiseAI conversations keep no copy of the calendar events it reads, only replies that mention one, that Google's script also loads on the Calendar when "Add a Google calendar" is opened, that removing the last Google calendar (or deleting the location or organization that holds it) or leaving the organization ends Townwise's access and asks Google to revoke it, that access can also be removed at myaccount.google.com/connections, and Google's Limited Use statement: "Townwise’s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements."

#### Scenario: Limited Use statement
- **WHEN** the privacy page renders
- **THEN** it contains the Limited Use statement with a link to Google's API Services User Data Policy, and no sentence still says Townwise never keeps a Google token

### Requirement: Google calendars are off in production until enabled
Terraform SHALL add the Key Vault secret `townwise-google-calendar-secret` as `TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET` only when `enable_google_calendar` is true, which SHALL default to false and SHALL be refused unless `enable_calendar_links` is true.

#### Scenario: Default plan
- **WHEN** the production stack is planned with the defaults
- **THEN** the Container App has no `townwise-google-calendar-secret` secret, no `TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET` and no role on that secret

#### Scenario: Enabled without links
- **WHEN** `enable_google_calendar` is true and `enable_calendar_links` is false
- **THEN** the plan fails on the variable's validation
