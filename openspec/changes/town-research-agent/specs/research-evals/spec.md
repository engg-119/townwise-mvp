## ADDED Requirements

### Requirement: Deterministic research tests run in CI
CI SHALL test research with the scripted model (gaining paused messages, web fetch results and document citations) and recorded fixtures under `api/test/fixtures/research/`, with encrypted fields stripped and no page text beyond cited quotes. The tests SHALL cover the source checks, grounding and confidence, the ledger across paused messages, the reservation, dedupe and merge, the runner's leases, retries and settling, revisions, the correction and its Undo, the calendar's additive key, deletion, isolation, the lab golden unchanged, and privacy sentinels in requests and logs. No CI test SHALL call the model API.

#### Scenario: Fixture replay
- **WHEN** the recorded Hanover sports thread is replayed
- **THEN** the stored events, their sources and drop counts equal the recorded expectation

### Requirement: An opt-in live eval scores Hanover research before shipping
`api/scripts/research-eval.ts` SHALL run only with `TOWNWISE_RESEARCH_EVAL=1` and `ANTHROPIC_API_KEY`, SHALL refuse `NODE_ENV=production`, and SHALL never run in CI. It SHALL run Hanover's six town threads with the curated rows held out of the prompt's known rows and seeds, over today to the earlier of 180 days ahead and 2028-06-11, and SHALL report recall of the curated rows in the window, source validity and the rate of unknown source ids before filtering, the date-parse and grounded rates, the event and entity duplicate rates, cost, searches, fetches, iterations and latency per thread, and a sample for hand-labeled precision. It SHALL also run the probes (web search with web fetch, extract over cited text, tokens per search, Places Nearby Search under the key's restriction). Its report SHALL be committed as `docs/research/eval-YYYY-MM-DD.md` before research ships to production. Ship gate: recall at least 0.5, validity 1.0, duplicates at most 10%, and at most 1 of 6 threads empty or failed. [CONFIRM: the live eval's ship gate]

#### Scenario: Run in CI by mistake
- **WHEN** the script starts without `TOWNWISE_RESEARCH_EVAL=1`
- **THEN** it exits without a request

#### Scenario: Below the gate
- **WHEN** recall is 0.4
- **THEN** the report says the gate failed, and `TOWNWISE_RESEARCH` stays false in `api/production.env` until a later eval passes
