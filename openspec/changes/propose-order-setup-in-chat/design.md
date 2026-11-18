## Context

A TownwiseAI turn can already carry files attached to the person's message (D36): `turnAttachments` in `api/src/chat/attachments.ts` sends a text, PDF, Word or Excel file as its text (at most 20,000 characters) and a picture as an image, and `read_data_item` reads an attached file again in a later turn. Reading a file into the ordering setup exists on Ordering setup (D41): `POST .../orders/setup/read` runs a dedicated reader and the page merges its answer into the unsaved draft through `client/src/portal/orders/proposal.ts` and `merge.ts`. The chat has two order cards already, `propose_order_change` and `propose_order_rule`, both served by `api/src/handlers/chat-order-proposals.ts` from the stored tool call and tracked in `tw_order_cards`.

Constraints that shape the design:

- A chat call has 16,000 output tokens including thinking, and a call cut at `max_tokens` never runs its tool. A turn has 150 seconds and 8 model calls.
- A document read for chat answers `no_time` unless it starts within 75 seconds of the turn's claim, and a tool runs only after its whole input has streamed.
- `chat/*` may not import file code (`api/test/isolation.test.ts`), and that test checks direct imports only.
- A tool call's input is stored exactly as the model wrote it, before any tool runs, and is sent back with each later message. That holds for a call the check rejected too.
- `get_order_setup` keeps point-of-sale names out of chat.

## Goals / Non-Goals

**Goals:**

- A person who attaches an order guide, invoice or price list to a TownwiseAI message can get its suppliers, delivery days and items into Ordering setup's draft from the conversation.
- The server, not the prompt, decides what a card shows and what reaches the setup.
- Nothing is saved from the chat. The owner sets each par and saves on Ordering setup.
- No new route, collection, limiter or audit action.

**Non-Goals:**

- Reading a file the conversation did not attach, or pasted chat text (the prompt sends that to Ordering setup's paste box).
- Scans, old .doc and .xls files, and files past D36's limits.
- Suggesting a par, a never run out or a point-of-sale name.
- Starting from native: the composer attaches files on the web only. The card and the handoff work on native in a conversation whose file was attached on the web.

## Decisions

### 1. The chat model writes the proposal as the tool's input

The tool's input is the suggestions themselves. Rejected: a tool that takes only a ref and runs the D41 reader as a nested call. A full read is sized to 150 seconds and 20,000 tokens, the whole chat turn, and would need a charge path into `handlers/chat.ts`.

### 2. Proposals come only from an attached file whose content this turn's requests carry; the tool never reads a file

`run` has two gates: the ref is attached on the path (`tc.files.attached`), and the turn sent its content (`tc.files.sent.get(ref)`). `sent` maps a ref to `{ text, truncated }` or `{ picture: true }` and is filled where content is already handed to the model: `turnAttachments` when it pushes a document or image block, and `read_data_item` where it sets `readUntrusted`. With no entry the tool answers `{ shown: false }` and tells the model to call `read_data_item` with the ref first. That one rule covers every way a file is not read (off, deleted, a scan, a ZIP, too large, a password, busy, too much at once, not allowed): none of them ever has an entry.

Rejected: the tool re-reads through `readForModel`. The read would be refused after 75 seconds, and 60 items is about 40 seconds of output alone. Rejected: re-read only when the text is absent, which brings back the same window for a case the model fixes itself in a later turn by calling `read_data_item` first.

### 3. One check, D41's with two differences

`api/src/chat/tools/order-setup.ts` exports the tool, and its `parse` is the one check: null unless the input is an object with a ref matching `ATTACHMENT_REF`; then `setupResult(raw, null)`; items sliced to 60 with `itemsCut` true when there were more; every `posNames` emptied. The card's GET reads the stored call through the same function (`shownOrderSetup`), so the tool's counts and the card cannot disagree.

Keys are lenient, as D41's are: an unknown key is dropped, not an error. A rejected block is stored exactly like an accepted one, so strict keys would keep nothing out of the conversation; a register name can equally sit in `name` or `note`, which no schema stops; and a rejection throws away output a 150-second turn cannot repeat. The tool's `input_schema` still has no `posNames`, `par` or `neverRunOut` and sets `additionalProperties: false`.

60 items is a named constant, `ORDER_SETUP_ITEMS_MAX`. The timing spike planned to fix it (seconds from the turn's claim to the tool's run, and output tokens, for a real order guide as a PDF and as an .xlsx) was skipped, so the number is unmeasured.

### 4. The shared schema and check live outside `files/`

`setupAnswer`, `setupResult`, `nameKey`, the caps and the `Suggested*` types live in `api/src/orders/suggestions.ts`; `entries`, `isRecord`, `oneOf` and `redacted` (with the email and phone patterns) live in `api/src/model-answer.ts`. `reader-prompt.ts` and `setup-prompt.ts` re-export them, so no other importer changes. If `orders/suggestions.ts` imported from `files/`, chat code would reach file code through one hop the isolation test would not notice; `api/test/order-suggestions.test.ts` pins that it does not. Rejected: copying the redaction pattern (a privacy check that can drift), and a port on `ctx` (wiring in files another branch edits).

### 5. The card hands off to Ordering setup; nothing is saved from the chat

The card links to `/locations/{id}/orders/setup?proposal={conversationId}.{toolUseId}` (ids only). Ordering setup loads the card, merges it once into the unsaved draft, and the owner saves through `org.orders.setup.save`.

### 6. Merge semantics are D41's, unchanged

Items match by name (trimmed, lower-cased, spaces collapsed). A matched item keeps its id, par, never run out and register names; it takes the proposal's spelling of its name and the proposal's supplier, category, unit, servings and deal size where given. A new item has a blank par and never run out off. A new supplier is added with its days; an existing supplier's days change only when it has none. Nothing is removed. A second entry of one name, and anything past 300 items or 20 suppliers, is left out and listed.

New on the card: each existing item that would change, with field, old value and new value, a name's spelling included (`client/src/portal/orders/setupCard.ts`). D41 avoids spelling changes by sending saved names to its reader; in chat that depends on the model calling `get_order_setup`, so the list is the guard.

### 7. The proposal lives in the stored tool call; `tw_order_cards` holds only "set aside"

The store gains kind `setup`. There is no `save` action and no saved mark: the card computes its preview against the live setup, so once the suggestions are in the setup it says so. This removes a write the server could not verify and an `order.card_saved` on the client's word. The GET checks the file again through `ctx.items.readForModel` as the caller (the check only; nothing is read) and is 404 unless it answers `readable`. Rejected: a `save` posted by Ordering setup after its PUT, and a new collection holding proposals.

### 8. Policy is `member` on every route involved

As with saving the setup today. A member who is not an org admin gets a card only from a file they added: the content reaches the turn only through `readForModel`, which answers `not_allowed` otherwise, and the GET's check applies the same rule after a role change.

## Decisions taken for the owner

The coordinator took these on the owner's behalf on 2026-11-18. Each is a `[CONFIRM: ...]` marker in the D56 row (written in phase B) until the owner signs off.

1. `[CONFIRM: the suggestion stays in the conversation as TownwiseAI wrote it, after the file is turned off or deleted too; the card is then no longer served]`
2. `[CONFIRM: the chat tool's schema has no point-of-sale names, and the card never shows or merges one]`
3. `[CONFIRM: the card opens Ordering setup unsaved; nothing saves from chat, and the card keeps no saved mark]`
4. `[CONFIRM: any member may use it, as any member saves the setup today]`
5. `[CONFIRM: 60 items a card; longer lists go to Read a file with TownwiseAI on Ordering setup]` (unmeasured: the timing spike was skipped)
6. Lenient keys in `parse` (D41's rule: unknown keys dropped), as Decision 3 argues.
7. `[CONFIRM: charged to the TownwiseAI month, not the files AI budget]`
8. `[CONFIRM: only from a file attached to the conversation whose content the turn sent, as D36 sends it]`

## Security and privacy

- **Access.** The turn is `member` with the `chat` limiter. Card GET and POST are `member`, author only through `ownerOf`, with `openAsAdmin`. Under view-as every non-GET is 403 before the handler. The save is `org.orders.setup.save`, unchanged.
- **Tenant isolation.** Every store call takes the caller's `OrgScope`. Another organization's ids answer 404. No `cross-tenant.ts` import and no new 401.
- **Logging.** No new log line and no new audit action. Views and audit details hold ids, counts and booleans. The handoff URL holds two ids.
- **What the server can promise.** Nothing new goes to Anthropic in the proposing turn; the file's content already went under D36. The tool call's input is stored as the model wrote it and goes back with each later message, so the server cannot promise the conversation holds no par, register name or email. It can promise what the card shows and what reaches the setup: emails and formatted phone numbers replaced, never a par, never run out or register name. The stored call stays until the conversation is deleted, also after the file is gone (sign-off 1).
- **Prompt injection.** The tool writes nothing, and every turn that reaches a card has `readUntrusted` set. A hostile page or file could steer supplier, category, unit, servings or deal size. The guards are the field-by-field list of changes on the card, the `readWeb` line, Ordering setup's own checks and the owner's save. Ids and links are never built from model text.

## Risks

- A long proposal can still hit `max_tokens` or the 150-second turn; nothing is shown and the turn is charged. The 60 cap is unmeasured.
- A later turn costs one more model call, because the file must be read again first.
- The chat model has no structured output. `setupResult` drops malformed entries and names not in the text are marked; a picture's names carry no mark, and the card says so.
- Chat reads less than Ordering setup: 20,000 characters against 100,000, a PDF as its text only, no scans.
- A new tool changes the frozen tool list: the prompt cache and stored thinking blocks reset at release.

## As built

### Phase A (2026-11-18, branch `feat/chat-order-setup`)

Built: Decision 4's move, the tool object with its check, run and views (not registered), the `setup` card kind with its GET and dismiss-only POST, and the client's pure preview with the card's two calls.

- `SentFile` and `SentFiles` are declared in `order-setup.ts` for now, and `run` reads `tc.files.sent` as optional: with no `sent` at all it answers as for a file not read. Phase B moves the type to `registry.ts` as a required `TurnFiles.sent` and fills it.
- The name check in `run` runs `setupResult` again over the checked input with the text sent. It is idempotent, and it keeps one definition of "written in the text".
- The tool's result carries `notInFile` as name keys and `namesChecked`; the GET lays `inFile` over the checked input from them.
- A dismiss of a card whose file is gone is 404 like its GET: one `loadShown` serves both.
- The integration tests seed stored calls, as `orders.int.test.ts` does for the other kinds. The turn-driven tests wait for phase B.
- `proposalSummary` takes a `CutWording` (cap, limit, rest); the default is D41's sentence, and `setupCard.ts` exports the chat's as `CHAT_CUT`.
- The preview keeps the leads of its two lists (`changesLead`, `problemsLead`) apart from its prose `lines`, so the card can place each list under its own lead.

### Phase B (2026-11-18, same branch)

Built: the turn's `sent` and the registry append, the prompt rule, the card in the chat, the handoff on Ordering setup, the docs and the privacy wording.

- `TurnFiles.sent` is a required `Map<string, SentFile>` in `registry.ts`. Eight test builders gained it, not seven: `api/test/chat.test.ts` builds a context that runs `read_data_item` too.
- The prompt holds no digits (a rule of `api/test/chat.test.ts`), so it says "at most sixty items".
- `OrderProposalCard.tsx` still makes the card's one GET, for every kind, and hands a `setup` card to `OrderSetupCard.tsx`; the client's `fetchSetupProposal` is used by Ordering setup alone.
- `SetupProposal.tsx` reads `?proposal=` itself and takes two counters from the editor (`loads`, `saves`), so `SetupEditor.tsx` gained four small edits. After a save it renders nothing and calls `router.setParams({ proposal: undefined })`.
- The card shows no actions under view-as and once the suggestions are in the setup. A setup that fails to load says so and offers nothing.
- The privacy wording shipped unapproved, in its own commit, with a `[CONFIRM]` marker on D56. The page's date line was left alone.
- Not done: the timing spike (0.3) and the independent UI review (6.3).

### Rebased onto `resumable-chat-turns` (2026-11-18)

That change landed on `develop` while phase B was built, and the branch was rebased onto it. The one conflict in code was `api/src/handlers/chat.ts`, where the turn's `files` gained `sent: new Map(attached?.sent)` again inside the detached run. `'propose_order_setup'` joined `DISPLAY_TOOLS` in `api/src/chat/turn.ts`. The three lines in `client/src/chat/useTuningChat.ts` and the tool list in `api/test/chat.int.test.ts` merged cleanly.

### After the reviews (2026-11-18)

- Code review. "Not now" on a card that stopped being served (404) now says the suggestions aren't available any more and drops the actions. On Ordering setup the merge is kept by card, not by page: a second `?proposal=` in the same page merges and replaces the first card's summary, and a card a save went through for is never read or merged again in that page, also when its address comes back. A setup card says "Loading TownwiseAI's suggestions…" while it loads.
- Security review, M1. `redacted` (`api/src/model-answer.ts`) reads at most four times the characters it keeps (`REDACT_SCAN_FACTOR`), because the email pattern is quadratic on a long run with no "@" and a stored call is checked again on every read of its conversation. A 60,000-character note took 7.5 seconds before and is checked in well under 100 ms now. A text within the bound is redacted exactly as before, for the setup read (D41) and the file reader (D34) too; a longer one loses its tail before the patterns run. The email pattern itself is unchanged: a lookbehind that makes it linear would stop redacting the second of two addresses written back to back.
- Security review, the rest. L1: under view-as the card's GET answers counts only, decided by the coordinator (`[CONFIRM: under view-as the setup card shows counts only]`); the client shows the two counts and no action, and Ordering setup merges nothing from such an answer. L2: Ordering setup lists each changed existing item, field by field, and the web pages line, as the card did. N1: the comment on the file check says a picture's first bytes are read. M2: the privacy wording was corrected to what the code does (the conversation keeps what TownwiseAI wrote from a file; which address and number formats are replaced; what survives a deleted original). L3, N2 and N3 changed no code; D56 states N3 plainly.

