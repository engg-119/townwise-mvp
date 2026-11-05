# data

Raw data for the project. Everything in this folder except this README is gitignored (see the root `.gitignore`) because these are private exports from Sawtooth Kitchen. Get the files from a teammate and put them in `data/sawtooth/`.

## `sawtooth/`

Toast POS exports from Kieran (Sawtooth Kitchen, Allen Street, Hanover). Each export covers a half-year, except the last, which ends on the export date (2026-10-21).

| Files | Periods | Granularity |
|---|---|---|
| `SalesSummary_<start>_<end>.xlsx` | 2025 H1, 2025 H2, 2026 H1, 2026-07-01 to 2026-10-21 | The `Sales by day` sheet has one row per day; every other sheet is a period total |
| `ProductMix_<start>_<end>.xlsx` | Same four periods, plus a 2022-09-11 to 2022-10-31 archive (older sheet layout) | Item-level quantities and sales, totaled over the whole period. No per-day item data |
| `sales-breakdown-*.csv` | Same four periods | Sales-category totals for the period, split by Service Type (Lunch, Dinner, Late Night, Brunch) |

The `Event` sales category is mostly ticket sales, and it's also used to take deposits for future events (Kieran, 2026-11-03). So Event revenue on a given day can belong to a later event.

## `sawtooth/weekends/`

Product Mix exports for single Friday-Saturday weekends, which Toast generated on 2026-11-03. As with every Product Mix, each file totals both days together.

| File | Weekend |
|---|---|
| `ProductMix_2025-04-11_2025-04-12.xlsx` | Apr 11-12, 2025: spring term, no Dartmouth event |
| `ProductMix_2025-05-16_2025-05-17.xlsx` | May 16-17, 2025: Green Key |

They're in a subfolder on purpose. The notebooks read every `ProductMix_*` file sitting directly in `sawtooth/`, and these weekends already fall inside the Jan-Jun 2025 export, so in the main folder they'd be counted twice. Both files' totals match the Sales Summary's net sales for those days to the cent.

## `chatgpt/`

Outputs ChatGPT produced from the files above (downloaded 2026-11-01): a model scorecard, out-of-sample predictions, a ranked missing-data list, and two audit workbooks. The forecasting-experiments workbook includes the dated event register (`EVENTS WITH SOURCE URL`). These are ChatGPT's own outputs, not source data; `eda/sawtooth_chatgpt_audit.ipynb` and `modeling/demand_model_v0.ipynb` check them against the raw exports.

## Note on the sales-breakdown CSVs

Two of the CSVs cover the same period: `sales-breakdown-jan1-jun30-2025.csv` is split by Dining Option (Dine In, Take Out, Online Ordering), and `sales-breakdown-jan1-jun30-2025-2.csv` is split by Service Type. So there are five CSV files but only four periods.
