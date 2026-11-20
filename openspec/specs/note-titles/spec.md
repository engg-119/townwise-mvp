# note-titles Specification

## Purpose
TBD - created by archiving change calendar-shows-everything. Update Purpose after archive.
## Requirements
### Requirement: A note may carry an event name
A note SHALL have an optional `title`, or null, with an empty string read as null. The API SHALL normalize it to NFC, make each run of white space one space and trim it, and SHALL refuse with 400 `invalid_request` a title that holds a control or format character (Unicode `Cc` or `Cf`) or is longer than 120 code points. A create without `title` SHALL store null. An edit body without a `title` key SHALL keep the stored title, merged before any other rule is checked, and `title: null` SHALL clear it. An `other` note SHALL need a title or a detail. A business rule's schedule SHALL refuse a `title` key, as it refuses `detail`. Every note read SHALL answer `title`.

#### Scenario: Save a titled buyout
- **WHEN** a member saves a private-event note, effect closed, 70 guests, titled "Holiday party"
- **THEN** the note is stored and read back with `title: "Holiday party"`

#### Scenario: An older client edits a titled note
- **WHEN** an edit of a titled note is sent with no `title` key
- **THEN** the stored title is kept

#### Scenario: An older client edits an other note
- **WHEN** an `other` note has a title and no detail, and an edit is sent with no `title` key and `detail: null`
- **THEN** the edit is saved and the title is kept

#### Scenario: A title with a bidi override
- **WHEN** a member saves a note whose title holds U+202E or a newline
- **THEN** the API answers 400 `invalid_request` and stores nothing

#### Scenario: An other note with only a title
- **WHEN** a member saves an `other` note with a title and no detail
- **THEN** it is saved

#### Scenario: A rule schedule with a title
- **WHEN** a rule is saved with a schedule holding `title`
- **THEN** the API answers 400 `invalid_request` and stores nothing

### Requirement: The title stays private
A note's title SHALL NOT appear in any log line, audit event, URL or lab input. The `note.created`, `note.updated` and `note.deleted` audit events SHALL keep `locationId`, `kind`, `startDate` and `endDate` only.

#### Scenario: A sentinel title
- **WHEN** a note titled with a sentinel string is created, edited and deleted
- **THEN** the sentinel appears in no log line and no audit event

### Requirement: The note form asks for the event name
The note form (C6) SHALL hold an optional "Event name" field after Kind, on web and native, with the placeholder "Holiday party", the helper "Name the event, not the guests." and a 120-character limit, filled from the note on Edit. Make a note SHALL leave it empty and SHALL NOT copy an imported event's title (D33).

#### Scenario: Add an event with a name
- **WHEN** a member opens "Add an event" on the Calendar, types "Holiday party" in Event name and saves
- **THEN** the note is saved with that title and the day's cell shows "Holiday party"

#### Scenario: Make a note from an imported event
- **WHEN** a member presses Make a note on an imported event titled "Wine dinner"
- **THEN** the form opens with the event's dates and hours and an empty Event name

### Requirement: Surfaces show the title, and reasons keep code-made labels
Compact surfaces SHALL show a note's title in place of its kind words. The day panel, Home's day detail and the Notes page (P14) SHALL show the title, then the kind words, then the detail. A forecast reason's label SHALL stay made in code (D30). Where a note reason's note has a title, the Calendar, Home and TownwiseAI's cards MAY show the title after the label, joined by the reason's `note.id`. A day booked by the forecast with no note SHALL keep "Booked for a private event".

#### Scenario: Why with a titled buyout
- **WHEN** a day's Why lists the note reason "Your private buyout, 70 guests" for a note titled "Holiday party"
- **THEN** it reads "Your private buyout, 70 guests: Holiday party"

#### Scenario: An untitled note
- **WHEN** a day has an untitled private-event note of 70 guests
- **THEN** its cell shows "Private event, 70"

### Requirement: TownwiseAI's file reader names the notes it makes
A note TownwiseAI makes from a file's event SHALL take the event's title as its `title`, normalized to NFC with white space collapsed and control and format characters removed (no title when nothing is left), and the event's own detail as its `detail`, or null when that is empty or equals the title. The duplicate check SHALL also skip an event when a note of the same kind, start and end has a folded title equal to the event's title, whether or not that note has a detail.

#### Scenario: A buyout in a calendar file
- **WHEN** a read finds "Rehearsal dinner" on 2026-12-12, a buyout of 60 guests, with no further detail
- **THEN** the note made has title "Rehearsal dinner" and detail null

#### Scenario: Already named
- **WHEN** the location has a buyout note on 2026-12-12 titled "rehearsal  dinner" with no detail
- **THEN** no note is made and `duplicate` is counted

### Requirement: Notes TownwiseAI already made are named once
At boot, the API SHALL give each note that has a `source` and no `title` key the title of the event it was made from, read from the file's stored read at the note's planned index and cleaned as a new note's is, or null when that event is no longer stored or the note's detail no longer says the event's title (its folded detail neither equals the folded title nor starts with it followed by ":"). It SHALL write only where the `title` key is still absent, SHALL leave `detail` unchanged, SHALL write no audit event and SHALL log only counts, so a second run changes nothing.

#### Scenario: An older note from a calendar file
- **WHEN** a note made before this change from the event "Rehearsal dinner" has detail "Rehearsal dinner: party of 60" and no title
- **THEN** after the next boot it has title "Rehearsal dinner" and the same detail

#### Scenario: The original was deleted
- **WHEN** such a note's file had its original deleted
- **THEN** after the next boot its title is null, and a later boot does not visit it again

#### Scenario: The owner rewrote the detail
- **WHEN** such a note's detail was edited by the owner to "Party of 60, back room", taking the event's name out
- **THEN** after the next boot its title is null, so the name does not come back

### Requirement: TownwiseAI reads and proposes the title
`list_notes` and `get_day` SHALL return each note's `title`. `propose_note` SHALL take `title` (a string of at most 120 characters naming the event and never a person, or null), and its card SHALL show it and save it. The weekly suggestion card SHALL show a note's title when it has one. The side panel's activity line SHALL stay without it.

#### Scenario: A proposal with a name
- **WHEN** TownwiseAI proposes a private event titled "Alumni weekend dinner" and the person presses Save note
- **THEN** the saved note has that title

#### Scenario: Reading notes
- **WHEN** TownwiseAI calls `list_notes` for a location with a titled note
- **THEN** the result holds the note's `title`

