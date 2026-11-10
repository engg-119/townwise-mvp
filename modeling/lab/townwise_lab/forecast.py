"""The forecast window: the 182 days after the data cutoff as a townwise.forecast-run/1 run file
(api/src/forecasts/file.ts), with each day's status, 80% range and reasons, and Monday-to-Sunday weeks."""

import numpy as np
import pandas as pd

from townwise_lab import backtest, metrics, model
from townwise_lab.features import EVENT_PREFIX, FLOOR
from townwise_lab.holidays import holiday_multiplier
from townwise_lab.version import MODEL_VERSION

RUN_SCHEMA = "townwise.forecast-run/1"
HORIZON_DAYS = 182
MAX_DAY_GUESTS = 20_000  # the run file's limits: a day's guests, and at most 6 reasons a day
MAX_REASONS = 6
CLOSED_WEEKDAY_DATES = 8  # a weekday with no guests on any of its last 8 dates (in weeks open otherwise) is closed
HOLIDAY_FLAGS = ("hol_big_night", "hol_halloween", "hol_closed", "federal_holiday")
ONE_OFF = "one_off"  # an event with no calendar group: its reason names none
STATUS_REASON = {"open": "weekday", "closed": "closure", "booked": "booking"}


def iso(day: pd.Timestamp) -> str:
    return day.strftime("%Y-%m-%d")


def _monday(dates: pd.Series) -> pd.Series:
    return dates - pd.to_timedelta(dates.dt.day_of_week, unit="D")


def bounded(lo: pd.Series, mid: pd.Series, hi: pd.Series) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Daily quantile forecasts as a run's days need them: the median at least FLOOR guests (a quantile regression can
    fall to zero or below on a quiet day) and the 10th and 90th percentiles on either side of it (three separate fits
    can cross). Identity on ordinary days."""
    mid = mid.clip(lower=FLOOR)
    return lo.clip(lower=0).clip(upper=mid), mid, hi.clip(lower=mid)


def backtest_predictions(frame: pd.DataFrame, hist: pd.DataFrame, origins: list[pd.Timestamp], end: pd.Timestamp,
                         base_cols: list[str], event_cols: list[str]) -> pd.DataFrame:
    """The lab's rolling backtest: backtest.rolling_predictions with holiday multipliers, its ranges bounded as a run's
    days are, so every weekly ratio is finite."""
    preds = backtest.rolling_predictions(frame, hist, origins, end, base_cols, event_cols, holidays=True)
    lo, mid, hi = bounded(preds.lo, preds.mid, preds.hi)
    return preds.assign(lo=lo, mid=mid, hi=hi)


def closed_weekdays(frame: pd.DataFrame, through: pd.Timestamp) -> set[str]:
    """Weekdays none of whose last 8 dates on or before `through` had guests, counting only dates in weeks with guests
    on another day (a week closed throughout says nothing about one weekday). A weekday with no such date stays open."""
    past = frame[frame.date <= through]
    had = past.guests.gt(0).astype(int)
    counted = (had.groupby(_monday(past.date)).transform("sum") - had) > 0
    recent = had[counted].groupby(past.weekday[counted]).tail(CLOSED_WEEKDAY_DATES)
    return {name for name, values in recent.groupby(past.weekday[recent.index]) if values.sum() == 0}


def _holiday_key(day: pd.Timestamp) -> tuple[int, ...]:
    # Thanksgiving moves, and it is the only closing holiday in November; the others fall on fixed dates
    return (11,) if day.month == 11 else (day.month, day.day)


def closed_holidays(frame: pd.DataFrame, through: pd.Timestamp) -> set[tuple[int, ...]]:
    """The closing holidays (hol_closed) whose most recent occurrence on or before `through` had no guests."""
    past = frame[(frame.date <= through) & frame.hol_closed.eq(1)]
    last = {_holiday_key(day): guests > 0 for day, guests in zip(past.date, past.guests)}  # dates ascend: latest wins
    return {key for key, had in last.items() if not had}


def statuses(frame: pd.DataFrame, through: pd.Timestamp) -> pd.Series:
    """For each row of `frame` after `through`: booked when booked; closed with a closure note, on a closing holiday
    whose last occurrence had no guests, or on a weekday closed_weekdays finds; open otherwise."""
    rows = frame[frame.date > through]
    holidays = closed_holidays(frame, through)
    on_closed_holiday = np.array([flag == 1 and _holiday_key(day) in holidays
                                  for day, flag in zip(rows.date, rows.hol_closed)], dtype=bool)
    closed = rows.closed.astype(bool) | rows.weekday.isin(closed_weekdays(frame, through)) | on_closed_holiday
    return pd.Series(np.select([rows.booked.astype(bool), closed], ["booked", "closed"], "open"), index=rows.index,
                     dtype=object)


def reasons(status: str, term: str, holiday: bool, groups: list[str]) -> list[dict]:
    """In order: the status's own reason, the term (not between terms), a holiday, then one per event group (no ref for
    an event with no group); at most 6. Townwise words each one in code; effects are not estimated per reason."""
    kinds = [(STATUS_REASON[status], None)]
    if term != "interim":
        kinds.append(("term", None))
    if holiday:
        kinds.append(("holiday", None))
    kinds += [("event", None if group == ONE_OFF else group) for group in groups]
    return [{"kind": kind, "ref": ref, "effectPct": None} for kind, ref in kinds[:MAX_REASONS]]


def run_file(frame: pd.DataFrame, fit: model.HybridFit, effects: dict[str, float], widen_k: float,
             weekly_log_range: dict[str, float], *, trained_from: pd.Timestamp, data_through: pd.Timestamp,
             made_at: str, code_version: str, backtest_block: dict) -> dict:
    """The run file for the days of `frame` (the frame `fit` was made on) after `data_through`.

    Open days: the hybrid's quantiles times the holiday multipliers, bounded, the range widened by widen_k (section
    9e); baseline is the linear median baseline alone. Closed and booked days carry no number. Each week is a
    Monday-to-Sunday span of the window: the sum of its open days' forecasts, and the weekly log range around it."""
    status = statuses(frame, data_through)
    rows = frame.loc[status.index]
    open_rows = rows[status == "open"]
    quantiles = model.hybrid_predict(fit, open_rows)
    multiplier = holiday_multiplier(open_rows, effects)
    lo, mid, hi = bounded(quantiles[0.1] * multiplier, quantiles[0.5] * multiplier, quantiles[0.9] * multiplier)
    lo, hi = metrics.widen(mid, lo, hi, widen_k)
    linear, X = fit.base[0.5]
    baseline = pd.Series(linear.predict(X.loc[open_rows.index]), index=open_rows.index)
    numbers = pd.DataFrame({"low": lo, "mid": mid, "high": hi, "baseline": baseline}).clip(lower=0,
                                                                                         upper=MAX_DAY_GUESTS)
    table = rows[["date"]].assign(status=status).join(numbers)

    groups = [c for c in frame.columns if c.startswith(EVENT_PREFIX)]
    holiday = rows[list(HOLIDAY_FLAGS)].eq(1).any(axis=1)
    days = []
    for (index, row), (_, source) in zip(table.iterrows(), rows.iterrows()):
        is_open = row.status == "open"
        days.append({
            "date": iso(row.date), "status": str(row.status),
            **{key: float(row[key]) if is_open else None for key in ("low", "mid", "high", "baseline")},
            "reasons": reasons(row.status, source.term, bool(holiday[index]),
                               [g.removeprefix(EVENT_PREFIX) for g in groups if source[g] == 1]),
        })

    lo_factor, hi_factor = np.exp(weekly_log_range["lo"]), np.exp(weekly_log_range["hi"])
    weeks = []
    for _, week in table.groupby(_monday(table.date)):
        total = float(week.mid.sum())  # open days only: the others have no number
        weeks.append({"from": iso(week.date.min()), "to": iso(week.date.max()),
                      "openDays": int((week.status == "open").sum()), "low": float(total * lo_factor), "mid": total,
                      "high": float(min(total * hi_factor, 7 * MAX_DAY_GUESTS))})

    return {
        "schema": RUN_SCHEMA,
        "metric": "guests",
        "model": {"family": "hybrid_linear_xgboost", "version": MODEL_VERSION, "notebookCommit": code_version},
        "trainingSource": "townwise_lab",
        "trainedFrom": iso(trained_from),
        "dataThrough": iso(data_through),
        "madeAt": made_at,
        "frozen": None,
        "interval": {"level": 0.8, "widened": True},
        "backtest": backtest_block,
        "days": days,
        "weeks": weeks,
    }
