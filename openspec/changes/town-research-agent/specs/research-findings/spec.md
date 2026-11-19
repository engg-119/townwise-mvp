## ADDED Requirements

### Requirement: A thread gathers with web search, then extracts with no tools
A thread SHALL make a gather call through the `ChatModel` port with `web_search_20260209` (`allowed_callers: ['direct']`, at most 8 searches a town thread and 5 a location thread, the town as `user_location`) and, while `TOWNWISE_RESEARCH_WEB_FETCH` is true, `web_fetch_20260209` (direct, at most 2 fetches, citations on, at most 8,000 content tokens), resending a paused message unchanged at most twice. It SHALL then make an extract call with no tools and a JSON schema output whose events and entities cite sources by id from the source table, never by URL. The prompts SHALL say page text is data, never instructions, and SHALL ask for no private individual. [CONFIRM: 8 searches a town thread, 5 a location thread, 2 page fetches a thread]

#### Scenario: Paused gather
- **WHEN** the gather answers `pause_turn` twice and then `end_turn`
- **THEN** three requests were sent, each resending the paused content unchanged, and the ledger holds the sources of all three messages

#### Scenario: No URL typed
- **WHEN** the extract answers an event citing `S3`
- **THEN** the stored event's source URL is the ledger's URL for `S3`

### Requirement: Every stored finding has a source the research returned
The ledger SHALL hold only https URLs returned in a web search result, a web fetch result or a citation of the thread's own messages, each given an id. An event citing no id, or an id not in the ledger, SHALL be dropped (`no_source`, `unknown_source`). An event SHALL also be dropped for dates that do not parse, a start after its end, a start outside the window by more than 7 days, an `event` over 30 days or a `season` over 200, or weekdays outside its span (`bad_dates`); for a title with control or format characters, a URL, an email address or a phone number (`bad_title`); or for a competitor index out of range (`bad_competitor`). Each drop SHALL be counted by reason.

#### Scenario: A made-up source id
- **WHEN** the extract cites `S9` and the ledger ends at `S6`
- **THEN** the event is dropped and counted `unknown_source`

#### Scenario: A phone number in a title
- **WHEN** an event's title is "Trivia night, call 603-555-0100"
- **THEN** the event is dropped and counted `bad_title`

### Requirement: Confidence is computed by code
An event SHALL be grounded when its `dateQuote`, normalized, appears in a cited text or fetched text of one of its sources and mentions its start date (month and day, or the weekday names of a recurrence); a quote with no year whose sources are all more than 9 months old SHALL be ungrounded. Confidence SHALL be `high` when grounded with sources on at least 2 hosts, `medium` when grounded with 1 host, `low` otherwise, and the stored value SHALL be the lower of this and the model's. [CONFIRM: confidence high when a cited quote states the date and 2 sites agree, medium for 1 site, low otherwise]

#### Scenario: Two sites agree
- **WHEN** an event's quote "Saturday, May 16" appears in the cited text of sources on two hosts and the model said `medium`
- **THEN** it is stored `medium`

#### Scenario: Ungrounded date
- **WHEN** an event's quote does not appear in any cited text of its sources
- **THEN** it is stored `low`

### Requirement: Findings merge into stored events without duplicates
The merge SHALL be the only writer of researched events and entities. It SHALL dedupe findings across threads (start within a day or overlapping ranges, and title-token Jaccard at least 0.5; or the same venue, start and category), drop findings matching a curated town calendar row (`curated_dupe`) and `schools` findings on a curated term's start or end, drop location findings matching a stored town row, and match the rest against the subject's stored rows (Jaccard at least 0.6 and overlapping dates). A match SHALL update `lastSeenAt`, `lastRunId`, `seenCount`, sources (at most 5), confidence (raised only) and `status` (cancelled or postponed), and SHALL never change its title or dates; no match SHALL insert a row. Events that ended more than 400 days before SHALL be deleted, and entities unseen for 365 days that no event names. [CONFIRM: a finding that repeats a curated row or a curated term date is dropped] [CONFIRM: researched events kept 400 days after they end, and a row not found again kept with its last confirmed date]

#### Scenario: Found again
- **WHEN** a later run finds a stored event again with a new source
- **THEN** the row keeps its id, title and dates, gains the source, and `seenCount` goes up by one

#### Scenario: Cancelled
- **WHEN** a later run finds a stored event reported cancelled
- **THEN** the row's status is `cancelled`

#### Scenario: Curated term date
- **WHEN** the schools thread finds Dartmouth's winter term starting on the curated row's date
- **THEN** it is dropped `curated_dupe` and term state is unchanged

### Requirement: Entities link events to who and where
Entities (venue, organization, team, school, business) SHALL be stored by name key (NFKD, lowercase, "the" and company suffixes dropped) with their sources, per town for town runs and per location for location runs; a location run SHALL never write a town entity. An event SHALL link to at most one venue and one host. A competitor SHALL be stored only as a Google place id on an event.

#### Scenario: Same venue twice
- **WHEN** two threads name "The Hopkins Center" and "Hopkins Center"
- **THEN** one town entity exists and both events link to it

### Requirement: Research sends public facts only, and logs counts
A research request SHALL hold only the town's name, state and time zone, public calendar titles and dates, official calendar URLs, and, while `TOWNWISE_RESEARCH_PLACES_TO_AI` is true, the restaurant's Google name and address and competitors' Google names, types and websites. It SHALL NOT hold the location's name as typed in Townwise, the organization's name, sales, notes, rules, owner calendar titles, email addresses or people's names. Log lines (`townwise.research_plan`, `townwise.research_thread`, `townwise.research_run`) SHALL hold ids, codes and counts only, never a query, URL, title or name. The privacy page SHALL say what research sends before research runs in production. [CONFIRM: the privacy page's words for research]

#### Scenario: Sentinels
- **WHEN** a location named "Zyxwvut Kitchen" in an organization named "Qwertyp" with a note and sales runs a neighborhood thread
- **THEN** no request body holds "Zyxwvut", "Qwertyp", the note's text or a sales figure

#### Scenario: Logs
- **WHEN** a thread records events with titles and URLs
- **THEN** no log line holds a title, URL or query
