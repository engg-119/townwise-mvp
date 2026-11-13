Built from the synthetic dataset in data/synthetic, not a real bar's sales.

# Replay, 2025-05-01 through 2026-11-04

Both policies start from the written par. The forecast for an order uses only sales dated before that cutoff. The score uses held-out true demand, including drinks the historical rules lost. Bottle service is off.

The acceptance bar is fewer never-run-out stockout days and no more stock on hand. This run does not clear that bar. Never-run-out stockout days are 14 for the agent and 17 for the pars. Average units on hand are 5.13 for the agent and 3.93 for the pars.

## baseline

| Category | Stockout days / item | Fill rate | Days of supply | Units wasted | Liquor runs / month | Margin lost | Pour cost | Window error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bottles_cans | 4.12 | 97% | 5.8 | 0.0 | 0.00 | $211 | 22% | — |
| cocktail_ingredient | 15.33 | 97% | 5.6 | 0.0 | 0.00 | $0 | 11% | — |
| draft | 0.00 | 100% | 15.2 | 0.0 | 0.00 | $0 | 23% | — |
| liquor | 2.78 | 99% | 14.5 | 0.0 | 4.29 | $787 | 9% | — |

Never-run-out stockout days: 17. Average units on hand: 3.93.
Late orders: 0. Late-order cost: $0.

## agent

| Category | Stockout days / item | Fill rate | Days of supply | Units wasted | Liquor runs / month | Margin lost | Pour cost | Window error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bottles_cans | 3.75 | 98% | 6.7 | 0.0 | 0.00 | $207 | 22% | 21.7 |
| cocktail_ingredient | 15.33 | 97% | 5.6 | 0.0 | 0.00 | $0 | 11% | 24.3 |
| draft | 0.00 | 100% | 16.4 | 0.0 | 0.00 | $0 | 23% | 12.4 |
| liquor | 2.78 | 99% | 14.5 | 0.0 | 4.29 | $768 | 9% | — |

Never-run-out stockout days: 14. Average units on hand: 5.13.
Late orders: 0. Late-order cost: $0.

## Thursday orders moved to the next delivery

Every Thursday order arrives on the next delivery instead. That is 158 late orders and $1975 in late fees. Sizing the replacement order for the longer window prevents 0 never-run-out stockout days on this history. Late-path stockout days: 34 without the longer order, 34 with it.
