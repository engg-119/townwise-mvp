## Why

PR #68 adds an Orders page, four TownwiseAI order tools, order cards and order rules, but nothing can feed it: `liveBoard()` returns `null`, so every location sees only a labeled sample, every write answers 409 or 404, and four tool names would be frozen with no data behind them (review of #68, B5 and S1). The owner asked on 2026-11-12 to "build everything that is missing and make sure they work", to give an owner an easy way to upload what the order agent needs, to give TownwiseAI full context on orders, and to link Orders from Home. This change finishes #68 on its own branch so it can merge as one working feature.

## What Changes

- **Ordering setup (new page).** A location's suppliers with their delivery days and order-by day and time, and its items (name, supplier, unit, servings per unit, par, deal size, never-run-out, and the point-of-sale names that sell it), typed in or imported from a CSV or Excel sheet with a downloadable template. Saved as one document per location with compare-and-set.
- **Item sales upload.** An owner uploads a point-of-sale item export (CSV or Excel, one row per sale or per item per day). The browser reads it, matches item names to the setup's point-of-sale names, and sends only matched daily servings per item. Unmatched names are listed to the owner in the browser, with a way to add them to an item, and never leave the browser.
- **Counts.** A quick count form: one quantity per item, in purchase units, for a date. Latest count per item wins.
- **Live order board.** A TypeScript port of the core of `reorder/reorder/engine.py`: delivery windows from the schedule, window demand from item sales (weekday means, scaled by the location's published guest forecast where one covers the day), a safety cushion from past window errors, order-up-to level, deal rounding with the other deal as the alternative, and confidence from count age and history. **BREAKING (within #68 only):** the board becomes one order per supplier (`orders[]`, each with its own cutoff, delivery and lines) instead of one cutoff per board; nothing outside #68 reads it.
- **The write side works.** Saving a line, remembering a change as a rule, turning a rule off, and the chat order cards run against the live board, with compare-and-set on cards and rules, audit events, and deletion with conversations and people.
- **Order rules apply to every later order of the item** until turned off, each rule shown and turned off on its own (fixes review S3; the copy says so when saving).
- **TownwiseAI full context.** `get_order_board` and `get_order_line` read the live board (line math, recent item sales); a new `get_order_setup` reads suppliers, items, latest counts and item-sales coverage; `propose_order_change` shows a card for a live line. Prompt lines updated.
- **Home.** The Bar order card reads the board: the next order's deadline and how many items to order, or "Set up ordering" when there is no setup. The "Planned" copy and the unbuilt-calculation text (review S2) go.
- **Review fixes for #68.** Lint, the five client tests and `chain.int`, tests for the new collections in isolation and deletion, docs (`api/README.md`, `docs/portal/tuning-chat.md`, `docs/portal/spec.md` pages, nav 15.3 and a D entry, `client/src/portal/README.md`), the Python package's lock file and a CI job for its tests, and synthetic labels on the committed reports.

Not in this change: price and substitute suggestions (`pricing.py`), late or missed order recovery, storage trims, shelf-life caps, deliveries received and a running stock estimate, supplier minimums, sending or exporting an order, the backtest in the product, and regrouping the top bar (its own change on `develop` after #70).

## Capabilities

### New Capabilities

- `order-setup`: a location's suppliers, schedules and items; the import template; who may edit; compare-and-set; limits; deletion.
- `item-sales`: the item sales upload, browser matching, what is sent and stored, replacement of a range, coverage, deletion with sales data.
- `order-counts`: entering a count, latest-wins, age.
- `order-board`: how the live board is computed (windows, demand, cushion, quantity, deal rounding, confidence, why line), what is missing when, the sample, decisions and rules.
- `townwise-ai-orders`: the order tools, their inputs and results, the cards, and the prompt rules.

### Modified Capabilities

None. `openspec/specs/` is empty; the existing behavior lives in `docs/portal/spec.md`, which this change updates.

## Impact

- **API** (`api/src`): new stores `tw_order_setups`, `tw_item_sales`, `tw_order_counts`; `orders/engine.ts` (pure) and `orders/board.ts` reshaped; routes in `TOWNWISE_ROUTES` for setup, item sales and counts; the order write handlers, cards and rules; five order tools; prompt lines; audit allowlists; deletion for location, organization, sales data, conversations and people.
- **Client** (`client/src/portal/orders/`): Orders page per supplier, setup page (P31), item sales upload, count form; Home's Bar order card; `routing.ts` for the setup path.
- **Python** (`reorder/`): `uv.lock` committed, a CI job running its tests; no engine changes.
- **Numbering:** Orders is P30, Ordering setup P31, and the decision D35, assuming #70 lands P28, P29 and D29 to D32, the owner-calendar change keeps D33, and the AI file reader keeps D34. Renumber on merge if that changes.
- **Depends on** nothing unmerged. When #70 lands on `develop`, this branch merges `develop` again (overlaps: `routes.ts`, `prompt.ts`, `stores/index.ts`, `deletion.ts`, the isolation test, `api/README.md`, `spec.md`).
- **Privacy:** item names the owner did not map never leave the browser; stored item sales are item ids, dates and servings; logs and audit details carry ids and counts only.
