"""The baseline engine (design decision 6, spec 14.6): each open day is its weekday's recent level, times last year's
seasonal shape, times the location's own effects of the town calendar's events and holidays. Pure pandas and numpy,
with nothing to fit, so its backtest refits every week.

- Level: the median guests of the last 8 plain same weekdays on or before the cutoff, needing 3. A plain day is a
  training day (features.training_rows) with no event, holiday or private event, so an effect is never counted twice.
  With fewer than 3, the last 8 training days of that weekday; with none, the median training day.
- Shape: last year's plain same weekdays in the 3 weeks around the date less 364 days (that day and a week either
  side), their median over last year's level (the plain level at the cutoff less 364 days), clamped to 0.5 to 2; 1
  when last year has fewer than 3 such days or no level.
- Effects: per event or holiday group, the median ratio of its past training days to the mean of the plain same
  weekdays up to 4 weeks either side of each (on or before the cutoff). An event group needs 3 days with it and 3
  without, a holiday 1 past occurrence (thresholds as api/src/forecasts/effects.ts). Holidays are the calendar's
  holiday groups and the lab's own big nights and Halloween (features.holiday_flags); events are the input's event
  groups. An event with no group, or a group short of its minimum, has no effect.

Day statuses (closed, booked) come from forecast.statuses, as the model's do. Notes and business rules act only
through the input's flags and the forecast read (14.5), never here. Nothing here logs or prints.
"""

from typing import NamedTuple

import numpy as np
import pandas as pd

from townwise_lab import forecast, metrics
from townwise_lab.features import EVENT_PREFIX, FLOOR, training_rows
from townwise_lab.forecast import MAX_DAY_GUESTS
from townwise_lab.metrics import WEEKDAYS

FAMILY = "seasonal_baseline"
LEVEL_DAYS = 8
LEVEL_MIN_DAYS = 3
SHAPE_LAG_DAYS = 364
SHAPE_OFFSETS = (-7, 0, 7)  # the 3 weeks around the date less 364 days
SHAPE_CLAMP = (0.5, 2.0)
EVENT_MIN_DAYS = 3  # with the event, and without it
HOLIDAY_MIN_DAYS = 1
AROUND_WEEKS = 4  # an event or holiday day is held to the same weekday this many weeks either side
LAB_HOLIDAYS = ("hol_big_night", "hol_halloween")  # the lab's own holiday flags the calendar has no group for
ONE_OFF = EVENT_PREFIX + "one_off"
# The backtest's first weekly cutoff is the first Sunday at least 28 days after the first day, so every weekday has at
# least 4 days before it (the level needs 3). Its scored weeks start on the first Monday at least 28 days after that
# cutoff (29 days, cutoffs being Sundays), and the 12th week with an 80% range is the 24th scored, ending 167 days after
# the first: 28 + 6 + 29 + 167. Pinned by test_baseline_min_history_days_always_gives_twelve_weeks_with_a_range.
FIRST_CUTOFF_DAYS = 28
MIN_HISTORY_DAYS = 230


class History(NamedTuple):
    """A frame's facts the engine reads, prepared once (prepare)."""
    dates: pd.Series  # frame.date
    guests: dict[pd.Timestamp, float]  # training days
    plain: dict[pd.Timestamp, float]  # plain training days
    plain_by_weekday: dict[str, tuple[np.ndarray, np.ndarray]]  # sorted dates and their guests
    train_by_weekday: dict[str, tuple[np.ndarray, np.ndarray]]
    train_all: tuple[np.ndarray, np.ndarray]
    kinds: dict[str, str]  # group: "event" or "holiday"
    members: dict[str, list[pd.Timestamp]]  # group: the dates it covers, ascending
    on_day: dict[int, list[str]]  # frame row: the groups covering it
    first_day: pd.Timestamp  # the first training day


def _sorted(dates: pd.Series, guests: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(dates.to_numpy())
    return dates.to_numpy()[order], guests.to_numpy(dtype=float)[order]


def prepare(frame: pd.DataFrame, calendar: list[dict], through: pd.Timestamp) -> History:
    """The engine's view of `frame` (pipeline.frame_of) with the input's `calendar`, history to `through`."""
    train = training_rows(frame, through)
    holiday_dates: dict[str, set[pd.Timestamp]] = {}
    for entry in calendar:
        if entry["kind"] == "holiday" and entry["group"] is not None:
            span = pd.date_range(entry["start"], entry["end"])
            holiday_dates.setdefault(entry["group"], set()).update(span)
    covered = {group: frame.date.isin(list(days)) for group, days in holiday_dates.items()}
    covered |= {flag: frame[flag].eq(1) for flag in LAB_HOLIDAYS}
    kinds = dict.fromkeys(covered, "holiday")
    for column in frame.columns:
        group = column.removeprefix(EVENT_PREFIX)
        if column.startswith(EVENT_PREFIX) and column != ONE_OFF and group not in kinds:
            covered[group], kinds[group] = frame[column].eq(1), "event"

    unusual = pd.Series(False, index=frame.index)
    for mask in covered.values():
        unusual |= mask
    if ONE_OFF in frame:
        unusual |= frame[ONE_OFF].eq(1)
    unusual |= frame.private_event.eq(1)
    plain = train[~unusual[train.index]]

    on_day: dict[int, list[str]] = {}
    for group, mask in covered.items():
        for index in frame.index[mask]:
            on_day.setdefault(index, []).append(group)
    return History(
        dates=frame.date,
        guests=dict(zip(train.date, train.guests.astype(float))),
        plain=dict(zip(plain.date, plain.guests.astype(float))),
        plain_by_weekday={name: _sorted(rows.date, rows.guests) for name, rows in plain.groupby("weekday")},
        train_by_weekday={name: _sorted(rows.date, rows.guests) for name, rows in train.groupby("weekday")},
        train_all=_sorted(train.date, train.guests),
        kinds=kinds,
        members={group: sorted(frame.date[mask]) for group, mask in covered.items()},
        on_day=on_day,
        first_day=train.date.min(),
    )


def _last(arrays: tuple[np.ndarray, np.ndarray], at: pd.Timestamp, count: int | None) -> np.ndarray:
    dates, guests = arrays
    end = int(np.searchsorted(dates, at.to_datetime64(), side="right"))
    return guests[:end] if count is None else guests[max(0, end - count):end]


_NONE = (np.array([], dtype="datetime64[ns]"), np.array([], dtype=float))


def plain_level(history: History, weekday: str, at: pd.Timestamp) -> float | None:
    """The median of the last 8 plain `weekday`s on or before `at`, or None with fewer than 3."""
    last = _last(history.plain_by_weekday.get(weekday, _NONE), at, LEVEL_DAYS)
    return float(np.median(last)) if len(last) >= LEVEL_MIN_DAYS else None


def level(history: History, weekday: str, cutoff: pd.Timestamp) -> float:
    """The weekday's level at `cutoff` (the module's rule, with its two fallbacks)."""
    plain = plain_level(history, weekday, cutoff)
    if plain is not None:
        return plain
    last = _last(history.train_by_weekday.get(weekday, _NONE), cutoff, LEVEL_DAYS)
    if len(last):
        return float(np.median(last))
    every = _last(history.train_all, cutoff, None)
    return float(np.median(every)) if len(every) else float(FLOOR)


def shape(history: History, day: pd.Timestamp, cutoff: pd.Timestamp) -> float:
    """Last year's seasonal shape for `day` as seen from `cutoff` (the module's rule)."""
    year_ago = day - pd.Timedelta(days=SHAPE_LAG_DAYS)
    around = [history.plain[when] for k in SHAPE_OFFSETS
              if (when := year_ago + pd.Timedelta(days=k)) <= cutoff and when in history.plain]
    if len(around) < len(SHAPE_OFFSETS):
        return 1.0
    then = plain_level(history, day.day_name(), cutoff - pd.Timedelta(days=SHAPE_LAG_DAYS))
    if then is None or then <= 0:
        return 1.0
    return float(np.clip(np.median(around) / then, *SHAPE_CLAMP))


def effects(history: History, cutoff: pd.Timestamp) -> dict[str, float]:
    """Each group's multiplier at `cutoff`, for the groups that have one (the module's rule)."""
    out = {}
    week = pd.Timedelta(days=7)
    for group, kind in history.kinds.items():
        ratios, without = [], set()
        for day in history.members[group]:
            if day > cutoff:
                break
            if day not in history.guests:
                continue
            near = [when for k in range(1, AROUND_WEEKS + 1) for when in (day - k * week, day + k * week)
                    if when <= cutoff and when in history.plain]
            if not near:
                continue
            ratios.append(history.guests[day] / np.mean([history.plain[when] for when in near]))
            without.update(near)
        enough = (len(ratios) >= HOLIDAY_MIN_DAYS if kind == "holiday"
                  else len(ratios) >= EVENT_MIN_DAYS and len(without) >= EVENT_MIN_DAYS)
        if enough:
            out[group] = float(np.median(ratios))
    return out


def predict(history: History, cutoff: pd.Timestamp, index: pd.Index,
            multipliers: dict[str, float] | None = None) -> pd.DataFrame:
    """mid (at least FLOOR guests) and base (level times shape, before calendar effects) for the frame rows `index`,
    from what was known at `cutoff`. `multipliers` is effects(history, cutoff) when the caller already has it."""
    multipliers = effects(history, cutoff) if multipliers is None else multipliers
    levels = {name: level(history, name, cutoff) for name in WEEKDAYS}
    base, mid = [], []
    for row in index:
        day = history.dates[row]
        value = levels[day.day_name()] * shape(history, day, cutoff)
        effect = float(np.prod([multipliers.get(group, 1.0) for group in history.on_day.get(row, [])]))
        base.append(value)
        mid.append(max(value * effect, FLOOR))
    return pd.DataFrame({"mid": mid, "base": base}, index=index, dtype=float)


def first_cutoff(first_day: pd.Timestamp) -> pd.Timestamp:
    """The first Sunday at least FIRST_CUTOFF_DAYS after `first_day`."""
    earliest = first_day + pd.Timedelta(days=FIRST_CUTOFF_DAYS)
    return earliest + pd.Timedelta(days=(6 - earliest.day_of_week) % 7)


def _weekday_median(history: History, cutoff: pd.Timestamp) -> dict[str, float]:
    """The training days' median guests by weekday on or before `cutoff` (the model backtest's weekday_median)."""
    out = {}
    for name, arrays in history.train_by_weekday.items():
        last = _last(arrays, cutoff, None)
        if len(last):
            out[name] = float(np.median(last))
    return out


def backtest_predictions(history: History, through: pd.Timestamp, horizons: list[int]) -> pd.DataFrame:
    """The baseline's weekly backtest, in backtest.PRED_COLUMNS with lo and hi empty (ranged sets them).

    Every Sunday from first_cutoff on is a cutoff (refit). For each horizon h it forecasts the training days of the one
    Monday-to-Sunday week whose Monday is the first at least h days after it, so backtest.pick(preds, h, ...) picks
    that cutoff for that week: each week is scored from a cutoff at least h days before its Monday, as the model's
    are. Weeks reach through `through`."""
    index_of = {day: index for index, day in history.dates.items()}
    pieces = []
    cutoff = first_cutoff(history.first_day)
    while cutoff + pd.Timedelta(days=min(horizons)) <= through:
        dates = set()
        for horizon in horizons:
            earliest = cutoff + pd.Timedelta(days=horizon)
            monday = earliest + pd.Timedelta(days=(7 - earliest.day_of_week) % 7)
            dates.update(day for day in pd.date_range(monday, periods=7) if day <= through and day in history.guests)
        if dates:
            rows = pd.Index(sorted(index_of[day] for day in dates))
            numbers = predict(history, cutoff, rows)
            days = history.dates[rows]
            median = _weekday_median(history, cutoff)
            pieces.append(pd.DataFrame({
                "refit": cutoff, "date": days, "weekday": days.dt.day_name(),
                "actual": [history.guests[day] for day in days], "lo": np.nan, "mid": numbers.mid, "hi": np.nan,
                "weekday_median": days.dt.day_name().map(median)}))
        cutoff += pd.Timedelta(days=7)
    if not pieces:
        return pd.DataFrame({column: pd.Series(dtype="datetime64[ns]" if column in ("refit", "date") else
                                               (object if column == "weekday" else float))
                             for column in ("refit", "date", "weekday", "actual", "lo", "mid", "hi", "weekday_median")})
    return pd.concat(pieces, ignore_index=True)


def daily_log_range(days: pd.DataFrame) -> dict[str, float]:
    """The 10th and 90th percentiles of scored days' log(actual / mid), holding zero, as the daily range's log bounds."""
    q10, q90 = np.quantile(np.log(days.actual / days.mid), [0.1, 0.9])
    return {"lo": float(min(q10, 0.0)), "hi": float(max(q90, 0.0))}


def ranged(preds: pd.DataFrame, log_range: dict[str, float]) -> pd.DataFrame:
    """The backtest with each day's 80% range from `log_range` around its mid."""
    return preds.assign(lo=preds.mid * np.exp(log_range["lo"]), hi=preds.mid * np.exp(log_range["hi"]))


def _pct(multiplier: float) -> float:
    return float(np.clip(round((multiplier - 1) * 100, 1), -100, 1000))


def run_file(history: History, frame: pd.DataFrame, *, data_through: pd.Timestamp, end: pd.Timestamp, widen_k: float,
             daily_log_range: dict[str, float], weekly_log_range: dict[str, float],
             widening: list[tuple[int, float]], trained_from: pd.Timestamp, made_at: str, code_version: str,
             backtest_block: dict | None) -> dict:
    """The baseline's run file for the days after `data_through` through `end`: open days' mid from predict at
    data_through, their range from `daily_log_range` widened by widen_k times the day's lead ratio, baseline the level
    times the shape. An event reason carries its group's effect as effectPct, and the holiday reason the product of the
    day's holiday groups' (null where none has one)."""
    rows, status = forecast.window(frame, data_through, end)
    open_rows = rows.index[status == "open"]
    multipliers = effects(history, data_through)
    numbers = predict(history, data_through, open_rows, multipliers)
    mid = numbers.mid
    ratio = forecast.lead_ratios(rows.date, data_through, widening)
    lo, hi = metrics.widen(mid, mid * np.exp(daily_log_range["lo"]), mid * np.exp(daily_log_range["hi"]),
                           widen_k * ratio[open_rows])
    table = pd.DataFrame({"low": lo, "mid": mid, "high": hi, "baseline": numbers.base}).clip(lower=0,
                                                                                           upper=MAX_DAY_GUESTS)

    def effect_pct(index: int, reason: dict) -> float | None:
        groups = history.on_day.get(index, [])
        if reason["kind"] == "event":
            ref = reason["ref"]
            return _pct(multipliers[ref]) if ref in multipliers and ref in groups else None
        if reason["kind"] == "holiday":
            events = {c.removeprefix(EVENT_PREFIX) for c in frame.columns
                      if c.startswith(EVENT_PREFIX) and frame.at[index, c] == 1}
            found = [multipliers[g] for g in groups if history.kinds[g] == "holiday" and g not in events
                     and g in multipliers]
            return _pct(float(np.prod(found))) if found else None
        return None

    days, weeks = forecast.assemble(rows, status, table, weekly_log_range, ratio, effect_pct)
    return forecast.run_document(FAMILY, trained_from=trained_from, data_through=data_through, made_at=made_at,
                                 code_version=code_version, backtest_block=backtest_block, days=days, weeks=weeks)
