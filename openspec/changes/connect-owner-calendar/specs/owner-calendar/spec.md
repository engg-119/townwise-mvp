## ADDED Requirements

### Requirement: A location keeps its calendars
The system SHALL store, per location, up to 5 calendars, each either an imported `.ics` file (`file`) or a subscription link (`link`), with a name of at most 60 characters given by the person who adds it.

#### Scenario: Import a calendar file
- **WHEN** a member posts `{ kind: 'file', label, ics }` with a calendar file of at most 1 MB
- **THEN** the system parses it, stores the calendar and its events, and answers with the calendar's name, kind, event count and count of repeating events not imported

#### Scenario: Sixth calendar refused
- **WHEN** a member adds a calendar to a location that already has 5
- **THEN** the system answers 409 `calendar_limit` and stores nothing

#### Scenario: Not a calendar
- **WHEN** the posted file is not a calendar
- **THEN** the system answers 400 `not_calendar` and stores nothing

### Requirement: Only an event's title, dates and hours are stored
For each single event within 400 days of the town's today, the system SHALL store its UID, title (cut to 200 characters), start and end dates and, when it has them, its hours, and SHALL NOT store its description, location, attendees or organizer. It SHALL keep at most 2,000 events per calendar, the first by start, count repeating events without importing them, and leave canceled events out, following the parsing rules of the Calendar page's in-browser parser that it replaces (P28).

#### Scenario: Description is dropped
- **WHEN** an imported event has a DESCRIPTION and a LOCATION
- **THEN** the stored event has neither

#### Scenario: Repeating events counted
- **WHEN** a file holds 3 single events and 2 events with an RRULE
- **THEN** 3 events are stored and the calendar reports 2 repeating events not imported

### Requirement: Calendars are managed by members and isolated by organization
Listing, adding, refreshing and removing calendars SHALL be allowed for every member of the organization, staff opened as admin included, and SHALL be refused under view-as for writes. A calendar id from another organization or another location SHALL answer 404, as an unknown id does.

#### Scenario: Cross-tenant id
- **WHEN** a member of organization A asks to remove a calendar that belongs to organization B
- **THEN** the system answers 404 and nothing changes

#### Scenario: View-as write
- **WHEN** staff viewing as a member try to add a calendar
- **THEN** the system refuses the write and stores nothing

### Requirement: The calendar list never returns a subscription address
The calendar list and every other response SHALL show a link calendar by its name and host only, never its address.

#### Scenario: List after adding a link
- **WHEN** a member lists the calendars after adding a Google Calendar link
- **THEN** the link appears with its name, `calendar.google.com`, its status and its last refresh time, and no address

### Requirement: Removing a calendar deletes its events
Removing a calendar SHALL delete the calendar and all of its events. Deleting a location or organization SHALL delete all of its calendars and events.

#### Scenario: Remove a calendar
- **WHEN** a member removes a calendar
- **THEN** none of its events are returned by any later read

### Requirement: Events read by date range
The system SHALL return a location's stored events overlapping a range of at most 92 days, with `to` at most 400 days after the town's today, each with its calendar's name, title, dates and hours.

#### Scenario: Month read
- **WHEN** the Calendar page reads November's events
- **THEN** the system returns every stored event overlapping November from the location's calendars, and none from other locations

#### Scenario: Range too long
- **WHEN** a read asks for 120 days
- **THEN** the system answers 400 `bad_range`

### Requirement: The Calendar page shows and manages stored calendars
The Calendar page (P28) SHALL show the stored events as "Your calendar" on web and native, read once per grid over the grid's range (`gridRange`), and SHALL hold one control in its header row's trailing slot on web and native: a "Your calendars" disclosure button reading "Your calendars (N)" with N the location's calendar count, or "Your calendars" with none, with `aria-expanded` and `aria-controls` on web and an expanded state on native, closed on every load. It replaces the header row's "Import a calendar file" button and "How importing works" link. The button SHALL open and close a full-width panel under the header row that lists each calendar's name, kind ("File" or "Link"), host for a link, event count, repeating events not imported, and for a link its status in words and its last refresh time, with "Refresh now" (a link) and "Remove" per calendar, and under the list "Import a calendar file" (web), "Add a link" (an inline form with a name of at most 60 characters and the address) and "How importing works". A file import SHALL be named after the file. Every failure code SHALL show plain words and store nothing. Under view-as the panel SHALL be read-only. "Make a note" from a stored event SHALL open the note form as today, with the note's detail empty.

#### Scenario: The button with calendars
- **WHEN** the Calendar opens for a location with 2 calendars
- **THEN** the header row's last control reads "Your calendars (2)" with `aria-expanded="false"`, its `aria-controls` names the panel, and the panel is hidden, so the grid sits where it would with no panel

#### Scenario: The button with none
- **WHEN** the Calendar opens for a location with no calendar
- **THEN** the button reads "Your calendars" and no "Your calendar" filter chip shows

#### Scenario: Opening the panel
- **WHEN** a member presses "Your calendars (2)"
- **THEN** it has `aria-expanded="true"` and the panel shows under the header row, listing a file as "File, 12 events" and a link as "Link, calendar.google.com, 3 events" with its "Updated" time, then "Import a calendar file", "Add a link" and "How importing works"

#### Scenario: Importing a file
- **WHEN** on web a member imports "Kitchen bookings.ics" from the panel
- **THEN** the page posts `{ kind: 'file', label: 'Kitchen bookings', ics }` with the file's text, says "Added Kitchen bookings: {n} events.", reads the calendar list and the grid's stored events again (not the forecast), and the file's events show on the Calendar with "Your calendar" on
- **AND** after a reload they still show

#### Scenario: Adding a link
- **WHEN** a member adds a link named "Bookings" with a Google Calendar iCal address
- **THEN** the page posts `{ kind: 'link', label: 'Bookings', url }`, shows "Adding…" until the answer, then closes and clears the form, lists "Bookings" as "Link, calendar.google.com", and its events show on the Calendar

#### Scenario: A refused link shows its words and stores nothing
- **WHEN** the API answers an added link with 400 `blocked_address`
- **THEN** the form stays open with what was typed and shows "Townwise doesn’t read calendars from that address. Use the link from your calendar’s settings.", the list and the button's count are unchanged, and nothing is read again

#### Scenario: Refresh now
- **WHEN** a member presses "Refresh now" on a link and the API answers 200 with status `ok`
- **THEN** the panel says "Refreshed {name}." and the list and the grid's stored events are read again
- **AND** when it answers 200 with status `timeout`, the row shows "Couldn’t refresh: the link took too long to answer." above its "Updated" time, and when it answers 429 the panel says "This calendar was refreshed a few minutes ago. Try again in {n} minutes."

#### Scenario: Remove
- **WHEN** a member presses "Remove" on a calendar and confirms "Remove calendar"
- **THEN** the page deletes it, says "Removed {name}.", and its events leave the Calendar after the list and the grid's stored events are read again
- **AND** until the list read again answers, every row's "Refresh now" and "Remove" are disabled in place, so the removed calendar's row, still listed, can't be removed a second time

#### Scenario: Focus follows the panel on web
- **WHEN** on web a member presses "Add a link" and then the form's Cancel
- **THEN** focus moves to the form's "Name" field, then back to "Add a link"
- **AND** when a link is added, when "Remove calendar" removes a calendar, and when Refresh now or Remove answers 404, focus moves to the messages line that says so, since each takes away the control that had it; a refused link leaves focus on "Add link"
- **AND** when a link add or a Refresh now answers after focus has left the panel, focus stays where it went

#### Scenario: View-as is read-only
- **WHEN** staff viewing as a member open the panel
- **THEN** the list shows, "Import a calendar file", "Add a link", "Refresh now" and "Remove" do nothing and are described by the read-only line, and no write is sent

#### Scenario: Native
- **WHEN** a member opens the panel on native
- **THEN** there is no "Import a calendar file"; the line "To add events from your own calendar file, open Townwise on the web." shows in its place, and Add a link, Refresh now and Remove work

#### Scenario: Note from an event
- **WHEN** a member chooses "Make a note" on a stored event
- **THEN** the note form opens as a private event, more guests, with the event's dates and hours and an empty detail, and no write carries the event's title

#### Scenario: One stored-events read per grid
- **WHEN** a member opens November 2026 (with today Nov 11, 2026)
- **THEN** the page reads the stored events once, `from=2026-10-26&to=2026-12-06`, in parallel with the grid's other reads
- **AND** selecting a day or switching to the week view reads no stored events again, and Next month reads `from=2026-11-30&to=2027-01-10`

#### Scenario: A failed calendars read leaves the calendar showing
- **WHEN** the calendar list cannot be read
- **THEN** the grid shows its town events, notes and forecast without stored events, the button reads "Your calendars", and a notice says "Couldn’t load your calendars. Try again.", whose Try again reads the list and the stored events again
- **AND** when the list answers with at least one calendar but the stored events cannot be read, the notice says "Couldn’t load the events from your calendars. Try again." instead; when the list answers with none, a failed stored-events read shows no notice; one of the two notices shows at a time, the list's first

### Requirement: Stored calendars do not change the forecast by themselves
A stored calendar event SHALL NOT change any forecast figure. Only notes and scheduled business rules SHALL change the forecast, as today.

#### Scenario: Event without a note
- **WHEN** a location has a stored event on a future day and no note covers that day
- **THEN** that day's forecast is the same as with no calendar

### Requirement: Calendar actions are audited without content
Adding, removing and manually refreshing a calendar SHALL write an audit event carrying ids, kind, event counts and status only, never the calendar's name, host, address or any title.

#### Scenario: Audit on add
- **WHEN** a member adds a link calendar
- **THEN** the audit event `owner_calendar.added` carries the location id, calendar id, kind and event count, and no name, host, address or title
