## ADDED Requirements

### Requirement: TownwiseAI corrects a researched event when a person asks
A chat tool `correct_calendar_event` SHALL be appended after `propose_order_setup`, taking `{ eventId, change: edit | hide | restore, title?, start?, end?, weekdays?, startTime?, where?, why }` (why at most 200 characters), at most 5 a turn. It SHALL apply only to researched events of the location or its town, answering `{ applied: false, code: 'not_researched' }` for a curated row or holiday. It SHALL refuse with `web_turn` or `file_turn` in a turn that read the web or a file, and SHALL refuse for staff and under view-as. It SHALL NOT be gated on TownwiseAI working on its own, and reading the calendar (`readNotTyped`) SHALL NOT block it. The frozen tool list, the client's tool table and `docs/portal/tuning-chat.md` section 4 SHALL list it. [CONFIRM: TownwiseAI corrects a researched event when a person asks, whether or not it works on its own, refused in a turn that read the web or a file, at most 5 a turn]

#### Scenario: Hide at a person's request
- **WHEN** a member asks "that trivia night on Dec 3 is wrong, remove it" and the model calls the tool with `change: 'hide'`
- **THEN** the event is hidden for that location, the activity lists the change with Undo, and the stream carries `{ type: 'correction', data: { eventId, changeId } }`

#### Scenario: After a web search
- **WHEN** the same turn searched the web before calling the tool
- **THEN** it answers `{ applied: false, code: 'web_turn' }` and nothing changes

#### Scenario: A curated row
- **WHEN** the model calls it with a curated Hanover row's id
- **THEN** it answers `not_researched` and nothing changes

### Requirement: Corrections go through the agent changes ledger with Undo
A correction SHALL be written by `agent/apply.ts` as action `event.correct`, keyed by the conversation and the tool call, its target the planned revision id, inserting the revision based on the current head; a duplicate key SHALL count as done and a clash on `basedOn` SHALL answer `conflict`. It SHALL NOT mark a refit. Undo SHALL delete the revision while no revision is based on it, and otherwise mark the change `adopted` and answer 409 `changed_since`. The isolation test's lists of ledger writers and undoers SHALL be unchanged. An older client SHALL drop the new action from the activity without breaking.

#### Scenario: Undo
- **WHEN** a person presses Undo on a correction nobody changed since
- **THEN** the revision is deleted and the event shows research's values again

#### Scenario: Edited since
- **WHEN** a member edited the event after TownwiseAI's correction and someone presses Undo
- **THEN** the API answers 409 `changed_since`, the change is `adopted`, and the member's edit stays

#### Scenario: Asked again after Undo
- **WHEN** a person undoes a correction and asks again in a later turn
- **THEN** the correction is applied again
