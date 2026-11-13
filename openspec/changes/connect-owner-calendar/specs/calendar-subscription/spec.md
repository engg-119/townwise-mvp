## ADDED Requirements

### Requirement: A link is fetched when it is added
Adding a link calendar SHALL fetch and parse the address before anything is stored. A fetch or parse failure SHALL refuse the add with its code and store nothing.

#### Scenario: Working link
- **WHEN** a member adds a Google Calendar secret iCal address
- **THEN** the system fetches it, stores the calendar with its events, and answers with its name, host and event count

#### Scenario: Link that is not a calendar
- **WHEN** a member adds an address that returns an HTML page
- **THEN** the system answers 400 `not_calendar` and stores nothing

### Requirement: Only public HTTPS addresses are fetched
The system SHALL fetch only `https:` addresses on port 443 with no user name or password (a `webcal:` address is fetched as `https:`). It SHALL resolve the host, refuse the fetch if any resolved address is loopback, private, link-local, CGNAT, unspecified, broadcast, multicast, documentation or reserved (IPv4 and IPv6, IPv4-mapped included), connect only to the address it checked, and follow at most 3 redirects, checking each one the same way.

#### Scenario: Private address
- **WHEN** a member adds `https://10.0.0.5/cal.ics`
- **THEN** the system answers 400 `blocked_address` and makes no connection

#### Scenario: Name that resolves to the metadata endpoint
- **WHEN** a member adds an address whose host resolves to `169.254.169.254`
- **THEN** the system answers 400 `blocked_address` and makes no connection

#### Scenario: Redirect to a private address
- **WHEN** a public address answers with a redirect to `https://127.0.0.1/`
- **THEN** the system does not follow it and answers 400 `blocked_address`

#### Scenario: Plain HTTP
- **WHEN** a member adds an `http:` address
- **THEN** the system answers 400 `bad_link`

### Requirement: Fetches are bounded
A fetch SHALL time out after 10 seconds and stop reading after 1 MB, send no cookies, and identify itself only as `Townwise calendar reader`.

#### Scenario: Feed over 1 MB
- **WHEN** an address returns more than 1 MB
- **THEN** the fetch stops at 1 MB and fails with `too_large`

### Requirement: The address is a secret
The system SHALL store a link's address encrypted with AES-256-GCM under the calendar key, and SHALL NOT return, log or audit it. Without the calendar key configured, adding a link SHALL answer 503 `calendar_links_unavailable` and no refresh SHALL run, while file imports keep working.

#### Scenario: Stored form
- **WHEN** a link calendar is stored
- **THEN** the database holds the address only as ciphertext, and its host in plain text

#### Scenario: No key
- **WHEN** the API runs without `TOWNWISE_CALENDAR_KEY` and a member adds a link
- **THEN** the system answers 503 `calendar_links_unavailable`

### Requirement: Links refresh on their own
The system SHALL refresh each link calendar about every 6 hours. One replica SHALL refresh a given calendar at a time, under a lease. A successful refresh SHALL replace the calendar's events so that a reader never sees a mix of old and new events. A failed refresh SHALL keep the last good events, record the failure code, and retry later with backoff.

#### Scenario: Two replicas
- **WHEN** two replicas look for due calendars at the same moment
- **THEN** each due calendar is fetched by only one of them

#### Scenario: Feed down
- **WHEN** a refresh times out
- **THEN** the calendar keeps its events, its status becomes `timeout`, and it is tried again later

#### Scenario: Crash mid-replace
- **WHEN** a replica stops after writing a refresh's new events but before switching the calendar to them
- **THEN** reads still return the previous events, and the next refresh or removal deletes the unused rows

### Requirement: Refresh now
A member SHALL be able to refresh a link calendar on demand, at most once per calendar every 5 minutes.

#### Scenario: Second refresh too soon
- **WHEN** a member refreshes the same calendar twice within 5 minutes
- **THEN** the second request answers 429 and no fetch is made

### Requirement: Refresh logs carry no content
The refresh loop SHALL log only the calendar id, status code, event counts and duration.

#### Scenario: Failed refresh log
- **WHEN** a refresh fails with `http_error`
- **THEN** the log line holds the calendar id, `http_error` and the duration, and no address, host, name or title
