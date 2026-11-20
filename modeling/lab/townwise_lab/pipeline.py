"""calibrate: a LabInput in, a LabResult out.

Runs two engines (design decision 8): the baseline engine (baseline.py) always, and the notebook's model (hybrid,
holiday multipliers, optional weekday regime) when the history spans MIN_HISTORY_DAYS. Both are backtested on the same
weeks (the model's quarterly refits, the baseline's weekly cutoffs, each week scored 28 and 7 days ahead), and the one
returned is the current run's engine unless the other's backtest weekly WAPE is at least 0.5 points lower, that win is
significant week by week (switch_p_value, D69), and it passes the gate's coverage, bias, weekday-bias and weekday-median
checks (choose_engine, passes); with no current run the baseline is returned unless the model wins the same way. The returned engine's backtest, six-month folds and
comparison with the current published run make the scorecard, with each engine's own figures beside them, and its run
reaches today plus 91 days (its forecast tier, D42) and, when that tier is backed, on to today plus 365 (its outlook,
D52; forecast.run_end), with the outlook's ranges by outlook_ratios. The result also carries backtestDays (D72), the
backtest's out-of-sample day-by-day predictions for the Calendar's past days. Nothing here logs or prints.
"""

import re

import numpy as np
import pandas as pd
from scipy import stats

from townwise_lab import backtest, baseline, compare, features, forecast, holidays, metrics, model, schema
from townwise_lab.forecast import iso

# From the first to the last history day: the span that always gives 12 horizon-28 backtest weeks with an 80% range,
# so the gate can judge the draft (GATE.minHistoryDays, decided by the owner on 2026-11-10 (spec D27): the gate's check
# on a first model forecast. The API starts any calibration from GATE.baselineMinHistoryDays, 230 days, and under this
# span only the baseline runs). The first refit is up to 30 days after first day + 364, scoring starts up to 34 days after it, and the
# 12th week with a range is the 24th scored, ending 167 days after the first: 364 + 30 + 34 + 167. Pinned by
# test_min_history_days_always_gives_twelve_weeks_with_a_range.
MIN_HISTORY_DAYS = 595
MIN_LEARNING_DAYS = 28  # held-out days a fold needs before its learning curve is worth reading
HORIZON = 28  # the scorecard's horizon: each week forecast from a refit at least 28 days before its Monday
SHORT_HORIZON = 7
LONG_HORIZON = forecast.FORECAST_DAYS  # reported, never gated: each week forecast at least 91 days before its Monday
CONFORMAL_MIN = 9  # independent windows an outlook's 80% conformal rank needs (as baseline.weekly_band: n of 9 or more)
ENGINE_MARGIN = 0.005  # an engine switch needs the other's backtest weekly WAPE 0.5 points lower on the same weeks
# D69: and a one-sided Diebold-Mariano test on those weeks' absolute errors under this p-value [CONFIRM]. A 0.5-point
# gap over about 40 noisy weeks is often luck; the test asks whether the other engine won week after week.
SWITCH_ALPHA = 0.10
SWITCH_LAGS = HORIZON // 7  # weeks forecast from the same refit share errors: Newey-West over 4 weeks of overlap
# The publish gate's absolute checks an engine must pass to be returned over the other (api/src/lab/gate.ts GATE)
WEEKS_WITH_RANGE_MIN = 12  # GATE.heldOutWeeksMin
COVERAGE_MIN, COVERAGE_MAX = 0.65, 0.95  # GATE.coverageMin and GATE.coverageMax
BASELINE_BIAS_MAX = 0.05  # GATE.baselineBiasMax
WEEKDAY_BIAS_ALLOWANCE = 0.02  # GATE.weekdayBiasAllowance: a model's weekday bias over the current run's recorded one
MEDIAN_MARGIN = 0.005  # GATE.wapeMargin: the model's backtest weekly WAPE must be this far under its weekday median's
BACKTEST_DAYS_BACK = 400  # D72: backtestDays reach this far before the data cutoff, as far back as the forecast route
# reads
CODE_VERSION = re.compile(r"[0-9a-f]{40}")


def frame_of(inp: dict) -> pd.DataFrame:
    """The day frame (see features) for a valid LabInput: one ev_<group> column per event group it names, "one_off"
    included, the holiday flags from the dates, and features.PRIVATE_ON_CLOSED (forecast.private_on_closed_weekday),
    which training_rows reads, so every engine and backtest leaves out the same private days (D70)."""
    days = inp["days"]
    dates = pd.Series(pd.to_datetime([d["date"] for d in days]), name="date")
    columns = {"date": dates, "weekday": dates.dt.day_name(),
               "guests": [np.nan if d["guests"] is None else float(d["guests"]) for d in days],
               "term": [d["term"] for d in days], "week_of_term": [d["weekOfTerm"] for d in days]}
    for group in sorted({g for d in days for g in d["events"]}):
        columns[features.EVENT_PREFIX + group] = [int(group in d["events"]) for d in days]
    columns |= {"private_event": [int(d["privateEvent"]) for d in days], "closed": [d["closed"] for d in days],
                "booked": [d["booked"] for d in days], "party": [d["party"] for d in days]}
    frame = pd.DataFrame(columns)
    frame = pd.concat([frame, features.holiday_flags(frame.date)], axis=1)
    frame[features.PRIVATE_ON_CLOSED] = forecast.private_on_closed_weekday(frame)
    return frame


def _failure(calibration_id: str | None, code: str) -> dict:
    return {"schema": schema.RESULT_SCHEMA, "calibrationId": calibration_id, "ok": False, "code": code}


def passes(bt: dict, engine: str, recorded_bias: float | None = None) -> bool:
    """Whether an engine's backtest passes the gate's absolute checks (gate.ts `absolute`): 12 or more weeks with an
    80% range, 65% to 95% of them inside it, a backtest weekly WAPE under the engine's own weekday median's
    (`median_wape`, from its training medians on its own cutoffs, so the two engines' differ): the model's at least 0.5
    points under, the baseline's strictly under; for the model a mean absolute weekday bias no more than 2 points over
    `recorded_bias` (the current run's recorded backtest, champion.recordedWeekdayBiasMeanAbs; None with no current
    run or one without a recorded backtest, when there is nothing to compare with); and for the baseline a weekly bias
    within 5 points either way. Each comparison is written as the gate writes it."""
    coverage = bt["scores"]["coverage80"]
    if coverage["weeks"] < WEEKS_WITH_RANGE_MIN:
        return False
    if not COVERAGE_MIN <= coverage["inside"] / coverage["weeks"] <= COVERAGE_MAX:
        return False
    wape = bt["scores"]["weeklyWape"]
    if engine == "model":
        weekday_bias = bt["scores"]["weekdayBiasMeanAbs"]
        if recorded_bias is not None and weekday_bias > recorded_bias + WEEKDAY_BIAS_ALLOWANCE + 1e-12:
            return False
        return not wape > bt["median_wape"] - MEDIAN_MARGIN
    return abs(bt["bias"]) <= BASELINE_BIAS_MAX + 1e-12 and wape < bt["median_wape"]


def switch_p_value(incumbent_err: pd.Series, challenger_err: pd.Series, lags: int = SWITCH_LAGS) -> float:
    """D69: the one-sided Diebold-Mariano p-value that the challenger's weekly absolute errors are lower than the
    incumbent's on the same weeks (the two series' shared index): the mean loss difference over its Newey-West
    (Bartlett) standard error, read against Student's t with T - 1 degrees of freedom. 1.0, never significant, with fewer
    than WEEKS_WITH_RANGE_MIN shared weeks or differences that do not vary."""
    weeks = incumbent_err.index.intersection(challenger_err.index)
    d = (incumbent_err[weeks] - challenger_err[weeks]).to_numpy(dtype=float)
    T = len(d)
    if T < WEEKS_WITH_RANGE_MIN:
        return 1.0
    c = d - d.mean()
    var = float(c @ c) / T
    for lag in range(1, min(lags, T - 1) + 1):
        var += 2 * (1 - lag / (lags + 1)) * float(c[lag:] @ c[:-lag]) / T
    if not var > 1e-18:
        return 1.0
    return float(stats.t.sf(d.mean() / np.sqrt(var / T), T - 1))


def choose_engine(current: str | None, model_wape: float | None, baseline_wape: float, *, model_ok: bool = True,
                  baseline_ok: bool = True, model_significant: bool = False,
                  baseline_significant: bool = False) -> str:
    """The engine a calibration returns: the current run's (`current`) unless the other's backtest weekly WAPE is at
    least 0.5 points lower on the same weeks, that win is significant (`model_significant`, `baseline_significant`:
    switch_p_value under SWITCH_ALPHA, D69) and the other passes its checks (`model_ok`, `baseline_ok`: passes); with
    no current run, the model when it wins the baseline that way, else the baseline, but the other when that one fails
    its checks and the other passes them. A tie or an insignificant win keeps the current engine, and a current engine
    that fails is kept (its run stays published until it lapses; then there is no current run). Without a model
    (`model_wape` None), the baseline."""
    if model_wape is None:
        return "baseline"
    ok = {"model": model_ok, "baseline": baseline_ok}
    lower = {"model": model_wape <= baseline_wape - ENGINE_MARGIN + 1e-12 and model_significant,
             "baseline": baseline_wape <= model_wape - ENGINE_MARGIN + 1e-12 and baseline_significant}
    if current is None:
        winner = "model" if lower["model"] else "baseline"
        other = "baseline" if winner == "model" else "model"
        return other if not ok[winner] and ok[other] else winner
    other = "baseline" if current == "model" else "model"
    return other if lower[other] and ok[other] else current


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


def _learning(frame: pd.DataFrame, hist: pd.DataFrame, through: pd.Timestamp, base_cols: list[str],
              event_cols: list[str]) -> dict | None:
    """How the trees learned, round by round, on the latest half-year fold with at least MIN_LEARNING_DAYS held-out
    days: their loss on the days before the fold (training) and on the fold's days (validation), which they never saw.
    Ratios only (model.learning_curve). None when no fold is long enough."""
    for train_through, start, stop in reversed(backtest.six_month_folds(hist.date.min(), through)):
        fr = features.limit_weekday_regime(features.add_recent_level(frame, train_through),
                                           hist.index[hist.date <= train_through])
        h = fr.loc[hist.index]
        train, valid = h[h.date <= train_through], h[h.date.between(start, stop)]
        if train.empty or len(valid) < MIN_LEARNING_DAYS:
            continue
        train_loss, valid_loss = model.learning_curve(fr, train, valid, base_cols, event_cols)
        return {"trainThrough": iso(train_through), "from": iso(start), "to": iso(stop), "trainDays": len(train),
                "validDays": len(valid), "metric": "mae_log",
                "train": [round(float(v), 5) for v in train_loss], "valid": [round(float(v), 5) for v in valid_loss]}
    return None


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
# metrics.quantile_band (section 8); for the baseline, the origins whose window scores the whole of its weekly backtest,
# baseline.weekly_band, and baseline.shaped_from, from which its forecasts have last year's shape to read, so a band for
# a week forecast with it is drawn from earlier weeks forecast with it, the latest earlier ones filling in to half a year
# (metrics.same_kind; design decision 6, "Ranges").
Calibration = tuple[list[pd.Timestamp], metrics.Band, pd.Timestamp | None] | None


def _week_errors(preds: pd.DataFrame, origins: list[pd.Timestamp], through: pd.Timestamp, horizon: int) -> pd.Series:
    """The weekly log errors, log(actual / forecast) by week start, of the weeks the window of `origins` scores at
    `horizon`, each forecast from a cutoff at least `horizon` days before its Monday."""
    weeks = metrics.weekly_totals(backtest.pick(preds, horizon, *backtest.score_window(origins, through, horizon)))
    return np.log(weeks.actual / weeks.pred)


def _past(own: pd.Series, preds: pd.DataFrame, through: pd.Timestamp, horizon: int,
          calibration: Calibration) -> tuple[pd.Series, metrics.Band, pd.Timestamp | None]:
    """The weekly errors a band at `horizon` is drawn from, the rule that draws it and the date its kind of forecast
    changes (metrics.same_kind): `own` with np.quantile's percentiles and no change for the model, the baseline's whole
    weekly backtest at that horizon with weekly_band and baseline.shaped_from for the baseline. Either way each band
    reads only weeks that ended at least `horizon` days before the week it is for."""
    if calibration is None:
        return own, metrics.quantile_band, None
    origins, rule, since = calibration
    return _week_errors(preds, origins, through, horizon), rule, since


def _backtest(preds: pd.DataFrame, origins: list[pd.Timestamp], through: pd.Timestamp,
              calibration: Calibration = None) -> dict | None:
    """One engine's backtest on the window the first of `origins` opens: its horizon-28 days, weeks and weekly log
    errors, the weekly errors its bands are drawn from and the rule (_past), its metrics at 28 and 7 days, its
    weekly bias (the sum of forecast minus actual over the sum of actuals) and its weekday median's weekly WAPE on the
    same days. None when no week is scored."""
    window = backtest.score_window(origins, through, HORIZON)
    days28 = backtest.pick(preds, HORIZON, *window)
    if days28.empty:
        return None
    weeks28 = metrics.weekly_totals(days28)
    log_err = np.log(weeks28.actual / weeks28.pred)
    past, rule, since = _past(log_err, preds, through, HORIZON, calibration)
    days7 = backtest.pick(preds, SHORT_HORIZON, *window)
    weeks7 = metrics.weekly_totals(days7)
    past7, _, _ = _past(np.log(weeks7.actual / weeks7.pred), preds, through, SHORT_HORIZON, calibration)
    return {"window": window, "days28": days28, "weeks28": weeks28, "log_err": log_err, "past": past, "rule": rule,
            "since": since, "calibration": calibration,
            "scores": metrics.metrics(days28, weeks28, HORIZON, past, rule, since),
            "scores7": metrics.metrics(days7, weeks7, SHORT_HORIZON, past7, rule, since),
            "bias": float((weeks28.pred - weeks28.actual).sum() / weeks28.actual.sum()),
            "median_wape": metrics.weekly_wape(metrics.weekly_totals(days28, value="weekday_median"))}


def _backtest_days(days28: pd.DataFrame, engine: str, fill: pd.DataFrame, through: pd.Timestamp) -> list[dict]:
    """D72: the backtest's day-by-day predictions, for the Calendar's past days with no forecast. The returned engine's
    horizon-28 days (`days28`), then the baseline's (`fill`, its horizon-28 days over its own whole window) on dates
    the engine has none, from `through` less BACKTEST_DAYS_BACK on, by date. Each day is out of sample: its
    dataThrough is the refit it was forecast from, which trained on no later day. Whole guests, low <= mid <= high."""
    picks = pd.concat([days28.assign(engine=engine), fill[~fill.date.isin(days28.date)].assign(engine="baseline")])
    picks = picks[picks.date >= through - pd.Timedelta(days=BACKTEST_DAYS_BACK)].sort_values("date")
    out = []
    for row in picks.itertuples():
        mid = max(int(round(row.mid)), 0)
        out.append({"date": iso(row.date), "engine": row.engine, "dataThrough": iso(row.refit),
                    "low": max(min(int(round(row.lo)), mid), 0), "mid": mid, "high": max(int(round(row.hi)), mid)})
    return out


def _summary(bt: dict) -> dict:
    """An engine's figures in the scorecard's `engines`."""
    return {"weeks": len(bt["weeks28"]), "weeklyWape": bt["scores"]["weeklyWape"], "weeklyBias": bt["bias"],
            "coverage80": bt["scores"]["coverage80"]}


def _log_range(past: pd.Series, rule: metrics.Band, horizon: int, since: pd.Timestamp | None,
               through: pd.Timestamp) -> dict[str, float]:
    """The run's weekly range (log scale) by `rule` from the past weeks a band for a forecast from `through` reads
    (metrics.same_kind with `since`), always holding zero."""
    every = np.ones(len(past), dtype=bool)
    chosen = metrics.same_kind(pd.DatetimeIndex(past.index), every, through, horizon, since)
    lo, hi = rule(past.to_numpy(dtype=float)[chosen])
    return {"lo": float(min(lo, 0.0)), "hi": float(max(hi, 0.0))}


def _band_width(past: pd.Series, rule: metrics.Band, horizon: int, since: pd.Timestamp | None,
                through: pd.Timestamp) -> float:
    log_range = _log_range(past, rule, horizon, since, through)
    return log_range["hi"] - log_range["lo"]


def _horizon(preds: pd.DataFrame, origins: list[pd.Timestamp], through: pd.Timestamp, horizon: int,
             calibration: Calibration = None) -> tuple[dict | None, dict[str, float] | None]:
    """The backtest weeks forecast at least `horizon` days before their Monday, reported as {weeks, weeklyWape,
    coverage80}, and their weekly band's log range (_log_range); (None, None) with no such week."""
    days = backtest.pick(preds, horizon, *backtest.score_window(origins, through, horizon))
    if days.empty:
        return None, None
    weeks = metrics.weekly_totals(days)
    log_err = np.log(weeks.actual / weeks.pred)
    past, rule, since = _past(log_err, preds, through, horizon, calibration)
    bands = metrics.weekly_bands(log_err, horizon, past=past, rule=rule, since=since)
    inside = [band[0] <= e <= band[1] for e, band in zip(log_err, bands) if band is not None]
    return ({"weeks": len(weeks), "weeklyWape": metrics.weekly_wape(weeks),
             "coverage80": {"inside": int(sum(inside)), "weeks": len(inside)}},
            _log_range(past, rule, horizon, since, through))


def _width(log_range: dict[str, float] | None) -> float | None:
    return None if log_range is None else log_range["hi"] - log_range["lo"]


def _outlook_band(own: pd.Series, every: pd.Series, horizon: int) -> tuple[float, float] | None:
    """The weekly log band (-m, m) an outlook horizon's ratio is read from (D52 decision 5, as built in release B), or
    None when the backtest has too few weeks at that lead to read one, and the growth floor alone sets the ratio.

    m is a size of the engine's weekly misses at that lead, |log(actual / forecast)|, the same on both sides: which way
    a level drifts in the next year is not read from which way it drifted before. `own` holds the backtest weeks
    forecast the way the run is (_outlook_errors), `every` all of them. Weeks at a lead of H days, forecast from cutoffs
    a week apart, share most of their H days of drift, so n of them count as n * 7 / H independent windows (n_eff):

    - n_eff of CONFORMAL_MIN or more: the split conformal 80% rank on n_eff windows, ceil(0.8 (n_eff + 1)) of them,
      read as the same share of the n weeks' misses (in whole numbers, so no rounding moves it);
    - n_eff of 1 or more but under CONFORMAL_MIN: the largest miss, since so few windows hold no 80% rank;
    - n_eff under 1: the larger of the own weeks' largest miss and the conformal 80% rank of every backtest week at
      that lead, of either kind, from forecast.MIN_HORIZON_WEEKS of them; with fewer, None. The rank treats correlated
      weeks as exchangeable, which the reasoning above rejects, so it is only a floor under the own weeks' largest
      miss: then the band never widens when the own weeks reach one window and the floor drops away, unless a new
      week is a new largest miss. (Every week's largest miss instead widened two-year outlooks past the R2 fallback,
      and the own weeks alone failed held-out histories: design.md, release B build notes.)"""
    misses = np.sort(own.abs().to_numpy(dtype=float))
    n = len(misses)
    if 7 * n >= CONFORMAL_MIN * horizon:
        windows = -(-8 * (7 * n + horizon) // (10 * horizon))  # ceil(0.8 (n_eff + 1))
        m = float(misses[min(-(-windows * horizon // 7), n) - 1])  # that many of n_eff windows, as a rank of n weeks
        return -m, m
    if 7 * n >= horizon:
        m = float(misses[-1])
        return -m, m
    if len(every) >= forecast.MIN_HORIZON_WEEKS:
        values = np.sort(every.abs().to_numpy(dtype=float))
        m = float(values[min(-(-8 * (len(values) + 1) // 10), len(values)) - 1])
        m = max(m, float(misses[-1])) if n else m
        return -m, m
    return None


def _outlook_errors(preds: pd.DataFrame, origins: list[pd.Timestamp], through: pd.Timestamp, horizon: int,
                    calibration: Calibration) -> tuple[pd.Series, pd.Series]:
    """An outlook horizon's weekly log errors over the whole backtest (_week_errors): those forecast the way the run
    is, and all of them. For the baseline, whose run made on or after baseline.shaped_from reads last year's shape,
    its own are the weeks forecast from a cutoff on or after that day (metrics.same_kind's later kind); for the model,
    and for a baseline run made before that day, every week."""
    every = _week_errors(preds, origins, through, horizon)
    since = None if calibration is None else calibration[2]
    if since is None or through < since:
        return every, every
    return every[every.index >= since + pd.Timedelta(days=horizon)], every


def outlook_ratios(previous: tuple[int, float], backtests: list[tuple[int, dict | None, tuple[pd.Series, pd.Series]]],
                   log_range28: dict[str, float]) -> list[dict]:
    """The outlook horizons' reports with their ratios (D52 decision 5, as built in release B). `previous` is the
    forecast tier's last horizon and its ratio (91, or the reach when sales lag); `backtests` each outlook horizon in
    order with its _horizon report and its (own, every) weekly log errors (_outlook_errors). An outlook week's range is
    the same on both sides, the 28-day weekly range's wider side times its ratio (forecast.assemble). For each horizon
    H after P with ratio r_P, the ratio is the growth floor r_P * sqrt(H / P), widened to m over that side when
    _outlook_band reads a band (-m, m) at H (basis growth_or_backtest), else the floor alone (basis growth). So no
    ratio is under the one before, and a week whose widest day has a lead of H is at least as wide as (-m, m)."""
    reports = []
    last_horizon, last_ratio = previous
    side = max(-log_range28["lo"], log_range28["hi"])
    for horizon, report, (own, every) in backtests:
        weeks = 0 if report is None else report["weeks"]
        growth = last_ratio * float(np.sqrt(horizon / last_horizon))
        band = _outlook_band(own, every, horizon)
        if band is None:
            ratio, basis = growth, "growth"
        else:
            ratio, basis = max(growth, band[1] / side if side > 0 else 1.0), "growth_or_backtest"
        reports.append({"horizon": horizon, "weeks": weeks, "weeklyWape": None if report is None else report["weeklyWape"],
                        "coverage80": {"inside": 0, "weeks": 0} if report is None else report["coverage80"],
                        "ratio": ratio, "basis": basis})
        last_horizon, last_ratio = horizon, ratio
    return reports


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
    terms_through = None if inp["termsThrough"] is None else pd.Timestamp(inp["termsThrough"])
    reach = forecast.reach_horizon(today, through)
    horizons = [SHORT_HORIZON, HORIZON, LONG_HORIZON] + ([reach] if reach is not None else []) + list(
        forecast.OUTLOOK_HORIZONS)

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
                        ([baseline.first_cutoff(history.first_day)], baseline.weekly_band,
                         baseline.shaped_from(history.first_day)))

    current = None if inp["champion"] is None else inp["champion"]["engine"]
    recorded_bias = None if inp["champion"] is None else inp["champion"]["recordedWeekdayBiasMeanAbs"]
    significant = {"model": False, "baseline": False}
    if model_bt is not None:  # D69: each engine's weekly absolute errors on the weeks both scored
        err = {name: (b["weeks28"].pred - b["weeks28"].actual).abs() for name, b in (("model", model_bt),
                                                                                       ("baseline", base_bt))}
        significant = {"model": switch_p_value(err["baseline"], err["model"]) < SWITCH_ALPHA,
                       "baseline": switch_p_value(err["model"], err["baseline"]) < SWITCH_ALPHA}
    engine = choose_engine(current, None if model_bt is None else model_bt["scores"]["weeklyWape"],
                           base_bt["scores"]["weeklyWape"],
                           model_ok=model_bt is not None and passes(model_bt, "model", recorded_bias),
                           baseline_ok=passes(base_bt, "baseline", recorded_bias),
                           model_significant=significant["model"], baseline_significant=significant["baseline"])
    bt, preds = (model_bt, model_preds) if engine == "model" else (base_bt, base_preds)
    days28, weeks28, log_err, scores, window = bt["days28"], bt["weeks28"], bt["log_err"], bt["scores"], bt["window"]
    # D72: the Calendar's past days, the baseline filling in before the model's window when the model is returned
    backtest_days = _backtest_days(days28, engine, backtest.pick(
        base_preds, HORIZON, *backtest.score_window([baseline.first_cutoff(history.first_day)], through, HORIZON)),
        through)

    # The run's ranges from every backtest day and week (section 9e). A weekly range that leaves out the forecast
    # itself would break the run file's low <= mid <= high, so it always holds zero. Past 28 days of lead they widen by
    # the longer horizons' weekly bands, never narrowing with lead.
    widen_k = metrics.choose_k(days28)
    log_range = _log_range(bt["past"], bt["rule"], HORIZON, bt["since"], through)
    width28 = _band_width(bt["past"], bt["rule"], HORIZON, bt["since"], through)
    horizon91, range91 = _horizon(preds, window_origins, through, LONG_HORIZON, bt["calibration"])
    horizon_reach, range_reach = (_horizon(preds, window_origins, through, reach, bt["calibration"])
                                  if reach is not None else (None, None))
    widening = []
    tier_horizon = LONG_HORIZON
    for first_lead, horizon, width in ((HORIZON + 1, LONG_HORIZON, _width(range91)),
                                       (LONG_HORIZON + 1, reach, _width(range_reach))):
        if width is not None:
            previous = widening[-1][1] if widening else 1.0
            widening.append((first_lead, max(previous, width / width28 if width28 > 0 else 1.0)))
            tier_horizon = horizon
    # Past the forecast tier, the outlook (D52): each outlook horizon's backtest on the weeks its band is drawn from
    # (the baseline's whole weekly backtest, the model's own window), and its ratio by outlook_ratios
    band_origins = window_origins if bt["calibration"] is None else bt["calibration"][0]
    horizon_outlook = outlook_ratios(
        (tier_horizon, widening[-1][1] if widening else 1.0),
        [(h, _horizon(preds, band_origins, through, h, bt["calibration"])[0],
          _outlook_errors(preds, band_origins, through, h, bt["calibration"])) for h in forecast.OUTLOOK_HORIZONS],
        log_range)
    tier_end = forecast.forecast_end(today, through)
    outlook = forecast.Outlook(tier_end, horizon_outlook[0]["ratio"], horizon_outlook[1]["ratio"])
    end = forecast.run_end(today, through, 0 if horizon91 is None else horizon91["weeks"],
                           None if horizon_reach is None else horizon_reach["weeks"],
                           terms_through if engine == "model" else None)

    series = [{"week": iso(start), "actual": int(round(week.actual)), "mid": float(week.pred),
               "low": None if band is None else float(week.pred * np.exp(band[0])),
               "high": None if band is None else float(week.pred * np.exp(band[1]))}
              for (start, week), band in zip(weeks28.iterrows(),
                                             metrics.weekly_bands(log_err, HORIZON, past=bt["past"], rule=bt["rule"],
                                                                  since=bt["since"]))]
    scorecard = {
        "horizonDays": HORIZON,
        "engine": engine,
        "history": {"firstDate": iso(first), "lastDate": iso(last), "days": len(hist), "spanDays": (last - first).days},
        "backtest": {
            "from": iso(window[0]), "to": iso(window[1]),
            "origins": [iso(o) for o in (origins if engine == "model" else sorted(set(days28.refit)))],
            "weeks": len(weeks28), "weeksWithRange": scores["coverage80"]["weeks"],
            "metrics": scores, "metrics7": bt["scores7"],
            "weekdayMedianWeeklyWape": bt["median_wape"],
            "weeklyBias": bt["bias"],
            "folds": (_folds(frame, hist, through, base_cols, event_cols) if engine == "model"
                      else _baseline_folds(history, hist, through)),
            "series": series,
        },
        "comparison": compare.compare(frame, hist, inp["champion"], window_origins, base_cols, event_cols,
                                      preds=preds, past=None if engine == "model" else bt["past"], rule=bt["rule"],
                                      since=bt["since"]),
        "engines": {"model": None if model_bt is None else _summary(model_bt), "baseline": _summary(base_bt)},
        "horizon91": horizon91,
        "horizonReach": horizon_reach,
        "horizonOutlook": horizon_outlook,
    }
    run_backtest = {
        "from": iso(window[0]), "to": iso(window[1]), "weeks": len(weeks28),
        "weeklyTypicalErrorPct": round(scores["typicalWeek"] * 100, 1),
        "weeksOver20Pct": scores["weeksOver20"],  # a count of weeks, despite the name
        "weeklyRangePct": {"below": round(float(1 - np.exp(log_range["lo"])) * 100, 1),
                           "above": round(float(np.exp(log_range["hi"]) - 1) * 100, 1)},
    }
    # The forecast tier's entries, then the outlook's anchors: r_182 from the first outlook day's lead (it holds to 182
    # days), r_365 from 365 (the lead it is reached at; ratios only grow between and after)
    widening_params = [{"fromLead": lead, "ratio": ratio} for lead, ratio in widening] + [
        {"fromLead": (tier_end - through).days + 1, "ratio": outlook.r182, "horizon": forecast.OUTLOOK_HORIZONS[0]},
        {"fromLead": forecast.OUTLOOK_HORIZONS[1], "ratio": outlook.r365, "horizon": forecast.OUTLOOK_HORIZONS[1]}]
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
                                backtest_block=run_backtest, outlook=outlook)
        return _success(calibration_id, code_version, params, scorecard, run, backtest_days)

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
                            backtest_block=run_backtest, outlook=outlook)
    # Only a model run carries how its trees learned: the baseline is a rule, with nothing fitted round by round
    scorecard["learning"] = _learning(frame, hist, through, base_cols, event_cols)
    return _success(calibration_id, code_version, params, scorecard, run, backtest_days)


def _success(calibration_id: str | None, code_version: str, params: dict, scorecard: dict, run: dict,
             backtest_days: list[dict]) -> dict:
    return {"schema": schema.RESULT_SCHEMA, "calibrationId": calibration_id, "ok": True, "codeVersion": code_version,
            "params": params, "scorecard": scorecard, "run": run, "backtestDays": backtest_days}
