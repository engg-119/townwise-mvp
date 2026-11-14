"""Turn the existing guest forecast, plus daily item sales, into the forecast contract.

Uncertainty follows spec section 5b: sigma is the spread of past errors on
delivery-window totals. The guest file's 10th and 90th percentiles are not read
into that number.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date, timedelta
from statistics import stdev

from reorder.contracts import Forecast, Product, RecipeLine, SalesRecord, SupplierSchedule
from reorder.paths import reject_ground_truth

_WEEKDAY = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def load_guest_forecasts(path, events_path=None) -> list[Forecast]:
    """Bar-level v3 guest forecast. ``unit`` stays ``guests`` and ``sigma`` stays empty."""

    reject_ground_truth(path)
    flags = _event_flags(events_path) if events_path is not None else {}
    forecasts: list[Forecast] = []
    with open(path, newline="") as handle:
        for raw in csv.DictReader(handle):
            if raw.get("expected_open", "True") != "True":
                continue
            value = raw.get("guests_forecast", "").strip()
            if not value:
                continue
            day = date.fromisoformat(raw["date"])
            holiday = raw.get("holiday", "").strip()
            labels = list(flags.get(day, ()))
            if holiday and holiday not in labels:
                labels.append(holiday)
            forecasts.append(
                Forecast(
                    item_id="bar",
                    date=day,
                    expected_servings=float(value),
                    unit="guests",
                    sigma=None,
                    event_flags=tuple(labels),
                )
            )
    return forecasts


def servings_per_drink(amount: float, unit: str, serving_size_oz: float | None) -> float:
    """Recipe amount in servings of the purchase product."""

    if unit in {"bottle", "can", "pint", "drink"}:
        return amount
    if unit == "oz":
        size = serving_size_oz if serving_size_oz else amount
        return amount / size
    return amount


def demand_drinks(row: SalesRecord) -> float:
    """Drinks to train on.

    ``quantity`` is qty sold. Comps are included in it, so they stay in demand.
    Voids are not in it, and ``void_qty`` is not added back.
    """

    return row.quantity


def product_servings_by_day(
    sales: list[SalesRecord],
    recipes: list[RecipeLine],
    products: list[Product],
) -> dict[str, dict[date, float]]:
    """Menu-item drinks converted to servings of each purchase product."""

    by_menu: dict[str, list[RecipeLine]] = defaultdict(list)
    for line in recipes:
        by_menu[line.menu_item_id].append(line)
    size = {product.item_id: product.serving_size_oz for product in products}
    totals: dict[str, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    for row in sales:
        if row.item_id is None:
            continue
        for line in by_menu.get(row.item_id, []):
            per_drink = servings_per_drink(line.amount, line.unit, size.get(line.product_id))
            totals[line.product_id][row.business_date] += demand_drinks(row) * per_drink
    return {product_id: dict(days) for product_id, days in totals.items()}


def expected_servings_on(
    history: dict[date, float],
    day: date,
    as_of: date,
    *,
    guest_index: float | None,
    event_names: tuple[str, ...] = (),
    events_by_date: dict[date, tuple[str, ...]] | None = None,
) -> float | None:
    """Point forecast for one product-day, using only sales before ``as_of``.

    When the guest forecast covers ``day``, scale that weekday's past average
    by how busy the guest forecast is versus its own weekday average. That
    already includes events, so the event average is not applied on top.

    Otherwise, use the average of past days with the same event name when one
    exists, and the weekday average when it does not.
    """

    past = {seen: qty for seen, qty in history.items() if seen < as_of}
    if not past:
        return None
    weekday_values = [qty for seen, qty in past.items() if seen.weekday() == day.weekday()]
    weekday_mean = _mean(weekday_values)
    if guest_index is not None and weekday_mean is not None:
        return weekday_mean * guest_index
    if event_names and events_by_date:
        wanted = set(event_names)
        event_values = [
            qty
            for seen, qty in past.items()
            if wanted & set(events_by_date.get(seen, ()))
        ]
        event_mean = _mean(event_values)
        if event_mean is not None:
            return event_mean
    return weekday_mean


def guest_index_for(day: date, guests_by_date: dict[date, float]) -> float | None:
    """This day's guest forecast divided by the average forecast for that weekday."""

    today = guests_by_date.get(day)
    if today is None:
        return None
    peers = [
        value
        for seen, value in guests_by_date.items()
        if seen.weekday() == day.weekday()
    ]
    baseline = _mean(peers)
    if baseline is None or baseline == 0:
        return None
    return today / baseline


def sigma_from_window_errors(errors: list[float]) -> float | None:
    """Sample standard deviation of window-total errors. Needs two windows."""

    if len(errors) < 2:
        return None
    return float(stdev(errors))


def exposure_windows(
    schedules: list[SupplierSchedule],
    product_id: str,
    start: date,
    end: date,
) -> list[tuple[date, date]]:
    """Windows from each cutoff date through the day before the following delivery.

    Built from the supplier schedule. A product bought on owner pickup has no
    distributor window.
    """

    relevant = [
        row
        for row in schedules
        if product_id in row.products and row.delivery_weekday and row.cutoff_weekday
    ]
    if not relevant:
        return []
    delivery_days = sorted({_weekday_index(row.delivery_weekday or "") for row in relevant})
    cutoff_for_delivery = {
        _weekday_index(row.delivery_weekday or ""): _weekday_index(row.cutoff_weekday or "")
        for row in relevant
    }
    windows: list[tuple[date, date]] = []
    day = start
    while day <= end:
        if day.weekday() in delivery_days:
            cutoff_index = cutoff_for_delivery[day.weekday()]
            cutoff = day - timedelta(days=(day.weekday() - cutoff_index) % 7)
            following = _next_delivery(day, delivery_days)
            window_end = following - timedelta(days=1)
            if window_end >= cutoff:
                windows.append((cutoff, window_end))
        day += timedelta(days=1)
    return windows


def window_errors(
    history: dict[date, float],
    windows: list[tuple[date, date]],
    as_of: date,
    guests_by_date: dict[date, float] | None = None,
    events_by_date: dict[date, tuple[str, ...]] | None = None,
) -> list[float]:
    """Actual window servings minus the forecast that cutoff could have made."""

    guests_by_date = guests_by_date or {}
    errors: list[float] = []
    for cutoff, window_end in windows:
        if window_end >= as_of:
            continue
        forecast_total = 0.0
        actual_total = 0.0
        covered = 0
        day = cutoff
        while day <= window_end:
            expected = expected_servings_on(
                history,
                day,
                cutoff,
                guest_index=guest_index_for(day, guests_by_date),
                event_names=events_by_date.get(day, ()) if events_by_date else (),
                events_by_date=events_by_date,
            )
            # A weekday with no history yet is not a forecast of zero.
            if expected is not None:
                forecast_total += expected
                actual_total += history.get(day, 0.0)
                covered += 1
            day += timedelta(days=1)
        if covered:
            errors.append(actual_total - forecast_total)
    return errors


def build_item_forecasts(
    history_by_product: dict[str, dict[date, float]],
    dates: list[date],
    as_of: date,
    *,
    guests_by_date: dict[date, float] | None = None,
    events_by_date: dict[date, tuple[str, ...]] | None = None,
    schedules: list[SupplierSchedule] | None = None,
    skip_item_ids: set[str] | None = None,
) -> list[Forecast]:
    """Daily serving forecasts. ``sigma`` is filled from past window errors when a schedule is passed."""

    guests_by_date = guests_by_date or {}
    skip_item_ids = skip_item_ids or set()
    forecasts: list[Forecast] = []
    for product_id, history in history_by_product.items():
        if product_id in skip_item_ids:
            continue
        sigma = None
        if schedules:
            span_start = min(history) if history else as_of
            windows = exposure_windows(schedules, product_id, span_start, as_of)
            sigma = sigma_from_window_errors(
                window_errors(history, windows, as_of, guests_by_date, events_by_date)
            )
        for day in dates:
            if day < as_of:
                continue
            expected = expected_servings_on(
                history,
                day,
                as_of,
                guest_index=guest_index_for(day, guests_by_date),
                event_names=events_by_date.get(day, ()) if events_by_date else (),
                events_by_date=events_by_date,
            )
            if expected is None:
                continue
            flags = events_by_date.get(day, ()) if events_by_date else ()
            forecasts.append(
                Forecast(
                    item_id=product_id,
                    date=day,
                    expected_servings=expected,
                    unit="servings",
                    sigma=sigma,
                    event_flags=flags,
                )
            )
    return forecasts


def _event_flags(path) -> dict[date, tuple[str, ...]]:
    reject_ground_truth(path)
    flags: dict[date, tuple[str, ...]] = {}
    with open(path, newline="") as handle:
        for raw in csv.DictReader(handle):
            text = raw.get("events", "").strip()
            if not text:
                continue
            flags[date.fromisoformat(raw["date"])] = tuple(
                part.strip() for part in text.split(",") if part.strip()
            )
    return flags


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _weekday_index(name: str) -> int:
    short = name.strip()[:3]
    try:
        return _WEEKDAY.index(short)
    except ValueError as exc:
        raise ValueError(f"unknown weekday {name!r}") from exc


def _next_delivery(delivery: date, delivery_weekdays: list[int]) -> date:
    day = delivery + timedelta(days=1)
    for _ in range(8):
        if day.weekday() in delivery_weekdays:
            return day
        day += timedelta(days=1)
    raise ValueError("no following delivery day")
