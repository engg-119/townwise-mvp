## ADDED Requirements

### Requirement: The Sales data chart shows the hovered day
On web, a mouse or pen over Sales data's daily chart (P12) SHALL mark the nearest day with a 1px vertical rule across the plot and a dot on the line, and SHALL show the charts' shared tooltip with the day and its value ("486 guests", or the net sales in dollars on the net sales series), or "No data" on a day without a value. Touch SHALL show nothing. The tooltip and the marks SHALL be hidden from screen readers, since the chart's summary and "Show the numbers" carry the same numbers. Native SHALL be unchanged.

#### Scenario: Hovering a day with guests
- **WHEN** a member moves the mouse over the daily guests chart at May 30, 2026
- **THEN** a rule and a dot mark that day and the tooltip reads "Sat, May 30, 2026" and "486 guests"

#### Scenario: A day without data
- **WHEN** the pointer is over a day the history has no value for
- **THEN** the tooltip names the day and says "No data", and no dot is drawn

#### Scenario: Leaving the chart
- **WHEN** the pointer leaves the plot
- **THEN** the rule, the dot and the tooltip go
