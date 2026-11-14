## 1. S1: API core (committed)

- [x] 1.1 `ai` subdocument on `tw_files`, claim index `{ 'ai.status': 1, 'ai.requestedAt': 1 }`, `claimNextAiRead` in `stores/cross-tenant.ts`, `scopeForClaimedAiRead` in `access/policy.ts`; isolation test updated
- [x] 1.2 `files/ai-reader.ts` (5 second tick, 90 second lease renewed every 30, attempts as claim token, three attempts) wired in `main.ts`
- [x] 1.3 Model input: PDF document block, picture image block, text from the worker thread (`files/parse/ai-text-thread.ts`), ZIP entries behind the archive guards, caps and `partial`
- [x] 1.4 `files/extract/reader.ts` and `reader-prompt.ts`: Opus 5.5, structured output, fallbacks, the answer checked again, saved before acting
- [x] 1.5 `org.data.ai_read` route, item fields `canAiRead` and `ai`, audit `file.ai_read_requested`, budget in `tw_files_usage`
- [x] 1.6 Tests: `test/ai-read.int.test.ts` (no names in the request, skips, budget, retry without a second call)

## 2. S2: API actions and undo (committed)

- [x] 2.1 `files/ai-actions.ts` via the `onRead` seam: plan saved first by compare-and-set, notes with `source`, duplicate and cap rules
- [x] 2.2 Verified daily totals at 95% with the reasons, upload with `source`, org admin replaces and member adds (superseded by 7.1: AI days only add, for everyone)
- [x] 2.3 Summary item (`addedVia: 'townwise_ai'`) and the calibration for an org admin with its statuses
- [x] 2.4 `org.data.ai_undo` route, `calibrationKept`, `fromAiRead`, audit `file.ai_read` and `file.ai_undone`
- [x] 2.5 Docs: spec D34 and 11A.9, `api/README.md` Your data and endpoint rows; D34 numbered after D33 (a881677)

## 3. S3a: client, files not shared with other work

- [ ] 3.1 Item page TownwiseAI section: status, summary and facts, what it made, Let TownwiseAI read this file, Undo (in progress)
- [ ] 3.2 Add a file opt-in on Your data, with one line that the whole file goes to Anthropic's Claude and a privacy link
- [ ] 3.3 API client types for `canAiRead`, `ai`, `fromAiRead`; console labels for the new audit events and log words
- [ ] 3.4 Client tests (web and native projects) for the section, the opt-in, view-as and the unavailable states

## 4. S3b: client, after session 64's PR lands

- [x] 4.1 Upload page and onboarding history step opt-in (P13 has no stored-files path, so only onboarding's drop gains it, asking once the sales read is done; P13 is pinned never to offer it)
- [x] 4.2 Your data row state (reading, done, undone, failed reasons): the Status cell's TownwiseAI words; the reasons stay on the item page
- [x] 4.3 Notes label for a note TownwiseAI made from a file
- [x] 4.4 Privacy page: the opt-in, the whole file going to Anthropic, no names sent
- [x] 4.5 Client tests for each

## 5. Reviews

- [x] 5.1 Correctness review of `ai-reader.ts`, `ai-actions.ts` and undo (retry, lease, claim token)
- [x] 5.2 Security review: prompt injection bounds, names kept out of the request, logs and audit, cross-tenant 404, ZIP guards
- [x] 5.3 Fix every finding, with a test for each (section 7; an audit event lost on a crash between a write and its record is a documented known limit, not fixed)

## 6. Verify and ship

- [ ] 6.1 `npm run verify` passes
- [ ] 6.2 Real-app QA with synthetic files only (a calendar, a sales PDF, an inventory sheet, a ZIP, a picture): opt in, see the notes and days, Undo, ask again; never a real customer file
- [ ] 6.3 Resolve nothing marked `[CONFIRM]` without the team; list them in the PR
- [ ] 6.4 Open the PR into `develop`

## 7. F: API fixes from the reviews

- [x] 7.1 AI days add-only for everyone: a stored day never replaced, no null over a figure, existing days skipped and counted (`daysAlreadyHad`), no upload when none remain (`already_had_days`); undo removes exactly the days added
- [x] 7.2 Per-row verification: a day's figures on a line carrying that date alone; comma pieces only on CSV rows; a decimal number never a guest count; tests for shifted rows, swapped figures, a header-only date, comma pieces and the crafted 304-day file (each verified before, none after)
- [x] 7.3 Streamed call with 64,000 output tokens; days capped at 1,500, newest first, `daysCut`; `max_tokens` fails `answer_too_long`, charged, not retried
- [x] 7.4 Undo whenever a plan exists (done, failed, skipped); a retry with a saved answer skips the original; backoff (`notBefore`, 1, 2, 4 minutes); a 4xx other than 408, 409, 429 fails at once; SDK `maxRetries` 1
- [x] 7.5 Budget checked before the original is read and the most a call can cost reserved by compare-and-set, corrected after; one read under a live lease per organization; 10 queued or reading per organization (429 `ai_read_queue_full`); `townwise:ai-reads` limiter that denies while Redis is down
- [x] 7.6 Deleting an original clears `ai.result`'s free text (kind and counts kept); undo nulls `ai.result`; days dropped after the actions; a staff purge removes the summary items read from purged files
- [x] 7.7 One parse-thread slot shared by the sales and AI threads; a smaller AI heap with an early stop; Word `document.xml` over 8 MiB skipped `too_large`
- [x] 7.8 The requester's seat (or staff grant) re-checked before the actions: gone, nothing written (`requester_gone`); the current role decides the calibration
- [x] 7.9 Email addresses and phone numbers redacted in titles, details, the summary and facts before saving
- [x] 7.10 The summary item named from the file as re-read; the read re-checked before each note; pictures at most 3,750,000 bytes
- [x] 7.11 Closed-note guard: no closed span over 14 days, at most 31 closed days a read (`notesSkipped.guard`) [CONFIRM: a file read can close at most 31 days, 14 in a row]
- [x] 7.12 Docs (`api/README.md`, spec 11A.9, D34, 10.8, 10.9, 10.14, 6.11, 6.13), this change, and the item page's words for the new codes; the lost-audit-event known limit recorded
