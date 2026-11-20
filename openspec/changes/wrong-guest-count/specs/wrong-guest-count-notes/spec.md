## ADDED Requirements

### Requirement: A note can mark past days' guest counts as wrong
The notes routes SHALL accept the effect `wrong_guest_count` on a note of kind `other` whose every covered date is before the location's town date, with `expectedGuests` null and `startTime` and `endTime` null. Such a note SHALL need no title or detail. Weekdays SHALL be allowed. Any other combination with this effect SHALL be refused 400 `invalid_request`. A member SHALL create such a note, and its author or an org admin SHALL edit or delete it, as with any note. The stored note SHALL keep the effect in `tw_notes`, and the notes list SHALL answer it.

#### Scenario: The owner marks Halloween weekend
- **WHEN** a member posts a note with kind `other`, effect `wrong_guest_count`, start 2025-10-31, end 2025-11-01, no guests and no hours, on 2026-11-19
- **THEN** the API answers 201 with the note, and the location is marked as wanting a refit

#### Scenario: A day that has not ended
- **WHEN** a note with effect `wrong_guest_count` ends on the town's today or later
- **THEN** the API answers 400 `invalid_request`

#### Scenario: Guests or hours on the mark
- **WHEN** a note with effect `wrong_guest_count` carries an expected guest count or hours
- **THEN** the API answers 400 `invalid_request`

#### Scenario: Another kind
- **WHEN** a note of kind `private_event` or `closure` carries effect `wrong_guest_count`
- **THEN** the API answers 400 `invalid_request`

#### Scenario: Read with the town's date
- **WHEN** it is 21:00 on 2026-11-19 in Hanover (2026-11-20 in UTC) and a note marks 2026-11-19
- **THEN** the API answers 400 `invalid_request`, since the town's day has not ended

### Requirement: Business rules never take the mark
A business rule's schedule SHALL NOT accept effect `wrong_guest_count`, and the rules routes SHALL answer 400 `invalid_request` for it.

#### Scenario: A rule with the mark
- **WHEN** an org admin saves a rule whose schedule has effect `wrong_guest_count`
- **THEN** the API answers 400 `invalid_request` and saves nothing

### Requirement: The mark decides nothing about open, closed or booked
A note with effect `wrong_guest_count` SHALL NOT count as a closure, a buyout or a note that says the day was open. It SHALL NOT set aside a business rule's closure or buyout, SHALL NOT set aside a TownwiseAI note on the same day, and SHALL NOT conflict with any note or rule TownwiseAI applies. On the forecast read every day it covers SHALL have outcome `past_day`.

#### Scenario: A TownwiseAI note on a marked day
- **WHEN** a past day has a person's guest-count mark and a TownwiseAI private-event note nobody edited
- **THEN** the TownwiseAI note is kept and still sets `privateEvent` on that history day

#### Scenario: A closed-Mondays rule
- **WHEN** a past Monday under a closed-Mondays rule has sales and a guest-count mark
- **THEN** the rule's closure holds, as on any past day with no guest count

### Requirement: The mark has its own words
The note form SHALL offer the effect for kind Other as "The guest count was wrong (sales were right)" and, while it is chosen, SHALL hide Expected guests and the hours. A forecast day's reason for the note SHALL read "Your note: guest count marked wrong". A calendar chip or compact entry for such a note with no title SHALL read "Guest count marked wrong".

#### Scenario: The reason on a past forecast day
- **WHEN** the forecast read lists a guest-count mark on a past day
- **THEN** its reason's label is "Your note: guest count marked wrong" and its outcome is `past_day`

#### Scenario: The form
- **WHEN** a member chooses kind Other and the guest-count effect
- **THEN** the Expected guests field and the hours are not shown, and saving sends both as null

### Requirement: TownwiseAI never makes the mark
`propose_note`, Read with TownwiseAI, the weekly suggestions and the D59 agent SHALL NOT propose, save or accept a note with effect `wrong_guest_count`. A note validated without the town's date SHALL be refused when it carries the effect.

#### Scenario: A proposal with the mark
- **WHEN** the model calls `propose_note` with effect `wrong_guest_count`
- **THEN** the tool answers its invalid-input message and no proposal is stored

### Requirement: A mark is never linked to a calendar event
A create body carrying `fromEvent` and effect `wrong_guest_count` SHALL save the note unlinked. The owner-calendar follow-up SHALL skip notes with this effect and expire any open follow-up for one.

#### Scenario: Made from an event
- **WHEN** a member saves a guest-count mark from Make a note on a past event
- **THEN** the note is saved with `fromEvent` null

#### Scenario: A linked note edited into a mark
- **WHEN** a linked note is edited to the guest-count effect and its event later moves
- **THEN** the follow-up writes no move suggestion for it
