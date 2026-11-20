## ADDED Requirements

### Requirement: Researched events stay out of the forecast's town calendar
`townEvents()` SHALL NOT read researched events. The lab input, both lab golden files, the lab input fingerprint, term state, forecast reasons and event effects SHALL be unchanged with researched rows present. Researched events SHALL reach the forecast only as notes.

#### Scenario: Golden unchanged
- **WHEN** Hanover has stored researched events in its window and the lab input test runs
- **THEN** `api-input.json` and `hanover-calendar.json` are byte-identical

### Requirement: The calendar read adds researched events additively
`GET /api/org/locations/:locationId/calendar` SHALL add a top-level `found`: the location's researched views in the range (its town's unsuppressed rows when the town is one of the twelve, and its own rows stamped with its current place and town), after its revisions, hidden ones left out, each `{ id ('t-' or 'l-' and hex), head ('base' or the head revision's id), title, start, end, weekdays, startTime, kind, category, status, origin, confidence, where, who, competitor, sources, lastSeenAt, edited }`; `[]` while the organization's research switch or `TOWNWISE_RESEARCH` is off; or `null` when the read fails. `events`, `researched` and `covers` SHALL keep their meaning. The route SHALL still log nothing. The client SHALL parse `found` item by item, dropping an item that fails, and SHALL keep a source only when its URL's protocol is `https:`.

#### Scenario: Older client
- **WHEN** a client built before this change reads the calendar
- **THEN** its parse succeeds and it shows what it showed before

#### Scenario: Read fails
- **WHEN** the researched read throws
- **THEN** the route answers 200 with `found: null` and its other keys

#### Scenario: A non-https source
- **WHEN** a view's source URL is `javascript:alert(1)`
- **THEN** the client drops that source and shows the event with its other sources

### Requirement: Findings show on the Calendar with no accept step
The Calendar SHALL show researched events under a "Found by research" filter, on by default, and the day panel SHALL group them under the same label, after notes, rules, holidays, curated and imported events, with where and who, an "Unconfirmed" chip for low confidence, a "Cancelled" chip, source chips, Edit, Hide, Ask TownwiseAI, and "Edited by your team" with Reset on an edited event. Home's This Week entries SHALL read researched entries after the location's other entries and SHALL leave out Unconfirmed and competitor rows. A banner SHALL show only for a run a person started (Research now, or the early run after creating a location or picking its place), while it runs and after it finishes, linking to the Town tab, until dismissed or the Town tab is opened. [CONFIRM: the Calendar's "Found by research" filter, on by default, and researched rows last on Home with Unconfirmed and competitor rows left off it] [CONFIRM: low-confidence findings shown as Unconfirmed on the Calendar and never sent to weekly suggestions]

#### Scenario: A low-confidence finding
- **WHEN** a day holds a researched event of low confidence
- **THEN** its row shows "Unconfirmed" and its sources on the Calendar, and Home leaves it out

#### Scenario: Filter off
- **WHEN** a person turns "Found by research" off
- **THEN** no researched event shows on the grid or the day panel

#### Scenario: A busy day on Home
- **WHEN** a day holds two notes and three researched events
- **THEN** This Week shows the two notes first and the researched events after them

#### Scenario: The weekly run
- **WHEN** a weekly run nobody pressed finishes
- **THEN** no banner shows on the Calendar

### Requirement: People edit, hide and restore researched events for their location only
`PATCH /api/org/locations/:locationId/research/events/:eventId { op: edit | hide | restore, fields, basedOn }` (body limit `8kb`) SHALL append a revision for that location, `fields.title` and `fields.where` checked by `safeText` and the dates by the date rules, answering 409 `changed_since` with the event's current view when `basedOn` is not the head, and 409 `too_many_edits` past 1,000 revisions a location. Any member and staff open as admin SHALL be allowed; view-as SHALL be refused. A revision SHALL never change another location's or organization's calendar. Curated rows and holidays SHALL answer 404. A merge SHALL change only research's own values, and a hidden event SHALL stay hidden when found again. Revisions SHALL never be deleted one by one; the effective state SHALL be the head of the chain from `'base'`, ignoring any revision whose parent is not in the chain. Audit SHALL record `research.event_edited`, `research.event_hidden` or `research.event_restored` with `{ locationId, eventId }` only. [CONFIRM: an edit or hide of a researched event applies to that location only, with no choice to apply it to every location of the organization in the town] [CONFIRM: any member may edit, hide or restore a researched event, and staff open as admin may too] [CONFIRM: curated town rows and holidays cannot be edited or hidden] [CONFIRM: at most 1,000 edits a location]

#### Scenario: One organization hides a town event
- **WHEN** organization A's location hides a Hanover researched event
- **THEN** organization B's Hanover location still shows it

#### Scenario: Two edits race
- **WHEN** two members edit the same event from the same head
- **THEN** one succeeds and the other answers 409 `changed_since` with the event's new head

#### Scenario: Found again after a hide
- **WHEN** research finds a hidden event again
- **THEN** it stays hidden for that location, and appears under "Hidden by your team" with Restore, its item carrying the head to restore from

#### Scenario: Another organization's event id
- **WHEN** a member sends organization B's `l-` id
- **THEN** the API answers 404

### Requirement: TownwiseAI reads researched events
`get_town_calendar` and the day tool SHALL add `found` (effective, not hidden, with ids and heads) and SHALL record the days of the researched events they returned on the turn; `propose_note`'s automatic save SHALL refuse a note whose days overlap one of those days, and SHALL still save a plainly stated note on other days. The weekly suggestions call SHALL add researched events that are effective, not hidden, not cancelled and of medium or high confidence, at most 60, each mapped into its calendar entries with kind `event`, `season` or `closure`, scope `researched` and no history, and SHALL accept suggestions citing their ids; the suggestions read SHALL resolve those ids through the researched read. A kept suggestion citing any researched id, or covering a day a sent researched entry falls on (whatever it cites), SHALL never be applied on its own, whatever its rating, and SHALL be stored open for a person. [CONFIRM: weekly suggestions read at most 60 researched events of medium or high confidence, and a suggestion resting on a researched event always waits for a person]

#### Scenario: A note proposed on a researched day
- **WHEN** a chat turn read a researched event on Dec 5 and the model proposes a plainly stated note for Dec 5
- **THEN** the note is not saved on its own, and the person sees the proposal

#### Scenario: A stated note on another day
- **WHEN** a chat turn read the calendar, which held researched events in December, and the person said "we're closed Dec 24", a day with no researched event
- **THEN** the closure note is saved on its own as before

#### Scenario: A suggestion citing a finding
- **WHEN** a weekly suggestion rated `high` cites an `l-` id the call sent, while TownwiseAI works on its own
- **THEN** the suggestion is kept open, its card names that event, and nothing is written to `tw_agent_changes`

#### Scenario: A suggestion on a finding's day citing nothing
- **WHEN** the call sent a researched event on Jul 11 and a weekly suggestion rated `high` for Jul 11 cites no id, or only a holiday, while TownwiseAI works on its own
- **THEN** the suggestion is kept open and nothing is written to `tw_agent_changes`

### Requirement: Owners see research on the Town tab, in TownwiseAI and on the dashboard
`GET /api/org/locations/:locationId/research` SHALL answer the switch, the town's last run (status, finish time, threads' states and counts, never what started it), the location's last run with its trigger and start, the next run, gaps (`no_place`, `not_researched_town`, `off`, `budget`, `places_off`), who and where, and the hidden events with their heads. The Town tab SHALL show the status in plain words ("Researching Hanover: 3 of 6 topics done"), the gaps, "Coming up this week" (from the Calendar's `found`), "Who and where", "Hidden by your team" with Restore, the Competition card, the research switch for org admins, and Research now for org admins outside view-as and open as admin, polling while a run is live. TownwiseAI's activity SHALL add `research_done` with the subject, status and counts, and its budget line SHALL say what research used this month. `GET /api/org`'s location summaries (`summarizer` in `handlers/locations.ts`) SHALL add `researching: { stage, since } | null`, set while the location's run is running or merging, and the dashboard SHALL say "Researching". [CONFIRM: the Town tab's, Calendar's, banner's, switch's, activity's and dashboard's words for research]

#### Scenario: Run finishes while the tab is open
- **WHEN** a run finishes while the Town tab polls
- **THEN** the tab shows the new counts without a reload, and the activity lists `research_done`

#### Scenario: Partial run
- **WHEN** a run ends `partial` because a thread failed
- **THEN** the Town tab and the activity say how many topics did not finish

#### Scenario: Waiting to retry
- **WHEN** a location's thread waits 10 minutes to retry
- **THEN** the dashboard still says "Researching", the Town tab says "Waiting to try again", and Research now answers 409 `research_running`
