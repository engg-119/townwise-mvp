## ADDED Requirements

### Requirement: TownwiseAI applies only typed additions
TownwiseAI SHALL apply only these actions: `note.add`, `rule.add` (a closure or hours schedule), `booking.label` (on an unlabeled file-calendar event), `sales_days.add` (only days the location lacks, under D34's checks) and `item.add` (a summary item). It SHALL never change or delete a record that exists, and it SHALL never set a field on a record it did not add in that change. A note or rule it adds SHALL carry `agent: { changeId, at }` and `createdBy: 'townwise_ai'`.

#### Scenario: A file says a booking moved
- **WHEN** a read finds that a private event in an existing note moved to another day
- **THEN** the existing note is not changed, and the move waits as a suggestion

### Requirement: Only what TownwiseAI is sure of is applied
A candidate SHALL be applied only when all of these hold: the model rated it `high` (for a file event, both the event and the read); it passes its type's code checks (the note or rule validators, the 14-day and 31-day closure guards, D34's 95% day verification); it conflicts with no note or rule a person made on those days; and its dedupe key was never used at the location. Every other candidate SHALL be stored as an open suggestion, or dropped as today. The bar SHALL be fixed in code. While the switch is on, a read someone pressed SHALL follow the same bar.

#### Scenario: A medium-confidence event
- **WHEN** a read rates an event `medium`
- **THEN** no note is written, and the event waits as a suggestion that a member can accept or dismiss

#### Scenario: Conflict with a person's note
- **WHEN** a read rates `high` a closure on a day a person's note marks a private party
- **THEN** no note is written, and the closure waits as a suggestion

#### Scenario: A long closure
- **WHEN** a read rates `high` a closure of 20 days
- **THEN** no note is written, and it waits as a suggested closure rule, as D46 does

### Requirement: Undone or deleted changes are never made again
A change whose ledger row is `undone`, or whose target a person deleted, SHALL keep its dedupe key, and TownwiseAI SHALL never apply a change with that key at the location again. A dismissed suggestion SHALL stay dismissed as today.

#### Scenario: Undo, then the same file read again
- **WHEN** a member undoes a note TownwiseAI added, and a later read states the same event
- **THEN** no note is written

### Requirement: A person's note beats a TownwiseAI note on the same day
When a note a person made decides a day, the forecast read and the lab input SHALL set aside each TownwiseAI note covering that day, with outcome `overridden`. A note is TownwiseAI's while it carries `agent` (or D34's `source`) and nobody has edited it since it was applied, read from the note itself (`updatedAt` equal to `agent.at`).

#### Scenario: A person adds a party over TownwiseAI's closure
- **WHEN** TownwiseAI added a closure note for Tuesday and a member then adds a private-event note for Tuesday
- **THEN** Tuesday's forecast follows the member's note and lists TownwiseAI's note as `overridden`

### Requirement: Each change can be undone in one press
`POST /api/org/locations/:locationId/agent/changes/:changeId/undo` SHALL be allowed to a member with the role the action needs (any member for a note or rule, an org admin for a label or sales days), and never under view-as. It SHALL set the row `undoing` by compare-and-set, then remove the target only while it is unchanged since it was applied, then set the row `undone` and record `agent.change_undone` with ids and counts only. A target changed since SHALL leave the row `adopted` and answer 409 `changed_since`. A target deleted since SHALL leave the row `undone` and answer 200. A retry SHALL finish the steps. An id from another organization or location SHALL answer 404.

#### Scenario: Undo an applied note
- **WHEN** a member presses Undo on "Added a note: Closure, Thu, Nov 26"
- **THEN** the note is deleted, the row reads `undone`, and the next forecast read no longer closes that day

#### Scenario: Edited since
- **WHEN** a member edited TownwiseAI's note and then presses Undo on it
- **THEN** the API answers 409 `changed_since`, the note stays, and the activity stops offering Undo for it

#### Scenario: Another organization's change
- **WHEN** a member sends the id of another organization's change
- **THEN** the API answers 404

### Requirement: Changes show in activity and in a log
The activity feed SHALL list each change as `agent_change` with its date, action, source kind, status, dates and whether it can be undone. It SHALL never include a title, file name, figure or why. `GET /api/org/locations/:locationId/agent/changes` SHALL list every change of the location, 50 a page, newest first, with its why and status, to members. Logs SHALL carry counts only, and audit events SHALL carry `locationId`, `action` and `sourceKind` only.

#### Scenario: A file read applied three notes
- **WHEN** an automatic read applies three notes
- **THEN** the activity lists three `agent_change` items with Undo, and the log lists them with their whys

#### Scenario: View-as
- **WHEN** staff view the activity as a member
- **THEN** they see the changes, and no Undo is offered

### Requirement: A calendar answers open closure questions
When a location's calendar events switch (a calendar added, the refresh loop, Refresh now) and at the end of its weekly pass, Townwise SHALL check, with no model call, the location's open closure questions and suggestions against the keyed all-day events of all its calendars whose titles plainly say the business is closed (design decision 16's word rule). A gap or likely-closed question SHALL not ask about a day such an event covers. A dated closure rule or closure note suggestion every day of which is covered, and a standing closed weekday whose next 8 days of each weekday are covered, SHALL be answered unless a person's note or rule decides one of its days differently. While TownwiseAI works on its own, an answer SHALL first save, through the one writer with `sourceKind: 'calendar'`, a closure note linked to each answering event that no closure or private-event note covers (or, for a standing weekday, the suggestion's rule), and SHALL leave the suggestion open when any of them is not written. While it does not, nothing SHALL be written. An answered suggestion SHALL read `answered` with `decidedBy: 'calendar'`, and SHALL no longer be listed or counted anywhere. Logs and audit events SHALL carry ids and counts only.

#### Scenario: The owner puts "Closed" on his Google calendar
- **WHEN** TownwiseAI works on its own, a file suggested "Closed Dec 24 to Dec 26", and the owner connects a Google calendar with an all-day event "Closed for the holidays" on those days
- **THEN** the suggestion is gone from TownwiseAI's panel, its counts, Home and Business rules, a closure note linked to the event shows in the activity with Undo, and the forecast closes those days

#### Scenario: The switch is off
- **WHEN** the same calendar is connected while TownwiseAI does not work on its own
- **THEN** the suggestion is answered and gone from every place, and no note or rule is written

#### Scenario: A person's note disagrees
- **WHEN** a member's note says Dec 24 is a private party and the calendar says closed
- **THEN** the suggestion stays open and nothing is written

#### Scenario: A title that does not plainly say closed
- **WHEN** the calendar's event on those days reads "Closed early" or "Kitchen closed"
- **THEN** nothing is answered
