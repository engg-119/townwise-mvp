## ADDED Requirements

### Requirement: The month grid always shows six full weeks
The Calendar's month view SHALL show exactly 42 consecutive days in 6 rows of 7, Monday first, starting on the Monday on or before the shown month's 1st, on web and native. A month that fits in 4 or 5 weeks SHALL still get 6 rows. Date math SHALL use calendar dates only, so the grid never depends on the device's time zone or a daylight saving change.

#### Scenario: A month that starts on a Sunday
- **WHEN** the grid shows November 2026
- **THEN** its days run from Mon, Oct 26, 2026 to Sun, Dec 6, 2026, with 6 leading and 6 trailing days

#### Scenario: A 4-row month gets 6 rows
- **WHEN** the grid shows February 2027, which starts on a Monday and has 28 days
- **THEN** its days run from Feb 1 to Mar 14, 2027, with no leading day and 14 trailing days in two rows

#### Scenario: A 5-row month gets 6 rows
- **WHEN** the grid shows January 2027
- **THEN** its days run from Mon, Dec 28, 2026 to Sun, Feb 7, 2027

#### Scenario: Across a year boundary
- **WHEN** the grid shows December 2026
- **THEN** its days run from Mon, Nov 30, 2026 to Sun, Jan 10, 2027

#### Scenario: Across a daylight saving change
- **WHEN** the grid shows November 2026 (which holds Nov 1, 2026) or March 2027 (which holds Mar 14, 2027)
- **THEN** it lists 42 consecutive dates with a Monday at every row start

### Requirement: The month grid's height depends on the width alone
Every month cell SHALL have a fixed height that depends only on the window width: 104px from 1024px, 64px from 641 to 1023px and 52px at 640px and below, on web and native. A cell's content SHALL never change its height, so the grid is 658px, 418px or 346px tall (a 16px weekday row, 6 rows and six 3px gaps) for every month.

#### Scenario: Same height for every month
- **WHEN** the window is 1280px wide and the grid shows November 2026, then January 2027, then February 2027
- **THEN** every cell is 104px tall each time and the grid's height does not change

#### Scenario: A busy day does not grow its row
- **WHEN** a day has five entries
- **THEN** its cell keeps the row's fixed height and shows "+N more" instead of growing

#### Scenario: Smaller widths
- **WHEN** the window is 800px wide, then 375px wide
- **THEN** cells are 64px tall, then 52px tall

### Requirement: Leading and trailing days are real, muted and selectable in place
Days of the previous and next months that complete the grid's first and last weeks SHALL show everything an in-month day shows (figure, status, entries and marks, from the same reads), muted with theme tokens: no `raised` fill but a 1px `border` outline, and the number, figure and entries in `text3`. Each SHALL carry `data-outside="1"` on web and keep its full-date label. Selecting one SHALL select it without moving the grid. Today SHALL keep its own number style, and the selected day its `mint` outline, in a leading or trailing cell.

#### Scenario: A trailing day shows its own data
- **WHEN** the grid shows November 2026 and Dec 3 has a town event and Dec 2 a published forecast day
- **THEN** the Dec 3 cell shows the event's title and the Dec 2 cell shows its forecast figure, both muted

#### Scenario: Clicking a trailing day keeps the grid
- **WHEN** the grid shows November 2026 and the owner clicks Dec 3
- **THEN** Dec 3 is selected and outlined `mint`, the day panel shows "Thu, Dec 3, 2026", the grid is still named "November 2026", and no new forecast read is made

#### Scenario: Today in a trailing cell
- **WHEN** today is Nov 3, 2026 and the grid shows October 2026 (Sep 28 to Nov 8)
- **THEN** the Nov 3 cell is muted as an outside day but its number keeps today's `white`, 600 style

#### Scenario: A screen reader hears the full date
- **WHEN** a screen reader reaches the Dec 3 cell in the grid named "November 2026"
- **THEN** its label starts with "Thu, Dec 3, 2026."

### Requirement: The grid moves only on navigation or when the selected day leaves it
The grid SHALL change month only on Previous, Next or Today, on PageUp or PageDown, or when the selected day leaves its 42 days (a key past the first or last row, browser back or forward, or a link). Otherwise it SHALL keep its month while the selected day is anywhere in its 42 days. The selected day SHALL always be in the shown grid. Previous and Next SHALL step from the grid's month, never from the selected day's month. The page SHALL keep the grid's month in its own state, not in the URL, and SHALL derive a new grid month from `?day=` only on a render where `?day=` changed, so a render that sees a newly set month with the old day never undoes it.

#### Scenario: Next month from a 1st that is already in the grid
- **WHEN** the grid shows November 2026 with Nov 11 selected and the owner presses Next month
- **THEN** the grid shows December 2026 with Dec 1 selected, even though Dec 1 is in November's grid

#### Scenario: Previous and Next from a trailing day
- **WHEN** Dec 3 is selected in November 2026's grid and the owner presses Next month
- **THEN** the grid shows December 2026, not January 2027
- **AND** pressing Previous month from November 2026's grid with Dec 3 selected shows October 2026

#### Scenario: Today from a trailing day
- **WHEN** Dec 3 is selected in November 2026's grid and the owner presses Today
- **THEN** the grid shows November 2026 with Nov 11 selected

#### Scenario: Today with today already selected in an outside cell
- **WHEN** today is Nov 3, 2026, the grid shows October 2026, the owner has selected Nov 3 in its trailing row, and presses Today
- **THEN** the grid shows November 2026 with Nov 3 still selected, though `?day=` does not change

#### Scenario: A split render does not undo Next
- **WHEN** after Next month one render sees the grid month set to December 2026 while `?day=` is still Nov 11, and the following render sees `?day=` Dec 1
- **THEN** the grid ends on December 2026 with Dec 1 selected

#### Scenario: A key past the last row
- **WHEN** Dec 6 is selected in November 2026's grid and the owner presses ArrowRight
- **THEN** Dec 7 is selected and the grid shows December 2026

#### Scenario: Back to a day outside the grid
- **WHEN** the owner goes back in the browser to `?day=2026-09-15` while the grid shows November 2026
- **THEN** the grid shows September 2026 with Sep 15 selected

#### Scenario: A day outside the 25 months
- **WHEN** the page opens at `?day=2028-03-01` with today Nov 11, 2026
- **THEN** today is selected and the grid shows November 2026

### Requirement: Days outside the 25 months are inert
A grid day outside the months the page shows (12 before today's to 12 after) SHALL show its number only, in `text3`, SHALL have no `data-date` on web, SHALL carry `aria-disabled="true"` and the label "{date}. Outside the months the calendar shows.", SHALL ignore click, hover and keys, and SHALL NOT be read. On native it SHALL be a disabled element with the same label.

#### Scenario: The last grid of the range
- **WHEN** today is Nov 11, 2026 and the grid shows November 2027 (Nov 1 to Dec 12, 2027)
- **THEN** Dec 1 to 12, 2027 are inert, Dec 5's label is "Sun, Dec 5, 2027. Outside the months the calendar shows.", and clicking or hovering one does nothing

#### Scenario: The first grid of the range
- **WHEN** today is Nov 11, 2026 and the grid shows November 2025 (Oct 27 to Dec 7, 2025)
- **THEN** Oct 27 to 31, 2025 are inert and the grid's reads start on Nov 1, 2025

### Requirement: Month cells show up to three entries from 1024px
From 1024px a month cell SHALL show, in three rows: the day number at the left of a 16px top row, with "BOOKED" (a booked day) or "guests" (under a past figure) at its right; a 26px middle row with the figure centered and the notes' "+70" inline in `mint`, or on a closed or likely-closed day the status word centered in its place over up to two lines ("LIKELY" over "CLOSED"), the row kept even when empty; and up to three one-line entry lines (holiday and town event titles, a note's kind words such as "Private event, 70", an imported event's title), showing every entry when there are three or fewer and otherwise the first two and "+{n} more". From 641 to 1023px a cell SHALL show the same top row, then its 18px figure with "+70" inline or its status word over up to two lines, and corner marks instead of entries. At 640px and below a cell SHALL show its number, then its 15px figure, or any status word (BOOKED included) in the figure's place, and corner marks; "+70" and the caption leave the cell. Term and season periods SHALL NOT appear in a month cell. A cell's label SHALL say everything the day holds, as today.

#### Scenario: Three entries all show
- **WHEN** at 1280px a day has a town event, a private-event note and an imported event
- **THEN** its cell shows all three entry lines and no "+N more"

#### Scenario: Four entries
- **WHEN** at 1280px a day has four entries
- **THEN** its cell shows the first two and "+2 more"

#### Scenario: A likely-closed day
- **WHEN** at 1024px a past day was likely closed
- **THEN** its cell shows "LIKELY" over "CLOSED" where the figure goes

#### Scenario: Medium width
- **WHEN** the window is 800px wide and a day has a town event and a note
- **THEN** its cell shows its corner marks and no entry lines

#### Scenario: Phone width
- **WHEN** the window is 375px wide and a future day is booked or likely closed
- **THEN** its cell shows the status word where the figure goes and no figure

#### Scenario: A term period
- **WHEN** a Dartmouth term covers a day
- **THEN** the month cell shows no entry for the term, and the day panel lists it

### Requirement: A new grid's days render at once while its reads load
On a month change the grid SHALL render the new month's 42 dates at once, named after the new month (`monthLabel` of the grid's month), dimmed (opacity 0.6) and `aria-busy`. Dates the kept reads cover SHALL show their data; any other date SHALL be pending: its number only, labeled "{date}. Loading.", focusable with its `data-date`, and with no tooltip. Exactly one cell SHALL be in the tab order throughout. The day panel SHALL show "Loading the day" until its day is covered.

#### Scenario: ArrowDown into a month still loading
- **WHEN** Nov 30 is selected in November 2026's grid, December's reads are held, and the owner presses ArrowDown
- **THEN** before the reads answer, the grid is named "December 2026" and `aria-busy`, Dec 7 is selected and focused, exactly one cell has `tabindex="0"`, Nov 30 to Dec 6 show their data, and Dec 7 onward show only their numbers

#### Scenario: No tooltip over a pending day
- **WHEN** a mouse moves over a pending day
- **THEN** no tooltip shows

### Requirement: The same keys move the selection in every view, inside the 25 months
On web the month grid and the week view SHALL each be one tab stop with a roving tabIndex on the selected day, and SHALL handle these keys: Left and Right move a day across rows, weeks and months; Up and Down move a week (a day in the agenda); Home and End go to the row's Monday and Sunday; Ctrl or Cmd with Home and End go to the grid month's first and last day in month view and act as Home and End in the week view; PageUp and PageDown change month as in a date picker, from the grid's month in month view and from the selected day's own month in the week view, keeping the selected day's number clamped to that month's length; Enter, Space or a click select. A key whose move would leave the 25 months SHALL be consumed without moving, except Home, End and Ctrl+Home/End, which SHALL clamp to the 25 months. Home's month grid keeps its own keys.

#### Scenario: PageDown from an in-month day
- **WHEN** Nov 3, 2026 is selected in month view and the owner presses PageDown
- **THEN** the grid shows December 2026 with Dec 3 selected, even though Dec 3 was in November's grid

#### Scenario: PageDown clamps to the month's length
- **WHEN** Jan 31, 2027 is selected in January's grid and the owner presses PageDown
- **THEN** the grid shows February 2027 with Feb 28 selected
- **AND** PageDown from Dec 31, 2026 gives Jan 31, 2027, and from Jan 31, 2028 gives Feb 29, 2028

#### Scenario: PageUp and PageDown from outside days
- **WHEN** the grid shows November 2026 with Oct 28 selected
- **THEN** PageUp shows October 2026 with Oct 28 selected, and PageDown shows December 2026 with Dec 28 selected

#### Scenario: PageDown from a trailing day keeps the day
- **WHEN** the grid shows November 2026 with Dec 6 selected and focused, and the owner presses PageDown
- **THEN** the grid shows December 2026 with Dec 6 still selected and focused, and `?day=` does not change

#### Scenario: PageDown in the week view
- **WHEN** the week view shows the week of Oct 26, 2026 with Oct 28 selected and the owner presses PageDown
- **THEN** Nov 28 is selected

#### Scenario: Arrow keys at the range's end are consumed
- **WHEN** today is Nov 11, 2026, Nov 30, 2027 is selected and the owner presses ArrowRight
- **THEN** the selection stays on Nov 30, 2027 and the key's default is prevented
- **AND** PageDown in November 2027's grid and PageUp in November 2025's grid are consumed the same way

#### Scenario: Home and End clamp at the range's ends
- **WHEN** today is Nov 11, 2026 and the owner presses End on Mon, Nov 29, 2027, or Home on Sun, Nov 2, 2025
- **THEN** Nov 30, 2027, or Nov 1, 2025, is selected

#### Scenario: Ctrl+Home in month view
- **WHEN** Nov 18, 2026 is selected in month view and the owner presses Ctrl+Home
- **THEN** Nov 1, 2026 is selected

#### Scenario: Home's month grid keeps its keys
- **WHEN** on Home, Nov 30, 2026 is selected in This month's grid and the owner presses ArrowRight
- **THEN** the selection stays on Nov 30, 2026, as before this change

### Requirement: Focus and announcements survive every change of grid, week and view
After a key move the newly selected cell SHALL take focus (with `preventScroll` in the week view). After Previous, Next, Today or the view switch, focus SHALL stay on the pressed button and the toolbar label, which is `aria-live="polite"`, SHALL announce the new month or week. When the grid or week view held focus and the focused cell is gone after a render, focus SHALL move to the selected cell, never to the page body. A click outside the calendar SHALL NOT pull focus back. On native every cell and agenda row SHALL carry its label and its selected state.

#### Scenario: Back to a day in another grid with focus on a cell
- **WHEN** focus is on a cell and browser back selects a day outside the shown grid
- **THEN** focus is on the newly selected cell, not on the body

#### Scenario: Next month keeps focus on the button
- **WHEN** the owner presses Next month with the keyboard
- **THEN** focus stays on Next month and the label "December 2026" is announced

#### Scenario: Back across the view with focus on a week column
- **WHEN** focus is on a column of the week view and browser back returns the page to the month view
- **THEN** focus is on the selected day's cell in the month grid, not on the body

#### Scenario: Focus elsewhere is left alone
- **WHEN** focus is on a toolbar button and `?day=` changes to a day outside the shown grid
- **THEN** focus stays on that button

### Requirement: Each grid is read once, over its own days, inside the API's bounds
The page SHALL read the town calendar and the forecast over the grid's range, and the stored sales days from 56 days before the range's first day to the earlier of its last day and yesterday, or not at all when no day of the range is past. The grid's range SHALL be its 42 days clamped to the first day of the first shown month and the last day of the last, which keeps every read within 396 days of today. The forecast SHALL be one request of at most 42 days, keyed by the grid's month. Selecting a day inside the grid and switching views SHALL read nothing. One function in `client/src/portal/calendar/grid.ts`, `gridRange`, SHALL compute this range for every read of a grid, including later reads such as stored calendar events.

#### Scenario: November 2026
- **WHEN** today is Nov 11, 2026 and the page opens on November 2026
- **THEN** it reads the calendar and the forecast `from=2026-10-26&to=2026-12-06` (one forecast request) and the sales days `from=2026-08-31&to=2026-11-10`

#### Scenario: December 2026
- **WHEN** the owner moves to December 2026
- **THEN** the page reads the forecast `from=2026-11-30&to=2027-01-10` and no sales days

#### Scenario: Clamped at the range's ends
- **WHEN** today is Nov 11, 2026 and the grid shows November 2025, then November 2027
- **THEN** the reads cover Nov 1 to Dec 7, 2025, then Nov 1 to 30, 2027

#### Scenario: Never past the API's bounds
- **WHEN** today is any day from Jan 1, 2026 to Dec 31, 2029 and the grid shows any of the 25 months
- **THEN** its range starts at most 396 days before today and ends at most 396 days after it

### Requirement: A failed forecast read leaves the calendar showing
When the forecast read fails, the page SHALL show the grid or week without forecast figures and with blank range lines, and "Couldn't load the forecast for {November}. Try again." in month view, or "Couldn't load the forecast for {Nov 16 to 22}. Try again." in the week view, between the header row and the calendar; Try again SHALL read only the forecast again. A day the published forecast does not cover SHALL show "No forecast" in the week view only when the read answered with that day not covered.

#### Scenario: Forecast fails in the week view
- **WHEN** the forecast read fails while the week of Nov 16, 2026 is shown
- **THEN** the columns show no figures and the notice reads "Couldn't load the forecast for Nov 16 to 22. Try again."

### Requirement: The header is one 44px row with the controls in a fixed order
Under the page title the Calendar SHALL show one header row, 44px tall with items centered and wrapping: Today, then "Previous month" and "Next month" ("Previous week" and "Next week" in the week view), then the month or week label (`aria-live="polite"`, 216px wide from 641px), then the view switch, then a trailing slot. No item SHALL be taller than 44px. From 1024px the switch and slot SHALL sit at the right; below that they start their own line at the left. Previous and Next SHALL be disabled in place at the 25 months' ends. The filters ("Show on the calendar") SHALL sit in the left column above the grid from 1024px, after the header row from 641 to 1023px, and after the grid and before the day panel at 640px and below. The no-published-forecast banner SHALL stay above the header row. The page SHALL keep the 64px bottom padding every page has.

#### Scenario: Desktop header
- **WHEN** the page opens at 1280px
- **THEN** the header row holds Today, Previous month, Next month, "November 2026", the view switch and Import a calendar file in that order, and the day panel's top is level with the filters' legend

#### Scenario: The header row keeps its height across views
- **WHEN** at 1280px the owner switches from the month view to the week view
- **THEN** the header row's height does not change

#### Scenario: Filters at phone width
- **WHEN** the page is 375px wide
- **THEN** the "Show on the calendar" group comes after the grid and before the "Selected day" region in document order
- **AND** at 800px and at 1280px it comes before the grid

#### Scenario: The trailing slot
- **WHEN** the page passes a control to the header's trailing slot
- **THEN** it renders after the view switch in the header row, before the import's full-width line

### Requirement: Importing a calendar file is a header button with a "How importing works" disclosure
On web the trailing slot SHALL hold an "Import a calendar file" button that opens the file picker and is described by the import help, and a "How importing works" button with `aria-expanded` and `aria-controls` that shows or hides the help on a full-width line under the header row. The help SHALL stay in the DOM while hidden, so the import button's description always resolves. The import's result and error messages SHALL show on that same line whether the disclosure is open or not, and SHALL survive a switch between views. On native the same place SHALL show "To add events from your own calendar file, open Townwise on the web.". The help's words are unchanged.

#### Scenario: The help starts hidden
- **WHEN** the page opens on web
- **THEN** "How importing works" has `aria-expanded="false"`, the help is hidden but present, and the import button's `aria-describedby` names it

#### Scenario: Opening the help
- **WHEN** the owner presses "How importing works"
- **THEN** it has `aria-expanded="true"` and the help shows under the header row

#### Scenario: A result without the help
- **WHEN** the owner imports kitchen.ics with 12 events while the help is closed
- **THEN** "12 events from kitchen.ics." shows under the header row and "Your calendar" appears among the filters, on

#### Scenario: An error survives a view switch
- **WHEN** a file over 1 MB was refused and the owner switches to the week view and back
- **THEN** the refusal is still shown

### Requirement: The week view shows each day as a column of cards
On web from 641px the week view SHALL show the selected day's week, Monday to Sunday, as a `role="grid"` named by the week label ("Nov 16 to 22, 2026", "Nov 30 to Dec 6, 2026", "Dec 28, 2026 to Jan 3, 2027") with one row of 7 gridcells, each a full-height column, the click target and the roving tab stop, with the day's cell label as its `aria-label` and its card list as its `aria-describedby`. Each column SHALL be headed by the day and date (a "Today" tag under today), the status word, the figure with "+70", and one line: the range ("180 to 240") on an open forecast day, "guests" under a past figure, "No forecast" for a day the read answered as not covered, or nothing. Every item on the day SHALL be a full card: holidays and town events (including those the day's forecast names as reasons), notes, business rules (whatever the filters), imported events, and term and season periods, all-day items first (holidays, town events, notes, rules, imported events, then terms and seasons), then timed items by start time, end time and title. A card SHALL show its hours first when timed, its title in full, and a sub-line of kind words ("Holiday", "Federal holiday", "Town event", "Term", "Season", "Your note", "Your calendar", a rule's schedule summary or "Your rule") with the span for a multi-day item; a term or season card is one line. Cards SHALL NOT be focusable. The view's box SHALL be at least as tall as the month grid at the same width. A mouse or pen over a column head SHALL show the day's tooltip; cards and touch SHALL show none. The selected column SHALL be outlined `mint`.

#### Scenario: A week's columns
- **WHEN** the week view shows Nov 16 to 22, 2026 at 1280px
- **THEN** it is a grid named "Nov 16 to 22, 2026" with 7 gridcells and exactly one in the tab order, and Saturday's head shows 212 and "180 to 240"

#### Scenario: Card order and hours
- **WHEN** a day has a town event, an all-day note, an imported event from 09:00 to 10:00 and a private-event note from 18:00 to 21:00
- **THEN** its cards are the town event, the all-day note, the import headed "9 am to 10 am", then the note headed "6 pm to 9 pm"

#### Scenario: An event Why already names still gets a card
- **WHEN** the day's forecast names "Dartmouth home football" as a reason
- **THEN** the day's column still has a "Dartmouth home football" card

#### Scenario: Filters and rules
- **WHEN** the owner turns off Term dates and every other filter
- **THEN** term and season cards go, and a business rule covering the day still shows with its schedule summary as its sub-line

#### Scenario: A rule with no end date
- **WHEN** a rule's schedule has no end date
- **THEN** its card builds with its schedule summary, or "Your rule" when it has none

#### Scenario: A national holiday
- **WHEN** a day holds a national holiday
- **THEN** its card's sub-line starts "Federal holiday"

#### Scenario: The description names the hours
- **WHEN** a screen reader reaches a column with a timed card
- **THEN** the column's description includes that card's hours and title

#### Scenario: The same height as the month grid
- **WHEN** at 1280px the owner switches between the month view and the week view
- **THEN** the week view's box is at least 658px tall and the page height does not change for a week whose cards fit

### Requirement: The week view is an agenda on phones and on native
At 640px and below on web, and at every width on native, the week view SHALL be an agenda of 7 rows, each the day's head line (date, figure, range or status) above full-width cards. On web it SHALL be a `role="grid"` named by the week label with 7 rows of one gridcell each, carrying the same label and description as a column, where Up and Down move one day. On native each row SHALL be a pressable element with the day's label and selected state, and pressing it SHALL select the day.

#### Scenario: Web at phone width
- **WHEN** the week view shows at 600px
- **THEN** it is a grid of 7 rows with one gridcell each, and ArrowDown moves the selection one day

#### Scenario: Native
- **WHEN** the week view shows on native
- **THEN** there are 7 rows labeled with their days' labels, and pressing one selects that day

### Requirement: The week view moves by weeks inside the 25 months
In the week view Previous week and Next week SHALL move the selected day 7 days back or forward, clamped to the 25 months, and SHALL be disabled in place when that week lies wholly outside them. ArrowRight from a Sunday SHALL select the next Monday, and Up and Down in the columns move 7 days. Days of a shown week outside the 25 months SHALL be inert columns (their head line only, no `data-date`, `aria-disabled`, no cards). Days whose reads are still in flight SHALL be pending columns (head line only, labeled "{date}. Loading.", no description, no tooltip, still the tab stop when selected) in an `aria-busy` box.

#### Scenario: Next week
- **WHEN** the week of Nov 16, 2026 is shown and the owner presses Next week
- **THEN** the label reads "Nov 23 to 29, 2026"

#### Scenario: ArrowRight from Sunday
- **WHEN** Sun, Nov 22, 2026 is selected in the week view and the owner presses ArrowRight
- **THEN** Mon, Nov 23, 2026 is selected and its week is shown

#### Scenario: The last week of the range
- **WHEN** today is Nov 11, 2026 and the week of Nov 29, 2027 is shown
- **THEN** Dec 1 to 5, 2027 are inert columns, ArrowRight from Nov 30, 2027 is consumed, and Next week is disabled

#### Scenario: A week whose reads are loading
- **WHEN** Next week crosses into a grid whose reads are held
- **THEN** the uncovered days show their head lines only, labeled "{date}. Loading.", with no tooltip, and exactly one column is in the tab order

### Requirement: A Month and Week switch, kept in the URL
The header SHALL hold a group named "Calendar view" with "Month" and "Week" buttons carrying `aria-pressed` on web and a checked state on native. `?view=week` SHALL open the week view and any other value, or none, the month view. Choosing Week SHALL set `view=week` and keep `?day=`; choosing Month SHALL remove `view` from the URL. Choosing a day SHALL keep the view. Switching views SHALL make no read and SHALL keep the grid's month, so Month, then Week, then Month returns to the same grid unless the selection left it. Links into the Calendar from Home SHALL open the month view.

#### Scenario: Week in the URL
- **WHEN** the owner presses Week with Nov 21, 2026 selected
- **THEN** the URL's query has `view=week` and `day=2026-11-21`, Week has `aria-pressed="true"` and Month `aria-pressed="false"`, and no read is made

#### Scenario: Reload in the week view
- **WHEN** the page loads at `?day=2026-11-21&view=week`
- **THEN** the week of Nov 16 to 22, 2026 is shown

#### Scenario: Back to the month
- **WHEN** the owner presses Month in the week view
- **THEN** the URL has no `view` parameter (and no `view=undefined`), and November 2026's grid is shown

#### Scenario: An unknown view
- **WHEN** the page loads at `?view=year`
- **THEN** the month view is shown

#### Scenario: The switch on native
- **WHEN** on native the owner presses Week with Nov 21, 2026 selected
- **THEN** Week has a checked state and the agenda shows the 7 days of Nov 16 to 22, 2026

### Requirement: Loading keeps the loaded page's shape
While the first reads load, the Calendar SHALL show its skeleton with "Loading the calendar": the header row's blocks (Today, the two arrows, a 216px label that is flexible at 640px and below, the view switch and the import button), the filters' legend and chips where the page puts them for the width (in the left column above the grid from 1024px), a month grid of exactly 6 rows of 7 cells whose fixed height is the loaded cell height for the width (104px, 64px or 52px), and the day panel, beside the grid from 1024px and under it below. Home's skeleton month SHALL look as it does today.

#### Scenario: Skeleton cells match the grid
- **WHEN** the Calendar loads at 1280px
- **THEN** the skeleton shows 42 cells, each 104px tall, and its grid's top and bottom match the loaded grid's

#### Scenario: Skeleton filters at phone width
- **WHEN** the Calendar loads at 375px
- **THEN** the skeleton's chips come after its month grid, as the page's filters do

#### Scenario: Home's skeleton is unchanged
- **WHEN** Home loads
- **THEN** its skeleton month still shows 42 empty cells 52px tall
