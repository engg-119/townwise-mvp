"""Owner-only review of void patterns. This does not read evaluation files.

Flags are patterns to review. They are not accusations, and they are not for staff.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from statistics import median

from reorder.contracts import VoidEvent

_WEEKDAY = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
# Last hours before a 1 a.m. close, plus the after-midnight hour on that business date.
_LATE_HOURS = {22, 23, 0}
_INNOCENT = (
    "Friday and Saturday are the busiest nights, so there are more rings to correct.",
    "A new button or a changed menu layout can cause a run of wrong-item voids.",
    "A closing manager may void several tickets at once while checking tabs.",
    "Training shifts cluster mistakes late, when the bar is loud.",
)


@dataclass(frozen=True)
class RateRow:
    slice_name: str
    key: str
    voids: int
    share_of_team: float


@dataclass(frozen=True)
class VoidFlag:
    employee_id: str
    start: date
    end: date
    voids: int
    summary: str
    innocent_explanations: tuple[str, ...]
    audience: str = "owner_only"


@dataclass(frozen=True)
class VoidReview:
    by_employee: tuple[RateRow, ...]
    by_weekday: tuple[RateRow, ...]
    by_hour: tuple[RateRow, ...]
    by_reason: tuple[RateRow, ...]
    flags: tuple[VoidFlag, ...]
    notice: str = "For the owner only. Do not send this to staff."


def review_voids(events: list[VoidEvent]) -> VoidReview:
    total = len(events) or 1
    return VoidReview(
        by_employee=_rates("employee", (event.employee_id or "unknown" for event in events), total),
        by_weekday=_rates("weekday", (_WEEKDAY[event.business_date.weekday()] for event in events), total),
        by_hour=_rates("hour", (f"{_hour(event):02d}" for event in events), total),
        by_reason=_rates("reason", (event.reason or "unspecified" for event in events), total),
        flags=tuple(_late_weekend_flags(events)),
    )


def _rates(slice_name: str, keys, total: int) -> tuple[RateRow, ...]:
    counts: dict[str, int] = defaultdict(int)
    for key in keys:
        counts[key] += 1
    return tuple(
        RateRow(slice_name, key, count, count / total)
        for key, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    )


def _late_weekend_flags(events: list[VoidEvent]) -> list[VoidFlag]:
    """Unusually many late Friday and Saturday voids that were not marked as waste."""

    monthly: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    dates: dict[tuple[str, str], list[date]] = defaultdict(list)
    months: set[str] = set()
    for event in events:
        months.add(event.business_date.strftime("%Y-%m"))
    if not months:
        return []
    span = _month_span(min(months), max(months))
    for event in events:
        if event.marked_as_waste is not False:
            continue
        if event.business_date.weekday() not in {4, 5}:
            continue
        if _hour(event) not in _LATE_HOURS:
            continue
        employee = event.employee_id or "unknown"
        bucket = event.business_date.strftime("%Y-%m")
        monthly[employee][bucket] += 1
        dates[(employee, bucket)].append(event.business_date)

    flags: list[VoidFlag] = []
    for employee, counts in monthly.items():
        series = [counts.get(month, 0) for month in span]
        own_median = median(series) if series else 0
        elevated = []
        for month in span:
            count = counts.get(month, 0)
            team = [monthly[other].get(month, 0) for other in monthly]
            team_median = median(team) if team else 0
            if count >= max(8, 2 * own_median) and count >= max(8, 2 * team_median):
                elevated.append(month)
        for start_month, end_month in _bridged_runs(elevated, counts, own_median, span):
            covered = [month for month in span if start_month <= month <= end_month and counts.get(month, 0)]
            days = [day for month in covered for day in dates[(employee, month)]]
            if not days:
                continue
            total_voids = sum(counts.get(month, 0) for month in covered)
            flags.append(
                VoidFlag(
                    employee_id=employee,
                    start=min(days),
                    end=max(days),
                    voids=total_voids,
                    summary=(
                        f"Pattern to review: {employee} has more voids that were not marked as waste "
                        f"on Friday and Saturday nights, in the last few hours before close, "
                        f"from {min(days).isoformat()} to {max(days).isoformat()} ({total_voids} voids). "
                        "This is a pattern to review, not a conclusion about what happened."
                    ),
                    innocent_explanations=_INNOCENT,
                )
            )
    return flags


def _bridged_runs(elevated: list[str], counts: dict[str, int], own_median: float, span: list[str]) -> list[tuple[str, str]]:
    """Group elevated months, keeping a single quieter month when it is still high for that person."""

    if not elevated:
        return []
    index = {month: position for position, month in enumerate(span)}
    chosen = set(elevated)
    for left, right in zip(elevated, elevated[1:]):
        between = span[index[left] + 1 : index[right]]
        if len(between) == 1 and counts.get(between[0], 0) >= 2 * own_median:
            chosen.add(between[0])
    ordered = [month for month in span if month in chosen]
    runs: list[tuple[str, str]] = []
    run_start = ordered[0]
    previous = ordered[0]
    for month in ordered[1:]:
        if index[month] == index[previous] + 1:
            previous = month
            continue
        runs.append((run_start, previous))
        run_start = previous = month
    runs.append((run_start, previous))
    return runs


def _month_span(start: str, end: str) -> list[str]:
    year, month = (int(part) for part in start.split("-"))
    last_year, last_month = (int(part) for part in end.split("-"))
    months = []
    while (year, month) <= (last_year, last_month):
        months.append(f"{year:04d}-{month:02d}")
        month += 1
        if month == 13:
            month = 1
            year += 1
    return months


def _hour(event: VoidEvent) -> int:
    if event.timestamp is None:
        return -1
    return event.timestamp.hour
