## ADDED Requirements

### Requirement: An organization switch turns TownwiseAI's own work off and on
`tw_orgs` SHALL hold `agentAuto: { on, at, by }`. An absent value SHALL read as on. `PATCH /api/org/agent-auto { on }` SHALL be allowed to an org admin outside view-as. Staff open as admin SHALL only turn it off, and 403 `open_as_admin_refused` SHALL answer a turn-on. The change SHALL be recorded as `org.agent_auto_switched { on }`. `TOWNWISE_AGENT_AUTO` SHALL default to true, and automatic work SHALL run only while both are on. While either is off, presses SHALL behave as before this change, and no automatic read, sort or apply SHALL run.

#### Scenario: Default
- **WHEN** an organization has never switched it
- **THEN** TownwiseAI works on its own, and the panel says it is on

#### Scenario: Staff open as admin
- **WHEN** staff open as admin try to turn it on
- **THEN** the API answers 403 `open_as_admin_refused`

#### Scenario: Off restores today's behavior
- **WHEN** the switch is off and a member presses Read with TownwiseAI on a file
- **THEN** the read writes its events as D34 does today, with no confidence bar

### Requirement: Calendar titles follow their own switch
An automatic calendar sort or a brought-forward weekly pass SHALL send event titles only while the organization's `calendarTitlesToAi` switch is also on.

#### Scenario: Titles off
- **WHEN** `calendarTitlesToAi` is off and an org admin imports a calendar CSV
- **THEN** no sort is queued, and the calendar's page still offers Sort with TownwiseAI

### Requirement: The wording says what TownwiseAI does on its own
P25's How TownwiseAI works SHALL say that TownwiseAI saves what it is sure of, shows each change with Undo, and leaves what it is not sure of waiting. It SHALL no longer say that it never saves a note without you. The Add a file box SHALL be checked by default while the switch is on. The privacy page SHALL say which sources are read without a press, that a sales export read into days and a file whose box was unchecked are not, what TownwiseAI may add, that it never changes or deletes what exists, and where the log is. The wording SHALL be marked [CONFIRM] until the owner approves it, and SHALL ship before the switch is on in production.

#### Scenario: The privacy page
- **WHEN** a visitor reads the privacy page
- **THEN** it says stored files other than sales exports are read by TownwiseAI unless an org admin turns it off or the file's box was unchecked

#### Scenario: The panel
- **WHEN** a member opens How TownwiseAI works
- **THEN** it says TownwiseAI saves what it is sure of with Undo, and the old sentence is gone
