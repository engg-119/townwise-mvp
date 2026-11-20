## ADDED Requirements

### Requirement: Deterministic research tests run in CI
CI SHALL test research with the scripted model (gaining paused messages, web fetch results and document citations) and recorded fixtures under `api/test/fixtures/research/`, with encrypted fields stripped and no page text beyond cited quotes. The tests SHALL cover the source checks and `safeText`, grounding and confidence, the ledger across paused messages, the reservation, dedupe and merge, one live run per subject and the merge sweep, the runner's leases, retries and settling, deletion and place changes mid-run, revisions and reverts, the correction, its proposal and its Undo, the calendar's additive key, deletion, isolation, the lab golden unchanged, the competitors thread with Google names not allowed, and privacy sentinels in requests and logs. No CI test SHALL call the model API.

#### Scenario: Fixture replay
- **WHEN** the recorded Hanover sports thread is replayed
- **THEN** the stored events, their sources and drop counts equal the recorded expectation

### Requirement: An opt-in live eval scores research before shipping
`api/scripts/research-eval.ts` SHALL run only with `TOWNWISE_RESEARCH_EVAL=1` and `ANTHROPIC_API_KEY`, SHALL refuse `NODE_ENV=production`, and SHALL never run in CI. It SHALL run Hanover's six town threads with the curated rows held out of the prompt's known rows and seeds, over today to the earlier of 180 days ahead and 2028-06-11, with web fetch off and once more with it on, and one `neighborhood` and one `competitors` thread for a public Hanover place that is not a Townwise customer with `TOWNWISE_RESEARCH_PLACES_TO_AI` false (the restaurant named by its own name and town, as an owner would type it). It SHALL report recall of the curated event rows in the window with their count `n` (term rows scored apart), source validity and the rate of unknown source ids before filtering, the date-parse and grounded rates, the event and entity duplicate rates, precision on a hand-labeled sample of 30 stored events from town and location threads (an event counting when its date is confirmed on the cited page), which threads had no curated rows to score, and cost, searches, fetches, iterations and latency per thread. It SHALL also run the probes (web search with web fetch, extract over cited text, tokens per search, Places Nearby Search under the key's restriction). Its report SHALL be committed as `docs/research/eval-YYYY-MM-DD.md` before research ships to production. Ship gate: event recall at least 0.5 with `n` reported, precision at least 80% of the sample, validity 1.0, duplicates at most 10%, and at most 1 of 6 town threads empty or failed. [CONFIRM: the live eval's ship gate]

#### Scenario: Run in CI by mistake
- **WHEN** the script starts without `TOWNWISE_RESEARCH_EVAL=1`
- **THEN** it exits without a request

#### Scenario: Below the gate
- **WHEN** recall is 0.4, or precision is 70% of the sample
- **THEN** the report says the gate failed, and `TOWNWISE_RESEARCH` stays false in `api/production.env` until a later eval passes

#### Scenario: Web fetch decided
- **WHEN** the run with fetch on shows no recall or grounding gain worth its cost
- **THEN** the report says so and `TOWNWISE_RESEARCH_WEB_FETCH` stays false
