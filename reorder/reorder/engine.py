"""Order-up-to quantities, deal rounding, and late-order recovery.

The owner still approves every order. This module only recommends one.
Sawtooth numbers (targets, loss rates, deal sizes, cooler space) come from
config. The forecast notebook is not used here, and ground truth is not read.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import NormalDist

from reorder.contracts import Product, Recommendation

# Spec section 5b names these two. Other targets use the normal table.
_SPEC_Z = {0.95: 1.65, 0.98: 2.05}
_WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_WORDS = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
]


def z_for_target(target: float) -> float:
    """In-stock target to the z in S = μ + z·σ."""

    named = _SPEC_Z.get(round(target, 2))
    if named is not None:
        return named
    if not 0 < target < 1:
        raise ValueError(f"in-stock target must be between 0 and 1, got {target}")
    return NormalDist().inv_cdf(target)


def servings_to_units(servings: float, servings_per_unit: float, loss_rate: float) -> float:
    """Purchase units from a serving forecast (spec section 5c)."""

    usable = servings_per_unit * (1.0 - loss_rate)
    if usable <= 0:
        return 0.0
    return servings / usable


def running_estimate(
    last_count: float,
    deliveries: float,
    servings_sold: float,
    servings_per_unit: float,
    loss_rate: float,
) -> float:
    """Count plus receipts minus drinks sold, with the category loss rate (spec section 6)."""

    return last_count + deliveries - servings_to_units(servings_sold, servings_per_unit, loss_rate)


def order_up_to(mu: float, sigma: float | None, target: float) -> float:
    return mu + z_for_target(target) * (sigma or 0.0)


def raw_order_qty(level: float, on_hand: float, on_order: float = 0.0, committed: float = 0.0) -> float:
    position = on_hand + on_order - committed
    return max(0.0, level - position)


def confidence_level(last_count: date | None, as_of: date) -> str:
    """High within 2 days, medium through 7, low when the count is missing or older."""

    if last_count is None:
        return "low"
    age = (as_of - last_count).days
    if age <= 2:
        return "high"
    if age <= 7:
        return "medium"
    return "low"


def par_level(par_text: str, delivery_weekday: str | None = None) -> float | None:
    """The written par for this delivery. It is a floor, not the order target."""

    text = par_text.lower()
    if delivery_weekday:
        short = delivery_weekday.strip()[:3].lower()
        for amount, day in re.findall(r"order up to (\d+(?:\.\d+)?) cases for (\w+)", text):
            if day[:3] == short:
                return float(amount)
    if "tapped" in text and "backup" in text:
        return 2.0
    match = re.search(r"buy up to (\d+(?:\.\d+)?)", text)
    if match:
        return float(match.group(1))
    return None


def draft_backup_par(forecast_units: float, base_par: float = 2.0) -> float:
    """One tapped keg plus one backup. A second backup when the window uses more than one keg."""

    if forecast_units > 1:
        return base_par + 1
    return base_par


def deal_pair(quantity: float, deal_step: float | None) -> tuple[float, float]:
    """The deal multiple just below the raw quantity, and the one just above it."""

    if deal_step is None or deal_step <= 0 or quantity <= 0:
        return quantity, quantity
    below = math.floor(quantity / deal_step) * deal_step
    above = math.ceil(quantity / deal_step - 1e-9) * deal_step
    if below <= 0:
        return above, above
    return below, above


def option_cost(
    quantity: float,
    *,
    on_hand: float,
    mu: float,
    level: float,
    unit_price: float,
    holding_rate: float = 0.05,
    stockout_multiple: float = 4.0,
) -> float:
    """Purchase cost, plus holding leftovers, plus the cost of ending below the order-up-to level."""

    purchase = quantity * unit_price
    leftover = max(0.0, on_hand + quantity - mu)
    short = max(0.0, level - (on_hand + quantity))
    holding = holding_rate * unit_price * leftover
    stockout = stockout_multiple * unit_price * short
    return purchase + holding + stockout


def choose_deal(
    quantity: float,
    *,
    on_hand: float,
    mu: float,
    level: float,
    deal_step: float | None,
    unit_price: float,
    holding_rate: float = 0.05,
    stockout_multiple: float = 4.0,
) -> tuple[float, float]:
    """Pick the cheaper of the two deal options. Return it and the other one."""

    below, above = deal_pair(quantity, deal_step)
    if abs(below - above) < 1e-9:
        return above, below
    cost_below = option_cost(
        below,
        on_hand=on_hand,
        mu=mu,
        level=level,
        unit_price=unit_price,
        holding_rate=holding_rate,
        stockout_multiple=stockout_multiple,
    )
    cost_above = option_cost(
        above,
        on_hand=on_hand,
        mu=mu,
        level=level,
        unit_price=unit_price,
        holding_rate=holding_rate,
        stockout_multiple=stockout_multiple,
    )
    if cost_above < cost_below:
        return above, below
    return below, above


def keep_rank(*, never_run_out: bool, substitutes: tuple[str, ...], target: float, category: str) -> int:
    """Higher rank is kept when space or budget runs out. Never-run-out items stay."""

    rank = int(round(target * 100))
    if never_run_out:
        rank += 1_000
    if not substitutes:
        rank += 100
    if category == "cocktail_ingredient":
        rank -= 50
    return rank


@dataclass(frozen=True)
class SizedLine:
    item_id: str
    quantity: float
    keep_rank: int
    space_per_unit: float = 1.0


def trim_lowest_priority(lines: list[SizedLine], free_space: float) -> list[SizedLine]:
    """Cut the lowest-priority lines first until the order fits (spec section 5e)."""

    used = sum(line.quantity * line.space_per_unit for line in lines)
    if used <= free_space + 1e-9:
        return lines
    overflow = used - free_space
    quantities = {line.item_id: line.quantity for line in lines}
    ordered = sorted(lines, key=lambda line: (line.keep_rank, line.item_id))
    for line in ordered:
        if overflow <= 1e-9:
            break
        held = quantities[line.item_id] * line.space_per_unit
        cut = min(held, overflow)
        if line.space_per_unit <= 0:
            continue
        quantities[line.item_id] -= cut / line.space_per_unit
        overflow -= cut
    return [
        SizedLine(line.item_id, quantities[line.item_id], line.keep_rank, line.space_per_unit)
        for line in lines
    ]


def cap_for_freshness(
    quantity: float,
    on_hand: float,
    mu: float,
    window_days: int,
    shelf_life_days: int | None,
) -> float:
    """Don't hold more than the bar sells inside the freshness window."""

    if shelf_life_days is None or window_days <= 0:
        return quantity
    daily = mu / window_days
    max_hold = daily * shelf_life_days
    return max(0.0, min(quantity, max_hold - on_hand))


def apply_receipt(on_hand: float, received: float) -> float:
    """A delivery adds what arrived. The ordered amount is not stock."""

    return on_hand + received


def shortfall(ordered: float, received: float) -> float:
    return max(0.0, ordered - received)


def products_in_play(products: list[Product], *, bottle_service: bool) -> list[Product]:
    """Bottle service stays out of every list while its module is off."""

    kept: list[Product] = []
    for product in products:
        if product.category == "bottle_service":
            if bottle_service:
                kept.append(product)
            continue
        if product.active:
            kept.append(product)
    return kept


def inclusive_days(start: date, end: date) -> list[date]:
    days: list[date] = []
    day = start
    while day <= end:
        days.append(day)
        day += timedelta(days=1)
    return days


def _weekday_index(name: str) -> int:
    short = name.strip()[:3]
    try:
        return _WEEKDAY.index(short)
    except ValueError as exc:
        raise ValueError(f"unknown weekday {name!r}") from exc


def _next_on_or_after(day: date, indexes: set[int]) -> date:
    cursor = day
    for _ in range(8):
        if cursor.weekday() in indexes:
            return cursor
        cursor += timedelta(days=1)
    raise ValueError("no delivery on this schedule")


def _next_after(day: date, indexes: set[int]) -> date:
    return _next_on_or_after(day + timedelta(days=1), indexes)


def extended_window(missed_delivery: date, delivery_weekdays: list[str]) -> tuple[date, date]:
    """From the missed delivery through the day before the delivery after the one that will arrive.

    A Thursday order moved to Monday has to cover Thursday until the delivery
    after that Monday. That is longer than the on-time Thursday window.
    """

    indexes = {_weekday_index(name) for name in delivery_weekdays}
    arrival = _next_after(missed_delivery, indexes)
    following = _next_after(arrival, indexes)
    return missed_delivery, following - timedelta(days=1)


def events_needing_an_earlier_order(
    as_of: date,
    delivery_weekdays: list[str],
    events_by_date: dict[date, tuple[str, ...]],
    horizon_days: int = 14,
) -> list[tuple[date, str]]:
    """Events inside the next 14 days that the second upcoming delivery cannot cover."""

    if not delivery_weekdays:
        return []
    indexes = {_weekday_index(name) for name in delivery_weekdays}
    first = _next_on_or_after(as_of, indexes)
    second = _next_after(first, indexes)
    flagged: list[tuple[date, str]] = []
    for offset in range(horizon_days + 1):
        day = as_of + timedelta(days=offset)
        if day >= second:
            continue
        for name in events_by_date.get(day, ()):
            flagged.append((day, name))
    return flagged


def expected_shortfalls(item: str, on_hand: float, daily: float, start: date, end: date) -> list[str]:
    """The first night the estimated stock goes negative if nothing else arrives."""

    stock = on_hand
    day = start
    while day <= end:
        stock -= daily
        if stock < -1e-9:
            return [f"{item} is likely to run out on {day:%A}."]
        day += timedelta(days=1)
    return []


def recovery_options(policy: str, *, category: str, substitutes: tuple[str, ...]) -> list[str]:
    """Cheapest recovery first. A late add-on is listed only when the supplier accepts one."""

    options: list[str] = []
    if policy == "accepted_with_fee":
        options.append("Ask the distributor for a late add-on. Their policy allows it for a fee.")
    if category == "liquor":
        options.append("Add the short items to the next state-store run.")
    if substitutes:
        options.append("Feature an in-stock substitute until the delivery arrives.")
    options.append("Pause specials that use the short item.")
    options.append("Add the shortfall to the next order, sized for the longer window.")
    return options


def order_for_span(
    mu_per_day: float,
    start: date,
    end: date,
    *,
    sigma: float | None,
    target: float,
    on_hand: float,
) -> float:
    days = inclusive_days(start, end)
    mu = mu_per_day * len(days)
    return raw_order_qty(order_up_to(mu, sigma, target), on_hand)


def _pretty(value: float) -> str:
    if abs(value - round(value)) < 1e-6:
        return str(int(round(value)))
    return f"{value:.1f}"


def _deal_phrase(quantity: float, deal_step: float | None, unit_name: str) -> str:
    if deal_step is None or deal_step <= 0 or quantity <= 0:
        return ""
    count = quantity / deal_step
    if abs(count - round(count)) > 1e-6:
        return ""
    number = int(round(count))
    word = _WORDS[number] if number < len(_WORDS) else str(number)
    noun = "deal" if number == 1 else "deals"
    if unit_name == "cases":
        return f" ({word} {_pretty(deal_step)}-case {noun})"
    return f" ({word} {noun} of {_pretty(deal_step)})"


def why_line(
    *,
    delivery_weekday: str,
    covers_through: date,
    forecast_units: float,
    unit_name: str,
    on_hand: float,
    quantity: float,
    target: float,
    deal_step: float | None,
    event_note: str | None = None,
    confidence: str = "high",
    shortage: bool = False,
    trimmed: bool = False,
    late: bool = False,
) -> str:
    text = f"{delivery_weekday} covers through {covers_through:%A}. "
    text += f"Forecast {_pretty(forecast_units)} {unit_name}"
    if event_note:
        text += f" ({event_note})"
    text += f". You have about {_pretty(on_hand)}. "
    if confidence == "low":
        text += "There is no recent count, so this order follows the par and does not use the forecast target."
        return text
    if confidence == "medium":
        text += "Count this item before you send the order. "
    if late:
        text += "The earlier delivery was missed, so this window is longer. "
    text += (
        f"Ordering {_pretty(quantity)}{_deal_phrase(quantity, deal_step, unit_name)} "
        f"leaves a {round(target * 100):.0f}% chance of not running out."
    )
    if shortage:
        text += " Cooler space is short, so this is the smaller deal and a shortage is more likely."
    if trimmed:
        text += " Storage or the weekly budget cut this item before higher-priority ones."
    return text


def build_recommendation(
    *,
    supplier: str,
    item_id: str,
    delivery_weekday: str,
    delivery_date: date | None,
    cutoff: datetime | None,
    window_start: date,
    window_end: date,
    covers_through: date,
    forecast_units: float,
    sigma_units: float | None,
    unit_name: str,
    on_hand: float,
    target: float,
    unit_price: float,
    as_of: date,
    on_order: float = 0.0,
    committed: float = 0.0,
    par: float | None = None,
    deal_step: float | None = None,
    last_count: date | None = None,
    event_note: str | None = None,
    free_space: float | None = None,
    perishable: bool = False,
    shelf_life_days: int | None = None,
    late_order: bool = False,
    category: str = "bottles_cans",
    holding_rate: float = 0.05,
    stockout_multiple: float = 4.0,
) -> Recommendation:
    """One item on the next order, with the other deal option and a why line."""

    level = order_up_to(forecast_units, sigma_units, target)
    position = on_hand + on_order - committed
    confidence = confidence_level(last_count, as_of)
    if category == "draft":
        par = draft_backup_par(forecast_units, par if par is not None else 2.0)
    window_days = max(1, (window_end - window_start).days + 1)
    shortage = False
    if confidence == "low":
        if last_count is None:
            quantity = par or 0.0
        else:
            quantity = max(0.0, (par or 0.0) - position)
        alternative = quantity
        deal_for_phrase = None
    else:
        needed = raw_order_qty(level, on_hand, on_order, committed)
        if par is not None:
            needed = max(needed, max(0.0, par - position))
        if perishable:
            needed = cap_for_freshness(needed, position, forecast_units, window_days, shelf_life_days)
        quantity, alternative = choose_deal(
            needed,
            on_hand=position,
            mu=forecast_units,
            level=level,
            deal_step=deal_step,
            unit_price=unit_price,
            holding_rate=holding_rate,
            stockout_multiple=stockout_multiple,
        )
        if par is not None and position + quantity + 1e-9 < par and position + alternative >= par:
            quantity, alternative = alternative, quantity
        deal_for_phrase = deal_step
        if free_space is not None and quantity > free_space + 1e-9:
            if alternative <= free_space + 1e-9:
                quantity, alternative = alternative, quantity
            else:
                quantity = max(0.0, free_space)
            shortage = True
    return Recommendation(
        supplier=supplier,
        cutoff=cutoff,
        delivery_date=delivery_date,
        window_end=window_end,
        item=item_id,
        forecast_for_window=forecast_units,
        sigma_for_window=sigma_units,
        estimated_on_hand=on_hand,
        confidence=confidence,
        target_level=target,
        order_up_to_level=level,
        recommended_quantity=quantity,
        alternative_deal_quantity=alternative,
        why_line=why_line(
            delivery_weekday=delivery_weekday,
            covers_through=covers_through,
            forecast_units=forecast_units,
            unit_name=unit_name,
            on_hand=on_hand,
            quantity=quantity,
            target=target,
            deal_step=deal_for_phrase,
            event_note=event_note,
            confidence=confidence,
            shortage=shortage,
            late=late_order,
        ),
        late_order_flag=late_order,
    )


def corona_worked_example(free_space: float | None = 70) -> Recommendation:
    """Spec section 5g. Illustrative numbers, not a Sawtooth order.

    Forecast 14 cases, σ = 3, 98% target, 5 cases on hand, deals of 6.
    S = 14 + 2.05 × 3 = 20.15. The raw order is about 15.2 cases.
    """

    return build_recommendation(
        supplier="SUP_A",
        item_id="P001",
        delivery_weekday="Thursday",
        delivery_date=date(2026, 11, 5),
        cutoff=datetime(2026, 11, 4, 14, 0),
        window_start=date(2026, 11, 4),
        window_end=date(2026, 11, 8),
        covers_through=date(2026, 11, 9),
        forecast_units=14,
        sigma_units=3,
        unit_name="cases",
        on_hand=5,
        target=0.98,
        unit_price=26.50,
        as_of=date(2026, 11, 4),
        deal_step=6,
        last_count=date(2026, 11, 4),
        event_note="Homecoming Saturday",
        free_space=free_space,
    )
