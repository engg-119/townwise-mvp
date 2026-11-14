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
For each single event within 400 days of the town's today, the system SHALL store its UID, title (cut to 200 characters), start and end dates and, when it has them, its hours, and SHALL NOT store its description, location, attendees or organizer. It SHALL keep at most 2,000 events per calendar, the first by start, count repeating events without importing them, and leave canceled events out, following the parsing rules the Calendar page uses today (P27).

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
The Calendar page (P27) SHALL show the stored events as "Your calendar" on web and native, and a "Your calendars" panel listing each calendar's name, kind, host for a link, event count, repeating events not imported, last refresh and status, with Add a link, Import a file (web), Refresh now (a link) and Remove. "Make a note" from an event SHALL open the note form as today, with the note's detail empty.

#### Scenario: Events survive a reload
- **WHEN** a member imports a calendar file and reloads the page
- **THEN** the imported events still show on the Calendar

#### Scenario: Note from an event
- **WHEN** a member chooses "Make a note" on a stored event
- **THEN** the note form opens as a private event, more guests, with the event's dates and hours and an empty detail

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
