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

### How to score

1. Add Kieran's next Sales Summary export to `data/sawtooth/`.
2. Re-run `modeling/demand_model_v0.ipynb`.
3. Read section 10: daily and weekly WAPE for all four forecasts, 80% range coverage, and a check of the closure assumptions.
