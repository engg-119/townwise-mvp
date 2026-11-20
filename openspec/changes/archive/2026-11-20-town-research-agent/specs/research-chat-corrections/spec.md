## ADDED Requirements

### Requirement: TownwiseAI corrects a researched event when a person asks
A chat tool `correct_calendar_event` SHALL be appended after `propose_order_setup`, taking `{ eventId, change: edit | hide | restore, title?, start?, end?, weekdays?, startTime?, where?, why }` (why at most 200 characters), at most 5 a turn. It SHALL apply only to researched events of the location or its town, answering `{ applied: false, code: 'not_researched' }` for a curated row or holiday, and `{ applied: false, code: 'bad_title' }` when `title` or `where` fails `safeText`. It SHALL refuse for staff and under view-as. In a turn that read the web or a file it SHALL NOT apply the change and SHALL answer `{ applied: false, code: 'needs_tap', eventId, proposed }`, which the client shows as a card whose Apply sends the person's own edit through the revision route. It SHALL NOT be gated on TownwiseAI working on its own, and reading the calendar (`readNotTyped`) SHALL NOT block it. The frozen tool list, the client's tool table and `docs/portal/tuning-chat.md` section 4 SHALL list it.

#### Scenario: Hide at a person's request
- **WHEN** a member asks "that trivia night on Dec 3 is wrong, remove it" in a clean turn and the model calls the tool with `change: 'hide'`
- **THEN** the event is hidden for that location, the activity lists the change with Undo, and the conversation holds a `tool` part named `correct_calendar_event` from which the client draws the correction card

#### Scenario: After a web search
- **WHEN** the same turn searched the web before calling the tool
- **THEN** it answers `needs_tap` with the proposed change, nothing changes, and the card shows Apply

#### Scenario: The card applied
- **WHEN** the person presses Apply on a `needs_tap` card
- **THEN** the client sends `PATCH .../research/events/:eventId` with the event's current head, and the change is recorded as that person's revision

#### Scenario: A curated row
- **WHEN** the model calls it with a curated Hanover row's id
- **THEN** it answers `not_researched` and nothing changes

### Requirement: Corrections keep older clients working
The stored and live conversation views SHALL keep a correction as the existing `tool` part (name `correct_calendar_event`, result `{ applied, code, eventId, changeId, proposed }`); no new part type and no new stream event SHALL be added. Ask TownwiseAI on the Calendar's day panel SHALL open a new conversation with a draft naming the event's title and date.

#### Scenario: Older client
- **WHEN** a client built before this change loads a conversation holding a correction
- **THEN** its parse succeeds and it shows the call as a tool call

### Requirement: Corrections go through the agent changes ledger with Undo
A correction SHALL be written by `agent/apply.ts` as action `event.correct`, keyed by the conversation and the tool call, its target the planned revision id, its confidence `high` and its dates null, inserting the revision based on the current head; a duplicate key SHALL count as done, and a clash on `basedOn` SHALL be answered by `write()` as `conflict` and reported as `conflict`. It SHALL NOT mark a refit, on apply or on Undo. A stale `applying` correction SHALL be finished when its revision exists and removed otherwise. Undo SHALL append a `revert` revision based on the correction's revision, succeeding only while that revision is the head; otherwise it SHALL mark the change `adopted` and answer 409 `changed_since`. Nothing SHALL be deleted. The isolation test's lists of ledger writers and undoers SHALL be unchanged. An older client SHALL drop the new action from the activity without breaking.

#### Scenario: Undo
- **WHEN** a person presses Undo on a correction nobody changed since
- **THEN** a revert revision is appended and the event shows its values from before the correction

#### Scenario: Edited since
- **WHEN** a member edited the event after TownwiseAI's correction and someone presses Undo
- **THEN** the API answers 409 `changed_since`, the change is `adopted`, and the member's edit stays

#### Scenario: Undo races an edit
- **WHEN** a member's edit and an Undo are both based on the correction's revision at the same moment
- **THEN** exactly one is stored, and the other answers 409 `changed_since`

#### Scenario: A turn that died after writing
- **WHEN** a turn inserted the correction's revision and stopped before marking the change applied
- **THEN** the location's next stale pass marks it applied, and it keeps its Undo

#### Scenario: Asked again after Undo
- **WHEN** a person undoes a correction and asks again in a later turn
- **THEN** the correction is applied again
