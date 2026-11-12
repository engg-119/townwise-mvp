## Context

Stored files (11A) are read for sales by the file reader (`files/worker.ts`, a lease per import), which sends a model nothing but redacted column profiles. TownwiseAI in chat reads only text reference items (`read_data_item`). Nothing could use what a calendar, a menu or an inventory sheet says. This change adds a second, opted-in reader that sends a whole file to Claude and acts on the checked answer. Most of it is built on branch `feat/ai-file-reader` (stacked on the data viewer, PR #67): the API (S1 and S2) is committed, with docs D34 and 11A.9; the client is in progress.

Owner decisions (2026-11-12): process uploaded files with TownwiseAI and act on them; let the user choose per file; build in everything (ZIP, calibration); notes are saved right away with Undo.

## Goals / Non-Goals

**Goals:**
- A person can let TownwiseAI read a stored file and see what it found, and what it did, on the file's page.
- What it does is bounded, checked and undoable in one step.
- A retry after a crash finishes the work without a second model call or duplicate rows.
- No name of a file, organization, location or person reaches the model, a log or an audit event.

**Non-Goals:**
- Reading a file nobody asked for, or in bulk.
- Days from a picture, or from a file that already wrote its own days.
- Publishing a forecast or undoing a started calibration.
- `.xls`, `.doc` and Numbers (no parser, no new dependency).

## Decisions

**1. A separate reader queue, not the sales import's lease.** The `ai` subdocument on `tw_files` carries its own `status`, `attempts` and `leaseUntil`; `claimNextAiRead` (cross-tenant, one compare-and-set) claims the oldest asked-for read, and `scopeForClaimedAiRead` lets it write under the file's organization. *Alternative:* reuse the import lease. Rejected: a read takes minutes and would block a person's sales import, and a failed read must never fail a file that is already kept. The reader is shaped like `createFileWorker` (deps in, start, drain, nudge) so it can move to a job unchanged. Attempts double as the claim token: every write matches the count it set, so a replica that lost its lease writes nothing.

**2. The answer is saved before any action.** The checked answer is written to `ai.result` first. Actions run through an `onRead` seam inside the same claim, so a retry acts on the same answer with no second (charged) call. An answer that is not JSON is not retried, because it was charged.

**3. Ids are chosen first, so writes are idempotent.** There are no multi-document transactions (DocumentDB, `retryWrites=false`). The plan (one note id per event, the upload, the summary item and the calibration) is saved by compare-and-set before the first write; each later write uses its planned id and a duplicate-key answer counts as made. A step also re-checks that the read is still held. This is the "writes ordered so a retry completes them" rule in CLAUDE.md.

**4. Days are verified against the file's own text.** The model is asked to copy figures, but a day is written only if its date is written in the text sent (or the PDF's own text, made in a worker thread and kept in memory only) and each figure is among the text's numbers, and at least 95% of the days pass. This makes a hallucinated sales figure unlikely to reach the forecast. *Alternative:* trust high confidence alone. Rejected: a wrong sales day moves the forecast.

**5. Pictures never give days.** A picture has no text to check against, so its summary, facts and events are used but its daily totals are not.

**6. PDFs go as document blocks.** The model reads layout better than our text extraction, up to 10 MiB and 600 pages. The extracted text is used only for the check in decision 4. A ZIP's PDF entries go as text, never as documents.

**7. One call per file, Claude Opus 5.5, with server-side fallbacks.** Structured output, medium effort, the chat's `fallbacks: 'default'` for refusals, 16,000 output tokens, 300 seconds. One call keeps cost predictable (`costMicroUsd` per read) and the budget check simple. A ZIP is flattened into one combined input (20 entries, 300,000 characters) rather than one call per entry. *Alternative:* an agent loop with tools. Rejected: more calls, more cost, and it would need tool-level guards for prompt injection.

**8. Prompt injection is bounded by what the actions can do.** The prompt treats file content as data. Beyond that, the worst a hostile file can do is write this location's notes (50 a file, checked), a verified upload and a summary item, all removed by one Undo. Titles, summaries and facts are told to hold no person's name.

**9. Budget shared with the files AI budget.** Each call is charged to `tw_files_usage` under `TOWNWISE_FILES_MONTHLY_BUDGET_USD`, checked before the call and charged after it whatever the answer. `tw_chat_usage` is separate, so neither budget eats the other's.

**10. Calibration is a lab start, not a publish.** If a read wrote a note or a day and the asker is an org admin, it starts a calibration through the lab's own checks. Refusals are recorded as statuses and never fail the read. Publishing stays behind staff's forecasts switch.

## Risks / Trade-offs

- [A whole customer file leaves Townwise] -> Opt-in per file, off by default, disclosed at the drop area and on the privacy page; no file name or location name is sent.
- [Wrong figures from a misread file] -> Verification (decision 4), 95% threshold, high confidence required, Undo.
- [A cut input hides part of a file] -> Marked `partial` and said so to the model and the person, never silent.
- [Cost] -> The shared budget, three attempts at most, a skipped read when spent.

## Overlap with connect-owner-calendar

That change makes TownwiseAI read PDF and Word files in chat (D33). This change reads them for the opted-in file reader (D34). The two can share `readWordText` and `readPdfText`; whichever lands second reuses the first's helpers instead of adding its own. D33 stores calendars as events; D34 turns a calendar *file's* events into notes only. A calendar file read here does not create a stored calendar.

## Open Questions

- [CONFIRM: opt-in per file, sends the whole file to Anthropic]
- [CONFIRM: TownwiseAI writes notes and days from an opted-in file without a second press, all undoable]
- [CONFIRM: a file read may start a calibration for the org admin who asked]
- [CONFIRM: reading whole files shares the files AI budget]
- [CONFIRM: 95% of days verified]
- [CONFIRM: file caps and limits]

## Known limits

- `.xls`, `.doc` and Numbers files, and a ZIP with no readable entry, are skipped `kind_not_read`.
- Deleting the source file leaves what the read made (notes, upload, summary item); undo removes them while the file exists, and afterwards each is deleted on its own.
- A scanned PDF (no text layer) is still sent and can give events and a summary, but never days: there is no text to check figures against.
- A read that fails after three attempts can leave partial writes behind; asking for a read again and then undoing it removes them by their source.
- A calibration a read started is never undone.
