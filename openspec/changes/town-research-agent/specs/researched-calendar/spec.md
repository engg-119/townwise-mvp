## ADDED Requirements

### Requirement: Researched events stay out of the forecast's town calendar
`townEvents()` SHALL NOT read researched events. The lab input, both lab golden files, the lab input fingerprint, term state, forecast reasons and event effects SHALL be unchanged with researched rows present. Researched events SHALL reach the forecast only as notes.

#### Scenario: Golden unchanged
- **WHEN** Hanover has stored researched events in its window and the lab input test runs
- **THEN** `api-input.json` and `hanover-calendar.json` are byte-identical

### Requirement: The calendar read adds researched events additively
`GET /api/org/locations/:locationId/calendar` SHALL add a top-level `found`: the location's researched views in the range (its town's rows when the town is one of the twelve, and its own rows), after its revisions, hidden ones left out, each `{ id ('t-' or 'l-' and hex), title, start, end, weekdays, startTime, kind, category, status, effect, origin, confidence, where, who, competitor, sources, lastSeenAt, edited }`; or `null` when the read fails. `events`, `researched` and `covers` SHALL keep their meaning. The route SHALL still log nothing. The client SHALL parse `found` item by item, dropping an item that fails.

#### Scenario: Older client
- **WHEN** a client built before this change reads the calendar
- **THEN** its parse succeeds and it shows what it showed before

#### Scenario: Read fails
- **WHEN** the researched read throws
- **THEN** the route answers 200 with `found: null` and its other keys

### Requirement: Findings show on the Calendar with no accept step
The Calendar SHALL show researched events under a "Found by research" filter, on by default. A day's panel SHALL group them as "Found by TownwiseAI research" with where and who, an "Unconfirmed" chip for low confidence, a "Cancelled" chip, source chips, Edit, Hide, Ask TownwiseAI, and "Edited by your team" with Reset on an edited event. Home's upcoming list SHALL read the same entries. A banner SHALL say while research runs and when it finished, linking to the Town tab. [CONFIRM: the Calendar's "Found by research" filter, on by default] [CONFIRM: low-confidence findings shown as Unconfirmed on the Calendar and never sent to weekly suggestions]

#### Scenario: A low-confidence finding
- **WHEN** a day holds a researched event of low confidence
- **THEN** its row shows "Unconfirmed" and its sources

#### Scenario: Filter off
- **WHEN** a person turns "Found by research" off
- **THEN** no researched event shows on the grid or the day panel

### Requirement: People edit, hide and restore researched events for their location only
`PATCH /api/org/locations/:locationId/research/events/:eventId { op: edit | hide | restore, fields, basedOn }` SHALL append a revision for that location, checked by the title and date rules, answering 409 `changed_since` when `basedOn` is not the head and 409 `too_many_edits` past 1,000 revisions a location. Any member and staff open as admin SHALL be allowed; view-as SHALL be refused. A revision SHALL never change another location's or organization's calendar. Curated rows and holidays SHALL answer 404. A merge SHALL change only research's own values, and a hidden event SHALL stay hidden when found again. Audit SHALL record `research.event_edited`, `research.event_hidden` or `research.event_restored` with `{ locationId, eventId }` only. [CONFIRM: an edit or hide of a researched event applies to that location only] [CONFIRM: any member may edit, hide or restore a researched event, and staff open as admin may too] [CONFIRM: curated town rows and holidays cannot be edited or hidden] [CONFIRM: at most 1,000 edits a location]

#### Scenario: One organization hides a town event
- **WHEN** organization A's location hides a Hanover researched event
- **THEN** organization B's Hanover location still shows it

#### Scenario: Two edits race
- **WHEN** two members edit the same event from the same head
- **THEN** one succeeds and the other answers 409 `changed_since`

#### Scenario: Found again after a hide
- **WHEN** research finds a hidden event again
- **THEN** it stays hidden for that location, and appears under "Hidden by your team" with Restore

#### Scenario: Another organization's event id
- **WHEN** a member sends organization B's `l-` id
- **THEN** the API answers 404

### Requirement: TownwiseAI reads researched events
`get_town_calendar` and the day tool SHALL add `found` (effective, not hidden) and SHALL set `readNotTyped` when it is non-empty. The weekly suggestions call SHALL add researched events that are effective, not hidden, not cancelled and of medium or high confidence, at most 60, and SHALL accept suggestions citing their ids; the suggestions read SHALL resolve those ids through the researched read. [CONFIRM: weekly suggestions read at most 60 researched events of medium or high confidence]

#### Scenario: A note proposed after reading findings
- **WHEN** a chat turn read researched events and the model proposes a note stated plainly
- **THEN** the note is not saved on its own, and the person sees the proposal

#### Scenario: A suggestion citing a finding
- **WHEN** a weekly suggestion cites an `l-` id the call sent
- **THEN** the suggestion is kept and its card names that event

### Requirement: Owners see research on the Town tab, in TownwiseAI and on the dashboard
`GET /api/org/locations/:locationId/research` SHALL answer the switch, the town's and the location's last runs with their threads' states and counts, the next run, gaps (`no_place`, `not_researched_town`, `off`, `budget`, `places_off`), who and where, and the hidden events. The Town tab SHALL show the status, the gaps, "New this week", "Who and where", "Hidden by your team" with Restore, the Competition card, and Research now for org admins outside view-as and open as admin, polling while a run is live. TownwiseAI's activity SHALL add `research_done` with the subject, status and counts. `GET /api/org`'s locations SHALL add `researching: { stage, since } | null`, a run older than 30 minutes read as not running, and the dashboard SHALL say "Researching". [CONFIRM: the Town tab's, Calendar's, banner's, activity's and dashboard's words for research]

#### Scenario: Run finishes while the tab is open
- **WHEN** a run finishes while the Town tab polls
- **THEN** the tab shows the new counts without a reload, and the activity lists `research_done`

#### Scenario: Partial run
- **WHEN** a run ends `partial` because a thread failed
- **THEN** the Town tab and the activity say how many threads did not finish
