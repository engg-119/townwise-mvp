## Why

Ordering setup (P31, D35) is the slowest step before Orders work: a member types each supplier, its delivery days and every item, or fills the CSV template by hand. The information is usually already in something they have: a supplier's invoice or order guide, a price list, the register's product mix or menu export, a photo of a delivery schedule, an email from a rep.

Owner request, 2026-11-15, while looking at P31: "shouldn't the ordering setup support just throwing any data into an agent that extracts the information?" They then asked to "add these". Recorded as D41 in `docs/portal/spec.md`, with its `[CONFIRM]` defaults.

## What Changes

- **Read with TownwiseAI on P31 (web).** A section beside the sheet import where a member drops or chooses one file (PDF, Excel `.xlsx`, Word `.docx`, CSV or text, or a picture) or pastes text, then presses Read. Native shows no control, only a line that it is on the web.
- **Sent once, never stored.** The browser sends the content in one request. The API makes one call to Claude Opus 5.5 with structured output, answers, and keeps nothing: no stored file, no Your data item, no blob. The file name never leaves the browser; a picture loses its metadata first.
- **Suggestions into the unsaved draft.** The answer is suppliers (with delivery and order-by days when the content gives them) and items (name, supplier, category, unit, servings per unit, deal size, point-of-sale names). It merges into the same draft as the sheet import, by item name, through one shared merge, so nothing saves until Save and `checkDraft` still guards it. TownwiseAI never proposes a par or never run out. Estimated servings and names not found in the content are marked on their fields.
- **API.** `POST /org/locations/:locationId/orders/setup/read` (`org.orders.setup.read`, member, staff opened as admin, refused under view-as), an 8 MB body on that route only, the `ai_reads` limiter, the files AI budget (`tw_files_usage`) with the reader's reserve-then-correct charge. `GET .../orders/setup` gains `canReadWithAi`. A new audit action `order.setup_read` and counts-only log lines.
- **Privacy.** The privacy page gains "Files and text you give TownwiseAI for ordering". A register export read this way sends item names and quantities to Anthropic; the item sales upload stays browser-only, as D35 promises.
- **Docs.** Spec D41, 10.17, P31, 11A.9 (shared budget), the privacy rule, `api/README.md` Ordering and its tables, `client/MODULE.md`.

Not in this change: the chat tool `propose_order_setup` and its card (slice 2), reading `.xls`, `.doc`, Numbers or ZIP files, more than one file per read, reading on native, and storing what was read.

## Capabilities

### New Capabilities

- `order-setup-read`: who may read, what is sent and what is never kept, accepted input and caps, what is proposed and never proposed, how suggestions merge into the unsaved draft, budget, errors, and privacy of logs and audit.

### Modified Capabilities

None. The ordering setup's behavior lives in `docs/portal/spec.md` (P31, 10.17) and the open change `complete-bar-ordering`, which this change leaves as they are apart from the new section.

## Impact

- **API** (`api/src`): `files/extract/input.ts` (the reader's input preparation, moved out of `files/ai-reader.ts` so both use it), `files/extract/setup-prompt.ts` and `setup-reader.ts`, a model factory in `files/extract/model.ts`, a handler in `handlers/orders.ts` or a sibling, one entry in `TOWNWISE_ROUTES` with an `'8mb'` body limit pinned to it, the audit allowlist, `canReadWithAi` on the setup read. No new collection, no new environment variable.
- **Client** (`client/src/portal/orders/`): `template.ts` split into a shared `mergeRows` used by the sheet import and the new `importProposal`, `SetupRead.web.tsx`, field marks in `SetupEditor.tsx` and `SetupRows.tsx`, `api.ts`, and the privacy page.
- **Cost**: each read is charged to the organization's files AI budget (`TOWNWISE_FILES_MONTHLY_BUDGET_USD`, shared with D34 reads and the AI column step); the spike measured $0.06 to $0.44 a read (a 150-row order guide $0.34, a 20-page PDF $0.44, a picture $0.06), so the default $5 covers about 12 reads of a full list a month, or about 80 invoice photos.
- **Depends on** nothing unreleased: it works with stored files on or off, and needs only `ANTHROPIC_API_KEY`.
