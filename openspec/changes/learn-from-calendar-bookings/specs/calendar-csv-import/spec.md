## ADDED Requirements

### Requirement: A calendar CSV is recognized by its header
Townwise SHALL treat a calendar file's text as an `.ics` file when it holds a `BEGIN:VCALENDAR` line, and otherwise as a calendar CSV when its first record, read as RFC 4180 CSV after any byte-order mark, holds the headers `event_id`, `title`, `start_at` and `end_at` (trimmed, any case, any order, other columns allowed). Any other text SHALL be refused `not_calendar`. No model SHALL be called to detect or parse it.

#### Scenario: The owner's export
- **WHEN** a member imports a CSV whose header holds those four columns among 25
- **THEN** Townwise reads it as a calendar CSV

#### Scenario: A sales export
- **WHEN** a member imports a CSV with date, guests and net sales columns and no `start_at`
- **THEN** the add answers 400 `not_calendar` and stores nothing

### Requirement: A calendar CSV keeps what an .ics keeps, and nothing else
Each row SHALL be read for `event_id`, `title`, `start_at`, `end_at` and, when present, `status` only. A row with `status` `cancelled` SHALL be left out. An event SHALL keep a uid (the trimmed `event_id`, `event-{n}` when blank, suffixed when repeated), a title cut at 200 characters, its dates and its hours, and `keyed` when its `event_id` is stated once and is at most 1,024 characters. Descriptions, locations, organizer and attendee fields, emails, attachments, colors, calendar ids and Google URLs SHALL never be read, stored, logged or answered. A row whose start cannot be read SHALL be skipped and counted in the add's answer. Each row of a repeating series SHALL be imported as a single event.

#### Scenario: Private columns are dropped
- **WHEN** a row's description holds a phone number and its organizer column an email
- **THEN** neither appears in any stored event, answer, log line or audit event

#### Scenario: A repeating series
- **WHEN** the export lists 4 rows sharing a `recurring_event_id`, each with its own `event_id`
- **THEN** Townwise stores 4 single events and counts no skipped repeating events

#### Scenario: An unreadable row
- **WHEN** one row's `start_at` is not a date
- **THEN** the other rows are stored and the add answers that 1 row was skipped

### Requirement: CSV times follow the town's clock and the .ics day rules
A `start_at` or `end_at` with an offset or `Z` SHALL be the town's wall date and time of that instant. A value with no offset SHALL be the wall time it states, and a bare date SHALL be a date. The event's dates and hours SHALL then follow the `.ics` rules: an end at midnight closes the day before, an event ending by 06:00 the next morning stays on its start day with its hours, and hours are kept only within one day. The `timezone` column SHALL NOT be used.

#### Scenario: An all-day export row
- **WHEN** a row runs from `2024-06-01T00:00:00` to `2024-06-04T00:00:00` with no offset
- **THEN** the event is June 1 to June 3 with no hours

#### Scenario: A late party
- **WHEN** a row runs from `2025-03-07T21:00:00-05:00` to `2025-03-08T01:00:00-05:00` in a town on New York time
- **THEN** the event is March 7 from 21:00 to 01:00

### Requirement: A file calendar keeps three years of past events, upcoming events first
A file calendar, `.ics` or CSV, SHALL keep the events ending on or after the town's today minus 1,096 days and starting by today plus 400 days. It SHALL keep at most 2,000, the upcoming ones first and then the latest earlier ones. Link and Google calendars SHALL keep their 400-day window. The file stays at most 1 MB.

#### Scenario: The owner's four-year export
- **WHEN** a member imports, on 2026-11-18, a 596 KB CSV of 1,067 events from 2023-11-18 to 2027-11-05
- **THEN** all 1,067 events are stored, and the Calendar shows those in March 2024

#### Scenario: A long history over the cap
- **WHEN** a file holds 2,500 events in the window, 600 of them upcoming
- **THEN** all 600 upcoming events are kept with the latest 1,400 earlier ones

### Requirement: TownwiseAI chat reads an imported CSV calendar in full
`get_owner_calendar` SHALL list a CSV calendar's events like any calendar's, for any 92-day range from 2010-01-01 to 400 days ahead, with no change to its name, description or input.

#### Scenario: A question about a past booking
- **WHEN** a member asks TownwiseAI about the bookings of April 2024 after importing the CSV
- **THEN** the tool lists that month's events from the CSV calendar

### Requirement: Your data keeps a calendar export apart from sales and the model
A stored text file, or a ZIP entry, whose header row matches the calendar CSV profile SHALL be kept with the outcome `calendar_export`. It SHALL NOT be read for sales and SHALL ask no mapping question. Read with TownwiseAI SHALL skip it `calendar_export` before reserving budget or calling a model, and SHALL write no notes from it. Its row SHALL point the person to Your calendars.

#### Scenario: The export dropped in Your data
- **WHEN** a member uploads the CSV to Your data and asks Read with TownwiseAI for it
- **THEN** the file is `calendar_export`, no model is called, no note is written, and its row says to import it in Your calendars
