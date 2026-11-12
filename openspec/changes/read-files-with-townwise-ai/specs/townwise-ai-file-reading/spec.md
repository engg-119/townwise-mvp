## ADDED Requirements

### Requirement: Reading is opt-in per file
A stored file SHALL be sent to a model only when the person who added it, or an org admin, asks for that file. It SHALL NOT be read by default, in bulk, under view-as, or without an `ANTHROPIC_API_KEY`, with `TOWNWISE_FILES_MONTHLY_BUDGET_USD` at 0, or while stored files are off.

#### Scenario: The uploader asks
- **WHEN** the person who added a stored file posts to `org.data.ai_read` for it
- **THEN** the API answers 202 with the item, queues the read and records `file.ai_read_requested` with the file's kind and no name

#### Scenario: Someone else asks
- **WHEN** a member who did not add the file and is not an org admin asks
- **THEN** the API answers 403 `forbidden` and queues nothing

#### Scenario: Under view-as
- **WHEN** staff view as an organization and ask for a read
- **THEN** the request is refused by the route chain and nothing is queued

#### Scenario: Reading is off
- **WHEN** there is no `ANTHROPIC_API_KEY` or the budget setting is 0
- **THEN** the API answers 503 `ai_unavailable` and the item's `canAiRead` is false

#### Scenario: A read is running
- **WHEN** a read is already queued or reading for the file
- **THEN** the API answers 409 `ai_read_running`

#### Scenario: Another organization's file
- **WHEN** the ref belongs to another organization
- **THEN** the API answers 404, the same as an unknown id

### Requirement: What is sent
The reader SHALL make one request per file to Claude Opus 5.5. A PDF up to 10 MiB and 600 pages SHALL go as a document, a PNG, JPEG, GIF or WebP up to 5 MiB as an image, and text, workbooks, Word files and ZIP entries as text made in a worker thread. The request SHALL NOT contain the file's name, the organization's or location's name, anyone's email, or a ZIP entry path. Input cut to fit the caps SHALL be marked `partial` and said so in the request.

#### Scenario: Names stay out
- **WHEN** a file named after a person at a named location is read
- **THEN** the request holds the file's content, today's date, the time zone and what the file is, and none of the names

#### Scenario: Cut input
- **WHEN** a text is longer than 300,000 characters
- **THEN** the start is sent, the request says only the start was sent, and the read is `partial`

#### Scenario: A ZIP
- **WHEN** a ZIP has readable entries
- **THEN** up to 20 are read behind the archive guards into one input under `Entry n (what it is):` lines, and the request says how many were not read

#### Scenario: Not read
- **WHEN** the file is `.xls`, `.doc`, a Numbers file, another unknown kind, or a ZIP with no readable entry
- **THEN** the read is `skipped` with `kind_not_read`, no call is made and nothing is charged

### Requirement: The answer is checked and saved first
Townwise SHALL parse and check the model's answer itself. An unknown kind SHALL read as `other`, an unknown confidence as `low`, and any fact, event or day that fails its check SHALL be dropped without failing the read. The checked answer SHALL be saved on the file before any action runs.

#### Scenario: One bad event
- **WHEN** an answer holds ten events and one has an end before its start
- **THEN** nine are kept and the read still completes

#### Scenario: Retry after a crash
- **WHEN** the reader restarts after the answer was saved
- **THEN** it acts on the saved answer and makes no second model call

### Requirement: Outcomes and attempts
A read SHALL end `done`, `skipped` (with `budget_spent`, `too_large`, `kind_not_read`, `encrypted`, `raw_missing`, `too_complex` or `not_readable`) or `failed` (with `refused` or `internal`). It SHALL be attempted at most three times. A failed, skipped or undone read MAY be asked for again.

#### Scenario: Original gone
- **WHEN** the file's original is deleted while the model reads it
- **THEN** the read is `skipped` with `raw_missing` and nothing of the answer is kept

#### Scenario: Refusal through the fallback chain
- **WHEN** every model in the chain refuses
- **THEN** the read is `failed` with `refused`, only its outcome and cost are written, and the person may ask again

### Requirement: Budget
Each call SHALL be charged to `tw_files_usage` within `TOWNWISE_FILES_MONTHLY_BUDGET_USD`, shared with the file reader's AI column step. The budget SHALL be checked before the call and charged after it whatever the answer.

#### Scenario: Budget spent
- **WHEN** the organization's month is spent
- **THEN** the read is `skipped` with `budget_spent` and no call is made

### Requirement: Privacy of logs and audit
Logs and audit events SHALL carry ids, kinds, counts and codes only. They SHALL NOT carry a file name, a summary, a fact, an event title, a note's text or a figure. Under view-as an item's summary, facts and notes' titles SHALL be null.

#### Scenario: Audit event
- **WHEN** a read finishes
- **THEN** `file.ai_read` carries the location id, kind, event and day counts, notes and days written, whether an item was kept and the calibration status code, and no text
