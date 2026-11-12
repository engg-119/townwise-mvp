## ADDED Requirements

### Requirement: Events become notes
Each dated event in a finished read SHALL become a note on the location through the notes route's own rules, authored by the person who asked and carrying `source: { via: 'ai_file', fileId }`. At most 50 notes SHALL be made a file. A read SHALL NOT make a closed note (a closure, or effect closed) spanning more than 14 days, nor more than 31 closed days in all; those SHALL be skipped `guard`. An event the route would refuse SHALL be skipped `invalid`; an event an existing note already says (same kind, start and end, and a detail equal to the title or starting with it and a colon, ignoring case and spacing), including an earlier event of the same file, SHALL be skipped `duplicate`; past the location's 1,000 notes the event SHALL be skipped `cap`.

#### Scenario: A buyout in a calendar file
- **WHEN** a read finds a buyout on 2026-12-12 and no note says it
- **THEN** a `private_event` note is saved at once for that date with the event's title in its detail and the person as its author

#### Scenario: Already noted
- **WHEN** the location already has a note of the same kind and dates whose detail is the event's title
- **THEN** no note is made and `duplicate` is counted

#### Scenario: A long closure
- **WHEN** a file states a 20-day closure, or closures adding up past 31 days
- **THEN** the closure over 14 days, and the ones past 31 days, are not made and `guard` is counted

#### Scenario: Expected guests the route refuses
- **WHEN** an event states 0 guests, more than 20,000, or the event is a closure
- **THEN** the note is made without expected guests

### Requirement: Verified daily totals become one upload
Daily totals SHALL be written as one new upload only when the kind is `sales`, there are days, the file wrote no days of its own, it is not a picture, confidence is `high`, at least 95% of the days are borne out by the file's own text, and the location lacks at least one of them; then only those days SHALL be written. Otherwise none SHALL be written and the reason SHALL be recorded (`not_sales`, `no_days`, `file_wrote_days`, `picture`, `not_high_confidence`, `days_not_verified`, `already_had_days`). A day is borne out only when one line of the text carries its date and no other date and carries each figure it gives as separate numbers, and it passes the upload route's caps. A day the location already has SHALL NOT be replaced, for anyone, and no null SHALL be written over a figure; those days SHALL be counted.

#### Scenario: Verified report
- **WHEN** a PDF sales report states 30 days and all 30 dates and figures appear in its text
- **THEN** an upload of 30 days is written as the person who asked, with `source: { via: 'ai_file', fileId }`, and `sales.uploaded` records `via: 'townwise_ai'`

#### Scenario: Figures not in the text
- **WHEN** fewer than 95% of the days are borne out
- **THEN** no days are written and the reason is `days_not_verified`

#### Scenario: A picture
- **WHEN** the file is a picture of a sales sheet
- **THEN** no days are written and the reason is `picture`

#### Scenario: Rows read shifted by one
- **WHEN** the model gives each date the figures of the next row
- **THEN** no day is borne out and the reason is `days_not_verified`

#### Scenario: Days already stored
- **WHEN** an org admin's read finds three verified days and the location already has one of them
- **THEN** the upload adds the other two, the stored day keeps its figures, and `daysAlreadyHad` is 1

#### Scenario: Every day already stored
- **WHEN** the location already has every verified day
- **THEN** no upload is made and the reason is `already_had_days`

### Requirement: The summary item
A non-empty summary SHALL be kept as a reference text item, titled from the file's name as it is when the item is kept, without its extension, holding the summary and each fact on a "- " line, added by the person who asked, with `addedVia: 'townwise_ai'` and a `source` naming the file, so TownwiseAI can read it in chat. A stored-files cap that refuses it SHALL skip it with that reason without failing the read.

#### Scenario: Inventory file
- **WHEN** a read of an inventory sheet finds a summary and three facts
- **THEN** a reference item holds the summary and three "- " lines and records `file.uploaded` with `via: 'townwise_ai'`

#### Scenario: Storage full
- **WHEN** the item would exceed the stored-files caps
- **THEN** the item is skipped with `storage_full` or `daily_upload_limit` and the read still completes

### Requirement: The model update
When a read made a note or wrote a day and the person who asked is an org admin at that time (their current role, not the one they asked with), a calibration SHALL start as them through the lab's own checks, `via: 'file'`. The status SHALL be recorded: `started`, `not_needed`, `not_admin`, `org_not_active`, `lab_unavailable`, `not_enough_history`, `regime`, `budget_spent`, `in_progress`, `daily_limit` or `start_failed`. A refusal SHALL NOT fail the read, and publishing SHALL stay behind staff's forecasts switch.

#### Scenario: Org admin with enough history
- **WHEN** an org admin's read writes notes and every lab check passes
- **THEN** a calibration starts and the outcome records `started` with its id

#### Scenario: Member
- **WHEN** a member's read writes notes
- **THEN** the status is `not_admin` and no calibration starts

#### Scenario: Promoted since asking
- **WHEN** a member asks and is made an org admin before the read is acted on
- **THEN** a calibration starts as them

### Requirement: Retry safety
Actions SHALL run once per finished read, after the answer is saved and before the read is marked done, inside the same claim, and only while the person who asked still has a seat in the organization (or, as staff, a live open-as-admin grant); otherwise nothing SHALL be written and the read SHALL be `skipped` with `requester_gone`. Fresh ids for every note, the upload, the summary item and the calibration SHALL be saved by compare-and-set before the first write, and a retry SHALL write under the same ids. A read no longer held, or whose original was deleted, SHALL write nothing more, checked before each note.

#### Scenario: Crash between notes
- **WHEN** the reader stops after three of five notes and another replica takes the read
- **THEN** it finds the saved plan, counts the three as made, writes the other two, and no note is duplicated

#### Scenario: File deleted mid-read
- **WHEN** the file is deleted while the actions run
- **THEN** the next step finds the read no longer held and writes nothing

#### Scenario: The asker left
- **WHEN** the person who asked is removed from the organization before the read is acted on
- **THEN** nothing is written and the read is `skipped` with `requester_gone`
