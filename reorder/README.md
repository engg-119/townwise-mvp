# Reorder module

Turns a bar's sales and the existing guest forecast into the contracts in `docs/REORDER_SPEC.md`. It does not change `modeling/demand_model_v0.ipynb` and it does not read `data/synthetic/ground_truth/`.

Phase 2 reads sales, counts, and the guest forecast. Phase 3 (`reorder/engine.py`) turns those into an order: the delivery window, an order-up-to level, a deal size, and a one-line reason. Phase 4 (`reorder/pricing.py`) suggests a cheaper deal or a substitute. Both are advisory. The owner approves every order. The phone screens are a later phase.

The reports in `reports/` are built from the synthetic dataset in `data/synthetic`, not a real bar's sales.

The product's live order board is a TypeScript port of this engine's core in `api/src/orders/engine.ts`, which reads a location's own ordering setup, item sales and counts instead of these files. Every place the port differs from the Python engine is listed in `openspec/changes/complete-bar-ordering/design.md`, Decision 5. This module is not changed by it.

Price suggestions use `config/rules/nh.yaml`. That file is not legal advice. A state with no rules file only gets deal-size comparisons from the suppliers already on the account. Prices come from an uploaded sheet (`paths.price_list`). A price older than 30 days is marked stale. `PriceLookup` is the hook for a public price listing and returns nothing until one is connected. Dismissed suggestions stay hidden for 30 days. The log of accept, dismiss, and remind-later is written only when a caller saves it.

## Run the tests

From this folder:

```sh
uv sync
uv run pytest
```

Expect every test to pass. The Square item summary cannot report voids. Those fields stay unknown (`None`) until `square_style_comps_voids_2025-10.csv` is joined. After that join, October void counts match the Toast export. Toast still cannot report comps (`data_sources.csv`), so its comp counts stay unknown. The joined Square comps match the clean daily file.

## What the forecast adapter emits

- Guest rows from `modeling/forecasts/frozen_forecast_v3_guests_daily_2026-10-22_to_2026-12-31.csv`, with `unit` set to `guests`. The file's 10th/90th band is not copied.
- Serving rows for a purchase product, from daily item sales scaled by that guest forecast when the date is inside the guest file. Event days outside that file use the average of past days with the same event name.
- `sigma` is the sample standard deviation of past delivery-window errors (spec section 5b). The same window sigma is stored on each day of that product so it can be read later. Do not add it across days.

Sawtooth's delivery days, pars, deal sizes, targets, and the bottle-service switch are in `config/sawtooth.yaml`.

## Mockup

From this folder:

```sh
python3 -m streamlit run mockup_app.py
```

The home screen is the next order. It stays blank until onboarding saves a delivery day, a cutoff, and a late-order policy for each supplier. Reminders default to 24 hours and 2 hours before a cutoff. Bottle service is a screen of its own only after the switch is on. The layout is a single narrow column for a phone. The owner approves and exports the order. The app does not send it.

## Backtest

`reorder/backtest.py` replays a date range under the written pars and under the order engine. The forecast at each cutoff uses only sales from earlier days. `reports/backtest.md` is the May 2025–November 2026 replay. How it's doing reads that file.

## Owner report

`reports/how_its_doing.html` is the owner-only view of the latest full count (known waste versus unexplained loss) and the void review. It is not for staff. Regenerate it by running the tests. The answer-key score lives in `reorder/evaluation.py` and is not used to build the estimate or the review.
