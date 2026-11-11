"""Supplier invoices and delivery receipts. Stock increases by what arrived, not what was ordered."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from reorder.contracts import DataSource, IngestResult, InventoryEvent
from reorder.ingestion.tabular import iter_rows, parse_date, parse_number
from reorder.paths import reject_ground_truth


def ingest_deliveries(
    path: Path,
    *,
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    reject_ground_truth(path)
    source = DataSource(
        source_id=source_id,
        source_type="invoice",
        vendor=None,
        file_format="csv",
        column_mapping={
            "item_id": "product_id",
            "quantity": "qty_received",
            "business_date": "delivery_date",
        },
        mapping_confirmed=True,
        business_day_cutoff_hour=cutoff_hour,
        time_zone=time_zone,
    )
    events: list[InventoryEvent] = []
    for raw in iter_rows(path):
        if not isinstance(raw, dict):
            raise ValueError("delivery receipts are read as CSV rows")
        arrived = parse_date(raw["delivery_date"])
        events.append(
            InventoryEvent(
                item_id=raw["product_id"].strip(),
                timestamp=datetime(arrived.year, arrived.month, arrived.day, 10, 15),
                event_type="delivery_received",
                quantity_purchase_units=parse_number(raw["qty_received"]),
                entered_by=None,
                source_id=source_id,
                raw_item_name=raw.get("product_name"),
            )
        )
    return IngestResult(source=source, inventory_events=events)
