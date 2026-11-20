# forecast-run-history Specification

## Purpose
TBD - created by archiving change forecast-training-status. Update Purpose after archive.
## Requirements
### Requirement: Refit marks and system calibrations record their causes
Every call that marks a location as wanting a refit SHALL name its cause, and the mark SHALL keep the set of causes since it was last cleared: `sales` for applied sales days (the upload route, staff setup's upload and the file reader), `person_change` for a person's note or rule change and an undo, `townwise_ai` for a change TownwiseAI saved (D59 changes, an automatic read's days and a calendar's answers). Clearing the mark by compare-and-set SHALL clear its causes in the same write. A calibration the weekly path starts SHALL store `causes: ['weekly']`, and one the refit path starts SHALL store the mark's causes when it has any. A calibration with no causes (a person's, or a refit of a mark set before this change) SHALL store no `causes` key, never an empty list, and a start SHALL NOT fail for want of causes. A person's calibration SHALL read as `staff` when Townwise staff started it (`requestedBy.role` `superadmin`), by any route, else as `asked`. A system calibration with no stored causes SHALL read as `unknown`. `requestedBy.via` SHALL NOT change.

#### Scenario: An upload and a note before the pass
- **WHEN** a sales upload and then a note on a past day mark the same location, and the pass starts its refit
- **THEN** the calibration stores `causes: ['sales', 'person_change']` and `requestedBy.via` is `scheduled`

#### Scenario: A mark lands during the pass
- **WHEN** TownwiseAI saves a change after the pass read the mark and before it cleared it
- **THEN** the clear does not match and the mark keeps `townwise_ai` for a later pass

#### Scenario: A mark from before this change
- **WHEN** the pass takes a refit mark that has no causes
- **THEN** it starts the refit, and the calibration has no `causes` key and reads `unknown`

#### Scenario: Staff start one through TownwiseAI
- **WHEN** staff, with the organization open as admin, start a calibration from TownwiseAI chat or a file read
- **THEN** the history reads its cause as `staff`, not `asked`

### Requirement: A calibration records the days it used
When the job fetches its input, the calibration SHALL also store `dayCount` (the input's history days with guests, on or before its `dataThrough`), `dataFrom` (its first day) and `newDays` (of those days, the ones after the last day of data of the location's newest run with status `published`, current or lapsed; null when there is none), beside `dataThrough`. Records without them SHALL read as null.

#### Scenario: A weekly refresh with new days
- **WHEN** the input holds 1,041 days from 2024-01-01 to 2026-11-21 and the newest published run's data ended 2026-11-15
- **THEN** the calibration stores `dayCount: 1041`, `dataFrom: '2024-01-01'` and `newDays: 6`

### Requirement: TownwiseAI's activity lists each recent finished forecast run
GET /api/org/locations/:locationId/agent SHALL include a `forecast_made` item for each finished calibration of the location among its newest 20, and each live one past its 20 minutes (as `not_run`, `failed`, dated its `requestedAt` plus 20 minutes, without a write), dated by `finishedAt`, with `calibrationId`, `causes`, `outcome`, `reason` (an owner reason code), `firstForecast`, `dayCount`, `firstDate`, `lastDate` and `newDays`. The outcome SHALL come from what happened to the run: `not_run` when it failed; `published` when its run has a `publishedAt`; `kept` otherwise. `firstForecast` SHALL be true only when no run of the location other than the calibration's own had a `publishedAt` at or before the calibration's `finishedAt`, except that a calibration whose own run is the location's earliest published run (only a `not_judged` one, whose run is an older one, can be so after another run's publish) MAY read as first, since the history reads the first published run once per request. Live calibrations under 20 minutes SHALL NOT be listed. The source SHALL be appended to `ACTIVITY_SOURCES`, and its items merged and capped with the others, keeping the newest 5 `forecast_made` items before the cut.

#### Scenario: A refit kept by the gate
- **WHEN** a refit after a sales upload succeeded and the gate held it as `not_better`
- **THEN** the activity shows a `forecast_made` item with `outcome: 'kept'`, `reason: 'not_more_accurate'` and `causes: ['sales']`

#### Scenario: A failed job
- **WHEN** a weekly calibration finished `failed` with `timeout`
- **THEN** the item has `outcome: 'not_run'` and `reason: 'failed'`

#### Scenario: Staff publish a run the gate held
- **WHEN** the gate held a calibration's run and staff later published it from the console
- **THEN** the item has `outcome: 'published'` and `reason: 'published_by_staff'`

#### Scenario: The gate published but staff withdrew the draft first
- **WHEN** the gate recorded `published: true` and the run's draft-to-published compare-and-set lost to a staff withdrawal
- **THEN** the item has `outcome: 'kept'` and `reason: 'staff_withdrew'`

#### Scenario: A run that was not judged
- **WHEN** a calibration succeeded with `gate: null` because its file matched a run Townwise already had
- **THEN** the item has `outcome: 'kept'` and `reason: 'not_judged'`

#### Scenario: A refresh after forecasts lapsed
- **WHEN** a location's published runs lapsed and a new calibration's run is published
- **THEN** its item has `firstForecast: false`

#### Scenario: Many TownwiseAI changes
- **WHEN** a location has 20 TownwiseAI changes newer than its last finished run
- **THEN** the activity still lists that run

#### Scenario: Another organization's calibrations
- **WHEN** organization B's location has finished calibrations
- **THEN** no item of organization A's activity comes from them, and no route answers A with B's calibration ids

### Requirement: Owner reasons and words are separate from staff words
Every gate reason, calibration failure and run outcome SHALL map to exactly one owner reason through an exhaustive map: `published`, `published_by_staff`, `not_more_accurate`, `not_beat_average`, `failed_checks`, `held_for_review`, `too_soon`, `needs_more_history`, `forecasts_off`, `newer_forecast`, `staff_withdrew`, `not_judged` or `failed`. The client SHALL word each item from its outcome, reason, first-forecast flag, causes and days, with a first-forecast sentence for every reason that never mentions a current forecast or says the forecast didn't change (and the same for a later run of a location with no published forecast now, `currentForecast` false), never with the staff `GATE_WORDS` or `FAILURE_WORDS`, never stating a minimum history, and never promising a retry. The `sales` cause SHALL be worded without saying the owner uploaded it, since staff setup's upload is one.

#### Scenario: A first forecast that did not beat the weekday average
- **WHEN** a first calibration's gate reason is `baseline_not_beaten`
- **THEN** the item reads that the first forecast wasn't published because it wasn't more accurate than a simple weekday average

#### Scenario: A first forecast that failed the checks
- **WHEN** a first calibration's gate reason is `coverage_out_of_band`
- **THEN** the item says it wasn't published because it didn't pass Townwise's accuracy checks, and does not contain "current"

#### Scenario: Not enough history
- **WHEN** a calibration failed `not_enough_history`
- **THEN** the item says Townwise needs more history and states no number of days

### Requirement: Run history carries no guest figure and no accuracy for anyone
A `forecast_made` item and a `lastRun` SHALL carry dates, day counts and codes only, never a guest count, sales figure or accuracy percentage, for every caller, and SHALL be the same under view-as and open-as-admin.

#### Scenario: Staff under view-as
- **WHEN** staff read the TownwiseAI panel under view-as
- **THEN** the `forecast_made` items equal the owner's and hold no guest or sales figure

