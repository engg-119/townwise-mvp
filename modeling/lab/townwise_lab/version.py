"""The model version a lab run names (the run file's model.version)."""

# The notebook's v5 (section 9f: hybrid, holiday multipliers, weekday regime) as the lab refits it: levels over a
# rolling year rather than a calendar year, holiday multipliers in the backtests, and ranges widened from them.
# v7 (autonomous-forecasts): the baseline engine beside it, the run through today plus 91 days, and the baseline's weekly
# ranges calibrated on its own earlier backtest weeks. The API's LAB_MODEL_VERSION (api/src/lab/input.ts) is held
# equal to this by a contract test, so a bump refits every location once.
MODEL_VERSION = "v7"
