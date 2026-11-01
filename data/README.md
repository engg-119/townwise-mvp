# data

Raw data for the project. Everything in this folder except this README is gitignored (see the root `.gitignore`) because these are private exports from Sawtooth Kitchen. Get the files from a teammate and put them in `data/sawtooth/`.

## `sawtooth/`

Toast POS exports from Kieran (Sawtooth Kitchen, Allen Street, Hanover). Each export covers a half-year, except the last, which ends on the export date (2026-10-21).

| Files | Periods | Granularity |
|---|---|---|
| `SalesSummary_<start>_<end>.xlsx` | 2025 H1, 2025 H2, 2026 H1, 2026-07-01 to 2026-10-21 | The `Sales by day` sheet has one row per day; every other sheet is a period total |
| `ProductMix_<start>_<end>.xlsx` | Same four periods, plus a 2022-09-11 to 2022-10-31 archive (older sheet layout) | Item-level quantities and sales, totaled over the whole period. No per-day item data |
| `sales-breakdown-*.csv` | Same four periods | Sales-category totals for the period, split by Service Type (Lunch, Dinner, Late Night, Brunch) |

Two of the CSVs cover the same period: `sales-breakdown-jan1-jun30-2025.csv` is split by Dining Option (Dine In, Take Out, Online Ordering), and `sales-breakdown-jan1-jun30-2025-2.csv` is split by Service Type. So there are five CSV files but only four periods.
