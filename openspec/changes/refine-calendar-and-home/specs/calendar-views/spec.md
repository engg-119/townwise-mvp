## ADDED Requirements

### Requirement: Popovers float over the page, anchored to their button
The Calendar's popovers (Your calendars, and the note form) SHALL open over the page on web and native without moving anything under them: a card (`role="dialog"` named by its heading, a `panel` fill, a 1px `border` outline, the `shadow` token, square, 16px padding) at most its own width (440px for Your calendars, 400px for the note form) and never wider than the window less 32px. From 641px wide it SHALL open 8px below its button when the room below is at least 320px or at least the room above, and 8px above it otherwise, be at most the room between the button and that edge less 24px (its 8px gap and a 16px margin) tall, and scroll inside itself past that; its right edge SHALL line up with its button's when the button's center is in the right half of the window, and its left edge otherwise, at least 16px from either window edge. Below 641px it SHALL be pinned 16px from the window's top and from either side, at most 32px less tall than the room it has. While the keyboard shows (native, iOS and Android, and web), the window's bottom SHALL be the keyboard's top for all of this, so no part of the card is under the keyboard and the card's own scroll brings the focused field into view. Placement SHALL be measured on open and again on every window size change and every keyboard show or hide. On open focus SHALL move to the card's first control ("Close" in Your calendars, the note form's Kind); while it is open focus SHALL stay inside the card, and the transparent area outside the card SHALL be neither a tab stop nor a screen reader stop. Escape on web and the back button on Android SHALL close it, as SHALL a press outside it when that popover allows one; on close, focus SHALL return to the button that opened it. Nothing SHALL animate.

#### Scenario: Below its button at the right of the row
- **WHEN** at 1280px by 900px the owner opens "Your calendars", whose button ends at the header row's right edge
- **THEN** the popover's top is 8px under the button, its right edge is level with the button's, and the grid and the day panel have not moved

#### Scenario: Above its button when the room below is short
- **WHEN** at 1280px a popover's button is 200px from the window's bottom and 600px from its top
- **THEN** the popover opens above the button, at most 576px tall, and scrolls inside itself when its content is taller

#### Scenario: Focus on open
- **WHEN** a popover opens on web
- **THEN** focus is on a control inside its card, and pressing Tab and Shift+Tab never reaches anything outside the card

#### Scenario: Escape returns focus
- **WHEN** a popover is open on web and the owner presses Escape
- **THEN** it closes and focus is on the button that opened it

#### Scenario: Phone width
- **WHEN** the window is 375px wide and a popover opens
- **THEN** it is 343px wide, 16px from either edge and 16px from the top, whichever button opened it

#### Scenario: Phone with the keyboard open
- **WHEN** the window is 375px by 667px, either popover is open, and a 300px keyboard shows for one of its fields
- **THEN** the card is at most 335px tall, ends above the keyboard, and the focused field is in view inside it

### Requirement: The note form opens in a popover
The day panel's "Add an event", a note's "Edit" and an imported event's "Make a note" SHALL each open the note form (C6) in a popover anchored to the pressed button, on web and native, headed "Add an event", "Edit note" or "Make a note", instead of in the day panel; that heading SHALL be the dialog's only heading and name, the form inside it drawing no panel, eyebrow or heading of its own. The day panel SHALL keep its shape and its "Add an event" button while a form is open. The form's fields, draft, save, notices and reads SHALL be as before. The popover SHALL close on Cancel, Escape (Android's back button), a save, a 404 on the write, and any change of the selected day, whether by a day click or by `?day=` changing otherwise (browser back or forward to another Calendar entry, or a link); a press outside it SHALL NOT close it. On close focus SHALL return to the opener, or move to the panel's notice when the opener is gone. Under view-as the three buttons SHALL stay disabled in place and the popover SHALL never open.

#### Scenario: Add an event
- **WHEN** a member presses "Add an event" on Sat, Nov 21, 2026
- **THEN** a dialog named "Add an event" opens anchored to the button with focus on Kind and the note form prefilled as a private event, more guests, on Nov 21; it has one heading, "Add an event", and no "Add a note" region or heading; and the day panel's height does not change

#### Scenario: A press outside keeps the form
- **WHEN** the member has typed a guest count and presses the grid behind the popover
- **THEN** the popover stays open with what was typed

#### Scenario: It stays open while saving
- **WHEN** the member presses Save and the API has not answered yet
- **THEN** Cancel is disabled, and Escape, Android's back button and a press outside leave the popover open, so the answer shows in it

#### Scenario: Saving closes it
- **WHEN** the member saves the form and the API answers 201
- **THEN** the popover closes, focus is on "Add an event", and the panel says "Saved." until the forecast reads again, then what the note did to the day

#### Scenario: Edit opens from its own button
- **WHEN** a member presses "Edit" on a note in the day panel
- **THEN** a dialog named "Edit note" opens anchored to that "Edit" with the note's fields

#### Scenario: A 404 takes the opener away
- **WHEN** a member saves an edit and the API answers 404
- **THEN** the popover closes, the panel says "This note isn’t available.", and focus is on that notice

#### Scenario: A day change from the URL closes the form
- **WHEN** the form is open for Sat, Nov 21, 2026 and `?day=` changes to 2026-11-20 without a day click (browser back or forward to another Calendar entry, or a link)
- **THEN** the popover closes and Nov 20 is selected, with no form open over it

#### Scenario: Native
- **WHEN** a member presses "Add an event" on native, iOS or Android
- **THEN** the note form opens in the popover, the keyboard does not cover the focused field, and the back button on Android closes it

## MODIFIED Requirements

### Requirement: The header is one 44px row with the controls in a fixed order
Under the page title the Calendar SHALL show one header row, 44px tall with items centered and wrapping: Today, then "Previous month" and "Next month" ("Previous week" and "Next week" in the week view), then the month or week label (`aria-live="polite"`, 216px wide from 641px), then the view switch, then a trailing slot that holds only the "Your calendars" button (owner-calendar). No item SHALL be taller than 44px, and nothing the trailing slot opens SHALL take a line of the row or of the page: "Your calendars" opens a popover over the page ("Popovers float over the page, anchored to their button"), and no full-width line SHALL sit under the row. From 1024px the switch and slot SHALL sit at the right; below that they start their own line at the left. Previous and Next SHALL be disabled in place at the 25 months' ends. The filters ("Show on the calendar") SHALL sit in the left column above the grid from 1024px, after the header row from 641 to 1023px, and after the grid and before the day panel at 640px and below. The no-published-forecast banner SHALL stay above the header row. The page SHALL keep the 64px bottom padding every page has.

#### Scenario: Desktop header
- **WHEN** the page opens at 1280px
- **THEN** the header row holds Today, Previous month, Next month, "November 2026", the view switch and "Your calendars" in that order, on one 44px line, and the day panel's top is level with the filters' legend

#### Scenario: The header row keeps its height across views
- **WHEN** at 1280px the owner switches from the month view to the week view
- **THEN** the header row's height does not change

#### Scenario: Filters at phone width
- **WHEN** the page is 375px wide
- **THEN** the "Show on the calendar" group comes after the grid and before the "Selected day" region in document order
- **AND** at 800px and at 1280px it comes before the grid

#### Scenario: The trailing slot
- **WHEN** the page passes the "Your calendars" button to the header's trailing slot
- **THEN** it renders after the view switch in the header row, and no line of any kind follows the row before the grid
- **AND** opening "Your calendars" adds nothing to the row or the page under it

### Requirement: The week view shows each day as a column of cards
On web from 641px the week view SHALL show the 7 days of the week the page shows (the 7-day block counted from today that holds the selected day; "The week view moves by weeks inside the 25 months") as a `role="grid"` named by the week label ("Nov 11 to 17, 2026", "Nov 25 to Dec 1, 2026", "Dec 30, 2026 to Jan 5, 2027" when today is Nov 11, 2026) with one row of 7 gridcells, each a full-height column, the click target and the roving tab stop, with the day's cell label as its `aria-label` and its card list as its `aria-describedby`. Each column SHALL be headed by the day and date ("Sun 15"; a "Today" tag under today), the status word, the figure with "+70", and one line: the range ("180 to 240") on an open forecast day, "guests" under a past figure, "No forecast" for a day the read answered as not covered, or nothing. Every item on the day SHALL be a full card: holidays and town events (including those the day's forecast names as reasons), notes, business rules (whatever the filters), imported events, and term and season periods, all-day items first (holidays, town events, notes, rules, imported events, then terms and seasons), then timed items by start time, end time and title. A card SHALL show its hours first when timed, its title in full, and a sub-line of kind words ("Holiday", "Federal holiday", "Town event", "Term", "Season", "Your note", "Your calendar", a rule's schedule summary or "Your rule") with the span for a multi-day item. Every card, a term or season card included, SHALL wrap its words onto as many lines as they need and SHALL NOT cut or ellipsize any of them; a term or season card SHALL keep its title and kind words on one wrapping run. Cards SHALL NOT be focusable. The view's box SHALL be at least as tall as the month grid at the same width and SHALL grow when a column's cards need more. A mouse or pen over a column head SHALL show the day's tooltip; cards and touch SHALL show none. The selected column SHALL be outlined `mint`.

#### Scenario: A week's columns
- **WHEN** today is Wed, Nov 11, 2026 and the week view shows Nov 18 to 24, 2026 at 1280px
- **THEN** it is a grid named "Nov 18 to 24, 2026" with 7 gridcells and exactly one in the tab order, its first column is "Wed 18", and Saturday's head shows 212 and "180 to 240"

#### Scenario: A long term title wraps
- **WHEN** at 1280px a day is covered by the term period "Fall term finals"
- **THEN** its card shows "Fall term finals" and its kind words in full over as many lines as they need, with no ellipsis, and the column grows if its cards need it

#### Scenario: The same on native
- **WHEN** the agenda on native shows a day covered by "Fall term finals"
- **THEN** its card shows the whole title, wrapping, and no line is cut

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

### Requirement: The week view moves by weeks inside the 25 months
The week view SHALL show the 7-day block counted from today that holds the selected day: its first day is today plus 7 days times the number of whole weeks from today to the selected day, rounded down (so it is today when the selected day is today), computed on calendar dates only. With no `?day=` it SHALL open on today's block, today in its first column. Previous week and Next week SHALL move the selected day 7 days back or forward, clamped to the 25 months, and SHALL be disabled in place when that block lies wholly outside them. ArrowRight from a block's last day SHALL select the next block's first day, ArrowLeft from its first day the previous block's last day, and Up and Down in the columns SHALL move 7 days. Days of a shown block outside the 25 months SHALL be inert columns (their head line only, no `data-date`, `aria-disabled`, no cards). Days whose reads are still in flight SHALL be pending columns (head line only, labeled "{date}. Loading.", no description, no tooltip, still the tab stop when selected) in an `aria-busy` box.

#### Scenario: The week opens on today
- **WHEN** today is Sun, Nov 15, 2026 and the Calendar opens at `?view=week`
- **THEN** the label reads "Nov 15 to 21, 2026", the first column is "Sun 15" with its "Today" tag, and it is selected

#### Scenario: Next week
- **WHEN** the block of Nov 15 to 21, 2026 is shown with Nov 15 selected and the owner presses Next week
- **THEN** Nov 22 is selected and the label reads "Nov 22 to 28, 2026"

#### Scenario: A day later in a block
- **WHEN** today is Wed, Nov 11, 2026 and the page loads at `?day=2026-11-21&view=week`
- **THEN** the block of Nov 18 to 24, 2026 is shown with Nov 21 selected

#### Scenario: ArrowRight from a block's last day
- **WHEN** today is Wed, Nov 11, 2026, Tue, Nov 17 is selected in the week view and the owner presses ArrowRight
- **THEN** Wed, Nov 18 is selected and the label reads "Nov 18 to 24, 2026"

#### Scenario: The last block of the range
- **WHEN** today is Wed, Nov 11, 2026 and the block of Nov 24 to 30, 2027 is shown
- **THEN** ArrowRight from Nov 30, 2027 is consumed and Next week is disabled

#### Scenario: The first block of the range
- **WHEN** today is Wed, Nov 11, 2026 and the block of Oct 29 to Nov 4, 2025 is shown
- **THEN** Oct 29 to 31, 2025 are inert columns and Previous week is disabled

#### Scenario: A week whose reads are loading
- **WHEN** Next week moves into a block whose reads are held
- **THEN** the uncovered days show their head lines only, labeled "{date}. Loading.", with no tooltip, and exactly one column is in the tab order

### Requirement: The same keys move the selection in every view, inside the 25 months
On web the month grid and the week view SHALL each be one tab stop with a roving tabIndex on the selected day, and SHALL handle these keys: Left and Right move a day across rows, weeks, blocks and months; Up and Down move a week (a day in the agenda); Home and End go to the row's Monday and Sunday in the month view and to the shown block's first and last day in the week view; Ctrl or Cmd with Home and End go to the grid month's first and last day in month view and act as Home and End in the week view; PageUp and PageDown change month as in a date picker, from the grid's month in month view and from the selected day's own month in the week view, keeping the selected day's number clamped to that month's length, the week view then showing the block that holds the new day; Enter, Space or a click select. A key whose move would leave the 25 months SHALL be consumed without moving, except Home, End and Ctrl+Home/End, which SHALL clamp to the 25 months. Home's month grid keeps its own keys.

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
- **WHEN** today is Wed, Nov 11, 2026, the week view shows the block of Oct 28 to Nov 3, 2026 with Oct 28 selected, and the owner presses PageDown
- **THEN** Nov 28 is selected and the block of Nov 25 to Dec 1, 2026 is shown

#### Scenario: Home and End in the week view
- **WHEN** today is Sun, Nov 15, 2026, Wed, Nov 18 is selected in the week view, and the owner presses Home, then End
- **THEN** Sun, Nov 15 is selected, then Sat, Nov 21

#### Scenario: Arrow keys at the range's end are consumed
- **WHEN** today is Nov 11, 2026, Nov 30, 2027 is selected and the owner presses ArrowRight
- **THEN** the selection stays on Nov 30, 2027 and the key's default is prevented
- **AND** PageDown in November 2027's grid and PageUp in November 2025's grid are consumed the same way

#### Scenario: Home and End clamp at the range's ends
- **WHEN** today is Nov 11, 2026 and the owner presses End on Mon, Nov 29, 2027, or Home on Sun, Nov 2, 2025, in month view
- **THEN** Nov 30, 2027, or Nov 1, 2025, is selected

#### Scenario: Ctrl+Home in month view
- **WHEN** Nov 18, 2026 is selected in month view and the owner presses Ctrl+Home
- **THEN** Nov 1, 2026 is selected

#### Scenario: Home's month grid keeps its keys
- **WHEN** on Home, Nov 30, 2026 is selected in This month's grid and the owner presses ArrowRight
- **THEN** the selection stays on Nov 30, 2026, as before this change

### Requirement: Each grid is read once, over its own days, inside the API's bounds
The page SHALL read the town calendar, the location's stored calendar events and the forecast over the shown view's range, and the stored sales days from 56 days before that range's first day to the earlier of its last day and yesterday, or not at all when no day of the range is past. In the month view the range SHALL be the grid's 42 days clamped to the first day of the first shown month and the last day of the last (`gridRange`), which keeps every read within 396 days of today. In the week view it SHALL be the grid's range when the shown block's days inside the 25 months (the block clamped to them, `weekRange`) all lie inside it, and otherwise `weekRange` itself. One function in `client/src/portal/calendar/grid.ts`, `readRangeFor`, SHALL compute the range for every read of the page. The forecast SHALL be one request of at most 42 days. Reads SHALL be keyed by the range's first and last day, so a view, day or block change whose range is the one already read reads nothing; while a new range reads, the days the kept reads cover SHALL show their data.

#### Scenario: November 2026
- **WHEN** today is Nov 11, 2026 and the page opens on November 2026
- **THEN** it reads the calendar and the forecast `from=2026-10-26&to=2026-12-06` (one forecast request) and the sales days `from=2026-08-31&to=2026-11-10`

#### Scenario: December 2026
- **WHEN** the owner moves to December 2026
- **THEN** the page reads the forecast `from=2026-11-30&to=2027-01-10` and no sales days

#### Scenario: Clamped at the range's ends
- **WHEN** today is Nov 11, 2026 and the grid shows November 2025, then November 2027
- **THEN** the reads cover Nov 1 to Dec 7, 2025, then Nov 1 to 30, 2027

#### Scenario: A week inside the grid reads nothing more
- **WHEN** today is Sun, Nov 15, 2026, the page shows November 2026's grid, and the owner presses Week
- **THEN** the block of Nov 15 to 21, 2026 shows its data at once and no read is made

#### Scenario: A week past the grid's last day reads its own days
- **WHEN** today is Sun, Nov 15, 2026, the grid's month is November 2026 (Oct 26 to Dec 6), and the week view moves to the block of Dec 6 to 12, 2026
- **THEN** the page reads the calendar, the stored events and the forecast `from=2026-12-06&to=2026-12-12` and no sales days, and Dec 6 shows its data while Dec 7 to 12 are pending
- **AND** pressing Month then reads November 2026's grid `from=2026-10-26&to=2026-12-06` again

#### Scenario: A block at the range's first end reads nothing more
- **WHEN** today is Wed, Nov 11, 2026, the grid shows November 2025 (read Nov 1 to Dec 7, 2025), and the owner presses Week with Nov 1, 2025 selected
- **THEN** the block of Oct 29 to Nov 4, 2025 shows, Oct 29 to 31 inert, and no read is made, since its days inside the 25 months (Nov 1 to 4) lie inside the grid's range

#### Scenario: Never past the API's bounds
- **WHEN** today is any day from Jan 1, 2026 to Dec 31, 2029 and the page shows any month or block of the 25 months
- **THEN** its range starts at most 396 days before today and ends at most 396 days after it

### Requirement: A failed forecast read leaves the calendar showing
When the forecast read fails, the page SHALL show the grid or week without forecast figures and with blank range lines, and "Couldn't load the forecast for {November}. Try again." in month view, or "Couldn't load the forecast for {Nov 15 to 21}. Try again." (the shown block's days) in the week view, between the header row and the calendar; Try again SHALL read only the forecast again. A day the published forecast does not cover SHALL show "No forecast" in the week view only when the read answered with that day not covered.

#### Scenario: Forecast fails in the week view
- **WHEN** today is Sun, Nov 15, 2026 and the forecast read fails while the block of Nov 15 to 21, 2026 is shown
- **THEN** the columns show no figures and the notice reads "Couldn't load the forecast for Nov 15 to 21. Try again."

### Requirement: A Month and Week switch, kept in the URL
The header SHALL hold a group named "Calendar view" with "Month" and "Week" buttons carrying `aria-pressed` on web and a checked state on native. `?view=week` SHALL open the week view and any other value, or none, the month view. Choosing Week SHALL set `view=week` and keep `?day=`; choosing Month SHALL remove `view` from the URL. Choosing a day SHALL keep the view. Switching views SHALL keep the grid's month, so Month, then Week, then Month returns to the same grid unless the selection left it, and SHALL read only when the shown block runs past the grid's days ("Each grid is read once, over its own days, inside the API's bounds"). Links into the Calendar from Home SHALL open the month view.

#### Scenario: Week in the URL
- **WHEN** today is Wed, Nov 11, 2026 and the owner presses Week with Nov 21, 2026 selected
- **THEN** the URL's query has `view=week` and `day=2026-11-21`, Week has `aria-pressed="true"` and Month `aria-pressed="false"`, the block of Nov 18 to 24, 2026 shows, and no read is made

#### Scenario: Reload in the week view
- **WHEN** today is Wed, Nov 11, 2026 and the page loads at `?day=2026-11-21&view=week`
- **THEN** the block of Nov 18 to 24, 2026 is shown

#### Scenario: Back to the month
- **WHEN** the owner presses Month in the week view
- **THEN** the URL has no `view` parameter (and no `view=undefined`), and November 2026's grid is shown

#### Scenario: An unknown view
- **WHEN** the page loads at `?view=year`
- **THEN** the month view is shown

#### Scenario: The switch on native
- **WHEN** today is Wed, Nov 11, 2026 and on native the owner presses Week with Nov 21, 2026 selected
- **THEN** Week has a checked state and the agenda shows the 7 days of Nov 18 to 24, 2026
