"""The lab against the notebook's own functions (tests/notebook.py), on the synthetic fixture."""

import numpy as np
import pandas as pd
import pytest
from fixture import DATA_THROUGH, FIRST_DAY, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS, REGIME_START
from notebook import definitions
from numpy.testing import assert_allclose

from townwise_lab import backtest, features, holidays, metrics, model

SPLIT = pd.Timestamp("2025-06-30")


def ts(day: str) -> pd.Timestamp:
    return pd.Timestamp(day)


def test_notebook_loader_raises_when_a_function_is_missing():
    with pytest.raises(LookupError, match="hybrid_fit"):
        definitions(["def design():\n    pass\n"], functions=("design", "hybrid_fit"), constants=())


def test_constants_match_notebook(nb):
    assert model.XGB_PARAMS == nb["XGB_PARAMS"]
    assert features.FLOOR == nb["FLOOR"]["guests"]
    assert holidays.LAMBDAS == tuple(nb["LAMBDAS"])


@pytest.mark.parametrize("columns", ["notebook", "lab", "lab_with_regime"])
def test_hybrid_matches_notebook(nb, frame, hist, columns):
    train, rows = hist[hist.date <= SPLIT], hist[hist.date > SPLIT]
    if columns == "notebook":
        base_cols, event_cols = NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS
        theirs_fit = nb["hybrid_fit"](train, target="guests")  # the notebook's own default inputs
    else:
        base_cols = features.base_columns(REGIME_START if columns == "lab_with_regime" else None)
        event_cols = features.event_columns(frame, train.index)
        theirs_fit = nb["hybrid_fit"](train, target="guests", base_cols=base_cols, event_cols=event_cols)
    ours = model.hybrid_predict(model.hybrid_fit(frame, train, base_cols, event_cols), rows)
    theirs = nb["hybrid_predict"](theirs_fit, rows)
    assert len(rows) > 90
    for q in model.QUANTILES:
        assert_allclose(ours[q], theirs[q], rtol=1e-9)
        assert ours[q].index.equals(rows.index)


def test_holiday_effects_and_lambda_match_notebook(nb, frame, hist):
    assert int(hist.hol_big_night.sum()) == 3  # the leave-one-out runs over three past big nights
    lam, errs = holidays.choose_big_night_lambda(frame, hist, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS)
    nb_lam, nb_errs = nb["choose_big_night_lambda"](hist, "guests")
    assert lam == nb_lam
    assert list(errs) == list(nb_errs) == list(holidays.LAMBDAS)
    assert_allclose([errs[k] for k in errs], [nb_errs[k] for k in errs], rtol=1e-9)

    lams = {"hol_big_night": lam, "hol_halloween": holidays.HALLOWEEN_LAMBDA}
    ours = holidays.holiday_effects(frame, hist, model.hybrid_fit(frame, hist, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS), lams)
    theirs = nb["holiday_effects"](hist, nb["hybrid_fit"](hist, target="guests"), lams, target="guests")
    assert list(ours) == list(theirs) == ["hol_big_night", "hol_halloween"]
    assert_allclose([ours[k] for k in ours], [theirs[k] for k in ours], rtol=1e-9)
    assert all(v > 0 for v in ours.values())  # the fixture's big nights and Halloween run busier
    assert_allclose(holidays.holiday_multiplier(hist, ours), nb["holiday_multiplier"](hist, theirs), rtol=1e-9)


def test_rolling_scores_match_notebook(nb_scores, preds, window):
    for horizon in (7, 28):
        days = backtest.pick(preds, horizon, *window)
        weeks = metrics.weekly_totals(days)
        theirs, their_log_err = nb_scores[horizon]
        assert len(weeks) == len(their_log_err) > 30
        assert_allclose(metrics.daily_wape(days), theirs["daily WAPE"], rtol=1e-12)
        assert_allclose(metrics.weekly_wape(weeks), theirs["weekly WAPE"], rtol=1e-12)
        assert_allclose(metrics.typical_week(weeks), theirs["typical week"], rtol=1e-12)
        assert_allclose(metrics.weeks_over_20(weeks) / len(weeks), theirs["weeks >20% off"], rtol=1e-12)
        assert_allclose(metrics.worst_week(weeks), theirs["worst week"], rtol=1e-12)
        assert_allclose(np.log(weeks.actual / weeks.pred).to_numpy(), their_log_err.to_numpy(), rtol=1e-12)


def test_widening_matches_notebook(nb, preds, window):
    # Section 9e's top-level lines, run on the notebook's own rolling_quantiles and daily_coverage
    qd = nb["rolling_quantiles"]()
    ks = np.round(np.arange(1.0, 3.01, 0.05), 2)
    k_daily = next(k for k in ks if nb["daily_coverage"](qd, k) >= 0.80)
    wk = qd.groupby(qd.date - pd.to_timedelta(qd.date.dt.day_of_week, unit="D"))[["actual", "mid"]].sum()
    w_lo, w_hi = np.quantile(np.log(wk.actual / wk.mid), [0.1, 0.9])

    days = backtest.pick(preds, 28, *window)
    assert metrics.choose_k(days) == k_daily
    assert k_daily > 1.0  # the fixture's ranges as fitted are too narrow, as the notebook's were
    weeks = metrics.weekly_totals(days)
    assert_allclose(np.quantile(np.log(weeks.actual / weeks.pred), [0.1, 0.9]), [w_lo, w_hi], rtol=1e-12)

    ours_by_day, theirs_by_day = days.set_index("date"), qd.set_index("date")
    assert ours_by_day.index.sort_values().equals(theirs_by_day.index.sort_values())
    theirs_by_day = theirs_by_day.loc[ours_by_day.index]
    for column in ("refit", "actual"):
        assert (ours_by_day[column] == theirs_by_day[column]).all()
    for column in ("lo", "mid", "hi"):
        assert_allclose(ours_by_day[column].to_numpy(), theirs_by_day[column].to_numpy(), rtol=1e-12)
    for ours, theirs in zip(metrics.widen(ours_by_day.mid, ours_by_day.lo, ours_by_day.hi, k_daily),
                            nb["widen"](theirs_by_day.mid, theirs_by_day.lo, theirs_by_day.hi, k_daily)):
        assert_allclose(ours.to_numpy(), theirs.to_numpy(), rtol=1e-12)


def test_weekly_band_coverage_matches_section_8_loop(nb_scores, preds, window):
    for horizon in (7, 28):
        log_err = nb_scores[horizon][1]
        # Section 8's loop, verbatim
        ends, starts = log_err.index.end_time.normalize(), log_err.index.start_time
        inside = []
        for i in range(len(log_err)):
            past = log_err[ends <= starts[i] - pd.Timedelta(days=horizon)]
            if len(past) >= 8:
                lo, hi = np.quantile(past, [0.1, 0.9])
                inside.append(lo <= log_err.iloc[i] <= hi)

        weeks = metrics.weekly_totals(backtest.pick(preds, horizon, *window))
        ours = metrics.weekly_band_coverage(np.log(weeks.actual / weeks.pred), weeks.index,
                                            weeks.index + pd.Timedelta(days=6), horizon)
        assert ours == (sum(inside), len(inside))
        assert 0 < sum(inside) < len(inside)


def test_six_month_folds_match_cell_55(nb, frame, hist):
    folds = backtest.six_month_folds(FIRST_DAY, DATA_THROUGH)
    assert folds == [(ts("2024-06-30"), ts("2024-07-01"), ts("2024-12-31")),
                     (ts("2024-12-31"), ts("2025-01-01"), ts("2025-06-30")),
                     (ts("2025-06-30"), ts("2025-07-01"), ts("2025-10-21"))]
    t = "guests"
    for train_end, test_start, test_end in folds:
        # Cell 55's loop body, with section 2's split() inlined
        train, test = hist[hist.date <= train_end], hist[hist.date.between(test_start, test_end)]
        wk = test.assign(pred=nb["hybrid_predict"](nb["hybrid_fit"](train, target=t), test)[0.5]).groupby(
            test.date.dt.to_period("W-SUN"))[[t, "pred"]].sum()
        pct = (wk.pred - wk[t]) / wk[t]

        mid = model.hybrid_predict(model.hybrid_fit(frame, train, NOTEBOOK_BASE, NOTEBOOK_EVENT_COLS), test)[0.5]
        weeks = metrics.weekly_totals(pd.DataFrame({"date": test.date, "actual": test.guests, "mid": mid}))
        assert_allclose(metrics.weekly_wape(weeks), (wk.pred - wk[t]).abs().sum() / wk[t].sum(), rtol=1e-12)
        assert_allclose(metrics.weeks_over_20(weeks) / len(weeks), (pct.abs() > 0.2).mean(), rtol=1e-12)
