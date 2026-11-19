"""The model version a lab run names (the run file's model.version)."""

# The notebook's v5 (section 9f: hybrid, holiday multipliers, weekday regime) as the lab refits it: levels over a
# rolling year rather than a calendar year, holiday multipliers in the backtests, and ranges widened from them.
# v7 (autonomous-forecasts): the baseline engine beside it, the run through today plus 91 days, and the baseline's weekly
# ranges calibrated on its own earlier backtest weeks.
# v8 (autonomous-forecasts 7.1): the baseline's weekly band for a week forecast with last year's shape is drawn from
# earlier weeks forecast with it, the latest earlier weeks filling in to half a year (design decision 6, "Weekly ranges
# by kind of forecast").
# v9 (2026-11-18): a closed weekday ignores dates under a tenth of their week's median guests (forecast.served), so a
# private party rung as a check or two on a closed Sunday or Monday no longer reopens the weekday.
# v10 (forecast-year-outlook, D52): the run reaches today plus 365 days past its forecast tier, with the outlook's
# ranges, the baseline's shape from two years back past 357 days of lead, and the model's outlook stopping at the
# town's last researched term. The API's LAB_MODEL_VERSION (api/src/lab/input.ts) is held equal to this by a contract
# test, so a bump refits every location once.
MODEL_VERSION = "v10"
