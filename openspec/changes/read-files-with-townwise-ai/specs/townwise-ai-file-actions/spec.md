## ADDED Requirements

### Requirement: Events become notes
Each dated event in a finished read SHALL become a note on the location through the notes route's own rules, authored by the person who asked and carrying `source: { via: 'ai_file', fileId }`. At most 50 notes SHALL be made a file. An event the route would refuse SHALL be skipped `invalid`; an event an existing note already says (same kind, start and end, and a detail equal to the title or starting with it and a colon, ignoring case and spacing), including an earlier event of the same file, SHALL be skipped `duplicate`; past the location's 1,000 notes the event SHALL be skipped `cap`.

#### Scenario: A buyout in a calendar file
- **WHEN** a read finds a buyout on 2026-12-12 and no note says it
- **THEN** a `private_event` note is saved at once for that date with the event's title in its detail and the person as its author

#### Scenario: Already noted
- **WHEN** the location already has a note of the same kind and dates whose detail is the event's title
- **THEN** no note is made and `duplicate` is counted

#### Scenario: Expected guests the route refuses
- **WHEN** an event states 0 guests, more than 20,000, or the event is a closure
- **THEN** the note is made without expected guests

### Requirement: Verified daily totals become one upload
Daily totals SHALL be written as one new upload only when the kind is `sales`, there are days, the file wrote no days of its own, it is not a picture, confidence is `high`, and at least 95% of the days are borne out by the file's own text; then only those days SHALL be written. Otherwise none SHALL be written and the reason SHALL be recorded (`not_sales`, `no_days`, `file_wrote_days`, `picture`, `not_high_confidence`, `days_not_verified`). A day is borne out when its date is written in the text, each figure it gives is among the text's numbers, and it passes the upload route's caps.

#### Scenario: Verified report
- **WHEN** a PDF sales report states 30 days and all 30 dates and figures appear in its text
- **THEN** an upload of 30 days is written as the person who asked, with `source: { via: 'ai_file', fileId }`, and `sales.uploaded` records `via: 'townwise_ai'`

#### Scenario: Figures not in the text
- **WHEN** fewer than 95% of the days are borne out
- **THEN** no days are written and the reason is `days_not_verified`

#### Scenario: A picture
- **WHEN** the file is a picture of a sales sheet
- **THEN** no days are written and the reason is `picture`

#### Scenario: Member versus org admin
- **WHEN** a member asked, versus an org admin
- **THEN** the member's upload adds new days only and the org admin's replaces the days it covers

### Requirement: The summary item
A non-empty summary SHALL be kept as a reference text item, titled from the file's name without its extension, holding the summary and each fact on a "- " line, added by the person who asked, with `addedVia: 'townwise_ai'` and a `source` naming the file, so TownwiseAI can read it in chat. A stored-files cap that refuses it SHALL skip it with that reason without failing the read.

#### Scenario: Inventory file
- **WHEN** a read of an inventory sheet finds a summary and three facts
- **THEN** a reference item holds the summary and three "- " lines and records `file.uploaded` with `via: 'townwise_ai'`

#### Scenario: Storage full
- **WHEN** the item would exceed the stored-files caps
- **THEN** the item is skipped with `storage_full` or `daily_upload_limit` and the read still completes

### Requirement: The model update
When a read made a note or wrote a day and the person who asked is an org admin, a calibration SHALL start as them through the lab's own checks, `via: 'file'`. The status SHALL be recorded: `started`, `not_needed`, `not_admin`, `org_not_active`, `lab_unavailable`, `not_enough_history`, `regime`, `budget_spent`, `in_progress`, `daily_limit` or `start_failed`. A refusal SHALL NOT fail the read, and publishing SHALL stay behind staff's forecasts switch.

#### Scenario: Org admin with enough history
- **WHEN** an org admin's read writes notes and every lab check passes
- **THEN** a calibration starts and the outcome records `started` with its id

#### Scenario: Member
- **WHEN** a member's read writes notes
- **THEN** the status is `not_admin` and no calibration starts

### Requirement: Retry safety
Actions SHALL run once per finished read, after the answer is saved and before the read is marked done, inside the same claim. Fresh ids for every note, the upload, the summary item and the calibration SHALL be saved by compare-and-set before the first write, and a retry SHALL write under the same ids. A read no longer held SHALL write nothing.

#### Scenario: Crash between notes
- **WHEN** the reader stops after three of five notes and another replica takes the read
- **THEN** it finds the saved plan, counts the three as made, writes the other two, and no note is duplicated

#### Scenario: File deleted mid-read
- **WHEN** the file is deleted while the actions run
- **THEN** the next step finds the read no longer held and writes nothing
