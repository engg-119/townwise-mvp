"""Phase 6: replay baseline pars against the agent, without future sales."""

from datetime import date, timedelta

import pytest

from reorder.backtest import (
    WeekdayStats,
    beats_baseline,
    load_sales_servings,
    load_true_demand,
    metrics_table,
    replay,
    run_period,
    stockouts_prevented,
    window_forecast,
)
from reorder.catalog import load_products, load_recipes
from reorder.config import load_config
from reorder.contracts import DealTier, Product, SupplierSchedule
def _beer() -> Product:
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
        par_minimum="order up to 4 cases for Thu delivery; order up to 4 cases for Mon delivery",
    )


def _schedule() -> list[SupplierSchedule]:
    return [
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
    ]


def test_a_sale_after_the_replay_does_not_change_the_order() -> None:
    stats = WeekdayStats()
    stats.add(date(2026, 5, 4), 10)
    stats.add(date(2026, 5, 11), 30)
    assert window_forecast(stats, [date(2026, 5, 18)]) == 20
    start = date(2026, 11, 4)
    end = date(2026, 11, 6)
    sales = {start - timedelta(days=7): 24.0}
    later = dict(sales)
    later[end + timedelta(days=1)] = 10000.0
    common = dict(
        products=[_beer()],
        schedules=_schedule(),
        demand={},
        start=start,
        end=end,
        policy="agent",
        targets={"never_run_out": 0.98},
        loss_rates={},
        opening_units={"P001": 4},
    )
    assert replay(sales={"P001": sales}, **common) == replay(sales={"P001": later}, **common)


def test_a_full_shelf_serves_the_day_and_an_empty_one_stocks_out() -> None:
    product = _beer()
    day = date(2026, 5, 4)
    common = dict(
        products=[product],
        schedules=[],
        sales={},
        start=day,
        end=day,
        policy="baseline",
        targets={"never_run_out": 0.98},
        loss_rates={},
    )
    full = replay(demand={"P001": {day: 24}}, opening_units={"P001": 2}, **common)
    empty = replay(demand={"P001": {day: 24}}, opening_units={"P001": 0}, **common)
    beer = next(row for row in full.by_category if row.category == "bottles_cans")
    assert beer.fill_rate == 1
    assert beer.stockout_item_days == 0
    assert empty.never_run_out_stockout_days == 1
    assert "bottles_cans" in metrics_table(full)


def test_recovery_order_prevents_stockouts_the_late_delivery_would_cause() -> None:
    product = Product(
        item_id="P001",
        names_by_source={"catalog": "Corona Extra"},
        category="bottles_cans",
        supplier="SUP_A",
        purchase_unit="case_24",
        servings_per_unit=24,
        cost_per_unit=26.5,
        deal_tiers=(),
        shelf_life_days=180,
        substitutes=(),
        never_run_out=True,
        par_minimum="order up to 1 cases for Thu delivery; order up to 1 cases for Mon delivery",
    )
    start = date(2026, 11, 2)
    end = date(2026, 11, 25)
    demand: dict[date, float] = {}
    sales: dict[date, float] = {}
    day = start - timedelta(days=28)
    while day <= end:
        if day.weekday() != 6:
            sales[day] = 24
            if day >= start:
                demand[day] = 24
        day += timedelta(days=1)
    common = dict(
        products=[product],
        schedules=_schedule(),
        sales={"P001": sales},
        demand={"P001": demand},
        start=start,
        end=end,
        policy="agent",
        targets={"never_run_out": 0.98, "bottles_cans": 0.95},
        loss_rates={},
        opening_units={"P001": 1},
        miss_thursdays=True,
    )
    late = replay(recover=False, **common)
    recovered = replay(recover=True, **common)
    assert late.late_orders > 0
    assert stockouts_prevented(late, recovered) > 0


def test_agent_beats_a_par_that_is_below_demand() -> None:
    start = date(2026, 5, 4)
    end = date(2026, 5, 20)
    demand = {}
    sales = {}
    # History before the replay, so the agent can see a weekday pattern.
    for back in range(1, 29):
        seen = start - timedelta(days=back)
        if seen.weekday() == 6:
            continue
        sales[seen] = 72
    day = start
    while day <= end:
        if day.weekday() != 6:
            demand[day] = 72
            sales[day] = 72
        day += timedelta(days=1)
    product = _beer()
    common = dict(
        products=[product],
        schedules=_schedule(),
        sales={"P001": sales},
        demand={"P001": demand},
        start=start,
        end=end,
        targets={"never_run_out": 0.98, "bottles_cans": 0.95},
        loss_rates={"bottles_cans": 0.0},
        opening_units={"P001": 4},
    )
    baseline = replay(policy="baseline", weekly_floor={"P001": 4}, **common)
    agent = replay(policy="agent", **common)
    assert agent.never_run_out_stockout_days < baseline.never_run_out_stockout_days
    # The acceptance rule also refuses an agent that ties up more stock.
    assert beats_baseline(agent, baseline) is False
    assert agent.never_run_out_units_on_hand > baseline.never_run_out_units_on_hand


def test_may_replay_reports_each_category_and_leaves_ground_truth_out_of_sales() -> None:
    config = load_config()
    if not config.resolve("synthetic_root").is_dir():
        pytest.skip("synthetic data is not in this checkout")
    root = config.resolve("synthetic_root")
    products = load_products(root / "reference" / "products.csv")
    recipes = load_recipes(root / "reference" / "recipes.csv")
    sales = load_sales_servings(root / "sales" / "daily_sales_by_item.csv", recipes, products)
    assert sales["P001"][date(2025, 5, 1)] > 0
    try:
        load_sales_servings(root / "ground_truth" / "true_daily_demand.csv", recipes, products)
    except ValueError:
        pass
    else:
        raise AssertionError("sales loader accepted ground truth")
    report = run_period(date(2025, 5, 1), date(2025, 5, 31), policy="agent")
    names = {row.category for row in report.by_category}
    assert {"bottles_cans", "draft", "liquor"} <= names
    assert all(row.fill_rate is None or 0 <= row.fill_rate <= 1 for row in report.by_category)
    truth = load_true_demand(root / "ground_truth" / "true_daily_demand.csv", recipes, products)
    assert truth["P001"][date(2025, 5, 1)] >= sales["P001"][date(2025, 5, 1)]
