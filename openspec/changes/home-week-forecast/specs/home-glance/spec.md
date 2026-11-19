## ADDED Requirements

### Requirement: This week leads At a glance with the published forecast
When a published forecast gives at least 5 of This week's seven days (today and the next 6) a figure in This week's Forecast row, At a glance's first tile SHALL be headed "This week's forecast" and SHALL show those figures added up, each rounded as the row shows it: an open day's middle rounded, 0 for a closed day, and a buyout's party for your buyout with one. A day SHALL have no figure when the run doesn't cover it, when it is booked for a private event that isn't your buyout with a party, or when an open day lacks its range. The tile SHALL say which days the total covers and name any left out, today's figure with its range (low rounded down, high rounded up) or that today has no forecast figure, the busiest day (a buyout as its party, with no "about"), the quietest open day when it is not the busiest, and the same 7 days last year when they have a summary.

#### Scenario: A full week of forecast
- **WHEN** today is Mon, Nov 23, 2026 and the published forecast's middles for Nov 23 to 29 are 110.4, 120.4, ... 170.4
- **THEN** the tile shows 980 guests, "Mon, Nov 23 to Sun, Nov 29, 2026: the 7 days' forecasts added up.", "Today: about 110 guests, 90 to 130." and "Busiest: Sun, Nov 29, 2026 (about 170 guests)."

#### Scenario: A closed day and a buyout
- **WHEN** one of the seven days is closed and another is your buyout with a party of 40
- **THEN** the closed day adds 0, the buyout adds 40, and neither is the quietest day

#### Scenario: Six days with a figure
- **WHEN** the published forecast gives six of the seven days a figure and not Sun, Nov 29
- **THEN** the tile shows those six added up and "Mon, Nov 23 to Sun, Nov 29, 2026: 6 of the 7 days' forecasts added up. Sun, Nov 29 has no forecast figure.", with no weekly range

### Requirement: The week's total carries the run's weekly backtest range
When all seven days count and the run that gave today's figure has a weekly band (`backtest.weeklyRangePct`, its 80% band of past weekly errors, as percents below and above), the tile SHALL show "Likely {low} to {high} guests: 8 in 10 of this forecast's backtest weeks landed in a range this wide." The band SHALL apply only to the estimated part of the total (open days' figures less the guests notes and rules add); those guests and buyouts' parties SHALL be added as they are. The low SHALL round down and the high up. Without the band, or with a day left out, the tile SHALL show no weekly range and SHALL say "Each day's range is in This week." Daily ranges SHALL never be added up.

#### Scenario: A band of 20% below and 25% above
- **WHEN** all seven days count, total 980 guests with nothing from notes, rules or buyouts, and the run's band is 20% below and 25% above
- **THEN** the tile says "Likely 784 to 1,225 guests: 8 in 10 of this forecast's backtest weeks landed in a range this wide."

#### Scenario: Exact guests outside the band
- **WHEN** the week totals 700, of which 40 guests come from your notes and 60 are a buyout's party, and the band is 20% below and 25% above
- **THEN** the range is 580 to 850: 600 estimated becomes 480 to 750, plus the 100 exact guests

### Requirement: Without 5 days of forecast the tile stays on last year
The first tile SHALL be This week, last year, exactly as before, when nothing is published, the read fails, fewer than 5 of the seven days have a figure in the Forecast row, or the location's metric is not guests. While the forecast read is still out for a guests location, it SHALL show a loading skeleton headed "This week's forecast", never last year's total first.

#### Scenario: Four days covered
- **WHEN** the published forecast gives only four of the seven days a figure
- **THEN** the tile reads "This week, last year" and no forecast total shows

### Requirement: The Last week tile points to an upload when every day is a forecast
When every day of Last week is a forecast without a guest count, the Last week tile SHALL say "No guest counts for these days yet. Upload your sales to see how Townwise's forecast did." and SHALL show no total over those days.

#### Scenario: No uploads since last Sunday
- **WHEN** every day of last week is forecast with no guests stored
- **THEN** the tile shows those words and no figure
