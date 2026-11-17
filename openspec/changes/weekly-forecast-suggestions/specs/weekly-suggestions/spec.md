## ADDED Requirements

### Requirement: Weekly suggestions are on by default, and an org admin can turn them off
An organization SHALL have `weeklySuggestions` (`{ on, at, by }` on `tw_orgs`, absent meaning on). Only an org admin, outside view-as (staff open as admin among them, carrying the tab's `orgId`, D25), SHALL turn it off or on with `PATCH /api/org/weekly-suggestions { on }` (2 KB body, the `writes` limiter), which records `org.weekly_suggestions_changed`. P25's Questions panel SHALL show the switch to org admins with "Each Monday TownwiseAI reads the next 3 months of {Town}'s calendar with your notes and rules, and suggests notes or rules for you to accept. It sends them to Anthropic and uses this organization's TownwiseAI budget." and a link to the privacy page; members see whether it is on. Weekly suggestions SHALL run only while `TOWNWISE_WEEKLY_SUGGESTIONS` is true (default true, written explicitly in `api/production.env`), `ANTHROPIC_API_KEY` is set and staff have not paused the weekly worker (the console's Pause weekly refresh pauses the whole worker, weekly suggestions included), and SHALL not need the lab. The panel SHALL say they run (`available`) only when the weekly worker ran them within the last 3 hours, the switch is true and the worker is not paused. The organization's switch SHALL be read again right before each location's call. They SHALL not run in production before the privacy page says what they send. [CONFIRM: weekly TownwiseAI suggestions are on by default for every organization (owner directive, 2026-11-16: features are on by default unless the owner says otherwise), and an org admin can turn them off]

#### Scenario: An org admin turns it off
- **WHEN** an org admin sends `{ on: false }`
- **THEN** the API answers 200, the organization's `weeklySuggestions.on` is false, the audit log records `org.weekly_suggestions_changed`, and no pass runs for its locations from then on, including its locations a pass already under way has not reached

#### Scenario: Staff pause the weekly worker
- **WHEN** staff pause the weekly refresh in the console
- **THEN** no weekly suggestions call is made from the next pass until they resume it, and the panel says suggestions aren't being made

#### Scenario: A member tries
- **WHEN** a member sends `{ on: false }`
- **THEN** the API answers 403 and nothing changes

#### Scenario: Default
- **WHEN** an organization never set it
- **THEN** its locations get one weekly pass each, as if it were on

### Requirement: One bounded pass per location per week
After the weekly refresh's calibrations in a pass of the worker (`api/src/workers/weekly-forecasts.ts`), the lease holder SHALL run at most one suggestions pass per location of an organization with weekly suggestions on per week (recorded on the location's `tw_suggestion_passes` row for that week, which is inserted before the call), from Monday 03:00 in the town to the end of that week. A pass SHALL be one Claude call with no tools and at most 8,000 output tokens, sending: the next 91 days of the town's researched calendar (titles, dates, kinds and public source URLs), the location's notes and scheduled rules covering those days (kind, dates, effect, guest count and text), and the location's history effects for those calendar groups (percentages and day counts). It SHALL never send a sales figure, an email, a person's or organization's name (apart from any the team wrote in a note's detail or a rule's words, which are sent as written), or an id other than calendar ids. It SHALL reserve $0.30 of the organization's TownwiseAI month before the call, or the request's ceiling at the most expensive model's prices when that is more, and correct it after, and be skipped (`budget`) when less is left. The reservation SHALL be held on the week's pass row, so a pass that dies mid-call is settled by a later pass: a row still running a lease after it was last written SHALL become `failed` with its reservation refunded once, or be removed when it held none, so that week can still run. A call that fails before reporting anything (it costs nothing) SHALL remove its row and hand its reservation back, so a later pass that week makes the call. Its log lines and audit events SHALL carry ids and counts only. [CONFIRM: a weekly suggestions pass reserves $0.30 of the organization's TownwiseAI month and suggests at most 5 items]

#### Scenario: A pass
- **WHEN** it is Monday 04:00 in Hanover and the organization never turned weekly suggestions off
- **THEN** one call is made for each of its locations that has no pass this week, and the week's pass row records it

#### Scenario: Budget spent
- **WHEN** the organization's TownwiseAI month has less than $0.30 left
- **THEN** no call is made and the week's pass row records `budget`

#### Scenario: A pass killed mid-call
- **WHEN** the worker's job is killed while a location's call runs, leaving its pass row `running` with the reservation
- **THEN** a pass more than 10 minutes later sets the row `failed` and hands the reservation back to the organization's month, once

#### Scenario: Anthropic is down on Monday
- **WHEN** a location's call fails before the stream reports anything
- **THEN** nothing is charged, the week's pass row is removed with its reservation handed back, and the next hourly pass makes the call

#### Scenario: Nothing private leaves
- **WHEN** a pass runs for a location whose notes name a customer
- **THEN** the request holds that note's text as the owner wrote it, as TownwiseAI's chat already reads it, and no email, organization name, location name or sales figure

### Requirement: Suggestions are checked and never applied on their own
A pass SHALL answer at most 5 suggestions, each a note or a business rule schedule with a one-sentence why and the calendar ids it rests on. Each SHALL be checked by the note rules (spec 12) or D31's schedule rules, and refused if it fails them, duplicates an existing note or rule, or names a date before the next day in the town. Kept suggestions SHALL be stored in `tw_agent_suggestions` (organization, location, week, kind, the note or schedule fields, why, calendar ids, status `open | accepted | dismissed | expired`). They SHALL show in P25's Questions panel and count in Home's "{n} questions from TownwiseAI". A suggestion SHALL change no forecast and no page but that list until an org admin accepts it; accepting SHALL write the note or rule through the existing stores as written by that admin, with the suggestion's id as the note's or rule's id so a retried accept writes it once, and record `agent.suggestion_accepted`; dismissing SHALL record `agent.suggestion_dismissed`, except that a dismiss of a suggestion whose note or rule an accept already wrote (with its id) SHALL finish the accept instead. A suggestion SHALL expire when its first date is today or past. Suggestions SHALL be deleted with the location and the organization, including those a call already in flight stores after the deletion.

#### Scenario: Thanksgiving
- **WHEN** a pass finds Thanksgiving in the next 91 days and the location has no note or rule for it
- **THEN** it may suggest "Closed on Thu, Nov 26?" as a closure note with the holiday's id, which shows in the Questions panel and changes no forecast

#### Scenario: Accepted
- **WHEN** an org admin accepts the suggestion
- **THEN** a closure note is saved for Nov 26, the forecast read closes that day from then on, and the audit log records `agent.suggestion_accepted`

#### Scenario: A member
- **WHEN** a member opens the Questions panel
- **THEN** they see the suggestion and no Accept or Dismiss

#### Scenario: Refused by the note rules
- **WHEN** the model answers a suggestion whose end date is before its start date
- **THEN** it is dropped and not stored
