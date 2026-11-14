## ADDED Requirements

### Requirement: TownwiseAI reads the owner's calendar
TownwiseAI SHALL have a tool `get_owner_calendar`, appended at the end of the frozen tool list, that takes `{ from, to }` (at most 92 days, `to` at most 400 days after the town's today) and returns the location's stored events in that range, at most the first 100 by start, with each event's calendar name, title, dates and hours, plus whether more were left out, the number of calendars and of repeating events not imported.

#### Scenario: Events in range
- **WHEN** TownwiseAI calls `get_owner_calendar` for next week and the location has two stored events in it
- **THEN** the result lists both events with their titles, dates, hours and calendar names

#### Scenario: More than 100 events
- **WHEN** the location has 1,800 stored events in the range
- **THEN** the result lists the first 100 by start with `truncated` true, and the result view counts 100

#### Scenario: No calendar
- **WHEN** the location has no stored calendar
- **THEN** the result is `{ available: false, reason }` saying no calendar is connected

#### Scenario: Invalid range
- **WHEN** the input asks for more than 92 days
- **THEN** the tool returns an error result and reads nothing

#### Scenario: Tool order
- **WHEN** the tool list is built
- **THEN** every existing tool keeps its name and position and `get_owner_calendar` is last

### Requirement: Calendar events become notes only through the owner
TownwiseAI SHALL turn a calendar event that changes guests into a note only by proposing it with `propose_note`, which the owner saves, edits or dismisses. The prompt SHALL tell it never to copy a person's or group's name from an event title into a note.

#### Scenario: Buyout on the calendar
- **WHEN** the owner asks TownwiseAI to check next month's calendar and a stored event is a buyout
- **THEN** TownwiseAI proposes a private-event note for that date, and no note is saved until the owner saves it

### Requirement: The tool's views and logs carry no titles
The tool's input view SHALL show the dates and its result view counts only. Its inputs and results SHALL NOT be logged.

#### Scenario: Result view
- **WHEN** the conversation shows a `get_owner_calendar` call
- **THEN** the view says how many events were read from how many calendars, with no title
