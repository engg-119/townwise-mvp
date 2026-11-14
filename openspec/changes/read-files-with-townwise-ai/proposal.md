## Why

A restaurant's files hold more than the three daily values the browser path reads: a calendar of buyouts, a sales report in a PDF, an inventory sheet, a menu, a staffing schedule. Today Townwise stores them and TownwiseAI can read only text reference items in chat, so the owner has to re-type what a file already says.

Owner request, 2026-11-12: any uploaded file should be processed by TownwiseAI and acted on proactively ("a calendar -> store the events, sales data -> store that, inventory -> parse it, then take action, e.g. update its models or make new predictions"). The owner then asked to "let the user select whether they want TownwiseAI to process it", so reading is opt-in per file and off by default, and then "build in everything", which brought ZIP files and the model update into scope.

The owner also chose that notes TownwiseAI makes from a file are saved right away, with an Undo, instead of waiting for a second press. An opt-in counts as the owner saving, which squares with the rule from issue #10 that calendar events change the forecast only through notes the owner saves. Recorded as D34 in `docs/portal/spec.md`, with its `[CONFIRM]` defaults.

## What Changes

- **Opt-in per file.** Wherever a person drops files that are stored, and on any stored file's item page (P27), they can let TownwiseAI read the file. The person who added the file or an org admin may ask, never under view-as. Off without `ANTHROPIC_API_KEY`, with `TOWNWISE_FILES_MONTHLY_BUDGET_USD` at 0, and while stored files are off. The browser-only sales path (P13) is unchanged.
- **A background reader.** A queue of its own (`api/src/files/ai-reader.ts`, `tw_files.ai`), separate from the sales import's lease, claims one asked-for file at a time and makes one call per file to Claude Opus 5.5. A PDF goes as a document, a picture as an image, text, workbooks, Word files and ZIP entries as text made in a worker thread. Input over the caps is cut and marked partial. The answer is parsed and checked again by Townwise, then saved before anything acts on it.
- **Actions on the answer.** Events become notes (at most 50 a file, duplicates skipped). Daily totals become a new upload only when the kind is sales, confidence is high and at least 95% of the days are borne out by the file's own text. A summary and facts become a reference text item TownwiseAI can read in chat. An org admin's read may start a lab calibration. Every write goes under ids chosen and saved first, so a retry finishes the work.
- **Undo in one step.** One action removes what the read made: its notes, its upload and the days it still holds, and its summary item. A calibration already started keeps running.
- **API.** Two routes in the Your data family: `POST /org/locations/:locationId/data/:ref/ai` (`org.data.ai_read`) and `DELETE` on the same path (`org.data.ai_undo`). Items gain `canAiRead`, `ai` and `fromAiRead`; notes, uploads and summary items gain a `source`; three audit events and a set of counts-only log lines.
- **Client.** The item page's TownwiseAI section, the Add a file opt-in, the upload page and onboarding opt-in, the Your data row state, a Notes label for notes TownwiseAI made, console labels and the privacy page.
- **Docs.** Spec D34 and 11A.9 (with 6.6, 6.7, 6.11, 9.2, 10.14 touched), `api/README.md` "Your data" and the endpoint rows, and the privacy page.

Not in this change: reading `.xls`, `.doc` or Numbers files; days from a picture; TownwiseAI reading files in bulk or without anyone asking; publishing a forecast (still staff's forecasts switch); a calendar kept as events (see `connect-owner-calendar`).

## Capabilities

### New Capabilities

- `townwise-ai-file-reading`: opt-in per file, who may ask, what is sent and how, caps and partial reads, outcomes, budget, and privacy of logs and audit.
- `townwise-ai-file-actions`: what a finished read does: notes, verified daily totals, the summary item, the calibration for an org admin, and retry-safety.
- `townwise-ai-file-undo`: who may undo a read, what goes, what stays, and a calibration that keeps running.

### Modified Capabilities

None. `openspec/specs/` is empty; the existing behavior lives in `docs/portal/spec.md`, which this change updates.

## Impact

- **API** (`api/src`): `files/ai-reader.ts`, `files/ai-actions.ts`, `files/extract/reader.ts` and `reader-prompt.ts`, `files/parse/ai-text-thread.ts`; `claimNextAiRead` in `stores/cross-tenant.ts` and `scopeForClaimedAiRead` in `access/policy.ts`; the `ai` subdocument and an index on `tw_files`; `source` on notes, uploads and files; two entries in `TOWNWISE_ROUTES`; audit allowlists; deletion unchanged (the `ai` data lives on the file).
- **Client** (`client/src/portal/`): item page, Add a file, upload page, onboarding, Your data row, Notes, console words, privacy page.
- **Cost and privacy**: an opted-in file reaches Anthropic whole; each read is charged to `tw_files_usage` within the shared files AI budget. File, organization and location names and ZIP entry paths are never sent; logs and audit carry ids, kinds and counts only.
- **Depends on** the data viewer work (PR #67, merged). Overlaps `connect-owner-calendar`; see design.
