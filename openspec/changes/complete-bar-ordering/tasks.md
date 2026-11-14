## 0. Before starting

- [x] 0.1 Record the baseline on `feat/inventory-management` at the develop merge (47fe5f4): typecheck, lint, API unit tests, client jest; the known failures are #68 review B1 (lint), B2 (five client tests) and B3 (`chain.int`)

## 1. Review fixes that do not need the live board

- [x] 1.1 Update the five client tests for the Orders tab (`phone-ui.test.web.tsx`, `location-shell.test.native.tsx`, `shell.test.native.tsx`) and spec 15.3's nav list with `[CONFIRM: Orders in the top bar]`
- [x] 1.2 Nits: duplicate comment in `handlers/sales.ts` (N1), `DayDetail.tsx` comment (N4), `bodyLimit` doc and `client/test/helpers/routes.ts` spacing (N5)
- [x] 1.3 Python: commit `reorder/uv.lock`, lower bounds at the locked versions, a `reorder` CI job beside `lab` (`uv sync --locked`, `uv run --frozen pytest -q -rs`), and a synthetic-data label on `reorder/reports/*` and `reorder/README.md`

## 2. Stores

- [x] 2.1 `stores/order-setups.ts` (`tw_order_setups`): get, save with compare-and-set (`setup_changed`), id minting, limits; indexes; unit and integration tests including the racing first insert
- [x] 2.2 `stores/item-sales.ts` (`tw_item_sales`): upsert sent days then delete unsent days in range, read days in a range, coverage, remove for location, organization and sales data; integration tests including retry
- [x] 2.3 `stores/order-counts.ts` (`tw_order_counts`): save (`$set` per item), latest per item with date, remove for location and organization; integration tests
- [x] 2.4 `stores/orders.ts`: `setCard` never overwrites saved and retries once on a duplicate key; `addRule` returns the existing rule on a duplicate key; `removeForConversations(ids)`; integration tests for each race
- [x] 2.5 Deletion: location, organization, sales data (item sales only), conversation and person (order cards); `deletion.int.test.ts` seeds a row in all six order collections

## 3. Engine (pure, `api/src/orders/engine.ts`)

- [x] 3.1 Windows: next order-by after now in the town zone, delivery, window, covers through, per supplier; unit tests for the Sawtooth schedule, a passed cutoff today and same-weekday order-by and delivery
- [x] 3.2 Demand: weekday means over 8 weeks of covered days, guest index against the location's own weekday guests, mu in purchase units with loss rates; unit tests
- [x] 3.3 Cushion: past window errors over 26 weeks, sample standard deviation, null under 2; unit tests
- [x] 3.4 Quantity, deal pair and par swap, whole units, confidence, why line; unit tests including the spec 5g vector (18, alternative 12) and the never-counted par case
- [ ] 3.5 `board.ts`: `orders[]` per supplier, the sample in the same shape, `rules[]` per line in `withPreferences`; `orders/live.ts` reads setup, item sales, counts, the forecast window and history guests and calls the engine; unit tests for `withPreferences` with two rules

## 4. Routes and handlers

- [ ] 4.1 Routes and handlers for the setup (GET, PUT), item sales (POST upload, DELETE, GET coverage) and counts (POST), with audit actions and summaries from fixed allowlists
- [ ] 4.2 Orders handlers on the live board (`getOrders`, decisions, rules, rule off) and the change card's save in `chat-order-proposals.ts`; remove the `liveBoard()` stub
- [ ] 4.3 Integration tests: each new route, `setup_changed`, cross-tenant 404, view-as refused, member delete 403, exact audit details, and one end to end board (setup, item sales, count, then the expected quantity, edit, rule, turn off)
- [ ] 4.4 `chain.int.test.ts` (a seeded shown `propose_order_change` call and a per-route proposal id) and `isolation.int.test.ts` (snapshot, B's order rows, bodies, covers list for every order route)
- [ ] 4.5 Lint clean on every changed file (B1)

## 5. TownwiseAI

- [ ] 5.1 `chat/tools/orders.ts`: `get_order_board {}`, `get_order_line {itemId}`, new `get_order_setup {}`, `propose_order_change {itemId}` on the live board, `propose_order_rule {itemId}`; registry order; `chat-tools.test.ts`
- [ ] 5.2 Prompt lines (static, no digits); `chat.test.ts`
- [ ] 5.3 Unit tests: unavailable answers, the sample only without setup, views carry ids, dates and counts only

## 6. Client

- [ ] 6.1 `orders/api.ts`: schemas and calls for the board, setup, item sales and counts
- [ ] 6.2 Orders page: one section per supplier with its deadline, `rules[]` with their own turn-off, "Enter a count", links to setup; empty and NaN quantities blocked (N6)
- [ ] 6.3 Ordering setup page (P31, `/locations/[id]/orders/setup`, `routing.ts`): suppliers and deliveries, item table, template download, CSV and Excel import, save with `expectedVersion` and the 409 copy
- [ ] 6.4 Item sales upload on the setup page (web): column presets and guessing, business day, matching, unmatched names with "Add to an item", chunked send, coverage and per-item "No sales matched"; native says to use a computer
- [ ] 6.5 Home's Bar order card reads the board; `beside.ts` describes the real method (S2); `honesty.test.ts` covers it
- [ ] 6.6 Your data: one line pointing to Ordering setup for item sales and counts
- [ ] 6.7 TownwiseAI client: tool labels for `get_order_setup`, the change card's save on a live line
- [ ] 6.8 Client tests for the setup page, upload matching, count form, Orders per supplier and the Home card

## 7. Docs

- [ ] 7.1 `api/README.md`: every new and changed route, the three collections, deletion, audit actions
- [ ] 7.2 `docs/portal/tuning-chat.md`: the five tools, views and prompt lines
- [ ] 7.3 `docs/portal/spec.md`: P30 Orders, P31 Ordering setup, D35 with the `[CONFIRM]` defaults, 15.3, P11's Bar order
- [ ] 7.4 `client/src/portal/README.md` page rows; `reorder/README.md` points to the product port and its deviations

## 8. Verify and land

- [ ] 8.1 `npm run verify`, API integration tests, `uv run pytest` in `reorder/`
- [ ] 8.2 Browser check with `/browse` on synthetic data: setup, import, item sales upload, count, board, edit, rule, turn off, Home card
- [ ] 8.3 `/review` on the branch diff and fix what it finds
- [ ] 8.4 Merge `develop` again (after #70 if it has landed), rerun 8.1
- [ ] 8.5 Push to `feat/inventory-management` and comment on #68 with what was added and the `[CONFIRM]` list
- [ ] 8.6 After #68 merges, remove the scratch worktree
