## ADDED Requirements

### Requirement: Research runs in the API, behind switches
The API SHALL run research in a leased loop in each replica (`research/runner.ts`), started in `main.ts` and stopped on shutdown, only while `TOWNWISE_RESEARCH` is true (default true), `ANTHROPIC_API_KEY` is set and `TOWNWISE_CHAT_WEB_SEARCH` is true. An organization SHALL have a `research` switch (`{ on, at, by }` on `tw_orgs`, absent meaning on) changed by an org admin through `PATCH /api/org/research { on }` (audit `org.research_switched { on }`), which staff open as admin SHALL only turn off. No run SHALL be planned or claimed for an organization whose switch is off. The hourly worker, its job and `deploy.yml` SHALL NOT change. [CONFIRM: research on by default] [CONFIRM: an organization's research switch, on by default, that staff open as admin may only turn off]

#### Scenario: Kill switch
- **WHEN** `TOWNWISE_RESEARCH=false`
- **THEN** the runner does not start, no run is planned, and the research read answers `available: false`

#### Scenario: Organization off
- **WHEN** an org admin turns research off
- **THEN** the audit log records `org.research_switched`, queued threads of that organization's locations are not claimed, and the next plan inserts none for it

#### Scenario: Staff open as admin turns it on
- **WHEN** staff with the organization open as admin send `{ on: true }`
- **THEN** the API answers 403 `open_as_admin_refused` and nothing changes

### Requirement: Runs are planned per town and per location
The planner SHALL run 60 seconds after boot and every 15 minutes, and SHALL only insert. It SHALL insert one town run per week (key `w:{Monday in the town's time zone}`, unique `(townKey, key)`) for each town of the twelve with a location in an active organization with research on, and one location run per week (unique `(orgId, locationId, key)`) for each such location. Creating a location, or setting or changing its place, SHALL insert a location run keyed `s:{placeId}` (or `s:none`) after the write, and SHALL never fail the request when the insert fails; when the town's last run started more than 7 days before, it SHALL also insert a town run with `trigger: 'early'` holding no organization, location or person. A run SHALL be inserted before its thread rows, and a plan SHALL insert the missing thread rows of any queued run. [CONFIRM: town research weekly for each of the twelve towns with a location] [CONFIRM: each location researched weekly, on its creation, and when its place is picked or changed]

#### Scenario: Two replicas plan at once
- **WHEN** two replicas plan the same week for Hanover
- **THEN** one town run exists for the key and each of its threads exists once

#### Scenario: A place is picked
- **WHEN** an org admin picks a place for a location
- **THEN** the answer is unchanged, and a location run keyed by that place id is queued

#### Scenario: A crash between run and threads
- **WHEN** a plan inserted a run and stopped before its threads
- **THEN** the next tick inserts the run's threads

### Requirement: Threads by subject
A town run SHALL have the threads `schools`, `sports`, `arts_festivals`, `civic`, `tourism_seasonal` and `markets_community`. A location run SHALL have `neighborhood` and `competitors`, plus `town_overview` when the location's town is outside the twelve; a typed town name SHALL never become a shared key. A location with no place SHALL end `neighborhood` and `competitors` as `empty` with code `no_place`. The window SHALL be today in the town's time zone to today plus 180 days. [CONFIRM: the six town threads and the two location threads] [CONFIRM: a town outside the twelve researched only by its locations' own combined thread, paid by the organization] [CONFIRM: a location with no place picked gets no restaurant or competitor research] [CONFIRM: research looks 180 days ahead]

#### Scenario: Another town
- **WHEN** a location's town is "Woodstock, VT" typed by hand
- **THEN** no town run is planned for it, and its location run has a `town_overview` thread under the organization

#### Scenario: No place
- **WHEN** a location has no place
- **THEN** its `neighborhood` and `competitors` threads end `empty` with code `no_place` and make no model call

### Requirement: Threads are leased, bounded and retried
A replica SHALL run at most 2 threads at once, alternating town and location threads, oldest `notBefore` first, and SHALL claim a location thread only while its organization has fewer than 2 live. A claim SHALL hold a 90-second lease renewed every 30 seconds, and a lost renewal SHALL abort the call. A request SHALL be limited to 150 seconds and a thread to 360 seconds. A thread SHALL be tried at most twice, waiting 10 then 60 minutes; an API refusal (a 4xx other than 408, 409 or 429) SHALL fail it at once with `request_refused`; a 4xx naming web fetch SHALL retry once without the fetch tool and stop sending it from that process. [CONFIRM: 2 research lanes per API replica, 2 live threads per organization, and a thread tried at most twice]

#### Scenario: Two runners race
- **WHEN** two replicas claim at the same moment
- **THEN** each thread is claimed by one

#### Scenario: Refused request
- **WHEN** the model API answers 400 to a gather request
- **THEN** the thread ends `failed` with `request_refused` and is not retried

#### Scenario: Web fetch not allowed
- **WHEN** the model API answers 400 naming web fetch
- **THEN** the request is sent again without the fetch tool, and later threads in that process send none

### Requirement: Each thread reserves its ceiling and settles to its cost
A thread SHALL reserve its ceiling (`research/budget.ts`: the gather's input over every iteration including search and fetch pages, its output, the extract's input and output at the most expensive model's prices, plus each allowed search's fee) before its first call, and SHALL settle to the cost of every message. Location threads SHALL reserve from the organization's TownwiseAI month and, unless started by Research now, only while $5 of it would be left. Town threads SHALL reserve from `tw_research_spend` against `TOWNWISE_RESEARCH_TOWN_MONTHLY_USD` (default 40, 0 meaning off). A refused reservation SHALL end the thread `budget`. Each heartbeat SHALL write the running spend (tokens seen, searches and fetches started) to the thread row; a graceful shutdown SHALL settle to it and requeue the thread; a stale reclaim SHALL settle to the last written spend plus 30 seconds of streaming at the ceiling rate and refund the rest. Gather SHALL stop continuing a paused message once the running spend leaves less than the extract's ceiling of the reservation. [CONFIRM: location research spends the TownwiseAI month, and automatic runs leave $5 of it] [CONFIRM: town research is system cost, at most $40 a month by default] [CONFIRM: weekly location research's share of the $20 TownwiseAI month] [CONFIRM: a dead replica's thread charged its last recorded spend plus 30 seconds of streaming]

#### Scenario: Little budget left
- **WHEN** an organization has $6 left of its month and a location thread's ceiling is $3
- **THEN** the weekly thread ends `budget`, its run ends `partial`, and Research now still runs it

#### Scenario: A replica dies mid-call
- **WHEN** a replica stops after its heartbeat wrote $0.40 spent on a $3 reservation
- **THEN** the reclaim charges $0.40 plus 30 seconds' worth, refunds the rest, and requeues the thread with its attempt counted

#### Scenario: Searches in a failed stream
- **WHEN** a gather stream throws after two searches started
- **THEN** the charge includes the two searches' fees

### Requirement: A run merges once
The lane that settles a run's last thread SHALL claim the merge by compare-and-set from `running` to `merging` with a 90-second lease, and a stale `merging` run SHALL be reclaimed. A run SHALL end `done` when every thread recorded or ended `empty`, `partial` when at least one recorded and another failed or ended `budget`, and `failed` or `budget` otherwise.

#### Scenario: Merge redone
- **WHEN** a merge stops after inserting some events and is reclaimed
- **THEN** the redone merge adds no event twice

### Requirement: Research now
`POST /api/org/locations/:locationId/research/run` SHALL be an org admin's only, never staff's open as admin, and limited by the `research` limiter (3 a day per person, denied while its store is down). It SHALL answer 202 with the run, 409 `research_running` while one is live, 409 `too_soon` within 6 hours of the location's last run, and 503 `research_off`. It SHALL queue the town run with `trigger: 'press'` only when the town's last run finished more than 24 hours before. [CONFIRM: Research now for org admins, 3 a day per person, not within 6 hours of the last run]

#### Scenario: Pressed twice
- **WHEN** an org admin presses Research now while a run is live
- **THEN** the API answers 409 `research_running`

#### Scenario: Staff open as admin
- **WHEN** staff with the organization open as admin press it
- **THEN** the API refuses it as every route without `openAsAdmin` is refused

### Requirement: Research reaches only what isolation allows
Lookups across organizations SHALL be `researchTownsInUse`, `researchLocationCandidates`, `claimNextLocationResearchThread`, `claimLocationResearchMerge` and `staleLocationResearchThreads` in `stores/cross-tenant.ts`, answering ids only, imported only by `research/runner.ts`. Only `access/policy.ts` SHALL mint the scope (`scopeForResearch`), and only `research/runner.ts` SHALL ask for it. No file under `src/research/` SHALL import notes, sales, sales days, owner calendars, chat conversations or turns, files, or orders. Town rows SHALL hold no field derived from an organization.

#### Scenario: Isolation pins
- **WHEN** a file under `src/research/` imports `stores/notes.ts`
- **THEN** `test/isolation.test.ts` fails

### Requirement: Research is deleted with its location and organization
Deleting a location, an organization, or an approval undone by person deletion SHALL remove its location runs, threads, events, entities and revisions. Town rows SHALL stay.

#### Scenario: Location deleted
- **WHEN** an org admin deletes a location
- **THEN** none of its research rows remain, and its town's rows are unchanged
