## ADDED Requirements

### Requirement: Weekly suggestions are an org admin's opt-in
An organization SHALL have `weeklySuggestions` (`{ on, at, by }` on `tw_orgs`, absent meaning off). Only an org admin, outside view-as, SHALL turn it on or off with `PATCH /api/org/weekly-suggestions { on }` (2 KB body, the `writes` limiter), which records `org.weekly_suggestions_changed`. P25's Questions panel SHALL show the switch to org admins with "Each Monday TownwiseAI reads the next 3 months of {Town}'s calendar with your notes and rules, and suggests notes or rules for you to accept. It sends them to Anthropic and uses this organization's TownwiseAI budget." and a link to the privacy page; members see whether it is on. Weekly suggestions SHALL run only while `TOWNWISE_WEEKLY_SUGGESTIONS` is true (default false) and `ANTHROPIC_API_KEY` is set, and SHALL not need the lab. [CONFIRM: weekly TownwiseAI suggestions are opt-in per organization and off by default]

#### Scenario: An org admin turns it on
- **WHEN** an org admin sends `{ on: true }`
- **THEN** the API answers 200, the organization's `weeklySuggestions.on` is true, and the audit log records `org.weekly_suggestions_changed`

#### Scenario: A member tries
- **WHEN** a member sends `{ on: true }`
- **THEN** the API answers 403 and nothing changes

#### Scenario: Default
- **WHEN** an organization never set it
- **THEN** no weekly pass runs for its locations

### Requirement: One bounded pass per location per week
After the weekly refresh's calibrations on a tick, the lease holder SHALL run at most one suggestions pass per location of an opted-in organization per week (recorded on the location's `tw_forecast_weeks` row), from Monday 03:00 in the town. A pass SHALL be one Claude call with no tools and at most 8,000 output tokens, sending: the next 91 days of the town's researched calendar (titles, dates, kinds and public source URLs), the location's notes and scheduled rules covering those days (kind, dates, effect, guest count and text), and the location's history effects for those calendar groups (percentages and day counts). It SHALL never send a sales figure, an email, a person's or organization's name, or an id other than calendar ids. It SHALL reserve $0.30 of the organization's TownwiseAI month before the call and correct it after, and be skipped (`budget`) when less is left. Its log lines and audit events SHALL carry ids and counts only. [CONFIRM: a weekly suggestions pass reserves $0.30 of the organization's TownwiseAI month and suggests at most 5 items]

#### Scenario: A pass
- **WHEN** it is Monday 04:00 in Hanover and the organization opted in
- **THEN** one call is made for each of its locations that has no pass this week, and the week row records the pass

#### Scenario: Budget spent
- **WHEN** the organization's TownwiseAI month has less than $0.30 left
- **THEN** no call is made and the week row records `budget`

#### Scenario: Nothing private leaves
- **WHEN** a pass runs for a location whose notes name a customer
- **THEN** the request holds that note's text as the owner wrote it, as TownwiseAI's chat already reads it, and no email, organization name, location name or sales figure

### Requirement: Suggestions are checked and never applied on their own
A pass SHALL answer at most 5 suggestions, each a note or a business rule schedule with a one-sentence why and the calendar ids it rests on. Each SHALL be checked by the note rules (spec 12) or D31's schedule rules, and refused if it fails them, duplicates an existing note or rule, or names a date before the next day in the town. Kept suggestions SHALL be stored in `tw_agent_suggestions` (organization, location, week, kind, the note or schedule fields, why, calendar ids, status `open | accepted | dismissed | expired`). They SHALL show in P25's Questions panel and count in Home's "{n} questions from TownwiseAI". A suggestion SHALL change no forecast and no page but that list until an org admin accepts it; accepting SHALL write the note or rule through the existing stores as written by that admin, with the suggestion's id as the note's or rule's id so a retried accept writes it once, and record `agent.suggestion_accepted`; dismissing SHALL record `agent.suggestion_dismissed`. A suggestion SHALL expire when its first date is today or past. Suggestions SHALL be deleted with the location and the organization.

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
