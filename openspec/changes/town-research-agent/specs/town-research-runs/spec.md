## ADDED Requirements

### Requirement: Research runs in the API, behind switches
The API SHALL run research in a leased loop in each replica (`research/runner.ts`), started in `main.ts` and stopped on shutdown, only while `TOWNWISE_RESEARCH` is true (default true), `ANTHROPIC_API_KEY` is set and `TOWNWISE_CHAT_WEB_SEARCH` is true. An organization SHALL have a `research` switch (`{ on, at, by }` on `tw_orgs`, absent meaning on) changed by an org admin through `PATCH /api/org/research { on }` (body limit `2kb`, audit `org.research_switched { on }`), which staff open as admin SHALL only turn off, and which the Town tab's Research section SHALL show to org admins outside view-as. No run SHALL be planned or claimed for an organization whose switch is off. While the switch is off or `TOWNWISE_RESEARCH` is false, nothing researched SHALL be read for the organization: the calendar's `found` SHALL be `[]`, the chat tools SHALL add no researched events, and weekly suggestions SHALL send none. The hourly worker, its job and `deploy.yml` SHALL NOT change. [CONFIRM: research on by default] [CONFIRM: an organization's research switch, on by default, that staff open as admin may only turn off]

#### Scenario: Kill switch
- **WHEN** `TOWNWISE_RESEARCH=false`
- **THEN** the runner does not start, no run is planned, the research read answers `available: false`, and the calendar's `found` is `[]`

#### Scenario: Organization off
- **WHEN** an org admin turns research off on the Town tab
- **THEN** the audit log records `org.research_switched`, queued threads of that organization's locations are not claimed, the next plan inserts none for it, its calendar's `found` is `[]` although its town has stored rows, and its next weekly suggestions call sends no researched event

#### Scenario: Staff open as admin turns it on
- **WHEN** staff with the organization open as admin send `{ on: true }`
- **THEN** the API answers 403 `open_as_admin_refused` and nothing changes

### Requirement: One live run per subject
A run SHALL carry `liveSubject` (the town's key on a town run, the location's id on a location run) while it is queued, running or merging, unset when it ends, under a unique partial index. Every path that inserts a run (the planner, an early run, Research now) SHALL treat a duplicate key on it as "already running" and insert nothing.

#### Scenario: Created and planned in the same quarter hour
- **WHEN** a location is created and the planner's next tick finds no weekly run for it
- **THEN** the planner inserts no run for the location, because its early run is live and was created less than 6 days before

#### Scenario: Two presses race
- **WHEN** two org admins press Research now for one location at the same moment
- **THEN** one run is queued and the other press answers 409 `research_running`

### Requirement: Runs are planned per town and per location
The planner SHALL run 60 seconds after boot and every 15 minutes, and SHALL only insert. It SHALL insert one town run per week (key `w:{Monday in the town's time zone}`, unique `(townKey, key)`) for each town of the twelve with a location in an active organization with research on, and one location run per week (unique `(orgId, locationId, key)`) for each such location, skipping a subject whose last run was created less than 6 days before, with each weekly thread's start spread over the Monday by a hash of its subject. Only `createLocation` and `updateLocation` in `handlers/locations.ts` SHALL queue an early location run (key `s:{ObjectId}`), after the write, for an active organization with research on and not for staff with the organization open as admin, and SHALL never fail the request when the insert fails; staff setup SHALL queue none. The same path SHALL NOT insert a town run: the planner's tick inserts the town's run on its weekly key, so a town run never starts because of one organization's action. A town run SHALL record no trigger, organization, location or person. A run SHALL be inserted before its thread rows, and a plan SHALL insert the missing thread rows of any queued run. [CONFIRM: town research weekly for each of the twelve towns with a location] [CONFIRM: each location researched weekly, on its creation, and when its place is picked or changed; a run in the last 6 days counts as the week's]

#### Scenario: Two replicas plan at once
- **WHEN** two replicas plan the same week for Hanover
- **THEN** one town run exists for the key and each of its threads exists once

#### Scenario: A place is picked
- **WHEN** an org admin picks a place for a location
- **THEN** the answer is unchanged, and a location run for that place is queued

#### Scenario: Staff setup
- **WHEN** staff create a location while setting up an organization that is not yet active
- **THEN** no research run is queued

#### Scenario: A crash between run and threads
- **WHEN** a plan inserted a run and stopped before its threads
- **THEN** the next tick inserts the run's threads

### Requirement: A place or town change replaces the location's research
When `updateLocation` changes a location's place or town, it SHALL end the location's live run `off` with code `place_changed` (its open threads too, so a running lane's heartbeat misses and aborts), delete the location's research events and entities stamped with another place or town and its revisions of events that no longer apply, and then queue an early run. The researched read SHALL ignore any location row whose stamped place or town differs from the location's current one.

#### Scenario: A mis-picked place corrected
- **WHEN** an org admin changes a location's place from A to B while a run for A is running
- **THEN** that run ends `off` with `place_changed`, no event researched for A remains or shows, and a run for B is queued

#### Scenario: Back to the first place
- **WHEN** the place is changed from A to B and back to A
- **THEN** a new run for A is queued

### Requirement: Threads by subject
A town run SHALL have the threads `schools`, `sports`, `arts_festivals`, `civic`, `tourism_seasonal` and `markets_community`. A location run SHALL have `neighborhood` and `competitors`, plus `town_overview` when the location's town is outside the twelve; a typed town name SHALL never become a shared key. A location with no place SHALL end `neighborhood` and `competitors` as `empty` with code `no_place`. While `TOWNWISE_RESEARCH_PLACES_TO_AI` is false, `neighborhood` SHALL still run, naming the restaurant by the location's own owner-typed name and its town, and `competitors` SHALL run by web search. The window SHALL be today in the town's time zone to today plus 180 days. [CONFIRM: the six town threads and the two location threads] [CONFIRM: a town outside the twelve researched only by its locations' own combined thread, paid by the organization] [CONFIRM: a location with no place picked gets no restaurant or competitor research] [CONFIRM: the location's own name sent to Anthropic for restaurant research] [CONFIRM: research looks 180 days ahead]

#### Scenario: Another town
- **WHEN** a location's town is "Woodstock, VT" typed by hand
- **THEN** no town run is planned for it, and its location run has a `town_overview` thread under the organization

#### Scenario: No place
- **WHEN** a location has no place
- **THEN** its `neighborhood` and `competitors` threads end `empty` with code `no_place` and make no model call

#### Scenario: Google names not allowed
- **WHEN** `TOWNWISE_RESEARCH_PLACES_TO_AI=false` and a location with a place runs
- **THEN** `neighborhood` and `competitors` both run, their prompts naming the restaurant by the location's own name and town, with nothing Google answered

### Requirement: Threads are leased, bounded and retried
A replica SHALL run at most 2 threads at once, alternating town and location threads, oldest `notBefore` first, and SHALL claim a location thread only while its organization has none live. A claim SHALL hold a 90-second lease renewed every 30 seconds by compare-and-set on the thread's status and owner, and a missed renewal SHALL abort the call and settle the reservation to the running spend. A request SHALL be limited to 150 seconds and a thread to 360 seconds. A thread SHALL be tried at most twice, waiting 10 minutes before the second; an API refusal (a 4xx other than 408, 409 or 429) SHALL fail it at once with `request_refused`; while web fetch is on, a 4xx naming web fetch SHALL retry once without the fetch tool and stop sending it from that process. [CONFIRM: 2 research lanes per API replica, 1 live thread per organization, and a thread tried at most twice]

#### Scenario: Two runners race
- **WHEN** two replicas claim at the same moment
- **THEN** each thread is claimed by one

#### Scenario: Refused request
- **WHEN** the model API answers 400 to a gather request
- **THEN** the thread ends `failed` with `request_refused` and is not retried

### Requirement: Each thread reserves its ceiling and settles to its cost
A thread SHALL reserve its ceiling (`research/budget.ts`: the gather's input over `S + F + 1 + MAX_CONTINUATIONS` iterations including search and fetch pages with the prompt priced as a cache write, its output, the extract's input and output at the most expensive model's prices, plus each allowed search's fee) before its first call, and SHALL settle to the cost of every message. Location threads SHALL reserve from the organization's TownwiseAI month; weekly and early threads SHALL also reserve from the organization's automatic share (`TOWNWISE_RESEARCH_ORG_MONTHLY_USD`, default 6, tracked on the organization's chat-usage document) and only while $5 of the month would be left, while Research now SHALL use neither limit beyond the month. Town threads SHALL reserve from `tw_research_spend` against `TOWNWISE_RESEARCH_TOWN_MONTHLY_USD` (default 40, 0 meaning off) and against their town's slice, the cap divided by the towns in use that month. A refused reservation SHALL end the thread `budget`. Each heartbeat SHALL write the running spend (tokens seen, searches and fetches started) to the thread row; a graceful shutdown SHALL settle to it and requeue the thread; a stale reclaim SHALL settle to the last written spend plus 30 seconds of streaming at the ceiling rate and refund the rest. Gather SHALL stop continuing a paused message once the running spend leaves less than the extract's ceiling of the reservation. [CONFIRM: location research spends the TownwiseAI month; automatic runs use at most $6 of it an organization and leave $5] [CONFIRM: town research is system cost, at most $40 a month by default (about 5 towns weekly at the measured cost), split evenly between the towns in use] [CONFIRM: weekly location research's share of the $20 TownwiseAI month] [CONFIRM: a dead replica's thread charged its last recorded spend plus 30 seconds of streaming]

#### Scenario: Little budget left
- **WHEN** an organization has $6 left of its month and a location thread's ceiling is $3
- **THEN** the weekly thread ends `budget`, its run ends `partial` when another of its threads recorded or found nothing (`budget` when every thread was refused), and Research now still runs it

#### Scenario: Three locations
- **WHEN** an organization with three locations has used $5.50 of its automatic share and a weekly thread's ceiling is $2
- **THEN** that thread ends `budget`, the location's gap says so, and the organization's chat month is otherwise untouched

#### Scenario: One town's slice
- **WHEN** two towns are in use, the cap is $40, and one town's threads have spent $20 this month
- **THEN** that town's next thread ends `budget` and the other town's threads still run

#### Scenario: A replica dies mid-call
- **WHEN** a replica stops after its heartbeat wrote $0.40 spent on a $3 reservation
- **THEN** the reclaim charges $0.40 plus 30 seconds' worth, refunds the rest, and requeues the thread with its attempt counted

#### Scenario: Searches in a failed stream
- **WHEN** a gather stream throws after two searches started
- **THEN** the charge includes the two searches' fees

### Requirement: A run merges once
The lane that settles a run's last thread SHALL try to claim the merge by compare-and-set from `running` to `merging` with a 90-second lease, and every planner tick SHALL claim the merge of any `running` run whose threads are all terminal; a stale `merging` run SHALL be reclaimed. A location merge SHALL check that the location exists with the run's place and town and that the organization is active before it writes, ending the run `off` otherwise, and SHALL check again after it writes, removing the location's research rows when the location is gone. A run SHALL end `done` when every thread recorded or ended `empty`, `partial` when at least one recorded and another failed or ended `budget`, and `failed` or `budget` otherwise, and SHALL unset `liveSubject` when it ends.

#### Scenario: Merge redone
- **WHEN** a merge stops after inserting some events and is reclaimed
- **THEN** the redone merge adds no event twice

#### Scenario: Last two threads settle together
- **WHEN** two lanes settle a run's last two threads at the same moment and neither claims the merge
- **THEN** the next planner tick claims it, and the run merges exactly once

### Requirement: Research now
`POST /api/org/locations/:locationId/research/run` SHALL be an org admin's only, never staff's open as admin, and limited by the `research` limiter (3 a day per person, denied while its store is down). It SHALL re-run only the location's threads and SHALL never queue a town run. It SHALL answer 202 with the run, 409 `research_running` while one is live, 409 `too_soon` within 6 hours of the location's last run, and 503 `research_off`. [CONFIRM: Research now for org admins, the location's threads only, 3 a day per person, not within 6 hours of the last run]

#### Scenario: Pressed twice
- **WHEN** an org admin presses Research now while a run is live
- **THEN** the API answers 409 `research_running`

#### Scenario: A press never queues the town
- **WHEN** an org admin presses Research now and the town's last run finished a week ago
- **THEN** no town run is inserted

#### Scenario: Staff open as admin
- **WHEN** staff with the organization open as admin press it
- **THEN** the API refuses it as every route without `openAsAdmin` is refused

### Requirement: Research reaches only what isolation allows
Lookups across organizations SHALL be `researchTownsInUse`, `researchLocationCandidates`, `claimNextLocationResearchThread`, `claimLocationResearchMerge` and `staleLocationResearchThreads` in `stores/cross-tenant.ts`, answering ids only, imported only by `research/runner.ts` and `research/plan.ts`. Only `access/policy.ts` SHALL mint the scope (`scopeForResearch`), and only `research/plan.ts` (the location candidates it plans for and the merges its sweep claims) and `research/runner.ts` SHALL ask for it. No file under `src/research/` SHALL import notes, sales, sales days, owner calendars, chat conversations or turns, files, or orders, and only `research/read.ts` and `research/revisions.ts` SHALL import the revisions store. Town rows and town run views SHALL hold no field derived from an organization, including what started a run.

#### Scenario: Isolation pins
- **WHEN** a file under `src/research/` imports `stores/notes.ts`
- **THEN** `test/isolation.test.ts` fails

#### Scenario: Another organization's actions
- **WHEN** organization A creates a Hanover location or presses Research now
- **THEN** organization B's `GET .../research` changes in nothing but the town run's status and counts

### Requirement: Research is deleted with its location, organization and person
Deleting a location, an organization, or an approval undone by person deletion SHALL remove its location runs and threads first, then its events, entities and revisions, and location deletion SHALL sweep the events and entities again at its end. Town rows SHALL stay. Person deletion SHALL clear the person's id from every research revision and from the organization's `research.by`.

#### Scenario: Location deleted mid-thread
- **WHEN** an org admin deletes a location while its thread is running
- **THEN** the lane's heartbeat misses and aborts, no research row of the location remains after the merge would have run, and its town's rows are unchanged

#### Scenario: Person deleted
- **WHEN** a person who edited researched events is deleted
- **THEN** no research revision or organization switch holds their user id
