Two phases (owner decision, 2026-11-12): phase 1 builds the server side on `origin/develop` now; phase 2 (groups 7 and 8.1) waits for the Calendar page and business-rules work (P27, D29 to D32, spec 10.16) to land on `develop`, because the client panel and every `docs/portal/spec.md` edit build on it.

## 0. Before starting

- [x] 0.1 Branch `feat/owner-calendar` from `origin/develop` in `.worktrees/owner-calendar` (the calendar work is not on `develop` yet, so phase 2 waits for it; remove the worktree after merge)
- [x] 0.2 Run `npm run verify` on the fresh branch and record the baseline: all green on c045649 (API 1,701 tests, client 2,872, web export, expo-doctor)

## 1. Server ICS parser

- [x] 1.1 Port the parser from the main checkout's uncommitted `client/src/portal/calendar/ics.ts` (and its tests under `client/test/portal/calendar/`) to `api/src/calendar/ics.ts` and `api/test/calendar-ics.test.ts`, same rules and limits, using the town's today instead of the device's; the client copy is removed in phase 2 (7.1)
- [x] 1.2 Drop DESCRIPTION, LOCATION, ATTENDEE and ORGANIZER from the parsed event and cut titles at 200 characters; add a test that a parsed event has none of them

## 2. Stores

- [x] 2.1 Add `tw_calendar_sources` and `tw_calendar_events` stores taking an `OrgScope`, with indexes registered for `ensureIndexes`; extend `test/indexes.test.ts`
- [x] 2.2 Implement replace-by-generation (write new generation, switch source, delete old) and removal (events, then source); integration test the crash-between-steps case from the calendar-subscription spec
- [x] 2.3 Enforce 5 calendars per location (`calendar_limit`) and 2,000 events per calendar; integration tests
- [x] 2.4 Delete both collections in `handlers/deletion.ts` for a location and an organization; extend the deletion integration test

## 3. Address encryption and guarded fetch

- [x] 3.1 Add `TOWNWISE_CALENDAR_KEY` to `config.ts` (optional, 32 bytes base64) and `main.ts`; add `api/src/calendar/secret.ts` (AES-256-GCM seal and open, `key_mismatch` on failure); unit tests including a wrong key
- [x] 3.2 Add `api/src/calendar/fetch.ts`: `node:https`, checking `lookup`, pinned address, port 443, `webcal:` to `https:`, manual redirects (3, re-checked), 10 s timeout, 1 MB cap, failure codes; unit tests for every blocked range (IPv4, IPv6, IPv4-mapped), a host resolving to `169.254.169.254`, a redirect to `127.0.0.1`, `http:`, user info in the URL, a timeout and an oversize body (local test server, no network)

## 4. Routes

- [x] 4.1 Add `'2mb'` to the `bodyLimit` union (used by the calendar create route only, room for a 1 MB file's JSON escaping; the handler holds the file itself to 1 MB), then the five `org.owner_calendars.*` entries to `TOWNWISE_ROUTES` (member, `openAsAdmin`, refresh limiter one per calendar per 5 minutes, 12 link adds per account an hour) and their handlers; the list never returns an address
- [x] 4.2 Audit events `townwise.owner_calendar_added|removed|refreshed` with the allowlisted fields only (`api/src/audit.ts`); the route integration tests assert the exact audit fields
- [x] 4.3 Integration tests: add file, add link (against a local HTTPS test server), not a calendar, blocked address, no key (503), cross-tenant 404, view-as write refused, events range read and `bad_range`, refresh limit 429
- [x] 4.4 Extend `test/isolation.test.ts` for the new stores and routes

## 5. Refresh loop

- [x] 5.1 Add the cross-tenant due-calendar claim to `stores/cross-tenant.ts` and a refresh scope in `access/policy.ts`; update the isolation test's import allowlist
- [x] 5.2 Add `api/src/calendar/refresher.ts` shaped like `createFileWorker` (deps in, start, drain): 15 minute tick, lease claim, fetch, parse, replace, 6 hour next refresh, backoff on failure, counts-only logs; wire it in `main.ts` only when the key is set, drained at shutdown
- [x] 5.3 Integration tests: two refreshers claim a due calendar once; failure keeps events and sets status; success replaces events

## 6. TownwiseAI

- [x] 6.1 Add `chat/tools/owner-calendar.ts` (`get_owner_calendar`), append it to the registry, add the prompt line; update `test/chat-tools.test.ts` for the appended name and the unchanged order
- [x] 6.2 Unit tests: range limits, `available: false` with no calendar, input and result views carry no title
- [x] 6.3 Extend `readableByTownwiseAi` and the item reader to `pdf` and `docx`; PDF as a `document` block in the tool result (10 MB, 100 pages), `.docx` text through the parse thread (20,000 characters); saved conversation keeps reference and counts only
- [x] 6.4 Tests: PDF and Word reads, turned-off item, `.doc` refused, PDF over the caps, saved shape holds no bytes or text

## 7. Client (phase 2: after the calendar work lands)

- [ ] 7.1 `IcsImport.web.tsx` posts the file text to the API instead of parsing it; remove `client/src/portal/calendar/ics.ts` and its client tests
- [ ] 7.2 The Calendar page reads the month's stored events from the API on web and native, in parallel with its existing reads
- [ ] 7.3 Add the "Your calendars" panel (list, Add a link, Import a file on web, Refresh now, Remove, statuses and failure messages), read-only under view-as
- [ ] 7.4 Your data and the composer's file line say PDF and Word items can be read by TownwiseAI
- [ ] 7.5 Client tests for the panel, the stored events, "Make a note" keeping the detail empty, and view-as; web and native projects

## 8. Docs, privacy and infra

- [ ] 8.1 (phase 2) `docs/portal/spec.md`: new D entry (owner decision, 2026-11-12), resolve the two P27 `[DECISION NEEDED]` rows in 22.4 with it, rewrite P27 "Your own calendar" and the section 17 calendar bullet, add the routes section after 10.16, add the `[CONFIRM]` defaults from the design's open questions
- [x] 8.2 `api/README.md` (endpoints, collections, env var, audit events, the `townwise:calendar-links` limit), `docs/portal/tuning-chat.md` (tool row appended, PDF and Word in `read_data_item`)
- [x] 8.3 Public privacy page (`client/app/(marketing)/privacy.tsx`): calendars kept with titles, links fetched by Townwise, PDF and Word contents and calendar titles may go to Anthropic through TownwiseAI
- [x] 8.4 `infra/terraform/production/containerapp.tf`: add `TOWNWISE_CALENDAR_KEY` to `api_secrets`; `infra/README.md`: create-the-key runbook step and the never-rotate note; run the CI Terraform checks

## 9. Verify

- [ ] 9.1 `npm run verify` passes
- [ ] 9.2 Run the API locally: import a file, add a public test `.ics` link, read the events, ask TownwiseAI about next week's bookings and save a proposed note, read a PDF from Your data (the Calendar page itself is phase 2)
- [ ] 9.3 Security review of `calendar/fetch.ts`, `calendar/secret.ts` and the new routes before the PR
