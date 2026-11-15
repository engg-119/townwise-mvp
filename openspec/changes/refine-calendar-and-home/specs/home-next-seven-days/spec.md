## ADDED Requirements

### Requirement: Home's strip shows today and the next 6 days
Home's day-by-day block (P11) SHALL show today and the 6 days after it, today first, on web and native, instead of Monday to Sunday: the strip from 1024px (one column a day, today's `raised` with its `mint` square) and the day-by-day table below 1024px. Its rows (On the calendar, Last year and Two years ago, each day's own figure for a past day with data), the term and season periods said once under its headline, its first event and its footnote SHALL all come from those 7 days. Every date SHALL be a calendar date, so no time zone or daylight saving change moves a day.

#### Scenario: A Sunday
- **WHEN** today is Sun, Nov 15, 2026 and Home loads at 1280px
- **THEN** the strip's columns are Sun, Nov 15 to Sat, Nov 21, 2026, and the first column is today's, `raised`

#### Scenario: Across a month
- **WHEN** today is Mon, Nov 30, 2026
- **THEN** the strip's days are Nov 30 to Dec 6, 2026 and each shows its own calendar entries and notes

#### Scenario: Below 1024px
- **WHEN** today is Sun, Nov 15, 2026 and Home loads at 800px
- **THEN** the table's first row is Sun, Nov 15 and its last Sat, Nov 21

#### Scenario: Native
- **WHEN** today is Sun, Nov 15, 2026 and Home opens on native
- **THEN** the day-by-day rows start on Sun, Nov 15

### Requirement: Home's words name the next 7 days
The block SHALL be named and headed "The next 7 days in {Town}" with the title "What’s on the calendar, and how these days went before". Its line SHALL read "On the calendar in the next 7 days: {title} ({weekday}), and {n} more.", or with nothing on "Nothing on {Town}’s researched calendar in the next 7 days." ("Nothing on the calendar in the next 7 days." without a researched calendar), or with only periods "No holiday or town event on {Town}’s researched calendar in the next 7 days." ("No holiday or town event in the next 7 days."). The strip's table SHALL be named "The next 7 days, day by day" and its past-years numbers "These days in past years".

#### Scenario: An event in the 7 days
- **WHEN** today is Sun, Nov 15, 2026 and Dartmouth home football is on Sat, Nov 21
- **THEN** the line reads "On the calendar in the next 7 days: Dartmouth home football (Saturday)."

#### Scenario: Nothing on the calendar
- **WHEN** no holiday, town event or period covers the 7 days in a researched town
- **THEN** the line reads "Nothing on Hanover’s researched calendar in the next 7 days."

#### Scenario: The names a screen reader hears
- **WHEN** a screen reader reaches the block
- **THEN** its region is named "The next 7 days in Hanover" and its table "The next 7 days, day by day"

### Requirement: The last-year tile sums the strip's days
At a glance's first tile SHALL be "The next 7 days, last year": the strip's 7 days 52 weeks earlier, when at least 5 of them have data, with "Same days last year, {Sun, Nov 16} to {Sat, Nov 22, 2025}. From all 7 days." (or "From {n} of its 7 days."), the usual line, the busiest day and the quietest open day as before; otherwise "Fewer than 5 of the same days last year have data, so there is no total to show."

#### Scenario: A full last year
- **WHEN** today is Sun, Nov 15, 2026 and every day from Nov 16 to 22, 2025 has data
- **THEN** the tile is headed "The next 7 days, last year", shows their total and reads "Same days last year, Sun, Nov 16 to Sat, Nov 22, 2025. From all 7 days."

#### Scenario: Too few days
- **WHEN** only 4 of those days have data
- **THEN** the tile reads "Fewer than 5 of the same days last year have data, so there is no total to show."

### Requirement: Home reads the town calendar through the strip's last day
Home's town calendar read SHALL keep its start, 2 years and 4 weeks before the current week's Monday (never before the earliest date), which the month's day detail needs for the "Two years ago" of the month's earlier days, and SHALL end on the later of the month's last day and today plus 6 days, so every day of the strip and its past years is covered.

#### Scenario: The strip runs into the next month
- **WHEN** today is Mon, Nov 30, 2026
- **THEN** Home's calendar read ends on Dec 6, 2026

#### Scenario: The month runs past the strip
- **WHEN** today is Sun, Nov 15, 2026
- **THEN** Home's calendar read runs from Oct 14, 2024 (Mon, Nov 9, 2026 less 756 days) to Nov 30, 2026

### Requirement: Home's other weeks stay Monday to Sunday
Home's Last week block (the Monday to Sunday before the current week), Who’s in town's "This week" group (runs that start by Sunday), the bar-order line ("Last year this week, Thursday to Sunday brought {n}% of the week’s guests.", over last year's Monday-to-Sunday week) and the "This week" outline and key of Home's and the Calendar's month grids SHALL stay as they are. This week's days before today then show in neither Last week nor the strip, only in the month grid [CONFIRM: the Calendar's weeks are 7-day blocks counted from today, and Home's Last week, Who's in town's This week, the bar-order line and the month grids' This week outline stay Monday to Sunday, so this week's days before today show in neither Last week nor the strip].

#### Scenario: Last week on a Sunday
- **WHEN** today is Sun, Nov 15, 2026
- **THEN** Last week covers Mon, Nov 2 to Sun, Nov 8, 2026, the month grid outlines Nov 9 to 15 as this week, and Nov 9 to 14 are in neither Last week nor the strip (Nov 15 to 21)

#### Scenario: The bar-order line
- **WHEN** today is Sun, Nov 15, 2026
- **THEN** the bar-order line still reads "Last year this week, Thursday to Sunday brought…" over Mon, Nov 10 to Sun, Nov 16, 2025
