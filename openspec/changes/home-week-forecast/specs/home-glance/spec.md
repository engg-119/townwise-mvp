## ADDED Requirements

### Requirement: This week leads At a glance with the published forecast
When a published forecast gives each of This week's seven days (today and the next 6) a figure in This week's Forecast row, At a glance's first tile SHALL be headed "This week's forecast" and SHALL show those seven figures added up, each rounded as the row shows it: an open day's middle rounded, 0 for a closed day, and a buyout's party for a booked day with one. The total SHALL carry no range. The tile SHALL also say which days the total covers, today's figure with its range (low rounded down, high rounded up), the busiest day (a buyout as its party, with no "about"), the quietest open day when it is not the busiest, the same 7 days last year when they have a summary, and that each day's range is in This week.

#### Scenario: A full week of forecast
- **WHEN** today is Mon, Nov 23, 2026 and the published forecast's middles for Nov 23 to 29 are 110.4, 120.4, ... 170.4
- **THEN** the tile shows 980 guests, "Mon, Nov 23 to Sun, Nov 29, 2026: the 7 days' forecasts added up. Each day's range is in This week.", "Today: about 110 guests, 90 to 130." and "Busiest: Sun, Nov 29, 2026 (about 170 guests)."

#### Scenario: A closed day and a buyout
- **WHEN** one of the seven days is closed and another is your buyout with a party of 40
- **THEN** the closed day adds 0, the buyout adds 40, and neither is the quietest day

### Requirement: Without a full week of forecast the tile stays on last year
The first tile SHALL be This week, last year, exactly as before, when nothing is published, the read fails or is loading, any of the seven days has no figure in the Forecast row (not covered, booked for a private event that is not your buyout, or your buyout with no party), or the location's metric is not guests.

#### Scenario: One day not covered
- **WHEN** the published forecast covers only six of the seven days
- **THEN** the tile reads "This week, last year" and no forecast total shows

### Requirement: The Last week tile points to an upload when every day is a forecast
When every day of Last week is a forecast without a guest count, the Last week tile SHALL say "No guest counts for these days yet. Upload your sales to see how Townwise's forecast did." and SHALL show no total over those days.

#### Scenario: No uploads since last Sunday
- **WHEN** every day of last week is forecast with no guests stored
- **THEN** the tile shows those words and no figure
