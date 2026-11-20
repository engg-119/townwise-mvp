import builtins
import io

import numpy as np
import pandas as pd
import pytest
from fixture import (CLOSED_NO_ROW, CLOSED_WITH_GUESTS, DATA_THROUGH, FESTIVAL, FIRST_DAY, FOOTBALL, FUTURE_DAYS,
                     NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS, REGIME_START, ZERO_GUEST_DAYS, synthetic_frame)
from numpy.testing import assert_allclose

from townwise_lab import backtest, features, holidays, metrics, model


def ts(day: str) -> pd.Timestamp:
    return pd.Timestamp(day)


def test_fixture_is_deterministic_and_reads_no_file(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the fixture opened a file")

    monkeypatch.setattr(builtins, "open", refuse)
    monkeypatch.setattr(io, "open", refuse)
    first, second = synthetic_frame(0), synthetic_frame(0)
    pd.testing.assert_frame_equal(first, second)
    assert not synthetic_frame(1).guests.equals(first.guests)


def test_fixture_has_every_case_the_lab_must_handle():
    f = synthetic_frame(0)
    hist = f[f.date <= DATA_THROUGH]
    assert f.date.min() == FIRST_DAY and f.date.max() == DATA_THROUGH + pd.Timedelta(days=FUTURE_DAYS)
    assert (f.date.diff().dropna() == pd.Timedelta(days=1)).all()
    assert f.loc[f.date > DATA_THROUGH, "guests"].isna().all()
    assert set(f.term) == {"fall", "winter", "spring", "summer", "interim"}
    assert hist[FESTIVAL].sum() > 0 and hist[FOOTBALL].sum() > 0
    assert f.loc[f.date > DATA_THROUGH, FOOTBALL].sum() > 0  # events in the forecast window too
    assert (hist.guests == 0).sum() == len(ZERO_GUEST_DAYS)
    mondays = (f.weekday == "Monday") & (f.date >= REGIME_START) & (f.date <= DATA_THROUGH)
    assert mondays.any() and f.loc[mondays, "guests"].isna().all() and not f.loc[mondays, "closed"].any()
    assert (hist.booked & hist.guests.gt(0)).any() and (f.booked & (f.date > DATA_THROUGH)).any()
    assert (hist.private_event.eq(1) & ~hist.booked).any()
    assert f.booked.le(f.private_event.astype(bool)).all()  # a booking is a private event
    assert f.loc[f.date.isin(pd.to_datetime(CLOSED_NO_ROW)), "guests"].isna().all()
    assert f.loc[f.date.isin(pd.to_datetime(CLOSED_WITH_GUESTS)), "guests"].gt(0).all()
    assert hist.loc[hist.date >= DATA_THROUGH - pd.Timedelta(days=364), "guests"].mean() > hist.loc[
        hist.date < DATA_THROUGH - pd.Timedelta(days=364), "guests"].mean()


def test_holiday_flags_follow_the_notebook_rules():
    f = synthetic_frame(0)
    flags = features.holiday_flags(f.date)
    assert list(flags.columns) == ["hol_big_night", "hol_halloween", "hol_closed", "federal_holiday"]
    pd.testing.assert_frame_equal(flags, f[list(flags.columns)])
    on = dict(zip(f.date, flags.itertuples(index=False)))
    assert on[ts("2024-11-27")].hol_big_night == 1 and on[ts("2024-11-28")].hol_closed == 1  # Thanksgiving Eve and Day
    assert on[ts("2024-12-23")].hol_big_night == 1 and on[ts("2025-12-31")].hol_big_night == 1
    assert on[ts("2025-10-31")].hol_halloween == 1
    assert all(on[ts(d)].hol_closed == 1 for d in ("2025-01-01", "2024-07-04", "2025-12-24", "2025-12-25"))
    assert on[ts("2024-01-15")].federal_holiday == 1 and on[ts("2024-01-15")].hol_closed == 0  # MLK Day
    assert on[ts("2024-03-15")] == (0, 0, 0, 0)


def test_halloween_flags_the_weekend_around_it():
    days = pd.Series(pd.date_range("2025-10-20", "2029-11-10"))
    flagged = set(days[features.halloween_weekend(days)].dt.strftime("%Y-%m-%d"))
    assert flagged == {
        "2025-10-31", "2025-11-01",  # Friday Halloween: it and the Saturday after
        "2026-10-30", "2026-10-31",  # Saturday: the Friday before
        "2027-10-29", "2027-10-30", "2027-10-31",  # Sunday, a closed day at many places: its Friday and Saturday still
        "2028-10-27", "2028-10-28", "2028-10-31",  # Tuesday: the weekend before (Friday Oct 27)
        "2029-10-31", "2029-11-02", "2029-11-03",  # Wednesday: the weekend after (Friday Nov 2)
    }


def test_quarterly_origins():
    assert backtest.quarterly_origins(ts("2024-01-01"), ts("2025-10-21")) == [
        ts("2024-12-31"), ts("2025-03-31"), ts("2025-06-30"), ts("2025-09-30")]


def test_quarterly_origins_need_a_year_of_history():
    assert backtest.quarterly_origins(ts("2024-01-01"), ts("2024-12-31")) == []
    assert backtest.quarterly_origins(ts("2024-03-15"), ts("2025-10-21")) == [ts("2025-03-31"), ts("2025-06-30"),
                                                                             ts("2025-09-30")]


def test_quarterly_origins_end_seven_days_before_the_cutoff():
    # A later origin could forecast no day of the data at the shortest horizon scored (7 days)
    assert backtest.quarterly_origins(ts("2024-01-01"), ts("2025-10-07"))[-1] == ts("2025-09-30")
    assert backtest.quarterly_origins(ts("2024-01-01"), ts("2025-10-06"))[-1] == ts("2025-06-30")


def test_score_window():
    origins = backtest.quarterly_origins(FIRST_DAY, DATA_THROUGH)
    # The first Monday at least `horizon` days after the first origin, to the last Sunday on or before the cutoff
    assert backtest.score_window(origins, DATA_THROUGH, 28) == (ts("2025-02-03"), ts("2025-10-19"))
    assert backtest.score_window(origins, DATA_THROUGH, 7) == (ts("2025-01-13"), ts("2025-10-19"))
    assert backtest.score_window(origins, ts("2025-10-19"), 7)[1] == ts("2025-10-19")


def test_pick_takes_the_latest_origin_at_least_horizon_days_before_the_monday():
    refits = [ts("2025-01-31"), ts("2025-02-28")]
    dates = pd.to_datetime(["2025-03-03", "2025-03-28", "2025-03-30", "2025-03-31"])  # Mon, Fri, Sun, Mon
    preds = pd.DataFrame({"refit": np.repeat(refits, len(dates)), "date": np.tile(dates, 2),
                          "mid": [1.0, 1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 2.0]})
    picked = backtest.pick(preds, 28, ts("2025-03-01"), ts("2025-03-31")).set_index("date").mid
    # 2025-03-03's week starts 2025-03-03: only the January refit is 28 days before it; 2025-03-31's week: February's
    assert picked.to_dict() == {ts("2025-03-03"): 1.0, ts("2025-03-28"): 1.0, ts("2025-03-30"): 1.0,
                                ts("2025-03-31"): 2.0}
    assert backtest.pick(preds, 28, ts("2025-03-29"), ts("2025-03-30")).date.tolist() == [ts("2025-03-30")]


def test_recent_level_is_rolling_year_and_future():
    f = synthetic_frame(0)
    through = ts("2025-06-30")
    out = features.add_recent_level(f, through)
    start = through - pd.Timedelta(days=364)
    assert (out.loc[out.date >= start, "recent_level"] == 1).all()
    assert (out.loc[out.date < start, "recent_level"] == 0).all()
    assert (out.loc[out.date > DATA_THROUGH, "recent_level"] == 1).all()
    assert "recent_level" not in f


def test_training_rows_drop_zero_missing_closed_and_booked():
    f = pd.DataFrame({"date": pd.date_range("2025-01-01", periods=7),
                      "guests": [10.0, 0.0, np.nan, 12.0, 14.0, 16.0, 18.0],
                      "closed": [False, False, False, True, False, False, False],
                      "booked": [False, False, False, False, True, False, False]})
    assert features.training_rows(f, ts("2025-01-06")).index.tolist() == [0, 5]

    fixture = synthetic_frame(0)
    rows = features.training_rows(fixture, DATA_THROUGH)
    assert rows.guests.gt(0).all() and not rows.closed.any() and not rows.booked.any()
    assert rows.date.max() <= DATA_THROUGH
    assert rows.index.equals(fixture.index[fixture.index.isin(rows.index)])  # rows keep the frame's labels


def test_event_columns_sorted_and_only_seen_in_training(frame):
    seen = frame.index[frame.date <= DATA_THROUGH]
    tail = ["private_event", "week_of_term", "weekday"]
    assert features.event_columns(frame, seen) == [FESTIVAL, FOOTBALL] + tail
    assert features.event_columns(frame, frame.index[frame.date <= ts("2024-08-31")]) == [FESTIVAL] + tail
    extra = frame.assign(**{"ev_one_off": (frame.date == ts("2024-05-02")).astype(int),
                            "ev_test-town:new-fair": (frame.date > DATA_THROUGH).astype(int)})
    assert features.event_columns(extra, seen) == ["ev_one_off", FESTIVAL, FOOTBALL] + tail
    no_private = frame.assign(private_event=0)
    assert features.event_columns(no_private, seen) == [FESTIVAL, FOOTBALL, "week_of_term", "weekday"]


def test_weekday_regime_splits_levels_from_regime_start():
    f = synthetic_frame(0)
    out = features.add_weekday_regime(f, REGIME_START)
    before = out.date < REGIME_START
    assert (out.loc[before, "weekday_regime"] == out.loc[before, "weekday"]).all()
    assert (out.loc[~before, "weekday_regime"] == out.loc[~before, "weekday"] + " (regime)").all()
    assert (features.add_weekday_regime(f, None).weekday_regime == f.weekday).all()
    assert features.base_columns(None) == ["weekday", "recent_level", "term"]
    assert features.base_columns(REGIME_START) == ["weekday_regime", "recent_level", "term"]

    train = features.training_rows(out, DATA_THROUGH)
    X = model.design(out, ["weekday_regime"], train.index)
    assert {"weekday_regime_Tuesday", "weekday_regime_Tuesday (regime)"} <= set(X.columns)
    assert "weekday_regime_Monday (regime)" not in X  # no Monday since the regime started: nothing to learn


def test_weekday_regime_keeps_a_level_only_with_four_training_days():
    f = pd.DataFrame({"date": pd.date_range("2025-01-06", "2025-02-16")})  # six weeks, Monday to Sunday
    f["weekday"] = f.date.dt.day_name()
    f = features.add_weekday_regime(f, ts("2025-01-13"))
    train = f.index[(f.date <= ts("2025-02-09")) & (f.date != ts("2025-01-14"))]  # four regime weeks, a Tuesday short
    out = features.limit_weekday_regime(f, train)
    plain = (out.date < ts("2025-01-13")) | (out.weekday == "Tuesday")  # later days included, not only training
    assert (out.loc[plain, "weekday_regime"] == out.loc[plain, "weekday"]).all()
    assert (out.loc[~plain, "weekday_regime"] == out.loc[~plain, "weekday"] + " (regime)").all()
    assert f.weekday_regime.str.endswith(" (regime)").sum() == 35  # the input is left as it was
    assert "weekday_regime" not in features.limit_weekday_regime(f.drop(columns="weekday_regime"), train)


def test_weekday_bias_matches_cell_76_rule(frame):
    d = features.training_rows(frame, DATA_THROUGH)
    d = d[d.date >= REGIME_START]  # no Mondays since the regime started
    factor = d.weekday.map({"Tuesday": 0.9, "Wednesday": 1.2, "Thursday": 1.0, "Friday": 1.05, "Saturday": 0.8,
                            "Sunday": 1.1})
    days = pd.DataFrame({"date": d.date, "weekday": d.weekday, "actual": d.guests, "mid": d.guests * factor})
    # Cell 76's rule, verbatim on the notebook's column names
    by_wd = days.rename(columns={"mid": "pred", "actual": "guests"}).groupby("weekday")[["pred", "guests"]].sum()
    expected = by_wd.pred / by_wd.guests - 1

    bias = metrics.weekday_bias(days)
    assert list(bias) == ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    assert bias["Mon"] is None
    for weekday, value in expected.items():
        assert bias[weekday[:3]] == pytest.approx(value, rel=1e-12)
    assert bias["Tue"] == pytest.approx(-0.1) and bias["Sat"] == pytest.approx(-0.2)

    few = days[(days.weekday != "Wednesday") | (days.date < days.date.min() + pd.Timedelta(days=21))]
    assert (few.weekday == "Wednesday").sum() == 3
    counted = [abs(v) for k, v in metrics.weekday_bias(few).items() if k not in ("Mon", "Wed")]
    assert metrics.mean_abs_bias(few) == pytest.approx(np.mean(counted), rel=1e-12)
    assert metrics.mean_abs_bias(days.iloc[:0]) == 0.0


def test_choose_k_stops_at_the_widest_range_when_none_reaches_the_target():
    days = pd.DataFrame({"actual": [10.0, 20.0], "lo": [5.0, 5.0], "mid": [5.0, 5.0], "hi": [5.0, 5.0]})
    assert metrics.choose_k(days) == 3.0


def test_metrics_follow_the_contract(preds, window):
    days = backtest.pick(preds, 28, *window)
    weeks = metrics.weekly_totals(days)
    log_err = np.log(weeks.actual / weeks.pred)
    m = metrics.metrics(days, weeks, 28, log_err)
    assert list(m) == ["weeklyWape", "dailyWape", "typicalWeek", "weeksOver20", "worstWeek", "coverage80",
                       "dailyCoverage80", "weekdayBias", "weekdayBiasMeanAbs"]
    for key in ("weeklyWape", "dailyWape", "typicalWeek", "worstWeek", "dailyCoverage80", "weekdayBiasMeanAbs"):
        assert type(m[key]) is float and np.isfinite(m[key])
    assert type(m["weeksOver20"]) is int
    inside, with_range = metrics.weekly_band_coverage(log_err, weeks.index, weeks.index + pd.Timedelta(days=6), 28)
    assert m["coverage80"] == {"inside": inside, "weeks": with_range}
    assert all(type(v) is int for v in m["coverage80"].values())
    assert list(m["weekdayBias"]) == ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    assert m["dailyCoverage80"] == pytest.approx(days.actual.between(days.lo, days.hi).mean())
    assert metrics.metrics(days.drop(columns=["lo", "hi"]), weeks, 28, log_err)["dailyCoverage80"] is None

    # Coverage on a subset of weeks draws each week's band from every earlier week in log_err
    late = weeks.iloc[-10:]
    sub = metrics.metrics(days[days.date >= late.index[0]], late, 28, log_err)["coverage80"]
    bands = metrics.weekly_bands(log_err, 28)[-10:]
    own = np.log(late.actual / late.pred)
    assert sub == {"inside": sum(b is not None and b[0] <= e <= b[1] for e, b in zip(own, bands)),
                   "weeks": sum(b is not None for b in bands)}
    assert sub["weeks"] == 10


def test_weekly_totals_sum_monday_to_sunday():
    days = pd.DataFrame({"date": pd.to_datetime(["2025-03-02", "2025-03-03", "2025-03-09", "2025-03-10"]),
                         "actual": [1.0, 2.0, 3.0, 4.0], "mid": [10.0, 20.0, 30.0, 40.0]})
    weeks = metrics.weekly_totals(days)
    assert weeks.index.tolist() == [ts("2025-02-24"), ts("2025-03-03"), ts("2025-03-10")]
    assert weeks.actual.tolist() == [1.0, 5.0, 4.0] and weeks.pred.tolist() == [10.0, 50.0, 40.0]
    assert weeks.days.tolist() == [1, 2, 1]
    assert metrics.weekly_totals(days, value="actual").pred.tolist() == [1.0, 5.0, 4.0]


def test_rolling_skips_an_origin_with_no_later_history(frame, hist, preds, window):
    # A closure running up to the cutoff can leave an origin with nothing to forecast
    out = backtest.rolling_predictions(frame, hist, [ts("2025-09-30")], ts("2025-09-30"), NOTEBOOK_BASE,
                                       NOTEBOOK_EVENT_COLS, holidays=False)
    assert out.empty
    assert list(out.columns) == ["refit", "date", "weekday", "actual", "lo", "mid", "hi", "weekday_median"]
    assert out.dtypes.equals(preds.dtypes)  # the usual column types, so the result can still be picked and scored
    assert backtest.pick(out, 28, *window).empty


@pytest.mark.parametrize("with_holidays", [False, True])
def test_rolling_weekday_regime_waits_for_training_days(frame, hist, origins, with_holidays):
    # An origin before the regime has no training day in it: its later days keep their own weekday's level
    events = features.event_columns(frame, hist.index)
    regime, plain = (backtest.rolling_predictions(frame, hist, origins, DATA_THROUGH, features.base_columns(start),
                                                  events, holidays=with_holidays) for start in (REGIME_START, None))
    before = regime.refit < REGIME_START
    assert before.any() and (regime.date[before] >= REGIME_START).sum() > 100
    pd.testing.assert_frame_equal(regime[before], plain[before])
    assert not np.allclose(regime.mid[~before], plain.mid[~before])  # later origins learn the regime's levels


def test_rolling_recomputes_recent_level_per_origin(monkeypatch, frame, hist, origins):
    seen = {}

    def fake_fit(fr, train, base_cols, event_cols, target="guests"):
        seen[train.date.max()] = fr
        return None

    monkeypatch.setattr(model, "hybrid_fit", fake_fit)
    monkeypatch.setattr(model, "hybrid_predict", lambda fit, rows: {q: rows.guests * 0 + 1.0 for q in model.QUANTILES})
    out = backtest.rolling_predictions(frame, hist, origins, DATA_THROUGH, ["recent_level"], ["weekday"],
                                       holidays=False)
    assert list(out.columns) == ["refit", "date", "weekday", "actual", "lo", "mid", "hi", "weekday_median"]
    assert sorted(out.refit.unique()) == origins
    for origin in origins:
        last_train_day = hist.date[hist.date <= origin].max()
        fr = seen[last_train_day]
        assert fr.recent_level.equals((fr.date >= origin - pd.Timedelta(days=364)).astype(int))


def test_rolling_holidays_multiply_all_three_quantiles(frame, hist):
    # The fixture's backtest weeks hold no big night or Halloween, so mark two plain Thursdays in them as holidays
    plain = hist[(hist.date > ts("2025-03-01")) & (hist.weekday == "Thursday") & (hist.private_event == 0)
                 & (hist[FESTIVAL] == 0) & (hist.federal_holiday == 0)]
    marked = frame.copy()
    marked.loc[plain.index[0], "hol_big_night"] = 1
    marked.loc[plain.index[1], "hol_halloween"] = 1
    h = marked.loc[hist.index]
    origin = ts("2024-12-31")
    without = backtest.rolling_predictions(marked, h, [origin], DATA_THROUGH, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS,
                                           holidays=False)
    with_h = backtest.rolling_predictions(marked, h, [origin], DATA_THROUGH, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS,
                                          holidays=True)

    fr = features.add_recent_level(marked, origin)
    train, rows = fr.loc[h.index[h.date <= origin]], fr.loc[h.index[h.date > origin]]
    lam, _ = holidays.choose_big_night_lambda(fr, train, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS)
    fit = model.hybrid_fit(fr, train, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS)
    effects = holidays.holiday_effects(fr, train, fit, {"hol_big_night": lam, "hol_halloween": holidays.HALLOWEEN_LAMBDA})
    expected = holidays.holiday_multiplier(rows, effects).to_numpy()
    assert (expected != 1.0).sum() == 2
    for column in ("lo", "mid", "hi"):
        assert_allclose(with_h[column].to_numpy(), without[column].to_numpy() * expected, rtol=1e-12)
    pd.testing.assert_frame_equal(with_h.drop(columns=["lo", "mid", "hi"]), without.drop(columns=["lo", "mid", "hi"]))
    assert without.weekday_median.equals(rows.weekday.map(train.groupby("weekday").guests.median()).reset_index(drop=True))
