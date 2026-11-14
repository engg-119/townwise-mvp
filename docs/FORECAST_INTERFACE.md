# Forecast interface

Phase 1 note for the reorder module. The forecast model was not changed. This describes what it actually emits today, and what Section 2 of `docs/REORDER_SPEC.md` asks for that it does not provide.

Studied from the notebook source and the committed forecast files. `data/sawtooth/` is gitignored and is not in this checkout, so the notebook was not re-run.

## Entry point

There is no importable forecast function or service. The model is the notebook `modeling/demand_model_v0.ipynb`.

From `modeling/`, with Kieran's Toast exports in `data/sawtooth/`:

```sh
uv sync
uv run jupyter nbconvert --to notebook --execute --inplace demand_model_v0.ipynb
```

Re-running does not overwrite files already in `modeling/forecasts/`. The training cutoff stays at 2026-10-21 even if newer exports are added. Section 10 of the notebook scores those frozen files once later sales exist. It prints WAPE and range coverage. It does not write a residual file.

The reorder module should read the frozen CSVs. It should not retrain this notebook or parse notebook cells.

## What is forecast

The notebook trains four ideas. Only the first has a saved forecast.

| Notebook section | Target | Status |
| --- | --- | --- |
| 1–2, 8–9 | One number per calendar day for the whole restaurant | Saved forecasts, below |
| 3 | Night type (show, Dartmouth event, big-ticket, regular) | Labels on history, not a forecast file |
| 4 | Drink mix (liquor, draft, bottled beer, wine, NA) | Cannot train. Category sales exist only as four period totals |
| 5 | Reorder points | Explicitly not built. Needs item demand, recipes, case sizes, lead times, counts |

The notebook's own summary: the model forecasts total restaurant sales, not drinks.

**Recommended series for anything that means "how busy."** v3, daily guests. The notebook says Kieran scales staffing, ordering, and prep to head count, and that guest forecasts beat sales forecasts in both backtests. The owner calendar in section 9g stays on v3. v5 is frozen as a later test, not the one the calendar uses.

v3 is still not a drink forecast. Guests are people, not servings, and they are not split by item.

## Saved outputs

All files are under `modeling/forecasts/`. Each daily file is 71 calendar days, 2026-10-22 through 2026-12-31. Closed days have blank numeric forecasts. 49 days are expected open.

Made 2026-11-01 from Toast Sales Summary data through 2026-10-21. Oct 22–Nov 1 had already happened but those sales were unseen (`outcome_existed_when_made` is true). Nov 2 onward was in the future when the file was written.

### v3 guests (recommended)

`frozen_forecast_v3_guests_daily_2026-10-22_to_2026-12-31.csv`

| Column | Meaning |
| --- | --- |
| `date` | Calendar date |
| `weekday` | Day name |
| `expected_open` | `True` / `False` |
| `closed_reason` | `Sunday`, `Monday`, `Thanksgiving`, `Christmas Eve`, `Christmas`, or blank |
| `holiday` | `Halloween`, `big night` (Thanksgiving Eve, Dec 23, New Year's Eve), `closed holiday`, or blank |
| `guests_forecast` | Point forecast of Toast "Total guests" for that day. Median hybrid, then a holiday multiplier |
| `guests_lo80`, `guests_hi80` | 10th and 90th percentile of the same hybrid, times the same holiday multiplier. Blank when closed |
| `outcome_existed_when_made` | Whether that date was already in the past on 2026-11-01 |

`frozen_forecast_v3_guests_weekly_2026-10-22_to_2026-12-31.csv` sums guests by Sunday–Saturday week (`week` like `2026-10-26/2026-11-01`). `guests_lo80` and `guests_hi80` are not the sum of the daily bands. They are the weekly point total times a fixed factor from past weekly guest errors, about −19% to +17% (see uncertainty below).

### v5 guests (not the calendar default)

Same columns as v3, in `frozen_forecast_v5_guests_daily_2026-10-22_to_2026-12-31.csv` and the matching weekly file. Same model with a separate weekday level after an assumed lunch-service end of 2026-07-01. A pre-registered check on Sep 1–Oct 21 did not beat v3 on weekly error, so the calendar stays on v3. Nov–Dec is v5's real test.

### v1 sales dollars

`frozen_forecast_daily_2026-10-22_to_2026-12-31.csv`

| Column | Meaning |
| --- | --- |
| `term`, `week_of_term` | Dartmouth term (`fall`, and later `interim`) and week since classes started. `-1` is not used inside this window |
| `events` | Comma-separated flags that were on that day: in this window only `private_event` (4 days) and `football_home` (2 days). Blank otherwise. Homecoming is before Oct 22, so it does not appear |
| `hybrid_forecast` | Primary point forecast of daily net sales, dollars |
| `hybrid_lo80`, `hybrid_hi80` | 10th and 90th percentile, dollars |
| `linear_forecast` | Quantile regression without the tree event layer |
| `weekday_median_forecast` | Weekday median from training data |
| `hybrid_holiday_blend` | Pre-registered alternative. Equals the hybrid except on six holiday days, where it averages the hybrid with last year's same weekday scaled by the year-over-year level as of Oct 21 |

Weekly file: `frozen_forecast_weekly_2026-10-22_to_2026-12-31.csv`. Weekly bands are again a multiplier on the weekly sum, from past weekly sales errors, not a sum of daily bands.

### v2 sales dollars, with holidays

`frozen_forecast_v2_daily_2026-10-22_to_2026-12-31.csv`: `v2_forecast`, `v2_lo80`, `v2_hi80`, plus `v1_hybrid_forecast` and the same `holiday` labels as v3. v2 is v1 times holiday multipliers learned from 2025. Big nights about +170%, Halloween about +16%. Weekly file matches.

## How a forecast row is produced

Inputs known before the day:

- Weekday, a 2026 level shift, and Dartmouth term.
- Dartmouth calendar flags from `modeling/dartmouth_calendar_2025_2026.csv`: commencement, Green Key, Homecoming, Winter Carnival, Family Weekend, orientation, home football. Term in session runs from the first day of classes through the end of finals.
- Sawtooth show dates and private-event dates parsed out of Toast Product Mix item names (ticket menu, Event-category open items, invoice numbers that encode a date). Off-site catering is excluded from the booking rule. Unticketed DJ or dance nights are missing.
- Holiday groups: `hol_big_night` (day before Thanksgiving, Dec 23, Dec 31), `hol_halloween` (Oct 31), `hol_closed` (New Year's Day, July 4, Thanksgiving, Dec 24, Dec 25). v1's primary hybrid does not use these. v2, v3, and v5 multiply by them.

The hybrid:

1. Median quantile regression (`sklearn` `QuantileRegressor`, quantile 0.5, no penalty) on weekday, `is_2026`, and term. v5 swaps weekday for `weekday_regime` (`"Thursday (no lunch)"` on and after 2026-07-01).
2. XGBoost (`reg:absoluteerror`, depth 3, 400 trees, learning rate 0.03) predicts the log ratio of actual to that baseline. Tree inputs are the separate Dartmouth event types, private-event flag, comedy/improv vs other shows, week of term, and weekday.
3. Point forecast = baseline × exp(tree prediction).
4. v2/v3/v5 then multiply by a shrunken holiday effect. Big-night shrinkage was chosen by leave-one-out on three 2025 nights. Halloween is shrunk with λ = 3 because it was seen once.

Closed-day rule for this window, still to confirm with Kieran: Sundays and Mondays are closed unless a private event is booked that day, plus Thanksgiving, Dec 24, and Dec 25. A booked Monday (Nov 16) is treated as open in the forecast file. The separate booking rule in `modeling/forecasts/booking_rule_2026-10-22_to_2026-12-31.md` would display that Monday as "booked: private event" and drop the walk-in number in the owner calendar. The CSV itself still has a guest forecast that day.

No lagged sales are used. A forecast is made once from the training cutoff and applied to every later day.

## Units and granularity

| Question | Answer |
| --- | --- |
| Grain | One row per calendar day for the whole restaurant. Also Sunday–Saturday week totals. No item, category, hour, or supplier |
| v3 / v5 units | Toast guest counts (people). Staff-entered. Guests per order fell from about 1.63 in early 2025 to about 1.2–1.3 in late 2026 |
| v1 / v2 units | Net sales dollars, all categories, including food and Event deposits |
| Servings or purchase units | Not produced |
| Horizon in the files | Only 2026-10-22 through 2026-12-31. The notebook can score 7-day and 28-day-ahead refits, but those predictions are not saved |
| Business day | Whatever date Toast put in `yyyyMMdd` on the Sales by day sheet. The model does not apply a 4 a.m. cutoff |

## Uncertainty

There is no σ column and no saved residual table.

Daily `*_lo80` / `*_hi80` are the hybrid's 10th and 90th percentile forecasts. The linear model is fit three times (quantiles 0.1, 0.5, 0.9). The tree multiplier is fit once, on the median log residual, and applied to all three. So the band is the linear model's spread, scaled by the event effect. It is not an empirical error distribution, and it is not a 95% or 98% quantile.

Those daily bands run narrow. In the rolling backtest, an "80%" daily band contained about 73–77% of sales days, and about 68% of guest days. Section 9e tried widening guest bands. Ranges wide enough to actually cover about 80% of nights span roughly half to 1.5 times the forecast, so the owner calendar dropped nightly ranges. The frozen daily CSVs still contain the un-widened 10/90 bands.

Weekly bands are different. They come from the 10th and 90th percentile of log(actual / forecast) on Sunday–Saturday totals in a rolling backtest (refit every 3 months, forecast at least 28 days ahead, at least 8 past weeks). That multiplier is applied to the weekly point total. For v3 guests the saved bands are about −19% to +17%. Those quantiles are computed in the notebook and then discarded. Only the multiplied weekly totals are saved.

Nothing in the repo is an error on a delivery exposure window (cutoff through the next delivery). Sunday–Saturday is not Thursday-through-Monday.

Section 10 will compute WAPE when a newer Sales Summary is added. It does not write the day-level errors anywhere.

## Where Toast is assumed

The loaders only read Sawtooth's Toast exports. Names and layouts are fixed in the notebook.

| Source | What the notebook requires |
| --- | --- |
| `data/sawtooth/SalesSummary_*.xlsx` | Sheet `Sales by day`. Columns `yyyyMMdd`, `Net sales`, `Total orders`, `Total guests`. One row per day. Other sheets in the workbook are period totals and are ignored |
| `data/sawtooth/ProductMix_202[56]-*.xlsx` | Sheet `All levels` columns `Type`, `Menu`, `Qty sold`, `Item, open item` (ticketed shows: `Type == menuItem`, `Menu == TICKETS`). Sheet `Open items` columns `Sales Category`, `Open item`, `Net item amt` (`Sales Category == Event`). Dates are parsed from item names and from invoice numbers like `7262501`. Every `ProductMix_*` file directly in `sawtooth/` is read, so weekend files are kept in `sawtooth/weekends/` to avoid double counting |
| `data/sawtooth/sales-breakdown-*.csv` | Columns `Service Type`, `Sales Category`, `Net Sales`. Used only for the period drink-mix table, not for the daily model. Categories read: Liquor, Draft Beer, Bottled Beer, Wine, NA Beverage |
| File names | `SalesSummary_<start>_<end>.xlsx` and `ProductMix_<start>_<end>.xlsx`. The stem's two dates set the export window used to guess the year inside an item name |

Show dates and private-event flags are rebuilt from those names. They are a partial list. Deposits post on the payment day, which can be weeks before the event. Big-ticket days (net sales per order ≥ $150) use that day's own outcome, so they are an oracle upper bound, not a model input.

There is no other POS adapter. A different vendor's export would not load.

## Locality research

The locality features are a checked-in CSV, `modeling/dartmouth_calendar_2025_2026.csv`, not a live research agent. Columns: `event`, `kind`, `start_date`, `end_date`, `source_url`, `confidence`, `notes`. Kinds include `term_classes`, `finals`, and the big-event kinds listed above. Each row has a source URL and a confidence of `high` or `medium`.

Private events and shows come from Toast names, not from a bookings calendar. The booking rule file says Kieran's own calendar should override that rule once it exists.

## Backtest errors

Stored on disk:

- Point forecasts and 10/90 bands in the frozen CSVs above.
- Narrative error rates in the notebook introduction and in `modeling/forecasts/README.md` (for example v3 week-ahead typical week off by 9.4%, 3 of 37 weeks worse than 20%).
- ChatGPT's earlier scorecard is an input under `data/chatgpt/`, which is gitignored, not a residual file from this model.

Not stored:

- Day-level or week-level residuals (actual minus forecast) for any backtest.
- The log-error sample used to set weekly bands.
- Errors on delivery windows.
- Errors by item, category, or event type.
- A σ the reorder math can sum across days.

To estimate σ over a delivery window, someone would have to re-run the rolling backtest and save the errors. That code does not exist outside the notebook, and this phase does not add it.

## Gaps against the Section 2 forecast contract

The contract is: item id, date, expected servings, uncertainty (σ or low/high quantiles), event flags.

| Contract field | What exists | Gap |
| --- | --- | --- |
| Item id | No item key. One restaurant-level series | The reorder engine cannot size Corona, a keg, or a liquor bottle from this forecast alone |
| Date | Daily dates, one frozen window only | No general "forecast from this cutoff forward" API. Nothing past 2026-12-31 is saved |
| Expected servings | Guests (v3/v5) or net sales dollars (v1/v2) | Not servings, not purchase units, not even drink revenue. Food and Event deposits are inside the dollar forecasts. Guest counts are a head-count proxy the notebook prefers for "how busy," and they are staff-entered |
| Uncertainty | Daily 10/90 quantiles. Weekly 10/90 multipliers on Sunday–Saturday totals. No σ | Spec service levels are 95% and 98%, not 80%. Daily bands under-cover. Weekly bands are the wrong window (Sun–Sat, not cutoff to next delivery) and are not independent daily errors you can add. No saved residual series to estimate σ_W on window totals |
| Event flags | v1 has `events`, `term`, `week_of_term`. v3/v5 have only `holiday` plus `closed_reason` | The recommended guest file does not carry Dartmouth or private-event flags. Those flags exist only on the dollar file, and in this window they are just `football_home` and `private_event`. No event-size estimate and no per-event error history |

Other spec needs this model does not meet:

- **By-item demand** for order-up-to levels, deal rounding, and event look-ahead. Product Mix quantities are period totals, and the weekend files total Friday and Saturday together.
- **Stockout-adjusted history.** Days an item was 86'd are not in the data and are not removed from training.
- **A forecast that updates at each order cutoff** using only information available then. The saved files are one freeze. The rolling backtest does this in memory and throws the predictions away.
- **Any non-Toast source.** Column names, sheet names, and file globs are Toast-specific.

## Decision for the reorder module (2026-11-05)

Use both signals. Do not turn the guest file into drink orders by itself, and do not ignore it once item sales show up.

**Busyness.** The existing v3 guest forecast stays the locality-aware demand signal: how many people are expected, including Dartmouth events, holidays, and closures. Its unit stays guests. `guests_lo80` and `guests_hi80` are not used for order sizing.

**Item sales.** When a bar or its POS vendor supplies daily sales by item, ingestion maps that file into `sales_record` like any other source. Those rows are the item's own history (servings, bottles, or cases, in the unit the file actually uses). Sawtooth's current Product Mix exports are period totals, so they do not fill this yet. A later export that is daily and by item does.

**How the two meet.** For an item that has daily history, expected servings on a future day come from that item's history, scaled by how busy the guest forecast says the day will be relative to a comparable past day. For an item with little or no history, the order falls back to the owner's par and is marked low confidence (spec section 3c). Pack size and servings per unit, from the product catalog, convert servings into cases or kegs. That conversion is reorder configuration, not a change to the forecast notebook.

**Uncertainty, from the reorder spec only.** Section 5b sets the order-up-to level as `S = μ_W + z · σ_W`.

- `μ_W` is expected demand over the exposure window (cutoff through the next delivery), summed from the daily item forecast and converted to purchase units.
- `σ_W` is the error of those window totals on past windows, measured in the backtest (spec section 10). It is not the guest model's 10th/90th band, and it is not a Sunday–Saturday band.
- `z` comes from the in-stock target in spec section 4 (95% → 1.65, 98% → 2.05).

The spec's other option, reading a quantile at the target level straight from the forecast model, does not apply. That model publishes an 80% band, not a 95% or 98% quantile, and the team has directed the reorder module to follow section 5b's window-total error. Until item history exists, `σ_W` for a drink cannot be computed. A guest-only error would be in people, not cases.
