"""The draft against the current published run (the champion) on held-out weeks both forecast: what the publish gate
(api/src/lab/gate.ts) reads."""

import numpy as np
import pandas as pd

from townwise_lab import backtest, metrics
from townwise_lab.forecast import backtest_predictions, iso

HORIZON = 28  # the challenger forecasts each week from a refit at least this many days before its Monday


def _scored(days: pd.DataFrame, weeks: pd.DataFrame, side: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """One side's days (date, weekday, actual, mid, lo, hi) and weeks (actual, pred, days) for metrics.metrics."""
    return (days[["date", "weekday", "actual"]].assign(mid=days[side], lo=days[f"{side}_lo"], hi=days[f"{side}_hi"]),
            weeks[["actual", "days"]].assign(pred=weeks[side]))


def compare(frame: pd.DataFrame, hist: pd.DataFrame, champion: dict | None, origins: list[pd.Timestamp],
            base_cols: list[str], event_cols: list[str], *, preds: pd.DataFrame | None = None,
            past: pd.Series | None = None, rule: metrics.Band = metrics.quantile_band,
            since: pd.Timestamp | None = None) -> dict | None:
    """The champion and the challenger's rolling backtest scored on the same weeks; None without a champion or without a
    comparable week.

    A week is comparable when it is one of the champion's full Monday-to-Sunday week rows, starts after its dataThrough,
    ends by the last history day, has no booked day (in the input or the champion), and every day the champion forecast
    open is a history day (guests, no closure note, no buyout) that the challenger forecast from a refit at least 28
    days before the Monday. Both are scored over the champion's open days: the champion's weekly forecast is its week
    row's mid, the challenger's the sum of its daily mids. The champion's 80% weekly range is the one it published (as
    the notebook's section 10 scores a frozen forecast); the challenger's is the past-only band from the whole
    horizon-28 backtest's weekly errors (section 8), on the window the first of `origins` opens. `preds` is the
    returned engine's backtest (pipeline.calibrate): the model's (forecast.backtest_predictions with the same origins
    and columns, which predicts only `hist` rows, so its end does not matter) or the baseline's weekly one
    (baseline.backtest_predictions, ranged), each refit picked as for the scorecard; without it, the model's is run
    here. `past`, `rule` and `since` are where the challenger's bands are drawn from (pipeline._past): by default its
    backtest weeks' own errors and np.quantile's percentiles; for the baseline, its whole weekly backtest,
    baseline.weekly_band and baseline.shaped_from (metrics.same_kind)."""
    if champion is None:
        return None
    end = hist.date.max()
    if preds is None:
        preds = backtest_predictions(frame, hist, origins, end, base_cols, event_cols)
    window = backtest.score_window(origins, end, HORIZON)
    backtest_weeks = metrics.weekly_totals(backtest.pick(preds, HORIZON, *window))
    log_err = np.log(backtest_weeks.actual / backtest_weeks.pred)
    past = log_err if past is None else past
    band_of = dict(zip(backtest_weeks.index, metrics.weekly_bands(log_err, HORIZON, past=past, rule=rule, since=since)))

    champion_through = pd.Timestamp(champion["dataThrough"])
    picked = backtest.pick(preds, HORIZON, champion_through + pd.Timedelta(days=1), end).set_index("date")
    guests = hist.set_index("date").guests
    booked = set(frame.date[frame.booked.astype(bool)])
    champion_days = {pd.Timestamp(d["date"]): d for d in champion["days"]}
    days, weeks = [], []
    for week in sorted(champion["weeks"], key=lambda w: w["from"]):
        dates = pd.date_range(week["from"], periods=7)
        if (dates[0].day_of_week != 0 or pd.Timestamp(week["to"]) != dates[-1] or dates[0] <= champion_through
                or dates[-1] > end or week["mid"] <= 0):
            continue
        if any(d not in champion_days or champion_days[d]["status"] == "booked" or d in booked for d in dates):
            continue
        open_dates = [d for d in dates if champion_days[d]["status"] == "open"]
        if not open_dates or any(d not in guests.index or d not in picked.index for d in open_dates):
            continue
        for d in open_dates:
            mine, theirs = picked.loc[d], champion_days[d]
            days.append({"date": d, "weekday": d.day_name(), "actual": guests[d], "champion": theirs["mid"],
                         "champion_lo": theirs["low"], "champion_hi": theirs["high"], "challenger": mine.mid,
                         "challenger_lo": mine.lo, "challenger_hi": mine.hi})
        weeks.append({"week": dates[0], "actual": sum(guests[d] for d in open_dates), "days": len(open_dates),
                      "champion": week["mid"], "low": week["low"], "high": week["high"],
                      "challenger": sum(picked.mid[d] for d in open_dates)})
    if not weeks:
        return None

    days, weeks = pd.DataFrame(days).astype({"actual": float}), pd.DataFrame(weeks).set_index("week")
    weeks = weeks.astype({"actual": float, "champion": float, "low": float, "high": float, "challenger": float})
    champion_metrics = metrics.metrics(*_scored(days, weeks, "champion"), HORIZON,
                                       np.log(weeks.actual / weeks.champion))
    champion_metrics["coverage80"] = {"inside": int(weeks.actual.between(weeks.low, weeks.high).sum()),
                                      "weeks": len(weeks)}
    challenger_metrics = metrics.metrics(*_scored(days, weeks, "challenger"), HORIZON, past, rule, since)

    series = []
    for start, week in weeks.iterrows():
        band = band_of.get(start)
        series.append({"week": iso(start), "actual": int(round(week.actual)), "champion": float(week.champion),
                       "challenger": float(week.challenger),
                       "challengerLow": None if band is None else float(week.challenger * np.exp(band[0])),
                       "challengerHigh": None if band is None else float(week.challenger * np.exp(band[1]))})
    return {
        "championRunId": champion["runId"],
        "championDataThrough": champion["dataThrough"],
        "from": iso(weeks.index[0]),
        "to": iso(weeks.index[-1] + pd.Timedelta(days=6)),
        "weeks": len(weeks),
        "champion": champion_metrics,
        "challenger": challenger_metrics,
        "series": series,
    }
