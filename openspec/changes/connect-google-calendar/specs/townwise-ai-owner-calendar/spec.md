## MODIFIED Requirements

### Requirement: The tool's views and logs carry no titles
The tool's input view SHALL show the dates and its result view counts only. Its inputs and results SHALL NOT be logged. The saved conversation SHALL keep, in place of a `get_owner_calendar` result that listed events, a stub with counts only, `{ calendars, eventCount, truncated, skippedRepeating, elided: true, reason }`, whose reason tells the model to call the tool again for the current events, so an event's title or a calendar's name reaches the model only in the turn that read it, and a later turn reads what is stored then. The thinking blocks after the first stubbed result of that turn SHALL NOT be saved, as for `read_data_item` (D28). A result with no calendar (`available: false`) and an error result SHALL be saved as they are. The tool's name, description and input SHALL NOT change.

#### Scenario: Result view
- **WHEN** the conversation shows a `get_owner_calendar` call
- **THEN** the view says how many events were read from how many calendars, with no title

#### Scenario: A later turn after the calendar is removed
- **WHEN** a turn's `get_owner_calendar` call listed two events of a Google calendar, the calendar is then removed, and the person sends another message in that conversation
- **THEN** the stored conversation holds the stub with `eventCount: 2` and no title or calendar name, and the next turn's request carries the stub, not the titles

#### Scenario: The stub's view
- **WHEN** a stored conversation with a stubbed `get_owner_calendar` result is opened
- **THEN** its tool row shows the same counts as when the turn ran
