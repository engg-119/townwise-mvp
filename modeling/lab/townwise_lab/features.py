"""The day frame's model inputs.

A frame has one row per date (no gaps) with: date, weekday (full name), guests (NaN with no sales row and after the
data cutoff), term ("fall", "winter", "spring", "summer" or "interim"), week_of_term (-1 between terms), one
ev_<group> column per town event group (0 or 1), private_event (0 or 1), closed and booked (booleans), and the
holiday_flags columns. add_recent_level and add_weekday_regime add the two level columns the baseline uses.
"""

import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar

FLOOR = 1  # guests; keeps log ratios finite on near-empty days (the notebook's FLOOR["guests"])
EVENT_PREFIX = "ev_"
REGIME_SUFFIX = " (regime)"
# A weekday's regime level is learned from at least this many training days. A level from one day fits that day
# exactly at every quantile, so days like it get an 80% range of no width. [CONFIRM: 4, as the notebook's v5 rule
# counts a weekday's bias only with at least 4 days]
MIN_REGIME_DAYS = 4
RECENT_DAYS = 364


def halloween_weekend(dates: pd.Series) -> pd.Series:
    """Oct 31, the Friday from Oct 27 to Nov 2, and the Saturday after it: the nights a town goes out for Halloween.

    The notebook flagged Oct 31 alone. Since v11 the lab flags the weekend too, so a Sunday Halloween (2027) still has
    its Friday and Saturday, and the other weekend night is not held to a plain one (2026: Fri Oct 30 ran 1.57 times its
    nearby Fridays, Sat Oct 31 1.58 times its Saturdays).
    """
    friday = dates - pd.to_timedelta((dates.dt.day_of_week == 5).astype(int), unit="D")  # a Saturday's Friday
    md = friday.dt.month * 100 + friday.dt.day
    weekend = dates.dt.day_of_week.isin([4, 5]) & (md.between(1027, 1031) | md.between(1101, 1102))
    return weekend | ((dates.dt.month == 10) & (dates.dt.day == 31))


def holiday_flags(dates: pd.Series) -> pd.DataFrame:
    """The notebook's holiday rules (section 1, used from section 8b): rules, not a table, so they reach future dates.

    hol_big_night: Thanksgiving Eve, Dec 23 and Dec 31. hol_halloween: Halloween weekend (halloween_weekend; the
    notebook's was Oct 31 alone). hol_closed: Thanksgiving, Jan 1, Jul 4, Dec 24 and Dec 25. federal_holiday: any US
    federal holiday (observed dates included).
    """
    first, last = dates.min(), dates.max()
    # One day past the last date, so a frame ending on Thanksgiving Eve still knows Thanksgiving
    federal = USFederalHolidayCalendar().holidays(first, last + pd.Timedelta(days=1), return_name=True)
    thanksgiving = federal[federal == "Thanksgiving Day"].index
    years = range(first.year, last.year + 1)
    big_night = list(thanksgiving - pd.Timedelta(days=1)) + [pd.Timestamp(y, 12, d) for y in years for d in (23, 31)]
    closed = list(thanksgiving) + [pd.Timestamp(y, m, d) for y in years
                                   for m, d in ((1, 1), (7, 4), (12, 24), (12, 25))]
    return pd.DataFrame({
        "hol_big_night": dates.isin(big_night).astype(int),
        "hol_halloween": halloween_weekend(dates).astype(int),
        "hol_closed": dates.isin(closed).astype(int),
        "federal_holiday": dates.isin(federal.index).astype(int),
    }, index=dates.index)


def add_recent_level(frame: pd.DataFrame, through: pd.Timestamp) -> pd.DataFrame:
    """recent_level: 1 on and after `through` - 364 days (every future date included), 0 before.

    The notebook's is_2026 marked its latest calendar year; a rolling year does the same for any cutoff.
    """
    out = frame.copy()
    out["recent_level"] = (out.date >= through - pd.Timedelta(days=RECENT_DAYS)).astype(int)
    return out


def add_weekday_regime(frame: pd.DataFrame, regime_start: pd.Timestamp | None) -> pd.DataFrame:
    """weekday_regime: the weekday, with its own levels from `regime_start` on (the notebook's v5, section 9f)."""
    out = frame.copy()
    if regime_start is None:
        out["weekday_regime"] = out.weekday
    else:
        out["weekday_regime"] = out.weekday + np.where(out.date >= regime_start, REGIME_SUFFIX, "")
    return out


def limit_weekday_regime(frame: pd.DataFrame, train_idx: pd.Index) -> pd.DataFrame:
    """weekday_regime with a regime level only for weekdays that have at least MIN_REGIME_DAYS training days in it;
    every other row, later days included, falls back to its weekday. Without this, a regime the training rows have not
    seen is a column constant in training, which the design drops, so its days get the reference weekday's level."""
    if "weekday_regime" not in frame:
        return frame
    counts = frame.loc[train_idx, "weekday_regime"].value_counts()
    out = frame.copy()
    out["weekday_regime"] = out.weekday_regime.where(out.weekday_regime.isin(counts.index[counts >= MIN_REGIME_DAYS]),
                                                     out.weekday)
    return out


def base_columns(regime_start: pd.Timestamp | None) -> list[str]:
    """The linear baseline's inputs: the notebook's BASE (or BASE_V5 with a regime), with recent_level for is_2026."""
    return ["weekday_regime" if regime_start is not None else "weekday", "recent_level", "term"]


def event_columns(frame: pd.DataFrame, train_idx: pd.Index) -> list[str]:
    """The XGBoost multiplier's inputs, in the notebook's order (section 2d's EVENT_INPUTS, then week_of_term and
    weekday): the event groups seen on a training day, sorted, then private_event if seen, then week_of_term, weekday.
    """
    seen = frame.loc[train_idx]
    groups = sorted(c for c in frame.columns if c.startswith(EVENT_PREFIX) and seen[c].eq(1).any())
    private = ["private_event"] if seen["private_event"].eq(1).any() else []
    return groups + private + ["week_of_term", "weekday"]


def training_rows(frame: pd.DataFrame, through: pd.Timestamp) -> pd.DataFrame:
    """The days a model learns from: on or before `through`, with guests above zero, not closed and not booked."""
    keep = ((frame.date <= through) & frame.guests.gt(0) & ~frame.closed.astype(bool)
            & ~frame.booked.astype(bool))
    return frame[keep]
