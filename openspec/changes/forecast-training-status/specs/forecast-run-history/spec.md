## ADDED Requirements

### Requirement: Refit marks and system calibrations record their causes
Every call that marks a location as wanting a refit SHALL name its cause, and the mark SHALL keep the set of causes since it was last cleared: `sales` for applied sales days (the upload route, staff setup's upload and the file reader), `person_change` for a person's note or rule change and an undo, `townwise_ai` for a change TownwiseAI saved (D59 changes, an automatic read's days and a calendar's answers). Clearing the mark by compare-and-set SHALL clear its causes in the same write. A calibration the weekly path starts SHALL store `causes: ['weekly']`, and one the refit path starts SHALL store the mark's causes. A person's calibration SHALL store no causes and SHALL read as `asked` (via `chat` or `file`) or `staff` (via `console`). A system calibration with no stored causes SHALL read as `unknown`. `requestedBy.via` SHALL NOT change.

#### Scenario: An upload and a note before the pass
- **WHEN** a sales upload and then a note on a past day mark the same location, and the pass starts its refit
- **THEN** the calibration stores `causes: ['sales', 'person_change']` and `requestedBy.via` is `scheduled`

#### Scenario: A mark lands during the pass
- **WHEN** TownwiseAI saves a change after the pass read the mark and before it cleared it
- **THEN** the clear does not match and the mark keeps `townwise_ai` for a later pass

#### Scenario: A calibration from before this change
- **WHEN** the history reads a system calibration with no `causes`
- **THEN** its cause reads `unknown`

### Requirement: A calibration records the days it used
When the job fetches its input, the calibration SHALL also store `dayCount` (the input's days), `dataFrom` (its first day) and `newDays` (input days after the compared published run's last day of data; null when it compared with none), beside `dataThrough`. Records without them SHALL read as null.

#### Scenario: A weekly refresh with new days
- **WHEN** the input holds 1,041 days from 2024-01-01 to 2026-11-21 and the published run's data ended 2026-11-15
- **THEN** the calibration stores `dayCount: 1041`, `dataFrom: '2024-01-01'` and `newDays: 6`

### Requirement: TownwiseAI's activity lists each finished forecast run
GET /api/org/locations/:locationId/agent SHALL include a `forecast_made` item for each finished calibration of the location among its newest 20, dated by `finishedAt`, with `calibrationId`, `causes`, `outcome` (`published` when the gate published it, `kept` when it succeeded and the gate held it, `not_run` when it failed), `reason` (an owner reason code), `firstForecast` (it compared with no published run), `dayCount`, `firstDate`, `lastDate`, `newDays`, and `accuracy` (`weeklyErrorPct`, `currentWeeklyErrorPct`, `weeks`) or null. Live calibrations SHALL NOT be listed. The source SHALL be appended to `ACTIVITY_SOURCES`, and the item merged and capped with the others. [CONFIRM: the history lists every finished run, failures included, with its causes, the days it used and its weekly error percentages]

#### Scenario: A refit kept by the gate
- **WHEN** a refit after a sales upload succeeded and the gate held it as `not_better`
- **THEN** the activity shows a `forecast_made` item with `outcome: 'kept'`, `reason: 'not_more_accurate'` and `causes: ['sales']`

#### Scenario: A failed job
- **WHEN** a weekly calibration finished `failed` with `timeout`
- **THEN** the item has `outcome: 'not_run'`, `reason: 'failed'` and `accuracy: null`

#### Scenario: Another organization's calibrations
- **WHEN** organization B's location has finished calibrations
- **THEN** no item of organization A's activity comes from them

### Requirement: Owner reasons and words are separate from staff words
Every gate reason and calibration failure SHALL map to exactly one owner reason through an exhaustive map: `published`, `not_more_accurate`, `failed_checks`, `held_for_review`, `too_soon`, `needs_more_history`, `forecasts_off`, `newer_forecast` or `failed`. The client SHALL word each item from its outcome, reason, causes, days and accuracy, never with the staff `GATE_WORDS` or `FAILURE_WORDS`, never stating a minimum history, and never promising a retry. [CONFIRM: the owner reasons, their words and the cause words]

#### Scenario: A first forecast that did not beat the weekday average
- **WHEN** a first calibration's gate reason is `baseline_not_beaten`
- **THEN** the item reads that the first forecast wasn't published because it wasn't more accurate than a simple weekday average

#### Scenario: Not enough history
- **WHEN** a calibration failed `not_enough_history`
- **THEN** the item says Townwise needs more history and states no number of days

### Requirement: Run history carries no guest figure for anyone
A `forecast_made` item SHALL carry dates, day counts, week counts and percentages only, never a guest count or sales figure, for every caller, and SHALL be the same under view-as and open-as-admin.

#### Scenario: Staff under view-as
- **WHEN** staff read the TownwiseAI panel under view-as
- **THEN** the `forecast_made` items equal the owner's and hold no guest or sales figure
