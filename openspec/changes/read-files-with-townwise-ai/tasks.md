## 1. S1: API core (committed)

- [x] 1.1 `ai` subdocument on `tw_files`, claim index `{ 'ai.status': 1, 'ai.requestedAt': 1 }`, `claimNextAiRead` in `stores/cross-tenant.ts`, `scopeForClaimedAiRead` in `access/policy.ts`; isolation test updated
- [x] 1.2 `files/ai-reader.ts` (5 second tick, 90 second lease renewed every 30, attempts as claim token, three attempts) wired in `main.ts`
- [x] 1.3 Model input: PDF document block, picture image block, text from the worker thread (`files/parse/ai-text-thread.ts`), ZIP entries behind the archive guards, caps and `partial`
- [x] 1.4 `files/extract/reader.ts` and `reader-prompt.ts`: Opus 5.5, structured output, fallbacks, the answer checked again, saved before acting
- [x] 1.5 `org.data.ai_read` route, item fields `canAiRead` and `ai`, audit `file.ai_read_requested`, budget in `tw_files_usage`
- [x] 1.6 Tests: `test/ai-read.int.test.ts` (no names in the request, skips, budget, retry without a second call)

## 2. S2: API actions and undo (committed)

- [x] 2.1 `files/ai-actions.ts` via the `onRead` seam: plan saved first by compare-and-set, notes with `source`, duplicate and cap rules
- [x] 2.2 Verified daily totals at 95% with the reasons, upload with `source`, org admin replaces and member adds
- [x] 2.3 Summary item (`addedVia: 'townwise_ai'`) and the calibration for an org admin with its statuses
- [x] 2.4 `org.data.ai_undo` route, `calibrationKept`, `fromAiRead`, audit `file.ai_read` and `file.ai_undone`
- [x] 2.5 Docs: spec D34 and 11A.9, `api/README.md` Your data and endpoint rows; D34 numbered after D33 (a881677)

## 3. S3a: client, files not shared with other work

- [ ] 3.1 Item page TownwiseAI section: status, summary and facts, what it made, Let TownwiseAI read this file, Undo (in progress)
- [ ] 3.2 Add a file opt-in on Your data, with one line that the whole file goes to Anthropic's Claude and a privacy link
- [ ] 3.3 API client types for `canAiRead`, `ai`, `fromAiRead`; console labels for the new audit events and log words
- [ ] 3.4 Client tests (web and native projects) for the section, the opt-in, view-as and the unavailable states

## 4. S3b: client, after session 64's PR lands

- [ ] 4.1 Upload page and onboarding history step opt-in
- [ ] 4.2 Your data row state (reading, done, undone, failed reasons)
- [ ] 4.3 Notes label for a note TownwiseAI made from a file
- [ ] 4.4 Privacy page: the opt-in, the whole file going to Anthropic, no names sent
- [ ] 4.5 Client tests for each

## 5. Reviews

- [ ] 5.1 Correctness review of `ai-reader.ts`, `ai-actions.ts` and undo (retry, lease, claim token)
- [ ] 5.2 Security review: prompt injection bounds, names kept out of the request, logs and audit, cross-tenant 404, ZIP guards
- [ ] 5.3 Fix every finding, with a test for each

## 6. Verify and ship

- [ ] 6.1 `npm run verify` passes
- [ ] 6.2 Real-app QA with synthetic files only (a calendar, a sales PDF, an inventory sheet, a ZIP, a picture): opt in, see the notes and days, Undo, ask again; never a real customer file
- [ ] 6.3 Resolve nothing marked `[CONFIRM]` without the team; list them in the PR
- [ ] 6.4 Open the PR into `develop`
