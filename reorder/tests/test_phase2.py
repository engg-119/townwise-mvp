"""Phase 2 checks: two POS files agree, and uncertainty comes from window errors."""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import pytest

from reorder.business_day import to_business_date
from reorder.catalog import excluded_product_ids, load_orders, load_products, matcher_from_catalog
from reorder.config import load_config
from reorder.contracts import SalesRecord, SupplierSchedule
from reorder.forecast_adapter import (
    build_item_forecasts,
    expected_servings_on,
    exposure_windows,
    guest_index_for,
    load_guest_forecasts,
    sigma_from_window_errors,
)
from reorder.ingestion.activity import attach_square_activity, ingest_comp_log, ingest_void_log
from reorder.ingestion.invoice import ingest_deliveries
from reorder.ingestion.mapping import clean_daily_mapping
from reorder.ingestion.sources import load_source_capabilities
from reorder.ingestion.manual import ingest_phone_notes
from reorder.ingestion.mapping import square_item_sales_mapping, toast_product_mix_mapping
from reorder.ingestion.pos import MappingNotConfirmed, ingest_pos_export, propose_pos_mapping
from reorder.ingestion.spreadsheet import ingest_count_spreadsheet
from reorder.paths import reject_ground_truth
from reorder.quality import sales_quality

ROOT = Path(__file__).resolve().parents[2]
SYNTH = ROOT / "data" / "synthetic"


def _needs_synth() -> None:
    if not SYNTH.is_dir():
        pytest.skip("synthetic data is not in this checkout")


def test_business_day_cutoff_rolls_back_before_4am() -> None:
    assert to_business_date(datetime(2025, 5, 2, 2, 30), 4) == date(2025, 5, 1)
    assert to_business_date(datetime(2025, 5, 2, 5, 0), 4) == date(2025, 5, 2)
    assert to_business_date(date(2025, 5, 2), 4) == date(2025, 5, 2)


def test_unconfirmed_mapping_is_refused() -> None:
    _needs_synth()
    path = SYNTH / "sales" / "toast_style_product_mix_daily.csv"
    vendor, mapping = propose_pos_mapping(path)
    assert vendor == "toast"
    assert mapping.confirmed is False
    with pytest.raises(MappingNotConfirmed):
        ingest_pos_export(
            path,
            mapping,
            matcher_from_catalog([], SYNTH / "reference" / "menu_items.csv", {}),
            source_id="toast",
            vendor="toast",
            cutoff_hour=4,
            time_zone="America/New_York",
        )


def _october_key(row: SalesRecord, *, comps: bool) -> tuple:
    comp = None if not comps else row.comp_qty
    return (
        row.business_date,
        row.item_id,
        round(row.quantity, 2),
        round(row.net_price or 0, 2),
        row.void_qty,
        comp,
    )


def test_square_summary_leaves_voids_unknown_until_the_report_is_joined() -> None:
    _needs_synth()
    matcher = matcher_from_catalog([], SYNTH / "reference" / "menu_items.csv", {})
    catalog = load_source_capabilities(SYNTH / "reference" / "data_sources.csv")
    square = ingest_pos_export(
        SYNTH / "sales" / "square_style_item_sales_2025-10.csv",
        square_item_sales_mapping().confirm(),
        matcher,
        source_id="square",
        vendor="square",
        cutoff_hour=4,
        time_zone="America/New_York",
        source_catalog=catalog,
    )
    assert square.source.capabilities.has_void_qty is False
    assert all(row.void_qty is None and row.comp_qty is None for row in square.sales)
    assert square.quality.unknown_void_rows == len(square.sales)

    filled = attach_square_activity(
        square,
        SYNTH / "sales" / "square_style_comps_voids_2025-10.csv",
        matcher,
        source_id="square-activity",
    )
    assert filled.source.capabilities.has_void_qty is True
    assert all(row.void_qty is not None and row.comp_qty is not None for row in filled.sales)

    toast = ingest_pos_export(
        SYNTH / "sales" / "toast_style_product_mix_daily.csv",
        toast_product_mix_mapping().confirm(),
        matcher,
        source_id="toast",
        vendor="toast",
        cutoff_hour=4,
        time_zone="America/New_York",
        source_catalog=catalog,
    )
    toast_october = [row for row in toast.sales if row.business_date.year == 2025 and row.business_date.month == 10]
    # Toast reports void counts and does not report comps, so comp_qty stays unknown.
    assert toast.source.capabilities.has_comp_qty is False
    assert all(row.comp_qty is None for row in toast_october)
    assert {_october_key(row, comps=False) for row in toast_october} == {
        _october_key(row, comps=False) for row in filled.sales
    }

    clean = ingest_pos_export(
        SYNTH / "sales" / "daily_sales_by_item.csv",
        clean_daily_mapping().confirm(),
        matcher,
        source_id="clean",
        vendor=None,
        cutoff_hour=4,
        time_zone="America/New_York",
        source_catalog=catalog,
    )
    clean_october = {
        (row.business_date, row.item_id): row
        for row in clean.sales
        if row.business_date.year == 2025 and row.business_date.month == 10
    }
    for row in filled.sales:
        reference = clean_october[(row.business_date, row.item_id)]
        assert row.void_qty == reference.void_qty
        assert row.comp_qty == reference.comp_qty


def test_void_and_comp_logs_keep_their_fields() -> None:
    _needs_synth()
    voids = ingest_void_log(
        SYNTH / "sales" / "void_log.csv",
        source_id="void-log",
        cutoff_hour=4,
        time_zone="America/New_York",
    )
    first = voids.void_events[0]
    assert first.event_id == "V-000001"
    assert first.item_id == "M001"
    assert first.marked_as_waste is False
    assert first.employee_id == "BT-02"
    comps = ingest_comp_log(
        SYNTH / "sales" / "comp_log.csv",
        source_id="comp-log",
        cutoff_hour=4,
        time_zone="America/New_York",
    )
    comp = comps.comp_events[0]
    assert comp.event_id == "C-000004"
    assert comp.reason == "Birthday"
    assert comp.product_cost == pytest.approx(0.96)


def test_unmatched_name_goes_to_review() -> None:
    matcher = matcher_from_catalog([], None, {"corona": "P001"})
    review = matcher.review("house cola", "notes")
    assert review.suggested_item_id is None
    assert matcher.match("corona") == "P001"
    assert matcher.match("CORONA") == "P001"


def test_ground_truth_cannot_be_read_as_input() -> None:
    path = SYNTH / "ground_truth" / "true_daily_demand.csv"
    with pytest.raises(ValueError, match="ground_truth"):
        reject_ground_truth(path)
    with pytest.raises(ValueError, match="ground_truth"):
        load_guest_forecasts(path)


def test_spreadsheet_count_and_phone_notes() -> None:
    _needs_synth()
    products = load_products(SYNTH / "reference" / "products.csv")
    config = load_config(ROOT / "config" / "sawtooth.yaml")
    matcher = matcher_from_catalog(products, None, config.item_aliases)
    counts = ingest_count_spreadsheet(
        SYNTH / "operations" / "owner_inventory_spreadsheet.xlsx",
        matcher,
        source_id="owner-sheet",
        cutoff_hour=config.cutoff_hour,
        time_zone=config.time_zone,
    )
    corona = next(
        event
        for event in counts.inventory_events
        if event.item_id == "P001" and event.timestamp.date() == date(2025, 5, 5)
    )
    assert corona.event_type == "count"
    assert corona.quantity_purchase_units == pytest.approx(6.92)

    notes = ingest_phone_notes(
        SYNTH / "operations" / "manager_phone_notes.txt",
        matcher,
        source_id="phone",
        cutoff_hour=4,
        time_zone=config.time_zone,
    )
    first = next(event for event in notes.inventory_events if event.raw_item_name == "corona")
    assert first.timestamp.date() == date(2025, 5, 3)
    assert first.item_id == "P001"
    assert first.quantity_purchase_units == pytest.approx(9.5)
    last = notes.inventory_events[-1]
    assert last.timestamp.date() == date(2026, 11, 4)
    assert notes.review == []


def test_short_delivery_adds_received_quantity() -> None:
    _needs_synth()
    result = ingest_deliveries(
        SYNTH / "operations" / "deliveries_received.csv",
        source_id="invoices",
        cutoff_hour=4,
        time_zone="America/New_York",
    )
    import csv

    short = next(
        row
        for row in csv.DictReader((SYNTH / "operations" / "deliveries_received.csv").open())
        if float(row["short_qty"]) > 0
    )
    match = next(
        event
        for event in result.inventory_events
        if event.item_id == short["product_id"]
        and event.timestamp.date().isoformat() == short["delivery_date"]
        and event.quantity_purchase_units == float(short["qty_received"])
    )
    assert match.quantity_purchase_units == float(short["qty_ordered"]) - float(short["short_qty"])
    orders = load_orders(
        SYNTH / "operations" / "purchase_orders.csv",
        SYNTH / "operations" / "deliveries_received.csv",
    )
    line = next(
        line
        for order in orders
        if order.order_id == short["order_id"]
        for line in order.lines
        if line.item_id == short["product_id"]
    )
    assert line.quantity_received == float(short["qty_received"])


def test_guest_forecast_keeps_guests_and_drops_model_band() -> None:
    config = load_config()
    forecasts = load_guest_forecasts(
        config.resolve("guest_forecast"),
        config.resolve("sales_forecast_events"),
    )
    opening = next(row for row in forecasts if row.date == date(2026, 10, 22))
    assert opening.unit == "guests"
    assert opening.sigma is None
    assert opening.expected_servings == pytest.approx(81.83)
    game = next(row for row in forecasts if row.date == date(2026, 10, 30))
    assert "football_home" in game.event_flags
    halloween = next(row for row in forecasts if row.date == date(2026, 10, 31))
    assert "Halloween" in halloween.event_flags
    assert config.bottle_service is False


def test_thursday_window_runs_through_sunday() -> None:
    schedule = SupplierSchedule(
        supplier="SUP_A",
        products=("P001",),
        delivery_weekday="Thu",
        cutoff_weekday="Wed",
        cutoff_time="14:00",
        lead_time="1",
        minimum_order=0,
        how_ordered="rep",
        late_order_policy="moved_to_next_delivery",
    )
    monday = SupplierSchedule(
        supplier="SUP_A",
        products=("P001",),
        delivery_weekday="Mon",
        cutoff_weekday="Sat",
        cutoff_time="14:00",
        lead_time="2",
        minimum_order=0,
        how_ordered="rep",
        late_order_policy="moved_to_next_delivery",
    )
    windows = exposure_windows(
        [schedule, monday], "P001", date(2026, 11, 5), date(2026, 11, 5)
    )
    assert (date(2026, 11, 4), date(2026, 11, 8)) in windows


def test_window_sigma_uses_past_window_errors_not_a_daily_band() -> None:
    assert sigma_from_window_errors([2.0, 6.0]) == pytest.approx(2.828427, rel=1e-4)
    assert sigma_from_window_errors([1.0]) is None
    from datetime import timedelta

    from reorder.forecast_adapter import window_errors

    start = date(2026, 9, 1)
    history = {start + timedelta(days=offset): 10.0 for offset in range(80)}
    schedules = [
        SupplierSchedule(
            supplier="SUP_A",
            products=("P001",),
            delivery_weekday=day,
            cutoff_weekday=cutoff,
            cutoff_time="14:00",
            lead_time="1",
            minimum_order=0,
            how_ordered="rep",
            late_order_policy="moved_to_next_delivery",
        )
        for day, cutoff in (("Mon", "Sat"), ("Thu", "Wed"))
    ]
    windows = exposure_windows(schedules, "P001", date(2026, 10, 1), date(2026, 10, 31))
    errors = window_errors(history, windows, date(2026, 11, 1))
    assert errors
    assert sigma_from_window_errors(errors) == pytest.approx(0.0, abs=1e-9)
    built = build_item_forecasts(
        {"P001": history},
        [date(2026, 11, 5)],
        date(2026, 11, 1),
        schedules=schedules,
    )
    assert built[0].unit == "servings"
    assert built[0].sigma == pytest.approx(0.0, abs=1e-9)


def test_guest_index_scales_item_history_once() -> None:
    history = {
        date(2026, 10, 3): 10.0,  # Saturday
        date(2026, 10, 10): 10.0,
    }
    guests = {
        date(2026, 10, 3): 100.0,
        date(2026, 10, 10): 100.0,
        date(2026, 10, 17): 200.0,
    }
    index = guest_index_for(date(2026, 10, 17), guests)
    expected = expected_servings_on(
        history,
        date(2026, 10, 17),
        date(2026, 10, 16),
        guest_index=index,
        event_names=("Halloween",),
        events_by_date={date(2026, 10, 17): ("Halloween",)},
    )
    assert index == pytest.approx(200 / (400 / 3))
    assert expected == pytest.approx(10.0 * index)
    # Without a guest forecast, a repeated event uses its own past average.
    past_event = expected_servings_on(
        {date(2025, 5, 5): 30.0, date(2025, 5, 6): 10.0},
        date(2026, 5, 5),
        date(2026, 5, 1),
        guest_index=None,
        event_names=("Cinco de Mayo",),
        events_by_date={
            date(2025, 5, 5): ("Cinco de Mayo",),
            date(2026, 5, 5): ("Cinco de Mayo",),
        },
    )
    assert past_event == pytest.approx(30.0)


def test_bottle_service_products_are_excluded_while_the_module_is_off() -> None:
    _needs_synth()
    products = load_products(SYNTH / "reference" / "products.csv")
    assert excluded_product_ids(products, bottle_service=False) == {"P901", "P902"}
    assert excluded_product_ids(products, bottle_service=True) == set()


def test_bottle_service_ids_can_be_left_out() -> None:
    history = {date(2026, 1, 6): 4.0}  # Tuesday
    rows = build_item_forecasts(
        {"P901": history, "P001": history},
        [date(2026, 1, 13)],
        date(2026, 1, 7),
        skip_item_ids={"P901"},
    )
    assert {row.item_id for row in rows} == {"P001"}


def test_duplicate_rows_are_counted() -> None:
    row = SalesRecord(
        source_id="pos",
        business_date=date(2026, 1, 2),
        timestamp=None,
        item_id="M001",
        raw_item_name="Corona Extra",
        quantity=1,
        unit="drink",
        net_price=6,
        void_qty=0,
        comp_qty=0,
        refund=False,
    )
    report = sales_quality([row, row])
    assert report.duplicate_rows == 1
    assert "1 duplicate" in report.summary()
