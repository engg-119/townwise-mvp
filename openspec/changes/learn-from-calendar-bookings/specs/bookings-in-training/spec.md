## ADDED Requirements

### Requirement: Confirmed labels mark past days in the lab input
`buildLabInput` SHALL read the current `buyout` and `party` events of the location's file calendars whose bookings are confirmed, as dates and label only, never a title or uid. On a day on or before `dataThrough` that such an event covers, and that no private-event or closure note covers, a `buyout` SHALL set `booked` and a `party` SHALL set `privateEvent`. Where such a note covers the day, the note SHALL decide. Labels SHALL NOT change `closed`, the likely-closed test, a rule's closure or the guests sent. After `dataThrough`, labels SHALL set nothing in the input. `own_event` and `other` SHALL set nothing.

#### Scenario: A past buyout
- **WHEN** a confirmed calendar holds a `buyout` event on a past Friday with low walk-in guests
- **THEN** that day goes to the lab with `booked` true, so the model does not learn walk-ins from it

#### Scenario: A past party alongside service
- **WHEN** a confirmed calendar holds a `party` event on a past Saturday with no note
- **THEN** that day goes to the lab with `privateEvent` true and its guests unchanged

#### Scenario: A note on the day
- **WHEN** a past day has a counted party note and a `party` label
- **THEN** the note decides, the day's guests go out less the note's count, and `privateEvent` stays false

#### Scenario: A party check on a closed Monday
- **WHEN** a likely-closed past Monday holds a `party` event
- **THEN** the day stays closed with null guests

#### Scenario: An upcoming party
- **WHEN** a `party` event is after `dataThrough`
- **THEN** the label sets no flag in the input, and the day's note (made at confirm) is what changes its forecast

### Requirement: Label changes refit through the input fingerprint
Confirming labels, editing a confirmed calendar's label of a past event, or removing a confirmed calendar SHALL change the lab input's fingerprint, so the weekly refresh refits that location. Unconfirmed labels SHALL NOT change it. The lab's code, the input schema `townwise.lab-input/2` and `LAB_MODEL_VERSION` SHALL stay unchanged by this change.

#### Scenario: Confirming changes the fingerprint
- **WHEN** an org admin confirms a calendar whose labels mark past days
- **THEN** the location's next weekly pass finds its fingerprint changed and starts a refit

#### Scenario: Sorting alone does not
- **WHEN** an org admin sorts a calendar and does not confirm
- **THEN** the weekly pass skips the location as `unchanged`

### Requirement: The weekly suggestions leave labeled events out
TownwiseAI's weekly call SHALL leave out of `ownerEvents` every event that carries a label on a confirmed calendar, and SHALL send a confirmed calendar's unlabeled events and an unconfirmed calendar's events as before.

#### Scenario: A labeled upcoming event
- **WHEN** a confirmed calendar's upcoming event is labeled `other`
- **THEN** the weekly call does not send it
