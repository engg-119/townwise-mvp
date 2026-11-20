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

**1. A separate reader queue, not the sales import's lease.** The `ai` subdocument on `tw_files` carries its own `status`, `attempts`, `leaseUntil` and `notBefore`; `claimNextAiRead` (cross-tenant, one compare-and-set) claims the oldest asked-for read past its `notBefore`, never a second read of an organization that has one under a live lease (so one organization cannot hold every replica's reader), and `scopeForClaimedAiRead` lets it write under the file's organization. An attempt that stops waits 1, 2, then 4 minutes before it may be claimed again; a 4xx from the API other than 408, 409 and 429 fails the read at once, and the SDK retries once (`maxRetries: 1`). An organization has at most 10 reads queued or reading (429 `ai_read_queue_full`), and the route has its own limiter that denies while Redis is down. *Alternative:* reuse the import lease. Rejected: a read takes minutes and would block a person's sales import, and a failed read must never fail a file that is already kept. The reader is shaped like `createFileWorker` (deps in, start, drain, nudge) so it can move to a job unchanged. Attempts double as the claim token: every write matches the count it set, so a replica that lost its lease writes nothing.

**2. The answer is saved before any action.** The checked answer is written to `ai.result` first, with which of its days the file's own text bears out (`daysBorneOut`). Actions run through an `onRead` seam inside the same claim, so a retry acts on the same answer with no second (charged) call and without reading the original again (prepare is skipped), so a retry can no longer stop on the original. An answer that is not JSON, or one cut at max_tokens (`answer_too_long`), is not retried, because it was charged. A retry that finds the outcome recorded writes nothing more.

**3. Ids are chosen first, so writes are idempotent.** There are no multi-document transactions (DocumentDB, `retryWrites=false`). The plan (one note id per event, the upload, the summary item and the calibration) is saved by compare-and-set before the first write; each later write uses its planned id and a duplicate-key answer counts as made. A step also re-checks that the read is still held. This is the "writes ordered so a retry completes them" rule in CLAUDE.md.

**4. Days are verified against the file's own text, row by row.** The model is asked to copy figures, but a day is written only if one line of the text sent (or the PDF's own text, made in a worker thread and kept in memory only) carries its date and no other date, and that same line carries each of its figures as separate numbers; at least 95% of the days must pass. A line is a CSV, workbook or Word table row, a paragraph, or a PDF line. A comma parts numbers only on a CSV row (a quoted field stays whole), and a number written with a decimal part (2100.00) is never a guest count. The review's probe showed a whole-text check passing shifted rows, swapped figures, comma pieces of one amount and a crafted file of dates plus the numbers 0 to 49 (304 of 304); the per-row rule refuses each, and `test/files/ai-verify.test.ts` pins every case. *Alternative:* trust high confidence alone. Rejected: a wrong sales day moves the forecast.

**4a. AI days only add.** For everyone, an org admin included: a day the location already has (from any upload, turned off or not) is never replaced and no null is written over a figure; those days are counted (`daysAlreadyHad`), and when every verified day is already there no upload is made (`already_had_days`). Undo then removes exactly the days the read added. *Alternative:* follow the upload route (an org admin replaces). Rejected: an AI read's replace authority came from the requester, a null could overwrite a figure, and undo deleted the replaced dates instead of restoring them.

**5. Pictures never give days.** A picture has no text to check against, so its summary, facts and events are used but its daily totals are not.

**6. PDFs go as document blocks.** The model reads layout better than our text extraction, up to 10 MiB and 600 pages. The extracted text is used only for the check in decision 4. A ZIP's PDF entries go as text, never as documents.

**7. One call per file, Claude Opus 5.5, with server-side fallbacks.** Streamed (`messages.stream(...).finalMessage()`), structured output, medium effort, the chat's `fallbacks: 'default'` for refusals, 64,000 output tokens (16,000 could not hold the old 3,660 days at about 25 tokens a day, thinking included), 300 seconds to the start of the answer. The days are capped at 1,500, the newest, with `daysCut` when the file had more; an answer cut at max_tokens fails `answer_too_long`, charged and not retried. One call keeps cost predictable (`costMicroUsd` per read) and the budget check simple. A ZIP is flattened into one combined input (20 entries, 300,000 characters) rather than one call per entry. *Alternative:* an agent loop with tools. Rejected: more calls, more cost, and it would need tool-level guards for prompt injection.

**8. Prompt injection is bounded by what the actions can do.** The prompt treats file content as data. Beyond that, the worst a hostile file can do is write this location's notes (50 a file, checked; never a closed note over 14 days, nor more than 31 closed days a read), new sales days its own text bears out row by row (never replacing one), and a summary item, all removed by one Undo. Titles, summaries and facts are told to hold no person's name; email addresses and phone numbers are replaced in code ("[email]", "[phone]") before saving, while names stay prompt-controlled. The person who asked must still belong to the organization (or, as staff, hold a live open-as-admin grant) when the actions run, else nothing is written (`requester_gone`); their role then, not at the request, decides the calibration. [CONFIRM: a file read can close at most 31 days, 14 in a row]

**9. Budget shared with the files AI budget, reserved before each call.** Each call is charged to `tw_files_usage` under `TOWNWISE_FILES_MONTHLY_BUDGET_USD`. The spend is checked before the original is downloaded or parsed; then the most the call can cost (input estimated from characters / 3, PDF pages x 3,000 or a picture's 5,000 tokens, plus all 64,000 output tokens, at the most expensive model of the fallback chain) is reserved with one `$inc` filtered on staying within the budget, so concurrent reads cannot pass it together, and corrected to the real cost after (given back whole when no answer came). A crash between the two leaves the reservation counted, so the budget errs toward refusing. `tw_chat_usage` is separate, so neither budget eats the other's.

**11. Memory: one parse thread at a time per replica.** The sales parse thread and the AI text thread share one process-wide slot (`files/parse/thread-slot.ts`), so their heaps are never held together in a 0.5 GiB replica. The AI thread has a smaller heap (128 MiB), stops making text once it has the characters it needs (a Word document's parse stops; a PDF's already did), and skips a Word document whose `document.xml` is over 8 MiB as `too_large`. A workbook is still parsed whole by its library before its text is cut, so the smaller heap is what bounds it.

**12. What a read keeps of a file goes with its original.** Deleting an original (owner, retention, staff purge) clears `ai.result`'s summary, facts, events and days, keeping its kind and counts; a staff purge also removes the summary items reads kept from the purged files. After the actions, `result.days` is dropped (its count kept); an undo sets `ai.result` to null.

**13. Undo whenever the actions began.** A read that failed or was skipped after its plan was saved may have written some of it, so undo is allowed whenever `ai.actions.plan` exists (done, failed or skipped), sweeping everything carrying the file as its source.

**10. Calibration is a lab start, not a publish.** If a read wrote a note or a day and the asker is an org admin, it starts a calibration through the lab's own checks. Refusals are recorded as statuses and never fail the read. Publishing stays behind staff's forecasts switch.

## Risks / Trade-offs

- [A whole customer file leaves Townwise] -> Opt-in per file, off by default, disclosed at the drop area and on the privacy page; no file name or location name is sent.
- [Wrong figures from a misread file] -> Verification (decision 4), 95% threshold, high confidence required, Undo.
- [A cut input hides part of a file] -> Marked `partial` and said so to the model and the person, never silent.
- [Cost] -> The shared budget, reserved before each call; the spend checked before the original is read; three attempts at most with a growing wait; a 4xx refused request failed at once; one read an organization at a time and at most 10 waiting; the route limiter.
- [Memory] -> One parse thread at a time per replica, a smaller AI heap, early stop, and the 8 MiB Word cap.

## Overlap with connect-owner-calendar

That change makes TownwiseAI read PDF and Word files in chat (D33). This change reads them for the opted-in file reader (D34). The two can share `readWordText` and `readPdfText`; whichever lands second reuses the first's helpers instead of adding its own. D33 stores calendars as events; D34 turns a calendar *file's* events into notes only. A calendar file read here does not create a stored calendar.

## Open Questions

- Approved by the owner on 2026-11-19: opt-in per file, sends the whole file to Anthropic.
- Approved by the owner on 2026-11-19: TownwiseAI writes notes and days from an opted-in file without a second press, all undoable.
- Approved by the owner on 2026-11-19: a file read may start a calibration for the org admin who asked.
- Approved by the owner on 2026-11-19: reading whole files shares the files AI budget.
- [CONFIRM: 95% of days verified]
- [CONFIRM: file caps and limits]
- [CONFIRM: a file read can close at most 31 days, 14 in a row]
- [CONFIRM: 10 reads a time per organization]

## Known limits

- `.xls`, `.doc` and Numbers files, and a ZIP with no readable entry, are skipped `kind_not_read`.
- Deleting the source file leaves what the read made (notes, upload, summary item); undo removes them while the file exists, and afterwards each is deleted on its own. Deleting only its original clears what the read kept of the file's content; a staff purge removes the summary items too.
- A scanned PDF (no text layer) is still sent and can give events and a summary, but never days: there is no text to check figures against.
- A read that fails after three attempts can leave partial writes behind; its plan stays, so Undo removes them by their source.
- An audit event is recorded after its write (as every `after` event): a crash between a write and its record loses the event while the write stays, and a retry finds the write and does not record it again.
- The queue cap is a count read before the write, so two presses at the same moment can pass it by one; two replicas claiming at the same instant could each take one read of the same organization.
- Names in a file are kept out of the answer only by the prompt; email addresses and phone numbers are also redacted in code, and a phone number written in an unusual form can slip through.
- A calibration a read started is never undone.
- Onboarding's opt-in is sent by the step itself once each file's sales read is done, so a checked file still being read when the person leaves the step is never sent; it can be let in later from its page on Your data.
