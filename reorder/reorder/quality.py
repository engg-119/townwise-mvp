"""Duplicates, missing days, and void, comp, and refund counts."""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta

from reorder.contracts import QualityReport, SalesRecord

_WEEKDAY = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def sales_quality(
    rows: list[SalesRecord],
    closed_weekdays: tuple[str, ...] = ("Sun",),
) -> QualityReport:
    keys = [(row.source_id, row.business_date, row.raw_item_name, row.timestamp) for row in rows]
    counts = Counter(keys)
    duplicates = sum(count - 1 for count in counts.values() if count > 1)
    closed = {day[:3] for day in closed_weekdays}
    present = {row.business_date for row in rows}
    missing: list[date] = []
    if present:
        day = min(present)
        last = max(present)
        while day <= last:
            name = _WEEKDAY[day.weekday()]
            if name not in closed and day not in present:
                missing.append(day)
            day += timedelta(days=1)
    unmatched = sorted({row.raw_item_name for row in rows if row.item_id is None})
    return QualityReport(
        duplicate_rows=duplicates,
        missing_business_days=missing,
        void_rows=sum(1 for row in rows if row.void_qty is not None and row.void_qty > 0),
        unknown_void_rows=sum(1 for row in rows if row.void_qty is None),
        comp_rows=sum(1 for row in rows if row.comp_qty is not None and row.comp_qty > 0),
        unknown_comp_rows=sum(1 for row in rows if row.comp_qty is None),
        refund_rows=sum(1 for row in rows if row.refund),
        unmatched_names=unmatched,
    )
