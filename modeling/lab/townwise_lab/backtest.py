"""Rolling-origin backtests (the notebook's sections 8, 8c and 9e) and six-month folds (section 2)."""

import pandas as pd

from townwise_lab import model
from townwise_lab.features import add_recent_level, limit_weekday_regime
from townwise_lab.holidays import HALLOWEEN_LAMBDA, choose_big_night_lambda, holiday_effects, holiday_multiplier

TARGET = "guests"
FIRST_ORIGIN_DAYS = 364  # a year of history before the first refit
REFIT_MONTHS = 3  # the notebook found refits every 3 months as good as every month
LAST_ORIGIN_GAP_DAYS = 7  # the shortest horizon scored: a later origin could forecast no day of the data
HALF_YEAR_MIN_DAYS = 182
PRED_COLUMNS = ["refit", "date", "weekday", "actual", "lo", "mid", "hi", "weekday_median"]


def quarterly_origins(first_day: pd.Timestamp, through: pd.Timestamp) -> list[pd.Timestamp]:
    """The first month-end on or after `first_day` + 364 days, then every third month-end, each at most
    `through` - 7 days (the notebook's last quarterly refit came 21 days before its cutoff)."""
    origin = first_day + pd.Timedelta(days=FIRST_ORIGIN_DAYS) + pd.offsets.MonthEnd(0)
    last = through - pd.Timedelta(days=LAST_ORIGIN_GAP_DAYS)
    origins = []
    while origin <= last:
        origins.append(origin)
        origin += pd.offsets.MonthEnd(REFIT_MONTHS)
    return origins


def score_window(origins: list[pd.Timestamp], through: pd.Timestamp,
                 horizon: int) -> tuple[pd.Timestamp, pd.Timestamp]:
    """From the first Monday at least `horizon` days after the first origin, to the last Sunday on or before `through`
    (the notebook's SCORE_START and SCORE_END)."""
    earliest = origins[0] + pd.Timedelta(days=horizon)
    start = earliest + pd.Timedelta(days=(7 - earliest.day_of_week) % 7)
    end = through - pd.Timedelta(days=(through.day_of_week + 1) % 7)
    return start, end


def pick(preds: pd.DataFrame, horizon: int, score_from: pd.Timestamp, score_to: pd.Timestamp) -> pd.DataFrame:
    """For each date, the prediction of the latest origin on or before that date's Monday minus `horizon` days, so a
    whole week is forecast from one origin; dates outside the score window are dropped (the notebook's rule)."""
    monday = preds.date - pd.to_timedelta(preds.date.dt.day_of_week, unit="D")
    p = preds[preds.refit <= monday - pd.Timedelta(days=horizon)].sort_values("refit").groupby("date").tail(1)
    return p[p.date.between(score_from, score_to)]


def six_month_folds(first_day: pd.Timestamp,
                    through: pd.Timestamp) -> list[tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp]]:
    """(last training day, first test day, last test day) for each half-year (Jan-Jun, Jul-Dec) that starts at least
    182 days after `first_day` and on or before `through`; its test ends at the half-year's end or `through`."""
    folds = []
    for year in range(first_day.year, through.year + 1):
        for start, end in ((pd.Timestamp(year, 1, 1), pd.Timestamp(year, 6, 30)),
                           (pd.Timestamp(year, 7, 1), pd.Timestamp(year, 12, 31))):
            if start - first_day >= pd.Timedelta(days=HALF_YEAR_MIN_DAYS) and start <= through:
                folds.append((start - pd.Timedelta(days=1), start, min(end, through)))
    return folds


def rolling_predictions(frame: pd.DataFrame, hist: pd.DataFrame, origins: list[pd.Timestamp], end: pd.Timestamp,
                        base_cols: list[str], event_cols: list[str], holidays: bool) -> pd.DataFrame:
    """At each origin: refit on the rows of `hist` (training rows of `frame`) up to it, then predict its rows after it
    through `end`. recent_level and weekday_regime (limit_weekday_regime) are recomputed for each origin. With
    `holidays`, the big-night lambda is chosen by leave-one-out on that origin's training rows and the holiday
    multiplier scales all three quantiles; without, this is the notebook's backtest. weekday_median is the training
    rows' median guests by weekday. An origin with no row of `hist` after it is skipped."""
    pieces = []
    for origin in origins:
        fr = limit_weekday_regime(add_recent_level(frame, origin), hist.index[hist.date <= origin])
        h = fr.loc[hist.index]
        train, rows = h[h.date <= origin], h[(h.date > origin) & (h.date <= end)]
        if rows.empty:
            continue
        fit = model.hybrid_fit(fr, train, base_cols, event_cols, target=TARGET)
        q = model.hybrid_predict(fit, rows)
        if holidays:
            lam, _ = choose_big_night_lambda(fr, train, base_cols, event_cols, target=TARGET)
            effects = holiday_effects(fr, train, fit, {"hol_big_night": lam, "hol_halloween": HALLOWEEN_LAMBDA},
                                      target=TARGET)
            multiplier = holiday_multiplier(rows, effects)
            q = {k: v * multiplier for k, v in q.items()}
        pieces.append(pd.DataFrame({
            "refit": origin, "date": rows.date, "weekday": rows.weekday, "actual": rows[TARGET],
            "lo": q[0.1], "mid": q[0.5], "hi": q[0.9],
            "weekday_median": rows.weekday.map(train.groupby("weekday")[TARGET].median())}, columns=PRED_COLUMNS))
    if not pieces:  # no row, but the usual column types, so the result can still be picked and scored
        none = hist.iloc[:0]
        no_value = pd.Series(dtype=float, index=none.index)
        return pd.DataFrame({"refit": none.date, "date": none.date, "weekday": none.weekday, "actual": no_value,
                             "lo": no_value, "mid": no_value, "hi": no_value, "weekday_median": no_value},
                            columns=PRED_COLUMNS).reset_index(drop=True)
    return pd.concat(pieces, ignore_index=True)
