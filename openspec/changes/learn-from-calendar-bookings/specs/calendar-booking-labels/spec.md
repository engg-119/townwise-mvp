## ADDED Requirements

### Requirement: Each event of a file calendar may carry a booking label
An event of a file calendar SHALL carry at most one label: `buyout` (takes the whole restaurant), `party` (a private party alongside regular service), `own_event` (the restaurant's own public event) or `other` (not a booking), with who set it (`ai` or `person`) and when. Link and Google calendars SHALL refuse labels with 409 `not_a_file_calendar`. Labels SHALL change no forecast until the calendar's bookings are confirmed. No label SHALL be logged per event, and no uid SHALL go in a URL path or query.

#### Scenario: A link calendar
- **WHEN** an org admin tries to sort or label a subscribed link's events
- **THEN** the API answers 409 `not_a_file_calendar`

#### Scenario: Unconfirmed labels
- **WHEN** a calendar's events are labeled but nobody has pressed Use for forecasts
- **THEN** the lab input, the forecast read and the notes are unchanged

### Requirement: An org admin can sort a calendar's events with TownwiseAI
`POST /api/org/locations/:locationId/owner-calendars/:calendarId/bookings/sort` SHALL be allowed only to an org admin outside view-as and not to staff open as admin. It SHALL be limited to 3 a calendar an hour, and it SHALL answer 503 without a model key and 409 `chat_budget_exhausted` when the organization's TownwiseAI month cannot cover its ceiling. It SHALL send the calendar's unlabeled events in batches of at most 250, each as a request-local ref, a title with emails and phone numbers replaced by `[removed]`, its dates with weekdays, and its hours. It SHALL never send the calendar's name, id or kind, an event's uid, or any other CSV column. It SHALL keep an answer's label only for a ref its batch sent, the first time, and leave `unsure`, missing and failed-batch events unlabeled. It SHALL never overwrite a label a person set, and it SHALL keep no words of the model.

#### Scenario: A first sort
- **WHEN** an org admin presses Sort with TownwiseAI on a calendar of 1,067 events
- **THEN** 5 batches are sent, each event the model labeled is stored with `bookingBy: 'ai'`, and the answer says how many were labeled

#### Scenario: A title with a phone number
- **WHEN** an event's title holds a phone number
- **THEN** the request holds `[removed]` in its place

#### Scenario: Staff open as admin
- **WHEN** staff with the organization open as admin press Sort
- **THEN** the API answers 403 `open_as_admin_refused` and nothing is sent

#### Scenario: A person's label survives a later sort
- **WHEN** an org admin set an event to `other` and then sorts again
- **THEN** that event is not sent and keeps `other`

### Requirement: An org admin reviews, edits and confirms the labels
An org admin SHALL set any event's label with `PATCH .../owner-calendars/:calendarId/bookings { uid, booking }`, stored with `bookingBy: 'person'`. `POST .../owner-calendars/:calendarId/bookings/confirm` SHALL mark the calendar's bookings confirmed by compare-and-set, with when and by whom. Members SHALL see the labels and counts read-only, and under view-as the section SHALL be read-only. Staff open as admin MAY label and confirm.

#### Scenario: A member tries to label
- **WHEN** a member sends a label
- **THEN** the API answers 403 and nothing changes

#### Scenario: Confirming
- **WHEN** an org admin presses Use for forecasts after reviewing
- **THEN** the calendar's bookings are confirmed and the audit log records `owner_calendar.bookings_confirmed` with counts only

### Requirement: Confirmed upcoming bookings become linked notes
On confirm, and when a confirmed calendar's event is later set to `buyout` or `party`, Townwise SHALL make a note for each such event that ends on or after the town's today, is keyed, is linked to no note and overlaps no private-event or closure note. The note SHALL be a private event with effect closed for a buyout or more guests for a party, with a null guest count, null title and detail, the event's dates, its hours when Section 12 allows them, and `fromEvent` set. A confirm SHALL make at most 100, soonest first, within the location's note limit, and a retry SHALL make none twice. Setting an upcoming event's label away from `buyout` or `party` SHALL leave its note and answer `noteKept: true`.

#### Scenario: An upcoming buyout
- **WHEN** an org admin confirms a calendar holding a `buyout` event next month
- **THEN** a linked private-event note with effect closed is made on its dates, and the forecast read books that day

#### Scenario: Already noted
- **WHEN** an upcoming `party` event is already linked to a note
- **THEN** no second note is made

#### Scenario: Relabeling an upcoming event
- **WHEN** an org admin sets an upcoming `buyout` event to `other` after confirming
- **THEN** its note stays, and the answer says `noteKept: true`

### Requirement: Confirming starts a refit when it can
Confirming SHALL start a calibration as the confirming admin when the lab is on and the admin's starts allow it, and otherwise SHALL say the next weekly refresh will learn from the labels.

#### Scenario: Lab off
- **WHEN** an org admin confirms while the lab runner is off
- **THEN** the labels are confirmed, no calibration starts, and the answer says when they will be learned from
