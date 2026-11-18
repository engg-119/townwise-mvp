## ADDED Requirements

### Requirement: One list of what is on a day feeds every calendar surface
The client SHALL build a day's entries in one pure helper (`client/src/portal/calendar/entries.ts`) and every Calendar (P28) and Home (P11) surface SHALL read its entries from it: the month cell, the tooltip, the week cards and the day panel, and Home's This week, This month grid, day detail and month list, on web and native. The list SHALL hold, in this order: the location's notes covering the day (start order), the business rules whose schedule covers the day (oldest first), the holidays then town events the filters allow, and the imported calendar events (by start time); term and season periods SHALL come last and only on the day panel, the week cards and Home's This week periods line. A note's words SHALL be its title, else its kind words ("Private event, 70"); a rule's words its text; a town entry's or imported event's words its title.

#### Scenario: A closed day with a private event
- **WHEN** at 1280px a future day is closed by a closure rule and has a private-event note titled "Holiday party"
- **THEN** its cell shows the status word in the figure's place and the entry lines "Holiday party" and the rule's text

#### Scenario: A booked day shows the party's name
- **WHEN** at 1280px a day is booked by a buyout note titled "Rehearsal dinner" and is also Veterans Day
- **THEN** its cell shows BOOKED in its corner and the entry lines "Rehearsal dinner" then "Veterans Day"

#### Scenario: Home reads the same list
- **WHEN** Home's This week shows a day with a note, a rule and an imported event
- **THEN** it lists the same entries in the same order as the Calendar's week card for that day

### Requirement: Status never hides an entry
A day's status (closed, booked, likely closed, no data or no forecast) SHALL be shown beside its entries and SHALL NOT remove any entry from any surface. A day booked by the forecast with no note behind it SHALL keep the words "Booked for a private event" and SHALL show its other entries.

#### Scenario: A run-booked day with no note
- **WHEN** a past day has no stored guests, the run booked it, and Dartmouth's fall term covers it
- **THEN** the tooltip's first line reads "No data. Booked for a private event" and the day panel lists the term

#### Scenario: Closed with entries at medium width
- **WHEN** at 800px a closed day has a holiday and a note
- **THEN** its cell shows the status word and the town and yours corner marks

### Requirement: Each surface shows a set number of entries at each width
Surfaces SHALL show, after the dedupe of compact surfaces:
- a Calendar month cell from 1024px: up to three entry lines, or the first two and "+N more" when there are four or more;
- a month cell from 641 to 1023px, at 640px and below, and on native: corner marks only (town, yours for a note or rule, imported);
- the web tooltip: the status line, up to three reasons, then up to three entries no shown reason names, or the first two and "+N more" when there are four or more;
- the week cards: every entry;
- Home's This week: up to three entries a day, or the first two and "+N more";
- Home's This month grid: the Calendar's cell rules at the same width;
- Home's month list: every entry;
- the Calendar's day panel and Home's day detail: every entry with its source, with no dedupe.

A cell's screen reader label SHALL say its status and every entry.

#### Scenario: Four entries in a cell
- **WHEN** at 1280px a day has four entries with different titles
- **THEN** its cell shows the first two and "+2 more", and its label names all four

#### Scenario: The tooltip shows reasons and entries together
- **WHEN** a web pointer rests on a day whose forecast has two reasons and which has a titled note and an imported event
- **THEN** the tooltip shows the status line, the two reasons, the note's title and the imported event's title

#### Scenario: Phone width
- **WHEN** the window is 375px wide and a day has three entries
- **THEN** its cell shows corner marks and no entry lines, and the day panel lists all three

### Requirement: Compact surfaces show a title once
On the month cell, the tooltip, the week cards, Home's This week and Home's month list, an entry whose title equals an earlier entry's on the same day, compared in lower case with each run of white space as one space and trimmed, SHALL NOT be shown. Kind words made in code (an untitled note) SHALL never be merged. The tooltip SHALL also leave out an entry whose folded words equal a shown reason's label or a shown note reason's title. The day panel and Home's day detail SHALL list each entry with its source.

#### Scenario: Veterans Day from two sources
- **WHEN** Nov 11 has the town calendar's "Veterans Day" and an imported "Veterans day " from the owner's linked calendar
- **THEN** the cell, tooltip and week card show "Veterans Day" once, and the day panel lists it twice, once under the town calendar with its sources and once as "From your calendar" with its calendar's chip

#### Scenario: Two untitled notes
- **WHEN** a day has two untitled private-event notes of 70 guests each
- **THEN** the cell shows "Private event, 70" twice

### Requirement: The forecast names a label once
The API's `reasonViews` SHALL keep one run reason per folded label on a day: the one with the larger absolute `effectPct`, else the first in the run's order. Note and rule reasons SHALL never be merged. Why, the tooltip, Home and TownwiseAI's `get_forecast` SHALL all read the deduped list.

#### Scenario: Two run reasons with one label
- **WHEN** a run gives Nov 11 a holiday reason and an event reason that both resolve to "Veterans Day", with effects of 4% and 9%
- **THEN** the forecast read lists one "Veterans Day" reason, with 9%

#### Scenario: Two note reasons
- **WHEN** two buyout notes cover a day
- **THEN** both note reasons are listed
