"""Phase 3: order-up-to math, deals, space, pars, and a missed cutoff."""

from datetime import date, datetime

from reorder.contracts import DealTier, Product, SupplierSchedule
from reorder.engine import (
    apply_receipt,
    build_recommendation,
    choose_deal,
    corona_worked_example,
    events_needing_an_earlier_order,
    expected_shortfalls,
    extended_window,
    inclusive_days,
    keep_rank,
    order_for_span,
    products_in_play,
    recovery_options,
    shortfall,
    trim_lowest_priority,
    SizedLine,
)
from reorder.forecast_adapter import exposure_windows


def _product(item_id: str, category: str, *, active: bool = True, substitutes: tuple[str, ...] = ()) -> Product:
    return Product(
        item_id=item_id,
        names_by_source={"menu": item_id},
        category=category,
        supplier="SUP_A",
        purchase_unit="case",
        servings_per_unit=24,
        cost_per_unit=20,
        deal_tiers=(DealTier(6, 20),),
        shelf_life_days=180,
        substitutes=substitutes,
        never_run_out=False,
        par_minimum="",
        active=active,
    )


def test_thursday_window_covers_friday_through_sunday() -> None:
    thursday = SupplierSchedule(
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
    windows = exposure_windows([thursday, monday], "P001", date(2026, 11, 5), date(2026, 11, 5))
    start, end = windows[0]
    covered = set(inclusive_days(start, end))
    assert date(2026, 11, 6) in covered  # Friday
    assert date(2026, 11, 7) in covered  # Saturday
    assert date(2026, 11, 8) in covered  # Sunday


def test_deal_rounding_picks_the_cheaper_option() -> None:
    # No penalty for running short, so the smaller deal costs less to hold.
    recommended, other = choose_deal(
        7,
        on_hand=0,
        mu=7,
        level=7,
        deal_step=6,
        unit_price=10,
        holding_rate=1,
        stockout_multiple=0,
    )
    assert recommended == 6
    assert other == 12


def test_storage_cap_trims_the_lowest_priority_first() -> None:
    corona = keep_rank(never_run_out=True, substitutes=(), target=0.98, category="bottles_cans")
    mixer = keep_rank(
        never_run_out=False,
        substitutes=("P002",),
        target=0.88,
        category="cocktail_ingredient",
    )
    assert corona > mixer
    trimmed = trim_lowest_priority(
        [
            SizedLine("P001", 6, corona),
            SizedLine("P301", 6, mixer),
        ],
        free_space=6,
    )
    by_item = {line.item_id: line.quantity for line in trimmed}
    assert by_item["P001"] == 6
    assert by_item["P301"] == 0


def test_missing_inventory_falls_back_to_the_par() -> None:
    recommendation = build_recommendation(
        supplier="SUP_A",
        item_id="P001",
        delivery_weekday="Thursday",
        delivery_date=date(2026, 11, 5),
        cutoff=datetime(2026, 11, 4, 14, 0),
        window_start=date(2026, 11, 4),
        window_end=date(2026, 11, 8),
        covers_through=date(2026, 11, 9),
        forecast_units=40,
        sigma_units=5,
        unit_name="cases",
        on_hand=0,
        target=0.98,
        unit_price=26.5,
        as_of=date(2026, 11, 4),
        par=13,
        last_count=None,
    )
    assert recommendation.confidence == "low"
    assert recommendation.recommended_quantity == 13
    assert "par" in recommendation.why_line.lower()


def test_spec_example_recommends_18_cases() -> None:
    recommendation = corona_worked_example()
    assert recommendation.order_up_to_level == 14 + 2.05 * 3
    assert recommendation.recommended_quantity == 18
    assert recommendation.alternative_deal_quantity == 12
    assert recommendation.why_line == (
        "Thursday covers through Monday. Forecast 14 cases (Homecoming Saturday). "
        "You have about 5. Ordering 18 (three 6-case deals) leaves a 98% chance of not running out."
    )
    tight = corona_worked_example(free_space=12)
    assert tight.recommended_quantity == 12
    assert "shortage" in tight.why_line.lower()


def test_missed_thursday_cutoff_extends_the_window_and_raises_the_order() -> None:
    on_time = exposure_windows(
        [
            SupplierSchedule(
                supplier="SUP_A",
                products=("P001",),
                delivery_weekday="Thu",
                cutoff_weekday="Wed",
                cutoff_time="14:00",
                lead_time="1",
                minimum_order=0,
                how_ordered="rep",
                late_order_policy="moved_to_next_delivery",
            ),
            SupplierSchedule(
                supplier="SUP_A",
                products=("P001",),
                delivery_weekday="Mon",
                cutoff_weekday="Sat",
                cutoff_time="14:00",
                lead_time="2",
                minimum_order=0,
                how_ordered="rep",
                late_order_policy="moved_to_next_delivery",
            ),
        ],
        "P001",
        date(2026, 11, 5),
        date(2026, 11, 5),
    )[0]
    extended = extended_window(date(2026, 11, 5), ["Mon", "Thu"])
    assert len(inclusive_days(*extended)) > len(inclusive_days(*on_time))
    on_time_qty = order_for_span(2, *on_time, sigma=0, target=0.95, on_hand=0)
    extended_qty = order_for_span(2, *extended, sigma=0, target=0.95, on_hand=0)
    assert extended_qty > on_time_qty
    options = recovery_options("moved_to_next_delivery", category="bottles_cans", substitutes=("P006",))
    assert "fee" not in options[0].lower()
    assert any("longer window" in option for option in options)
    assert expected_shortfalls("Corona", 0, 2, extended[0], extended[1])


def test_short_delivery_adds_only_what_arrived() -> None:
    assert apply_receipt(5, received=4) == 9
    assert shortfall(ordered=6, received=4) == 2
    assert apply_receipt(5, received=4) != 5 + 6


def test_bottle_service_off_removes_its_items() -> None:
    corona = _product("P001", "bottles_cans")
    service = _product("P901", "bottle_service", active=False)
    off = products_in_play([corona, service], bottle_service=False)
    on = products_in_play([corona, service], bottle_service=True)
    assert [item.item_id for item in off] == ["P001"]
    assert {item.item_id for item in on} == {"P001", "P901"}


def test_saturday_event_is_flagged_before_the_second_delivery() -> None:
    # Wednesday cutoff. Thursday can cover Saturday. Monday cannot.
    flagged = events_needing_an_earlier_order(
        date(2026, 11, 4),
        ["Mon", "Thu"],
        {date(2026, 11, 7): ("Homecoming",)},
    )
    assert (date(2026, 11, 7), "Homecoming") in flagged
