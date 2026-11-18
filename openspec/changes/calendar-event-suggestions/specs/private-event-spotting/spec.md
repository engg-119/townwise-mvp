## ADDED Requirements

### Requirement: Sending owner-calendar titles is on by default, and an org admin can turn it off
An organization SHALL have `calendarTitlesToAi` (`{ on, at, by }` on `tw_orgs`, absent meaning on). Only an org admin outside view-as SHALL change it, with `PATCH /api/org/weekly-suggestions/calendar-titles { on, orgId? }` (a `TOWNWISE_ROUTES` entry, `org_admin`, body 2 KB, the `writes` limiter, open as admin with D25's tab check), which records `org.calendar_titles_ai_changed { on }` before applying; staff open as admin SHALL be able to turn it off and SHALL get 403 `open_as_admin_refused` turning it on. A person's deletion SHALL null its `by`. GET `.../agent`'s `weeklySuggestions` SHALL carry `calendarTitles`. P25 SHALL show org admins the switch with words that say titles, dates and hours of the next 3 months of the location's calendar events are sent to Anthropic each week to suggest private-event notes, and members whether it is on. The weekly pass SHALL read it again right before each location. Titles SHALL not be sent before the privacy page says so in production. [CONFIRM: owner-calendar event titles go to Anthropic in the weekly suggestions call by default (owner, 2026-11-17), and an org admin can turn it off] [CONFIRM: staff open as admin can turn the titles switch off but not on (owner, 2026-11-17)] [CONFIRM: the switch's words]

#### Scenario: An org admin turns titles off
- **WHEN** an org admin sends `{ on: false }`
- **THEN** the API answers 200, the audit log records `org.calendar_titles_ai_changed`, and the next weekly call for the organization's locations holds no owner-calendar event

#### Scenario: Staff open as admin try to turn it on
- **WHEN** staff with the organization open as admin send `{ on: true }` with the tab's `orgId`
- **THEN** the API answers 403 `open_as_admin_refused` and nothing changes

#### Scenario: Default
- **WHEN** an organization never set it and its weekly suggestions are on
- **THEN** its weekly calls include its locations' owner-calendar events

### Requirement: The weekly call sends owner-calendar titles, and nothing that identifies them
While the organization's weekly suggestions and calendar titles are both on, a location's weekly call SHALL add `ownerEvents`: its keyed events overlapping tomorrow to today plus 91 in the town, soonest first, at most 150, leaving out events already linked to a note and events with an earlier `event` suggestion in any status, leaving out a Google calendar's events unless its connection is not revoked and holds `titlesNotice: 1`, and leaving out a file's or link's events unless the calendar holds `titlesNotice: 1`. An add of a file or link SHALL store `titlesNotice` only when its body carries the literal `titlesNotice: 1`, and a Google connect SHALL store it on the connection only when its body carries it (a reconnect with it sets it; nothing clears it); the client SHALL send it only from the screen that shows the weekly sentence (`WEEKLY_TITLES_NOTICE`). Each SHALL be `{ ref, title, startDate, startWeekday, endDate, endWeekday, startTime, endTime }` with `ref` a request-local id and every email address and phone number in the title replaced before sending; the call SHALL never hold a calendar's name, kind or id, an event's `uid`, an email address or a phone number. Titles SHALL go only into this call, and no log line, audit event or stored record SHALL hold a title. The call SHALL stay one call, reserved and corrected as weekly suggestions are, with no new reservation constant. This change SHALL not change TownwiseAI chat's system prompt or tools. [CONFIRM: at most 150 owner-calendar events a weekly call, soonest first] [CONFIRM: a Google calendar connected from a screen that did not say titles go weekly sends no titles until its person connects again from one that does (owner, 2026-11-17)] [CONFIRM: a file or link calendar added from a screen that did not say titles go weekly sends no titles weekly until added again] [CONFIRM: a person's or company's name written in an event's title reaches Anthropic as written in the weekly call; only email addresses and phone numbers are removed]

#### Scenario: A booking calendar
- **WHEN** a location's link calendar holds "Private party, 40 guests, call 603-555-0100" on Sat, Dec 5 and the switches are on
- **THEN** the call's `ownerEvents` holds "Private party, 40 guests, call [removed]" with its dates and a `ref`, and no calendar name, calendar id, UID or phone number

#### Scenario: An older Google connection
- **WHEN** a Google calendar's connection was made from a screen that did not say titles go weekly (no `titlesNotice`), or is revoked
- **THEN** its events are not in `ownerEvents` until its person connects again from the explainer that says so

#### Scenario: An older link or file calendar
- **WHEN** a link or file calendar was added with no `titlesNotice` (an older app, a stale tab, or before the words shipped), whatever day it was added
- **THEN** its events are not in `ownerEvents` until it is added again, and one added with `titlesNotice: 1` is sent

#### Scenario: Titles switched off
- **WHEN** the organization's calendar titles switch is off
- **THEN** no calendar's events are sent, `titlesNotice` or not

#### Scenario: Already noted
- **WHEN** an event is linked to a note
- **THEN** it is not sent

### Requirement: No sent title reaches a stored suggestion
On a pass that sent owner events, the server SHALL drop every `note` or `rule` item of kind `private_event`, every `note` or `rule` item citing no town calendar id the request sent, and every `note` or `rule` item whose `why`, `detail` or `ruleText` holds 7 digits in a row or a word of a sent title: compared after NFKD with combining marks stripped, lowercased, with punctuation inside a word removed and one trailing s off, each pair of words side by side also joined; a title word of 3 or more characters, or a pair of title words, unless it is in a fixed list of generic event and food words (party, dinner, lunch, brunch, private, event, events, birthday, wedding, rehearsal, reception, meeting, booking, reservation, table, group, guests, celebration, holiday, buyout), a fixed list of function and date words, or a title of a town calendar entry the item cites (a pair only when both its words are). An `event` item's `why` and `detail` SHALL be dropped. [CONFIRM: on a pass that sent owner events, private-event notes and rules, notes and rules citing no town calendar entry, and items repeating a word of a sent title or holding 7 digits in a row, are dropped]

#### Scenario: A title echoed into a closure's why
- **WHEN** the request sent the sentinel title "Zyxwvut rehearsal dinner" and the model answers a closure whose why mentions "Zyxwvut"
- **THEN** the closure is dropped, and no stored suggestion and no staff view of the panel holds "Zyxwvut"

#### Scenario: A generic word
- **WHEN** a sent title is "Zyxwvut rehearsal dinner" and a closure's why says "a holiday dinner crowd"
- **THEN** the closure is kept

#### Scenario: A town event's word
- **WHEN** a sent title and the town calendar both hold "Commencement" and a closure that cites the Commencement entry names it in its why
- **THEN** the closure is kept, and one that names it without citing that entry is dropped

#### Scenario: A name however it is written
- **WHEN** the sent titles are "Ng buyout", "Johnsons 50th", "Smith-Jones rehearsal", "McDonald retirement", "Bo Kim 30" and "Rodríguez quinceañera"
- **THEN** a closure whose why is "Closed for the Ng buyout.", "Closed for Johnson.", "Closed for SmithJones.", "Closed for Mc Donald.", "Closed for Bo Kim." or "Closed for Rodriguez quinceanera." is dropped

#### Scenario: Resting on nothing
- **WHEN** the request sent owner events and a closure cites no town calendar id the request sent
- **THEN** the closure is dropped

### Requirement: A spotted private event asks whether it takes the whole restaurant
The model MAY answer up to 5 `event` items with an `eventRef`, counted apart from the pass's 5 notes and rules; the server SHALL keep one only when the ref is one the request sent and not used twice and no `private_event` or `closure` note overlaps the event's dates, SHALL take its dates and hours from the event, and SHALL keep `expectedGuests` only when the sent title states that number beside a guest word (N guests, N people, N ppl, N pax, party of N, for N). It SHALL be stored open with the event's link and no title. The card SHALL show words written by code with the title read from the live event row, never the model's words, and SHALL ask the org admin to choose "The whole restaurant (a buyout)" or "Alongside regular service", with no choice preselected and the guest count prefilled and editable. Accepting SHALL take `{ effect: 'closed' | 'more_guests', expectedGuests: integer 1 to 20,000 | null }`, answering 400 `invalid_request` for `more_guests` with no count; SHALL answer 404 and expire it when the calendar is gone, and 409 `event_changed` and expire it when the event is gone or moved, or another note now covers it (a note other than its own linked to the same event, or a private-event or closure note over its days), which also hides it from the panel and Home's count; and SHALL otherwise write, with the suggestion's id, a `private_event` note on the event's dates, its hours when Section 12 allows them, `weekdays` null, `detail` null, the chosen effect and count, and `fromEvent`, recording `agent.suggestion_accepted`. To staff under view-as or open as admin, a Google calendar's event SHALL show as "Google calendar event" on these cards, as on the Calendar. [CONFIRM: a spotted event's guest count is prefilled only from a number its title states beside a guest word, and neither choice is preselected] [CONFIRM: spotted events have their own cap of 5 a pass, apart from the pass's 5 notes and rules (owner, 2026-11-17)]

#### Scenario: Spotted
- **WHEN** the weekly call answers an `event` item for "Private party, 40 guests" with 40 guests
- **THEN** one open suggestion is stored with the event's link and 40 guests, and the card reads "From your calendar: Private party, 40 guests, Sat, Dec 5" with the two choices

#### Scenario: Already noted by hand
- **WHEN** a private-event note made without Make a note overlaps the event's dates
- **THEN** the `event` item is dropped

#### Scenario: A guessed count
- **WHEN** the model answers 60 guests for "Jones reception"
- **THEN** the suggestion is kept with no guest count

#### Scenario: Alongside with no count
- **WHEN** an org admin accepts "Alongside regular service" with no guest count
- **THEN** the API answers 400 `invalid_request` and nothing is written

#### Scenario: Accepted as a buyout
- **WHEN** an org admin chooses "The whole restaurant (a buyout)" with 40 guests and accepts
- **THEN** a buyout note for Dec 5 with 40 guests and no detail is saved and linked to the event, and the forecast read books Dec 5

#### Scenario: Staff see no Google title
- **WHEN** staff open as admin read the panel for an `event` suggestion from a Google calendar
- **THEN** its card names "Google calendar event", never the title or the calendar's name
