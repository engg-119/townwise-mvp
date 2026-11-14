"""Void and comp logs, and the Square report that fills a summary with no void column."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from reorder.contracts import (
    CompEvent,
    DataSource,
    IngestResult,
    SalesRecord,
    SourceCapabilities,
    VoidEvent,
)
from reorder.ingestion.tabular import iter_rows, parse_date, parse_number
from reorder.matching import ItemMatcher
from reorder.paths import reject_ground_truth
from reorder.quality import sales_quality


def ingest_void_log(
    path: Path,
    *,
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    """Read sales/void_log.csv. The business date in the file is kept as written."""

    reject_ground_truth(path)
    events = [
        _void_from_log(raw, source_id)
        for raw in _csv(path)
    ]
    return IngestResult(source=_detail_source(source_id, "void_log", cutoff_hour, time_zone, voids=True), void_events=events)


def ingest_comp_log(
    path: Path,
    *,
    source_id: str,
    cutoff_hour: int,
    time_zone: str,
) -> IngestResult:
    reject_ground_truth(path)
    events = [_comp_from_log(raw, source_id) for raw in _csv(path)]
    return IngestResult(source=_detail_source(source_id, "comp_log", cutoff_hour, time_zone, comps=True), comp_events=events)


def attach_square_activity(
    sales_result: IngestResult,
    report_path: Path,
    matcher: ItemMatcher,
    *,
    source_id: str,
    closed_weekdays: tuple[str, ...] = ("Sun",),
) -> IngestResult:
    """Fill void and comp counts from the Square comps-and-voids report.

    The summary file cannot report those fields, so they start as None. Once this
    report is provided, a day with no matching event is a real zero.
    """

    reject_ground_truth(report_path)
    voids: list[VoidEvent] = []
    comps: list[CompEvent] = []
    review = list(sales_result.review)
    for index, raw in enumerate(_csv(report_path), start=1):
        name = raw["Item"].strip()
        item_id = matcher.match(name)
        if item_id is None:
            review.append(matcher.review(name, source_id))
        kind = raw["Type"].strip().lower()
        if kind == "void":
            voids.append(_void_from_square(raw, source_id, index, item_id))
        elif kind == "comp":
            comps.append(_comp_from_square(raw, source_id, index, item_id))
        else:
            raise ValueError(f"unknown Square activity type {raw['Type']!r}")

    void_totals: dict[tuple, float] = defaultdict(float)
    comp_totals: dict[tuple, float] = defaultdict(float)
    for event in voids:
        void_totals[(event.business_date, event.item_id)] += event.quantity
    for event in comps:
        comp_totals[(event.business_date, event.item_id)] += event.quantity

    filled: list[SalesRecord] = []
    for row in sales_result.sales:
        key = (row.business_date, row.item_id)
        filled.append(
            replace(
                row,
                void_qty=void_totals.get(key, 0.0),
                comp_qty=comp_totals.get(key, 0.0),
            )
        )
    source = replace(
        sales_result.source,
        capabilities=SourceCapabilities(
            has_void_qty=True,
            has_void_reason=True,
            has_comp_qty=True,
            has_employee=True,
        ),
    )
    return IngestResult(
        source=source,
        sales=filled,
        review=_unique(review),
        void_events=voids,
        comp_events=comps,
        quality=sales_quality(filled, closed_weekdays),
    )


def _void_from_log(raw: dict[str, str], source_id: str) -> VoidEvent:
    return VoidEvent(
        event_id=raw["event_id"],
        business_date=parse_date(raw["business_date"]),
        timestamp=_stamp(raw["business_date"], raw.get("time", "")),
        check_id=_blank(raw.get("check_id")),
        employee_id=_blank(raw.get("employee_id")),
        item_id=_blank(raw.get("menu_item_id")),
        raw_item_name=raw.get("menu_item", ""),
        quantity=parse_number(raw["qty"]),
        void_amount=_money(raw.get("void_amount")),
        reason=_blank(raw.get("reason")),
        marked_as_waste=_yes_no(raw.get("marked_as_waste", "")),
        manager_approved_by=_blank(raw.get("manager_approved_by")),
        source_id=source_id,
    )


def _comp_from_log(raw: dict[str, str], source_id: str) -> CompEvent:
    return CompEvent(
        event_id=raw["event_id"],
        business_date=parse_date(raw["business_date"]),
        timestamp=_stamp(raw["business_date"], raw.get("time", "")),
        check_id=_blank(raw.get("check_id")),
        employee_id=_blank(raw.get("employee_id")),
        item_id=_blank(raw.get("menu_item_id")),
        raw_item_name=raw.get("menu_item", ""),
        quantity=parse_number(raw["qty"]),
        comp_amount=_money(raw.get("comp_amount")),
        reason=_blank(raw.get("reason")),
        manager_approved_by=_blank(raw.get("manager_approved_by")),
        product_cost=_money(raw.get("product_cost")),
        source_id=source_id,
    )


def _void_from_square(raw: dict[str, str], source_id: str, index: int, item_id: str | None) -> VoidEvent:
    return VoidEvent(
        event_id=f"SQV-{index:05d}",
        business_date=parse_date(raw["Date"]),
        timestamp=_stamp(raw["Date"], raw.get("Time", "")),
        check_id=None,
        employee_id=_blank(raw.get("Team Member")),
        item_id=item_id,
        raw_item_name=raw["Item"].strip(),
        quantity=parse_number(raw["Qty"]),
        void_amount=_money(raw.get("Amount")),
        reason=_blank(raw.get("Reason")),
        marked_as_waste=_yes_no(raw.get("Waste", "")),
        manager_approved_by=_blank(raw.get("Approved By")),
        source_id=source_id,
    )


def _comp_from_square(raw: dict[str, str], source_id: str, index: int, item_id: str | None) -> CompEvent:
    return CompEvent(
        event_id=f"SQC-{index:05d}",
        business_date=parse_date(raw["Date"]),
        timestamp=_stamp(raw["Date"], raw.get("Time", "")),
        check_id=None,
        employee_id=_blank(raw.get("Team Member")),
        item_id=item_id,
        raw_item_name=raw["Item"].strip(),
        quantity=parse_number(raw["Qty"]),
        comp_amount=_money(raw.get("Amount")),
        reason=_blank(raw.get("Reason")),
        manager_approved_by=_blank(raw.get("Approved By")),
        product_cost=None,
        source_id=source_id,
    )


def _detail_source(source_id: str, layout: str, cutoff_hour: int, time_zone: str, *, voids: bool = False, comps: bool = False) -> DataSource:
    return DataSource(
        source_id=source_id,
        source_type="pos_export",
        vendor=None,
        file_format="csv",
        column_mapping={"layout": layout},
        mapping_confirmed=True,
        business_day_cutoff_hour=cutoff_hour,
        time_zone=time_zone,
        capabilities=SourceCapabilities(
            has_void_qty=voids,
            has_void_reason=voids,
            has_comp_qty=comps,
            has_employee=True,
        ),
    )


def _csv(path: Path) -> list[dict[str, str]]:
    rows = iter_rows(path)
    if rows and not isinstance(rows[0], dict):
        raise ValueError(f"{path.name} is not a CSV with a header")
    return rows  # type: ignore[return-value]


def _stamp(day: str, clock: str) -> datetime | None:
    clock = clock.strip()
    if not clock:
        return None
    return datetime.strptime(f"{parse_date(day).isoformat()} {clock}", "%Y-%m-%d %H:%M")


def _money(value: str | None) -> float | None:
    if value is None or not str(value).strip():
        return None
    return parse_number(str(value))


def _blank(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _yes_no(value: str) -> bool | None:
    text = value.strip().lower()
    if text in {"yes", "true", "y"}:
        return True
    if text in {"no", "false", "n"}:
        return False
    return None


def _unique(items: list) -> list:
    seen: set[str] = set()
    unique = []
    for item in items:
        if item.raw_name in seen:
            continue
        seen.add(item.raw_name)
        unique.append(item)
    return unique
