## ADDED Requirements

### Requirement: Reads of up to 92 days
`GET /api/org/locations/:locationId/forecast?from=&to=` SHALL accept at most 92 days counting both ends (was 42), with `from` still at most 400 days before the server's UTC day and `to` at most 400 days after it, and answer 400 `invalid_request` beyond. TownwiseAI's `get_forecast` SHALL accept at most 92 days (was 31), `from` still at most 92 days before today; its description and invalid-input words SHALL say 92, recorded in `docs/portal/tuning-chat.md` as a frozen-prefix change.

#### Scenario: The next 91 days in one read
- **WHEN** a member reads the forecast from today through today plus 91 days
- **THEN** the API answers 200 with every covered day

#### Scenario: Too long
- **WHEN** a read spans 93 days
- **THEN** the API answers 400 `invalid_request`

#### Scenario: TownwiseAI over three months
- **WHEN** TownwiseAI calls `get_forecast` for 92 days
- **THEN** it answers with those days, and for 93 days with its invalid-input words naming 92

### Requirement: Reads stay bounded as weekly runs pile up
The forecast reader (`api/src/forecasts/reader.ts`) SHALL read rows by range (`ForecastStore.rows`' `range`, `api/src/stores/forecasts.ts:231`), covering the read window and the past days that live accuracy and `accuracy` score, instead of every row of every published run as it does today (`reader.ts:193` passes no range). Its answers SHALL not change: the same run per date, days, weeks and each run's live accuracy.

#### Scenario: A year of weekly runs
- **WHEN** a location has 52 published weekly runs of 91 days each and a member reads 42 days
- **THEN** the reader asks the store for a bounded range, and the answer equals the answer of a reader that reads every row

### Requirement: The window's own accuracy
A forecast read SHALL carry `accuracy`: live accuracy (`api/src/forecasts/score.ts`, `liveAccuracy`) over the window's own days, each from the run the reader chose for it, with booked, closed and likely-closed days left out and null under 5 scored days, exactly as a run's live accuracy. Each day SHALL carry `scored`: true when score.ts counted it. The read SHALL still log and store nothing.

#### Scenario: Last week scored
- **WHEN** a read covers 7 past days, 6 forecast open with stored guests and 1 a closure note
- **THEN** 6 days have `scored: true`, the closed day `scored: false`, and `accuracy` counts 6 days with their WAPE and in-range count

#### Scenario: Too few days
- **WHEN** only 3 days in the window are scored
- **THEN** `accuracy` is null and those 3 days still carry `scored: true`, `actual` and `inRange`

#### Scenario: Days from two runs
- **WHEN** the window's first 3 days read from a run made Nov 8 and the rest from one made Nov 15
- **THEN** `accuracy` scores each day against its own run's figures, and each run's own live accuracy is unchanged
