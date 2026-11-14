"""Phone notes and a handwritten 86 log. Nicknames resolve only through confirmed aliases."""

from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path

from reorder.contracts import DataSource, IngestResult, InventoryEvent, StockoutNote
from reorder.ingestion.tabular import iter_rows, parse_date
from reorder.matching import ItemMatcher
from reorder.paths import reject_ground_truth

_NOTE_LINE = re.compile(
    r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]+)\s+(\d+)\s+-\s+(.+)$"
)
_ITEM = re.compile(r"\s*([^,]+?)\s+(-?\d+(?:\.\d+)?)\s*(?:,|$)")
_MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
_DOW = {"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}


def ingest_phone_notes(
    path: Path,
    matcher: ItemMatcher,
    *,
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
    years: tuple[int, ...] = (2025, 2026, 2027),
) -> IngestResult:
    """Lines like ``Sat May 3 - corona 8.5, bud lt 5.5``.

    The year is the one in ``years`` whose weekday matches and that falls after
    the previous note. Units are purchase units, cases unless the note says otherwise.
    """

    reject_ground_truth(path)
    source = DataSource(
        source_id=source_id,
        source_type="manual",
        vendor=None,
        file_format="txt",
        column_mapping={"layout": "phone_notes"},
        mapping_confirmed=True,
        business_day_cutoff_hour=cutoff_hour,
        time_zone=time_zone,
    )
    events: list[InventoryEvent] = []
    review = []
    previous: date | None = None
    for line in path.read_text().splitlines():
        found = _NOTE_LINE.match(line.strip())
        if found is None:
            continue
        counted_on = _resolve_date(found.group(1), found.group(2), int(found.group(3)), years, previous)
        previous = counted_on
        for name, qty in _ITEM.findall(found.group(4)):
            label = name.strip()
            item_id = matcher.match(label)
            if item_id is None:
                review.append(matcher.review(label, source_id))
            events.append(
                InventoryEvent(
                    item_id=item_id,
                    timestamp=datetime(counted_on.year, counted_on.month, counted_on.day, 18),
                    event_type="count",
                    quantity_purchase_units=float(qty),
                    entered_by="manager",
                    source_id=source_id,
                    raw_item_name=label,
                )
            )
    return IngestResult(source=source, inventory_events=events, review=_unique(review))


def ingest_stockout_log(
    path: Path,
    matcher: ItemMatcher,
    *,
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    """Staff notes that an item was 86'd. These are notes, not counted quantities."""

    reject_ground_truth(path)
    source = DataSource(
        source_id=source_id,
        source_type="manual",
        vendor=None,
        file_format="csv",
        column_mapping={"business_date": "business_date", "item_name": "menu_item"},
        mapping_confirmed=True,
        business_day_cutoff_hour=cutoff_hour,
        time_zone=time_zone,
    )
    notes: list[StockoutNote] = []
    review = []
    for raw in iter_rows(path):
        if not isinstance(raw, dict):
            raise ValueError("the 86 log is read as CSV rows")
        name = raw["menu_item"].strip()
        item_id = matcher.match(name)
        if item_id is None:
            review.append(matcher.review(name, source_id))
        notes.append(
            StockoutNote(
                business_date=parse_date(raw["business_date"]),
                raw_item_name=name,
                item_id=item_id,
                source_id=source_id,
                note=raw.get("note", ""),
            )
        )
    return IngestResult(source=source, stockout_notes=notes, review=_unique(review))


def _resolve_date(
    dow: str,
    month_name: str,
    day: int,
    years: tuple[int, ...],
    previous: date | None,
) -> date:
    month = _MONTHS[month_name.lower()[:3]]
    for year in years:
        candidate = date(year, month, day)
        if candidate.weekday() != _DOW[dow]:
            continue
        if previous is not None and candidate <= previous:
            continue
        return candidate
    raise ValueError(f"no year in {years} matches {dow} {month_name} {day}")


def _unique(items: list) -> list:
    seen: set[str] = set()
    unique = []
    for item in items:
        if item.raw_name in seen:
            continue
        seen.add(item.raw_name)
        unique.append(item)
    return unique
