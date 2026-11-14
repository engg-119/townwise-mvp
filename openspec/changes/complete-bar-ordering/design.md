## Context

PR #68 (mcardin4, `feat/inventory-management`) brings the reorder research (`reorder/`, Python, `docs/REORDER_SPEC.md`) and a product slice: `api/src/orders/board.ts` (types, a labeled sample, `withPreferences`), `stores/orders.ts` (decisions, rules, cards), six routes, four chat tools, an Orders page, order cards in TownwiseAI and Home links. The live board is a stub (`liveBoard(): null`), so the product slice cannot run. The review of #68 (blockers B1 to B5, should-fix S1 to S7, nits N1 to N6) is the checklist this change closes. Recon notes: the engine math is in `reorder/reorder/engine.py`, `forecast_adapter.py` and `mockup_logic.py`; the product has no item-level sales anywhere; the only guest forecast is a published run read through `ctx.ports.forecasts.window` (31 days at most per call, none for most locations); the browser already reads CSV (`client/src/portal/upload/csv.ts`) and Excel (`client/src/portal/viewer/xlsx.ts`, `readWorkbook`).

Constraints: no multi-document transactions (DocumentDB), compare-and-set for concurrent edits, `OrgScope` on every tenant store, view-as read-only, logs and audit details carry ids and counts only, the system prompt is static, the tool registry is append-only once on `develop` (these tools are not on `develop` yet, so their names and inputs can still change), everything pinned, no em dashes in copy.

## Goals / Non-Goals

**Goals:**
- An owner can set up ordering in one sitting: suppliers and schedule, items (typed or from a sheet), item sales from a point-of-sale export, and a count.
- The Orders page shows a live next order per supplier, computed by a faithful TypeScript port of the Python engine's core, with every deviation written down.
- Every write in #68 works end to end and is tested: saving a line, rules, cards.
- TownwiseAI can answer "what should I order, why, what did we sell, what is set up" from tools.
- Home links to Orders with live status.
- #68's review blockers and should-fix items are closed; `npm run verify` and the API integration tests pass.

**Non-Goals:**
- Price and substitute suggestions, NH purchasing rules, late-order recovery, storage trims, shelf-life caps, keg slots, supplier minimums, deliveries received, a running stock estimate between counts, sending or exporting an order, bottle service, recipes beyond "servings per sale", the backtest in the product.
- Listing item sales, setup or counts in Your data (Your data gets a one-line pointer to Orders setup instead).
- Regrouping the top bar (own change on `develop` after #70).
- Changing the Python engine.

## Decisions

### 1. Work on #68's branch, as merge commits
Commits go on `feat/inventory-management` in the scratch worktree, merged from `develop` (never rebased; force-push is blocked). The PR then holds her commits plus ours. Alternative, a second PR stacked on hers: rejected, because her PR cannot merge alone (B1 to B5) and two PRs double the review.

### 2. One order per supplier
`OrderBoard` becomes `{ available: true, sample, missing[], orders: SupplierOrder[] }`, where `SupplierOrder = { supplier, cutoff, cutoffTime, delivery, coversThrough, deadline, lines[] }`, ordered by cutoff. Python computes a window per product; suppliers have different days and times (Sawtooth: three suppliers, cutoffs at 12:00, 14:00 and 17:00). Alternative, keep one cutoff and show only the soonest supplier: rejected, it hides the other orders. Decisions stay keyed by `{itemId, delivery}`: an item belongs to one supplier.

### 3. Three stores, each one document per location or per day
- `tw_order_setups`: one document per location, `{ suppliers[], items[], version, updatedAt }`, written by `PUT` with `expectedVersion` (compare-and-set: `findOneAndUpdate({orgId, locationId, version}, {$set, $inc})`, 409 `setup_changed` on a mismatch; the first save inserts with version 1 and a unique `{orgId, locationId}` index catches a racing insert). Suppliers: `{ id, name, deliveries: [{ deliveryWeekday, cutoffWeekday, cutoffTime }] }`. Items: `{ id, name, supplierId, category, unit, servingsPerUnit, par, dealSize | null, neverRunOut, posNames: [{ name, perSale }] }`. Ids are 24-hex strings minted by the server for new rows. Limits: 20 suppliers, 7 deliveries each, 300 items, 10 point-of-sale names per item.
- `tw_item_sales`: one document per location and business date, `{ date, items: { [itemId]: servings }, uploadedAt }`, unique `{orgId, locationId, date}`. A day that is stored counts as covered: an item absent from it sold zero that day. A day not stored is unknown (closed, or no file covered it). Alternative, one row per item and day: rejected, a board read would scan up to 70,000 rows; per day it reads at most 244.
- `tw_order_counts`: one document per location and count date, `{ date, items: { [itemId]: quantity }, updatedAt }`; a save `$set`s each item, so the latest count per item is the newest date holding it.

All three take an `OrgScope`, register before `ensureIndexes`, lead every index with `orgId`, and are removed with the location and the organization. Item sales are also removed with the location's sales data (`removeSalesData`); counts and setup are not. None holds a person's id, so person deletion has nothing to remove in them.

### 4. Item sales are matched in the browser and sent by range
The upload reads the file in the browser (CSV through `CsvReader`, Excel through `readWorkbook`), guesses the date, item and quantity columns (presets for Toast "Business Date / Menu Item / Item Qty", Square "Date / Item / Qty", and the clean daily layout), applies the 4 a.m. business-day rule when the date column carries a time, and matches each item name, trimmed and case-folded, to the setup's point-of-sale names. It sends `{ from, to, days: [{ date, items: { [itemId]: servings } }] }` where servings = quantity x `perSale`, in chunks of at most 31 days and 500 items per day (`256kb`). An org admin's chunk upserts each sent day, then deletes stored days in `[from, to]` that the chunk did not send, so a retry completes it and no gap appears mid-way; a member's chunk adds only days not already stored (Decision 8). Unmatched names are shown to the owner with "Add to an item" before sending; they never leave the browser. Alternative, parse on the server through the stored-files pipeline: rejected, it would store the raw export, whose item names can carry customer or group names.

### 5. The engine is a pure port, with written deviations
`api/src/orders/engine.ts` exports pure functions over plain inputs (setup, item-sales days, latest counts, guest forecast days, history guests, `now` in the town's zone); `board.ts` keeps the types, sample and `withPreferences`; a small `orders/live.ts` reads the stores and calls the engine. Port, from `engine.py` and `forecast_adapter.py`:
- Window per delivery row: the next cutoff (date and time, town zone) after `now`; delivery = cutoff date + ((delivery weekday - cutoff weekday) mod 7) days; window = [cutoff date, next delivery of that supplier - 1]; covers through = that next delivery.
- Daily demand = the item's weekday mean, times a guest index when a published forecast covers the day; window demand mu = the sum over the window (days with no mean skipped). Servings to purchase units: / (servingsPerUnit x (1 - loss)).
- sigma = sample standard deviation of past window errors (actual minus forecast, each forecast made as of that window's cutoff, no guest index), null under 2 windows.
- Target 0.98 for never-run-out, else by category; z from the engine's table (0.98: 2.05, 0.95: 1.65; 0.92: 1.405 and 0.88: 1.175 from its inverse normal). S = mu + z x (sigma or 0).
- Quantity: no count gives par; a count older than 7 days gives max(0, par - count); otherwise needed = max(S - count, par - count, 0), then the deal pair (floor and ceil multiples of the deal size) chosen by the engine's cost (holding 0.05, shortage 4.0; the unit price cancels, so no price is needed), with the par swap; no deal size rounds up to a whole unit. The other deal size is the alternative, or null when equal.
- Confidence: low with no count, a count over 7 days old, or no item sales; medium with a count 3 to 7 days old or under 4 weeks of covered item-sales days; else high.
- Draft backup par (`draft_backup_par`): a draft item's par is its par plus 1 when mu is more than one unit. Python's base is the par it is given, and 2 only when it is given none; every setup item has a par, so the base is always the owner's (an explicit 0 gives 1, as in Python).
- History read: the oldest past window's delivery is 182 days back, its cutoff up to 6 days before that, and its weekday means read the 56 days before the cutoff, so the board reads 244 days of item sales. The latest count is read from the last 400 days, because a count older than 7 days still sets the quantity (par less count) where no count at all orders the whole par.

Deviations from Python, each a `[CONFIRM]` in the spec: (a) the weekday mean uses the last 8 weeks of covered days, not all history (a college-town bar is seasonal); (b) the guest index is forecast guests over the location's own mean guests for that weekday in the same 8 weeks, so it scales history to the forecast (Python divides by the forecast file's own weekday mean); (c) the cutoff time is honored when picking the next order; (d) quantities are whole units; (e) a covered day counts an unsold item as zero (Python skips the day for that item); (f) with no sigma the why line says there is no cushion yet instead of printing a chance; (g) lines with a quantity of 0 stay on the board; (h) a past window's error uses only its covered days (Python's backtest has every day); (i) confidence is also low when there is no mean (Python's reads the count's age only); (j) lines are ordered never-run-out first, then by name (Python orders by value); (k) a day the published forecast marks closed expects no sales, and a booked day (a private buyout) keeps the weekday mean with no guest index [CONFIRM: a booked (private buyout) day uses the weekday mean]; (l) an item that no covered day of the 8 weeks sold has no mean, so it follows the par at low confidence, where Python would give it a mean of 0 and a target chance; (m) a deal size of 1 is no deal size (whole units already); (n) a line holds at most 999, the most an owner's edit saves, with no alternative when capped; (o) the why line says the par set the quantity when the par floor or the par swap did, asks for a count only for a count 3 or more days old, says the history is short when coverage made the line medium, and says the order covers the expected use only when what is counted plus the order reaches it. Of two delivery rows with the same cutoff day and time, the earlier delivery is the next order. Defaults (targets, loss rates by category: bottles and cans 1%, draft 12%, liquor 5%, cocktail ingredients 0%) are Sawtooth's config values, used for every location until the team says otherwise.

### 6. Rules apply to every later order of the item
A rule saved from an edit adds its change to every later order of that item until turned off; the save copy says "Add 2 cases to every order of {item}". Each rule is listed on its line with its own "Turn off" (`rules[]` replaces `rule`). The rule's text stays the owner's reason. Alternative, apply only in a named situation: rejected, Townwise cannot tell when "a football weekend" happens. Rules apply after deal rounding, as #68 does, never below 0 or above 999; a line a rule moves has no alternative (it was priced for the quantity before the rule), and its why line ends with the quantity the rules leave. A rule or an edit saved in another unit than the item's unit now is left out.

### 7. Concurrency, audit and deletion for the write side
`setCard` filters `status: {$ne: 'saved'}` and retries once on a duplicate key, as `stores/chat-proposals.ts` does, and says whether it moved the card; `addRule` retries once on a duplicate key, returns the existing rule and says whether it created it. A change card save reads the live line, then claims the card (`saving`, as `claimSave` does for notes) and stores its edit under the decision id the card holds, so two saves at once store one edit, and only the call that moves a card or creates a rule writes its event. A rule card save sends the situation its card showed and is 409 `rule_changed` when the latest edit's reason differs. Audit actions, details from fixed allowlists with no free text: `order.setup_saved` (supplierCount, itemCount), `order.item_sales_uploaded` (dayCount, itemCount, firstDate, lastDate, removedCount, keptCount), `order.item_sales_deleted`, `order.count_saved` (date, itemCount), `order.decision_saved` (itemId, delivery), `order.rule_saved`, `order.rule_turned_off`, `order.card_saved` / `order.card_dismissed`. Cards gain removal by conversation (conversation delete) and by a set of conversation ids (person deletion, from the conversations the person owned).

### 8. Who may do what
Every member edits the setup, uploads item sales and saves counts; an org admin deletes item sales. Staff opened as admin can do all of it; view-as is read-only through the chain. `[CONFIRM]`.

Item sales uploads follow the sales upload rule (D16): an org admin's, and staff opened as admin's, replaces the sent days and deletes the range's stored days it did not send; a member's inserts only the sent days not already stored (`$setOnInsert`), deletes nothing and answers the rest as `kept`. Otherwise a member could clear or zero a location's item sales with an empty upload, past the org admin-only delete. Alternative, members replace too: rejected for that reason (#68 review A1). `[CONFIRM: members add only item-sales days not already stored; org admins replace]`

### 9. TownwiseAI
Tools (appended after the existing registry, names frozen once on `develop`): `get_order_board {}` (the live board, or `{available: false, reason, missing}`; never the sample, which only the Orders page shows), `get_order_line {itemId}` (one line with mu, sigma, S, target, count and age, deal size, history weeks and the last 28 covered days of servings), `get_order_setup {}` (suppliers and days, items with unit, par, deal size, never-run-out, latest count and date, item-sales coverage; never point-of-sale names), `propose_order_change {itemId, delivery}` (a card for a live line when `delivery` is its supplier's next delivery; #68's input, kept), `propose_order_rule {itemId}`. Result views carry ids, dates and counts only. Prompt lines: read `get_order_board` first, use `get_order_setup` for what is set up or missing, never state a quantity a tool did not return, a rule applies to every later order, never say an order was placed.

### 10. Home and navigation
The Bar order card calls `GET .../orders`: with a board it shows the soonest deadline and "N items to order"; with no setup it says what is missing and links to setup. It stays hidden while Home shows onboarding (`needs`), as today. Orders stays in the flat top bar as #68 has it, marked `[CONFIRM]` in spec 15.3, until the regroup change.

### 11. Python package
Commit `reorder/uv.lock` with lower bounds at the locked versions (the `eda/` and `modeling/` pattern), add a `reorder` CI job (`uv sync --locked`, `uv run --frozen pytest -q`) beside `lab`, and label `reorder/reports/*` and the README as built from the synthetic dataset. Tests that need `data/synthetic/` keep skipping with that reason; the CI job prints the skip count.

## Risks / Trade-offs

- [The PR becomes very large for a teammate to review] → Each task is its own commit with a Conventional message; the PR comment lists what was added on top of her work and why.
- [#70 lands first and conflicts] → Merge `develop` at the end, resolve by keeping both sides, rerun verify and the integration tests.
- [Engine deviations change her numbers] → Every deviation is written above and marked `[CONFIRM]`; the spec 5g test vector (mu 14, sigma 3, 98%, 5 on hand, deal 6 gives 18, alternative 12) is a unit test.
- [A board read is heavy] → At most 244 item-sales days, the counts of the last 400 days, the edits for deliveries from today on, one setup and one forecast window per request. The weekday means read one array per item, so 20 suppliers with 7 deliveries and 300 items compute in about 30 ms.
- [Owners map point-of-sale names wrongly] → The upload shows matched and unmatched counts per item before sending; the setup page shows each item's sales coverage.
- [No count means par orders] → The board says so per line and the count form is one click from it.

## Migration Plan

New collections only; nothing existing changes shape outside #68. Rollback is reverting the merge. Indexes build at boot.

## Open Questions

- Team sign-off on the `[CONFIRM]` defaults (targets, loss rates, 8 weeks, confidence thresholds, rule scope, who may edit, Orders in the top bar).
- P30, P31 and D35 assume the numbering in #70 and the two open changes; renumber at merge if needed.
