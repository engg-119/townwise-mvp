## ADDED Requirements

### Requirement: Last week reads its own forecast
Home SHALL read the published forecast for the seven days before today (`from` today less 7, `to` today less 1, device date as P11) in its own request, apart from the month's read. Home SHALL never wait for it or fail with it: while it loads, when it fails, and when it answers `no_published_forecast` or covers none of the days, the Last week card and its At a glance tile SHALL show exactly today's history comparison. For each date the figures SHALL be the forecast read's own (the newest published run whose `dataThrough` is before the date); Home SHALL never compute, sum or adjust a forecast figure.

#### Scenario: The read fails
- **WHEN** the Last week forecast read fails
- **THEN** the card shows today's comparison with the same week last year and no forecast words

#### Scenario: Nothing published
- **WHEN** the read answers `no_published_forecast`
- **THEN** the card shows today's comparison and the lead's In progress line is unchanged

### Requirement: Forecast against sales
When at least one of the seven days is `scored`, the card SHALL open with the forecast's error: "Townwise's forecast was off by {12%} over {5} days. {4} of {5} days landed in its range." from the read's `accuracy`, the percentage and counts bold; with `accuracy` null (under 5 scored days) only "{2} of {3} days landed in Townwise's range." Then the card SHALL keep its last-year comparison sentence and bars. "Show the numbers" SHALL add Forecast ("About {150}, {120} to {180}") and In range ("Yes", "No") columns for the days with a forecast. Days left out of scoring (closed, likely closed, booked) SHALL show as today's card shows them. All forecast words SHALL be in guests.

#### Scenario: A scored week
- **WHEN** today is Mon, Nov 23, 2026 and Nov 16 to 22 all have stored guests and a published forecast, 6 of them `scored` with WAPE 11.6% and 5 in range, and Sunday was a closure
- **THEN** the card says "Townwise's forecast was off by 12% over 6 days. 5 of 6 days landed in its range." and then the last-year sentence

#### Scenario: Few scored days
- **WHEN** 3 days are `scored` and 2 of them in range
- **THEN** the card says "2 of 3 days landed in Townwise's range." and no percentage

### Requirement: Forecast where sales are missing
When some of the seven days have a published forecast and no stored guests, the card SHALL say "No guest count uploaded for {these days | Sat and Sun | Sat, Nov 21} yet; this is Townwise's forecast." and each such day SHALL read, in its table row and its label, "Forecast, no guest count uploaded yet: about {150} guests, {120} to {180}" (or "Forecast, no guest count uploaded yet: closed" or "... booked"), so a forecast row never reads like a sales figure; scored days keep their sales figure with their forecast beside it; on web the day's bar SHALL be drawn in the forecast style (outlined, with its range) and the key SHALL name it "Forecast". The card SHALL show no total, change or range summed over forecast days, and SHALL keep the upload link. When every day is in this state, this sentence SHALL replace "Your history ends {date}. Upload the days since to compare last week." Native SHALL show the text and the table only (D21).

#### Scenario: No uploads since last Sunday
- **WHEN** the history ends Nov 15, 2026, today is Mon, Nov 23, and a published run covers Nov 16 to 22
- **THEN** the card says "No guest count uploaded for these days yet; this is Townwise's forecast.", lists each day's forecast, offers Upload sales history, and shows no weekly total

#### Scenario: A mix of scored and forecast-only days
- **WHEN** today is Mon, Nov 23, 2026, Nov 16 to 20 have stored guests and a published forecast (all 5 `scored`, WAPE 9.8%, 4 in range), and Sat, Nov 21 and Sun, Nov 22 have a published forecast and no stored guests
- **THEN** the card says "Townwise's forecast was off by 10% over 5 days. 4 of 5 days landed in its range.", then "No guest count uploaded for Sat and Sun yet; this is Townwise's forecast.", the Saturday row reads "Forecast, no guest count uploaded yet: about 210 guests, 180 to 245", the five scored rows show their guests with the forecast beside them, and no total covers the two forecast-only days

#### Scenario: Native
- **WHEN** the card renders on native with forecast days
- **THEN** it shows the sentences and the table and no bars

### Requirement: The At a glance tile follows the card
At a glance's Last week tile SHALL say "{Off by 12%} against the forecast over {6} days" when the card shows an error with `accuracy`, "No guest count uploaded yet; Last week shows Townwise's forecast" when every day is a forecast without sales, and today's words otherwise.

#### Scenario: Tile with an error
- **WHEN** the card shows an error of 12% over 6 days
- **THEN** the tile says "Off by 12% against the forecast over 6 days"

### Requirement: Never an unpublished guess
Home SHALL show no forecast figure that is not a published run's day as the read gives it. The spec's and code's "never a guess" wording for Home (P11's opening, the Last week bullet, At a glance, `LastWeek.tsx`, `Glance.tsx` and `Home.tsx` comments) SHALL become "never an unpublished guess", and every other rule SHALL stay: no figure without a published run, runs frozen and never overwritten, a run never credited with an older run's days, and past days keeping the model's own figures (14.5 rule 1). The lead's In progress line, shown only with no published forecast, SHALL stay as it is.

#### Scenario: A draft run
- **WHEN** a calibration made a draft run covering last week and nothing is published
- **THEN** the card shows no forecast figure

#### Scenario: A note on a past day
- **WHEN** a closure note covers Nov 18 and the run forecast it open
- **THEN** the day shows the run's own figure in the table and is left out of scoring as a closure
