"""Replay the bar day by day. Two policies, no peeking at later sales.

The order decision sees only servings recorded before the cutoff. What guests
actually wanted, including drinks the old rules lost, is used only to score
the result. That file lives under ground_truth and is not an input to the
forecast or the order engine.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from statistics import mean

from reorder.catalog import load_products, load_recipes, load_supplier_schedules
from reorder.config import load_config
from reorder.contracts import Product, RecipeLine, SupplierSchedule
from reorder.engine import build_recommendation, extended_window, par_level, servings_to_units
from reorder.forecast_adapter import servings_per_drink, sigma_from_window_errors
from reorder.paths import reject_ground_truth

_WEEKDAY = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


@dataclass
class WeekdayStats:
    total: list[float] = field(default_factory=lambda: [0.0] * 7)
    count: list[int] = field(default_factory=lambda: [0] * 7)

    def add(self, day: date, qty: float) -> None:
        self.total[day.weekday()] += qty
        self.count[day.weekday()] += 1

    def mean(self, weekday: int) -> float | None:
        if self.count[weekday] == 0:
            return None
        return self.total[weekday] / self.count[weekday]


def window_forecast(stats: WeekdayStats, days: list[date]) -> float | None:
    """Sum of weekday averages. Days with no past sales of that weekday are skipped."""

    total = 0.0
    covered = 0
    for day in days:
        value = stats.mean(day.weekday())
        if value is None:
            continue
        total += value
        covered += 1
    if not covered:
        return None
    return total


@dataclass(frozen=True)
class CategoryScore:
    category: str
    stockout_item_days: int
    stockout_days_per_item: float
    fill_rate: float | None
    avg_units_on_hand: float
    avg_days_of_supply: float | None
    units_wasted: float
    liquor_runs_per_month: float
    margin_lost: float
    pour_cost: float | None
    window_error: float | None


@dataclass(frozen=True)
class Replay:
    policy: str
    by_category: tuple[CategoryScore, ...]
    never_run_out_stockout_days: int
    never_run_out_units_on_hand: float
    late_orders: int
    late_order_cost: float
    months: float


def beats_baseline(agent: Replay, baseline: Replay) -> bool:
    """Fewer never-run-out stockout days, and no more stock sitting on hand."""

    return (
        agent.never_run_out_stockout_days < baseline.never_run_out_stockout_days
        and agent.never_run_out_units_on_hand <= baseline.never_run_out_units_on_hand + 1e-6
    )


def metrics_table(replay: Replay) -> str:
    header = (
        "| Category | Stockout days / item | Fill rate | Days of supply | "
        "Units wasted | Liquor runs / month | Margin lost | Pour cost | Window error |"
    )
    rule = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    lines = [f"## {replay.policy}", "", header, rule]
    for row in replay.by_category:
        fill = "—" if row.fill_rate is None else f"{row.fill_rate:.0%}"
        cover = "—" if row.avg_days_of_supply is None else f"{row.avg_days_of_supply:.1f}"
        pour = "—" if row.pour_cost is None else f"{row.pour_cost:.0%}"
        error = "—" if row.window_error is None else f"{row.window_error:.1f}"
        lines.append(
            f"| {row.category} | {row.stockout_days_per_item:.2f} | {fill} | {cover} | "
            f"{row.units_wasted:.1f} | {row.liquor_runs_per_month:.2f} | ${row.margin_lost:.0f} | {pour} | {error} |"
        )
    lines.append("")
    lines.append(
        f"Never-run-out stockout days: {replay.never_run_out_stockout_days}. "
        f"Average units on hand: {replay.never_run_out_units_on_hand:.2f}."
    )
    lines.append(
        f"Late orders: {replay.late_orders}. Late-order cost: ${replay.late_order_cost:.0f}."
    )
    return "\n".join(lines)


def stockouts_prevented(without_recovery: Replay, with_recovery: Replay) -> int:
    return without_recovery.never_run_out_stockout_days - with_recovery.never_run_out_stockout_days


class _Lots:
    def __init__(self) -> None:
        self.lots: list[list] = []

    def add(self, day: date, qty: float) -> None:
        if qty > 1e-9:
            self.lots.append([day, qty])

    def on_hand(self) -> float:
        return sum(qty for _, qty in self.lots)

    def take(self, qty: float) -> float:
        left = qty
        kept: list[list] = []
        for arrival, have in self.lots:
            if left <= 1e-9:
                kept.append([arrival, have])
                continue
            used = min(have, left)
            left -= used
            if have - used > 1e-9:
                kept.append([arrival, have - used])
        self.lots = kept
        return qty - left

    def expire(self, today: date, shelf_days: int | None) -> float:
        if shelf_days is None:
            return 0.0
        wasted = 0.0
        kept: list[list] = []
        for arrival, qty in self.lots:
            if (today - arrival).days > shelf_days:
                wasted += qty
            else:
                kept.append([arrival, qty])
        self.lots = kept
        return wasted


def _dates(start: date, end: date) -> list[date]:
    days = []
    day = start
    while day <= end:
        days.append(day)
        day += timedelta(days=1)
    return days


def _next_weekday(day: date, index: int) -> date:
    ahead = (index - day.weekday()) % 7
    found = day + timedelta(days=ahead)
    if found < day:
        found += timedelta(days=7)
    return found


def _cutoff_date(delivery: date, cutoff_weekday: str) -> date:
    index = _WEEKDAY.index(cutoff_weekday[:3])
    back = (delivery.weekday() - index) % 7
    return delivery - timedelta(days=back)


@dataclass(frozen=True)
class _Stop:
    cutoff: date
    delivery: date
    arrival: date
    window: tuple[date, ...]
    supplier: str
    product_ids: tuple[str, ...]
    late: bool
    late_fee: float
    delivery_name: str


def _stops(
    schedules: list[SupplierSchedule],
    products: list[Product],
    start: date,
    end: date,
    *,
    miss_thursdays: bool,
    recover: bool,
) -> list[_Stop]:
    by_supplier: dict[str, list[SupplierSchedule]] = defaultdict(list)
    for row in schedules:
        if row.delivery_weekday and row.cutoff_weekday:
            by_supplier[row.supplier].append(row)
    drafted: list[_Stop] = []
    covered: set[tuple[str, date]] = set()
    for supplier, rows in by_supplier.items():
        ids = tuple(product.item_id for product in products if product.supplier == supplier and product.category != "liquor")
        if not ids:
            continue
        weekdays = [row.delivery_weekday or "" for row in rows]
        indexes = {_WEEKDAY.index(name[:3]) for name in weekdays}
        for row in rows:
            delivery_index = _WEEKDAY.index((row.delivery_weekday or "")[:3])
            day = start
            while day <= end + timedelta(days=7):
                if day.weekday() == delivery_index:
                    cutoff = _cutoff_date(day, row.cutoff_weekday or "")
                    arrival = day
                    late = False
                    window_end = _next_delivery_after(day, indexes) - timedelta(days=1)
                    if miss_thursdays and delivery_index == 3:
                        late = True
                        arrival = _next_delivery_after(day, indexes)
                        covered.add((supplier, arrival))
                        if recover:
                            _, window_end = extended_window(day, weekdays)
                    if start <= cutoff <= end:
                        drafted.append(
                            _Stop(
                                cutoff=cutoff,
                                delivery=day,
                                arrival=arrival,
                                window=tuple(_dates(cutoff, window_end)),
                                supplier=supplier,
                                product_ids=ids,
                                late=late,
                                late_fee=row.late_fee if late else 0.0,
                                delivery_name=day.strftime("%A"),
                            )
                        )
                day += timedelta(days=1)
    # A missed Thursday is the order that shows up on the next delivery.
    # That delivery does not also get its ordinary short order.
    return [stop for stop in drafted if stop.late or (stop.supplier, stop.delivery) not in covered]


def _next_delivery_after(delivery: date, indexes: set[int]) -> date:
    day = delivery + timedelta(days=1)
    for _ in range(8):
        if day.weekday() in indexes:
            return day
        day += timedelta(days=1)
    return delivery + timedelta(days=7)


def _perishable(product: Product) -> bool:
    return product.category == "draft" or "cider" in product.names_by_source.get("catalog", "").lower()


def _target(product: Product, targets: dict[str, float]) -> float:
    if product.never_run_out:
        return targets.get("never_run_out", 0.98)
    return targets.get(product.category, 0.95)


def _baseline_qty(
    product: Product,
    on_hand: float,
    delivery_name: str,
    window: tuple[date, ...],
    events: dict[date, tuple[str, ...]],
    weekly_floor: dict[str, float],
) -> float:
    par = par_level(product.par_minimum, delivery_name)
    if product.category == "draft" and par is None:
        par = 2.0
    qty = max(0.0, (par or 0.0) - on_hand)
    floor = weekly_floor.get(product.item_id)
    if floor is not None and delivery_name.startswith("Thu"):
        qty = max(qty, max(0.0, floor - on_hand))
    if product.category == "bottles_cans" and any(events.get(day) for day in window):
        qty += 1.0
    return qty


def _agent_qty(
    product: Product,
    on_hand: float,
    stats: WeekdayStats,
    errors: list[float],
    stop: _Stop,
    targets: dict[str, float],
    loss: float,
    as_of: date,
) -> float:
    forecast = window_forecast(stats, list(stop.window))
    mu_servings = forecast or 0.0
    mu = servings_to_units(mu_servings, product.servings_per_unit, loss)
    sigma_servings = sigma_from_window_errors(errors)
    sigma = None if sigma_servings is None else servings_to_units(sigma_servings, product.servings_per_unit, loss)
    par = par_level(product.par_minimum, stop.delivery_name)
    step = min((tier.quantity for tier in product.deal_tiers), default=None)
    recommendation = build_recommendation(
        supplier=product.supplier,
        item_id=product.item_id,
        delivery_weekday=stop.delivery_name,
        delivery_date=stop.delivery,
        cutoff=datetime.combine(stop.cutoff, datetime.min.time()),
        window_start=stop.window[0],
        window_end=stop.window[-1],
        covers_through=stop.window[-1] + timedelta(days=1),
        forecast_units=mu,
        sigma_units=sigma,
        unit_name="cases",
        on_hand=on_hand,
        target=_target(product, targets),
        unit_price=product.cost_per_unit or 1.0,
        as_of=as_of,
        par=par,
        deal_step=step,
        last_count=as_of,
        category=product.category,
        perishable=_perishable(product),
        shelf_life_days=product.shelf_life_days,
    )
    return recommendation.recommended_quantity or 0.0


def replay(
    products: list[Product],
    schedules: list[SupplierSchedule],
    sales: dict[str, dict[date, float]],
    demand: dict[str, dict[date, float]],
    *,
    start: date,
    end: date,
    policy: str,
    targets: dict[str, float],
    loss_rates: dict[str, float],
    weekly_floor: dict[str, float] | None = None,
    events: dict[date, tuple[str, ...]] | None = None,
    revenue_per_serving: dict[str, float] | None = None,
    opening_units: dict[str, float] | None = None,
    miss_thursdays: bool = False,
    recover: bool = False,
) -> Replay:
    """Walk ``start`` through ``end``. ``sales`` trains the forecast. ``demand`` is the score."""

    if policy not in {"baseline", "agent"}:
        raise ValueError(f"unknown policy {policy!r}")
    weekly_floor = weekly_floor or {}
    events = events or {}
    revenue_per_serving = revenue_per_serving or {}
    by_id = {product.item_id: product for product in products}
    stock = {product.item_id: _Lots() for product in products}
    for product in products:
        stock[product.item_id].add(start, (opening_units or {}).get(product.item_id, 0.0))
    stats = {product.item_id: WeekdayStats() for product in products}
    for product in products:
        for day, qty in sales.get(product.item_id, {}).items():
            if day < start:
                stats[product.item_id].add(day, qty)
    errors: dict[str, list[float]] = defaultdict(list)
    pending: dict[date, list[tuple[str, float]]] = defaultdict(list)
    open_windows: list[tuple[str, date, date, float]] = []
    stops = [stop for stop in _stops(schedules, products, start, end, miss_thursdays=miss_thursdays, recover=recover) if start <= stop.cutoff <= end]
    stops_on: dict[date, list[_Stop]] = defaultdict(list)
    for stop in stops:
        stops_on[stop.cutoff].append(stop)

    wanted: dict[str, float] = defaultdict(float)
    served: dict[str, float] = defaultdict(float)
    stockouts: dict[str, int] = defaultdict(int)
    on_hand_sum: dict[str, float] = defaultdict(float)
    on_hand_days: dict[str, int] = defaultdict(int)
    wasted: dict[str, float] = defaultdict(float)
    margin: dict[str, float] = defaultdict(float)
    cost_used: dict[str, float] = defaultdict(float)
    revenue: dict[str, float] = defaultdict(float)
    closed_errors: dict[str, list[float]] = defaultdict(list)
    liquor_runs = 0
    late_orders = 0
    late_cost = 0.0
    seen_late: set[tuple[date, str]] = set()

    for day in _dates(start, end):
        for product in products:
            if _perishable(product):
                wasted[product.item_id] += stock[product.item_id].expire(day, product.shelf_life_days)
        for item_id, qty in pending.pop(day, []):
            stock[item_id].add(day, qty)
        for stop in stops_on.get(day, []):
            if stop.late and (stop.delivery, stop.supplier) not in seen_late:
                seen_late.add((stop.delivery, stop.supplier))
                late_orders += 1
                late_cost += stop.late_fee
            for item_id in stop.product_ids:
                product = by_id[item_id]
                on_hand = stock[item_id].on_hand()
                loss = loss_rates.get(product.category, 0.0)
                if policy == "baseline":
                    qty = _baseline_qty(product, on_hand, stop.delivery_name, stop.window, events, weekly_floor)
                    forecast_servings = 0.0
                else:
                    forecast_servings = window_forecast(stats[item_id], list(stop.window)) or 0.0
                    qty = _agent_qty(product, on_hand, stats[item_id], errors[item_id], stop, targets, loss, day)
                if qty > 0:
                    pending[stop.arrival].append((item_id, qty))
                if policy == "agent":
                    open_windows.append((item_id, stop.window[0], stop.window[-1], forecast_servings))
        if day.weekday() == 0:
            bought = False
            store_ids = {row.supplier for row in schedules if row.delivery_weekday}
            for product in products:
                # Liquor, and mixers the owner picks up, ride along on the store run.
                # A mixer with a distributor delivery is ordered on that schedule instead.
                if product.category == "liquor":
                    pass
                elif product.category == "cocktail_ingredient" and product.supplier not in store_ids:
                    pass
                else:
                    continue
                on_hand = stock[product.item_id].on_hand()
                if policy == "baseline":
                    par = par_level(product.par_minimum) or 0.0
                    qty = max(0.0, par - on_hand)
                else:
                    horizon = _dates(day, day + timedelta(days=6))
                    fake = _Stop(day, day + timedelta(days=1), day + timedelta(days=1), tuple(horizon), product.supplier, (product.item_id,), False, 0.0, "Mon")
                    qty = _agent_qty(product, on_hand, stats[product.item_id], errors[product.item_id], fake, targets, loss_rates.get(product.category, 0.0), day)
                if qty > 0:
                    pending[day + timedelta(days=1)].append((product.item_id, qty))
                    bought = True
            if bought:
                liquor_runs += 1
        for product in products:
            need = demand.get(product.item_id, {}).get(day, 0.0)
            if need <= 0:
                on_hand_sum[product.item_id] += stock[product.item_id].on_hand()
                on_hand_days[product.item_id] += 1
                continue
            units_needed = need / product.servings_per_unit if product.servings_per_unit else need
            taken = stock[product.item_id].take(units_needed)
            served_servings = taken * product.servings_per_unit
            short = need - served_servings
            if short > 1e-6:
                for other_id in product.substitutes:
                    other = by_id.get(other_id)
                    if other is None or other.servings_per_unit <= 0:
                        continue
                    other_units = short / other.servings_per_unit
                    covered = stock[other_id].take(other_units)
                    if covered <= 0:
                        continue
                    covered_servings = covered * other.servings_per_unit
                    own_cost = (product.cost_per_unit or 0) / product.servings_per_unit
                    other_cost = (other.cost_per_unit or 0) / other.servings_per_unit
                    margin[product.item_id] += max(0.0, other_cost - own_cost) * covered_servings
                    cost_used[other.item_id] += covered * (other.cost_per_unit or 0)
                    short -= covered_servings
                    served_servings += covered_servings
                    if short <= 1e-6:
                        break
            wanted[product.item_id] += need
            served[product.item_id] += min(served_servings, need)
            if short > 1e-6:
                stockouts[product.item_id] += 1
            cost_used[product.item_id] += taken * (product.cost_per_unit or 0)
            price = revenue_per_serving.get(product.item_id)
            if price is not None:
                revenue[product.item_id] += min(served_servings, need) * price
            on_hand_sum[product.item_id] += stock[product.item_id].on_hand()
            on_hand_days[product.item_id] += 1
        still_open = []
        for item_id, window_start, window_end, forecast_servings in open_windows:
            if day <= window_end:
                still_open.append((item_id, window_start, window_end, forecast_servings))
                continue
            actual = sum(
                qty
                for seen, qty in sales.get(item_id, {}).items()
                if window_start <= seen <= window_end
            )
            errors[item_id].append(actual - forecast_servings)
            closed_errors[item_id].append(abs(actual - forecast_servings))
        open_windows = still_open
        for product in products:
            recorded = sales.get(product.item_id, {}).get(day)
            if recorded is not None:
                stats[product.item_id].add(day, recorded)

    months = max((end - start).days / 30.0, 1 / 30)
    categories = sorted({product.category for product in products})
    rows: list[CategoryScore] = []
    nro_stockouts = 0
    nro_units = []
    for category in categories:
        members = [product for product in products if product.category == category]
        if not members:
            continue
        item_days = sum(stockouts[product.item_id] for product in members)
        demand_total = sum(wanted[product.item_id] for product in members)
        served_total = sum(served[product.item_id] for product in members)
        units = []
        cover = []
        for product in members:
            days = on_hand_days[product.item_id]
            avg_units = on_hand_sum[product.item_id] / days if days else 0.0
            units.append(avg_units)
            daily = []
            for qty in demand.get(product.item_id, {}).values():
                if qty > 0:
                    daily.append(qty / product.servings_per_unit if product.servings_per_unit else qty)
            if daily and mean(daily) > 0:
                cover.append(avg_units / mean(daily))
            if product.never_run_out:
                nro_stockouts += stockouts[product.item_id]
                nro_units.append(avg_units)
        cost = sum(cost_used[product.item_id] for product in members)
        take = sum(revenue[product.item_id] for product in members)
        window_values = [value for product in members for value in closed_errors[product.item_id]]
        rows.append(
            CategoryScore(
                category=category,
                stockout_item_days=item_days,
                stockout_days_per_item=item_days / len(members),
                fill_rate=(served_total / demand_total) if demand_total else None,
                avg_units_on_hand=mean(units) if units else 0.0,
                avg_days_of_supply=mean(cover) if cover else None,
                units_wasted=sum(wasted[product.item_id] for product in members),
                liquor_runs_per_month=(liquor_runs / months) if category == "liquor" else 0.0,
                margin_lost=sum(margin[product.item_id] for product in members),
                pour_cost=(cost / take) if take else None,
                window_error=mean(window_values) if window_values else None,
            )
        )
    return Replay(
        policy=policy,
        by_category=tuple(rows),
        never_run_out_stockout_days=nro_stockouts,
        never_run_out_units_on_hand=mean(nro_units) if nro_units else 0.0,
        late_orders=late_orders,
        late_order_cost=late_cost,
        months=months,
    )


def _servings_by_product(
    path,
    qty_column: str,
    recipes: list[RecipeLine],
    products: list[Product],
    *,
    ground_truth: bool,
) -> dict[str, dict[date, float]]:
    if not ground_truth:
        reject_ground_truth(path)
    by_menu: dict[str, list[RecipeLine]] = defaultdict(list)
    for line in recipes:
        by_menu[line.menu_item_id].append(line)
    size = {product.item_id: product.serving_size_oz for product in products}
    totals: dict[str, dict[date, float]] = defaultdict(lambda: defaultdict(float))
    with open(path, newline="") as handle:
        for raw in csv.DictReader(handle):
            menu_id = raw.get("menu_item_id", "")
            qty = float(raw.get(qty_column) or 0)
            day = date.fromisoformat(raw["business_date"])
            for line in by_menu.get(menu_id, []):
                per = servings_per_drink(line.amount, line.unit, size.get(line.product_id))
                totals[line.product_id][day] += qty * per
    return {item: dict(days) for item, days in totals.items()}


def load_sales_servings(path, recipes: list[RecipeLine], products: list[Product]) -> dict[str, dict[date, float]]:
    return _servings_by_product(path, "qty_sold", recipes, products, ground_truth=False)


def load_true_demand(path, recipes: list[RecipeLine], products: list[Product]) -> dict[str, dict[date, float]]:
    """Held-out demand for the score. Not a forecast input."""

    return _servings_by_product(path, "true_demand", recipes, products, ground_truth=True)


def load_known_events(path) -> dict[date, tuple[str, ...]]:
    reject_ground_truth(path)
    found: dict[date, list[str]] = defaultdict(list)
    with open(path, newline="") as handle:
        for raw in csv.DictReader(handle):
            if raw.get("known_in_advance", "").strip().lower() != "true":
                continue
            found[date.fromisoformat(raw["date"])].append(raw["event_name"])
    return {day: tuple(names) for day, names in found.items()}


def revenue_per_serving(menu_path, recipes: list[RecipeLine], products: list[Product]) -> dict[str, float]:
    """Menu price spread across the recipe by ingredient cost."""

    reject_ground_truth(menu_path)
    prices: dict[str, float] = {}
    with open(menu_path, newline="") as handle:
        for raw in csv.DictReader(handle):
            prices[raw["menu_item_id"]] = float(raw.get("menu_price") or 0)
    cost = {product.item_id: product.cost_per_unit / product.servings_per_unit if product.servings_per_unit else 0.0 for product in products}
    size = {product.item_id: product.serving_size_oz for product in products}
    weight: dict[str, float] = defaultdict(float)
    take: dict[str, float] = defaultdict(float)
    by_menu: dict[str, list[RecipeLine]] = defaultdict(list)
    for line in recipes:
        by_menu[line.menu_item_id].append(line)
    for menu_id, lines in by_menu.items():
        price = prices.get(menu_id, 0.0)
        shares = []
        for line in lines:
            per = servings_per_drink(line.amount, line.unit, size.get(line.product_id))
            shares.append((line.product_id, per, max(cost.get(line.product_id, 0.0), 0.01) * per))
        total = sum(share for _, _, share in shares) or 1.0
        for product_id, per, share in shares:
            if per <= 0:
                continue
            take[product_id] += price * share / total
            weight[product_id] += per
    return {item: take[item] / weight[item] for item in take if weight[item]}


def run_period(start: date, end: date, *, miss_thursdays: bool = False, recover: bool = False, policy: str) -> Replay:
    config = load_config()
    root = config.resolve("synthetic_root")
    products = [
        product
        for product in load_products(root / "reference" / "products.csv")
        if product.active and product.category != "bottle_service"
    ]
    recipes = load_recipes(root / "reference" / "recipes.csv")
    schedules = load_supplier_schedules(root / "reference" / "supplier_schedule.csv")
    sales = load_sales_servings(root / "sales" / "daily_sales_by_item.csv", recipes, products)
    demand = load_true_demand(root / "ground_truth" / "true_daily_demand.csv", recipes, products)
    events = load_known_events(root / "reference" / "events_calendar.csv")
    prices = revenue_per_serving(root / "reference" / "menu_items.csv", recipes, products)
    opening = {}
    for product in products:
        par = par_level(product.par_minimum, "Thursday") or par_level(product.par_minimum) or 0.0
        opening[product.item_id] = par
    floor = {}
    corona = config.raw.get("current_par_rules", {}).get("corona_min_cases_per_week")
    if corona is not None:
        floor["P001"] = float(corona)
    return replay(
        products,
        schedules,
        sales,
        demand,
        start=start,
        end=end,
        policy=policy,
        targets=config.targets,
        loss_rates={key: float(value) for key, value in config.raw.get("loss_rate_defaults", {}).items()},
        weekly_floor=floor,
        events=events,
        revenue_per_serving=prices,
        opening_units=opening,
        miss_thursdays=miss_thursdays,
        recover=recover,
    )
