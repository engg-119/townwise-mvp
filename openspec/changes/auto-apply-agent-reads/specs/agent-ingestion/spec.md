## ADDED Requirements

### Requirement: A stored file is read by TownwiseAI when it is stored
While the organization's `agentAuto` switch and `TOWNWISE_AGENT_AUTO` are both on, Townwise SHALL queue a TownwiseAI read, marked `auto`, for each stored file once the file reader finishes it, unless any of these hold: the file was read into sales days, it is kept as `calendar_export`, its original is gone, or the person unchecked the Add a file box for it. The read SHALL use D34's queue, reader, lease, retries and checks. The system SHALL be the requester, and the file's adder SHALL be checked as D34 checks the person who asked. While either switch is off, no read SHALL be queued without a press.

#### Scenario: A PDF added for reference
- **WHEN** a member adds a PDF to Your data with the box left checked and the switch on
- **THEN** a TownwiseAI read of it is queued `auto` without a press

#### Scenario: A point-of-sale export
- **WHEN** the file reader reads a CSV into 400 sales days
- **THEN** no TownwiseAI read is queued for it, and its page still offers Read with TownwiseAI

#### Scenario: Switch off
- **WHEN** an org admin has turned the switch off and a member adds a PDF
- **THEN** nothing is queued, and the file is read only when someone presses Read with TownwiseAI

#### Scenario: Box unchecked
- **WHEN** a member unchecks the box under Add a file before adding a Word document
- **THEN** no read is queued for that document

### Requirement: The same file is never read twice
An automatic read SHALL be skipped `duplicate` before reading the budget, reserving or calling the model when another file of the location with the same fingerprint already has a finished TownwiseAI read.

#### Scenario: The same PDF uploaded again
- **WHEN** a member adds a PDF byte-identical to one TownwiseAI already read for the location
- **THEN** the new read is skipped `duplicate`, nothing is charged, and no change is applied

### Requirement: Automatic reads are bounded per organization
An automatic file read SHALL start only while the organization's files month, after the read's ceiling is reserved, still has more than $1 left. It SHALL be skipped `budget_spent` otherwise. At most 20 automatic reads SHALL start per organization per day, and the rest SHALL be skipped `daily_auto_limit`. Reads SHALL run one at a time per organization, as D34's claim does. A read someone pressed SHALL keep D34's bounds only.

#### Scenario: Month nearly spent
- **WHEN** $1.20 of the files month is left and an automatic read's ceiling is $0.44
- **THEN** the read is skipped `budget_spent`, and a member can still press Read with TownwiseAI on another file

#### Scenario: A ZIP of 30 files
- **WHEN** 30 stored files of one organization are queued `auto` in one day
- **THEN** 20 are read one after another and 10 are skipped `daily_auto_limit`

### Requirement: Sales uploads and a person's edits start no model call
An applied sales upload, and a note or business rule a person saves, changes or deletes, SHALL start no model call. When one touches a day on or before the location's sales data end, it SHALL mark the location as wanting a refit.

#### Scenario: A sales upload
- **WHEN** a member applies an upload of 30 new days
- **THEN** nothing is sent to Anthropic and the location is marked as wanting a refit

### Requirement: Writes are ordered so a retry completes them
Every change TownwiseAI applies SHALL first be inserted into `tw_agent_changes` as `applying`, under a planned target id and a dedupe key that is unique per location in every status. The target SHALL then be written under that id. The row SHALL then be set `applied` by compare-and-set, with the target's `updatedAt`. The audit event SHALL be recorded last. A retry SHALL find the row and the target by their ids and finish the remaining steps. A duplicate key SHALL mean the change already exists, and nothing SHALL be written again.

#### Scenario: A crash after the note is written
- **WHEN** the reader dies after writing a note and before setting its row `applied`
- **THEN** the retry finds the note by its planned id, sets the row `applied`, and writes no second note

#### Scenario: Two sources state the same event
- **WHEN** a PDF and a photo read the same day state the same private event with the same kind, dates, effect and title
- **THEN** one note is written, and the second read records it as skipped `duplicate`
