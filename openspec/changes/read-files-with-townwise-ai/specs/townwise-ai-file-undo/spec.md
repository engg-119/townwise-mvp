## ADDED Requirements

### Requirement: Who may undo
The person who asked for a read, or an org admin, SHALL be able to undo it outside view-as, on a done read that made a note, an upload or a summary item, and on a read that failed or was skipped after its actions began (a plan saved, no outcome recorded). It SHALL be refused with 409 `ai_read_running` while the read is queued or reading, 403 `forbidden` for anyone else, and 400 `nothing_to_undo` for a read whose actions never began or that made nothing. It SHALL work while reading with TownwiseAI is off.

#### Scenario: The asker undoes
- **WHEN** the person who asked sends `org.data.ai_undo` for a done read
- **THEN** the API answers 200 with the item and the read is `undone`

#### Scenario: A read that stopped part way
- **WHEN** a read's actions wrote notes and days and then failed three times
- **THEN** the read is `failed`, `canUndo` is true, and an undo removes what it wrote

#### Scenario: Unrelated member
- **WHEN** a member who neither asked nor is an org admin tries
- **THEN** the API answers 403 `forbidden` and nothing is removed

#### Scenario: Still reading
- **WHEN** the read is queued or reading
- **THEN** the API answers 409 `ai_read_running`

### Requirement: What goes and what stays
Undo SHALL remove the notes the read made (including one the person since edited), its upload with the days that upload still holds (only days it added, since it never replaced one), and its summary item (including an edit of it). Days a later upload replaced SHALL stay. A calibration the read started SHALL NOT be undone: it runs on and publishes only as any calibration does, and the answer SHALL name it.

#### Scenario: Edited note
- **WHEN** the person edited a note TownwiseAI made and then undoes the read
- **THEN** the note is removed because an edit keeps its `source`

#### Scenario: Calibration started
- **WHEN** the read started a calibration
- **THEN** undo answers 200 with `calibrationKept` set to its id and the calibration keeps running

#### Scenario: Replaced days
- **WHEN** a later upload replaced some of the read's days
- **THEN** undo deletes the read's upload and the days it still holds, and the later upload's days stay

### Requirement: Retry-safe, recorded once
Undo SHALL mark the read `undoing` by compare-and-set, remove everything that carries the file as its `source` by filter so a step may run twice harmlessly, then mark the read `undone` and clear its actions and its answer. Only the call that marks it `undone` SHALL record `file.ai_undone` with counts of notes, days and items; the audit event SHALL carry no name or title. A repeat after it finished SHALL answer 200 unchanged and record nothing.

#### Scenario: Crash during undo
- **WHEN** an undo stops after removing the notes
- **THEN** a retry removes the rest, marks the read `undone` and records one `file.ai_undone`

#### Scenario: Asked again after undo
- **WHEN** the person may ask TownwiseAI to read the file again
- **THEN** `canAiRead` is true and a new read starts with a fresh plan
