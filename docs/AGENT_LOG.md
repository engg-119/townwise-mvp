# Agent log

Running log for the reorder module. New phases append a section. Earlier entries stay.

## 2026-11-05 — Phase 1: forecast interface

### What changed

- Created `docs/FORECAST_INTERFACE.md`.
- Created this log.
- No model code, notebooks, forecast CSVs, or application code were edited.

### Decisions

- Treated `modeling/demand_model_v0.ipynb` as the forecast entry point. There is no library function or API route that produces a forecast.
- Treated the committed files in `modeling/forecasts/` as the output the reorder module can read. The notebook refuses to overwrite them.
- Called v3 (daily guests) the recommended series, because the notebook says so and the owner calendar stays on v3. Documented v1, v2, and v5 beside it so a later phase does not pick the dollar file by accident.
- Did not re-run the notebook. `data/sawtooth/` is not in this checkout, and Phase 1 is not supposed to change or regenerate the model.

### Assumptions

- Toast `Sales by day` dates are the business dates the model uses. The notebook does not apply a 4 a.m. cutoff of its own.
- Guest counts are Toast "Total guests," staff-entered, for the whole restaurant. They are not drink servings.
- The 10th/90th bands on the daily files are model quantiles (linear quantile spread times one median event multiplier), not a stored residual standard deviation.
- Weekly bands are Sunday–Saturday error quantiles baked into the weekly CSVs. The residual sample itself was not saved.
- Lunch ending on 2026-07-01, Sunday/Monday closures since 2026-05-25, and the holiday groups are the notebook's assumptions, still marked there as needing Kieran's confirmation.
- Sawtooth-specific Toast sheet and column names are what the model requires. That is an observation about this repo, not a claim that every bar uses Toast.

### Skipped or needs input

- Did not build the forecast adapter, contracts, or config. That is Phase 2.
- Could not confirm live backtest numbers by executing section 10. No sales after 2026-10-21 are in this checkout, and no residual file exists.
- The spec's forecast contract wants item, date, expected servings, and σ or quantiles at the service level. This model has date, a restaurant-wide guest or dollar total, an 80% daily band, and only partial event flags. See the gap table in `docs/FORECAST_INTERFACE.md`.
- Need a team decision before Phase 2 writes the adapter: pass restaurant-level guests through with an explicit unit, or block item-level recommendations until daily item or category sales exist. The notebook says drink-level demand cannot be trained on the current exports.
- Need a decision on uncertainty: pass through the 80% guest band as-is, or add a separate backtest export of window-total errors so σ_W can be estimated. That export does not exist today. Estimating it would be new code outside the forecast notebook.

### How to check

- Read `docs/FORECAST_INTERFACE.md` and compare the column tables with the headers of:
  - `modeling/forecasts/frozen_forecast_v3_guests_daily_2026-10-22_to_2026-12-31.csv`
  - `modeling/forecasts/frozen_forecast_daily_2026-10-22_to_2026-12-31.csv`
- Expect v3 columns `date,weekday,expected_open,closed_reason,holiday,guests_forecast,guests_lo80,guests_hi80,outcome_existed_when_made`.
- Expect 71 data rows and blank guest numbers on `expected_open=False` days.
- `git diff` should show only `docs/FORECAST_INTERFACE.md` and `docs/AGENT_LOG.md`.

## 2026-11-05 — Direction after Phase 1 (no new phase)

### What changed

- Updated the decision section at the end of `docs/FORECAST_INTERFACE.md`.
- No application or model code was edited.

### Decisions

- Keep the existing v3 guest forecast as the busyness signal. Its unit stays guests. Do not read `guests_lo80` / `guests_hi80` into order quantities.
- Also accept daily sales by item from any bar or POS source, mapped into `sales_record`. Where that history exists, item demand is that history scaled by how the guest forecast compares with a comparable past day. Where it does not, use the owner's par and mark low confidence.
- Uncertainty follows `docs/REORDER_SPEC.md` section 5b: `S = μ_W + z · σ_W`, with `σ_W` equal to past forecast error on delivery-window totals (section 10) and `z` from the in-stock target (95% → 1.65, 98% → 2.05). The forecast model's own bands are not an input to that formula.

### Assumptions

- "Companies that can provide additional information" means any bar or POS vendor that can supply daily item sales, which spec section 3c already allows. Sawtooth's files in this repo are not daily by item.
- Scaling an item's own history by the guest forecast is a reorder-module step. It does not require changing `modeling/demand_model_v0.ipynb`.
- Servings-per-unit and pack size still have to come from the product catalog before a guest-scaled item total becomes cases.

### Skipped or needs input

- Phase 2 has not started.
- `σ_W` in cases still cannot be computed for Sawtooth until daily item sales (or a stand-in the team accepts) exist. A guest-window error is in people, not purchase units.

### How to check

- Read the "Decision for the reorder module" section at the end of `docs/FORECAST_INTERFACE.md`.
- It should name v3 guests as busyness, daily item sales as the item history, and section 5b window-total error as the only uncertainty used for `S`.

## 2026-11-05 — Phase 2: contracts, ingestion, forecast adapter

### What changed

- Created `reorder/` (contracts, POS / spreadsheet / invoice / inventory-export / manual adapters, catalog loaders, forecast adapter, tests, README).
- Created `config/sawtooth.yaml` from the synthetic config, plus time zone, phone-note aliases, and file paths.
- Updated the root `README.md` with how to run the reorder tests.
- Did not edit `modeling/demand_model_v0.ipynb` or any file under `data/synthetic/`, including `ground_truth/`.
- Did not generate a second synthetic dataset. `data/synthetic/sales/` already has a clean daily file, a Toast-style export, and a Square-style export.

### Decisions

- Sales records use menu-item ids. Inventory, orders, and item forecasts use purchase-product ids. Recipes convert drinks into servings of a product.
- `servings_per_unit` on a product is the theoretical yield. The draft loss rate in config is separate, so foam is not counted twice.
- Toast and Square are confirmed column mappings on one POS reader, not two parsers.
- Guest forecast rows keep `unit = guests` and `sigma = None`. The v3 10th/90th columns are not read.
- Item servings for a future day are that product's past weekday average, multiplied by the guest forecast's weekday index when the guest file covers the day. If it does not, and the same event happened before the cutoff, the past event average is used instead.
- `sigma` is the sample standard deviation of past delivery-window errors (spec section 5b). It is stored once per product on each forecast day and must not be added across days.
- A delivery window runs from the cutoff date through the day before the following delivery, taken from the supplier schedule. For the synthetic Thursday beer delivery that is Wednesday through Sunday.
- Bottle-service products `P901` and `P902` are excluded while `modules.bottle_service` is false.
- Staff 86 notes are stockout notes, not inventory quantities. The evaluation stockout file stays unread.

### Assumptions

- Hanover's time zone is `America/New_York`. That was not in the synthetic yaml.
- Phone-note nicknames (`corona`, `bud lt`, `HN`, `claw`, `suncruiser`, `guinness backup`) map to the product ids in `config/sawtooth.yaml`.
- A note's year is whichever of 2025–2027 matches the written weekday and falls after the previous note.
- POS quantity is drinks. Void and comp flags are set only when the file has those columns. The Square October export has neither, so those flags are false even when Toast records a void. Quantity and net sales still match.
- Product cost on the contract is the 2026 case cost when the catalog has one.
- Days with no prior same-weekday sales are left out of a window error instead of treated as a forecast of zero.
- `uv` was not on the shell path here. Tests were run with `python3 -m pytest` after installing PyYAML and pytest for that interpreter.

### Skipped or needs input

- Phase 3 (order-up-to math, inventory estimate, deal rounding, late-order recovery) has not started.
- No full-history item forecast was written to disk. The adapter can build one; the engine that turns it into an order is next.
- Real Sawtooth cutoffs, prices, and cooler size are still the synthetic assumptions in `config/sawtooth.yaml`.
- Keg tap log is not ingested. It is not one of the section 2 contracts.

### How to check

From `reorder/`:

```sh
uv sync
uv run pytest
```

If `uv` is not installed, `python3 -m pytest` from that same folder works once PyYAML and pytest are available. Expect 14 passed.

The October POS test is `test_toast_and_square_october_sales_match`. The guest-file test is `test_guest_forecast_keeps_guests_and_drops_model_band`: 2026-10-22 is 81.83 guests and `sigma` is empty.

## 2026-11-05 — Void and comp ingestion (stop before the engine)

### What changed

- Replaced regenerated files in `data/synthetic/` with the new downloads. `README (2).md` became `README.md`. New sales files landed in `sales/`, `reference/data_sources.csv` in `reference/`, updated operations files in `operations/`, and `void_truth.csv` plus `void_anomaly_answer_key.json` in `ground_truth/`. File contents were not edited.
- `SalesRecord.void_qty` and `comp_qty` are now counts or `None`. `DataSource` has a `capabilities` field from `reference/data_sources.csv`.
- Added `VoidEvent` and `CompEvent`, plus readers for `sales/void_log.csv`, `sales/comp_log.csv`, and `sales/square_style_comps_voids_2025-10.csv`.
- Joining that Square report fills void and comp counts on the Square summary. A day with no event becomes 0 only after the report is attached.
- Did not change the forecast notebook, the reorder math, or anything under `ground_truth/` as an input.

### Decisions

- A source that cannot report voids or comps stores `None`, never 0 or false. `reference/data_sources.csv` is what decides that.
- Toast can report void quantity and cannot report comp quantity, so October Toast comps stay unknown. After the Square report is joined, void counts match Toast, and comp counts match the clean daily file, which is the file that actually has `comp_qty`.
- The Date column on the Square activity report is already the business date. Times after midnight are not shifted again.

### Assumptions

- `Waste` of Yes/No on a Square void maps to `marked_as_waste`. A blank waste field stays unknown.
- Square activity rows have no check id or product cost. Those fields are empty. The full logs have them.
- The regenerated owner count for Corona on 2025-05-05 is 6.92 cases, and the first phone note says corona 9.5. Tests were updated to those values.

### Skipped or needs input

- Stopped before the engine, as requested. Forecast training, the inventory waste split, the owner void-review report, and the ground-truth scoring are not built.
- Toast and Square sales records are not fully identical on comps, because the Toast export cannot report a comp count. Void counts for October do match.

### How to check

From `reorder/`:

```sh
python3 -m pytest
```

Expect 15 passed. `test_square_summary_leaves_voids_unknown_until_the_report_is_joined` checks that Square voids are `None` before the report and match Toast afterward. `test_void_and_comp_logs_keep_their_fields` reads the first void `V-000001` and the first comp `C-000004`.

## 2026-11-05 — Void and comp use in the estimate, owner report, and evaluation

### What changed

- Forecast training uses `demand_drinks`, which is qty sold. Voids are not added. Comps stay inside qty sold.
- `reorder/inventory.py` carries stock from one owner full count to the next: plus deliveries, minus drinks sold, minus voids marked as waste. Unmarked voids are not subtracted.
- At each full count the gap is split into known waste (comps plus marked-waste voids) and unexplained loss.
- `reorder/void_review.py` rates voids by employee, weekday, hour, and reason, and flags a late Friday/Saturday pattern. Wording is "pattern to review," with innocent explanations. The notice says owner only.
- `reorder/reports/how_its_doing.html` is that screen.
- `reorder/evaluation.py` is the only module that reads `ground_truth/`. It scores the waste split against `void_truth.csv` and the flag against `void_anomaly_answer_key.json`.
- The forecast notebook was not changed.

### Decisions

- Comps are not subtracted a second time. They are already in qty sold. They are still listed as known waste so the owner can see them.
- The waste split uses owner full counts, not the manager's quick counts. Quick counts are a partial list and include counting error.
- A month is flagged when late Friday/Saturday voids that were not marked as waste are at least 8 and at least twice that person's usual month and twice the team that month. One quieter month between two high months stays in the span if it is still twice that person's usual month.
- "Late" is 10 p.m., 11 p.m., and the midnight hour, the last stretch before a 1 a.m. close.

### Assumptions

- One poured drink converts to purchase units through the recipe and the theoretical servings per unit.
- The hidden pattern would show up as unmarked late weekend voids. The rule was not given the employee's id.

### Evaluation result

- Answer key: BT-04, 2026-02-01 through 2026-06-30. The report found BT-04, 2026-02-06 through 2026-06-27, 73 voids. No other flag, so no false alarm.
- Across owner full counts, known waste is about 87 purchase units and unexplained loss about 98. Voids that were truly poured but not marked as waste are about 8.7 purchase units, roughly 9% of that unexplained total. The rest of the gap is not those voids.

### Skipped or needs input

- Order-up-to quantities, deal rounding, and late-order recovery are still not built.
- The screen is a static HTML page, not the full mockup.

### How to check

From `reorder/`:

```sh
python3 -m pytest
```

Expect 19 passed. Open `reorder/reports/how_its_doing.html`. The banner should say the page is for the owner only, and the void section should name a pattern to review from February through June 2026.

## 2026-11-05 — Phase 3: reorder engine

### What changed

- Added `reorder/engine.py`. It sizes an order from the exposure window, the in-stock target, stock on hand, the written par, and the deal step.
- Added `reorder/tests/test_engine.py`.
- Each recommendation has a why line. The spec's Corona example produces the sentence in section 9.
- A missed cutoff with policy `moved_to_next_delivery` lengthens the window to the delivery that will actually arrive, lists the first night an item runs out, and ranks recovery options.
- A short delivery adds only the received quantity. Bottle-service products stay off the order while that module is off.
- The forecast notebook was not changed. Nothing was committed or pushed.

### Decisions

- 95% uses z = 1.65 and 98% uses z = 2.05, as section 5b states. Liquor (92%) and cocktail ingredients (88%) use the normal table, because the spec does not name a z for them.
- Deal choice compares purchase cost, a holding cost of 5% of the case price on units above the forecast, and a shortage cost of 4 times the case price on units below the order-up-to level. Those two rates are assumptions. They make the section 5g example pick 18 cases over 12.
- When the cooler cannot hold 18, the example recommends 12 and says a shortage is more likely.
- No count, or a count older than 7 days, orders the written par and says the forecast target was not used. A count 3–7 days old still uses the forecast and asks for a count of that item.
- Draft keeps 1 tapped plus 1 backup, and adds a second backup when the window forecast is more than 1 keg.
- Space and budget cut the lowest-priority line first. Never-run-out items, and items with no substitute, rank higher.
- Forecast servings convert to cases with the category loss rate in `config/sawtooth.yaml`. The count-gap math from the void work still uses theoretical yield. Comps are already inside qty sold, and the config loss rates are foam and over-pour, so applying the loss rate there as well would subtract comps twice.
- The Thursday window is still the one from the schedule: cutoff Wednesday through the day before Monday, which includes Friday, Saturday, and Sunday.

### Assumptions

- Holding cost is 5% of the case price per leftover case over one window. Shortage cost is 4 times the case price per case below the order-up-to level. Neither number has been confirmed with the owner.
- Cooler capacity stays the assumption already in `config/sawtooth.yaml` (70 cases, 9 keg slots).
- A Thursday order that misses cutoff and moves to Monday must cover from that Thursday through the day before the next Thursday.

### Skipped or needs input

- Phase 4 (legal price suggestions), Phase 5 (the phone screens), and Phase 6 (the backtest replay) are not started.
- The two-POS identity check is the Phase 2 test `test_square_summary_leaves_voids_unknown_until_the_report_is_joined`. It was not rewritten.
- Real cutoffs, deal prices, and cooler size are still the synthetic stand-ins.

### How to check

From `reorder/`:

```sh
python3 -m pytest
```

Expect 28 passed. `test_spec_example_recommends_18_cases` should recommend 18, and 12 when only 12 cases of cooler space are free. `test_missed_thursday_cutoff_extends_the_window_and_raises_the_order` should order more after the cutoff is missed.

## 2026-11-05 — Phase 4: price and deal suggestions

### What changed

- Added `config/rules/nh.yaml` with the New Hampshire channels from spec section 7a.
- Added `reorder/pricing.py`. It reads an uploaded price sheet, compares deal sizes, and can suggest a catalog substitute.
- Added supplier channels and the price-list path to `config/sawtooth.yaml`.
- Added `reorder/tests/test_pricing.py`.
- The forecast notebook was not changed. Nothing was committed or pushed.

### Decisions

- Beer, cider, seltzer, and draft suggestions may name a licensed distributor, manufacturer, or brew pub. Retail stores and warehouse clubs are refused, including a cheaper price that arrives from the web lookup.
- The same product is never priced from a second distributor. New Hampshire gives each beer brand to one distributor in a territory, so the comparison is deals and substitutes.
- Liquor suggestions stay on the New Hampshire Liquor Commission, including a case-lot discount on that sheet.
- A state with no file in `config/rules/` gets deal sizes from the current supplier only. Substitutes are skipped because the legal channel is unknown.
- A larger deal is suggested only when it still costs less for the week after a 5% holding charge on cases that will not sell that week. That is the same holding assumption as Phase 3.
- Prices older than 30 days are still shown and marked stale. Dismiss and remind-later hide that suggestion for 30 days. Accept is logged and does not hide it.
- `PriceLookup.quotes_for` returns an empty list. A real public listing can override that method later.

### Assumptions

- Supplier channels in `config/sawtooth.yaml` (SUP_A and SUP_B are distributors, SUP_C is restaurant supply, SUP_NHLC is the state store) match the synthetic data, not a confirmed Sawtooth vendor list.
- Weekly savings use the weekly purchase-unit forecast the caller passes in. The price module does not read the guest forecast itself.
- The 5% holding charge is still an assumption, not a Sawtooth number.
- `config/rules/nh.yaml` is a reading of the spec's statute list. It is not legal advice.

### Skipped or needs input

- Phase 5 (the phone screens) and Phase 6 (the backtest) are not started. There is no Savings screen yet; the suggestions are the data that screen will show.
- No live state price listing is connected.
- Real deal prices are still the synthetic sheet.

### How to check

From `reorder/`:

```sh
python3 -m pytest
```

Expect 34 passed. `test_illegal_channels_and_a_second_distributor_are_never_suggested` should keep warehouse, grocery, and a second distributor out of the suggestions. `test_a_state_with_no_rules_file_only_suggests_current_deals` should return deal sizes only.

## 2026-11-05 — Phase 5: mockup screens

### What changed

- Added `reorder/mockup_app.py`, a Streamlit mockup, and `reorder/mockup_logic.py` for the schedule gate, reminders, and order list.
- Added `reorder/tests/test_mockup.py`.
- The home screen lists the next order in cases, kegs, or bottles, with a why line, an editable quantity, an override reason, approve, mark placed, and a text or PDF export.
- Onboarding requires a delivery day, cutoff, and late-order policy before any recommendation appears. Reminders default to 24 hours and 2 hours and can be changed.
- The other screens are data sources, late-order recovery, quick count, receive delivery, week ahead, liquor run, savings ideas, and how it's doing. Bottle service is in the menu only when the switch is on.
- The forecast notebook was not changed. Nothing was committed or pushed.

### Decisions

- The repo's existing interface is the Townwise Expo app, a different product. The reorder module is Python and had no screens, so the mockup is Streamlit, which is what the spec says to use in that case. The order math stays in Python.
- With no recent count, the order follows the written par and says so. A submitted quick count is what turns confidence up.
- How it's doing does not invent backtest numbers. That comparison is Phase 6.
- The layout is one narrow column so it can be used on a phone.

### Assumptions

- The "Fill Sawtooth's synthetic schedule" button copies `config/sawtooth.yaml`. Those cutoffs are still the synthetic stand-ins.
- A practice count is half the written par, and only appears if the owner taps that button.

### Skipped or needs input

- Phase 6, the historical replay, is not started.
- The mockup does not send an order, a text, or an email to a rep.

### How to check

From `reorder/`:

```sh
python3 -m pytest
python3 -m streamlit run mockup_app.py
```

Expect 39 passed. Open the app. Next order should say recommendations stay off. Fill the synthetic schedule, save it, load the catalog, and come back. The first line should be a never-run-out item in kegs or cases, and the reason should say there is no recent count. Bottle service should be absent from the menu until the switch is on.

## 2026-11-06 — Phase 6: backtest

### What changed

- Added `reorder/backtest.py`. It replays a date range under the written pars and under the order engine, then writes one metrics row per category.
- Added `reorder/tests/test_backtest.py`.
- Wrote `reorder/reports/backtest.md` for 2025-05-01 through 2026-11-04. The How it's doing screen reads that file.
- A sale dated after the cutoff is not part of the forecast. Held-out true demand is used only to score fill rate and stockouts. The order engine does not import this module.
- The forecast notebook was not changed. Nothing was committed or pushed.

### Decisions

- Both policies start from the written par, so the first week is not an empty shelf.
- The baseline orders up to the par, keeps Corona at the weekly floor on Thursday, and adds one case of bottles or cans when a known event is inside the window.
- The agent uses the weekday average of sales before the cutoff, the order-up-to level, deal rounding, and the par floor.
- Mixers the owner buys at the state store go on the Monday liquor run. A mixer with a distributor delivery stays on that schedule.
- A missed Thursday is not delivered that day. It becomes the next delivery, and that delivery does not also get its ordinary short order. With recovery on, that replacement order is sized for the longer window.
- Draft and cider lots older than their shelf life are counted as waste.

### Result

The acceptance bar is fewer never-run-out stockout days and no more units on hand. This run does not clear it.

- Never-run-out stockout days: 14 for the agent, 17 for the pars.
- Average units on hand for those items: 5.13 for the agent, 3.93 for the pars.
- Bottles and cans fill rate: 98% agent, 97% pars. Draft fill rate is 100% for both. Liquor is 99% for both. Cocktail ingredients are 97% for both.
- Moving every Thursday order to the next delivery is 158 late orders and $1,975 in fees. The longer replacement order does not reduce never-run-out stockout days on this history (34 either way). The fee is the supplier's late fee from the schedule. Suppliers with no fee add a late order and $0.

### Assumptions

- Opening stock equals the written par. That is not a counted inventory.
- One extra case before a known event is the baseline's "over-order." The spec does not give the amount.
- Pour cost is ingredient cost divided by menu price, with a cocktail's price split across its ingredients by cost.
- Days of supply are average units on hand divided by average daily demand.

### Skipped or needs input

- The agent was not tuned to clear the acceptance bar. Doing that would mean changing targets or the holding cost, which is a decision for the team.
- Live logging of the owner's overrides is not built. The spec puts that after launch.

### How to check

From `reorder/`:

```sh
python3 -m pytest
```

Expect 44 passed. Read `reorder/reports/backtest.md`. The first paragraph should say the run does not clear the bar, with 14 never-run-out stockout days for the agent and 17 for the pars.
