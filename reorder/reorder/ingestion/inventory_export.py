"""Exports from an inventory or accounting app, plus state-store purchase logs."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from reorder.contracts import DataSource, IngestResult, InventoryEvent, InventoryEventType
from reorder.ingestion.tabular import iter_rows, parse_date, parse_number, parse_timestamp
from reorder.paths import reject_ground_truth

_EVENT_TYPES: dict[str, InventoryEventType] = {
    "count": "count",
    "delivery_received": "delivery_received",
    "adjustment": "adjustment",
}


def ingest_inventory_export(
    path: Path,
    *,
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    """Read either an inventory-event log or a count export. The header decides which."""

    reject_ground_truth(path)
    rows = iter_rows(path)
    if not rows or not isinstance(rows[0], dict):
        raise ValueError("inventory exports are read as CSV rows")
    headers = set(rows[0])
    if "event_type" in headers:
        return _events(path, rows, source_id, cutoff_hour, time_zone)
    if "counted_qty" in headers:
        return _counts(rows, source_id, cutoff_hour, time_zone)
    if "bottles" in headers:
        return _store_runs(rows, source_id, cutoff_hour, time_zone)
    raise ValueError(f"unrecognized inventory export columns: {sorted(headers)}")


def _events(
    path: Path,
    rows: list[dict[str, str]],
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    source = _source(source_id, "inventory_events", cutoff_hour, time_zone, path.suffix)
    events: list[InventoryEvent] = []
    for raw in rows:
        kind = _EVENT_TYPES.get(raw["event_type"].strip())
        if kind is None:
            raise ValueError(f"unknown inventory event type {raw['event_type']!r}")
        events.append(
            InventoryEvent(
                item_id=raw["product_id"].strip(),
                timestamp=parse_timestamp(raw["timestamp"]),
                event_type=kind,
                quantity_purchase_units=parse_number(raw["qty_purchase_units"]),
                entered_by=raw.get("entered_by") or None,
                source_id=raw.get("source_id") or source_id,
            )
        )
    return IngestResult(source=source, inventory_events=events)


def _counts(
    rows: list[dict[str, str]],
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    source = _source(source_id, "inventory_counts", cutoff_hour, time_zone, ".csv")
    events: list[InventoryEvent] = []
    for raw in rows:
        counted = parse_date(raw["count_date"])
        events.append(
            InventoryEvent(
                item_id=raw["product_id"].strip(),
                timestamp=datetime(counted.year, counted.month, counted.day, 12),
                event_type="count",
                quantity_purchase_units=parse_number(raw["counted_qty"]),
                entered_by=raw.get("counted_by") or None,
                source_id=source_id,
                raw_item_name=raw.get("product_name"),
            )
        )
    return IngestResult(source=source, inventory_events=events)


def _store_runs(
    rows: list[dict[str, str]],
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    source = _source(source_id, "liquor_store_runs", cutoff_hour, time_zone, ".csv")
    events: list[InventoryEvent] = []
    for raw in rows:
        bought = parse_date(raw["run_date"])
        events.append(
            InventoryEvent(
                item_id=raw["product_id"].strip(),
                timestamp=datetime(bought.year, bought.month, bought.day, 15),
                event_type="delivery_received",
                quantity_purchase_units=parse_number(raw["bottles"]),
                entered_by=raw.get("purchased_by") or None,
                source_id=source_id,
                raw_item_name=raw.get("product_name"),
            )
        )
    return IngestResult(source=source, inventory_events=events)


def _source(
    source_id: str,
    kind: str,
    cutoff_hour: int,
    time_zone: str,
    suffix: str,
) -> DataSource:
    return DataSource(
        source_id=source_id,
        source_type="inventory_app",
        vendor=None,
        file_format=suffix.lstrip("."),
        column_mapping={"layout": kind},
        mapping_confirmed=True,
        business_day_cutoff_hour=cutoff_hour,
        time_zone=time_zone,
    )
