# forecasts

Frozen forecasts, saved before their outcomes were available so they can be scored honestly later. Don't edit or regenerate these files; `demand_model_v0.ipynb` refuses to overwrite them. The git commit that added them is the timestamp.

## Oct 22 to Dec 31, 2026

| | |
|---|---|
| Made | 2026-11-01 |
| Data through | 2026-10-21 (Toast Sales Summary exports) |
| Primary model | Hybrid: linear median baseline (weekday, term, 2026 level) times XGBoost event effects, with an 80% daily range (`demand_model_v0.ipynb`, sections 2d and 9) |
| Also saved | `hybrid_holiday_blend` (pre-registered alternative, below), `linear_forecast`, `weekday_median_forecast` |
| Already past when made | Oct 22 to Nov 1 (sales unseen). Nov 2 onward was in the future |

| File | sha256 |
|---|---|
| `frozen_forecast_daily_2026-10-22_to_2026-12-31.csv` | `2eee13d2f75967e4e128a5e4aa2134bd625e3489b0b3f835334366399661930a` |
| `frozen_forecast_weekly_2026-10-22_to_2026-12-31.csv` | `62856b9b1b928e83dfffc3b19089f50804c6109044555622c3b0222d0d4a5358` |

### Assumptions (to confirm with Kieran)

- **Closed:** Sundays and Mondays (the pattern since May 25, 2026) unless a private event is booked, plus Thanksgiving (Nov 26), Dec 24 and Dec 25. That leaves 49 open days of 71.
- **Known bookings:** deposits already in Toast for Oct 29, Nov 12, Nov 16 (a Monday, so treated as open) and Nov 17.
- **No future shows known:** no ticket presales after Oct 21 appear in the data, so weekly comedy nights aren't flagged.
- **Dartmouth:** fall classes end Nov 17, finals run Nov 20-25, then interim. Home football Oct 30 (Harvard) and Nov 21 (Brown).

### Known risk: holidays

The model has no holiday feature, and several 2025 holiday days were far above a normal day. Its forecasts for those days are much lower than last year's sales:

| Day | Hybrid | 2025 same day | `hybrid_holiday_blend` |
|---|---|---|---|
| Wed Nov 25 (before Thanksgiving) | $1,857 | $6,075 | $2,906 |
| Fri Nov 27 | $4,326 | $6,042 | $4,704 |
| Sat Nov 28 | $6,475 | $8,455 | $6,588 |
| Wed Dec 23 | $1,790 | $8,359 | $3,616 |
| Sat Dec 26 | $6,475 | $5,034 | $5,232 |
| Thu Dec 31 (New Year's Eve) | $2,311 | $9,363 | $5,048 |

`hybrid_holiday_blend` averages the hybrid with last year's same day, scaled by that weekday's year-over-year level as of Oct 21, on these six days only. It equals the hybrid everywhere else. It was registered before any outcomes were seen, so scoring it is fair.

## v2: Oct 22 to Dec 31, 2026, with holidays

Registered on 2026-11-01 after v1, before any of these days' sales were seen. Same training data (through 2026-10-21) and model as v1, times holiday multipliers learned from 2025 (`demand_model_v0.ipynb`, sections 8b and 9b). v1 above is unchanged.

| File | sha256 |
|---|---|
| `frozen_forecast_v2_daily_2026-10-22_to_2026-12-31.csv` | `ee4b9ee93a53f519d753473e89acbd2dc069e50b0b57324ed21c7b3c974610f9` |
| `frozen_forecast_v2_weekly_2026-10-22_to_2026-12-31.csv` | `2fc0fcbffa14f894ebd4d846740fcdcb7aaf4f3a61744738462bda4ac91af096` |

- **Big nights** (Thanksgiving Eve, Dec 23, New Year's Eve): +170%. These ran 3.0x to 4.2x a normal day in 2025. Shrinkage was chosen by leave-one-out on those three nights (no shrinkage won: 14.7% error vs 67.2% for v1).
- **Halloween:** +16% (seen once, shrunk to a quarter of its measured effect).
- **Closures** (New Year's Day, July 4, Thanksgiving, Dec 24, Dec 25) come from holiday rules; in this window they match v1's closed days.

| Day | v1 hybrid | v2 | v2 80% range | 2025 same day |
|---|---|---|---|---|
| Sat Oct 31 (Halloween) | $6,701 | $7,742 | $4,635 to $11,285 | $11,174 (Fri) |
| Wed Nov 25 (Thanksgiving Eve) | $1,857 | $5,024 | $3,158 to $13,770 | $6,075 |
| Wed Dec 23 | $1,790 | $4,843 | $1,653 to $13,867 | $8,359 |
| Thu Dec 31 (New Year's Eve) | $2,311 | $6,251 | $1,972 to $17,138 | $9,363 |

Caution: the big-night effect rests on three nights from one year. If 2025's were unusual, v2 will overshoot.

## v3: Oct 22 to Dec 31, 2026, guest counts (recommended)

Registered on 2026-11-01 after v1 and v2, before any of these days' outcomes were seen. Same model and inputs as v1, but forecasting guests per day (Toast's "Total guests") instead of sales, because the owner scales staff, ordering and prep to how many people come in (`demand_model_v0.ipynb`, sections 8c and 9c).

| File | sha256 |
|---|---|
| `frozen_forecast_v3_guests_daily_2026-10-22_to_2026-12-31.csv` | `976ef7c3c131eec76397687b4a61bdff1cef650011a514da0a007c7d8c4420c9` |
| `frozen_forecast_v3_guests_weekly_2026-10-22_to_2026-12-31.csv` | `4fe42224dc531970184ab5328e97c673d20cd287b1a6c1f1c156f2917b9f230a` |

- **Backtest:** a week ahead, a typical week was off by 9.4% (sales: 11.3%), and 3 of 37 weeks missed by more than 20% (sales: 12 of 37).
- **Holidays:** re-estimated on guests. Big nights +173% (no shrinkage, chosen by leave-one-out); Halloween +4%.
- **Weekly 80% ranges:** from the rolling backtest's weekly guest errors (refits every 3 months, 28 days ahead), about -19% to +17% around the forecast.
- **Caveat:** guest counts are entered by staff. Guests per order slid from 1.63 (early 2025) to about 1.2-1.3 (late 2026), which fits the shift toward bar tabs but could also be a change in how counts are entered.

## Booking rule

`booking_rule_2026-10-22_to_2026-12-31.md` (registered 2026-11-01) defines how v3 is presented and scored on booked private-event nights: full buyouts get "booked: private event" instead of a walk-in forecast. In this window that's Mon Nov 16.

## How to score

1. Add Kieran's next Sales Summary export to `data/sawtooth/`.
2. Re-run `modeling/demand_model_v0.ipynb`.
3. Read section 10: daily and weekly WAPE for v1, the holiday-blend alternative, v2, the linear model and the weekday median; v3's guest-count WAPE and 80% range coverage; and a check of the closure assumptions.
