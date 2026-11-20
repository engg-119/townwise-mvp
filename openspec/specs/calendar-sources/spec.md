# calendar-sources Specification

## Purpose
TBD - created by archiving change calendar-shows-everything. Update Purpose after archive.
## Requirements
### Requirement: An imported event links to its calendar
On the Calendar's day panel and Home's day detail, each imported event SHALL show a source chip naming its calendar by the calendar's `label` ("Google calendar" under view-as and open as admin). The chip SHALL link inside the app to `/locations/[id]/data/c_<calendarId>`, navigating with the app's router on web and native rather than opening a URL, and its name SHALL come from the event's own calendar label. Home SHALL read the location's events over its forecast range (this month and This week's days past it, under the route's 92 days). A failed read SHALL leave Home showing without imported events.

#### Scenario: Veterans Day from a linked calendar
- **WHEN** the day panel shows "From your calendar: Veterans Day" from the linked calendar "US holidays"
- **THEN** the line carries a chip "US holidays" that opens that calendar's page in Your data

#### Scenario: On native
- **WHEN** a member taps the "US holidays" chip in the native app
- **THEN** the calendar's page opens inside the app

#### Scenario: Home's events read
- **WHEN** Home loads on Nov 17, 2026
- **THEN** it asks for the events from Nov 1 to Nov 30, 2026, a range under 92 days

#### Scenario: Home's day detail
- **WHEN** a member opens a day on Home that has an imported event
- **THEN** the day detail lists it with its calendar's chip

### Requirement: A note TownwiseAI made links to its file
Every note read SHALL answer `source.ref` for a note TownwiseAI made: `f_<fileId>` for a stored file, `u_<uploadId>` for a file that wrote days of its own, or null once the file is gone or while stored files are off. On the Calendar's day panel and Home's day detail, such a note SHALL show a chip "Your file" linking to `/locations/[id]/data/<ref>`, only while `ref` is not null.

#### Scenario: A note made from a file
- **WHEN** the day panel lists a note TownwiseAI made from a stored file
- **THEN** the note carries a chip "Your file" that opens the file's page (P27)

#### Scenario: A file that wrote its own days
- **WHEN** the note was made from a sales file whose item is its upload
- **THEN** the chip links to `u_<uploadId>`

#### Scenario: The file was deleted
- **WHEN** the file has since been deleted
- **THEN** the note's `source.ref` is null and no chip shows

### Requirement: No link holds a calendar's address
No chip, page, tooltip or link SHALL hold a link calendar's address or a Google calendar's id. A link calendar's host SHALL be shown as text only, never as a link.

#### Scenario: A Google Calendar secret iCal link
- **WHEN** a calendar was added from Google Calendar's secret iCal address
- **THEN** its chip and its page show its name and `calendar.google.com` as text, and nothing on either holds the address

### Requirement: Compact surfaces carry no source links
Month cells, the tooltip, week cards and Home's This week SHALL carry no source links. Pressing them SHALL open the day, whose panel holds the links.

#### Scenario: A week card for an imported event
- **WHEN** a member presses a week card for an imported event
- **THEN** the day is selected and its panel shows the event with its calendar's chip

