## ADDED Requirements

### Requirement: Outlook on read days and weeks
A forecast read (`ForecastWindow`, spec 14.4) SHALL carry `outlook: boolean` on each day, true when the date is after `tierEnd` of the run the reader chose for it, and on each week, true when any of its days is. Nothing SHALL be stored for it. Notes and scheduled business rules SHALL adjust outlook days exactly as forecast days (14.5). While every published run is a 91-day run, every day SHALL read `outlook: false` and every answer SHALL equal today's.

#### Scenario: A read across the boundary
- **WHEN** a member reads 2027-02-16 to 2027-03-01 from a run made 2026-11-23 with sales through 2026-11-22
- **THEN** days through 2027-02-22 carry `outlook: false`, later days `outlook: true`, and the week of 2027-02-22 to 2027-02-28 carries `outlook: true`

#### Scenario: A note on an outlook day
- **WHEN** a private event note with 70 guests covers an outlook day
- **THEN** the day's range adds 70 guests and its reason says so, as on a forecast day

### Requirement: Outlook days are not scored
Live accuracy (`api/src/forecasts/score.ts`) SHALL leave outlook days out of each run's `live` and the window's `accuracy`, and such a day SHALL read `scored: false` while still carrying its `actual` and `inRange`.

#### Scenario: A stale run's outlook day passes
- **WHEN** a day 100 days after its run was made has passed with stored guests
- **THEN** it carries `actual` and `inRange`, reads `scored: false`, and no accuracy counts it

### Requirement: Read limits unchanged
The forecast route SHALL keep at most 92 days a read, `from` at most 400 days back and `to` at most 400 days ahead; `get_forecast` SHALL keep 92 days, `from` at most 92 days back. The Calendar SHALL read a month in 2027 with its one read of the grid's 42 days.

#### Scenario: A month a year out
- **WHEN** a member opens the Calendar at November 2027 with today 2026-11-23
- **THEN** one forecast read covers the grid's 42 days and answers 200, its days after the run's end listed in `notCovered`

### Requirement: Reads bounded with year-long runs
The reader SHALL choose each date's run from run metadata (`dataThrough`, `range`, `dayCount`) for a run with no gap in its days, and from rows for a run with gaps, and SHALL read rows only of the runs it chose: over the read's days and a week either side, and each chosen run's own supplied days before today for its live accuracy. Its answers SHALL equal those of a reader that reads every row.

#### Scenario: 52 year-long runs
- **WHEN** a location has 52 published weekly runs of a year each and a member reads 42 days in 2027
- **THEN** the answer equals the every-row reader's, and a spy on the store sees rows requested for the chosen runs only

#### Scenario: An imported run with a gap
- **WHEN** an imported run skips a day inside its range
- **THEN** the reader chooses around the gap from rows, and the answer equals the every-row reader's

### Requirement: TownwiseAI marks the outlook
`get_forecast` SHALL give each day and week its `outlook`, and its description SHALL say that a day or week with `outlook` true is more than 91 days after its run was made, or more than 182 days after the last sales the run learned from, to call it Townwise's outlook, give its range, and not say 8 in 10 for it, recorded in `docs/portal/tuning-chat.md` as a frozen-prefix change. A daily `show_visual` SHALL carry `outlook` on its days.

#### Scenario: An outlook day in chat
- **WHEN** TownwiseAI reads a range whose last days are outlook days
- **THEN** those days carry `outlook: true`, and the description pinned by `api/test/chat-estimate-tools.test.ts` carries the outlook sentence
