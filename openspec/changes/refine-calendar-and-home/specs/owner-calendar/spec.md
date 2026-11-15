## MODIFIED Requirements

### Requirement: The Calendar page shows and manages stored calendars
The Calendar page (P28) SHALL show the stored events as "Your calendar" on web and native, read with the page's other reads over the shown view's range (`readRangeFor`, calendar-views), and SHALL hold one control in its header row's trailing slot on web and native: a "Your calendars" button reading "Your calendars (N)" with N the location's calendar count, or "Your calendars" with none, with `aria-expanded` and `aria-haspopup="dialog"` on web (and `aria-controls` naming the popover while it is open) and an expanded state on native, closed on every load. It replaces the header row's "Import a calendar file" button and "How importing works" link. The button SHALL open and close a popover anchored to it (calendar-views' "Popovers float over the page, anchored to their button", at most 440px wide), headed "Your calendars" with a "Close" button, that lists each calendar's name, kind ("File" or "Link"), host for a link, event count, repeating events not imported, and for a link its status in words and its last refresh time, with "Refresh now" (a link) and "Remove" per calendar, and under the list "Import a calendar file" (web), "Add a link" (an inline form with a name of at most 60 characters and the address) and "How importing works". Nothing under the header row SHALL move when it opens or closes. Opening it SHALL move focus to its "Close" button. A press outside the popover SHALL close it, except while its Remove dialog is open. While a link add, a file import or a Refresh now runs, the popover SHALL stay open: "Close" disabled in place, and Escape, Android's back button and a press outside doing nothing, so every answer shows in the open popover. Closing it SHALL keep its messages, whether the help and the add-a-link form are open, and what was typed in the form, so they show again when it opens; a link added (201) and the form's Cancel SHALL each clear what was typed. A file import SHALL be named after the file. Every failure code SHALL show plain words and store nothing. Under view-as the popover SHALL be read-only. "Make a note" from a stored event SHALL open the note form as calendar-views says, with the note's detail empty.

#### Scenario: The button with calendars
- **WHEN** the Calendar opens for a location with 2 calendars
- **THEN** the header row's last control reads "Your calendars (2)" with `aria-expanded="false"` and `aria-haspopup="dialog"`, no popover is in the document, and the grid sits directly under the header row

#### Scenario: The button with none
- **WHEN** the Calendar opens for a location with no calendar
- **THEN** the button reads "Your calendars" and no "Your calendar" filter chip shows

#### Scenario: Opening the popover
- **WHEN** a member presses "Your calendars (2)"
- **THEN** it has `aria-expanded="true"` and `aria-controls` naming a dialog "Your calendars" anchored to it, with focus on its "Close", which lists a file as "File, 12 events" and a link as "Link, calendar.google.com, 3 events" with its "Updated" time, then "Import a calendar file", "Add a link" and "How importing works", and the grid and the day panel have not moved

#### Scenario: Closing keeps what was typed
- **WHEN** a member opens "Add a link", types a name, closes the popover with Escape and opens it again
- **THEN** the form is open with the name as typed, and focus was on "Your calendars" while it was closed

#### Scenario: A press outside closes it
- **WHEN** the popover is open and the member presses the grid
- **THEN** the popover closes and nothing is selected in the grid by that press

#### Scenario: Importing a file
- **WHEN** on web a member imports "Kitchen bookings.ics" from the popover
- **THEN** the page posts `{ kind: 'file', label: 'Kitchen bookings', ics }` with the file's text, says "Added Kitchen bookings: {n} events." in the popover, reads the calendar list and the shown range's stored events again (not the forecast), and the file's events show on the Calendar with "Your calendar" on
- **AND** after a reload they still show

#### Scenario: Adding a link
- **WHEN** a member adds a link named "Bookings" with a Google Calendar iCal address
- **THEN** the page posts `{ kind: 'link', label: 'Bookings', url }`, shows "Adding…" until the answer, then closes and clears the form inside the popover, lists "Bookings" as "Link, calendar.google.com", and its events show on the Calendar
- **AND** "Add a link" opened again shows empty Name and Calendar link fields

#### Scenario: An add keeps the popover open until it answers
- **WHEN** a member presses "Add link", and while it reads "Adding…" presses Escape, then presses the grid
- **THEN** the popover stays open, "Close" is disabled, and no second post is sent
- **AND** when the API then answers 400 `blocked_address`, the refusal's words show in the open form, with what was typed

#### Scenario: A refused link shows its words and stores nothing
- **WHEN** the API answers an added link with 400 `blocked_address`
- **THEN** the form stays open with what was typed and shows "Townwise doesn’t read calendars from that address. Use the link from your calendar’s settings.", the list and the button's count are unchanged, and nothing is read again

#### Scenario: Refresh now
- **WHEN** a member presses "Refresh now" on a link and the API answers 200 with status `ok`
- **THEN** the popover says "Refreshed {name}." and the list and the shown range's stored events are read again
- **AND** when it answers 200 with status `timeout`, the row shows "Couldn’t refresh: the link took too long to answer." above its "Updated" time, and when it answers 429 the popover says "This calendar was refreshed a few minutes ago. Try again in {n} minutes."

#### Scenario: Remove
- **WHEN** a member presses "Remove" on a calendar and confirms "Remove calendar"
- **THEN** the page deletes it, says "Removed {name}." in the popover, which stayed open under the dialog, and its events leave the Calendar after the list and the shown range's stored events are read again
- **AND** until the list read again answers, every row's "Refresh now" and "Remove" are disabled in place, so the removed calendar's row, still listed, can't be removed a second time

#### Scenario: Focus follows the popover on web
- **WHEN** on web a member presses "Add a link" and then the form's Cancel
- **THEN** focus moves to the form's "Name" field, then back to "Add a link"
- **AND** when a link is added, when "Remove calendar" removes a calendar, and when Refresh now or Remove answers 404, focus moves to the messages line that says so, since each takes away the control that had it; a refused link leaves focus on "Add link"
- **AND** no answer arrives while the popover is closed, since it stays open while an add, an import or a Refresh now runs

#### Scenario: View-as is read-only
- **WHEN** staff viewing as a member open the popover
- **THEN** the list shows, "Import a calendar file", "Add a link", "Refresh now" and "Remove" do nothing and are described by the read-only line, and no write is sent

#### Scenario: Native
- **WHEN** a member opens the popover on native
- **THEN** there is no "Import a calendar file"; the line "To add events from your own calendar file, open Townwise on the web." shows in its place, Add a link, Refresh now and Remove work, and the back button on Android closes it

#### Scenario: Note from an event
- **WHEN** a member chooses "Make a note" on a stored event
- **THEN** the note form opens in its popover as a private event, more guests, with the event's dates and hours and an empty detail, and no write carries the event's title

#### Scenario: One stored-events read per range
- **WHEN** a member opens November 2026 (with today Nov 11, 2026)
- **THEN** the page reads the stored events once, `from=2026-10-26&to=2026-12-06`, in parallel with the grid's other reads
- **AND** selecting a day or switching to a week whose 7 days lie inside the grid reads no stored events again, and Next month reads `from=2026-11-30&to=2027-01-10`

#### Scenario: A failed calendars read leaves the calendar showing
- **WHEN** the calendar list cannot be read
- **THEN** the grid shows its town events, notes and forecast without stored events, the button reads "Your calendars", and a notice says "Couldn’t load your calendars. Try again.", whose Try again reads the list and the stored events again
- **AND** when the list answers with at least one calendar but the stored events cannot be read, the notice says "Couldn’t load the events from your calendars. Try again." instead; when the list answers with none, a failed stored-events read shows no notice; one of the two notices shows at a time, the list's first
