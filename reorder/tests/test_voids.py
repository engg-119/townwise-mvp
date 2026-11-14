"""Voids are not demand. Marked waste is. The answer key is scored only here."""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import pytest

from reorder.catalog import load_products, load_recipes, matcher_from_catalog
from reorder.contracts import InventoryEvent, SalesRecord
from reorder.evaluation import score_anomaly, score_waste_split
from reorder.forecast_adapter import demand_drinks
from reorder.ingestion.activity import ingest_comp_log, ingest_void_log
from reorder.ingestion.inventory_export import ingest_inventory_export
from reorder.ingestion.mapping import clean_daily_mapping
from reorder.ingestion.pos import ingest_pos_export
from reorder.ingestion.sources import load_source_capabilities
from reorder.inventory import gaps_between_counts, reconcile_count
from reorder.owner_report import render_owner_report
from reorder.void_review import review_voids

ROOT = Path(__file__).resolve().parents[2]
SYNTH = ROOT / "data" / "synthetic"


def test_comps_count_as_demand_and_voids_do_not() -> None:
    row = SalesRecord(
        source_id="clean",
        business_date=date(2025, 10, 1),
        timestamp=None,
        item_id="M006",
        raw_item_name="White Claw",
        quantity=10,
        unit="drink",
        net_price=60,
        void_qty=3,
        comp_qty=1,
        refund=False,
    )
    assert demand_drinks(row) == 10


def test_marked_waste_is_subtracted_and_the_gap_is_split() -> None:
    estimated, known, unexplained = reconcile_count(
        previous=10,
        deliveries=5,
        sold=4,
        comps=1,
        marked_waste=1,
        counted=9,
    )
    assert estimated == pytest.approx(10)
    assert known == pytest.approx(2)
    assert unexplained == pytest.approx(1)
    assert estimated - 9 == pytest.approx(unexplained)


def test_review_language_is_not_an_accusation() -> None:
    from reorder.contracts import VoidEvent

    events = []
    for offset in range(10):
        events.append(
            VoidEvent(
                event_id=f"T-{offset}",
                business_date=date(2026, 2, 6 + 7 * (offset % 4)),
                timestamp=datetime(2026, 2, 6, 23, 0),
                check_id=None,
                employee_id="BT-04" if offset else "BT-01",
                item_id="M001",
                raw_item_name="Corona Extra",
                quantity=1,
                void_amount=6,
                reason="Rang in wrong item",
                marked_as_waste=False,
                manager_approved_by=None,
                source_id="test",
            )
        )
    # The tiny fixture is only a wording check when a flag exists. The dataset test covers detection.
    review = review_voids(events)
    assert review.notice.startswith("For the owner only")
    for flag in review.flags:
        assert "Pattern to review" in flag.summary
        assert "not a conclusion" in flag.summary
        assert flag.audience == "owner_only"
        assert flag.innocent_explanations


def test_owner_report_and_answer_key_on_the_synthetic_bar() -> None:
    if not SYNTH.is_dir():
        pytest.skip("synthetic data is not in this checkout")
    catalog = load_source_capabilities(SYNTH / "reference" / "data_sources.csv")
    matcher = matcher_from_catalog([], SYNTH / "reference" / "menu_items.csv", {})
    sales = ingest_pos_export(
        SYNTH / "sales" / "daily_sales_by_item.csv",
        clean_daily_mapping().confirm(),
        matcher,
        source_id="clean",
        vendor=None,
        cutoff_hour=4,
        time_zone="America/New_York",
        source_catalog=catalog,
    ).sales
    products = load_products(SYNTH / "reference" / "products.csv")
    recipes = load_recipes(SYNTH / "reference" / "recipes.csv")
    voids = ingest_void_log(
        SYNTH / "sales" / "void_log.csv", source_id="void-log", cutoff_hour=4, time_zone="America/New_York"
    ).void_events
    comps = ingest_comp_log(
        SYNTH / "sales" / "comp_log.csv", source_id="comp-log", cutoff_hour=4, time_zone="America/New_York"
    ).comp_events
    deliveries = ingest_inventory_export(
        SYNTH / "operations" / "inventory_events.csv",
        source_id="events",
        cutoff_hour=4,
        time_zone="America/New_York",
    ).inventory_events
    counts = [
        event
        for event in _full_counts()
    ]
    gaps = gaps_between_counts(counts, deliveries, sales, voids, comps, recipes, products)
    assert gaps
    review = review_voids(voids)
    html = render_owner_report(gaps, review)
    assert "How it's doing" in html
    assert "For the owner only" in html
    assert "Known waste" in html
    out = ROOT / "reorder" / "reports" / "how_its_doing.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html)

    score = score_anomaly(list(review.flags), SYNTH / "ground_truth" / "void_anomaly_answer_key.json")
    assert score.found_start is not None and score.found_end is not None
    assert score.found_start <= date(2026, 2, 28)
    assert score.found_end >= date(2026, 6, 1)
    waste = score_waste_split(gaps, voids, SYNTH / "ground_truth" / "void_truth.csv", recipes, products)
    assert waste.truly_poured_unmarked_purchase_units > 0
    assert waste.fraction_of_unexplained_matched_by_poured_unmarked_voids is not None


def _full_counts() -> list[InventoryEvent]:
    import csv

    events = []
    with (SYNTH / "operations" / "inventory_counts.csv").open() as handle:
        for raw in csv.DictReader(handle):
            if raw["count_type"] != "owner_full_count":
                continue
            counted = datetime.strptime(raw["count_date"], "%Y-%m-%d").replace(hour=12)
            events.append(
                InventoryEvent(
                    item_id=raw["product_id"],
                    timestamp=counted,
                    event_type="count",
                    quantity_purchase_units=float(raw["counted_qty"]),
                    entered_by=raw["counted_by"],
                    source_id="owner-full-count",
                    raw_item_name=raw["product_name"],
                )
            )
    return events
