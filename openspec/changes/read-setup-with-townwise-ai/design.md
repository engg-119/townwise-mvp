## Context

P31 (Ordering setup, D35) holds suppliers with their deliveries and items with their point-of-sale names. A member types them or imports the CSV template: `client/src/portal/orders/template.ts` reads the sheet (`importSheet`, 175-254), merges by item name, creates the suppliers it names, keeps a replaced item's point-of-sale names, deal size and never run out where cells are blank (`KeptField`, 94; 149-165), and lists failed rows with reasons. Nothing saves until Save (`checkDraft` in `setupDraft.ts`, 230). P31's files are read in the browser and never stored (`sheetFile.web.ts`, 6-8).

TownwiseAI already reads whole files a person opts into (D34, 11A.9): `api/src/files/ai-reader.ts` prepares the input (`prepare`, 152-200: PDF as a document, workbooks and Word as text from a worker thread, pictures without metadata), and `files/extract/model.ts` makes one structured-output call with the refusal fallback (73-110). That read is charged to `tw_files_usage` with a reservation corrected after the call (`ai-reader.ts`, 233-266; `stores/files-usage.ts`, 36-45). Only `files/extract/model.ts` and the chat may build an Anthropic client (`api/test/isolation.test.ts`, 79-81).

## Goals / Non-Goals

**Goals:**
- A member gets a filled, unsaved setup draft from what they already have, in one step, on the web.
- The content is sent once and kept nowhere: no stored file, no Your data item, no log of it.
- The suggestions go through the same merge and checks as the sheet import, so a bad suggestion can't be saved unseen.
- TownwiseAI never decides a par or never run out: those stay the owner's.

**Non-Goals:**
- The chat tool `propose_order_setup` and its card (slice 2: it reads a D36 attachment through the same reader and opens P31 with `?proposal=`).
- Reading on native, more than one file per read, `.xls`, `.doc`, Numbers or ZIP.
- Matching item sales to items; the item sales upload stays browser-only.

## Decisions

### 1. A P31 control first, not a chat tool
The result lands in the draft the page already holds, through the sheet import's merge. A chat tool would need up to 300 rows as tool input, or a stored proposal P31 reads, and a way to carry it to the page. Alternative considered: both at once. Rejected for slice 1 as twice the surface for the same outcome.

### 2. Sent once in the request, never stored
The browser posts `{ source }` (a file as base64 with its kind from the extension, or pasted text); the server prepares it, makes one call, answers and drops the bytes. Stored files (11A) would keep an invoice holding a rep's name, or an export holding staff or guest names, for 365 days for no benefit, and would break P31's rule that its files are read and never stored. It also works with stored files off. Alternative considered: store, then reuse the D34 queue. Rejected for retention and for the queue's latency.

### 3. One input helper for both readers
`prepare` moves from `ai-reader.ts` to `files/extract/input.ts` and takes bytes instead of a blob, so D34 and this read share the PDF, Office, text and picture handling and its caps. `ai-read.int.test.ts` must stay green through the move.

### 4. Structured output without par or never run out
The schema (`files/extract/setup-prompt.ts`): `kind`, `confidence`, up to 20 suppliers (name, up to 7 deliveries: delivery weekday, order-by weekday or null, order-by time or null), up to 150 items (name, supplier or null, category or null, unit or null, servings per unit or null with `servingsEstimated`, deal size or null, up to 10 point-of-sale names with servings per sale, a short note), and `itemsCut`. Par and never run out are not in it, so the model cannot set them. The prompt treats the content as data, never instructions; leaves out food, fees, deposits and freight; estimates servings only for standard containers (a half-barrel about 124 pints, a 750 ml bottle about 17 pours), marked; and leaves out a person's or group's name. The server checks the answer again entry by entry (the reader's pattern and `redacted()` from `reader-prompt.ts`), drops email addresses and phone numbers, dedupes items by normalized name and deliveries by weekday, and marks each item `inFile` when its name appears in the content's text (null for a picture).

### 5. The request holds the content and the setup's names only
To reuse the saved spelling, the request includes the saved suppliers' and items' names. It never includes point-of-sale names (as `get_order_setup` leaves them out), the organization or location name, the file name, or an email.

### 6. One shared merge on the client
`importSheet` splits into its header mapping and `readRow`, and a shared `mergeRows` that creates suppliers, replaces by name with kept fields, and applies the limits and duplicate checks. The new `importProposal(read, draft)` turns the answer into the same rows with the same parsers. For a new item, a blank category, unit, servings, par or supplier stays blank, so `checkDraft` marks it at Save. A replaced item keeps its own values for every blank (`KeptField` gains servings per unit, category, unit and supplier), and always keeps its par and never run out. Proposed deliveries fill a supplier only when it has none.

### 7. The files AI budget, reserve then correct
Charged to `tw_files_usage` within `TOWNWISE_FILES_MONTHLY_BUDGET_USD`, shared with D34 reads and the AI column step: reserve the call's ceiling (the reader's ceiling generalized: words at a token per three characters, a PDF at 3,000 tokens a page, a picture at 5,000, all output tokens, at the fallback chain's highest list prices), then correct to the call's cost (`messageCostMicroUsd`). The spike measured $0.06 to $0.44 a read (a 150-row order guide $0.34, a 20-page PDF $0.44, a picture $0.06; Decision 8), so $5 covers about 12 reads of a full list a month, or about 80 invoice photos. Off (no key, or the budget at 0): 503 `ai_unavailable` and `canReadWithAi: false`. Spent: 409 `files_ai_budget_exhausted`.

### 8. Route, body and limits
`org.orders.setup.read`, `POST .../orders/setup/read`, `member`, `openAsAdmin: true` (staff opened as admin, audited as superadmin with the grant), refused under view-as by the chain (403 `view_as_read_only`). An `'8mb'` body limit allowed on this route only and pinned by `assertRouteTable`, as the 1 MB `PUT` is. The `ai_reads` limiter (30 an hour, denies while Redis is down). Caps: 5 MB a file, 30 PDF pages, a picture up to 3.75 MB and 8,000 px, 100,000 characters of text (a cut is said). 150 seconds from the request's start, `max_tokens` 20,000, `maxRetries: 1`, low effort, 150 items, set by the spike in task 1 (2026-11-15, six calls on synthetic input). At low effort a 150-row order guide took 99.6 seconds, 8,542 input and 15,193 output tokens and $0.34; a 20-page price list (140 items) 94.0 seconds, 39,793 and 14,100 tokens and $0.44; a one-page invoice photo 14.3 seconds, 4,932 and 1,983 tokens and $0.06. Medium effort took 8 to 12 seconds and 7 to 15% more output on each for no better answer, so low stays. About 100 output tokens an item put a full 150-item answer at about 15,000, so 20,000 leaves about 30% headroom, and at about 150 tokens a second a full answer ends about 50 seconds inside the limit (less after a workbook or Word file's wait for the parse thread). A read costs about $0.06 to $0.44, so the shared $5 covers about 12 reads of a full list or about 80 invoice photos. A byte gate (`createByteGate`) caps bytes in flight per replica (503 `extract_busy` with `retryAfterSeconds`).

### 9. Counts-only logs and audit
`townwise.setup_read { locationId, inputKind, fileKind, confidence, suppliers, items, estimated, notInFile, itemsCut, partial, costMicroUsd, durationMs }`, `townwise.setup_read_failed { locationId, inputKind, code, errType, status }`, and the audit action `order.setup_read { locationId, inputKind, outcome, suppliers, items }`. Never a name, a point-of-sale name, a note or the text.

## Risks / Trade-offs

- [A register export read this way sends item names and quantities to Anthropic, unlike the item sales upload] → The section says so before Read, the privacy page gets its own paragraph, and D41 states the difference from D35.
- [Prompt injection in an invoice or email] → The answer can only fill an unsaved draft, through the same parsers and limits; the prompt treats the content as data; nothing is saved or sent without the person pressing Save.
- [A long order guide takes longer than the ingress allows (about 240 s)] → The spike measures latency at 150 items; the 150-second limit and `itemsCut` keep the answer inside it, and a cut is said.
- [Names a person typed into a register's item names] → The prompt leaves them out, the server drops email addresses and phone numbers, and the logs never carry names.
- [The shared $5 budget runs out with D34 reads] → A spent budget answers 409 with copy that says so; raising the budget is one setting.

## Migration Plan

No data migration and no new environment variable. The section appears only while `canReadWithAi` is true, so it ships dark without `ANTHROPIC_API_KEY` or with the budget at 0. Rollback is the release before it; nothing is stored to clean up.

## Open Questions

- Settled by the spike (task 1): low effort, 20,000 output tokens, 150 items, 150 seconds (Decision 8).
- Whether `DropArea` (`client/src/portal/onboarding/HistoryStepDrop.web.tsx`) can be reused outside onboarding, or P31 gets its own drop target.
