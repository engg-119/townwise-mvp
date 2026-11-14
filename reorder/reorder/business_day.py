"""A night that runs past midnight counts toward the day it opened."""

from __future__ import annotations

from datetime import date, datetime, timedelta


def to_business_date(moment: datetime | date, cutoff_hour: int) -> date:
    """Dates with no clock time are already business dates.

    A timestamp before ``cutoff_hour`` (default 4) belongs to the previous day.
    """

    if cutoff_hour < 0 or cutoff_hour > 23:
        raise ValueError("business-day cutoff hour must be between 0 and 23")
    if isinstance(moment, datetime):
        if moment.hour < cutoff_hour:
            return moment.date() - timedelta(days=1)
        return moment.date()
    return moment
