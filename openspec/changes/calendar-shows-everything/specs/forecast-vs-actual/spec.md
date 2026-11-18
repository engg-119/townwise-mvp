## ADDED Requirements

### Requirement: A forecast figure is marked the same way everywhere
Every surface that shows a day's guest figure SHALL mark a forecast and leave an actual plain, from one rule in `client/src/portal/calendar/model.ts` beside `figureOf`: the Calendar's month cell, week view, tooltip and day panel, Home's This month cell, tooltip and day detail, Home's This week, and TownwiseAI's daily chart, on web and native. A forecast is a published day's middle figure, a past day's run figure, or a buyout's expected party; an actual is a stored figure. A forecast's figure SHALL be printed lighter (`text2`) with a leading "~", with the word "forecast" where the surface has room; an actual SHALL be a plain solid figure (`white`) with no mark. A future day and a past day with only the run's figure SHALL look the same. The mark SHALL never rest on color alone. Each grid's key SHALL name "Actual guests" and "Forecast", and each cell's label SHALL say "forecast" or "actual" after its figure.

#### Scenario: Today, a future day and a past fallback day look alike
- **WHEN** at 1280px the Calendar shows today with a forecast of 82, Nov 25 with 90, and Nov 3 with no stored guests and the run's 75
- **THEN** each cell shows its figure after "~" in `text2` with "FORECAST" in its top row, and its label says "82 guests, forecast", "90 guests, forecast" and "No data. 75 guests, forecast"

#### Scenario: An actual is plain
- **WHEN** a past day has 94 stored guests
- **THEN** its Calendar and Home cells show "94" in `white` with no tag and no "~", and its label says "94 guests, actual"

#### Scenario: A phone cell
- **WHEN** the Calendar is 375px wide
- **THEN** a forecast day shows "~82" and an actual day "94", with no tag

#### Scenario: A booked day with a party
- **WHEN** a future day is booked by a buyout note of 70 guests
- **THEN** its cell shows "BOOKED" and "~70", and its label says the booking and "70 guests, forecast"

#### Scenario: The same day on the Calendar and Home
- **WHEN** one fixture month is given to the Calendar's month and to Home's grid
- **THEN** every day's figure carries the same mark and its label the same "forecast" or "actual" on both

### Requirement: A past day says how its forecast did
When a past day has stored guests and the forecast read's day for it is scored (open in the model, not closed or likely closed, from a run made by the day), the Calendar's tooltip and day panel and Home's tooltip and day detail SHALL say "Forecast was about N (likely L to H); X guests came: inside the range", or "above the range" or "below the range", from the model's own figures. A day with no such forecast SHALL make no comparison.

#### Scenario: Inside the range
- **WHEN** Nov 6 had 94 guests and a run made Nov 2 forecast 82, 70 to 95
- **THEN** its tooltip and panel say "Forecast was about 82 (likely 70 to 95); 94 guests came: inside the range"

#### Scenario: A run made after the day
- **WHEN** Nov 6 had 94 guests and its only forecast came from a run made Nov 16
- **THEN** no surface compares them, and the panel says that a forecast made after the day isn't scored

### Requirement: A month says how many days landed inside the forecast range
The Calendar's month view and Home's This month SHALL show "So far this month: n of m days inside the forecast range." for today's month (the Calendar: "In {Month}: ..." for an earlier month), counting the forecast read's days of that month that a past day's comparison would show. With none in a month that has begun, they SHALL say "No day this month has both its guests and a forecast made before it yet."; for a later month, or while the read loads or failed, nothing. The model card's live line and Home's Last week SHALL use the same words, "inside the forecast range".

#### Scenario: Five of six
- **WHEN** today is Nov 18 and six days of November have a comparison, five inside
- **THEN** the Calendar's November and Home's This month say "So far this month: 5 of 6 days inside the forecast range."

### Requirement: Only a forecast made by a day is compared with it
The forecast read SHALL take each day from the newest published run whose data ends before the day and whose `madeAt` is on or before it, and only with none from the newest whose data ends before it. A day taken from a run made after it SHALL answer `inRange: null` and `scored: false` and SHALL count in no run's `live` and no window's `accuracy`; a week from a run made after its first day SHALL answer `inRange: null`. A run made on the day counts as made by it.

#### Scenario: A late run alone
- **WHEN** the only published run, made May 10 with data through April 30, covers May 6, which had 130 guests
- **THEN** the read's May 6 shows that run's figures with `inRange: null` and `scored: false`, and `accuracy` is null

#### Scenario: A run made in time and a later one
- **WHEN** a run made May 1 and a newer run made May 10, both with data through April 30, cover May 1 to 14
- **THEN** May 1 to 9 come from the run made May 1 and are scored against it, and May 10 to 14 from the newer run
