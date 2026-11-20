"""The lab's pipeline on the synthetic fixture: the LabResult contract of each engine, which engine a calibration
returns, the forecast window's rules and reach, the comparison with the current published run, and the golden files the
API's contract test reads.

On this fixture the baseline wins (its 20% level jump a year before the cutoff is one the model's quarterly refits
cannot learn), so a test of the model's own run takes it with calibrate_as(..., "model")."""

import copy
import json
import math
import re
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fixture import CHAMPION_THROUGH, EFFECT, LEVEL_SHIFT, REGIME_START, synthetic_champion, synthetic_input

from townwise_lab import backtest, baseline, compare, features, forecast, metrics, model, pipeline, schema, version

CODE = "0123456789abcdef0123456789abcdef01234567"
GOLDEN = Path(__file__).resolve().parent / "golden"
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
REASON_KINDS = {"weekday", "term", "event", "holiday", "level", "closure", "booking"}
REF = re.compile(r"[a-z0-9][a-z0-9:-]{0,119}")

METRICS_KEYS = {"weeklyWape", "dailyWape", "typicalWeek", "weeksOver20", "worstWeek", "coverage80", "dailyCoverage80",
                "weekdayBias", "weekdayBiasMeanAbs"}
PARAMS_KEYS = {"target", "baseCols", "eventCols", "regimeStart", "xgb", "holidayLambdas", "holidayEffects", "widenK",
               "weeklyLogRange", "widening", "refitEveryMonths", "horizonDays", "minPastWeeks", "floor"}
BASELINE_PARAMS_KEYS = {"target", "engine", "regimeStart", "levelDays", "levelMinDays", "shapeClamp", "calendarEffects",
                        "dailyLogRange", "widenK", "weeklyLogRange", "widening", "horizonDays", "minPastWeeks", "floor"}
SCORECARD_KEYS = ["horizonDays", "engine", "history", "backtest", "comparison", "engines", "horizon91", "horizonReach",
                  "horizonOutlook"]
ENGINES = ("model", "baseline")
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
            elif reason["effectPct"] is not None and not (is_num(reason["effectPct"])
                                                          and -100 <= reason["effectPct"] <= 1000):
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


def calibrate_as(inp: dict, engine: str) -> dict:
    """calibrate(inp) returning `engine`'s run whichever engine its backtest would choose, so each engine's output is
    checked on the same fixture. Everything else, the engines' figures included, is calibrate's own."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(pipeline, "choose_engine", lambda *args, **kwargs: engine)
        return pipeline.calibrate(copy.deepcopy(inp), CODE)


def later(inp: dict, days: int) -> dict:
    """`inp` with its today `days` after its data cutoff: sales that lag."""
    out = copy.deepcopy(inp)
    out["today"] = (day(inp["dataThrough"]) + timedelta(days=days)).isoformat()
    return out


@pytest.fixture(scope="session")
def result(lab_input) -> dict:
    """What calibrate returns for the fixture: the baseline's run (scorecard.engines says why)."""
    return pipeline.calibrate(copy.deepcopy(lab_input), CODE)


@pytest.fixture(scope="session")
def model_result(lab_input) -> dict:
    return calibrate_as(lab_input, "model")


@pytest.fixture(scope="session")
def results(result, model_result) -> dict[str, dict]:
    return {"baseline": result, "model": model_result}


@pytest.fixture(scope="session")
def lagging(lab_input) -> dict[str, tuple[dict, dict]]:
    """Each engine's result, and its input, with sales three weeks behind today."""
    inp = later(lab_input, 21)
    return {engine: (inp, calibrate_as(inp, engine)) for engine in ENGINES}


@pytest.fixture(scope="session")
def regime_result(lab_input) -> dict:
    inp = copy.deepcopy(lab_input)
    inp["regimeStart"], inp["champion"] = REGIME_START.strftime("%Y-%m-%d"), None
    return calibrate_as(inp, "model")


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
    return inp, calibrate_as(inp, "model")


@pytest.fixture(scope="session")
def messy_baseline(messy) -> dict:
    return calibrate_as(messy[0], "baseline")


def check_widening(widening) -> None:
    """The forecast tier's entries (D42), then the outlook's two anchors (D52), never narrower with lead."""
    tier, anchors = widening[:-2], widening[-2:]
    assert [w["fromLead"] for w in tier] in ([], [29], [29, 92]) and all(set(w) == {"fromLead", "ratio"} for w in tier)
    assert [w.get("horizon") for w in anchors] == [182, 365] and anchors[1]["fromLead"] == 365
    leads = [w["fromLead"] for w in widening]
    assert leads == sorted(set(leads))
    ratios = [w["ratio"] for w in widening]
    assert all(is_num(r) and r >= 1 for r in ratios) and ratios == sorted(ratios)  # never narrower with lead


def check_outlook(reports, widening) -> None:
    assert [r["horizon"] for r in reports] == [182, 365]
    for r in reports:
        assert set(r) == {"horizon", "weeks", "weeklyWape", "coverage80", "ratio", "basis"}
        assert is_int(r["weeks"]) and (r["weeklyWape"] is None) == (r["weeks"] == 0)
        assert set(r["coverage80"]) == {"inside", "weeks"} and is_num(r["ratio"]) and r["ratio"] >= 1
        # Under 8 backtest weeks the growth floor alone; from 8 the backtest may widen it, at any count of weeks
        assert r["basis"] == ("growth" if r["weeks"] < 8 else "growth_or_backtest")
    assert [r["ratio"] for r in reports] == [w["ratio"] for w in widening[-2:]]  # the anchors are the reports' ratios


def check_horizon(report) -> None:
    assert report is None or (set(report) == {"weeks", "weeklyWape", "coverage80"} and is_int(report["weeks"])
                              and is_num(report["weeklyWape"]) and set(report["coverage80"]) == {"inside", "weeks"})


def check_scorecard(card: dict, engine: str) -> None:
    assert list(card) == SCORECARD_KEYS + (["learning"] if engine == "model" else []) and card["horizonDays"] == 28 and card["engine"] == engine
    history = card["history"]
    assert set(history) == {"firstDate", "lastDate", "days", "spanDays"}
    assert is_date(history["firstDate"]) and is_date(history["lastDate"])
    assert is_int(history["days"]) and is_int(history["spanDays"])
    assert history["spanDays"] == (day(history["lastDate"]) - day(history["firstDate"])).days

    bt = card["backtest"]
    assert set(bt) == {"from", "to", "origins", "weeks", "weeksWithRange", "metrics", "metrics7",
                       "weekdayMedianWeeklyWape", "weeklyBias", "folds", "series"}
    assert is_date(bt["from"]) and is_date(bt["to"]) and all(is_date(o) for o in bt["origins"]) and bt["origins"]
    assert is_int(bt["weeks"]) and is_int(bt["weeksWithRange"]) and 0 < bt["weeksWithRange"] <= bt["weeks"]
    check_metrics(bt["metrics"])
    check_metrics(bt["metrics7"])
    assert bt["metrics"]["coverage80"]["weeks"] == bt["weeksWithRange"]
    assert is_num(bt["weekdayMedianWeeklyWape"]) and is_num(bt["weeklyBias"])
    # Weekly bias: the backtest weeks' forecasts minus actuals, over the actuals
    assert bt["weeklyBias"] == pytest.approx(sum(r["mid"] - r["actual"] for r in bt["series"])
                                             / sum(r["actual"] for r in bt["series"]))
    assert bt["folds"] or card["history"]["spanDays"] < 365  # a half-year fold starts 182 days after the first day
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

    engines = card["engines"]
    assert list(engines) == ["model", "baseline"]
    for figures in engines.values():
        assert figures is None or (set(figures) == {"weeks", "weeklyWape", "weeklyBias", "coverage80"}
                                   and is_int(figures["weeks"]) and is_num(figures["weeklyWape"])
                                   and is_num(figures["weeklyBias"]))
    # The returned engine's figures are its backtest's
    mine = engines[engine]
    assert (mine["weeks"], mine["weeklyWape"], mine["weeklyBias"], mine["coverage80"]) == (
        bt["weeks"], bt["metrics"]["weeklyWape"], bt["weeklyBias"], bt["metrics"]["coverage80"])
    check_horizon(card["horizon91"])
    check_horizon(card["horizonReach"])


def check_comparison(cmp: dict, lab_input: dict) -> None:
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


def check_envelope(result: dict, lab_input: dict) -> None:
    assert list(result) == ["schema", "calibrationId", "ok", "codeVersion", "params", "scorecard", "run"]
    assert result["schema"] == schema.RESULT_SCHEMA == "townwise.lab-result/1"
    assert schema.INPUT_SCHEMA == "townwise.lab-input/4"
    assert result["calibrationId"] == lab_input["calibrationId"]
    assert result["ok"] is True and result["codeVersion"] == CODE
    json.dumps(result, allow_nan=False)
    run = result["run"]
    assert set(run) == RUN_KEYS
    assert run["schema"] == "townwise.forecast-run/1" and run["metric"] == "guests"
    assert run["trainingSource"] == "townwise_lab" and run["frozen"] is None
    assert run["interval"] == {"level": 0.8, "widened": True}
    assert run["trainedFrom"] == result["scorecard"]["history"]["firstDate"]
    assert run["dataThrough"] == lab_input["dataThrough"] and run["madeAt"] == lab_input["today"]
    assert set(run["backtest"]) == {"from", "to", "weeks", "weeklyTypicalErrorPct", "weeksOver20Pct", "weeklyRangePct"}
    check_widening(result["params"]["widening"])
    check_outlook(result["scorecard"]["horizonOutlook"], result["params"]["widening"])


def test_baseline_result_matches_contract(result, lab_input):
    check_envelope(result, lab_input)
    check_scorecard(result["scorecard"], "baseline")
    check_comparison(result["scorecard"]["comparison"], lab_input)
    params = result["params"]
    assert set(params) == BASELINE_PARAMS_KEYS
    assert params["target"] == "guests" and params["engine"] == "baseline" and params["regimeStart"] is None
    assert (params["levelDays"], params["levelMinDays"], params["shapeClamp"]) == (8, 3, {"min": 0.5, "max": 2.0})
    assert set(params["calendarEffects"]) <= {"test-town:festival", "test-town:home-football", "hol_big_night",
                                              "hol_halloween"} | {e["group"] for e in lab_input["calendar"]
                                                                  if e["kind"] == "holiday"}
    assert params["calendarEffects"]["test-town:home-football"] == pytest.approx(EFFECT["football"], rel=0.15)
    assert params["dailyLogRange"]["lo"] <= 0 <= params["dailyLogRange"]["hi"]
    assert is_num(params["widenK"]) and 1 <= params["widenK"] <= 3
    assert params["weeklyLogRange"]["lo"] <= 0 <= params["weeklyLogRange"]["hi"]
    assert (params["horizonDays"], params["minPastWeeks"], params["floor"]) == (28, 8, 1)
    assert result["run"]["model"] == {"family": "seasonal_baseline", "version": version.MODEL_VERSION,
                                      "notebookCommit": CODE}
    # The baseline's origins are its weekly cutoffs: Sundays
    assert all(day(o).weekday() == 6 for o in result["scorecard"]["backtest"]["origins"])


def test_result_matches_contract(model_result, lab_input):
    result = model_result
    check_envelope(result, lab_input)
    check_scorecard(result["scorecard"], "model")
    check_comparison(result["scorecard"]["comparison"], lab_input)
    assert result["scorecard"]["history"]["spanDays"] >= pipeline.MIN_HISTORY_DAYS

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

    assert result["run"]["model"] == {"family": "hybrid_linear_xgboost", "version": version.MODEL_VERSION,
                                      "notebookCommit": CODE}
    assert version.MODEL_VERSION == "v13"


def test_a_model_run_carries_how_its_trees_learned(model_result, result, lab_input):
    learning = model_result["scorecard"]["learning"]
    assert list(learning) == ["trainThrough", "from", "to", "trainDays", "validDays", "metric", "train", "valid"]
    # The latest half-year fold: trained on every history day before it, validated on its own days
    assert day(learning["trainThrough"]) + timedelta(days=1) == day(learning["from"])
    assert learning["from"] <= learning["to"] <= lab_input["dataThrough"]
    assert learning["trainDays"] > 0 and learning["validDays"] >= pipeline.MIN_LEARNING_DAYS
    assert learning["metric"] == "mae_log"
    rounds = model.XGB_PARAMS["n_estimators"]
    assert len(learning["train"]) == len(learning["valid"]) == rounds
    assert all(is_num(v) and v >= 0 for v in learning["train"] + learning["valid"])
    # Each round fits the training days a little better; the held-out days are not promised that
    assert learning["train"][-1] < learning["train"][0]
    # The baseline is a rule: nothing learns round by round
    assert "learning" not in result["scorecard"]


def ratio_at(widening: list[dict], lead: int) -> float:
    """The widening params' ratio for a day `lead` days after the data cutoff."""
    return next((w["ratio"] for w in reversed(widening) if lead >= w["fromLead"]), 1.0)


def ratio_by_lead(result: dict, inp: dict, lead: int) -> float:
    """A day's range ratio by its lead, from the result's widening: the forecast tier's entries up to the tier's last
    day, then the outlook's (forecast.outlook_ratio with the anchors' ratios, pinned by the outlook tests below)."""
    widening = result["params"]["widening"]
    through, today = pd.Timestamp(inp["dataThrough"]), pd.Timestamp(inp["today"])
    if lead > (forecast.forecast_end(today, through) - through).days:
        r182, r365 = (w["ratio"] for w in widening if "horizon" in w)
        return forecast.outlook_ratio(lead, r182, r365)
    return ratio_at([w for w in widening if "horizon" not in w], lead)


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("sales", ["current", "three_weeks_behind"])
def test_run_file_obeys_api_rules(engine, sales, results, lagging, lab_input):
    inp, result = (lab_input, results[engine]) if sales == "current" else lagging[engine]
    run = result["run"]
    assert result["scorecard"]["engine"] == engine
    assert run_file_issues(run, inp["today"]) == []
    through, today = day(inp["dataThrough"]), day(inp["today"])
    # From the day after the last day of sales through today + 365, inside the cap of 400 days after them (D52)
    last = today + timedelta(days=forecast.OUTLOOK_DAYS)
    assert [d["date"] for d in run["days"]] == [(through + timedelta(days=k)).isoformat()
                                               for k in range(1, (last - through).days + 1)]
    assert (last - through).days == (367 if sales == "current" else 386) <= forecast.HORIZON_DAYS == 400
    assert {d["status"] for d in run["days"]} == {"open", "closed", "booked"}
    # Weeks: exactly the Monday-to-Sunday weeks wholly inside the run
    first_monday = through + timedelta(days=1 + (7 - (through + timedelta(days=1)).weekday()) % 7)
    whole = [first_monday + timedelta(weeks=k) for k in range((last - first_monday).days // 7 + 1)
             if first_monday + timedelta(weeks=k, days=6) <= last]
    assert [(w["from"], w["to"]) for w in run["weeks"]] == [(m.isoformat(), (m + timedelta(days=6)).isoformat())
                                                            for m in whole]
    lo, hi = result["params"]["weeklyLogRange"]["lo"], result["params"]["weeklyLogRange"]["hi"]
    tier_end = forecast.forecast_end(pd.Timestamp(today), pd.Timestamp(through)).date()
    for w in run["weeks"]:
        mids = [d["mid"] for d in run["days"] if w["from"] <= d["date"] <= w["to"] and d["status"] == "open"]
        assert w["mid"] == pytest.approx(sum(mids), rel=1e-12)
        ratios = [ratio_by_lead(result, inp, lead) for lead in range((day(w["from"]) - through).days,
                                                                     (day(w["to"]) - through).days + 1)]
        # A forecast-tier week widened by its first day's lead; an outlook week by its widest day's, the same both sides
        outlook = day(w["to"]) > tier_end
        r = max(ratios) if outlook else ratios[0]
        low, high = (-max(-lo, hi), max(-lo, hi)) if outlook else (lo, hi)
        assert w["low"] == pytest.approx(w["mid"] * math.exp(low * r))
        assert w["high"] == pytest.approx(w["mid"] * math.exp(high * r))
    # Sales that lag reach further than 91 days after them: the reach is reported and widens the forecast tier's end
    card = result["scorecard"]
    assert card["horizon91"]["weeks"] >= forecast.MIN_HORIZON_WEEKS
    assert [w["fromLead"] for w in result["params"]["widening"]][:2] == [29, 92]
    assert card["horizonReach"]["weeks"] >= 8


@pytest.mark.parametrize("engine", ENGINES)
def test_ranges_never_narrow_with_lead(engine, lagging):
    inp, result = lagging[engine]
    through = day(inp["dataThrough"])
    ratios = [ratio_by_lead(result, inp, lead) for lead in range(1, 387)]
    assert ratios == sorted(ratios) and ratios[0] == 1.0
    weeks = result["run"]["weeks"]
    spans = [math.log(w["high"] / w["mid"]) - math.log(w["low"] / w["mid"]) for w in weeks if w["mid"] > 0]
    assert all(b >= a - 1e-12 for a, b in zip(spans, spans[1:]))  # the weekly log range only grows with lead
    if engine == "baseline":  # one daily log range for every day, so the days' own ranges only grow with lead
        open_days = [d for d in result["run"]["days"] if d["status"] == "open"]
        high = [math.log(d["high"] / d["mid"]) for d in open_days]
        assert all(b >= a - 1e-12 for a, b in zip(high, high[1:]))
        assert (day(open_days[-1]["date"]) - through).days > 365


def test_the_run_end_rules():
    through, today = pd.Timestamp("2026-11-15"), pd.Timestamp("2026-11-16")
    # The forecast tier as D42's run: today + 91 (to Feb 15, 2027), a longest lead of 92 days, so 98 in whole weeks
    assert forecast.forecast_end(today, through) == pd.Timestamp("2027-02-15")
    assert forecast.reach_horizon(today, through) == 98
    assert forecast.reach_horizon(through, through) is None  # today the last day of sales: 91 days exactly
    # Sales three weeks behind (data through Sun, Oct 25): a forecast tier to Feb 15, 2027, a longest lead of 113 days
    lag = pd.Timestamp("2026-10-25")
    assert forecast.forecast_end(today, lag) == pd.Timestamp("2027-02-15")
    assert forecast.reach_horizon(today, lag) == 119  # 113 days, in whole weeks
    assert forecast.run_end(today, lag, 20, 8) == today + pd.Timedelta(days=365)
    # The forecast tier capped at 182 days after the last day of sales, the run at 400
    old = pd.Timestamp("2026-06-01")
    assert forecast.forecast_end(today, old) == old + pd.Timedelta(days=182)
    assert forecast.run_end(today, old, 20, 8) == old + pd.Timedelta(days=400)


def test_run_reaches_a_year_with_current_sales(results, lab_input):
    # Spec scenario: a Monday 2026-11-23 calibration with sales through Sunday 2026-11-22 covers through 2027-11-23
    assert forecast.run_end(pd.Timestamp("2026-11-23"), pd.Timestamp("2026-11-22"), 20, 8) == pd.Timestamp("2027-11-23")
    assert forecast.run_end(pd.Timestamp("2026-11-22"), pd.Timestamp("2026-11-22"), 20, None) == pd.Timestamp(
        "2027-11-22")
    for result in results.values():
        assert result["run"]["days"][-1]["date"] == (day(lab_input["today"]) + timedelta(days=365)).isoformat()


def test_run_seven_weeks_behind_ends_400_after_data(lab_input):
    today = pd.Timestamp("2026-11-23")
    through = today - pd.Timedelta(days=49)
    assert forecast.run_end(today, through, 20, 8) == through + pd.Timedelta(days=400) == today + pd.Timedelta(days=351)
    inp = later(lab_input, 49)
    run = calibrate_as(inp, "baseline")["run"]
    assert run["days"][-1]["date"] == (day(inp["dataThrough"]) + timedelta(days=400)).isoformat()
    assert run_file_issues(run, inp["today"]) == []


def test_no_outlook_when_91_is_not_backed():
    through, today = pd.Timestamp("2026-11-15"), pd.Timestamp("2026-11-16")
    assert forecast.run_end(today, through, 7, 8) == through + pd.Timedelta(days=28)
    assert forecast.run_end(today, through, 7, 8, pd.Timestamp("2027-11-24")) == through + pd.Timedelta(days=28)


def test_no_outlook_when_the_reach_is_not_backed():
    today, lag = pd.Timestamp("2026-11-16"), pd.Timestamp("2026-10-25")
    assert forecast.run_end(today, lag, 20, 7) == lag + pd.Timedelta(days=91)
    assert forecast.run_end(today, lag, 20, None) == lag + pd.Timedelta(days=91)
    # Today the last day of sales: the tier ends at 91 days, so no reach is asked for and the outlook follows
    assert forecast.run_end(lag, lag, 20, None) == lag + pd.Timedelta(days=365)


def with_terms_through(inp: dict, days: int) -> dict:
    out = copy.deepcopy(inp)
    out["termsThrough"] = (day(inp["dataThrough"]) + timedelta(days=days)).isoformat()
    return out


def test_model_outlook_stops_at_terms_through(lab_input):
    # Spec scenario: a model run made 2027-01-04 would reach 2028-01-04; the last researched term ends 2027-11-24
    today = pd.Timestamp("2027-01-04")
    assert forecast.run_end(today, today - pd.Timedelta(days=1), 20, 8, pd.Timestamp("2027-11-24")) == pd.Timestamp(
        "2027-11-24")
    inp = with_terms_through(lab_input, 300)
    result = calibrate_as(inp, "model")
    assert result["run"]["days"][-1]["date"] == inp["termsThrough"]
    assert run_file_issues(result["run"], inp["today"]) == []


def test_model_forecast_tier_never_cut_by_terms_through(lab_input, model_result):
    today, through = pd.Timestamp("2027-01-04"), pd.Timestamp("2027-01-03")
    tier_end = forecast.forecast_end(today, through)
    assert forecast.run_end(today, through, 20, 8, pd.Timestamp("2027-01-20")) == tier_end
    inp = with_terms_through(lab_input, 10)
    run = calibrate_as(inp, "model")["run"]
    tier = forecast.forecast_end(pd.Timestamp(inp["today"]), pd.Timestamp(inp["dataThrough"]))
    assert run["days"][-1]["date"] == forecast.iso(tier)
    assert run["days"] == [d for d in model_result["run"]["days"] if d["date"] <= forecast.iso(tier)]


def test_baseline_outlook_ignores_terms_through(lab_input, result):
    inp = with_terms_through(lab_input, 100)
    run = calibrate_as(inp, "baseline")["run"]
    assert run["days"][-1]["date"] == (day(inp["today"]) + timedelta(days=365)).isoformat()
    assert run == result["run"]


def test_outlook_week_takes_its_widest_day(lab_input):
    frame = pipeline.frame_of(lab_input)
    through, today = pd.Timestamp(lab_input["dataThrough"]), pd.Timestamp(lab_input["today"])
    tier_end = forecast.forecast_end(today, through)
    rows, status = forecast.window(frame, through, through + pd.Timedelta(days=200))
    open_index = rows.index[status == "open"]
    numbers = pd.DataFrame({"low": 8.0, "mid": 10.0, "high": 12.0, "baseline": 10.0}, index=open_index)
    ratio = forecast.lead_ratios(rows.date, through, [(29, 1.2), (92, 1.3)], forecast.Outlook(tier_end, 2.0, 3.0))
    _, weeks = forecast.assemble(rows, status, numbers, {"lo": -0.1, "hi": 0.1}, ratio, tier_end=tier_end)
    by_date = dict(zip(rows.date, ratio))
    straddling = 0
    for w in weeks:
        ratios = [by_date[d] for d in pd.date_range(w["from"], w["to"])]
        outlook = pd.Timestamp(w["to"]) > tier_end
        expected = max(ratios) if outlook else ratios[0]
        assert w["high"] == pytest.approx(w["mid"] * math.exp(0.1 * expected))
        if outlook and pd.Timestamp(w["from"]) <= tier_end:
            straddling += 1
            assert max(ratios) == 2.0 > ratios[0]  # its outlook days, not its first (forecast) day
    assert straddling == 1


def test_an_outlook_week_is_the_same_both_sides_when_a_28_day_side_is_0(lab_input):
    # A weekly range that held only one way at 28 days (its other side exactly 0) is not carried one way into the
    # outlook: an outlook week takes the wider side on both, while a forecast-tier week keeps the range as backtested
    frame = pipeline.frame_of(lab_input)
    through, today = pd.Timestamp(lab_input["dataThrough"]), pd.Timestamp(lab_input["today"])
    tier_end = forecast.forecast_end(today, through)
    rows, status = forecast.window(frame, through, through + pd.Timedelta(days=200))
    numbers = pd.DataFrame({"low": 8.0, "mid": 10.0, "high": 12.0, "baseline": 10.0}, index=rows.index[status == "open"])
    ratio = forecast.lead_ratios(rows.date, through, [(29, 1.2), (92, 1.3)], forecast.Outlook(tier_end, 2.0, 3.0))
    by_date = dict(zip(rows.date, ratio))
    for log_range in ({"lo": 0.0, "hi": 0.1}, {"lo": -0.1, "hi": 0.0}):
        _, weeks = forecast.assemble(rows, status, numbers, log_range, ratio, tier_end=tier_end)
        kinds = set()
        for w in weeks:
            ratios = [by_date[d] for d in pd.date_range(w["from"], w["to"])]
            outlook = pd.Timestamp(w["to"]) > tier_end
            kinds.add(outlook)
            if outlook:
                assert w["low"] == pytest.approx(w["mid"] * math.exp(-0.1 * max(ratios)))
                assert w["high"] == pytest.approx(w["mid"] * math.exp(0.1 * max(ratios)))
            else:
                assert w["low"] == pytest.approx(w["mid"] * math.exp(log_range["lo"] * ratios[0]))
                assert w["high"] == pytest.approx(w["mid"] * math.exp(log_range["hi"] * ratios[0]))
                assert w["low"] == pytest.approx(w["mid"]) or w["high"] == pytest.approx(w["mid"])  # one way, as before
        assert kinds == {True, False}


# The outlook's range rule (D52 decision 5, as built in release B), on pipeline._outlook_band, pipeline.outlook_ratios
# and forecast.outlook_ratio

RANGE28 = {"lo": -0.1, "hi": 0.1}


def errors(sizes) -> pd.Series:
    """Weekly log errors of these sizes, alternately under and over, by week start a week apart."""
    starts = pd.date_range("2024-01-01", periods=len(sizes), freq="7D")
    return pd.Series([size if i % 2 else -size for i, size in enumerate(sizes)], index=starts, dtype=float)


def backtested(own: pd.Series, every: pd.Series | None = None) -> tuple[dict | None, tuple[pd.Series, pd.Series]]:
    """An outlook horizon's _horizon report (None with no week) and its (own, every) errors, as calibrate passes them."""
    every = own if every is None else every
    report = None if every.empty else {"weeks": len(every), "weeklyWape": 0.1,
                                       "coverage80": {"inside": len(every), "weeks": len(every)}}
    return report, (own, every)


NONE = errors([])


def test_outlook_band_reads_a_conformal_rank_from_nine_windows():
    # 500 weeks at 365 days of lead are 500 * 7 / 365 = 9.59 windows: the conformal 80% rank ceil(0.8 * 10.59) = 9 of
    # them, as a share of the weeks the 470th smallest of 500 misses, ceil(9 * 365 / 7); the every-kind weeks unread
    own = errors(np.arange(1, 501) / 1000)
    assert pipeline._outlook_band(own, errors(np.full(600, 0.9)), 365) == pytest.approx((-0.47, 0.47))
    # 234 weeks at 182 are exactly 9 windows: 8 of 9, the 208th of 234 (whole numbers, so no rounding moves it)
    assert pipeline._outlook_band(errors(np.arange(1, 235) / 1000), NONE, 182) == pytest.approx((-0.208, 0.208))
    assert pipeline._outlook_band(errors(np.arange(1, 241) / 1000), NONE, 182) == pytest.approx((-0.234, 0.234))


def test_outlook_band_takes_the_largest_miss_from_one_window_to_nine():
    # 26 weeks at 182 days are one window; 233 are 8.96: too few for an 80% rank, so the largest miss
    assert pipeline._outlook_band(errors([0.1] * 25 + [0.4]), NONE, 182) == (-0.4, 0.4)
    assert pipeline._outlook_band(errors(np.arange(1, 234) / 1000), NONE, 182) == pytest.approx((-0.233, 0.233))
    # 53 weeks at 365 are one window (1.02), its every-kind weeks unread
    assert pipeline._outlook_band(errors([0.2] * 52 + [0.3]), errors([0.9] * 60), 365) == (-0.3, 0.3)


def test_outlook_band_reads_every_week_under_one_window():
    # 25 weeks at 182 days (0.96 windows) and 52 at 365 (0.997): every week at that lead, of either kind, by its
    # conformal 80% rank (of 30 weeks the 25th smallest, ceil(0.8 * 31)), but never under the own weeks' largest miss
    every = errors(np.arange(1, 31) / 100)
    assert pipeline._outlook_band(every[:25], every, 182) == pytest.approx((-0.25, 0.25))
    assert pipeline._outlook_band(every[-25:], every, 182) == pytest.approx((-0.30, 0.30))
    assert pipeline._outlook_band(NONE, every, 182) == pytest.approx((-0.25, 0.25))  # none of the run's kind yet
    assert pipeline._outlook_band(errors([0.2] * 52), every, 365) == pytest.approx((-0.25, 0.25))
    assert pipeline._outlook_band(errors([0.1] * 51 + [0.5]), every, 365) == pytest.approx((-0.5, 0.5))
    assert pipeline._outlook_band(NONE, every[:8], 365) == pytest.approx((-0.08, 0.08))  # 8 weeks: the 8th, ceil(7.2)


def test_outlook_band_never_widens_as_the_runs_own_weeks_reach_one_window():
    # The run's own weeks: one large miss, then small ones; 20 weeks of the other kind at 0.2. Under one window the
    # every-week rank (0.2) is only a floor under the own largest miss (0.3), so the 26th own week at 182 days (one
    # window, where the floor drops away) does not widen the band: no week after the first is a new largest miss
    own = errors([0.3] + [0.05] * 40)
    every = pd.concat([own, errors([0.2] * 20)])
    widths = [pipeline._outlook_band(own[:n], every, 182)[1] for n in range(1, len(own) + 1)]
    assert all(earlier >= later for earlier, later in zip(widths, widths[1:])), widths


def test_outlook_band_is_none_under_8_weeks():
    assert pipeline._outlook_band(errors([0.9] * 7), errors([0.9] * 7), 182) is None
    assert pipeline._outlook_band(NONE, NONE, 365) is None


def test_outlook_growth_with_no_year_ahead_backtest():
    # Spec scenario: 15 weeks at 182 whose band is 1.5 times the 28-day range's wider side, none at 365, a 91-day ratio
    # of 1.3. Under one window, the larger of the largest miss and the 13th smallest of 15 (ceil(0.8 * 16)), both
    # 0.15, over a side of 0.1
    reports = pipeline.outlook_ratios((91, 1.3), [(182, *backtested(errors([0.01] * 12 + [0.15] * 3))),
                                                  (365, *backtested(NONE))], RANGE28)
    r182 = max(1.3 * math.sqrt(2), 1.5)
    assert [r["ratio"] for r in reports] == pytest.approx([r182, r182 * math.sqrt(365 / 182)])
    assert [r["basis"] for r in reports] == ["growth_or_backtest", "growth"]
    assert reports[1] == {"horizon": 365, "weeks": 0, "weeklyWape": None, "coverage80": {"inside": 0, "weeks": 0},
                          "ratio": reports[1]["ratio"], "basis": "growth"}
    # Under 8 weeks the backtest is not read at all, however wide; the reach (98 days) is the previous horizon
    wide = pipeline.outlook_ratios((98, 1.3), [(182, *backtested(errors([0.9] * 7))),
                                               (365, *backtested(errors([0.9] * 7)))], RANGE28)
    assert [r["ratio"] for r in wide] == pytest.approx([1.3 * math.sqrt(182 / 98), 1.3 * math.sqrt(365 / 98)])
    assert [r["basis"] for r in wide] == ["growth", "growth"]


def test_outlook_backtest_only_widens_the_growth():
    growth = 1.3 * math.sqrt(2)
    # 25 weeks (under one window): the largest miss and the 21st smallest, ceil(0.8 * 26), are 0.25 over a side of 0.1
    wider = pipeline.outlook_ratios((91, 1.3), [(182, *backtested(errors([0.01] * 20 + [0.25] * 5))),
                                                (365, *backtested(NONE))], RANGE28)
    assert wider[0]["ratio"] == pytest.approx(2.5) and wider[0]["basis"] == "growth_or_backtest"
    narrower = pipeline.outlook_ratios((91, 1.3), [(182, *backtested(errors([0.12] * 8))), (365, *backtested(NONE))],
                                       RANGE28)
    assert narrower[0]["ratio"] == pytest.approx(growth) and narrower[0]["basis"] == "growth_or_backtest"


def test_outlook_never_narrows_under_the_growth_however_many_weeks():
    # The growth floor always holds: 26 narrow weeks (one window) no longer set the ratio alone, nor do 40 at 365
    reports = pipeline.outlook_ratios((91, 1.3), [(182, *backtested(errors([0.12] * 26))),
                                                  (365, *backtested(errors([0.1] * 40)))], RANGE28)
    r182 = 1.3 * math.sqrt(2)
    assert [r["ratio"] for r in reports] == pytest.approx([r182, r182 * math.sqrt(365 / 182)])
    # From one window the largest miss sets the band: 26 weeks with one miss of 0.4 widen 182 to 4 times the side
    largest = pipeline.outlook_ratios((91, 1.3), [(182, *backtested(errors([0.05] * 25 + [0.4]))),
                                                  (365, *backtested(NONE))], RANGE28)
    assert largest[0]["ratio"] == pytest.approx(4.0)


def test_outlook_ratio_reads_the_28_day_ranges_wider_side():
    # Spec scenario: a 28-day range of -0.1 to 0.2, and misses at 182 whose band is 0.6: the ratio is 0.6 over 0.2
    band = [(182, *backtested(errors([0.05] * 25 + [0.6]))), (365, *backtested(NONE))]
    assert pipeline.outlook_ratios((91, 1.3), band, {"lo": -0.1, "hi": 0.2})[0]["ratio"] == pytest.approx(3.0)
    assert pipeline.outlook_ratios((91, 1.3), band, {"lo": -0.2, "hi": 0.1})[0]["ratio"] == pytest.approx(3.0)
    # A 28-day side of exactly 0 (the range holds zero): the other side
    assert pipeline.outlook_ratios((91, 1.3), band, {"lo": 0.0, "hi": 0.2})[0]["ratio"] == pytest.approx(3.0)
    # A 28-day range of 0 both ways: nothing to scale, so the growth
    assert pipeline.outlook_ratios((91, 1.3), band, {"lo": 0.0, "hi": 0.0})[0]["ratio"] == pytest.approx(
        1.3 * math.sqrt(2))


def test_outlook_interpolates_between_182_and_365():
    assert forecast.outlook_ratio(93, 1.8, 3.0) == forecast.outlook_ratio(182, 1.8, 3.0) == 1.8
    assert forecast.outlook_ratio(365, 1.8, 3.0) == pytest.approx(3.0)
    middle = ((math.sqrt(182) + math.sqrt(365)) / 2) ** 2  # halfway on the square root of lead
    assert forecast.outlook_ratio(middle, 1.8, 3.0) == pytest.approx(2.4)
    growth = 1.8 * math.sqrt(365 / 182)  # with r_365 the pure growth, the interpolation is r_182 * sqrt(L / 182)
    for lead in (183, 240, 300, 364):
        assert forecast.outlook_ratio(lead, 1.8, growth) == pytest.approx(1.8 * math.sqrt(lead / 182))


def test_outlook_grows_past_365():
    assert forecast.outlook_ratio(400, 1.8, 3.0) == pytest.approx(3.0 * math.sqrt(400 / 365))
    assert forecast.outlook_ratio(366, 1.8, 3.0) > 3.0


def test_outlook_ratios_never_narrow_with_lead(results, lagging, lab_input):
    pairs = [(lab_input, r) for r in results.values()] + list(lagging.values())
    for inp, result in pairs:
        ratios = [ratio_by_lead(result, inp, lead) for lead in range(1, 401)]
        assert ratios == sorted(ratios)
        reports = result["scorecard"]["horizonOutlook"]
        tier = [w["ratio"] for w in result["params"]["widening"] if "horizon" not in w]
        assert tier[-1] <= reports[0]["ratio"] <= reports[1]["ratio"]
    rng = np.random.default_rng(5)
    for _ in range(200):  # any backtest, any count of weeks of either kind: each ratio at least the one before
        previous = (int(rng.choice([91, 98, 119])), float(rng.uniform(1, 2)))
        backtests = []
        for horizon in (182, 365):
            every = errors(rng.uniform(0, 0.8, int(rng.integers(0, 600))))
            backtests.append((horizon, *backtested(every[len(every) - int(rng.integers(0, len(every) + 1)):], every)))
        reports = pipeline.outlook_ratios(previous, backtests, {"lo": -float(rng.uniform(0, 0.2)),
                                                                "hi": float(rng.uniform(0, 0.2))})
        growth = previous[1] * math.sqrt(182 / previous[0])
        assert previous[1] <= growth <= reports[0]["ratio"] <= reports[1]["ratio"]
        assert reports[1]["ratio"] >= reports[0]["ratio"] * math.sqrt(365 / 182) - 1e-12  # the floor, at 365 too


def test_outlook_reported_not_gated(lab_input, result):
    # The outlook's ratios change nothing the engine choice or the gate reads
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(pipeline, "outlook_ratios", lambda previous, backtests, log_range28: [
            {"horizon": h, "weeks": 0, "weeklyWape": None, "coverage80": {"inside": 0, "weeks": 0}, "ratio": 50.0,
             "basis": "growth"} for h in (182, 365)])
        wide = pipeline.calibrate(copy.deepcopy(lab_input), CODE)
    same = ("engine", "history", "backtest", "comparison", "engines", "horizon91", "horizonReach")
    assert {k: wide["scorecard"][k] for k in same} == {k: result["scorecard"][k] for k in same}
    assert wide["scorecard"]["horizonOutlook"] != result["scorecard"]["horizonOutlook"]


def test_a_run_without_enough_91_day_weeks_stops_at_28_days_of_lead(lab_input):
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(forecast, "MIN_HORIZON_WEEKS", 10_000)  # as if a short history had fewer than 8 such weeks
        out = pipeline.calibrate(copy.deepcopy(lab_input), CODE)
    through = day(lab_input["dataThrough"])
    assert out["run"]["days"][-1]["date"] == (through + timedelta(days=28)).isoformat()
    assert run_file_issues(out["run"], lab_input["today"]) == []


@pytest.mark.parametrize("engine", ENGINES)
def test_closed_weekday_and_holiday_rules(engine, results, lab_input):
    days = {d["date"]: d for d in results[engine]["run"]["days"]}
    booked = {d["date"] for d in lab_input["days"] if d["booked"]}
    closed_note = {d["date"] for d in lab_input["days"] if d["closed"]}
    mondays = [d for when, d in days.items() if day(when).weekday() == 0 and when not in booked]
    assert len(mondays) > 10
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

    # A weekday is closed when at most 1 of its last 8 dates had guests, counting only weeks with guests on another day
    inp = copy.deepcopy(lab_input)
    thursdays = [d for d in inp["days"] if d["date"] <= inp["dataThrough"] and day(d["date"]).weekday() == 3][-10:]
    assert day(thursdays[-1]["date"]) + timedelta(days=3) <= day(inp["dataThrough"])  # in a complete week: it counts
    assert all(d["guests"] and d["guests"] > 0 for d in thursdays[:2])
    for d in thursdays[:2]:
        d["privateEvent"] = d["booked"] = False  # served: a private event or buyout never is
    for d in thursdays[2:]:
        d["guests"] = None
    status = statuses_of(inp)
    future_thursdays = [when for when in status if day(when).weekday() == 3
                        and when not in holidays_closed + sorted(booked | closed_note)]  # Thanksgiving is a Thursday
    assert future_thursdays and all(status[when] == "closed" for when in future_thursdays)

    def empty_week_of(thursday: dict) -> None:
        monday = day(thursday["date"]) - timedelta(days=3)
        for d in inp["days"]:
            if monday <= day(d["date"]) <= monday + timedelta(days=6):
                d["guests"] = None  # a week with no guests at all: not evidence about Thursdays

    empty_week_of(thursdays[-1])  # the last 8 counted Thursdays now hold one with guests: still closed
    status = statuses_of(inp)
    assert all(status[when] == "closed" for when in future_thursdays)
    empty_week_of(thursdays[-2])  # and now two
    status = statuses_of(inp)
    assert all(status[when] == "open" for when in future_thursdays)


def test_a_closing_holiday_with_no_past_occurrence_stays_open():
    dates = pd.Series(pd.date_range("2025-06-01", "2025-07-10"))
    frame = pd.DataFrame({"date": dates, "weekday": dates.dt.day_name(), "guests": np.where(dates <= "2025-06-30", 20.0,
                                                                                            np.nan),
                          "closed": False, "private_event": 0, "booked": False})
    frame = pd.concat([frame, features.holiday_flags(frame.date)], axis=1)
    status = forecast.statuses(frame, pd.Timestamp("2025-06-30"))
    assert frame.date[status.index].tolist() == list(pd.date_range("2025-07-01", "2025-07-10"))
    assert (status == "open").all()  # July 4 included: no earlier July 4 says the place closes


# Closed weekdays (forecast.closed_weekdays, v12): a restaurant open every day at 100 guests, then closed on Sundays and
# Mondays from June 2025 (no guest count), with the days each test serves on them

CLOSED_FROM = pd.Timestamp("2025-06-01")


def closed_weekdays_of(through: str, guests: dict[str, float] | None = None, private: tuple[str, ...] = (),
                       booked: tuple[str, ...] = (), first: str = "2025-03-03",
                       party: tuple[str, ...] = ()) -> set[str]:
    dates = pd.Series(pd.date_range(first, through))
    shut = dates.dt.day_of_week.isin([6, 0]) & dates.ge(CLOSED_FROM)
    frame = pd.DataFrame({"date": dates, "weekday": dates.dt.day_name(), "guests": np.where(shut, np.nan, 100.0),
                          "private_event": dates.isin(pd.to_datetime(list(private))).astype(int),
                          "booked": dates.isin(pd.to_datetime(list(booked)))})
    if party:  # a frame without the column reads as one without parties
        frame["party"] = dates.isin(pd.to_datetime(list(party)))
    for when, count in (guests or {}).items():
        frame.loc[frame.date.eq(pd.Timestamp(when)), "guests"] = count
    return forecast.closed_weekdays(frame, pd.Timestamp(through))


def test_a_partial_last_week_whose_median_collapses_does_not_reopen_a_closed_weekday():
    # Data ends on a Tuesday: its week holds only Monday's 4 guests and Tuesday's 49, a median of 26.5 and a bar of
    # 2.65 that 4 passes. One real Monday among the last 8 is not enough alone, so only that week could reopen Mondays.
    assert closed_weekdays_of("2025-08-26", {"2025-07-14": 100.0, "2025-08-25": 4.0, "2025-08-26": 49.0}) == {
        "Sunday", "Monday"}
    # A complete week counts: the same real Monday then opens Mondays, with July's
    assert closed_weekdays_of("2025-08-31", {"2025-07-14": 100.0, "2025-08-25": 100.0}) == {"Sunday"}
    # but not while its week is still partial
    assert closed_weekdays_of("2025-08-26", {"2025-07-14": 100.0, "2025-08-25": 100.0}) == {"Sunday", "Monday"}


def test_a_private_event_or_booked_day_on_a_closed_weekday_does_not_reopen_it():
    # Two parties on closed Sundays, rung as full rooms, beside one real Sunday: one served date in 8
    parties = {"2025-08-17": 60.0, "2025-08-24": 80.0}
    real = {"2025-07-13": 100.0}
    assert closed_weekdays_of("2025-08-31", parties | real, private=("2025-08-17",), booked=("2025-08-24",)) == {
        "Sunday", "Monday"}
    assert closed_weekdays_of("2025-08-31", parties | real) == {"Monday"}  # unflagged, they would have reopened it


def test_one_served_date_in_the_last_eight_does_not_reopen_a_weekday_but_two_do():
    assert closed_weekdays_of("2025-08-31", {"2025-08-18": 100.0}) == {"Sunday", "Monday"}
    assert closed_weekdays_of("2025-08-31", {"2025-08-11": 100.0, "2025-08-18": 100.0}) == {"Sunday"}


def test_an_open_weekday_stays_open():
    assert closed_weekdays_of("2025-05-25") == set()  # before the closures every weekday is served
    # Tuesdays to Saturdays are served throughout, so only Sundays and Mondays close
    assert closed_weekdays_of("2025-08-31") == {"Sunday", "Monday"}
    # A weekday with fewer than 2 counted dates stays open, even unserved: one week of data, closed Sunday and Monday
    assert closed_weekdays_of("2025-08-31", first="2025-08-25") == set()


# D70 (v13): a private event or counted party on a weekday held closed as of the weeks before it opened only for the
# event, so it leaves training; and such days are neither served nor unserved when closed weekdays are judged.


def closed_input(through: str = "2025-08-31", guests: dict[str, float] | None = None, party: tuple[str, ...] = (),
                 private: tuple[str, ...] = (), first: str = "2025-03-03", shut: tuple[int, ...] = (6, 0)) -> dict:
    """A valid LabInput from `first` to `through` + 400 days: guests by weekday with a little noise, none on the
    weekdays `shut` (day_of_week numbers) from CLOSED_FROM on, then `guests` by date, with `party` and `private` days
    flagged as the API flags them (a counted party's guests already taken off)."""
    end = pd.Timestamp(through)
    days = []
    for n, when in enumerate(pd.date_range(first, end + pd.Timedelta(days=forecast.HORIZON_DAYS))):
        count = None
        if when <= end and not (when.day_of_week in shut and when >= CLOSED_FROM):
            count = float(80 + 10 * when.day_of_week + (n * 7) % 11)
        key = forecast.iso(when)
        if when <= end and guests and key in guests:
            count = guests[key]
        days.append({"date": key, "guests": count, "term": "interim", "weekOfTerm": -1, "events": [], "closed": False,
                     "privateEvent": key in private, "booked": False, "party": key in party})
    inp = {"schema": schema.INPUT_SCHEMA, "calibrationId": "0" * 24, "metric": "guests", "today": through,
           "dataThrough": through, "horizonDays": forecast.HORIZON_DAYS, "termsThrough": None, "regimeStart": None,
           "days": days, "calendar": [], "champion": None}
    schema.validate_input(inp)
    return inp


def trained_dates(inp: dict) -> set[str]:
    frame = pipeline.frame_of(inp)
    return {forecast.iso(d) for d in features.training_rows(frame, pd.Timestamp(inp["dataThrough"])).date}


def future_status(inp: dict, weekday: str) -> set[str]:
    frame = pipeline.frame_of(inp)
    status = forecast.statuses(frame, pd.Timestamp(inp["dataThrough"]))
    return set(status[frame.weekday[status.index].eq(weekday).to_numpy()])


PARTY_MONDAYS = {"2025-08-11": 100.0, "2025-08-18": 100.0}  # counted parties whose leftovers look like full service


def test_counted_parties_on_closed_mondays_neither_reopen_mondays_nor_train():
    assert closed_weekdays_of("2025-08-31", PARTY_MONDAYS, party=tuple(PARTY_MONDAYS)) == {"Sunday", "Monday"}
    inp = closed_input(guests=PARTY_MONDAYS, party=tuple(PARTY_MONDAYS))
    assert future_status(inp, "Monday") == {"closed"}
    assert not set(PARTY_MONDAYS) & trained_dates(inp)
    assert pipeline.frame_of(inp)[features.PRIVATE_ON_CLOSED].sum() == 2
    # Unflagged, the same two Mondays are real service: they reopen Mondays and train (v12)
    assert closed_weekdays_of("2025-08-31", PARTY_MONDAYS) == {"Sunday"}
    plain = closed_input(guests=PARTY_MONDAYS)
    assert future_status(plain, "Monday") == {"open"}
    assert set(PARTY_MONDAYS) <= trained_dates(plain)


def test_an_uncounted_private_event_on_a_closed_monday_leaves_training():
    inp = closed_input(guests={"2025-08-18": 60.0}, private=("2025-08-18",))
    assert "2025-08-18" not in trained_dates(inp)
    assert future_status(inp, "Monday") == {"closed"}
    # The same day unflagged is one served Monday in 8: Mondays stay closed, but it trains
    assert "2025-08-18" in trained_dates(closed_input(guests={"2025-08-18": 60.0}))


@pytest.mark.parametrize("flag", ["party", "private"])
def test_a_party_every_friday_keeps_fridays_open_and_training(flag):
    fridays = tuple(forecast.iso(d) for d in pd.date_range("2025-03-07", "2025-08-31", freq="W-FRI"))
    inp = closed_input(**{flag: fridays})
    # Every Friday set aside leaves Friday no counted date, so it stays open (fewer than 2), and nothing is flagged
    assert "Friday" not in forecast.closed_weekdays(pipeline.frame_of(inp), pd.Timestamp("2025-08-31"))
    assert future_status(inp, "Friday") == {"open"}
    assert set(fridays) <= trained_dates(inp)  # a counted party on its leftovers


def test_a_party_on_an_open_weekday_trains_on_its_leftovers():
    inp = closed_input(guests={"2025-08-20": 70.0}, party=("2025-08-20",))  # a Wednesday
    frame = pipeline.frame_of(inp)
    hist = features.training_rows(frame, pd.Timestamp(inp["dataThrough"]))
    assert hist.guests[hist.date.eq(pd.Timestamp("2025-08-20"))].tolist() == [70.0]


def test_a_party_monday_before_the_closure_is_kept():
    inp = closed_input(party=("2025-05-19",))  # Mondays close from June
    assert "2025-05-19" in trained_dates(inp)


def test_a_party_spanning_saturday_to_monday_drops_only_monday():
    days = ("2025-08-16", "2025-08-17", "2025-08-18")
    inp = closed_input(guests=dict.fromkeys(days, 90.0), party=days, shut=(0,))  # Mondays alone are closed
    trained = trained_dates(inp)
    assert {"2025-08-16", "2025-08-17"} <= trained and "2025-08-18" not in trained


def test_a_days_flag_reads_only_the_weeks_before_it():
    """The flag is the same whether the data end on the party day or a year later, when Mondays have reopened, so every
    cutoff (and every backtest) trains on the same days."""
    party = ("2025-08-18",)
    short = pipeline.frame_of(closed_input("2025-08-18", {"2025-08-18": 100.0}, party))
    reopened = {forecast.iso(d): 100.0 for d in pd.date_range("2025-09-01", "2026-08-31", freq="W-MON")}
    long = pipeline.frame_of(closed_input("2026-08-31", {"2025-08-18": 100.0} | reopened, party))
    assert short[features.PRIVATE_ON_CLOSED].sum() == 1
    days = len(short[short.date <= pd.Timestamp("2025-08-18")])
    assert short[features.PRIVATE_ON_CLOSED][:days].tolist() == long[features.PRIVATE_ON_CLOSED][:days].tolist()
    assert "Monday" not in forecast.closed_weekdays(long, pd.Timestamp("2026-08-31"))


def test_a_party_monday_after_the_closure_is_in_no_engines_history_or_backtest():
    party = "2025-08-18"
    inp = closed_input(guests={party: 100.0}, party=(party,), first="2023-06-05")
    frame, through = pipeline.frame_of(inp), pd.Timestamp(inp["dataThrough"])
    hist = features.training_rows(frame, through)
    assert pd.Timestamp(party) not in set(hist.date)
    history = baseline.prepare(frame, inp["calendar"], through)
    assert pd.Timestamp(party) not in history.guests
    base_preds = baseline.backtest_predictions(history, through, [7, 28])
    assert not base_preds.empty and pd.Timestamp(party) not in set(base_preds.date)
    origins = backtest.quarterly_origins(hist.date.min(), through)[-1:]
    preds = forecast.backtest_predictions(frame, hist, origins, through, features.base_columns(None),
                                          features.event_columns(frame, hist.index))
    assert not preds.empty and pd.Timestamp(party) not in set(preds.date)
    assert pd.Timestamp("2025-08-19") in set(preds.date)  # its Tuesday is forecast as usual


def test_open_days_take_the_holiday_multipliers_and_ranges_widened_by_k(lab_input):
    frame, hist, _, base_cols, event_cols = _prepared(lab_input)
    through = pd.Timestamp(lab_input["dataThrough"])
    fitted = features.add_recent_level(frame, through)
    fit = model.hybrid_fit(fitted, fitted.loc[hist.index], base_cols, event_cols)
    common = dict(trained_from=hist.date.min(), data_through=through, made_at=lab_input["today"], code_version=CODE,
                  backtest_block=None)
    log_range = {"lo": -0.1, "hi": 0.2}
    common["end"], common["widening"] = through + pd.Timedelta(days=forecast.HORIZON_DAYS), []
    plain = forecast.run_file(fitted, fit, {"hol_big_night": 0.0, "hol_halloween": 0.0}, 1.0, log_range, **common)
    lifted = forecast.run_file(fitted, fit, {"hol_big_night": 0.3, "hol_halloween": 0.0}, 1.0, log_range, **common)
    wide = forecast.run_file(fitted, fit, {"hol_big_night": 0.0, "hol_halloween": 0.0}, 2.0, log_range, **common)
    # Past 28 days of lead, ranges widen by the longer horizon's ratio: here 1.5 from day 29 on
    longer = forecast.run_file(fitted, fit, {"hol_big_night": 0.0, "hol_halloween": 0.0}, 1.0, log_range,
                               **(common | {"widening": [(29, 1.5)]}))
    for p, w in zip(plain["days"], longer["days"]):
        if p["status"] == "open":
            factor = 1.5 if (day(p["date"]) - through.date()).days > 28 else 1.0
            assert w["mid"] == p["mid"]
            assert math.log(w["high"] / w["mid"]) == pytest.approx(factor * math.log(p["high"] / p["mid"]))
    assert [w["low"] for w in longer["weeks"]] != [w["low"] for w in plain["weeks"]]
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


@pytest.mark.parametrize("engine", ENGINES)
def test_booked_days_have_no_numbers_and_reason_booking(engine, results, lab_input):
    result = results[engine]
    end = result["run"]["days"][-1]["date"]
    booked = {d["date"] for d in lab_input["days"] if d["booked"] and lab_input["dataThrough"] < d["date"] <= end}
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


def test_baseline_reasons_carry_its_own_effects(result, lab_input):
    """The same reasons as the model's (kinds and refs), with effectPct from the baseline's multipliers on open days."""
    effects = result["params"]["calendarEffects"]
    by_date = {d["date"]: d for d in lab_input["days"]}
    seen = set()
    for d in result["run"]["days"]:
        for reason in d["reasons"]:
            if d["status"] != "open" or reason["kind"] not in ("event", "holiday"):
                assert reason["effectPct"] is None
            elif reason["kind"] == "event" and reason["ref"] is not None and reason["ref"] in effects:
                assert reason["effectPct"] == round((effects[reason["ref"]] - 1) * 100, 1)
                seen.add(reason["ref"])
        kinds = [r["kind"] for r in d["reasons"]]
        assert kinds.count("event") == len(by_date[d["date"]]["events"])
    assert "test-town:home-football" in seen


@pytest.mark.parametrize("which", ["model", "baseline"])
def test_messy_history_gives_finite_valid_output(which, messy, messy_baseline):
    inp, res = messy[0], (messy[1] if which == "model" else messy_baseline)
    assert res["ok"] is True
    assert finite_everywhere(res)
    json.dumps(res, allow_nan=False)
    assert run_file_issues(res["run"], inp["today"]) == []
    status = {d["date"]: d["status"] for d in res["run"]["days"]}
    assert all(s != "open" for when, s in status.items() if day(when).weekday() == 2)  # Wednesdays now closed
    assert which == "baseline" or "ev_one_off" in res["params"]["eventCols"]
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


def _baseline_weeks_with_range(first: pd.Timestamp, span: int) -> int:
    """The same for the baseline's weekly cutoffs: its first cutoff (baseline.first_cutoff), its window and bands."""
    through = first + pd.Timedelta(days=span)
    cutoff = baseline.first_cutoff(first)
    if cutoff >= through:
        return 0
    start, end = backtest.score_window([cutoff], through, pipeline.HORIZON)
    starts = pd.date_range(start, end - pd.Timedelta(days=6), freq="7D")
    return metrics.weekly_band_coverage(pd.Series(np.zeros(len(starts))), starts, starts + pd.Timedelta(days=6),
                                        pipeline.HORIZON)[1]


def test_baseline_min_history_days_always_gives_twelve_weeks_with_a_range():
    # Scheduled calibrations may start from baseline.MIN_HISTORY_DAYS (the API's GATE.baselineMinHistoryDays): every
    # first day of a year has 12 baseline backtest weeks with a range at 230 days, and some first day does not at 229.
    firsts = pd.date_range("2023-01-01", periods=366)
    assert baseline.MIN_HISTORY_DAYS == 230
    assert min(_baseline_weeks_with_range(first, baseline.MIN_HISTORY_DAYS) for first in firsts) >= 12
    assert min(_baseline_weeks_with_range(first, baseline.MIN_HISTORY_DAYS - 1) for first in firsts) < 12


def shortened(lab_input: dict, span: int) -> dict:
    """`lab_input` with its history cut to a `span`-day span ending on its last day of sales."""
    inp = copy.deepcopy(lab_input)
    start = (day(inp["dataThrough"]) - timedelta(days=span)).isoformat()
    inp["days"] = [d for d in inp["days"] if d["date"] >= start]
    assert inp["days"][0]["guests"]
    return inp


def test_not_enough_history(lab_input):
    inp = shortened(lab_input, baseline.MIN_HISTORY_DAYS - 1)
    out = pipeline.calibrate(inp, CODE)
    assert out == {"schema": schema.RESULT_SCHEMA, "calibrationId": inp["calibrationId"], "ok": False,
                   "code": "not_enough_history"}


@pytest.mark.parametrize("span", [pipeline.MIN_HISTORY_DAYS - 1, 400, baseline.MIN_HISTORY_DAYS])
def test_the_model_does_not_run_under_595_days(lab_input, span):
    # The fixture's current run is a model run: with the model not run, the lab returns the baseline's run, which
    # the gate holds (model_not_run)
    inp = shortened(lab_input, span)
    out = pipeline.calibrate(inp, CODE)
    card = out["scorecard"]
    assert out["ok"] is True and card["history"]["spanDays"] == span
    assert card["engine"] == "baseline" and card["engines"]["model"] is None
    assert out["run"]["model"]["family"] == "seasonal_baseline"
    assert card["backtest"]["weeksWithRange"] >= 12
    check_scorecard(card, "baseline")
    assert run_file_issues(out["run"], inp["today"]) == []


def without_level_jump(lab_input: dict) -> dict:
    """The fixture with its last year's 20% busier level taken out: a history the model's refits can learn."""
    inp = copy.deepcopy(lab_input)
    for d in inp["days"]:
        if d["date"] >= LEVEL_SHIFT.strftime("%Y-%m-%d") and d["guests"]:
            d["guests"] = round(d["guests"] / EFFECT["level_shift"])
    return inp


def test_a_first_forecast_needs_a_significant_win(lab_input):
    # This fixture's model bands hold 8 of 25 weeks, which the gate refuses (the next test), so its checks are taken
    # as passed here to pin the engine rule alone. Without its level jump the model is more than 0.5 points better on
    # the same weeks, but not week after week (D69: one-sided p about 0.12): with no current run the baseline stays
    inp = without_level_jump(lab_input)
    inp["champion"] = None
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(pipeline, "passes", lambda bt, engine, recorded_bias=None: True)
        out = pipeline.calibrate(inp, CODE)
    engines = out["scorecard"]["engines"]
    assert engines["model"]["weeklyWape"] <= engines["baseline"]["weeklyWape"] - pipeline.ENGINE_MARGIN
    assert out["scorecard"]["engine"] == "baseline" and out["run"]["model"]["family"] == "seasonal_baseline"
    assert engines["model"]["weeks"] == engines["baseline"]["weeks"]  # scored on the same weeks


def test_the_model_wins_a_first_forecast_when_its_win_is_significant(lab_input):
    inp = without_level_jump(lab_input)
    inp["champion"] = None
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(pipeline, "passes", lambda bt, engine, recorded_bias=None: True)
        patch.setattr(pipeline, "switch_p_value", lambda incumbent, challenger, lags=pipeline.SWITCH_LAGS:
                      0.0 if challenger.mean() < incumbent.mean() else 1.0)
        out = pipeline.calibrate(inp, CODE)
    assert out["scorecard"]["engine"] == "model" and out["run"]["model"]["family"] == "hybrid_linear_xgboost"


def test_the_baseline_is_chosen_when_it_clearly_wins(result, lab_input):
    # The fixture's current run is a model run, and its level jump makes the baseline more than 0.5 points better on
    # the same weeks: the lab switches engines
    engines = result["scorecard"]["engines"]
    assert lab_input["champion"]["engine"] == "model"
    assert engines["baseline"]["weeklyWape"] <= engines["model"]["weeklyWape"] - pipeline.ENGINE_MARGIN
    assert engines["model"]["weeks"] == engines["baseline"]["weeks"] == result["scorecard"]["backtest"]["weeks"]
    assert result["scorecard"]["engine"] == "baseline"
    # The two engines' backtests are scored on exactly the same weeks
    model_card = calibrate_as(lab_input, "model")["scorecard"]
    assert [r["week"] for r in model_card["backtest"]["series"]] == [
        r["week"] for r in result["scorecard"]["backtest"]["series"]]
    assert model_card["engines"] == engines


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
    _set(["schema"], "townwise.lab-input/1"),
    _set(["schema"], "townwise.lab-input/2"),
    _set(["termsThrough"], "2028-02-30"),
    _gap,
    _unsorted,
    _set(["metric"], "net_sales"),
    _set(["calibrationId"], "not-an-id"),
    _set(["horizonDays"], 182),
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
    _set(["champion", "engine"], None),
    _set(["champion", "recordedWeekdayBiasMeanAbs"], -0.01),
    _set(["champion", "recordedWeekdayBiasMeanAbs"], "0.03"),
    _set(["calendar", 0, "title"], "Test Town Festival"),
], ids=["schema", "schema_2", "terms_through", "gap", "unsorted", "metric", "calibration_id", "horizon", "today", "regime_start", "unknown_key",
        "negative_guests", "nan_guests", "guests_after_cutoff", "closed_not_bool", "term", "week_of_term",
        "event_group", "champion_day", "champion_week", "champion_run_id", "champion_engine",
        "champion_recorded_bias_negative", "champion_recorded_bias_not_a_number", "calendar_title"])
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
    frame = pipeline.frame_of(lab_input)
    pd.testing.assert_frame_equal(frame[lab_columns], expected, check_dtype=False)
    # D70's two columns: the fixture has no counted party, and its private events on closed Mondays have no guests
    assert list(frame.columns) == lab_columns[:10] + ["party"] + lab_columns[10:] + [features.PRIVATE_ON_CLOSED]
    assert not frame.party.any() and not frame[features.PRIVATE_ON_CLOSED].any()


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


def test_comparison_in_the_result_is_the_one_compare_makes(model_result, lab_input):
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    out = compare.compare(frame, hist, lab_input["champion"], origins, base_cols, event_cols)
    assert_close(model_result["scorecard"]["comparison"], out)


def test_the_baselines_comparison_uses_its_own_backtest(result, model_result, lab_input):
    # The returned engine's predictions against the current run, on the same weeks the model's comparison uses
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    through = pd.Timestamp(lab_input["dataThrough"])
    history = baseline.prepare(frame, lab_input["calendar"], through)
    preds = baseline.ranged(baseline.backtest_predictions(history, through, [7, 28, 91, 98]),
                            result["params"]["dailyLogRange"])
    # Its bands are drawn from its whole weekly backtest by baseline.weekly_band, from weeks of the same kind (with last
    # year's shape or without), as its scorecard's are
    past = pipeline._week_errors(preds, [baseline.first_cutoff(history.first_day)], through, 28)
    out = compare.compare(frame, hist, lab_input["champion"], origins, base_cols, event_cols, preds=preds, past=past,
                          rule=baseline.weekly_band, since=baseline.shaped_from(history.first_day))
    assert_close(result["scorecard"]["comparison"], out)
    mine, theirs = result["scorecard"]["comparison"], model_result["scorecard"]["comparison"]
    assert [r["week"] for r in mine["series"]] == [r["week"] for r in theirs["series"]]
    assert mine["champion"] == theirs["champion"] and mine["challenger"] != theirs["challenger"]


def test_comparison_none_without_champion(regime_result, lab_input):
    assert regime_result["ok"] is True and regime_result["scorecard"]["comparison"] is None
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    assert compare.compare(frame, hist, None, origins, base_cols, event_cols) is None


def test_comparison_none_when_no_week_is_comparable(lab_input):
    frame, hist, origins, base_cols, event_cols = _prepared(lab_input)
    late = synthetic_champion(frame, hist.date.max() - pd.Timedelta(days=3))  # no full week after it has sales yet
    assert compare.compare(frame, hist, late, origins, base_cols, event_cols) is None


def test_regime_start_adds_weekday_regime(regime_result, model_result):
    result = model_result
    assert regime_result["params"]["baseCols"][0] == "weekday_regime"
    assert regime_result["params"]["regimeStart"] == REGIME_START.strftime("%Y-%m-%d")
    assert run_file_issues(regime_result["run"], synthetic_input(0)["today"]) == []
    # The regime's own weekday levels change the forecast of the days it covers
    mids = [(a["mid"], b["mid"]) for a, b in zip(regime_result["run"]["days"], result["run"]["days"])
            if a["status"] == "open"]
    assert any(abs(a - b) > 1 for a, b in mids)


def test_a_regime_start_without_four_training_days_changes_nothing_but_params(model_result, lab_input):
    # From two weeks before the cutoff: no weekday has 4 days of the regime to learn its level from, and no backtest
    # refit has any, so every weekday keeps its plain level (features.limit_weekday_regime) everywhere
    result = model_result
    inp = copy.deepcopy(lab_input)
    inp["regimeStart"] = (day(inp["dataThrough"]) - timedelta(days=13)).isoformat()
    late = calibrate_as(inp, "model")
    assert late["params"]["baseCols"][0] == "weekday_regime"
    assert_close(late["run"], result["run"])
    assert_close(late["scorecard"], result["scorecard"])


@pytest.mark.parametrize("engine", ENGINES)
def test_backtest_block_mirrors_scorecard(engine, results):
    result = results[engine]
    run_bt, card_bt = result["run"]["backtest"], result["scorecard"]["backtest"]
    assert (run_bt["from"], run_bt["to"], run_bt["weeks"]) == (card_bt["from"], card_bt["to"], card_bt["weeks"])
    assert run_bt["weeklyTypicalErrorPct"] == round(card_bt["metrics"]["typicalWeek"] * 100, 1)
    assert run_bt["weeksOver20Pct"] == card_bt["metrics"]["weeksOver20"]
    lo, hi = result["params"]["weeklyLogRange"]["lo"], result["params"]["weeklyLogRange"]["hi"]
    assert run_bt["weeklyRangePct"] == {"below": round((1 - math.exp(lo)) * 100, 1),
                                        "above": round((math.exp(hi) - 1) * 100, 1)}


def test_backtest_scores_the_horizon_28_weeks(model_result, lab_input):
    result = model_result
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


def test_forecast_tier_unchanged(result):
    """Days 1 to 91 as D42 made them (D52 decision 4 (a)): the golden history's result as input version 2 gave it
    (golden/result-v2.json, develop's golden result.json at e53aaa53, the commit before year-long runs on this branch,
    regenerated once since, at 8aeb6df4: that same lab code with v11's Halloween weekend, which changes the fixture's
    guests and flags; it says model v10 there) against version 3's. Its forecast tier's days, reasons and weeks, its scorecard's gate fields and its
    params but the outlook's anchors are the same. The model's figures in `engines` come from XGBoost, whose sampling
    differs between builds, so they are held to the golden tolerance; everything else is the baseline's (pandas)."""
    v2 = json.loads((GOLDEN / "result-v2.json").read_text(encoding="utf-8"))
    tier_end = v2["run"]["days"][-1]["date"]
    assert tier_end == forecast.iso(forecast.forecast_end(pd.Timestamp(v2["run"]["madeAt"]),
                                                          pd.Timestamp(v2["run"]["dataThrough"])))
    run = result["run"]
    assert_close([d for d in run["days"] if d["date"] <= tier_end], v2["run"]["days"])
    assert_close([w for w in run["weeks"] if w["to"] <= tier_end], v2["run"]["weeks"])
    assert run["backtest"] == v2["run"]["backtest"] and run["dataThrough"] == v2["run"]["dataThrough"]
    card, card2 = result["scorecard"], v2["scorecard"]
    for key in ("horizonDays", "engine", "history", "backtest", "comparison", "horizon91", "horizonReach"):
        assert_close(card[key], card2[key], f"scorecard.{key}")
    assert_close(card["engines"]["baseline"], card2["engines"]["baseline"], "scorecard.engines.baseline")
    assert_close(card["engines"]["model"], card2["engines"]["model"], "scorecard.engines.model", rel=GOLDEN_REL,
                 abs_=GOLDEN_ABS, edge_slack=1)
    params, params2 = dict(result["params"]), dict(v2["params"])
    assert_close([w for w in params.pop("widening") if "horizon" not in w], params2.pop("widening"))
    assert_close(params, params2)


def test_golden_result_is_current(lab_input):
    golden_input = json.loads((GOLDEN / "input.json").read_text(encoding="utf-8"))
    golden_result = json.loads((GOLDEN / "result.json").read_text(encoding="utf-8"))
    assert golden_input == lab_input  # the fixture has not drifted from the golden input
    assert golden_result["codeVersion"] == "0" * 40
    assert_close(pipeline.calibrate(golden_input, golden_result["codeVersion"]), golden_result, rel=GOLDEN_REL,
                 abs_=GOLDEN_ABS, edge_slack=1)


# Which engine a calibration returns (design decision 8, D69): the current one sticks unless the other is 0.5 points
# better and that win is significant week by week; with no current run, the baseline unless the model wins that way

SIG = {"model_significant": True, "baseline_significant": True}


def test_with_no_current_run_the_model_needs_half_a_point_over_the_baseline():
    assert pipeline.choose_engine(None, 0.090, 0.102, **SIG) == "model"
    assert pipeline.choose_engine(None, 0.097, 0.102, **SIG) == "model"  # exactly 0.5 points
    assert pipeline.choose_engine(None, 0.098, 0.102, **SIG) == "baseline"
    assert pipeline.choose_engine(None, None, 0.102) == "baseline"  # the model did not run


def test_with_no_current_run_an_insignificant_model_win_returns_the_baseline():
    assert pipeline.choose_engine(None, 0.090, 0.102) == "baseline"
    assert pipeline.choose_engine(None, 0.090, 0.102, baseline_significant=True) == "baseline"


def test_close_engines_do_not_flip_flop():
    # The current run is a baseline run; over four weekly calibrations the model is 0.3 lower, 0.2 higher, 0.4 lower
    # and 0.1 lower than the baseline: every one keeps the baseline, and the same margins keep a current model
    for model_wape in (0.097, 0.102, 0.096, 0.099):
        assert pipeline.choose_engine("baseline", model_wape, 0.100, **SIG) == "baseline"
        assert pipeline.choose_engine("model", 0.100, model_wape, **SIG) == "model"


def test_a_six_tenths_win_switches_engines_when_it_is_significant():
    assert pipeline.choose_engine("baseline", 0.094, 0.100, **SIG) == "model"
    assert pipeline.choose_engine("model", 0.100, 0.094, **SIG) == "baseline"


def test_an_insignificant_win_keeps_the_current_engine():
    # D69: a large gap that is not significant week by week does not switch, however large
    assert pipeline.choose_engine("baseline", 0.050, 0.100) == "baseline"
    assert pipeline.choose_engine("model", 0.100, 0.050) == "model"


def test_a_current_model_that_could_not_run_returns_the_baseline():
    assert pipeline.choose_engine("model", None, 0.100) == "baseline"  # the gate holds it (model_not_run)


# D69's test: a one-sided Diebold-Mariano p-value on the weeks both engines scored

def _weeks(values):
    return pd.Series(values, index=pd.date_range("2026-02-02", periods=len(values), freq="7D"), dtype=float)


def test_a_consistent_win_is_significant():
    rng = np.random.default_rng(0)
    incumbent = _weeks(100 + rng.normal(0, 5, 40))
    challenger = incumbent - 8 + rng.normal(0, 3, 40)  # better nearly every week
    assert pipeline.switch_p_value(incumbent, challenger) < 0.01
    assert pipeline.switch_p_value(challenger, incumbent) > 0.99  # one-sided: the other way is not a win


def test_a_noisy_win_is_not_significant():
    rng = np.random.default_rng(1)
    incumbent = _weeks(100 + rng.normal(0, 5, 40))
    noise = rng.normal(0, 30, 40)
    challenger = incumbent - 1 - (noise - noise.mean())  # exactly 1 better on average, wildly either way week to week
    assert pipeline.switch_p_value(incumbent, challenger) > pipeline.SWITCH_ALPHA


def test_too_few_or_unvarying_weeks_are_never_significant():
    assert pipeline.switch_p_value(_weeks([100.0] * 11), _weeks([50.0] * 11)) == 1.0  # under 12 shared weeks
    assert pipeline.switch_p_value(_weeks([100.0] * 20), _weeks([90.0] * 20)) == 1.0  # differences that never vary
    assert pipeline.switch_p_value(_weeks([100.0] * 20), _weeks([100.0] * 20)) == 1.0


def test_only_shared_weeks_are_compared():
    incumbent = _weeks(np.linspace(100, 140, 30))
    challenger = incumbent.iloc[:11] - 10  # 11 shared weeks
    assert pipeline.switch_p_value(incumbent, challenger) == 1.0


# An engine the gate would refuse on its own checks (coverage, and the baseline's bias) is not returned when the other
# passes them: a WAPE winner whose ranges miss would leave a location with no current run without a forecast.

def test_with_no_current_run_a_winner_that_fails_its_checks_falls_back_to_the_other():
    assert pipeline.choose_engine(None, 0.090, 0.100, model_ok=False, **SIG) == "baseline"
    assert pipeline.choose_engine(None, 0.100, 0.090, baseline_ok=False, **SIG) == "model"
    # With neither passing, the WAPE rule stands and the gate says why
    assert pipeline.choose_engine(None, 0.090, 0.100, model_ok=False, baseline_ok=False, **SIG) == "model"


def test_an_engine_switch_needs_the_other_to_pass_its_checks():
    assert pipeline.choose_engine("baseline", 0.090, 0.100, model_ok=False, **SIG) == "baseline"
    assert pipeline.choose_engine("model", 0.100, 0.090, baseline_ok=False, **SIG) == "model"
    # A current engine that fails does not switch to a worse one: the current run stays until it lapses
    assert pipeline.choose_engine("model", 0.090, 0.100, model_ok=False, **SIG) == "model"


def bt_of(inside, weeks, bias=0.0, wape=0.10, median=0.15, weekday_bias=0.03):
    """The parts of an engine's backtest (pipeline._backtest) that passes reads."""
    return {"scores": {"coverage80": {"inside": inside, "weeks": weeks}, "weeklyWape": wape,
                       "weekdayBiasMeanAbs": weekday_bias}, "bias": bias, "median_wape": median}


def test_passes_mirrors_the_gates_absolute_checks():
    bt = bt_of
    assert pipeline.passes(bt(16, 20), "model")
    assert not pipeline.passes(bt(7, 20), "model")  # 35%: under 65%
    assert not pipeline.passes(bt(20, 20), "model")  # 100%: over 95%
    assert not pipeline.passes(bt(10, 11), "model")  # fewer than 12 weeks with a range
    assert pipeline.passes(bt(13, 20), "baseline") and pipeline.passes(bt(19, 20), "baseline")  # 65% and 95% pass
    assert pipeline.passes(bt(16, 20, bias=-0.05), "baseline")
    assert not pipeline.passes(bt(16, 20, bias=0.06), "baseline")  # biased
    assert pipeline.passes(bt(16, 20, bias=0.06), "model")  # the model's bias is judged by weekday


def test_passes_needs_each_engine_to_beat_its_own_weekday_median():
    # The gate's weekday-median check, on each engine's own benchmark (its training medians on its own cutoffs): the
    # model half a point under it, the baseline strictly under it
    assert pipeline.passes(bt_of(16, 20, wape=0.140, median=0.150), "model")
    assert not pipeline.passes(bt_of(16, 20, wape=0.148, median=0.150), "model")  # 0.2 points under: not enough
    assert pipeline.passes(bt_of(16, 20, wape=0.129, median=0.130), "baseline")
    assert not pipeline.passes(bt_of(16, 20, wape=0.130, median=0.130), "baseline")  # a tie fails
    assert not pipeline.passes(bt_of(16, 20, wape=0.132, median=0.130), "baseline")


def test_a_wape_winner_that_fails_only_its_weekday_median_gives_way():
    # The baseline is 0.8 points better than the model on the same weeks and passes coverage and bias, but its own
    # weekday-median benchmark (0.130) is lower than the model's (0.150): the gate would hold it baseline_not_beaten
    # while the model (1 point under its benchmark) would publish, so the lab returns the model
    model, base = bt_of(16, 20, wape=0.140, median=0.150), bt_of(16, 20, wape=0.132, median=0.130)
    ok = {"model_ok": pipeline.passes(model, "model"), "baseline_ok": pipeline.passes(base, "baseline")}
    assert ok == {"model_ok": True, "baseline_ok": False}
    assert pipeline.choose_engine(None, 0.140, 0.132, **ok, **SIG) == "model"
    assert pipeline.choose_engine("model", 0.140, 0.132, **ok, **SIG) == "model"  # no switch to a draft the gate holds


def test_a_model_needs_weekday_bias_within_two_points_of_the_current_runs_recorded_backtest():
    # The gate holds a model draft whose weekday bias is more than 2 points worse than the current run's recorded
    # backtest (gate.ts absolute, weekday_bias_worse); with no current run, or one with no recorded backtest (an
    # import), there is nothing to compare with. The baseline is not judged by weekday.
    model = bt_of(16, 20, wape=0.10, median=0.20, weekday_bias=0.06)
    assert pipeline.passes(model, "model") and pipeline.passes(model, "model", recorded_bias=None)
    assert pipeline.passes(model, "model", recorded_bias=0.04)  # exactly 2 points worse passes
    assert not pipeline.passes(model, "model", recorded_bias=0.03)
    assert pipeline.passes(bt_of(16, 20, wape=0.10, median=0.20, weekday_bias=0.50), "baseline", recorded_bias=0.03)


def test_no_switch_to_a_model_the_gate_would_hold_for_weekday_bias():
    # The current run is a baseline run whose calibration recorded a weekday bias of 3 points. The model is 2 points
    # better on the same weeks and passes coverage and its weekday median, but its weekday bias is 6 points: the gate
    # would hold its draft weekday_bias_worse, while the baseline's refit would publish (refreshed), so the lab keeps
    # the baseline
    model, base = bt_of(16, 20, wape=0.10, median=0.20, weekday_bias=0.06), bt_of(16, 20, wape=0.12, median=0.20)
    ok = {"model_ok": pipeline.passes(model, "model", recorded_bias=0.03),
          "baseline_ok": pipeline.passes(base, "baseline", recorded_bias=0.03)}
    assert ok == {"model_ok": False, "baseline_ok": True}
    assert pipeline.choose_engine("baseline", 0.10, 0.12, **ok, **SIG) == "baseline"


def test_calibrate_judges_the_model_by_the_current_runs_recorded_weekday_bias(lab_input):
    judged = []

    def record(bt, engine, recorded_bias=None):
        judged.append((engine, recorded_bias))
        return True

    inp = copy.deepcopy(lab_input)
    for recorded in (0.031, None):
        inp["champion"]["recordedWeekdayBiasMeanAbs"] = recorded
        judged.clear()
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(pipeline, "passes", record)
            pipeline.calibrate(inp, CODE)
        assert ("model", recorded) in judged
    inp["champion"] = None
    judged.clear()
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(pipeline, "passes", record)
        pipeline.calibrate(inp, CODE)
    assert ("model", None) in judged


def test_calibrate_judges_each_engine_by_its_own_weekday_median(lab_input):
    # The fixture's current run is a model run and the baseline wins by more than 0.5 points; with the baseline's own
    # weekday median moved to its WAPE (a tie, which the gate refuses), the lab keeps the model
    real = pipeline._backtest

    def baseline_ties_its_median(preds, origins, through, calibration=None):
        bt = real(preds, origins, through, calibration)
        if bt is not None and calibration is not None:  # the baseline's backtest (its bands have a calibration)
            bt["median_wape"] = bt["scores"]["weeklyWape"]
        return bt

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(pipeline, "_backtest", baseline_ties_its_median)
        out = pipeline.calibrate(lab_input, CODE)
    card = out["scorecard"]
    assert card["engines"]["baseline"]["weeklyWape"] <= card["engines"]["model"]["weeklyWape"] - pipeline.ENGINE_MARGIN
    assert card["engine"] == "model"


def test_a_model_that_wins_on_wape_but_fails_coverage_returns_the_baseline(lab_input):
    # With the level jump taken out and no current run, the model is 1.3 points better than the baseline on the same
    # weeks, but its 80% bands hold 8 of 25 weeks (under 65%), so the gate would hold its draft
    # (coverage_out_of_band); the baseline passes every check, so it is returned
    inp = without_level_jump(lab_input)
    inp["champion"] = None
    out = pipeline.calibrate(inp, CODE)
    engines = out["scorecard"]["engines"]
    assert engines["model"]["weeklyWape"] <= engines["baseline"]["weeklyWape"] - pipeline.ENGINE_MARGIN
    model_coverage = engines["model"]["coverage80"]
    assert model_coverage["inside"] / model_coverage["weeks"] < pipeline.COVERAGE_MIN
    assert out["scorecard"]["engine"] == "baseline" and out["run"]["model"]["family"] == "seasonal_baseline"
    baseline_coverage = out["scorecard"]["backtest"]["metrics"]["coverage80"]
    assert pipeline.COVERAGE_MIN <= baseline_coverage["inside"] / baseline_coverage["weeks"] <= pipeline.COVERAGE_MAX
    assert abs(out["scorecard"]["backtest"]["weeklyBias"]) <= pipeline.BASELINE_BIAS_MAX
