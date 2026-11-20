## ADDED Requirements

### Requirement: A marked day reads as a day with sales and no guest count
Every reader of stored days that trains, compares or analyzes SHALL first set `guests` to null on each date a note with effect `wrong_guest_count` covers, through one shared function in `api/src/closed-days.ts` (`trustedGuestDays`) and its client mirror. Net sales SHALL be unchanged. With no such note the days SHALL be returned unchanged. Record views (Your data, the sales page and its monthly totals, the location overview's month totals) SHALL keep showing the stored count.

#### Scenario: No mark
- **WHEN** a location has no note with effect `wrong_guest_count`
- **THEN** every reader's days, and the lab input, are identical to those before this change

#### Scenario: Sales stay
- **WHEN** 2025-10-31 is marked and its stored row has guests and net sales
- **THEN** readers see its guests as null and its net sales as stored, and the sales page still shows the stored guests

### Requirement: The lab never trains on a marked count
`labInputOf` SHALL send `guests: null` and `closed: false` for a marked history day, SHALL compute typical guests and the likely-closed test from trusted days, and SHALL compute `dataThrough` from the stored days, so a marked last day stays `dataThrough`. The lab's code, the input schema and `LAB_MODEL_VERSION` SHALL be unchanged. The input fingerprint SHALL change when a mark covers a history day with a stored count.

#### Scenario: Halloween weekend in the input
- **WHEN** 2025-10-31 and 2025-11-01 are marked
- **THEN** both days go to the lab with `guests` null and `closed` false, the lab trains on neither, and the fingerprint differs from the one without the note

#### Scenario: A marked last day
- **WHEN** the last stored day with guests is marked
- **THEN** `dataThrough` is still that day and its guests go out null

#### Scenario: Neighbors' typical guests
- **WHEN** a marked Friday falls among the 8 Fridays before a later Friday whose count is near a tenth of typical
- **THEN** the later Friday's typical guests and likely-closed result are computed without the marked Friday's count

### Requirement: Forecast comparisons leave a marked day out
The forecast read SHALL read the marks over every stored day it loads and SHALL give a marked day a null actual, so live accuracy does not score it, its `inRange` is null and its week's actual is null. Reason effects (weekday, term, holiday and event) SHALL leave the marked day out of both sides of every comparison.

#### Scenario: Live accuracy
- **WHEN** a run forecast 2025-10-31 open and that day is marked
- **THEN** the day is not among the run's scored days and its week has no actual

#### Scenario: A holiday effect
- **WHEN** the forecast reads the Halloween effect from the location's own history and 2025-10-31 is marked
- **THEN** the comparison uses the other Halloween days only

### Requirement: Other analyses leave a marked count out
"Your history by term state", TownwiseAI's "Questions for you", the weekly pass's holiday counts and effects, the orders baseline and the client's Home, Analytics and Calendar day classes SHALL read trusted days. A marked day SHALL never be likely closed and SHALL stay `noted`. The shared day-classes fixture SHALL pin the server and client to the same results.

#### Scenario: A door count of zero
- **WHEN** a past day with real sales has a stored guest count of 0 and is marked
- **THEN** it is not likely closed, not asked about in Questions for you, and not counted in any mean of guests

#### Scenario: The orders baseline
- **WHEN** a marked day falls inside the orders engine's history window
- **THEN** its guests are not in the baseline mean

### Requirement: TownwiseAI's day reads say the count is marked wrong
`get_sales_days` and `get_day` SHALL send a marked day's guests as null with `guestCountMarkedWrong: true`, and SHALL read typical guests and likely closed from trusted days. Their descriptions SHALL say what the field means. Chat visuals SHALL draw trusted days.

#### Scenario: Asking about Halloween
- **WHEN** the model calls `get_sales_days` for October 2025 after the mark
- **THEN** the row for 2025-10-31 has guests null, its net sales, and `guestCountMarkedWrong` true
