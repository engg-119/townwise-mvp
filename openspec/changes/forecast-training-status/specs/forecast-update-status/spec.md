## ADDED Requirements

### Requirement: Calibration answers carry an additive updating field
Every calibration object the API answers (GET /api/org's location summaries, GET /api/org/locations/:locationId/sales, and the sales upload answer) SHALL carry `updating`, either null or `{ stage: 'running' | 'waiting', since }` with `since` an ISO time. The `state` values SHALL stay `no_sales_data`, `not_calibrated`, `calibrated` and `stale`, and `queued`, `calibrating` and `failed` SHALL stay reserved. `updating` SHALL be null on `no_sales_data`. The client SHALL accept a calibration without `updating` and read it as null. [CONFIRM: the forecast's progress is a field beside the calibration state; queued, calibrating and failed stay reserved]

#### Scenario: An older client reads a location that is updating
- **WHEN** a client built before this change parses GET /api/org for a location with a running calibration
- **THEN** the parse succeeds, `updating` is stripped, and every page renders as before

#### Scenario: A newer client reads an older API
- **WHEN** the client parses a calibration with no `updating` key
- **THEN** it reads the location as not updating

### Requirement: Running is a live calibration younger than its time limit, read without a write
`updating` SHALL be `{ stage: 'running', since: requestedAt }` while the location has a calibration whose status is `queued` or `running` and whose `requestedAt` is less than 20 minutes (`CALIBRATION_TIMEOUT_MS`) before now, whoever started it. A live calibration past its 20 minutes SHALL read as not updating. Computing `updating` SHALL write nothing: it SHALL NOT call `expireStale` or any other write. [CONFIRM: owners see every live calibration of their location as updating, including one staff or another admin started] [CONFIRM: a calibration past its 20 minutes reads as not updating, with no write, until the next start or pass fails it]

#### Scenario: The weekly refresh is running
- **WHEN** an owner loads GET /api/org while the weekly refresh's calibration of their location has been running for 6 minutes
- **THEN** that location's `calibration.updating` is `{ stage: 'running', since }` with `since` its `requestedAt`

#### Scenario: A dead job
- **WHEN** a calibration is still stored `queued` 25 minutes after it was requested
- **THEN** GET /api/org answers `updating: null` for that location and no document changes

#### Scenario: Another organization's run
- **WHEN** organization B has a live calibration and a member of organization A loads GET /api/org
- **THEN** none of A's locations reads updating from it

### Requirement: Waiting is a first forecast the hourly pass will start
`updating` SHALL be `{ stage: 'waiting', since: refit.wantedAt }` only when the location has no live calibration, no run of the location was ever published, its refit mark is set and the pass has not tried it since (`refit.startedAt` absent or before `refit.wantedAt`), and the conditions under which the hourly pass starts it hold: the lab runner is on, `TOWNWISE_WEEKLY_FORECASTS` is true, staff have not paused the schedule, the organization is active with forecasts on, and the location's history spans what the schedule starts. A location with a published run SHALL never read `waiting`. No answer or page SHALL state the minimum history. [CONFIRM: a location's first forecast reads as being built from the moment its history lands and the hourly pass will start it]

#### Scenario: Onboarding history lands
- **WHEN** an org admin's onboarding upload of 700 days applies to a new location of an active organization with forecasts on and the schedule running
- **THEN** the upload answer and GET /api/org read `updating: { stage: 'waiting' }` for it until the pass starts its calibration, then `running`

#### Scenario: A short history
- **WHEN** a new location's upload holds 120 days
- **THEN** `updating` is null and no page says how many days are needed

#### Scenario: A refit of a published location
- **WHEN** a location with a published forecast gets a sales upload and no calibration has started yet
- **THEN** `updating` is null until the pass starts one

### Requirement: Owners see updating where they look
While `updating` is not null, the model card (P24) SHALL show a sentence saying the forecast is updating or the first forecast is being built, with the days and the time it started; Home (P11) SHALL replace its no-forecast line with a "Building your first forecast" line for a location with no published run; the dashboard's Calibration cell (P9) SHALL add a second line in plain words, never a StatusTag; the upload result SHALL say the forecast is updating or the first forecast is next; and TownwiseAI's overview tool SHALL include the model card's sentence. A time SHALL be shown in the viewer's time zone, with the date added when it is not the viewer's today. [CONFIRM: every updating sentence in design decision 3] [CONFIRM: no separate run-history page; the dashboard shows updating as words in the Calibration cell]

#### Scenario: Model card while a refit runs
- **WHEN** a stale location with 6 newer days has a calibration running since 2:14 PM
- **THEN** the model card reads "Updating your forecast with 6 new days, started 2:14 PM."

#### Scenario: Dashboard with two locations
- **WHEN** one of an organization's two locations is updating
- **THEN** its Calibration cell shows its heading and "Updating now" beneath it, in plain text

### Requirement: Pages poll quietly while something updates and act when it ends
While any shown location is updating, the dashboard and the location's pages SHALL re-read GET /api/org in place every 30 seconds without returning to a loading state, SHALL wait while the app is in the background, and SHALL wait 10 seconds after a failed read. When a location they saw updating stops, Home SHALL re-read its forecast in place and the model card its estimates, so a published forecast replaces the building line without a reload. When Home saw a first forecast building and the location is still `not_calibrated` afterwards, it SHALL say the first forecast was not published and that TownwiseAI's activity says why. No page SHALL poll while nothing updates. [CONFIRM: pages re-read every 30 seconds while a forecast is updating] [CONFIRM: Home's words when a first forecast was not published]

#### Scenario: The first forecast publishes while Home is open
- **WHEN** Home shows "Building your first forecast" and the run is published
- **THEN** within one poll Home shows the forecast and no skeleton flashes

#### Scenario: The first run is held by the gate
- **WHEN** Home saw the first forecast building and the run finished with the gate holding it
- **THEN** Home shows that the first forecast wasn't published and points to TownwiseAI's activity

#### Scenario: Nothing is updating
- **WHEN** no location is updating
- **THEN** no page re-reads GET /api/org on a timer

### Requirement: Running and done is one shared pattern
The client SHALL expose one hook that refreshes while a flag is true and calls back once when it turns false after being seen true, and the org provider SHALL expose an in-place refresh. Later background work an owner waits for (D66's research runs) SHALL show progress as an additive, read-only `{ stage, since } | null` field on a read the page already makes and its end as an activity kind, using the same hook.

#### Scenario: Another kind of run reuses the hook
- **WHEN** a page passes the hook a running flag that turns false
- **THEN** its done callback runs exactly once
