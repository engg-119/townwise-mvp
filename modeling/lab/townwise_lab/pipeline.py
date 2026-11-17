"""calibrate: a LabInput in, a LabResult out.

Runs two engines (design decision 8): the baseline engine (baseline.py) always, and the notebook's model (hybrid,
holiday multipliers, optional weekday regime) when the history spans MIN_HISTORY_DAYS. Both are backtested on the same
weeks (the model's quarterly refits, the baseline's weekly cutoffs, each week scored 28 and 7 days ahead), and the one
returned is the current run's engine unless the other's backtest weekly WAPE is at least 0.5 points lower
(choose_engine). The returned engine's backtest, six-month folds and comparison with the current published run make
the scorecard, with each engine's own figures beside them, and its run reaches today plus 91 days (forecast.run_end).
Nothing here logs or prints.
"""

import re

import numpy as np
import pandas as pd

from townwise_lab import backtest, baseline, compare, features, forecast, holidays, metrics, model, schema
from townwise_lab.forecast import iso

# From the first to the last history day: the span that always gives 12 horizon-28 backtest weeks with an 80% range,
# so the gate can judge the draft (GATE.minHistoryDays, decided by the owner on 2026-11-10 (spec D27), which the API checks before it starts
# a calibration). The first refit is up to 30 days after first day + 364, scoring starts up to 34 days after it, and the
# 12th week with a range is the 24th scored, ending 167 days after the first: 364 + 30 + 34 + 167. Pinned by
# test_min_history_days_always_gives_twelve_weeks_with_a_range.
MIN_HISTORY_DAYS = 595
HORIZON = 28  # the scorecard's horizon: each week forecast from a refit at least 28 days before its Monday
SHORT_HORIZON = 7
LONG_HORIZON = forecast.REACH_DAYS  # reported, never gated: each week forecast at least 91 days before its Monday
ENGINE_MARGIN = 0.005  # an engine switch needs the other's backtest weekly WAPE 0.5 points lower on the same weeks
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


def choose_engine(current: str | None, model_wape: float | None, baseline_wape: float) -> str:
    """The engine a calibration returns: the current run's (`current`) unless the other's backtest weekly WAPE is at
    least 0.5 points lower on the same weeks; with no current run, the model when it is 0.5 points lower than the
    baseline. A tie keeps the current engine. Without a model (`model_wape` None), the baseline."""
    if model_wape is None:
        return "baseline"
    lower = {"model": model_wape <= baseline_wape - ENGINE_MARGIN + 1e-12,
             "baseline": baseline_wape <= model_wape - ENGINE_MARGIN + 1e-12}
    if current is None:
        return "model" if lower["model"] else "baseline"
    other = "baseline" if current == "model" else "model"
    return other if lower[other] else current


def _folds(frame: pd.DataFrame, hist: pd.DataFrame, through: pd.Timestamp, base_cols: list[str],
           event_cols: list[str]) -> list[dict]:
    """The notebook's section 2 folds: each half-year forecast by one refit on every history day before it."""
    folds = []
    for train_through, start, stop in backtest.six_month_folds(hist.date.min(), through):
        days = forecast.backtest_predictions(frame, hist, [train_through], stop, base_cols, event_cols)
        if days.empty:
            continue
        folds.append(_fold(train_through, start, stop, metrics.weekly_totals(days)))
    return folds


def _baseline_folds(history: baseline.History, hist: pd.DataFrame, through: pd.Timestamp) -> list[dict]:
    """The same folds for the baseline: each half-year forecast from one cutoff, the day before it."""
    folds = []
    for train_through, start, stop in backtest.six_month_folds(hist.date.min(), through):
        rows = hist[hist.date.between(start, stop)]
        if rows.empty:
            continue
        mid = baseline.predict(history, train_through, rows.index).mid
        weeks = metrics.weekly_totals(pd.DataFrame({"date": rows.date, "actual": rows.guests, "mid": mid}))
        folds.append(_fold(train_through, start, stop, weeks))
    return folds


def _fold(train_through: pd.Timestamp, start: pd.Timestamp, stop: pd.Timestamp, weeks: pd.DataFrame) -> dict:
    return {"trainThrough": iso(train_through), "from": iso(start), "to": iso(stop), "weeks": len(weeks),
            "weeklyWape": metrics.weekly_wape(weeks), "weeksOver20": metrics.weeks_over_20(weeks)}


# Where an engine's weekly 80% bands are calibrated: None for the model, whose bands come from its own scored weeks with
# metrics.quantile_band (section 8); for the baseline, the origins whose window scores the whole of its weekly backtest
# and baseline.weekly_band (design decision 6, "Ranges").
Calibration = tuple[list[pd.Timestamp], metrics.Band] | None


def _week_errors(preds: pd.DataFrame, origins: list[pd.Timestamp], through: pd.Timestamp, horizon: int) -> pd.Series:
    """The weekly log errors, log(actual / forecast) by week start, of the weeks the window of `origins` scores at
    `horizon`, each forecast from a cutoff at least `horizon` days before its Monday."""
    weeks = metrics.weekly_totals(backtest.pick(preds, horizon, *backtest.score_window(origins, through, horizon)))
    return np.log(weeks.actual / weeks.pred)


def _past(own: pd.Series, preds: pd.DataFrame, through: pd.Timestamp, horizon: int,
          calibration: Calibration) -> tuple[pd.Series, metrics.Band]:
    """The weekly errors a band at `horizon` is drawn from, and the rule that draws it: `own` with np.quantile's
    percentiles for the model, the baseline's whole weekly backtest at that horizon with weekly_band for the baseline.
    Either way each band reads only weeks that ended at least `horizon` days before the week it is for."""
    if calibration is None:
        return own, metrics.quantile_band
    origins, rule = calibration
    return _week_errors(preds, origins, through, horizon), rule


def _backtest(preds: pd.DataFrame, origins: list[pd.Timestamp], through: pd.Timestamp,
              calibration: Calibration = None) -> dict | None:
    """One engine's backtest on the window the first of `origins` opens: its horizon-28 days, weeks and weekly log
    errors, the weekly errors its bands are drawn from and the rule (_past), its metrics at 28 and 7 days, and its
    weekly bias (the sum of forecast minus actual over the sum of actuals). None when no week is scored."""
    window = backtest.score_window(origins, through, HORIZON)
    days28 = backtest.pick(preds, HORIZON, *window)
    if days28.empty:
        return None
    weeks28 = metrics.weekly_totals(days28)
    log_err = np.log(weeks28.actual / weeks28.pred)
    past, rule = _past(log_err, preds, through, HORIZON, calibration)
    days7 = backtest.pick(preds, SHORT_HORIZON, *window)
    weeks7 = metrics.weekly_totals(days7)
    past7, _ = _past(np.log(weeks7.actual / weeks7.pred), preds, through, SHORT_HORIZON, calibration)
    return {"window": window, "days28": days28, "weeks28": weeks28, "log_err": log_err, "past": past, "rule": rule,
            "calibration": calibration,
            "scores": metrics.metrics(days28, weeks28, HORIZON, past, rule),
            "scores7": metrics.metrics(days7, weeks7, SHORT_HORIZON, past7, rule),
            "bias": float((weeks28.pred - weeks28.actual).sum() / weeks28.actual.sum())}


def _summary(bt: dict) -> dict:
    """An engine's figures in the scorecard's `engines`."""
    return {"weeks": len(bt["weeks28"]), "weeklyWape": bt["scores"]["weeklyWape"], "weeklyBias": bt["bias"],
            "coverage80": bt["scores"]["coverage80"]}


def _log_range(past: pd.Series, rule: metrics.Band) -> dict[str, float]:
    """The run's weekly range (log scale) from every past week by `rule`, always holding zero."""
    lo, hi = rule(past.to_numpy(dtype=float))
    return {"lo": float(min(lo, 0.0)), "hi": float(max(hi, 0.0))}


def _band_width(past: pd.Series, rule: metrics.Band) -> float:
    log_range = _log_range(past, rule)
    return log_range["hi"] - log_range["lo"]


def _horizon(preds: pd.DataFrame, origins: list[pd.Timestamp], through: pd.Timestamp, horizon: int,
             calibration: Calibration = None) -> tuple[dict | None, float | None]:
    """The backtest weeks forecast at least `horizon` days before their Monday, reported as {weeks, weeklyWape,
    coverage80}, and their weekly band's width (log scale); (None, None) with no such week."""
    days = backtest.pick(preds, horizon, *backtest.score_window(origins, through, horizon))
    if days.empty:
        return None, None
    weeks = metrics.weekly_totals(days)
    log_err = np.log(weeks.actual / weeks.pred)
    past, rule = _past(log_err, preds, through, horizon, calibration)
    bands = metrics.weekly_bands(log_err, horizon, past=past, rule=rule)
    inside = [band[0] <= e <= band[1] for e, band in zip(log_err, bands) if band is not None]
    return ({"weeks": len(weeks), "weeklyWape": metrics.weekly_wape(weeks),
             "coverage80": {"inside": int(sum(inside)), "weeks": len(inside)}}, _band_width(past, rule))


def calibrate(inp: dict, code_version: str) -> dict:
    """The LabResult for `inp`, its run named by `code_version` (the 40-character commit the lab runs).

    An input that breaks the contract comes back as ok false with invalid_input, and a history spanning less than
    baseline.MIN_HISTORY_DAYS (or with no week yet scored 28 days ahead) as not_enough_history. Anything else that goes
    wrong raises.
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

    through, today = pd.Timestamp(inp["dataThrough"]), pd.Timestamp(inp["today"])
    regime = None if inp["regimeStart"] is None else pd.Timestamp(inp["regimeStart"])
    frame = frame_of(inp)
    if regime is not None:
        frame = features.add_weekday_regime(frame, regime)
    hist = features.training_rows(frame, through)
    if hist.empty or (hist.date.max() - hist.date.min()).days < baseline.MIN_HISTORY_DAYS:
        return _failure(calibration_id, "not_enough_history")
    first, last = hist.date.min(), hist.date.max()
    base_cols, event_cols = features.base_columns(regime), features.event_columns(frame, hist.index)
    reach = forecast.reach_horizon(today, through)
    horizons = [SHORT_HORIZON, HORIZON, LONG_HORIZON] + ([reach] if reach is not None else [])

    # The model, at a 595-day span: refits every quarter, each week scored from the latest refit 28 (or 7) days
    # before its Monday
    model_bt = None
    if (last - first).days >= MIN_HISTORY_DAYS:
        origins = backtest.quarterly_origins(first, through)
        model_preds = forecast.backtest_predictions(frame, hist, origins, through, base_cols, event_cols)
        model_bt = _backtest(model_preds, origins, through)

    # The baseline, always, on the model's weeks when the model ran: weekly cutoffs, ranges from its daily errors
    history = baseline.prepare(frame, inp["calendar"], through)
    base_preds = baseline.backtest_predictions(history, through, horizons)
    window_origins = origins if model_bt is not None else [baseline.first_cutoff(history.first_day)]
    scored = backtest.pick(base_preds, HORIZON, *backtest.score_window(window_origins, through, HORIZON))
    if scored.empty:
        return _failure(calibration_id, "not_enough_history")
    daily_log_range = baseline.daily_log_range(scored)
    base_preds = baseline.ranged(base_preds, daily_log_range)
    base_bt = _backtest(base_preds, window_origins, through,
                        ([baseline.first_cutoff(history.first_day)], baseline.weekly_band))

    current = None if inp["champion"] is None else inp["champion"]["engine"]
    engine = choose_engine(current, None if model_bt is None else model_bt["scores"]["weeklyWape"],
                           base_bt["scores"]["weeklyWape"])
    bt, preds = (model_bt, model_preds) if engine == "model" else (base_bt, base_preds)
    days28, weeks28, log_err, scores, window = bt["days28"], bt["weeks28"], bt["log_err"], bt["scores"], bt["window"]

    # The run's ranges from every backtest day and week (section 9e). A weekly range that leaves out the forecast
    # itself would break the run file's low <= mid <= high, so it always holds zero. Past 28 days of lead they widen by
    # the longer horizons' weekly bands, never narrowing with lead.
    widen_k = metrics.choose_k(days28)
    log_range = _log_range(bt["past"], bt["rule"])
    width28 = _band_width(bt["past"], bt["rule"])
    horizon91, width91 = _horizon(preds, window_origins, through, LONG_HORIZON, bt["calibration"])
    horizon_reach, width_reach = (_horizon(preds, window_origins, through, reach, bt["calibration"])
                                  if reach is not None else (None, None))
    widening = []
    for first_lead, width in ((HORIZON + 1, width91), (LONG_HORIZON + 1, width_reach)):
        if width is not None:
            previous = widening[-1][1] if widening else 1.0
            widening.append((first_lead, max(previous, width / width28 if width28 > 0 else 1.0)))
    end = forecast.run_end(today, through, 0 if horizon91 is None else horizon91["weeks"],
                           None if horizon_reach is None else horizon_reach["weeks"])

    series = [{"week": iso(start), "actual": int(round(week.actual)), "mid": float(week.pred),
               "low": None if band is None else float(week.pred * np.exp(band[0])),
               "high": None if band is None else float(week.pred * np.exp(band[1]))}
              for (start, week), band in zip(weeks28.iterrows(),
                                             metrics.weekly_bands(log_err, HORIZON, past=bt["past"], rule=bt["rule"]))]
    scorecard = {
        "horizonDays": HORIZON,
        "engine": engine,
        "history": {"firstDate": iso(first), "lastDate": iso(last), "days": len(hist), "spanDays": (last - first).days},
        "backtest": {
            "from": iso(window[0]), "to": iso(window[1]),
            "origins": [iso(o) for o in (origins if engine == "model" else sorted(set(days28.refit)))],
            "weeks": len(weeks28), "weeksWithRange": scores["coverage80"]["weeks"],
            "metrics": scores, "metrics7": bt["scores7"],
            "weekdayMedianWeeklyWape": metrics.weekly_wape(metrics.weekly_totals(days28, value="weekday_median")),
            "weeklyBias": bt["bias"],
            "folds": (_folds(frame, hist, through, base_cols, event_cols) if engine == "model"
                      else _baseline_folds(history, hist, through)),
            "series": series,
        },
        "comparison": compare.compare(frame, hist, inp["champion"], window_origins, base_cols, event_cols,
                                      preds=preds, past=None if engine == "model" else bt["past"], rule=bt["rule"]),
        "engines": {"model": None if model_bt is None else _summary(model_bt), "baseline": _summary(base_bt)},
        "horizon91": horizon91,
        "horizonReach": horizon_reach,
    }
    run_backtest = {
        "from": iso(window[0]), "to": iso(window[1]), "weeks": len(weeks28),
        "weeklyTypicalErrorPct": round(scores["typicalWeek"] * 100, 1),
        "weeksOver20Pct": scores["weeksOver20"],  # a count of weeks, despite the name
        "weeklyRangePct": {"below": round(float(1 - np.exp(log_range["lo"])) * 100, 1),
                           "above": round(float(np.exp(log_range["hi"]) - 1) * 100, 1)},
    }
    widening_params = [{"fromLead": lead, "ratio": ratio} for lead, ratio in widening]
    if engine == "baseline":
        params = {
            "target": "guests", "engine": "baseline", "regimeStart": inp["regimeStart"],
            "levelDays": baseline.LEVEL_DAYS, "levelMinDays": baseline.LEVEL_MIN_DAYS,
            "shapeClamp": {"min": baseline.SHAPE_CLAMP[0], "max": baseline.SHAPE_CLAMP[1]},
            "calendarEffects": baseline.effects(history, through), "dailyLogRange": daily_log_range,
            "widenK": widen_k, "weeklyLogRange": log_range, "widening": widening_params, "horizonDays": HORIZON,
            "minPastWeeks": metrics.MIN_PAST_WEEKS, "floor": features.FLOOR,
        }
        run = baseline.run_file(history, frame, data_through=through, end=end, widen_k=widen_k,
                                daily_log_range=daily_log_range, weekly_log_range=log_range, widening=widening,
                                trained_from=first, made_at=inp["today"], code_version=code_version,
                                backtest_block=run_backtest)
        return _success(calibration_id, code_version, params, scorecard, run)

    # The model the run forecasts with: every history day, the level as of the cutoff, the regime where it has data
    fitted = features.limit_weekday_regime(features.add_recent_level(frame, through), hist.index)
    train = fitted.loc[hist.index]
    fit = model.hybrid_fit(fitted, train, base_cols, event_cols)
    big_night_lambda, _ = holidays.choose_big_night_lambda(fitted, train, base_cols, event_cols)
    lambdas = {"hol_big_night": int(big_night_lambda), "hol_halloween": holidays.HALLOWEEN_LAMBDA}
    effects = {k: float(v) for k, v in holidays.holiday_effects(fitted, train, fit, lambdas).items()}
    params = {
        "target": "guests", "baseCols": base_cols, "eventCols": event_cols, "regimeStart": inp["regimeStart"],
        "xgb": dict(model.XGB_PARAMS), "holidayLambdas": lambdas, "holidayEffects": effects, "widenK": widen_k,
        "weeklyLogRange": log_range, "widening": widening_params, "refitEveryMonths": backtest.REFIT_MONTHS,
        "horizonDays": HORIZON, "minPastWeeks": metrics.MIN_PAST_WEEKS, "floor": features.FLOOR,
    }
    run = forecast.run_file(fitted, fit, effects, widen_k, log_range, trained_from=first, data_through=through,
                            end=end, widening=widening, made_at=inp["today"], code_version=code_version,
                            backtest_block=run_backtest)
    return _success(calibration_id, code_version, params, scorecard, run)


def _success(calibration_id: str | None, code_version: str, params: dict, scorecard: dict, run: dict) -> dict:
    return {"schema": schema.RESULT_SCHEMA, "calibrationId": calibration_id, "ok": True, "codeVersion": code_version,
            "params": params, "scorecard": scorecard, "run": run}
