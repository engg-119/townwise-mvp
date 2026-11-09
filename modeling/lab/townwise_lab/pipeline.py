"""calibrate: a LabInput in, a LabResult out.

Fits the notebook's model (hybrid, holiday multipliers, optional weekday regime) on the location's whole history,
backtests it as the notebook did (rolling quarterly refits scored 28 and 7 days ahead, six-month folds), compares it
with the current published run, and writes the next 182 days as a run file. Nothing here logs or prints.
"""

import re

import numpy as np
import pandas as pd

from townwise_lab import backtest, compare, features, forecast, holidays, metrics, model, schema
from townwise_lab.forecast import iso

# From the first to the last history day: the gate's minimum for a first draft (GATE.minHistoryDays, a [CONFIRM] in
# spec D27), which the API also checks before it starts a calibration
MIN_HISTORY_DAYS = 420
HORIZON = 28  # the scorecard's horizon: each week forecast from a refit at least 28 days before its Monday
SHORT_HORIZON = 7
CODE_VERSION = re.compile(r"[0-9a-f]{40}")


def frame_of(inp: dict) -> pd.DataFrame:
    """The day frame (see features) for a valid LabInput: one ev_<group> column per event group it names, "one_off"
    included, and the holiday flags from the dates."""
    days = inp["days"]
    dates = pd.Series(pd.to_datetime([d["date"] for d in days]), name="date")
    columns = {"date": dates, "weekday": dates.dt.day_name(),
               "guests": [np.nan if d["guests"] is None else float(d["guests"]) for d in days],
               "term": [d["term"] for d in days], "week_of_term": [d["weekOfTerm"] for d in days]}
    for group in sorted({g for d in days for g in d["events"]}):
        columns[features.EVENT_PREFIX + group] = [int(group in d["events"]) for d in days]
    columns |= {"private_event": [int(d["privateEvent"]) for d in days], "closed": [d["closed"] for d in days],
                "booked": [d["booked"] for d in days]}
    frame = pd.DataFrame(columns)
    return pd.concat([frame, features.holiday_flags(frame.date)], axis=1)


def _failure(calibration_id: str | None, code: str) -> dict:
    return {"schema": schema.RESULT_SCHEMA, "calibrationId": calibration_id, "ok": False, "code": code}


def _folds(frame: pd.DataFrame, hist: pd.DataFrame, through: pd.Timestamp, base_cols: list[str],
           event_cols: list[str]) -> list[dict]:
    """The notebook's section 2 folds: each half-year forecast by one refit on every history day before it."""
    folds = []
    for train_through, start, stop in backtest.six_month_folds(hist.date.min(), through):
        days = forecast.backtest_predictions(frame, hist, [train_through], stop, base_cols, event_cols)
        if days.empty:
            continue
        weeks = metrics.weekly_totals(days)
        folds.append({"trainThrough": iso(train_through), "from": iso(start), "to": iso(stop), "weeks": len(weeks),
                      "weeklyWape": metrics.weekly_wape(weeks), "weeksOver20": metrics.weeks_over_20(weeks)})
    return folds


def calibrate(inp: dict, code_version: str) -> dict:
    """The LabResult for `inp`, its run named by `code_version` (the 40-character commit the lab runs).

    An input that breaks the contract comes back as ok false with invalid_input, and less than 420 days of history (or
    no week yet scored 28 days ahead) as not_enough_history. Anything else that goes wrong raises.
    """
    if not (isinstance(code_version, str) and CODE_VERSION.fullmatch(code_version)):
        raise ValueError("code_version is not a 40-character commit")
    calibration_id = inp.get("calibrationId") if isinstance(inp, dict) else None
    if not (isinstance(calibration_id, str) and schema.CALIBRATION_ID.fullmatch(calibration_id)):
        calibration_id = None
    try:
        schema.validate_input(inp)
    except schema.InputError:
        return _failure(calibration_id, "invalid_input")

    through = pd.Timestamp(inp["dataThrough"])
    regime = None if inp["regimeStart"] is None else pd.Timestamp(inp["regimeStart"])
    frame = frame_of(inp)
    if regime is not None:
        frame = features.add_weekday_regime(frame, regime)
    hist = features.training_rows(frame, through)
    if hist.empty or (hist.date.max() - hist.date.min()).days < MIN_HISTORY_DAYS:
        return _failure(calibration_id, "not_enough_history")
    first, last = hist.date.min(), hist.date.max()
    base_cols, event_cols = features.base_columns(regime), features.event_columns(frame, hist.index)

    # Backtest: refits every quarter, each week scored from the latest refit 28 (or 7) days before its Monday
    origins = backtest.quarterly_origins(first, through)
    preds = forecast.backtest_predictions(frame, hist, origins, through, base_cols, event_cols)
    window = backtest.score_window(origins, through, HORIZON)
    days28 = backtest.pick(preds, HORIZON, *window)
    if days28.empty:
        return _failure(calibration_id, "not_enough_history")
    weeks28 = metrics.weekly_totals(days28)
    log_err = np.log(weeks28.actual / weeks28.pred)
    scores = metrics.metrics(days28, weeks28, HORIZON, log_err)
    days7 = backtest.pick(preds, SHORT_HORIZON, *window)
    weeks7 = metrics.weekly_totals(days7)
    scores7 = metrics.metrics(days7, weeks7, SHORT_HORIZON, np.log(weeks7.actual / weeks7.pred))

    # The run's ranges from every backtest day and week (section 9e). A weekly range that leaves out the forecast
    # itself would break the run file's low <= mid <= high, so it always holds zero.
    widen_k = metrics.choose_k(days28)
    q10, q90 = np.quantile(log_err, [0.1, 0.9])
    log_range = {"lo": float(min(q10, 0.0)), "hi": float(max(q90, 0.0))}

    # The model the run forecasts with: every history day, the level as of the cutoff, the regime where it has data
    fitted = features.limit_weekday_regime(features.add_recent_level(frame, through), hist.index)
    train = fitted.loc[hist.index]
    fit = model.hybrid_fit(fitted, train, base_cols, event_cols)
    big_night_lambda, _ = holidays.choose_big_night_lambda(fitted, train, base_cols, event_cols)
    lambdas = {"hol_big_night": int(big_night_lambda), "hol_halloween": holidays.HALLOWEEN_LAMBDA}
    effects = {k: float(v) for k, v in holidays.holiday_effects(fitted, train, fit, lambdas).items()}

    series = [{"week": iso(start), "actual": int(round(week.actual)), "mid": float(week.pred),
               "low": None if band is None else float(week.pred * np.exp(band[0])),
               "high": None if band is None else float(week.pred * np.exp(band[1]))}
              for (start, week), band in zip(weeks28.iterrows(), metrics.weekly_bands(log_err, HORIZON))]
    scorecard = {
        "horizonDays": HORIZON,
        "history": {"firstDate": iso(first), "lastDate": iso(last), "days": len(hist), "spanDays": (last - first).days},
        "backtest": {
            "from": iso(window[0]), "to": iso(window[1]), "origins": [iso(o) for o in origins],
            "weeks": len(weeks28), "weeksWithRange": scores["coverage80"]["weeks"],
            "metrics": scores, "metrics7": scores7,
            "weekdayMedianWeeklyWape": metrics.weekly_wape(metrics.weekly_totals(days28, value="weekday_median")),
            "folds": _folds(frame, hist, through, base_cols, event_cols),
            "series": series,
        },
        "comparison": compare.compare(frame, hist, inp["champion"], origins, base_cols, event_cols),
    }
    run_backtest = {
        "from": iso(window[0]), "to": iso(window[1]), "weeks": len(weeks28),
        "weeklyTypicalErrorPct": round(scores["typicalWeek"] * 100, 1),
        "weeksOver20Pct": scores["weeksOver20"],  # a count of weeks, despite the name
        "weeklyRangePct": {"below": round(float(1 - np.exp(log_range["lo"])) * 100, 1),
                           "above": round(float(np.exp(log_range["hi"]) - 1) * 100, 1)},
    }
    params = {
        "target": "guests", "baseCols": base_cols, "eventCols": event_cols, "regimeStart": inp["regimeStart"],
        "xgb": dict(model.XGB_PARAMS), "holidayLambdas": lambdas, "holidayEffects": effects, "widenK": widen_k,
        "weeklyLogRange": log_range, "refitEveryMonths": backtest.REFIT_MONTHS, "horizonDays": HORIZON,
        "minPastWeeks": metrics.MIN_PAST_WEEKS, "floor": features.FLOOR,
    }
    run = forecast.run_file(fitted, fit, effects, widen_k, log_range, trained_from=first, data_through=through,
                            made_at=inp["today"], code_version=code_version, backtest_block=run_backtest)
    return {"schema": schema.RESULT_SCHEMA, "calibrationId": calibration_id, "ok": True, "codeVersion": code_version,
            "params": params, "scorecard": scorecard, "run": run}
