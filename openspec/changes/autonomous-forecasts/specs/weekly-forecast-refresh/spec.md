## ADDED Requirements

### Requirement: Forecasts are on by default for every organization
Every organization, existing and new, SHALL have its forecasts on (G1) unless staff switched them off: an organization with no `forecasts` field SHALL read as on, and a staff switch off SHALL be stored with when and by whom and stay off until staff switch it on again. The console SHALL show "On (default)" for an organization nobody switched. The spec SHALL keep G1's original text ("nothing is published ... unless staff have switched the organization's forecasts on") as history beside a build note. Nothing SHALL publish while the lab runner is off. [CONFIRM: forecasts are on by default for every organization, existing and new (an organization with no `forecasts` field reads as on), reversing the team's G1 rule that nothing is published until staff switch the organization's forecasts on; staff can still switch one off, recorded with when and by whom]

#### Scenario: An organization nobody switched
- **WHEN** an active organization has no `forecasts` field and a calibration's draft passes the gate
- **THEN** the draft publishes, and the console shows its switch as "On (default)"

#### Scenario: Staff switch one off
- **WHEN** staff switch an organization's forecasts off
- **THEN** it is stored with the time and the staff id, its drafts stay drafts with reason `forecasts_off`, and the weekly refresh skips its locations

#### Scenario: The lab is off
- **WHEN** `TOWNWISE_LAB_RUNNER` is off
- **THEN** no calibration starts and nothing publishes, whatever the switches say

### Requirement: A background worker runs one pass under one lease
The weekly refresh SHALL run in a worker, `api/src/workers/weekly-forecasts.ts`, not in the API's server process: the worker SHALL build the stores and the lab runner from `config.ts`'s schema, run one pass of `createForecastSchedule` (`api/src/lab/schedule.ts`), close its connections and exit (0, or 1 on an error), and `main.ts` SHALL start no loop. In production a Container Apps scheduled job, `caj-townwise-forecasts`, SHALL run it. The job SHALL use the API image with a command override, run hourly with parallelism 1, a replica timeout and no retry, and have its own managed identity with the `mongodb-uri` Key Vault reference and the right to start the lab job. `deploy.yml` SHALL set its image with the API's. Locally `npm run worker:forecasts -w @townwise/api` SHALL run one pass, and `--loop` SHALL tick hourly and once at start. Only the pass that claims the lease on the `tw_forecast_schedule` document by compare-and-set SHALL act, so overlapping executions do no harm. The lease SHALL last 10 minutes and be renewed by compare-and-set before each location, and a failed renewal SHALL stop the pass at once. With the lab runner off, `TOWNWISE_WEEKLY_FORECASTS` false, or the document's `paused` set, a pass SHALL start no calibration and exit. `TOWNWISE_WEEKLY_FORECASTS` SHALL default to true in code and in `api/.env.example`, and SHALL be written explicitly as `true` in `api/production.env` (owner directive, 2026-11-16).

#### Scenario: One pass
- **WHEN** the scheduled job starts the worker at 03:05 on a Monday in Hanover
- **THEN** the worker runs one pass, logs `townwise.weekly_refresh_pass`, closes its Mongo connection and exits 0

#### Scenario: Overlapping executions
- **WHEN** a slow pass still holds the lease when the next hour's execution starts
- **THEN** the second execution's pass finds the lease held, starts nothing and exits 0

#### Scenario: Switched off
- **WHEN** `TOWNWISE_WEEKLY_FORECASTS` is false or `TOWNWISE_LAB_RUNNER` is off
- **THEN** the worker starts no calibration and exits 0

#### Scenario: The renewal fails mid-pass
- **WHEN** a pass has started 1 of 4 due locations and its lease renewal finds the lease taken
- **THEN** it starts no other location and exits, and a later pass continues with the 3 left

#### Scenario: The API starts no loop
- **WHEN** the API's server process starts with the lab runner on
- **THEN** it schedules no timer for the weekly refresh

### Requirement: Three ways to stop it
`TOWNWISE_WEEKLY_FORECASTS`, true by default, SHALL be the deploy-level off. Staff SHALL be able to pause and resume every scheduled start from the console (`POST /api/admin/forecast-schedule { paused }`, policy `staff`, audit `forecast_schedule.paused` or `forecast_schedule.resumed`), which sets `paused` (`{ at, by }` or null) on the schedule document and takes effect at the next pass. Switching an organization's forecasts off (G1) SHALL stop its scheduled starts at once, since only organizations with forecasts on are considered. None of the three SHALL cancel a calibration already live.

#### Scenario: Staff pause
- **WHEN** a staff member pauses the schedule
- **THEN** the next pass starts no calibration, the console shows "Paused by {email} on {date}", and the audit log records `forecast_schedule.paused`

#### Scenario: One organization stops
- **WHEN** staff switch an organization's forecasts off on Monday at 03:30
- **THEN** none of its locations gets a scheduled calibration from the next pass on

### Requirement: Which locations a week starts
On a pass, the lease holder SHALL consider each location of an active organization whose forecasts are on (G1, an absent switch counting as on), found through `stores/cross-tenant.ts` with its scope minted by `access/policy.ts`. It SHALL start a calibration for a location only when: it is Monday at 03:00 or later in the location's town time zone; the location has no `tw_forecast_weeks` row for that Monday; its history span is at least 230 days; fewer than 3 scheduled calibrations are live across all organizations; and its fingerprint differs from its reference calibration's. The fingerprint (`dataSha256`) SHALL be the sha256 of the lab input without `calibrationId`, `today` and `champion`, together with the input schema version and `LAB_MODEL_VERSION` (an API constant held equal to `modeling/lab/townwise_lab/version.py`'s `MODEL_VERSION` by a contract test). The reference calibration SHALL be the location's newest calibration whose gate published the draft or refused it on its own data (any reason but `forecasts_off` and `champion_changed`); a failed calibration, or one refused for `forecasts_off` or `champion_changed`, SHALL never be a reference. The calibration SHALL carry the `regimeStart` of the calibration that made the current published run (null without one). Nothing in the schedule SHALL name a town, organization or location. [CONFIRM: a scheduled calibration starts from 03:00 on Monday in the town's time zone] [CONFIRM: at most 3 scheduled calibrations live at once across all organizations]

#### Scenario: A changed location on Monday morning
- **WHEN** it is Mon, Nov 23, 2026 at 03:10 in Hanover, the organization has no `forecasts` field (on by default), and the owner uploaded last week's days on Sunday
- **THEN** the schedule writes the location's week row for 2026-11-23 and starts a calibration with `requestedBy: { userId: null, role: 'system', via: 'scheduled' }`

#### Scenario: Nothing changed
- **WHEN** the location's fingerprint equals its reference calibration's
- **THEN** the week row records `unchanged` and no calibration starts

#### Scenario: Forecasts switched on after a forecasts_off draft
- **WHEN** last week's calibration was refused `forecasts_off`, staff switch forecasts on, and no data changed
- **THEN** Monday's pass starts a fresh calibration, since a `forecasts_off` calibration is never a reference

#### Scenario: The lab model changes
- **WHEN** `LAB_MODEL_VERSION` moves from v6 to v7 and no data changed
- **THEN** the fingerprint differs and the location is calibrated again

#### Scenario: The regime carries over
- **WHEN** the current published run came from a calibration with `regimeStart` 2026-06-01
- **THEN** the scheduled calibration's input has `regimeStart` 2026-06-01

#### Scenario: The live cap
- **WHEN** 3 scheduled calibrations are live and 5 more locations are due
- **THEN** the pass starts none of them and writes no week row for them, and later passes start them as live ones finish

#### Scenario: A failed scheduled calibration
- **WHEN** Monday's scheduled calibration fails `timeout`
- **THEN** no other scheduled calibration starts for that location until the next Monday

#### Scenario: Someone is already calibrating
- **WHEN** an org admin's calibration of the location is live at 03:10 on Monday
- **THEN** no week row is written and the next pass tries again until that Monday ends in the town

### Requirement: Week rows record every start once
Before starting, the holder SHALL insert the week row (unique on `{ orgId, locationId, week }`) as `starting`, then set it `started` with the calibration id, or `start_failed`. A pass that finds a `starting` row older than the lease SHALL look for a calibration of that location requested by the system at or after the row was written, and set the row `started` with it or `start_failed`. Skips SHALL be recorded as `unchanged`, `not_enough_history` or `cap_reached`. A started calibration SHALL never be retried that week.

#### Scenario: The holder dies between insert and start
- **WHEN** a row is left `starting` and no calibration was created
- **THEN** a later pass sets it `start_failed`, and the location waits for the next Monday

### Requirement: Scheduled calibrations are paid by Townwise and bounded
A scheduled calibration SHALL not be charged to the organization's TownwiseAI month (`chargedMicroUsd` 0), SHALL not count toward its 4 calibrations a day, and SHALL not be refused for a spent budget; it SHALL still hold the location's one live slot. Roughly `TOWNWISE_WEEKLY_FORECAST_CAP` (default 200) week rows across all organizations SHALL be `starting` or `started` in one week; past it, rows SHALL record `cap_reached`. The count is approximate only in that a stopped holder's `starting` rows count until resolved. Each start SHALL record the audit event `calibration.scheduled` (system actor; location id and calibration id only). Calibrations a person starts SHALL keep D27's charge, limits and 595-day minimum. [CONFIRM: scheduled calibrations are paid by Townwise, not the organization's TownwiseAI month, and do not count toward its 4 a day] [CONFIRM: roughly 200 scheduled calibrations a week across all organizations]

#### Scenario: No charge
- **WHEN** a scheduled calibration starts
- **THEN** the organization's TownwiseAI month is unchanged and its 4-a-day limiter is not consumed

#### Scenario: The weekly cap
- **WHEN** 200 week rows are `starting` or `started` this week and a 201st location is due
- **THEN** its week row records `cap_reached` and no calibration starts

#### Scenario: A person's calibration the same day
- **WHEN** an org admin starts a calibration on Monday afternoon after the scheduled one finished
- **THEN** it is charged $0.10, counts as one of the organization's 4 that day, and needs 595 days of history

### Requirement: Each pass is visible
Each pass SHALL end with one log line `townwise.weekly_refresh_pass { started, failed, skipped, capped, ms }` (counts and time only, never an id or a figure). The console's Forecasts section SHALL show each location's latest week row (week, outcome, the calibration and its gate reason). `infra/README.md` SHALL add a log search alert, like the daily-cap alert, that fires when a pass reports `failed` above 0, when the job's execution fails, or when no pass line appears for 8 days while the switch is on.

#### Scenario: A pass's log line
- **WHEN** a pass starts 4, skips 7 as unchanged and records 1 `start_failed`
- **THEN** it logs `townwise.weekly_refresh_pass` with `started` 4, `skipped` 7, `failed` 1 and no id

#### Scenario: Staff check a location
- **WHEN** staff open an organization's Forecasts section on Monday afternoon
- **THEN** each location shows this week's outcome, such as "Mon, Nov 23: started, published (refreshed)" or "unchanged"

### Requirement: Calibrated and stale states
The derived calibration state (`api/src/calibration.ts`, spec 14.1) SHALL add `calibrated` and `stale` for a location with a published run: `calibrated` when the newest published run's `dataThrough` is on or after the last day with guests, and `stale` when it is before it. Both SHALL carry the run's `dataThrough`, `newerDays` (days with guests after it) and `nextRefresh`, the date of the Monday the weekly refresh will next consider the location, or null while the lab runner is off, `TOWNWISE_WEEKLY_FORECASTS` is false, the schedule is paused, or the organization's forecasts are off. It SHALL be derived on every read and never stored, and the client SHALL accept both states before the API sends them. Where the state shows, `stale` SHALL read "Forecast made from your sales through {Sun, Nov 15}. Townwise refits on {Mon, Nov 23} with the {6} days since." or, with `nextRefresh` null, "Forecast made from your sales through {Sun, Nov 15}. The {6} days since aren't in it yet." `queued`, `calibrating` and `failed` SHALL stay reserved.

#### Scenario: New days after the run
- **WHEN** the newest published run's `dataThrough` is Nov 15, 2026, the owner uploaded Nov 16 to 21, and the weekly refresh is on
- **THEN** the state is `stale` with `newerDays` 6 and `nextRefresh` 2026-11-23

#### Scenario: The lab is off
- **WHEN** the same location's API runs with `TOWNWISE_LAB_RUNNER` off
- **THEN** the state is `stale` with `nextRefresh` null

#### Scenario: Up to date
- **WHEN** the newest published run's `dataThrough` is the last day with guests
- **THEN** the state is `calibrated`

#### Scenario: No published run
- **WHEN** the location has days and no published run
- **THEN** the state is `not_calibrated`, as today
