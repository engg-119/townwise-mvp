"""Owner inventory spreadsheets. One sheet per count, columns Item, Count, Unit."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from reorder.contracts import DataSource, IngestResult, InventoryEvent
from reorder.ingestion.tabular import xlsx_sheets
from reorder.matching import ItemMatcher
from reorder.paths import reject_ground_truth

_COUNT_DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def ingest_count_spreadsheet(
    path: Path,
    matcher: ItemMatcher,
    *,
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    reject_ground_truth(path)
    source = DataSource(
        source_id=source_id,
        source_type="spreadsheet",
        vendor=None,
        file_format="xlsx",
        column_mapping={"item_name": "Item", "quantity": "Count", "unit": "Unit"},
        mapping_confirmed=True,
        business_day_cutoff_hour=cutoff_hour,
        time_zone=time_zone,
    )
    events: list[InventoryEvent] = []
    review = []
    for sheet_name, rows in xlsx_sheets(path):
        found = _COUNT_DATE.search(sheet_name)
        if found is None or not rows:
            continue
        counted_on = datetime.strptime(found.group(1), "%Y-%m-%d")
        header = [cell.strip().lower() for cell in rows[0]]
        if "item" not in header or "count" not in header:
            continue
        item_at = header.index("item")
        count_at = header.index("count")
        for row in rows[1:]:
            if len(row) <= max(item_at, count_at):
                continue
            name = row[item_at].strip()
            if not name:
                continue
            item_id = matcher.match(name)
            if item_id is None:
                review.append(matcher.review(name, source_id))
            events.append(
                InventoryEvent(
                    item_id=item_id,
                    timestamp=counted_on.replace(hour=12),
                    event_type="count",
                    quantity_purchase_units=float(row[count_at]),
                    entered_by="owner",
                    source_id=source_id,
                    raw_item_name=name,
                )
            )
    seen: set[str] = set()
    unique = []
    for item in review:
        if item.raw_name in seen:
            continue
        seen.add(item.raw_name)
        unique.append(item)
    return IngestResult(source=source, inventory_events=events, review=unique)
