"""The baseline engine (baseline.py) on small synthetic histories built for each rule: the weekday level, the seasonal
shape and its clamp, calendar effects, shared day statuses and the reasons' effectPct. Synthetic data only."""

from collections.abc import Callable

import numpy as np
import pandas as pd
import pytest

from townwise_lab import backtest, baseline, forecast, metrics, pipeline, schema

LEVEL = {"Monday": 30, "Tuesday": 40, "Wednesday": 100, "Thursday": 55, "Friday": 85, "Saturday": 100, "Sunday": 50}
FOOTBALL = "test-town:home-football"
PARADE = "test-town:parade"


def ts(day: str) -> pd.Timestamp:
    return pd.Timestamp(day)


def iso(day: pd.Timestamp) -> str:
    return day.strftime("%Y-%m-%d")


def make_input(first: str, through: str, guests: Callable[[pd.Timestamp], float | None],
               events: Callable[[pd.Timestamp], list[str]] = lambda day: [], calendar: list[dict] | None = None) -> dict:
    """A valid LabInput from `first` to `through` + 182 days: guests from `guests` (None after `through`), interim days,
    the events `events` names, the given calendar, and no champion."""
    end = ts(through) + pd.Timedelta(days=forecast.HORIZON_DAYS)
    days = []
    for day in pd.date_range(first, end):
        count = guests(day) if day <= ts(through) else None
        days.append({"date": iso(day), "guests": count, "term": "interim", "weekOfTerm": -1, "events": events(day),
                     "closed": False, "privateEvent": False, "booked": False})
    inp = {"schema": schema.INPUT_SCHEMA, "calibrationId": "0" * 24, "metric": "guests", "today": through,
           "dataThrough": through, "horizonDays": forecast.HORIZON_DAYS, "regimeStart": None, "days": days,
           "calendar": calendar or [], "champion": None}
    schema.validate_input(inp)
    return inp


def prepared(inp: dict) -> tuple[pd.DataFrame, baseline.History]:
    frame = pipeline.frame_of(inp)
    return frame, baseline.prepare(frame, inp["calendar"], pd.Timestamp(inp["dataThrough"]))


def future(frame: pd.DataFrame, through: str, days: int = 35) -> pd.DataFrame:
    return frame[(frame.date > ts(through)) & (frame.date <= ts(through) + pd.Timedelta(days=days))]


def weekly(day: pd.Timestamp) -> float:
    return float(LEVEL[day.day_name()])


def test_a_known_weekday_pattern_is_forecast_as_it_was():
    inp = make_input("2024-06-03", "2025-08-31", weekly)
    frame, history = prepared(inp)
    rows = future(frame, inp["dataThrough"])
    numbers = baseline.predict(history, ts(inp["dataThrough"]), rows.index)
    assert numbers.mid.tolist() == [LEVEL[name] for name in rows.weekday]
    assert numbers.base.tolist() == numbers.mid.tolist()  # no calendar effect on these days


def test_the_level_is_the_median_of_the_last_eight_plain_same_weekdays():
    # Fridays step from 85 to 115 four weeks before the cutoff: 4 of the last 8 at 115 give a median of 100
    step = ts("2025-08-08")
    inp = make_input("2024-06-03", "2025-08-31",
                     lambda day: 115.0 if day.day_name() == "Friday" and day >= step else weekly(day))
    _, history = prepared(inp)
    assert baseline.level(history, "Friday", ts("2025-08-31")) == 100.0
    assert baseline.level(history, "Friday", step - pd.Timedelta(days=1)) == 85.0


def football_days(day: pd.Timestamp) -> bool:
    # Every other fall Saturday, 2024 and 2025, with one more on 2025-10-11 (after the cutoff)
    return (day.day_name() == "Saturday" and day.month in (9, 10, 11)
            and (day - ts("2024-09-14")).days % 14 == 0)


def test_a_home_game_group_lifts_saturdays_by_its_own_past_ratio():
    calendar = [{"id": f"test-town:{iso(d)}:home-football", "group": FOOTBALL, "kind": "event", "start": iso(d),
                 "end": iso(d), "confidence": "high"}
                for d in pd.date_range("2024-06-03", "2026-04-01") if football_days(d)]
    inp = make_input("2024-06-03", "2025-10-05",
                     lambda day: 130.0 if football_days(day) else weekly(day),
                     events=lambda day: [FOOTBALL] if football_days(day) else [], calendar=calendar)
    frame, history = prepared(inp)
    cutoff = ts(inp["dataThrough"])
    assert sum(football_days(d) for d in pd.date_range("2024-06-03", cutoff)) >= 6
    effects = baseline.effects(history, cutoff)
    assert effects[FOOTBALL] == pytest.approx(1.3)
    # The lab's own big nights and Halloween are holidays too; on this flat history they change nothing
    assert {k: v for k, v in effects.items() if k != FOOTBALL} == {k: pytest.approx(1.0) for k in baseline.LAB_HOLIDAYS}

    game, plain = ts("2025-10-11"), ts("2025-10-18")
    rows = frame[frame.date.isin([game, plain])]
    numbers = baseline.predict(history, cutoff, rows.index).set_axis([game, plain])
    assert numbers.mid[game] == pytest.approx(100 * 1.3)  # the Saturday level, a shape of 1, times the game's 1.3
    assert numbers.base[game] == pytest.approx(100.0) and numbers.mid[plain] == pytest.approx(100.0)

    run = baseline_run(inp)
    reasons = next(d["reasons"] for d in run["days"] if d["date"] == iso(game))
    assert {"kind": "event", "ref": FOOTBALL, "effectPct": 30.0} in reasons
    assert next(d for d in run["days"] if d["date"] == iso(game))["mid"] == pytest.approx(130.0)


def test_a_holiday_needs_one_past_occurrence_against_the_same_weekday_four_weeks_either_side():
    july4 = [ts("2024-07-04"), ts("2025-07-04")]
    calendar = [{"id": f"us:independence-day:{d.year}", "group": "us:independence-day", "kind": "holiday",
                 "start": iso(d), "end": iso(d), "confidence": None} for d in july4 + [ts("2026-07-04")]]
    inp = make_input("2024-06-03", "2025-08-31", lambda day: 2 * weekly(day) if day in july4 else weekly(day),
                     calendar=calendar)
    _, history = prepared(inp)
    assert baseline.effects(history, ts("2025-08-31"))["us:independence-day"] == pytest.approx(2.0)
    # Before its first occurrence there is nothing to learn from
    assert "us:independence-day" not in baseline.effects(history, ts("2024-07-03"))


def test_a_closed_weekday_is_closed_with_no_figures_as_the_models_would_be():
    through = "2025-08-31"
    last_mondays = ts(through) - pd.Timedelta(days=70)
    inp = make_input("2024-06-03", through,
                     lambda day: None if day.day_name() == "Monday" and day >= last_mondays else weekly(day))
    frame = pipeline.frame_of(inp)
    status = forecast.statuses(frame, ts(through))
    run = baseline_run(inp)
    mondays = [d for d in run["days"] if ts(d["date"]).day_name() == "Monday"]
    assert mondays and all(d["status"] == "closed" for d in mondays)
    assert all((d["low"], d["mid"], d["high"], d["baseline"]) == (None, None, None, None) for d in mondays)
    assert all(d["reasons"][0] == {"kind": "closure", "ref": None, "effectPct": None} for d in mondays)
    # The same statuses the model's run takes, day by day
    by_date = dict(zip(frame.date[status.index].dt.strftime("%Y-%m-%d"), status))
    assert all(d["status"] == by_date[d["date"]] for d in run["days"])


def test_a_one_off_event_or_a_group_without_enough_history_has_no_effect():
    through = "2025-08-31"
    parade, one_off = ts("2025-09-06"), ts("2025-09-13")  # Saturdays after the cutoff
    calendar = [{"id": f"test-town:{iso(d)}:parade", "group": PARADE, "kind": "event", "start": iso(d), "end": iso(d),
                 "confidence": "low"} for d in (ts("2025-05-03"), parade)]
    calendar += [{"id": f"test-town:{iso(one_off)}:fair", "group": None, "kind": "event", "start": iso(one_off),
                  "end": iso(one_off), "confidence": "low"}]
    events = {ts("2025-05-03"): [PARADE], parade: [PARADE], one_off: ["one_off"]}
    inp = make_input("2024-06-03", through, lambda day: 150.0 if day == ts("2025-05-03") else weekly(day),
                     events=lambda day: events.get(day, []), calendar=sorted(calendar, key=lambda e: e["start"]))
    frame, history = prepared(inp)
    assert PARADE not in baseline.effects(history, ts(through))  # one past parade: under 3 days with it
    rows = frame[frame.date.isin([parade, one_off])]
    assert baseline.predict(history, ts(through), rows.index).mid.tolist() == [100.0, 100.0]
    run = {d["date"]: d for d in baseline_run(inp)["days"]}
    assert {"kind": "event", "ref": PARADE, "effectPct": None} in run[iso(parade)]["reasons"]
    assert {"kind": "event", "ref": None, "effectPct": None} in run[iso(one_off)]["reasons"]


@pytest.mark.parametrize("last_year, shape", [(1000.0, 2.0), (5.0, 0.5), (150.0, 1.5)])
def test_the_seasonal_shape_is_last_years_ratio_clamped(last_year, shape):
    through, target = "2025-08-31", ts("2025-10-01")  # a Wednesday 31 days after the cutoff
    around = {target - pd.Timedelta(days=364 + k) for k in (-7, 0, 7)}
    inp = make_input("2024-06-03", through, lambda day: last_year if day in around else weekly(day))
    frame, history = prepared(inp)
    assert baseline.shape(history, target, ts(through)) == pytest.approx(shape)
    rows = frame[frame.date == target]
    assert baseline.predict(history, ts(through), rows.index).mid.iloc[0] == pytest.approx(100 * shape)


def test_the_shape_is_one_without_three_days_last_year():
    inp = make_input("2025-01-06", "2025-08-31", weekly)  # under a year: no last year around the target
    _, history = prepared(inp)
    assert baseline.shape(history, ts("2025-10-01"), ts("2025-08-31")) == 1.0


def baseline_run(inp: dict) -> dict:
    """The baseline's run file for `inp`, through 91 days after its cutoff, with no widening."""
    frame, history = prepared(inp)
    through = ts(inp["dataThrough"])
    return baseline.run_file(history, frame, data_through=through, end=through + pd.Timedelta(days=91), widen_k=1.0,
                             daily_log_range={"lo": -0.1, "hi": 0.1}, weekly_log_range={"lo": -0.1, "hi": 0.1},
                             widening=[], trained_from=frame.date.min(), made_at=inp["today"],
                             code_version="0" * 40, backtest_block=None)


def noisy(seed: int) -> Callable[[pd.Timestamp], float]:
    rng = np.random.default_rng(seed)
    noise = {}

    def guests(day: pd.Timestamp) -> float:
        noise.setdefault(day, float(rng.lognormal(0.0, 0.15)))
        return round(weekly(day) * noise[day])
    return guests


def test_the_backtest_forecasts_each_week_from_a_sunday_cutoff_at_least_h_days_before_its_monday():
    inp = make_input("2024-06-05", "2025-01-20", noisy(3))  # a 229-day span: too short for 12 weeks with a range
    _, history = prepared(inp)
    through = ts(inp["dataThrough"])
    preds = baseline.backtest_predictions(history, through, [7, 28, 91])
    assert list(preds.columns) == backtest.PRED_COLUMNS
    assert (preds.refit.dt.day_of_week == 6).all()  # Sundays
    assert preds.refit.min() == baseline.first_cutoff(history.first_day) == ts("2024-07-07")
    assert preds.date.max() <= through and preds.date.isin(list(history.guests)).all()
    monday = preds.date - pd.to_timedelta(preds.date.dt.day_of_week, unit="D")
    lead = (monday - preds.refit).dt.days
    assert set(lead) == {8, 29, 92}  # the first Monday at least 7, 28 and 91 days after each Sunday
    for horizon in (7, 28, 91):
        picked = backtest.pick(preds, horizon, preds.date.min(), through)
        picked_monday = picked.date - pd.to_timedelta(picked.date.dt.day_of_week, unit="D")
        assert ((picked_monday - picked.refit).dt.days == horizon + 1).all()
    # The weekday median is the training days' median by weekday up to the cutoff, as the model backtest's is
    row = preds.iloc[-1]
    train = [g for d, g in history.guests.items() if d <= row.refit and d.day_name() == row.weekday]
    assert row.weekday_median == np.median(train)
    # Each prediction is predict() from its own cutoff
    for cutoff, rows in preds.groupby("refit"):
        index = pd.Index([history.dates[history.dates == d].index[0] for d in rows.date])
        assert rows.mid.tolist() == baseline.predict(history, cutoff, index).mid.tolist()


@pytest.mark.parametrize("span, enough", [(230, True), (229, False)])
def test_a_230_day_span_gives_twelve_backtest_weeks_with_a_range(span, enough):
    first = ts("2024-06-03")  # a Monday: its first cutoff is 34 days later, the latest any first day gets
    through = first + pd.Timedelta(days=span)
    inp = make_input(iso(first), iso(through), noisy(4))
    _, history = prepared(inp)
    preds = baseline.backtest_predictions(history, through, [7, 28])
    window = backtest.score_window([baseline.first_cutoff(first)], through, 28)
    days = backtest.pick(baseline.ranged(preds, {"lo": -0.2, "hi": 0.2}), 28, *window)
    weeks = metrics.weekly_totals(days)
    with_range = metrics.weekly_band_coverage(np.log(weeks.actual / weeks.pred), weeks.index,
                                              weeks.index + pd.Timedelta(days=6), 28)[1]
    assert (with_range >= 12) is enough


def test_ranged_sets_each_days_range_from_the_daily_log_errors():
    days = pd.DataFrame({"actual": [90.0, 100, 110, 120, 80, 100, 100, 100, 100, 100], "mid": [100.0] * 10})
    log_range = baseline.daily_log_range(days)
    assert log_range["lo"] == pytest.approx(np.quantile(np.log(days.actual / 100), 0.1))
    assert log_range["hi"] == pytest.approx(np.quantile(np.log(days.actual / 100), 0.9))
    out = baseline.ranged(days, log_range)
    assert (out.lo <= out.mid).all() and (out.mid <= out.hi).all()
    assert out.hi.iloc[0] == pytest.approx(100 * np.exp(log_range["hi"]))
