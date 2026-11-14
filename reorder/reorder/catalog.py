"""Load the standard reference files into the section 2 contracts.

These files are already in the contract shape. Messy exports go through ingestion.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from reorder.contracts import (
    DealTier,
    LateOrderPolicy,
    Order,
    OrderLine,
    Product,
    RecipeLine,
    SupplierSchedule,
)
from reorder.ingestion.tabular import iter_rows, parse_date, parse_number
from reorder.matching import ItemMatcher
from reorder.paths import reject_ground_truth

_POLICIES: dict[str, LateOrderPolicy] = {
    "moved_to_next_delivery": "moved_to_next_delivery",
    "accepted_with_fee": "accepted_with_fee",
    "refused": "refused",
    "not_applicable": "not_applicable",
}


def load_products(path: Path) -> list[Product]:
    reject_ground_truth(path)
    products: list[Product] = []
    for raw in _dicts(path):
        tiers = tuple(
            DealTier(quantity=float(tier["min_cases"]), price=float(tier["price_per_case"]))
            for tier in json.loads(raw["deal_tiers"] or "[]")
        )
        cost_2026 = raw.get("cost_per_purchase_unit_2026", "").strip()
        cost_2025 = raw.get("cost_per_purchase_unit_2025", "").strip()
        size = raw.get("serving_size_oz", "").strip()
        expected = raw.get("servings_per_unit_expected", "").strip()
        shelf = raw.get("shelf_life_days", "").strip()
        substitutes = tuple(part for part in raw.get("substitutes", "").split("|") if part)
        products.append(
            Product(
                item_id=raw["product_id"],
                names_by_source={"catalog": raw["product_name"]},
                category=raw["category"],
                supplier=raw["supplier_id"],
                purchase_unit=raw["purchase_unit"],
                servings_per_unit=float(raw["servings_per_unit_theoretical"]),
                servings_per_unit_expected=float(expected) if expected else None,
                serving_size_oz=float(size) if size else None,
                cost_per_unit=float(cost_2026 or cost_2025 or "0"),
                deal_tiers=tiers,
                shelf_life_days=int(float(shelf)) if shelf else None,
                substitutes=substitutes,
                never_run_out=raw["never_run_out"].strip().lower() == "true",
                par_minimum=raw.get("par_rule_current", ""),
                active=raw.get("active", "True").strip().lower() == "true",
            )
        )
    return products


def load_recipes(path: Path) -> list[RecipeLine]:
    reject_ground_truth(path)
    return [
        RecipeLine(
            menu_item_id=raw["menu_item_id"],
            product_id=raw["product_id"],
            amount=float(raw["amount"]),
            unit=raw["unit"],
        )
        for raw in _dicts(path)
    ]


def load_supplier_schedules(path: Path) -> list[SupplierSchedule]:
    reject_ground_truth(path)
    schedules: list[SupplierSchedule] = []
    for raw in _dicts(path):
        delivery = raw["delivery_day"].strip()
        pickup = delivery.lower().startswith("none")
        policy = _POLICIES[raw["late_order_policy"].strip()]
        products = tuple(part for part in raw["products"].split("|") if part)
        schedules.append(
            SupplierSchedule(
                supplier=raw["supplier_id"],
                products=products,
                delivery_weekday=None if pickup else delivery[:3],
                cutoff_weekday=(raw.get("order_cutoff_day") or "").strip()[:3] or None,
                cutoff_time=(raw.get("order_cutoff_time") or "").strip() or None,
                lead_time=raw.get("lead_time_days", ""),
                minimum_order=parse_number(raw.get("min_order_cases") or "0"),
                how_ordered=raw.get("how_ordered", ""),
                late_order_policy=policy,
                late_fee=parse_number(raw.get("late_fee") or "0"),
            )
        )
    return schedules


def load_orders(orders_path: Path, deliveries_path: Path | None = None) -> list[Order]:
    """Group purchase-order lines. Received quantities come from the delivery file."""

    reject_ground_truth(orders_path)
    received: dict[tuple[str, str], float] = defaultdict(float)
    arrived: dict[str, list] = defaultdict(list)
    if deliveries_path is not None:
        reject_ground_truth(deliveries_path)
        for raw in _dicts(deliveries_path):
            key = (raw["order_id"], raw["product_id"])
            received[key] += parse_number(raw["qty_received"])
            arrived[raw["order_id"]].append(parse_date(raw["delivery_date"]))
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for raw in _dicts(orders_path):
        grouped[raw["order_id"]].append(raw)
    orders: list[Order] = []
    for order_id, lines in grouped.items():
        first = lines[0]
        placed = datetime.strptime(
            f"{first['placed_date']} {first['placed_time']}", "%Y-%m-%d %H:%M"
        )
        cutoff = None
        if first.get("cutoff_date") and first.get("cutoff_time"):
            cutoff = datetime.strptime(
                f"{first['cutoff_date']} {first['cutoff_time']}", "%Y-%m-%d %H:%M"
            )
        order_lines = tuple(
            OrderLine(
                item_id=line["product_id"],
                quantity=parse_number(line["qty"]),
                quantity_received=received.get((order_id, line["product_id"])),
            )
            for line in lines
        )
        arrival_dates = arrived.get(order_id, [])
        orders.append(
            Order(
                order_id=order_id,
                supplier=first["supplier_id"],
                lines=order_lines,
                placed_at=placed,
                cutoff_at=cutoff,
                met_cutoff=first["met_cutoff"].strip().lower() == "true",
                expected_arrival=parse_date(first["expected_arrival_date"])
                if first.get("expected_arrival_date")
                else None,
                actual_arrival=max(arrival_dates) if arrival_dates else None,
            )
        )
    return orders


def load_events(path: Path) -> dict:
    """Dates of events known in advance. Values are event names."""

    reject_ground_truth(path)
    events: dict = defaultdict(list)
    for raw in _dicts(path):
        if raw.get("known_in_advance", "True").strip().lower() != "true":
            continue
        events[parse_date(raw["date"])].append(raw["event_name"])
    return {day: tuple(names) for day, names in events.items()}


def excluded_product_ids(products: list[Product], bottle_service: bool) -> set[str]:
    """Bottle-service products stay out of forecasts while that module is off."""

    if bottle_service:
        return set()
    return {product.item_id for product in products if product.category == "bottle_service"}


def matcher_from_catalog(
    products: list[Product],
    menu_path: Path | None,
    aliases: dict[str, str],
) -> ItemMatcher:
    """Exact names from the product list and the menu file, plus config aliases."""

    reject_ground_truth(menu_path) if menu_path else None
    matcher = ItemMatcher(aliases)
    for product in products:
        for name in product.names_by_source.values():
            matcher.add(name, product.item_id)
    if menu_path is not None:
        for raw in _dicts(menu_path):
            matcher.add(raw["toast_menu_item"], raw["menu_item_id"])
            matcher.add(raw["square_item_name"], raw["menu_item_id"])
            matcher.add(raw["menu_item_id"], raw["menu_item_id"])
    return matcher


def _dicts(path: Path) -> list[dict[str, str]]:
    rows = iter_rows(path)
    if rows and not isinstance(rows[0], dict):
        raise ValueError(f"{path} is not a CSV with a header")
    return rows  # type: ignore[return-value]
