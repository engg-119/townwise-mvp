## ADDED Requirements

### Requirement: A note made from an owner-calendar event keeps a link to it
A note SHALL store `fromEvent: { calendarId, uid, startDate, endDate, startTime, endTime, linkedAt }` when it is made with Make a note from a keyed owner-calendar event, or by accepting an `event` suggestion. `uid` SHALL be the event row's stored key: the ICS UID, or Google's event id. An event SHALL be keyed only when its key survives a refresh: every Google event, and an ICS event whose UID was stated, appears once in its file and is at most 1,024 characters (never `event-{n}` or `{UID}#{n}`). The server SHALL read the event from the calendar's current events under the caller's `OrgScope` and take the dates and hours from the stored row, never from the request; an event that is gone, unkeyed or not this location's SHALL leave the note unlinked and still saved. Editing a note SHALL keep its link. A note without the field SHALL read as unlinked. No title SHALL be stored on the note by this link. A `uid` SHALL travel only in JSON bodies and answers, never in a URL, a log line or an audit event. TownwiseAI chat's `propose_note` SHALL stay unlinked, so the chat's frozen prefix is unchanged.

#### Scenario: Make a note from a party on a subscribed calendar
- **WHEN** a member presses Make a note on a link calendar's event with a stated UID and saves a private-event note
- **THEN** the note is stored with `fromEvent` holding that calendar's id, the event's UID and its stored dates and hours, and its detail is whatever the member typed, never the title

#### Scenario: An event with no UID
- **WHEN** a member makes a note from an imported file's event that had no UID
- **THEN** the note is saved with `fromEvent` null

#### Scenario: The event was refreshed away
- **WHEN** the event is gone from the calendar's current events by the time the note is posted
- **THEN** the API answers 201 with the note and `fromEvent` null

### Requirement: A moved or vanished event yields a suggestion, never a change
Where `replaceEvents` switches in a calendar's events (the refresh loop after its "after" check, Refresh now, and an add after the Google `clearCheck`), Townwise SHALL compare each note linked to that calendar with its current events, with no model call, and SHALL write open suggestions in `tw_agent_suggestions`, each with `week` the town's Monday and the note's `updatedAt`: `move` when the event's key is present with other dates or hours and the note's own dates and hours still equal the link's, proposing the event's exact new dates and hours (passing Section 12's rules, first date after the town's today); and `remove` when the key is absent, the link's end date is the town's today or later, the note's first date is after today, the calendar holds fewer than 2,000 events, and the refresh kept at least one source-stated UID of the generation it replaced when that generation had any. A note edited off its link's dates SHALL get no suggestion. It SHALL make no suggestion after a failed refresh. A note SHALL have at most one open follow-up, enforced by a unique partial index on `openFollowFor`; a newer change SHALL update it in place, a run that finds nothing to suggest for a note SHALL expire its open follow-up, and a change an org admin dismissed (same note, kind and target) SHALL not be suggested again. Follow-ups SHALL run whatever the weekly suggestions switch, `TOWNWISE_WEEKLY_SUGGESTIONS` and `ANTHROPIC_API_KEY` say. A follow-up failure SHALL be logged with the calendar id only and SHALL not fail the refresh.

#### Scenario: The party moves a week
- **WHEN** a link calendar's refresh finds a linked event on Sat, Dec 12 instead of Sat, Dec 5, and the note is still on Dec 5
- **THEN** one open `move` suggestion proposes the note on Dec 12, the note and the forecast for Dec 5 are unchanged, and Home's question count includes it

#### Scenario: The note was edited off its event
- **WHEN** the linked event moves but someone had changed the note's dates
- **THEN** no suggestion is made

#### Scenario: The party is canceled
- **WHEN** a Google calendar's refresh no longer lists the linked event, which was on a future date
- **THEN** one open `remove` suggestion proposes deleting the note, and nothing else changes

#### Scenario: The feed failed
- **WHEN** a refresh fails with `unreachable`
- **THEN** no suggestion is made and existing open follow-ups stay as they are

#### Scenario: A feed of UID-less events and rewritten UIDs
- **WHEN** a calendar holds events with no UID and its stated UIDs are all new after a refresh
- **THEN** the positional `event-{n}` keys are not counted as kept, and no `remove` suggestion is made from that refresh

#### Scenario: The event moves back
- **WHEN** an open `move` exists and a later refresh finds the event at the link's dates again
- **THEN** the suggestion is set `expired` and no longer listed

### Requirement: An org admin accepts or dismisses a follow-up, which hides once what it rests on is gone
Only an org admin outside view-as (staff open as admin among them, D25) SHALL accept or dismiss a `move` or `remove` through the existing accept and dismiss routes with an empty body. Both accepts SHALL compare-and-set on the note's `updatedAt` as recorded on the follow-up and answer 409 `note_changed` when it differs, leaving the suggestion open. Accepting a `move` SHALL set only the note's dates and hours, its link's dates and `updatedAt`, never write back the rest of the note, and SHALL record `note.updated` and `agent.suggestion_accepted`; a retry after its own write SHALL be accepted. Accepting a `remove` SHALL delete the note, recording `note.deleted` and `agent.suggestion_accepted`, and a note already gone SHALL be accepted without a second `note.deleted`. GET `.../agent` SHALL treat as expired, neither listing nor counting, a follow-up whose note or calendar is gone, with no hook on the paths that remove them; accepting one SHALL answer 404 and set it `expired`. A removed calendar's notes and links SHALL stay, and a file imported again SHALL be a new calendar whose events are not linked to the old notes. The cards SHALL read from the note's kind and dates only ("The private event on Sat, Dec 5 is no longer on your calendar."), never a title, and so SHALL the Calendar's linked-note line ("Made from a calendar event"). Follow-ups SHALL show in P25's panel, in a "Your calendar changed" section, and in Home's question count, and nowhere on the Calendar.

#### Scenario: Accepting the move
- **WHEN** an org admin accepts the `move` to Dec 12
- **THEN** the note covers Dec 12 with its kind, guests and detail unchanged, its link records Dec 12, the forecast read books or adds guests on Dec 12 and not Dec 5, and the audit log records `note.updated` and `agent.suggestion_accepted`

#### Scenario: Someone edited the guest count first
- **WHEN** a member changed the note's guest count after the `move` was made, and an org admin then accepts it
- **THEN** the API answers 409 `note_changed` and the note is unchanged

#### Scenario: A member
- **WHEN** a member posts accept on a `remove`
- **THEN** the API answers 403 and the note stays

#### Scenario: The Google calendar was disconnected
- **WHEN** a `remove` is open and its Google calendar's access ends (its person leaves the organization), and an org admin then accepts it
- **THEN** the panel no longer lists it, the accept answers 404, the suggestion is `expired` and the note stays
