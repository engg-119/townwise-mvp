"""POS CSV or Excel export. Toast and Square are confirmed mappings, not separate parsers."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from reorder.business_day import to_business_date
from reorder.contracts import DataSource, IngestResult, SalesRecord, SourceCapabilities
from reorder.ingestion.mapping import ColumnMapping, detect_sales_unit, propose_mapping
from reorder.ingestion.sources import capabilities_for
from reorder.ingestion.tabular import iter_rows, parse_date, parse_number, parse_timestamp, read_headers
from reorder.matching import ItemMatcher
from reorder.paths import reject_ground_truth
from reorder.quality import sales_quality


class MappingNotConfirmed(ValueError):
    """The owner has not confirmed which columns are date, item, and quantity."""


def propose_pos_mapping(path: Path) -> tuple[str | None, ColumnMapping]:
    reject_ground_truth(path)
    return propose_mapping(read_headers(path))


def ingest_pos_export(
    path: Path,
    mapping: ColumnMapping,
    matcher: ItemMatcher,
    *,
    source_id: str,
    vendor: str | None,
    cutoff_hour: int,
    time_zone: str,
    closed_weekdays: tuple[str, ...] = ("Sun",),
    source_catalog: dict[str, SourceCapabilities] | None = None,
) -> IngestResult:
    """Map a POS export into sales records.

    Rows whose names are not in the catalog are kept, with an empty item id,
    and listed for review. Nothing is dropped quietly.
    """

    reject_ground_truth(path)
    if not mapping.confirmed:
        raise MappingNotConfirmed(
            "confirm the column mapping before building sales records"
        )
    table = iter_rows(path)
    if table and isinstance(table[0], dict):
        headers = list(table[0].keys())
        raw_rows = [dict(row) for row in table]  # type: ignore[arg-type]
    else:
        headers = [str(cell) for cell in table[0]]
        raw_rows = [dict(zip(headers, row, strict=False)) for row in table[1:]]

    unit = detect_sales_unit(headers, [])
    capabilities = capabilities_for(path, source_catalog)
    source = DataSource(
        source_id=source_id,
        source_type="pos_export",
        vendor=vendor,
        file_format=path.suffix.lower().lstrip("."),
        column_mapping=mapping.as_dict(),
        mapping_confirmed=True,
        business_day_cutoff_hour=cutoff_hour,
        time_zone=time_zone,
        capabilities=capabilities,
    )
    sales: list[SalesRecord] = []
    review = []
    for raw in raw_rows:
        name = str(raw.get(mapping.item_name, "")).strip()
        if not name:
            continue
        item_id = matcher.match(name)
        if item_id is None:
            review.append(matcher.review(name, source_id))
        moment = _moment(raw, mapping)
        business_date = (
            to_business_date(moment, cutoff_hour)
            if moment is not None
            else to_business_date(parse_date(str(raw[mapping.business_date])), cutoff_hour)
        )
        quantity = parse_number(str(raw.get(mapping.quantity, "") or "0"))
        net = (
            parse_number(str(raw[mapping.net_price]))
            if mapping.net_price and str(raw.get(mapping.net_price, "")).strip()
            else None
        )
        refund_qty = _optional_number(raw, mapping.refunds)
        sales.append(
            SalesRecord(
                source_id=source_id,
                business_date=business_date,
                timestamp=moment,
                item_id=item_id,
                raw_item_name=name,
                quantity=quantity,
                unit=unit,
                net_price=net,
                void_qty=_reported_qty(raw, mapping.voids, capabilities.has_void_qty),
                comp_qty=_reported_qty(raw, mapping.comps, capabilities.has_comp_qty),
                refund=bool(refund_qty and refund_qty != 0) or quantity < 0,
            )
        )
    quality = sales_quality(sales, closed_weekdays)
    if unit in {"dollar", "unknown"}:
        quality.warnings.append(
            f"quantity unit looks like {unit}; confirm whether this file counts drinks, bottles, cases, or dollars"
        )
    unique_review = _unique_review(review)
    return IngestResult(source=source, sales=sales, review=unique_review, quality=quality)


def _moment(raw: dict[str, str], mapping: ColumnMapping) -> datetime | None:
    if mapping.timestamp is None:
        return None
    value = str(raw.get(mapping.timestamp, "")).strip()
    if not value:
        return None
    return parse_timestamp(value)


def _reported_qty(raw: dict[str, str], column: str | None, capable: bool) -> float | None:
    """A source that cannot report the field yields None. Zero is kept when it can."""

    if not capable:
        return None
    if column is None:
        return None
    value = str(raw.get(column, "")).strip()
    if not value:
        return None
    return parse_number(value)


def _optional_number(raw: dict[str, str], column: str | None) -> float | None:
    if column is None:
        return None
    value = str(raw.get(column, "")).strip()
    if not value:
        return None
    return parse_number(value)


def _unique_review(items: list) -> list:
    seen: set[str] = set()
    unique = []
    for item in items:
        if item.raw_name in seen:
            continue
        seen.add(item.raw_name)
        unique.append(item)
    return unique
