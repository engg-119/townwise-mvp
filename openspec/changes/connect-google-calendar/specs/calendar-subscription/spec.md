## MODIFIED Requirements

### Requirement: Refresh now
A member SHALL be able to refresh a link calendar or a Google calendar on demand, at most once per calendar every 5 minutes. A calendar file SHALL answer 400 `not_a_link`. A Google calendar SHALL be refreshed through the person's Google connection as the refresh loop refreshes it (the google-calendar capability), and SHALL answer 503 `google_calendar_unavailable`, fetching nothing, while Google calendars are off.

#### Scenario: Second refresh too soon
- **WHEN** a member refreshes the same calendar twice within 5 minutes
- **THEN** the second request answers 429 and no fetch is made

#### Scenario: Refresh a Google calendar
- **WHEN** a member refreshes a Google calendar and Google answers its events
- **THEN** the system replaces the calendar's events, answers 200 with status `ok`, and audits `owner_calendar.refreshed` with kind `google`

#### Scenario: A file
- **WHEN** a member asks to refresh an imported calendar file
- **THEN** the system answers 400 `not_a_link` and fetches nothing
