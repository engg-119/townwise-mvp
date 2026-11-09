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
RECENT_DAYS = 364


def holiday_flags(dates: pd.Series) -> pd.DataFrame:
    """The notebook's holiday rules (section 1, used from section 8b): rules, not a table, so they reach future dates.

    hol_big_night: Thanksgiving Eve, Dec 23 and Dec 31. hol_halloween: Oct 31. hol_closed: Thanksgiving, Jan 1, Jul 4,
    Dec 24 and Dec 25. federal_holiday: any US federal holiday (observed dates included).
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
        "hol_halloween": ((dates.dt.month == 10) & (dates.dt.day == 31)).astype(int),
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
