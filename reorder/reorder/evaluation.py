"""Scores that read ground_truth. The reorder engine does not import this module."""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from reorder.contracts import Product, RecipeLine, VoidEvent
from reorder.forecast_adapter import servings_per_drink
from reorder.inventory import CountGap, purchase_units
from reorder.void_review import VoidFlag


@dataclass(frozen=True)
class WasteScore:
    unexplained_purchase_units: float
    truly_poured_unmarked_purchase_units: float
    fraction_of_unexplained_matched_by_poured_unmarked_voids: float | None


@dataclass(frozen=True)
class AnomalyScore:
    true_employee: str
    true_start: date
    true_end: date
    found_start: date | None
    found_end: date | None
    false_alarms: tuple[str, ...]


def score_waste_split(
    gaps: list[CountGap],
    voids: list[VoidEvent],
    truth_path: Path,
    recipes: list[RecipeLine],
    products: list[Product],
) -> WasteScore:
    """How much of the unexplained count gap matches voids that were really poured but not marked."""

    unexplained = sum(gap.unexplained for gap in gaps)
    poured_unmarked = _poured_unmarked_units(voids, truth_path, recipes, products)
    fraction = None if unexplained <= 0 else min(1.0, poured_unmarked / unexplained)
    return WasteScore(unexplained, poured_unmarked, fraction)


def score_anomaly(flags: list[VoidFlag], key_path: Path) -> AnomalyScore:
    key = json.loads(key_path.read_text())
    true_start = date.fromisoformat(key["start"])
    true_end = date.fromisoformat(key["end"])
    employee = str(key["employee"])
    matches = [
        flag
        for flag in flags
        if flag.employee_id == employee and flag.end >= true_start and flag.start <= true_end
    ]
    found_start = min((flag.start for flag in matches), default=None)
    found_end = max((flag.end for flag in matches), default=None)
    false_alarms = tuple(
        flag.summary
        for flag in flags
        if not (flag.employee_id == employee and flag.end >= true_start and flag.start <= true_end)
    )
    return AnomalyScore(employee, true_start, true_end, found_start, found_end, false_alarms)


def _poured_unmarked_units(voids, truth_path: Path, recipes, products) -> float:
    truth = {row["event_id"]: row for row in csv.DictReader(truth_path.open())}
    by_id = {product.item_id: product for product in products}
    menu: dict[str, list[RecipeLine]] = {}
    for line in recipes:
        menu.setdefault(line.menu_item_id, []).append(line)
    total = 0.0
    for event in voids:
        row = truth.get(event.event_id)
        if row is None:
            continue
        if row["truly_poured"] != "True" or row["marked_as_waste"] == "True":
            continue
        if event.item_id is None:
            continue
        for line in menu.get(event.item_id, []):
            product = by_id.get(line.product_id)
            if product is None:
                continue
            servings = event.quantity * servings_per_drink(line.amount, line.unit, product.serving_size_oz)
            total += purchase_units(servings, product)
    return total
