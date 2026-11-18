## MODIFIED Requirements

### Requirement: A location keeps its calendars
The system SHALL store, per location, up to 5 calendars, each an imported `.ics` file (`file`), a subscription link (`link`) or a Google calendar connected by signing in with Google (`google`, the google-calendar capability), with a name of at most 60 characters: given by the person who adds a file or a link, and taken from Google for a Google calendar.

#### Scenario: Import a calendar file
- **WHEN** a member posts `{ kind: 'file', label, ics }` with a calendar file of at most 1 MB
- **THEN** the system parses it, stores the calendar and its events, and answers with the calendar's name, kind, event count and count of repeating events not imported

#### Scenario: Sixth calendar refused
- **WHEN** a member adds a calendar to a location that already has 5
- **THEN** the system answers 409 `calendar_limit` and stores nothing

#### Scenario: Not a calendar
- **WHEN** the posted file is not a calendar
- **THEN** the system answers 400 `not_calendar` and stores nothing

#### Scenario: A Google calendar takes a slot
- **WHEN** a location has 2 files, 2 links and 1 Google calendar and a member adds another Google calendar
- **THEN** the system answers 409 `calendar_limit` before any request to Google and stores nothing

### Requirement: Only an event's title, dates and hours are stored
For each single event within 400 days of the town's today, the system SHALL store its UID, title (cut to 200 characters), start and end dates and, when it has them, its hours, and SHALL NOT store its description, location, attendees or organizer. It SHALL keep at most 2,000 events per calendar, the first by start for a file or a link, and for a Google calendar those ending on or after the town's today first, by start, then the earlier ones (the google-calendar capability), and leave canceled events out. For a file or a link it SHALL count repeating events without importing them, following the parsing rules of the Calendar page's in-browser parser that it replaces (P28). For a Google calendar it SHALL read from Google only each event's id, status, title, start and end, and SHALL store each instance of a repeating event as a single event, so a Google calendar reports no repeating events not imported.

#### Scenario: Description is dropped
- **WHEN** an imported event has a DESCRIPTION and a LOCATION
- **THEN** the stored event has neither

#### Scenario: Repeating events counted
- **WHEN** a file holds 3 single events and 2 events with an RRULE
- **THEN** 3 events are stored and the calendar reports 2 repeating events not imported

#### Scenario: A Google calendar's repeating event
- **WHEN** a Google calendar holds one single event and a weekly event with 52 instances in the window
- **THEN** 53 events are stored and the calendar reports 0 repeating events not imported, and Google was asked for no description, location, attendee or organizer

### Requirement: Calendars are managed by members and isolated by organization
Listing, adding, refreshing and removing calendars SHALL be allowed for every member of the organization, staff opened as admin included, except that adding a Google calendar SHALL need the member's own Google connection and SHALL be refused with 403 `open_as_admin_refused` for staff opened as admin. Writes SHALL be refused under view-as. A calendar id from another organization or another location SHALL answer 404, as an unknown id does.

#### Scenario: Cross-tenant id
- **WHEN** a member of organization A asks to remove a calendar that belongs to organization B
- **THEN** the system answers 404 and nothing changes

#### Scenario: View-as write
- **WHEN** staff viewing as a member try to add a calendar
- **THEN** the system refuses the write and stores nothing

#### Scenario: Open as admin adds a Google calendar
- **WHEN** staff who opened an organization as admin post `{ kind: 'google', googleCalendarId }`
- **THEN** the system answers 403 `open_as_admin_refused`, calls nothing at Google and stores nothing
- **AND** their file imports and link adds still work as before

### Requirement: The calendar list never returns a subscription address
The calendar list, the events read and every add, refresh and remove answer SHALL show a link calendar by its name and host only, never its address, and a Google calendar by its name only, with a null host, never its Google calendar id, a Google token or the Google account it came from; under view-as a Google calendar's name SHALL be "Google calendar" and its events' titles "Google calendar event" (the google-calendar capability). The calendar list SHALL also answer `google: { available, connected, clientId }`: whether Google calendars are configured, whether the caller has a Google connection that is not revoked (false under view-as), and the public OAuth client id when available, else null.

#### Scenario: List after adding a link
- **WHEN** a member lists the calendars after adding a Google Calendar link
- **THEN** the link appears with its name, `calendar.google.com`, its status and its last refresh time, and no address

#### Scenario: List after adding a Google calendar
- **WHEN** a connected member lists the calendars after adding their primary Google calendar
- **THEN** it appears with the name "Google calendar", kind `google`, host null, its event count, status and last refresh time, and no Google calendar id, and the answer's `google` is `{ available: true, connected: true, clientId }`

#### Scenario: Under view-as
- **WHEN** staff viewing as a connected member list the calendars, one of which is a Google calendar named "Bookings"
- **THEN** it is listed as "Google calendar" with kind `google`, host null, its event count, status and last refresh time, and `google.connected` is false

### Requirement: The Calendar page shows and manages stored calendars
The Calendar page (P28) SHALL show the stored events as "Your calendar" on web and native, read with the page's other reads over the shown view's range (`readRangeFor`, calendar-views), and SHALL hold one control in its header row's trailing slot on web and native: a "Your calendars" button reading "Your calendars (N)" with N the location's calendar count, or "Your calendars" with none, with `aria-expanded` and `aria-haspopup="dialog"` on web (and `aria-controls` naming the popover while it is open) and an expanded state on native, closed on every load. It replaces the header row's "Import a calendar file" button and "How importing works" link. The button SHALL open and close a popover anchored to it (calendar-views' "Popovers float over the page, anchored to their button", at most 440px wide), headed "Your calendars" with a "Close" button, that lists each calendar's name, kind ("File", "Link" or "Google calendar"), host for a link, event count, repeating events not imported, and for a link or a Google calendar its status in words and its last refresh time, with "Refresh now" (a link or a Google calendar) and "Remove" per calendar, a calendar of a kind the page does not know offering "Remove" only, and under the list "Import a calendar file" (web), "Add a link" (an inline form with a name of at most 60 characters and the address), "Add a Google calendar" (web, only while the list answers `google.available`; the google-calendar capability's "The Your calendars popover connects and picks Google calendars") and "How importing works". Nothing under the header row SHALL move when it opens or closes. Opening it SHALL move focus to its "Close" button. A press outside the popover SHALL close it, except while its Remove dialog is open. While a link add, a file import, a Refresh now, or a Google choices read, connect, wait or add runs, the popover SHALL stay open: "Close" disabled in place, and Escape, Android's back button and a press outside doing nothing, so every answer shows in the open popover. Closing it SHALL keep its messages, whether the help, the add-a-link form and the Google section are open, what was typed in the form and the Google section's choices and checks, so they show again when it opens; a link added (201) and the form's Cancel SHALL each clear what was typed. A file import SHALL be named after the file. Every failure code SHALL show plain words and store nothing. Under view-as the popover SHALL be read-only. "Make a note" from a stored event SHALL open the note form as calendar-views says, with the note's detail empty.

#### Scenario: The button with calendars
- **WHEN** the Calendar opens for a location with 2 calendars
- **THEN** the header row's last control reads "Your calendars (2)" with `aria-expanded="false"` and `aria-haspopup="dialog"`, no popover is in the document, and the grid sits directly under the header row

#### Scenario: The button with none
- **WHEN** the Calendar opens for a location with no calendar
- **THEN** the button reads "Your calendars" and no "Your calendar" filter chip shows

#### Scenario: Opening the popover
- **WHEN** a member presses "Your calendars (3)" on web with Google calendars available
- **THEN** it has `aria-expanded="true"` and `aria-controls` naming a dialog "Your calendars" anchored to it, with focus on its "Close", which lists a file as "File, 12 events", a link as "Link, calendar.google.com, 3 events" and a Google calendar as "Google calendar, 40 events", each link and Google calendar with its "Updated" time, then "Import a calendar file", "Add a link", "Add a Google calendar" and "How importing works", and the grid and the day panel have not moved

#### Scenario: Google calendars not available
- **WHEN** the list answers `google.available` false
- **THEN** the popover shows no "Add a Google calendar", and a stored Google calendar still lists with "Refresh now" and "Remove"

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

#### Scenario: Refresh now on a Google calendar
- **WHEN** a member presses "Refresh now" on a teammate's Google calendar and the API answers 200 with status `google_revoked`
- **THEN** the row shows "Couldn’t refresh: Google no longer lets Townwise read this calendar. Ask whoever added it to reconnect, or remove it." above its "Updated" time (the person who added it reads google-calendar's Reconnect words instead)

#### Scenario: Remove
- **WHEN** a member presses "Remove" on a calendar and confirms "Remove calendar"
- **THEN** the page deletes it, says "Removed {name}." in the popover, which stayed open under the dialog, and its events leave the Calendar after the list and the shown range's stored events are read again
- **AND** until the list read again answers, every row's "Refresh now" and "Remove" are disabled in place, so the removed calendar's row, still listed, can't be removed a second time

#### Scenario: Focus follows the popover on web
- **WHEN** on web a member presses "Add a link" and then the form's Cancel
- **THEN** focus moves to the form's "Name" field, then back to "Add a link"
- **AND** when a link is added, when "Remove calendar" removes a calendar, when Google calendars are added from the picker, and when Refresh now or Remove answers 404, focus moves to the messages line that says so, since each takes away the control that had it; a refused link leaves focus on "Add link"
- **AND** no answer arrives while the popover is closed, since it stays open while an add, an import, a Refresh now, or a Google choices read or connect runs

#### Scenario: View-as is read-only
- **WHEN** staff viewing as a member open the popover
- **THEN** the list shows, "Import a calendar file", "Add a link", "Add a Google calendar", "Refresh now" and "Remove" do nothing and are described by the read-only line, and no write is sent

#### Scenario: Native
- **WHEN** a member opens the popover on native with Google calendars available
- **THEN** there is no "Import a calendar file" and no "Add a Google calendar"; the line "To import a calendar file or connect a Google calendar, open Townwise on the web." shows in their place, Add a link, Refresh now and Remove work, and the back button on Android closes it
- **AND** with Google calendars not available the line reads "To add events from your own calendar file, open Townwise on the web."

#### Scenario: An unknown kind
- **WHEN** the list answers a calendar with a kind the page does not know
- **THEN** the list still shows, that row reads "Calendar, {n} events" with "Remove" only, and every other row is as above

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
