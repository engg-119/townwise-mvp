"""The scorecard's error measures (the notebook's sections 8, 8c, 9e and 9f), as unrounded fractions.

`days` frames have date, actual and mid (and lo, hi and weekday where a measure needs them). `weeks` frames come from
weekly_totals: indexed by week start (Monday), with actual, pred and days.
"""

from collections.abc import Callable

import numpy as np
import pandas as pd

KS = np.round(np.arange(1.0, 3.01, 0.05), 2)  # widening factors tried, smallest first (section 9e)
MIN_PAST_WEEKS = 8  # weeks of past errors a weekly band needs (section 8)
KIND_MIN_WEEKS = 26  # weeks a band of the later kind reads, the nearest earlier ones filling in (same_kind)
OVER = 0.2  # a week more than 20% off
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def weekly_totals(days: pd.DataFrame, value: str = "mid") -> pd.DataFrame:
    """Monday-to-Sunday sums of actual and of `value` (as pred), and the number of days summed."""
    week = (days.date - pd.to_timedelta(days.date.dt.day_of_week, unit="D")).rename("week")
    grouped = days.groupby(week)
    weeks = pd.DataFrame({"actual": grouped.actual.sum(), "pred": grouped[value].sum()})
    weeks["days"] = grouped.size()
    return weeks


def _week_pct(weeks: pd.DataFrame) -> pd.Series:
    return (weeks.pred - weeks.actual) / weeks.actual


def weekly_wape(weeks: pd.DataFrame) -> float:
    return float((weeks.pred - weeks.actual).abs().sum() / weeks.actual.sum())


def daily_wape(days: pd.DataFrame) -> float:
    return float((days.mid - days.actual).abs().sum() / days.actual.sum())


def typical_week(weeks: pd.DataFrame) -> float:
    """The median week's absolute percentage error."""
    return float(_week_pct(weeks).abs().median())


def worst_week(weeks: pd.DataFrame) -> float:
    return float(_week_pct(weeks).abs().max())


def weeks_over_20(weeks: pd.DataFrame) -> int:
    return int((_week_pct(weeks).abs() > OVER).sum())


Band = Callable[[np.ndarray], tuple[float, float]]


def quantile_band(past: np.ndarray) -> tuple[float, float]:
    """Section 8's 80% band: the 10th and 90th percentiles of past weekly log errors (np.quantile's interpolation)."""
    lo, hi = np.quantile(past, [0.1, 0.9])
    return float(lo), float(hi)


def same_kind(past_starts: pd.DatetimeIndex, earlier: np.ndarray, forecast_from: pd.Timestamp, horizon: int,
              since: pd.Timestamp | None) -> np.ndarray:
    """Of the past weeks `earlier` selects (a mask over `past_starts`, in time order), the ones a band for a week
    forecast from `forecast_from` reads. `since` is an engine's change of method (the baseline's first cutoff with last
    year's shape to read, baseline.shaped_from): a forecast made on or after it is of the later kind, as are the past
    weeks forecast `horizon` days ahead from on or after it (their Monday at least `horizon` days after `since`). A
    forecast of the later kind reads the earlier weeks of its kind, and while they are fewer than KIND_MIN_WEEKS (half a
    year, so a band has seen a season of the town calendar's busy and quiet weeks), the latest earlier weeks of the
    other kind fill in up to that many. Without `since`, or for a forecast made before it, every week `earlier`
    selects."""
    if since is None or forecast_from < since:
        return earlier
    later = np.asarray(past_starts >= since + pd.Timedelta(days=horizon))
    chosen = earlier & later
    short = KIND_MIN_WEEKS - int(chosen.sum())
    if short > 0:
        chosen = chosen.copy()
        chosen[np.flatnonzero(earlier & ~later)[-short:]] = True
    return chosen


def _bands(past_err: np.ndarray, past_ends: pd.DatetimeIndex, starts: pd.DatetimeIndex, horizon: int,
           min_past: int, rule: Band = quantile_band,
           since: pd.Timestamp | None = None) -> list[tuple[float, float] | None]:
    bands = []
    past_starts = past_ends - pd.Timedelta(days=6)
    for start in starts:
        earlier = np.asarray(past_ends <= start - pd.Timedelta(days=horizon))
        past = past_err[same_kind(past_starts, earlier, start - pd.Timedelta(days=horizon), horizon, since)]
        bands.append(rule(past) if len(past) >= min_past else None)
    return bands


def weekly_band_coverage(log_err: pd.Series, week_starts, week_ends, horizon: int,
                         min_past: int = MIN_PAST_WEEKS) -> tuple[int, int]:
    """Section 8's loop over aligned weeks: each week's 80% band is the 10th to 90th percentile of the log errors of
    weeks that ended at least `horizon` days before it starts (when at least `min_past` did). Returns (weeks inside
    their band, weeks with a band)."""
    err = np.asarray(log_err, dtype=float)
    bands = _bands(err, pd.DatetimeIndex(week_ends), pd.DatetimeIndex(week_starts), horizon, min_past)
    inside = [band[0] <= e <= band[1] for e, band in zip(err, bands) if band is not None]
    return int(sum(inside)), len(inside)


def weekly_bands(log_err: pd.Series, horizon: int, min_past: int = MIN_PAST_WEEKS, *, past: pd.Series | None = None,
                 rule: Band = quantile_band, since: pd.Timestamp | None = None) -> list[tuple[float, float] | None]:
    """For each week of `log_err` (indexed by week start), its past-only band as (lo, hi) log errors, or None. The band
    is drawn by `rule` from the weeks of `past` (weekly log errors indexed by week start; `log_err` itself by default)
    that ended at least `horizon` days before the week starts, of them the ones same_kind picks with `since`; with
    fewer than `min_past`, the week has no band."""
    past = log_err if past is None else past
    return _bands(past.to_numpy(dtype=float), pd.DatetimeIndex(past.index) + pd.Timedelta(days=6),
                  pd.DatetimeIndex(log_err.index), horizon, min_past, rule, since)


def widen(mid: pd.Series, lo: pd.Series, hi: pd.Series, k: float) -> tuple[pd.Series, pd.Series]:
    """Scale the daily range's distance from the median by `k` on the log scale (section 9e)."""
    return mid * np.exp(k * np.log(lo.clip(lower=0.5) / mid)), mid * np.exp(k * np.log(hi / mid))


def choose_k(days: pd.DataFrame, target: float = 0.80) -> float:
    """The smallest k in KS whose widened daily ranges hold at least `target` of days; the largest k if none does."""
    for k in KS:
        lo, hi = widen(days.mid, days.lo, days.hi, k)
        if days.actual.between(lo, hi).mean() >= target:
            return float(k)
    return float(KS[-1])


def weekday_bias(days: pd.DataFrame) -> dict[str, float | None]:
    """Per weekday (Mon to Sun), sum of forecasts over sum of actuals minus 1 (cell 76's rule); None with no day."""
    by_wd = days.groupby("weekday")[["mid", "actual"]].sum()
    bias = {}
    for name in WEEKDAYS:
        has = name in by_wd.index and by_wd.loc[name, "actual"] > 0
        bias[name[:3]] = float(by_wd.loc[name, "mid"] / by_wd.loc[name, "actual"] - 1) if has else None
    return bias


def mean_abs_bias(days: pd.DataFrame, min_days: int = 4) -> float:
    """Mean absolute weekday bias over weekdays with at least `min_days` scored days (section 9f); 0.0 if none."""
    counts = days.groupby("weekday").size()
    bias = weekday_bias(days)
    values = [abs(bias[name[:3]]) for name in WEEKDAYS
              if counts.get(name, 0) >= min_days and bias[name[:3]] is not None]
    return float(np.mean(values)) if values else 0.0


def metrics(days: pd.DataFrame, weeks: pd.DataFrame, horizon: int, log_err: pd.Series,
            rule: Band = quantile_band, since: pd.Timestamp | None = None) -> dict:
    """The Metrics contract for scored `days` and their `weeks`.

    coverage80 counts the weeks of `weeks` inside their past-only band, drawn by `rule` from `log_err` (weekly log
    errors indexed by week start: usually log(actual / pred) of `weeks` itself, or a longer backtest that includes
    earlier weeks), of them the ones same_kind picks for each week with `since`. dailyCoverage80 is the share of days
    inside lo to hi, None when `days` has no range.
    """
    own = np.log(weeks.actual / weeks.pred)
    starts = pd.DatetimeIndex(log_err.index)
    bands = _bands(log_err.to_numpy(dtype=float), starts + pd.Timedelta(days=6), pd.DatetimeIndex(weeks.index), horizon,
                   MIN_PAST_WEEKS, rule, since)
    inside = [band[0] <= e <= band[1] for e, band in zip(own, bands) if band is not None]
    has_range = {"lo", "hi"} <= set(days.columns) and len(days) > 0 and days[["lo", "hi"]].notna().all().all()
    return {
        "weeklyWape": weekly_wape(weeks),
        "dailyWape": daily_wape(days),
        "typicalWeek": typical_week(weeks),
        "weeksOver20": weeks_over_20(weeks),
        "worstWeek": worst_week(weeks),
        "coverage80": {"inside": int(sum(inside)), "weeks": len(inside)},
        "dailyCoverage80": float(days.actual.between(days.lo, days.hi).mean()) if has_range else None,
        "weekdayBias": weekday_bias(days),
        "weekdayBiasMeanAbs": mean_abs_bias(days),
    }
