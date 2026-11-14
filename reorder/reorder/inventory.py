"""Running stock estimate and the waste split at each full count.

The estimate subtracts drinks sold (comps included) and voids marked as waste.
Voids not marked as waste are left out, so they show up when the shelf is counted.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from reorder.contracts import CompEvent, InventoryEvent, Product, RecipeLine, SalesRecord, VoidEvent
from reorder.forecast_adapter import demand_drinks, servings_per_drink


@dataclass(frozen=True)
class CountGap:
    item_id: str
    count_date: date
    previous_count_date: date
    counted: float
    estimated: float
    known_waste: float
    unexplained: float


def purchase_units(servings: float, product: Product) -> float:
    if product.servings_per_unit <= 0:
        return 0.0
    return servings / product.servings_per_unit


def reconcile_count(
    *,
    previous: float,
    deliveries: float,
    sold: float,
    comps: float,
    marked_waste: float,
    counted: float,
) -> tuple[float, float, float]:
    """Return estimated on hand, known waste, and unexplained loss, in purchase units.

    ``sold`` already includes comps. Known waste is comps plus voids marked as
    waste. Unexplained loss is what is still missing after those are named.
    """

    estimated = previous + deliveries - sold - marked_waste
    known_waste = comps + marked_waste
    expected_without_known_waste = previous + deliveries - (sold - comps)
    unexplained = (expected_without_known_waste - counted) - known_waste
    return estimated, known_waste, unexplained


def gaps_between_counts(
    counts: list[InventoryEvent],
    deliveries: list[InventoryEvent],
    sales: list[SalesRecord],
    voids: list[VoidEvent],
    comps: list[CompEvent],
    recipes: list[RecipeLine],
    products: list[Product],
) -> list[CountGap]:
    """Compare each count with the estimate carried forward from the previous one."""
    by_product = {product.item_id: product for product in products}
    recipes_for = _recipes_by_menu(recipes)
    sold = _menu_units_by_product_day(sales, recipes_for, by_product, from_sales=True)
    comp_units = _event_units(comps, recipes_for, by_product)
    waste_units = _event_units(
        [event for event in voids if event.marked_as_waste is True],
        recipes_for,
        by_product,
    )
    received = _deliveries_by_product_day(deliveries)
    anchors: dict[str, list[tuple[date, float]]] = defaultdict(list)
    for event in counts:
        if event.item_id is None or event.event_type != "count":
            continue
        anchors[event.item_id].append((event.timestamp.date(), event.quantity_purchase_units))

    gaps: list[CountGap] = []
    for item_id, points in anchors.items():
        points.sort()
        for (start, previous), (end, counted) in zip(points, points[1:]):
            estimated, known, unexplained = reconcile_count(
                previous=previous,
                deliveries=_between(received.get(item_id, {}), start, end),
                sold=_between(sold.get(item_id, {}), start, end),
                comps=_between(comp_units.get(item_id, {}), start, end),
                marked_waste=_between(waste_units.get(item_id, {}), start, end),
                counted=counted,
            )
            gaps.append(
                CountGap(
                    item_id=item_id,
                    count_date=end,
                    previous_count_date=start,
                    counted=counted,
                    estimated=estimated,
                    known_waste=known,
                    unexplained=unexplained,
                )
            )
    return gaps


def _recipes_by_menu(recipes: list[RecipeLine]) -> dict[str, list[RecipeLine]]:
    grouped: dict[str, list[RecipeLine]] = defaultdict(list)
    for line in recipes:
        grouped[line.menu_item_id].append(line)
    return grouped


def _menu_units_by_product_day(sales, recipes_for, products, *, from_sales: bool) -> dict[str, dict[date, float]]:
    totals: dict[str, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    for row in sales:
        if row.item_id is None:
            continue
        drinks = demand_drinks(row) if from_sales else 0.0
        for line in recipes_for.get(row.item_id, []):
            product = products.get(line.product_id)
            if product is None:
                continue
            servings = drinks * servings_per_drink(line.amount, line.unit, product.serving_size_oz)
            totals[line.product_id][row.business_date] += purchase_units(servings, product)
    return totals


def _event_units(events, recipes_for, products) -> dict[str, dict[date, float]]:
    totals: dict[str, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    for event in events:
        if event.item_id is None:
            continue
        for line in recipes_for.get(event.item_id, []):
            product = products.get(line.product_id)
            if product is None:
                continue
            servings = event.quantity * servings_per_drink(line.amount, line.unit, product.serving_size_oz)
            totals[line.product_id][event.business_date] += purchase_units(servings, product)
    return totals


def _deliveries_by_product_day(events: list[InventoryEvent]) -> dict[str, dict[date, float]]:
    totals: dict[str, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    for event in events:
        if event.item_id is None or event.event_type != "delivery_received":
            continue
        totals[event.item_id][event.timestamp.date()] += event.quantity_purchase_units
    return totals


def _between(by_day: dict[date, float], start: date, end: date) -> float:
    """Activity after the previous count, through the new count date."""

    return sum(qty for day, qty in by_day.items() if start < day <= end)
