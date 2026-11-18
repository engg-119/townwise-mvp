## ADDED Requirements

### Requirement: Your data lists the location's calendars
Your data (P26) SHALL show a "Calendars" group above its list, read from `GET .../owner-calendars`, with one row per calendar showing its name, kind ("File", "Link, {host}", "Google calendar"), event count and last refresh, each opening `/locations/[id]/data/c_<calendarId>`. The group SHALL be hidden when the location has no calendar and SHALL show while stored files are off. Each row of the Your calendars popover SHALL gain "Open" to the same page.

#### Scenario: Two calendars
- **WHEN** a member opens Your data for a location with a file and a link calendar
- **THEN** the Calendars group lists both, the link as "Link, calendar.google.com"

#### Scenario: No calendars
- **WHEN** the location has no calendar
- **THEN** no Calendars group shows

### Requirement: A calendar's page shows its events by month
P27 with a ref `c_<calendarId>` SHALL render the calendar's page without reading `org.data.get`. It SHALL show the calendar's name, kind, host as text, event count, repeating events not imported, status and last refresh, then an agenda of the events of one month at a time (today's month first, "Earlier" and "Later" within the events route's range). It SHALL read the existing events route over that month and keep the events of this calendar. Each event SHALL show its title, dates and hours and SHALL link to `/locations/[id]/calendar?day=<startDate>`. An unknown or removed calendar SHALL show P27's not-found state. The page SHALL work on web and native.

#### Scenario: Open a linked calendar
- **WHEN** a member opens the page of the linked calendar "US holidays" in November 2026
- **THEN** it shows "US holidays", "Link, calendar.google.com", its counts and refresh time, and November's events, including "Veterans Day, Wed, Nov 11", which links to the Calendar on Nov 11

#### Scenario: A ref of another organization
- **WHEN** a member opens `c_` with another organization's calendar id
- **THEN** the page shows the not-found state

#### Scenario: No data read
- **WHEN** the page loads for any `c_` ref
- **THEN** the client makes no request to `org.data.get`

### Requirement: A calendar file's page shows what TownwiseAI read
On P27, when a stored file's TownwiseAI read answered `kind: 'calendar'`, the AI section SHALL show the read's events with the same agenda, grouped by month in date order, each with its title, dates, kind words and guests. An event that became a note SHALL read "Note made" and link to `/locations/[id]/calendar?day=<startDate>`; any other SHALL read "No note made". The item view's `ai` SHALL gain `events: { title, startDate, endDate, kind, effect, expectedGuests, noteId }[]`, with `noteId` set only while the note the read made from it exists, `title` null under view-as, and an empty list once the original is deleted.

#### Scenario: A calendar file read
- **WHEN** a member opens a stored calendar file whose read found 3 events and made 2 notes
- **THEN** the page lists the 3 events by month, 2 marked "Note made" with links to their days and 1 "No note made"

#### Scenario: Under view-as
- **WHEN** staff viewing as a member open the same file's page
- **THEN** the events show their dates and kinds with no titles

#### Scenario: The original was deleted
- **WHEN** the file's original has been deleted
- **THEN** `ai.events` is empty and the agenda does not show
