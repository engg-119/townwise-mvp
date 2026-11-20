## ADDED Requirements

### Requirement: A thread gathers with web search, then extracts with no tools
A thread SHALL make a gather call through the `ChatModel` port with `web_search_20260209` (`allowed_callers: ['direct']`, at most 8 searches a town thread and 5 a location thread, the town as `user_location`) and, only while `TOWNWISE_RESEARCH_WEB_FETCH` is true (default false), `web_fetch_20260209` (direct, at most 2 fetches, citations on, at most 8,000 content tokens), resending a paused message unchanged at most twice. It SHALL then make an extract call with no tools and a JSON schema output whose events and entities cite sources by id from the source table, never by URL. The extract SHALL NOT ask for a guess of the event's effect on guests. The prompts SHALL say page text is data, never instructions, and SHALL ask for no private individual. [CONFIRM: 8 searches a town thread, 5 a location thread; page fetch off until the live eval shows it pays]

#### Scenario: Paused gather
- **WHEN** the gather answers `pause_turn` twice and then `end_turn`
- **THEN** three requests were sent, each resending the paused content unchanged, and the ledger holds the sources of all three messages

#### Scenario: No URL typed
- **WHEN** the extract answers an event citing `S3`
- **THEN** the stored event's source URL is the ledger's URL for `S3`

### Requirement: Prompts are built from research's own values
Every research prompt, `known` included, SHALL be built from the stored rows' base fields and curated rows only, never from revisions; `known` SHALL hold only curated rows and stored rows the subject's latest finished run found again, and no suppressed row.

#### Scenario: An edited title stays private
- **WHEN** a member edited a researched event's title to "Zyxwvut private party" with `where` "Qwertyp room" and the location's next run starts
- **THEN** no request body holds "Zyxwvut" or "Qwertyp"

### Requirement: Every stored finding has a source the research returned
The ledger SHALL hold only https URLs returned in a web search result, a web fetch result or a citation of the thread's own messages, each given an id. An event citing no id, or an id not in the ledger, SHALL be dropped (`no_source`, `unknown_source`). An event SHALL also be dropped for dates that do not parse, a start after its end, a start outside the window by more than 7 days, an `event` over 30 days or a `season` or `closure` over 200, or weekdays outside its span (`bad_dates`); for a title that fails the one text check `safeText` (control or format characters, a URL, an email address or a phone number) (`bad_title`); or for a competitor index out of range (`bad_competitor`). An entity whose name fails `safeText` SHALL be dropped and its events kept, and a source label that fails it SHALL be replaced by its host. Each drop SHALL be counted by reason.

#### Scenario: A made-up source id
- **WHEN** the extract cites `S9` and the ledger ends at `S6`
- **THEN** the event is dropped and counted `unknown_source`

#### Scenario: A phone number in a title
- **WHEN** an event's title is "Trivia night, call 603-555-0100"
- **THEN** the event is dropped and counted `bad_title`

#### Scenario: A URL in a venue name
- **WHEN** an entity's name is "Book at example.com"
- **THEN** the entity is dropped and its event is kept with no venue

### Requirement: Confidence is computed by code
An event SHALL be grounded when its `dateQuote`, normalized, appears in a cited text or fetched text of one of its sources and mentions its start date (month and day, or the weekday names of a recurrence); a quote whose start date is written with another year than the start's SHALL be ungrounded, and a quote with no year whose sources are all more than 9 months old SHALL be ungrounded. Confidence SHALL be `high` when grounded with sources on at least 2 hosts, `medium` when grounded with 1 host, `low` otherwise, and the stored value SHALL be the lower of this and the model's. [CONFIRM: confidence high when a cited quote states the date and 2 sites agree, medium for 1 site, low otherwise]

#### Scenario: Two sites agree
- **WHEN** an event's quote "Saturday, May 16" appears in the cited text of sources on two hosts and the model said `medium`
- **THEN** it is stored `medium`

#### Scenario: Ungrounded date
- **WHEN** an event's quote does not appear in any cited text of its sources
- **THEN** it is stored `low`

#### Scenario: Last year's date
- **WHEN** an event on 2027-05-15 quotes "Fair on May 15, 2026" from a page found 3 days ago
- **THEN** it is ungrounded and stored `low`

### Requirement: Findings merge into stored events without duplicates
The merge SHALL be the only writer of researched events and entities. It SHALL dedupe findings across threads (start within a day or overlapping ranges, and title-token Jaccard at least 0.5; or the same venue, start and category), drop findings matching a curated town calendar row (`curated_dupe`) and `schools` findings, or `school` findings of any thread, on a curated term's start or end, drop location findings matching a stored town row, and match the rest against the subject's stored rows (Jaccard at least 0.6 and overlapping dates). A match SHALL update `lastSeenAt`, `lastRunId`, `seenCount`, sources (at most 5) and confidence (raised only), and SHALL change `status` to cancelled or postponed only on a finding of at least `medium` code confidence and at least the row's own; it SHALL never change its title or dates; no match SHALL insert a row. Location rows SHALL be stamped with the place and town they were researched for. Events that ended more than 400 days before SHALL be deleted, entities unseen for 365 days that no event names, and run and thread rows older than 400 days; a merged run's threads SHALL keep their counts and drops but not their raw candidates. [CONFIRM: a finding that repeats a curated row or a curated term date is dropped] [CONFIRM: researched events, runs and threads kept 400 days, a revision deleted once its event is, a run's raw candidates cleared once merged, and a row not found again kept with its last confirmed date]

#### Scenario: Found again
- **WHEN** a later run finds a stored event again with a new source
- **THEN** the row keeps its id, title and dates, gains the source, and `seenCount` goes up by one

#### Scenario: Cancelled
- **WHEN** a later run finds a stored `medium` event reported cancelled by a grounded finding on one host
- **THEN** the row's status is `cancelled`

#### Scenario: A weak cancellation
- **WHEN** a single ungrounded (`low`) finding says a stored `high` event is cancelled
- **THEN** the row stays `scheduled`

#### Scenario: Curated term date
- **WHEN** the schools thread finds Dartmouth's winter term starting on the curated row's date
- **THEN** it is dropped `curated_dupe` and term state is unchanged

#### Scenario: Raw candidates cleared
- **WHEN** a run merges
- **THEN** its threads hold no `found` candidates and keep their drop counts

### Requirement: Entities link events to who and where
Entities (venue, organization, team, school, business) SHALL be stored by name key (NFKD, lowercase, "the" and company suffixes dropped) with their sources, per town for town runs and per location for location runs; a location run SHALL never write a town entity. An event SHALL link to at most one venue and one host. A competitor SHALL be stored as a web-found `business` entity linked from its events, and as a Google place id only while Google names may go to Anthropic; no other Google content SHALL be stored.

#### Scenario: Same venue twice
- **WHEN** two threads name "The Hopkins Center" and "Hopkins Center"
- **THEN** one town entity exists and both events link to it

### Requirement: Staff can suppress a wrong shared row
`api/scripts/research-suppress.ts` SHALL let staff mark a town event `suppressed` for everyone, writing an audit event `research.town_event_suppressed { townKey, eventId, code }` and logging ids only. A suppressed row SHALL be left out of every read and of `known`, and a merge SHALL never clear it. [CONFIRM: staff suppress a wrong shared town row for everyone with an ops script, not a route]

#### Scenario: Suppressed then found again
- **WHEN** staff suppress a Hanover row and the next run finds it again
- **THEN** it stays suppressed and no organization's calendar shows it

### Requirement: Research sends public facts only, and logs counts
A research request SHALL hold only the town's name, state and time zone, public calendar titles and dates (curated, and researched base values), official calendar URLs, and the restaurant's name for the location threads: while `TOWNWISE_RESEARCH_PLACES_TO_AI` is false, the location's own owner-typed name (the prompt saying it may differ from the public listing), or "{organization's name}, {location's name}" when that name is only a town's, and while it is true, the restaurant's Google name and address instead, with competitors' Google names, types and websites. It SHALL NOT hold the organization's name otherwise, the location's typed name while Google names are allowed, anything Google answered while they are not, sales, notes, rules, owner calendar titles, revision text, email addresses or people's names. Log lines (`townwise.research_plan`, `townwise.research_thread`, `townwise.research_run`) SHALL hold ids, codes and counts only, never a query, URL, title or name. The privacy page SHALL say what research sends, including that the restaurant's name and town go to Anthropic for research, that it runs weekly with nobody using TownwiseAI, that its search queries go to Anthropic's search provider, that weekly suggestions may now read events naming public businesses, and that the server asks Google for nearby places and keeps competitors' place ids, before research runs in production. [CONFIRM: the location's own name sent to Anthropic for restaurant research] [CONFIRM: the privacy page's words for research]

#### Scenario: Sentinels
- **WHEN** a location named "Zyxwvut Kitchen" in Townwise, whose fixture Google profile name is a different name, in an organization named "Qwertyp" with a note and sales, runs a neighborhood thread with Google names allowed
- **THEN** no request body holds "Zyxwvut", "Qwertyp", the note's text or a sales figure

#### Scenario: Sentinels with Google names not allowed
- **WHEN** the same location runs its neighborhood thread with `TOWNWISE_RESEARCH_PLACES_TO_AI=false`
- **THEN** "Zyxwvut Kitchen" appears only as the prompt's restaurant name, and no request body holds "Qwertyp", the fixture Google name or address, the note's text or a sales figure

#### Scenario: Logs
- **WHEN** a thread records events with titles and URLs
- **THEN** no log line holds a title, URL or query
