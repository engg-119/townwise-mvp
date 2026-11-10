"""The lab's pipeline on the synthetic fixture: the LabResult contract, the forecast window's rules, the comparison with
the current published run, and the golden files the API's contract test reads."""

import copy
import json
import math
import re
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fixture import CHAMPION_THROUGH, REGIME_START, synthetic_champion, synthetic_input

from townwise_lab import backtest, compare, features, forecast, metrics, model, pipeline, schema, version

CODE = "0123456789abcdef0123456789abcdef01234567"
GOLDEN = Path(__file__).resolve().parent / "golden"
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
REASON_KINDS = {"weekday", "term", "event", "holiday", "level", "closure", "booking"}
REF = re.compile(r"[a-z0-9][a-z0-9:-]{0,119}")

METRICS_KEYS = {"weeklyWape", "dailyWape", "typicalWeek", "weeksOver20", "worstWeek", "coverage80", "dailyCoverage80",
                "weekdayBias", "weekdayBiasMeanAbs"}
PARAMS_KEYS = {"target", "baseCols", "eventCols", "regimeStart", "xgb", "holidayLambdas", "holidayEffects", "widenK",
               "weeklyLogRange", "refitEveryMonths", "horizonDays", "minPastWeeks", "floor"}
RUN_KEYS = {"schema", "metric", "model", "trainingSource", "trainedFrom", "dataThrough", "madeAt", "frozen", "interval",
            "backtest", "days", "weeks"}


# Shapes and the API's run file rules (api/src/forecasts/file.ts), mirrored so a break shows here first

def is_date(value) -> bool:
    if not (isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
        return False
    date.fromisoformat(value)
    return True


def is_int(value) -> bool:
    return type(value) is int


def is_num(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def day(text: str) -> date:
    return date.fromisoformat(text)


def check_metrics(m: dict) -> None:
    assert set(m) == METRICS_KEYS
    for key in ("weeklyWape", "dailyWape", "typicalWeek", "worstWeek", "weekdayBiasMeanAbs"):
        assert is_num(m[key]) and m[key] >= 0, key
    assert is_int(m["weeksOver20"])
    assert set(m["coverage80"]) == {"inside", "weeks"}
    assert is_int(m["coverage80"]["inside"]) and is_int(m["coverage80"]["weeks"])
    assert 0 <= m["coverage80"]["inside"] <= m["coverage80"]["weeks"]
    assert m["dailyCoverage80"] is None or (is_num(m["dailyCoverage80"]) and 0 <= m["dailyCoverage80"] <= 1)
    assert list(m["weekdayBias"]) == WEEKDAYS
    assert all(v is None or is_num(v) for v in m["weekdayBias"].values())


def run_file_issues(run: dict, today: str) -> list[str]:
    """The run file rules the API checks a lab run against (checkLabRunFile), as paths and codes."""
    issues = []
    add = issues.append
    if run["trainedFrom"] > run["dataThrough"] or run["dataThrough"] > run["madeAt"]:
        add("dates_out_of_order")
    if run["madeAt"] > today:
        add("made_in_future")
    bt = run["backtest"]
    if bt is not None:
        if not (bt["from"] <= bt["to"] <= run["madeAt"]):
            add("backtest.to")
        if not (is_int(bt["weeks"]) and 1 <= bt["weeks"] <= 520):
            add("backtest.weeks")
        if not (is_int(bt["weeksOver20Pct"]) and 0 <= bt["weeksOver20Pct"] <= bt["weeks"]):
            add("backtest.weeksOver20Pct")
        if not (is_num(bt["weeklyTypicalErrorPct"]) and 0 <= bt["weeklyTypicalErrorPct"] <= 100):
            add("backtest.weeklyTypicalErrorPct")
        wr = bt["weeklyRangePct"]
        if wr is not None and not (set(wr) == {"below", "above"} and is_num(wr["below"]) and 0 <= wr["below"] <= 100
                                   and is_num(wr["above"]) and 0 <= wr["above"] <= 1000):
            add("backtest.weeklyRangePct")
    if not 1 <= len(run["days"]) <= 400:
        add("days.length")
    if len(run["weeks"]) > 60:
        add("weeks.length")

    status_of = {}
    for i, d in enumerate(run["days"]):
        at = f"days[{i}]"
        if set(d) != {"date", "status", "low", "mid", "high", "baseline", "reasons"} or not is_date(d["date"]):
            add(f"{at}.shape")
            continue
        if d["date"] in status_of:
            add(f"{at}.duplicate_date")
        status_of[d["date"]] = d["status"]
        if d["date"] <= run["dataThrough"]:
            add(f"{at}.not_after_data")
        elif (day(d["date"]) - day(run["dataThrough"])).days > 400:
            add(f"{at}.too_far_ahead")
        numbers = [d["low"], d["mid"], d["high"]]
        if d["status"] == "open":
            if not all(is_num(v) and 0 <= v <= 20_000 for v in numbers + [d["baseline"]]):
                add(f"{at}.numbers_required")
            elif not d["low"] <= d["mid"] <= d["high"]:
                add(f"{at}.order")
        elif d["status"] in ("closed", "booked"):
            if any(v is not None for v in numbers + [d["baseline"]]):
                add(f"{at}.numbers_not_allowed")
        else:
            add(f"{at}.status")
        if len(d["reasons"]) > 6:
            add(f"{at}.reasons")
        for r, reason in enumerate(d["reasons"]):
            if set(reason) != {"kind", "ref", "effectPct"} or reason["kind"] not in REASON_KINDS:
                add(f"{at}.reasons[{r}]")
            elif reason["ref"] is not None and (reason["kind"] not in ("term", "event", "holiday")
                                                or not REF.fullmatch(reason["ref"])):
                add(f"{at}.reasons[{r}].ref")
            elif reason["effectPct"] is not None:
                add(f"{at}.reasons[{r}].effectPct")

    covered = set()
    for i, w in enumerate(run["weeks"]):
        at = f"weeks[{i}]"
        if not (is_num(w["low"]) and is_num(w["mid"]) and is_num(w["high"]) and 0 <= w["low"] <= w["mid"] <= w["high"]
                <= 140_000):
            add(f"{at}.numbers")
        start, end = day(w["from"]), day(w["to"])
        if start > end or start - timedelta(days=start.weekday()) != end - timedelta(days=end.weekday()):
            add(f"{at}.week_span")
            continue
        dates = [(start + timedelta(days=k)).isoformat() for k in range((end - start).days + 1)]
        if covered & set(dates):
            add(f"{at}.week_overlap")
        covered |= set(dates)
        if any(d not in status_of for d in dates):
            add(f"{at}.week_day_missing")
            continue
        if w["openDays"] != sum(status_of[d] == "open" for d in dates):
            add(f"{at}.openDays")
    return issues


def finite_everywhere(value) -> bool:
    if isinstance(value, dict):
        return all(finite_everywhere(v) for v in value.values())
    if isinstance(value, list):
        return all(finite_everywhere(v) for v in value)
    if isinstance(value, float):
        return math.isfinite(value)
    return value is None or type(value) in (str, int, bool)


# How far the golden result may sit from this machine's. XGBoost's row and column sampling differs between builds:
# macOS arm64 against Linux x86_64 (CI and the job) moved 699 of 886 floats, the largest by 2.4%, and one count of
# weeks inside their range by one week. Structure, dates, statuses and reasons did not move.
GOLDEN_REL, GOLDEN_ABS = 0.05, 0.01
EDGE_COUNTS = ("inside", "weeksOver20", "weeksOver20Pct")  # a week on its range's edge can land either side


def assert_close(actual, expected, path: str = "result", rel: float = 1e-9, abs_: float = 1e-12,
                 edge_slack: int = 0) -> None:
    """Equal in every key, string, flag and count; floats within `rel` (or `abs_`); counts named in EDGE_COUNTS within
    `edge_slack`. The defaults are for two results from this machine."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and list(actual) == list(expected), path
        for key in expected:
            assert_close(actual[key], expected[key], f"{path}.{key}", rel, abs_, edge_slack)
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), path
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_close(a, e, f"{path}[{i}]", rel, abs_, edge_slack)
    elif type(expected) is float:
        assert type(actual) is float and math.isclose(actual, expected, rel_tol=rel, abs_tol=abs_), path
    elif type(expected) is int and path.rsplit(".", 1)[-1] in EDGE_COUNTS:
        assert type(actual) is int and abs(actual - expected) <= edge_slack, path
    else:
        assert type(actual) is type(expected) and actual == expected, path


def statuses_of(inp: dict) -> dict[str, str]:
    frame = pipeline.frame_of(inp)
    status = forecast.statuses(frame, pd.Timestamp(inp["dataThrough"]))
    return dict(zip(frame.date[status.index].dt.strftime("%Y-%m-%d"), status))


def input_day(inp: dict, when: str) -> dict:
    return next(d for d in inp["days"] if d["date"] == when)


@pytest.fixture(scope="session")
def lab_input() -> dict:
    return synthetic_input(0)


@pytest.fixture(scope="session")
def result(lab_input) -> dict:
    return pipeline.calibrate(copy.deepcopy(lab_input), CODE)


@pytest.fixture(scope="session")
def regime_result(lab_input) -> dict:
    inp = copy.deepcopy(lab_input)
    inp["regimeStart"], inp["champion"] = REGIME_START.strftime("%Y-%m-%d"), None
    return pipeline.calibrate(inp, CODE)


def messy_input(lab_input: dict) -> dict:
    """The fixture made messier (Review Focus 4): days with no row, zero-guest days, closure notes, buyouts with and
    without guests, Wednesdays closed for the last ten weeks, a two-week closure and events with no group."""
    inp = copy.deepcopy(lab_input)
    rng = np.random.default_rng(7)
    through = inp["dataThrough"]
    past = [d for d in inp["days"] if d["date"] <= through]
    for d in past[1:-1]:  # the first and last days keep their guests, as the API's bounds say
        u = rng.random()
        if u < 0.08:
            d["guests"] = None
        elif u < 0.11:
            d["guests"] = 0
        elif u < 0.13:
            d["closed"] = True
        elif u < 0.15:
            d["privateEvent"] = d["booked"] = True
        elif u < 0.16:
            d["privateEvent"] = d["booked"] = True
            d["guests"] = None
    wednesdays_from = (day(through) - timedelta(days=70)).isoformat()
    for d in past:
        if day(d["date"]).weekday() == 2 and d["date"] >= wednesdays_from:
            d["guests"] = None
        if "2025-01-13" <= d["date"] <= "2025-01-26":
            d["guests"], d["closed"] = None, True
    for d in inp["days"][::37]:
        d["events"] = sorted(set(d["events"]) | {"one_off"})
    return inp


@pytest.fixture(scope="session")
def messy(lab_input) -> tuple[dict, dict]:
    inp = messy_input(lab_input)
    return inp, pipeline.calibrate(copy.deepcopy(inp), CODE)


def test_result_matches_contract(result, lab_input):
    assert list(result) == ["schema", "calibrationId", "ok", "codeVersion", "params", "scorecard", "run"]
    assert result["schema"] == schema.RESULT_SCHEMA == "townwise.lab-result/1"
    assert schema.INPUT_SCHEMA == "townwise.lab-input/1"
    assert result["calibrationId"] == lab_input["calibrationId"]
    assert result["ok"] is True and result["codeVersion"] == CODE
    json.dumps(result, allow_nan=False)

    params = result["params"]
    assert set(params) == PARAMS_KEYS
    assert params["target"] == "guests" and params["regimeStart"] is None
    assert params["baseCols"] == ["weekday", "recent_level", "term"]
    assert params["eventCols"] == ["ev_test-town:festival", "ev_test-town:home-football", "private_event",
                                   "week_of_term", "weekday"]
    assert params["xgb"] == model.XGB_PARAMS
    assert set(params["holidayLambdas"]) == {"hol_big_night", "hol_halloween"}
    assert params["holidayLambdas"]["hol_big_night"] in (0, 1, 3, 10) and params["holidayLambdas"]["hol_halloween"] == 3
    assert set(params["holidayEffects"]) == {"hol_big_night", "hol_halloween"}
    assert all(is_num(v) for v in params["holidayEffects"].values())
    assert is_num(params["widenK"]) and 1 <= params["widenK"] <= 3
    assert set(params["weeklyLogRange"]) == {"lo", "hi"}
    assert is_num(params["weeklyLogRange"]["lo"]) and is_num(params["weeklyLogRange"]["hi"])
    assert params["weeklyLogRange"]["lo"] <= 0 <= params["weeklyLogRange"]["hi"]
    assert (params["refitEveryMonths"], params["horizonDays"], params["minPastWeeks"], params["floor"]) == (3, 28, 8, 1)

    card = result["scorecard"]
    assert list(card) == ["horizonDays", "history", "backtest", "comparison"] and card["horizonDays"] == 28
    history = card["history"]
    assert set(history) == {"firstDate", "lastDate", "days", "spanDays"}
    assert is_date(history["firstDate"]) and is_date(history["lastDate"])
    assert is_int(history["days"]) and is_int(history["spanDays"])
    assert history["spanDays"] == (day(history["lastDate"]) - day(history["firstDate"])).days >= pipeline.MIN_HISTORY_DAYS

    bt = card["backtest"]
    assert set(bt) == {"from", "to", "origins", "weeks", "weeksWithRange", "metrics", "metrics7",
                       "weekdayMedianWeeklyWape", "folds", "series"}
    assert is_date(bt["from"]) and is_date(bt["to"]) and all(is_date(o) for o in bt["origins"]) and bt["origins"]
    assert is_int(bt["weeks"]) and is_int(bt["weeksWithRange"]) and 0 < bt["weeksWithRange"] <= bt["weeks"]
    check_metrics(bt["metrics"])
    check_metrics(bt["metrics7"])
    assert bt["metrics"]["coverage80"]["weeks"] == bt["weeksWithRange"]
    assert is_num(bt["weekdayMedianWeeklyWape"])
    assert bt["folds"]
    for fold in bt["folds"]:
        assert set(fold) == {"trainThrough", "from", "to", "weeks", "weeklyWape", "weeksOver20"}
        assert all(is_date(fold[k]) for k in ("trainThrough", "from", "to"))
        assert is_int(fold["weeks"]) and is_int(fold["weeksOver20"]) and is_num(fold["weeklyWape"])
    assert len(bt["series"]) == bt["weeks"]
    for row in bt["series"]:
        assert set(row) == {"week", "actual", "mid", "low", "high"}
        assert is_date(row["week"]) and is_int(row["actual"]) and is_num(row["mid"])
        assert (row["low"] is None) == (row["high"] is None)
        assert row["low"] is None or (is_num(row["low"]) and is_num(row["high"]) and row["low"] <= row["high"])

    cmp = card["comparison"]
    assert set(cmp) == {"championRunId", "championDataThrough", "from", "to", "weeks", "champion", "challenger",
                        "series"}
    assert cmp["championRunId"] == lab_input["champion"]["runId"]
    assert cmp["championDataThrough"] == lab_input["champion"]["dataThrough"]
    assert is_date(cmp["from"]) and is_date(cmp["to"]) and is_int(cmp["weeks"]) and cmp["weeks"] >= 12
    check_metrics(cmp["champion"])
    check_metrics(cmp["challenger"])
    for row in cmp["series"]:
        assert set(row) == {"week", "actual", "champion", "challenger", "challengerLow", "challengerHigh"}
        assert is_int(row["actual"]) and is_num(row["champion"]) and is_num(row["challenger"])
        assert (row["challengerLow"] is None) == (row["challengerHigh"] is None)

    run = result["run"]
    assert set(run) == RUN_KEYS
    assert run["schema"] == "townwise.forecast-run/1" and run["metric"] == "guests"
    assert run["model"] == {"family": "hybrid_linear_xgboost", "version": version.MODEL_VERSION, "notebookCommit": CODE}
    assert version.MODEL_VERSION == "v6"
    assert run["trainingSource"] == "townwise_lab" and run["frozen"] is None
    assert run["interval"] == {"level": 0.8, "widened": True}
    assert run["trainedFrom"] == history["firstDate"]
    assert run["dataThrough"] == lab_input["dataThrough"] and run["madeAt"] == lab_input["today"]
    assert set(run["backtest"]) == {"from", "to", "weeks", "weeklyTypicalErrorPct", "weeksOver20Pct", "weeklyRangePct"}


def test_run_file_obeys_api_rules(result, lab_input):
    run = result["run"]
    assert run_file_issues(run, lab_input["today"]) == []
    through = day(lab_input["dataThrough"])
    assert [d["date"] for d in run["days"]] == [(through + timedelta(days=k)).isoformat()
                                               for k in range(1, forecast.HORIZON_DAYS + 1)]
    assert forecast.HORIZON_DAYS == 182
    assert {d["status"] for d in run["days"]} == {"open", "closed", "booked"}
    # Every day of the window is in exactly one week
    assert sum((day(w["to"]) - day(w["from"])).days + 1 for w in run["weeks"]) == len(run["days"])
    lo, hi = result["params"]["weeklyLogRange"]["lo"], result["params"]["weeklyLogRange"]["hi"]
    for w in run["weeks"]:
        mids = [d["mid"] for d in run["days"] if w["from"] <= d["date"] <= w["to"] and d["status"] == "open"]
        assert w["mid"] == pytest.approx(sum(mids), rel=1e-12)
        assert w["low"] == pytest.approx(w["mid"] * math.exp(lo))
        assert w["high"] == pytest.approx(w["mid"] * math.exp(hi))


def test_closed_weekday_and_holiday_rules(result, lab_input):
    days = {d["date"]: d for d in result["run"]["days"]}
    booked = {d["date"] for d in lab_input["days"] if d["booked"]}
    closed_note = {d["date"] for d in lab_input["days"] if d["closed"]}
    mondays = [d for when, d in days.items() if day(when).weekday() == 0 and when not in booked]
    assert len(mondays) > 20
    assert all(d["status"] == "closed" and d["reasons"][0]["kind"] == "closure" for d in mondays)
    holidays_closed = ["2025-11-27", "2025-12-24", "2025-12-25", "2026-01-01"]  # last year's had no sales row
    assert all(days[h]["status"] == "closed" and days[h]["reasons"][0]["kind"] == "closure" for h in holidays_closed)
    others = [when for when in days
              if day(when).weekday() != 0 and when not in holidays_closed + sorted(booked | closed_note)]
    assert all(days[when]["status"] == "open" for when in others)
    assert all(days[when]["status"] == "closed" for when in closed_note if when in days)

    # Closed on a holiday only when its last occurrence had no guests
    inp = copy.deepcopy(lab_input)
    input_day(inp, "2024-12-25")["guests"] = 40
    status = statuses_of(inp)
    assert status["2025-12-25"] == "open" and status["2025-12-24"] == "closed" and status["2025-11-27"] == "closed"

    # A weekday is closed when none of its last 8 dates had guests, counting only weeks with guests on another day
    inp = copy.deepcopy(lab_input)
    thursdays = [d for d in inp["days"] if d["date"] <= inp["dataThrough"] and day(d["date"]).weekday() == 3][-9:]
    assert thursdays[0]["guests"] and thursdays[0]["guests"] > 0
    for d in thursdays[1:]:
        d["guests"] = None
    status = statuses_of(inp)
    future_thursdays = [when for when in status if day(when).weekday() == 3
                        and when not in holidays_closed + sorted(booked | closed_note)]  # Thanksgiving is a Thursday
    assert future_thursdays and all(status[when] == "closed" for when in future_thursdays)
    week_of_last = day(thursdays[-1]["date"]) - timedelta(days=3)
    for d in inp["days"]:
        if week_of_last <= day(d["date"]) <= week_of_last + timedelta(days=6):
            d["guests"] = None  # a week with no guests at all: not evidence about Thursdays
    status = statuses_of(inp)
    assert all(status[when] == "open" for when in future_thursdays)


def test_a_closing_holiday_with_no_past_occurrence_stays_open():
    dates = pd.Series(pd.date_range("2025-06-01", "2025-07-10"))
    frame = pd.DataFrame({"date": dates, "weekday": dates.dt.day_name(), "guests": np.where(dates <= "2025-06-30", 20.0,
                                                                                            np.nan),
                          "closed": False, "booked": False})
    frame = pd.concat([frame, features.holiday_flags(frame.date)], axis=1)
    status = forecast.statuses(frame, pd.Timestamp("2025-06-30"))
    assert frame.date[status.index].tolist() == list(pd.date_range("2025-07-01", "2025-07-10"))
    assert (status == "open").all()  # July 4 included: no earlier July 4 says the place closes


def test_open_days_take_the_holiday_multipliers_and_ranges_widened_by_k(lab_input):
    frame, hist, _, base_cols, event_cols = _prepared(lab_input)
    through = pd.Timestamp(lab_input["dataThrough"])
    fitted = features.add_recent_level(frame, through)
    fit = model.hybrid_fit(fitted, fitted.loc[hist.index], base_cols, event_cols)
    common = dict(trained_from=hist.date.min(), data_through=through, made_at=lab_input["today"], code_version=CODE,
                  backtest_block=None)
    log_range = {"lo": -0.1, "hi": 0.2}
    plain = forecast.run_file(fitted, fit, {"hol_big_night": 0.0, "hol_halloween": 0.0}, 1.0, log_range, **common)
    lifted = forecast.run_file(fitted, fit, {"hol_big_night": 0.3, "hol_halloween": 0.0}, 1.0, log_range, **common)
    wide = forecast.run_file(fitted, fit, {"hol_big_night": 0.0, "hol_halloween": 0.0}, 2.0, log_range, **common)
    big_nights = set(frame.date[frame.hol_big_night.eq(1) & (frame.date > through)].dt.strftime("%Y-%m-%d"))
    linear, X = fit.base[0.5]
    checked = 0
    for p, h, w in zip(plain["days"], lifted["days"], wide["days"]):
        if p["status"] != "open":
            continue
        checked += 1
        factor = math.exp(0.3) if p["date"] in big_nights else 1.0  # every quantile scales by the holiday's effect
        assert (h["low"], h["mid"], h["high"]) == pytest.approx(
            (p["low"] * factor, p["mid"] * factor, p["high"] * factor))
        assert w["mid"] == p["mid"]  # k widens the range around the median, on the log scale
        assert math.log(w["high"] / w["mid"]) == pytest.approx(2 * math.log(p["high"] / p["mid"]))
        assert math.log(w["low"] / w["mid"]) == pytest.approx(2 * math.log(max(p["low"], 0.5) / p["mid"]))
        row = frame.index[frame.date == pd.Timestamp(p["date"])]
        assert p["baseline"] == pytest.approx(max(float(linear.predict(X.loc[row])[0]), 0.0))  # no multiplier, no range
        assert h["baseline"] == p["baseline"]
    assert checked > 100 and big_nights & {d["date"] for d in plain["days"] if d["status"] == "open"}


def test_bounded_keeps_the_median_positive_and_inside_its_range():
    lo, mid, hi = (pd.Series([5.0, 9.0, -3.0, 2.0]), pd.Series([10.0, 8.0, -2.0, 0.4]),
                   pd.Series([15.0, 7.0, -1.0, 0.2]))
    b_lo, b_mid, b_hi = forecast.bounded(lo, mid, hi)
    assert b_mid.tolist() == [10.0, 8.0, 1.0, 1.0]  # at least FLOOR guests
    assert b_lo.tolist() == [5.0, 8.0, 0.0, 1.0]  # never above the median, never below zero
    assert b_hi.tolist() == [15.0, 8.0, 1.0, 1.0]  # never below the median (separate quantile fits can cross)
    w_lo, w_hi = metrics.widen(b_mid, b_lo, b_hi, 3.0)
    assert np.isfinite(w_lo).all() and np.isfinite(w_hi).all() and (w_lo <= b_mid).all() and (b_mid <= w_hi).all()


def test_booked_days_have_no_numbers_and_reason_booking(result, lab_input):
    booked = {d["date"] for d in lab_input["days"] if d["booked"] and d["date"] > lab_input["dataThrough"]}
    assert booked
    run_booked = [d for d in result["run"]["days"] if d["status"] == "booked"]
    assert {d["date"] for d in run_booked} == booked
    for d in run_booked:
        assert (d["low"], d["mid"], d["high"], d["baseline"]) == (None, None, None, None)
        assert d["reasons"][0] == {"kind": "booking", "ref": None, "effectPct": None}
        assert not {"weekday", "closure"} & {r["kind"] for r in d["reasons"]}

    # A buyout wins over every closing rule: a closed weekday, a closure note, a closing holiday
    inp = copy.deepcopy(lab_input)
    for when in ("2025-11-03", "2025-11-05", "2025-12-25"):  # a Monday, a Wednesday with a closure note, Christmas
        d = input_day(inp, when)
        d["privateEvent"] = d["booked"] = True
    input_day(inp, "2025-11-05")["closed"] = True
    status = statuses_of(inp)
    assert [status[w] for w in ("2025-11-03", "2025-11-05", "2025-12-25")] == ["booked"] * 3


def test_reasons_name_status_term_holiday_and_event_groups(messy):
    inp, res = messy
    by_date = {d["date"]: d for d in inp["days"]}
    frame = pipeline.frame_of(inp)
    flags = features.holiday_flags(frame.date).set_axis(frame.date.dt.strftime("%Y-%m-%d"))
    seen_one_off = seen_ref = False
    for d in res["run"]["days"]:
        source = by_date[d["date"]]
        kinds = [{"open": "weekday", "closed": "closure", "booked": "booking"}[d["status"]]]
        refs = [None]
        if source["term"] != "interim":
            kinds.append("term")
            refs.append(None)
        if flags.loc[d["date"]].any():
            kinds.append("holiday")
            refs.append(None)
        for group in source["events"]:
            kinds.append("event")
            refs.append(None if group == "one_off" else group)
        assert [(r["kind"], r["ref"], r["effectPct"]) for r in d["reasons"]] == list(zip(kinds, refs, [None] * 6))
        seen_one_off |= "one_off" in source["events"]
        seen_ref |= any(r is not None for r in refs)
    assert seen_one_off and seen_ref


def test_messy_history_gives_finite_valid_output(messy):
    inp, res = messy
    assert res["ok"] is True
    assert finite_everywhere(res)
    json.dumps(res, allow_nan=False)
    assert run_file_issues(res["run"], inp["today"]) == []
    status = {d["date"]: d["status"] for d in res["run"]["days"]}
    assert all(s != "open" for when, s in status.items() if day(when).weekday() == 2)  # Wednesdays now closed
    assert "ev_one_off" in res["params"]["eventCols"]
    # Training left out every day with no guests, a closure note or a buyout
    frame = pipeline.frame_of(inp)
    hist = features.training_rows(frame, pd.Timestamp(inp["dataThrough"]))
    assert res["scorecard"]["history"]["days"] == len(hist)
    assert hist.guests.gt(0).all() and not hist.closed.any() and not hist.booked.any()


def _weeks_with_range(first: pd.Timestamp, span: int) -> int:
    """Backtest weeks with an 80% range for history running every day for `span` days from `first`, by the lab's own
    origin, window and band rules."""
    through = first + pd.Timedelta(days=span)
    origins = backtest.quarterly_origins(first, through)
    if not origins:
        return 0
    start, end = backtest.score_window(origins, through, pipeline.HORIZON)
    starts = pd.date_range(start, end - pd.Timedelta(days=6), freq="7D")
    return metrics.weekly_band_coverage(pd.Series(np.zeros(len(starts))), starts, starts + pd.Timedelta(days=6),
                                        pipeline.HORIZON)[1]


def test_min_history_days_always_gives_twelve_weeks_with_a_range():
    # The gate's 12 weeks (api/src/lab/gate.ts GATE.minHistoryDays, which the API checks before a start): every first
    # day of a year, a leap day included, has them at MIN_HISTORY_DAYS, and some first day does not one day sooner.
    firsts = pd.date_range("2023-01-01", periods=366)
    assert min(_weeks_with_range(first, pipeline.MIN_HISTORY_DAYS) for first in firsts) >= 12
    assert min(_weeks_with_range(first, pipeline.MIN_HISTORY_DAYS - 1) for first in firsts) < 12
    # 420 days, the first value tried, never gave one week with a range
    assert max(_weeks_with_range(first, 420) for first in firsts) == 0


def test_not_enough_history(lab_input):
    inp = copy.deepcopy(lab_input)
    start = (day(inp["dataThrough"]) - timedelta(days=pipeline.MIN_HISTORY_DAYS - 1)).isoformat()
    inp["days"] = [d for d in inp["days"] if d["date"] >= start]
    out = pipeline.calibrate(inp, CODE)
    assert out == {"schema": schema.RESULT_SCHEMA, "calibrationId": inp["calibrationId"], "ok": False,
                   "code": "not_enough_history"}


def _gap(inp):
    del inp["days"][100]


def _unsorted(inp):
    inp["days"][100], inp["days"][101] = inp["days"][101], inp["days"][100]


def _set(path, value):
    def apply(inp):
        target = inp
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
    return apply


@pytest.mark.parametrize("break_it", [
    _set(["schema"], "townwise.lab-input/2"),
    _gap,
    _unsorted,
    _set(["metric"], "net_sales"),
    _set(["calibrationId"], "not-an-id"),
    _set(["horizonDays"], 181),
    _set(["today"], "2025-10-20"),
    _set(["regimeStart"], "2025-02-30"),
    _set(["unknown"], 1),
    _set(["days", 5, "guests"], -1),
    _set(["days", 5, "guests"], float("nan")),
    _set(["days", -1, "guests"], 12),
    _set(["days", 5, "closed"], "yes"),
    _set(["days", 5, "term"], "autumn"),
    _set(["days", 5, "weekOfTerm"], 1.5),
    _set(["days", 5, "events"], ["Test Town Festival"]),
    _set(["champion", "days", 0, "mid"], None),
    _set(["champion", "weeks", 0, "openDays"], 8),
    _set(["champion", "runId"], ""),
], ids=["schema", "gap", "unsorted", "metric", "calibration_id", "horizon", "today", "regime_start", "unknown_key",
        "negative_guests", "nan_guests", "guests_after_cutoff", "closed_not_bool", "term", "week_of_term",
        "event_group", "champion_day", "champion_week", "champion_run_id"])
def test_invalid_input_codes(lab_input, break_it):
    inp = copy.deepcopy(lab_input)
    break_it(inp)
    with pytest.raises(schema.InputError):
        schema.validate_input(inp)
    out = pipeline.calibrate(inp, CODE)
    expected_id = inp["calibrationId"] if re.fullmatch(r"[0-9a-f]{24}", inp["calibrationId"]) else None
    assert out == {"schema": schema.RESULT_SCHEMA, "calibrationId": expected_id, "ok": False, "code": "invalid_input"}


def test_input_that_is_not_an_object_is_invalid():
    assert pipeline.calibrate([], CODE) == {"schema": schema.RESULT_SCHEMA, "calibrationId": None, "ok": False,
                                            "code": "invalid_input"}


def test_the_fixture_input_is_valid(lab_input):
    schema.validate_input(lab_input)
    no_champion = copy.deepcopy(lab_input)
    no_champion["champion"] = None
    schema.validate_input(no_champion)


def test_a_code_version_that_is_not_a_full_commit_raises(lab_input):
    with pytest.raises(ValueError):
        pipeline.calibrate(lab_input, "abc123")


def test_frame_of_input_is_the_fixture_frame(lab_input):
    from fixture import synthetic_frame
    lab_columns = ["date", "weekday", "guests", "term", "week_of_term", "ev_test-town:festival",
                   "ev_test-town:home-football", "private_event", "closed", "booked", "hol_big_night", "hol_halloween",
                   "hol_closed", "federal_holiday"]
    expected = synthetic_frame(0)[lab_columns]
    expected = expected[expected.date >= lab_input["days"][0]["date"]].reset_index(drop=True)
    pd.testing.assert_frame_equal(pipeline.frame_of(lab_input), expected, check_dtype=False)


def _prepared(inp):
    frame = pipeline.frame_of(inp)
    through = pd.Timestamp(inp["dataThrough"])
    hist = features.training_rows(frame, through)
    return (frame, hist, backtest.quarterly_origins(hist.date.min(), through), features.base_columns(None),
            features.event_columns(frame, hist.index))


def test_comparison_uses_only_comparable_weeks(lab_input):
    inp = copy.deepcopy(lab_input)
    frame, hist, origins, base_cols, event_cols = _prepared(inp)
    # A champion from the first refit's date, so its first weeks have no challenger refit 28 days before them
    champion = synthetic_champion(frame, origins[0])
    out = compare.compare(frame, hist, champion, origins, base_cols, event_cols)

    champion_days = {d["date"]: d for d in champion["days"]}
    guests = dict(zip(hist.date.dt.strftime("%Y-%m-%d"), hist.guests))
    booked = set(frame.date[frame.booked].dt.strftime("%Y-%m-%d"))
    last = hist.date.max().strftime("%Y-%m-%d")
    expected, origin_only, incomplete = [], [], []
    for w in champion["weeks"]:
        start = day(w["from"])
        dates = [(start + timedelta(days=k)).isoformat() for k in range(7)]
        if start.weekday() != 0 or w["to"] != dates[-1] or w["from"] <= champion["dataThrough"] or w["to"] > last:
            continue
        open_days = [d for d in dates if champion_days[d]["status"] == "open"]
        comparable = (open_days and all(d in guests for d in open_days)
                      and not any(d in booked or champion_days[d]["status"] == "booked" for d in dates))
        has_origin = any(o.date() <= start - timedelta(days=28) for o in origins)
        if comparable and has_origin:
            expected.append(w)
        elif comparable:
            origin_only.append(w)
        else:
            incomplete.append(w)
    # Each rule drops weeks here (a refit too late, a buyout, an open day without guests), and enough weeks remain
    assert origin_only and incomplete and len(expected) >= 12
    assert [row["week"] for row in out["series"]] == [w["from"] for w in expected]
    assert out["weeks"] == len(expected)
    assert (out["from"], out["to"]) == (expected[0]["from"], expected[-1]["to"])

    # The challenger: the rolling refit at least 28 days before each week's Monday, summed over the champion's open days
    preds = forecast.backtest_predictions(frame, hist, origins, hist.date.max(), base_cols, event_cols)
    picked = backtest.pick(preds, 28, pd.Timestamp(expected[0]["from"]), pd.Timestamp(expected[-1]["to"]))
    mid = dict(zip(picked.date.dt.strftime("%Y-%m-%d"), picked.mid))
    refit = dict(zip(picked.date.dt.strftime("%Y-%m-%d"), picked.refit))
    for row, w in zip(out["series"], expected):
        open_days = [d for d in champion_days if w["from"] <= d <= w["to"] and champion_days[d]["status"] == "open"]
        assert row["champion"] == w["mid"]
        assert row["actual"] == round(sum(guests[d] for d in open_days))
        assert row["challenger"] == pytest.approx(sum(mid[d] for d in open_days), rel=1e-12)
        assert all(refit[d] <= pd.Timestamp(w["from"]) - pd.Timedelta(days=28) for d in open_days)
        band = (row["challengerLow"], row["challengerHigh"])
        assert band == (None, None) or band[0] <= band[1]

    # Both scored on the same weeks and days
    actual = sum(r["actual"] for r in out["series"])
    assert out["champion"]["weeklyWape"] == pytest.approx(sum(abs(r["champion"] - r["actual"]) for r in out["series"])
                                                          / actual)
    assert out["challenger"]["weeklyWape"] == pytest.approx(
        sum(abs(r["challenger"] - r["actual"]) for r in out["series"]) / actual)
    # The champion's 80% weekly range is the one it published; the challenger's is its past-only backtest band
    inside = sum(w["low"] <= r["actual"] <= w["high"] for r, w in zip(out["series"], expected))
    assert out["champion"]["coverage80"] == {"inside": inside, "weeks": len(expected)}
    banded = [r for r in out["series"] if r["challengerLow"] is not None]
    assert out["challenger"]["coverage80"] == {
        "inside": sum(r["challengerLow"] <= r["actual"] <= r["challengerHigh"] for r in banded), "weeks": len(banded)}
    assert banded

    # A buyout the champion never knew of still drops its week, even on a day the champion had closed
    monday = next(w["from"] for w in expected if champion_days[w["from"]]["status"] == "closed")
    rebooked = frame.copy()
    rebooked.loc[rebooked.date == pd.Timestamp(monday), "booked"] = True
    again = compare.compare(rebooked, hist, champion, origins, base_cols, event_cols)
    assert [row["week"] for row in again["series"]] == [w["from"] for w in expected if w["from"] != monday]


def test_comparison_in_the_result_is_the_one_compare_makes(result, lab_input):
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    out = compare.compare(frame, hist, lab_input["champion"], origins, base_cols, event_cols)
    assert_close(result["scorecard"]["comparison"], out)


def test_comparison_none_without_champion(regime_result, lab_input):
    assert regime_result["ok"] is True and regime_result["scorecard"]["comparison"] is None
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    assert compare.compare(frame, hist, None, origins, base_cols, event_cols) is None


def test_comparison_none_when_no_week_is_comparable(lab_input):
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    late = synthetic_champion(frame, hist.date.max() - pd.Timedelta(days=3))  # no full week after it has sales yet
    assert compare.compare(frame, hist, late, origins, base_cols, event_cols) is None


def test_regime_start_adds_weekday_regime(regime_result, result):
    assert regime_result["params"]["baseCols"][0] == "weekday_regime"
    assert regime_result["params"]["regimeStart"] == REGIME_START.strftime("%Y-%m-%d")
    assert run_file_issues(regime_result["run"], synthetic_input(0)["today"]) == []
    # The regime's own weekday levels change the forecast of the days it covers
    mids = [(a["mid"], b["mid"]) for a, b in zip(regime_result["run"]["days"], result["run"]["days"])
            if a["status"] == "open"]
    assert any(abs(a - b) > 1 for a, b in mids)


def test_a_regime_start_without_four_training_days_changes_nothing_but_params(result, lab_input):
    # From two weeks before the cutoff: no weekday has 4 days of the regime to learn its level from, and no backtest
    # refit has any, so every weekday keeps its plain level (features.limit_weekday_regime) everywhere
    inp = copy.deepcopy(lab_input)
    inp["regimeStart"] = (day(inp["dataThrough"]) - timedelta(days=13)).isoformat()
    late = pipeline.calibrate(inp, CODE)
    assert late["params"]["baseCols"][0] == "weekday_regime"
    assert_close(late["run"], result["run"])
    assert_close(late["scorecard"], result["scorecard"])


def test_backtest_block_mirrors_scorecard(result):
    run_bt, card_bt = result["run"]["backtest"], result["scorecard"]["backtest"]
    assert (run_bt["from"], run_bt["to"], run_bt["weeks"]) == (card_bt["from"], card_bt["to"], card_bt["weeks"])
    assert run_bt["weeklyTypicalErrorPct"] == round(card_bt["metrics"]["typicalWeek"] * 100, 1)
    assert run_bt["weeksOver20Pct"] == card_bt["metrics"]["weeksOver20"]
    lo, hi = result["params"]["weeklyLogRange"]["lo"], result["params"]["weeklyLogRange"]["hi"]
    assert run_bt["weeklyRangePct"] == {"below": round((1 - math.exp(lo)) * 100, 1),
                                        "above": round((math.exp(hi) - 1) * 100, 1)}


def test_backtest_scores_the_horizon_28_weeks(result, lab_input):
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    card = result["scorecard"]
    assert card["backtest"]["origins"] == [o.strftime("%Y-%m-%d") for o in origins]
    assert (card["history"]["firstDate"], card["history"]["lastDate"], card["history"]["days"]) == (
        hist.date.min().strftime("%Y-%m-%d"), hist.date.max().strftime("%Y-%m-%d"), len(hist))
    preds = forecast.backtest_predictions(frame, hist, origins, pd.Timestamp(lab_input["dataThrough"]), base_cols,
                                          event_cols)
    start, end = backtest.score_window(origins, pd.Timestamp(lab_input["dataThrough"]), 28)
    assert (card["backtest"]["from"], card["backtest"]["to"]) == (start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
    days28 = backtest.pick(preds, 28, start, end)
    weeks28 = metrics.weekly_totals(days28)
    log_err = np.log(weeks28.actual / weeks28.pred)
    assert_close(card["backtest"]["metrics"], metrics.metrics(days28, weeks28, 28, log_err))
    days7 = backtest.pick(preds, 7, start, end)  # the same weeks, each from the latest refit 7 days before its Monday
    weeks7 = metrics.weekly_totals(days7)
    assert_close(card["backtest"]["metrics7"], metrics.metrics(days7, weeks7, 7, np.log(weeks7.actual / weeks7.pred)))
    assert card["backtest"]["metrics7"] != card["backtest"]["metrics"]
    assert result["params"]["widenK"] == metrics.choose_k(days28)
    q10, q90 = np.quantile(log_err, [0.1, 0.9])
    assert result["params"]["weeklyLogRange"] == pytest.approx({"lo": min(q10, 0.0), "hi": max(q90, 0.0)})
    assert card["backtest"]["weekdayMedianWeeklyWape"] == pytest.approx(
        metrics.weekly_wape(metrics.weekly_totals(days28, value="weekday_median")))
    series = card["backtest"]["series"]
    assert [r["week"] for r in series] == list(weeks28.index.strftime("%Y-%m-%d"))
    assert [r["actual"] for r in series] == [round(a) for a in weeks28.actual]
    assert [r["mid"] for r in series] == pytest.approx(list(weeks28.pred), rel=1e-12)
    starts = list(weeks28.index)
    for row, start in zip(series, starts):
        # null until 8 earlier weeks ended at least 28 days before this one starts
        earlier = sum(s + pd.Timedelta(days=6) <= start - pd.Timedelta(days=28) for s in starts)
        assert (row["low"] is None) == (earlier < 8)
    banded = [(row, band) for row, band in zip(series, metrics.weekly_bands(log_err, 28)) if band is not None]
    assert banded
    for row, (err_lo, err_hi) in banded:
        assert (row["low"], row["high"]) == pytest.approx(
            (row["mid"] * math.exp(err_lo), row["mid"] * math.exp(err_hi)))
    assert sum(row["low"] <= row["actual"] <= row["high"] for row, _ in banded) == card["backtest"]["metrics"][
        "coverage80"]["inside"]
    folds = backtest.six_month_folds(hist.date.min(), pd.Timestamp(lab_input["dataThrough"]))
    assert [(f["trainThrough"], f["from"], f["to"]) for f in card["backtest"]["folds"]] == [
        tuple(t.strftime("%Y-%m-%d") for t in fold) for fold in folds]


def test_golden_result_is_current(lab_input):
    golden_input = json.loads((GOLDEN / "input.json").read_text(encoding="utf-8"))
    golden_result = json.loads((GOLDEN / "result.json").read_text(encoding="utf-8"))
    assert golden_input == lab_input  # the fixture has not drifted from the golden input
    assert golden_result["codeVersion"] == "0" * 40
    assert_close(pipeline.calibrate(golden_input, golden_result["codeVersion"]), golden_result, rel=GOLDEN_REL,
                 abs_=GOLDEN_ABS, edge_slack=1)
