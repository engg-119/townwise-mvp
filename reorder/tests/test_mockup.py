"""Phase 5 screen rules: the schedule gate, reminders, and the order list."""

from datetime import date, datetime

from reorder.contracts import DealTier, Product
from reorder.mockup_logic import (
    build_order,
    edited_reason_needed,
    nav_pages,
    next_cutoff,
    order_text,
    reminder_text,
    rows_from_suppliers,
    schedule_ready,
    text_pdf,
    unit_name,
)


def _row(supplier: str, delivery: str, cutoff_day: str, cutoff_time: str, policy: str) -> dict[str, str]:
    return {
        "supplier_id": supplier,
        "delivery_day": delivery,
        "cutoff_day": cutoff_day,
        "cutoff_time": cutoff_time,
        "late_policy": policy,
    }


def _corona() -> Product:
    return Product(
        item_id="P001",
        names_by_source={"catalog": "Corona Extra"},
        category="bottles_cans",
        supplier="SUP_A",
        purchase_unit="case_24",
        servings_per_unit=24,
        cost_per_unit=26.5,
        deal_tiers=(DealTier(6, 26.5),),
        shelf_life_days=180,
        substitutes=("P002",),
        never_run_out=True,
        par_minimum="order up to 13 cases for Thu delivery",
    )


def _mixer() -> Product:
    return Product(
        item_id="P301",
        names_by_source={"catalog": "Ginger beer"},
        category="cocktail_ingredient",
        supplier="SUP_C",
        purchase_unit="case_24",
        servings_per_unit=24,
        cost_per_unit=22,
        deal_tiers=(),
        shelf_life_days=365,
        substitutes=(),
        never_run_out=False,
        par_minimum="order up to 5 cases for Tue delivery",
    )


def _sawtooth_rows() -> list[dict[str, str]]:
    return [
        _row("SUP_A", "Mon", "Sat", "14:00", "moved_to_next_delivery"),
        _row("SUP_A", "Thu", "Wed", "14:00", "moved_to_next_delivery"),
        _row("SUP_NHLC", "pickup", "", "", "not_applicable"),
    ]


def test_recommendations_wait_for_the_schedule() -> None:
    assert schedule_ready([]) is False
    assert schedule_ready([_row("SUP_A", "", "", "", "moved_to_next_delivery")]) is False
    assert schedule_ready(_sawtooth_rows()) is True
    assert build_order([_corona()], [_row("SUP_A", "Thu", "", "14:00", "moved_to_next_delivery")], as_of=date(2026, 11, 4), targets={"never_run_out": 0.98}) == []


def test_pickup_supplier_does_not_need_a_cutoff() -> None:
    rows = rows_from_suppliers(
        {
            "SUP_A": {
                "late_order_policy": "moved_to_next_delivery",
                "deliveries": [{"day": "Thu", "cutoff_day": "Wed", "cutoff_time": "14:00"}],
            },
            "SUP_NHLC": {"late_order_policy": "not_applicable", "deliveries": []},
        }
    )
    assert schedule_ready(rows) is True
    assert any(row["delivery_day"] == "pickup" for row in rows)


def test_reminder_uses_the_owner_hours() -> None:
    cutoff = datetime(2026, 11, 7, 14, 0)
    assert reminder_text(datetime(2026, 11, 6, 8, 0), cutoff, [24, 2]) is None
    day_before = reminder_text(datetime(2026, 11, 6, 16, 0), cutoff, [24, 2])
    assert day_before is not None and "24-hour" in day_before
    close = reminder_text(datetime(2026, 11, 7, 12, 30), cutoff, [24, 2])
    assert close is not None and "2-hour" in close
    found = next_cutoff(_sawtooth_rows(), datetime(2026, 11, 5, 22, 0))
    assert found is not None
    assert found[0] == datetime(2026, 11, 7, 14, 0)
    assert found[1]["delivery_day"] == "Mon"


def test_next_order_shows_cases_and_the_worked_example() -> None:
    lines = build_order(
        [_corona(), _mixer()],
        _sawtooth_rows(),
        as_of=date(2026, 11, 4),
        targets={"never_run_out": 0.98, "bottles_cans": 0.95, "cocktail_ingredient": 0.88},
        on_hand={"P001": 5},
        last_count=date(2026, 11, 4),
        forecasts={"P001": (14, 3)},
    )
    assert lines[0].item_id == "P001"
    assert lines[0].unit == "cases"
    assert unit_name("keg") == "kegs"
    assert "serving" not in lines[0].why.lower()
    assert lines[0].recommended == 18
    assert "Thursday covers through Monday" in lines[0].why
    assert edited_reason_needed(18, 12) is True
    assert edited_reason_needed(18, 18) is False
    text = order_text(lines, {"P001": 12}, datetime(2026, 11, 4, 13, 0))
    assert "12 cases" in text
    assert text_pdf(text).startswith(b"%PDF")


def test_bottle_service_screen_is_hidden_until_it_is_on() -> None:
    assert "Bottle service" not in nav_pages(False)
    assert "Bottle service" in nav_pages(True)
    hidden = build_order(
        [
            _corona(),
            Product(
                item_id="P901",
                names_by_source={"catalog": "Bottle package"},
                category="bottle_service",
                supplier="SUP_NHLC",
                purchase_unit="package",
                servings_per_unit=1,
                cost_per_unit=60,
                deal_tiers=(),
                shelf_life_days=365,
                substitutes=(),
                never_run_out=False,
                par_minimum="",
                active=False,
            ),
        ],
        _sawtooth_rows(),
        as_of=date(2026, 11, 4),
        targets={"never_run_out": 0.98},
        on_hand={"P001": 5},
        last_count=date(2026, 11, 4),
        forecasts={"P001": (14, 3)},
        bottle_service=False,
    )
    assert all(line.item_id != "P901" for line in hidden)
