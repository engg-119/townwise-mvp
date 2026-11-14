"""Screen rules for the mockup. Streamlit draws these. It does not place orders.

Recommendations stay hidden until every supplier has a delivery day, a cutoff,
and a late-order policy. Pickup suppliers (the state store) use "not applicable"
and do not need a cutoff.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from reorder.contracts import Product, SupplierSchedule
from reorder.engine import (
    build_recommendation,
    keep_rank,
    par_level,
    products_in_play,
    trim_lowest_priority,
    SizedLine,
)
from reorder.forecast_adapter import exposure_windows

POLICIES = (
    "moved_to_next_delivery",
    "accepted_with_fee",
    "refused",
    "not_applicable",
)
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
OVERRIDE_REASONS = ("event", "storage", "price", "gut feel", "other")


def nav_pages(bottle_service: bool) -> list[str]:
    pages = [
        "Next order",
        "Onboarding",
        "Data sources",
        "Late order recovery",
        "Quick count",
        "Receive delivery",
        "Week ahead",
        "Liquor run",
        "Savings ideas",
        "How it's doing",
    ]
    if bottle_service:
        pages.insert(-2, "Bottle service")
    return pages


def schedule_ready(rows: list[dict[str, str]]) -> bool:
    """True only when the required schedule fields are filled in."""

    usable = [row for row in rows if str(row.get("supplier_id", "")).strip()]
    if not usable:
        return False
    for row in usable:
        policy = str(row.get("late_policy", "")).strip()
        if policy not in POLICIES:
            return False
        if policy == "not_applicable":
            continue
        if not str(row.get("delivery_day", "")).strip():
            return False
        if not str(row.get("cutoff_day", "")).strip():
            return False
        if not str(row.get("cutoff_time", "")).strip():
            return False
    return True


def rows_from_suppliers(suppliers: dict) -> list[dict[str, str]]:
    """Turn the config supplier block into onboarding rows. Values stay in the file."""

    rows: list[dict[str, str]] = []
    for supplier_id, info in suppliers.items():
        policy = str(info.get("late_order_policy", "")).strip()
        deliveries = info.get("deliveries") or []
        if not deliveries:
            rows.append(
                {
                    "supplier_id": str(supplier_id),
                    "delivery_day": "pickup",
                    "cutoff_day": "",
                    "cutoff_time": "",
                    "late_policy": policy or "not_applicable",
                }
            )
            continue
        for delivery in deliveries:
            rows.append(
                {
                    "supplier_id": str(supplier_id),
                    "delivery_day": str(delivery.get("day", "")),
                    "cutoff_day": str(delivery.get("cutoff_day", "")),
                    "cutoff_time": str(delivery.get("cutoff_time", "")),
                    "late_policy": policy,
                }
            )
    return rows


def _indexes(names: list[str]) -> set[int]:
    return {WEEKDAYS.index(name.strip()[:3]) for name in names if name.strip()}


def next_cutoff(rows: list[dict[str, str]], now: datetime) -> tuple[datetime, dict[str, str]] | None:
    """The soonest cutoff still ahead of ``now``."""

    best: tuple[datetime, dict[str, str]] | None = None
    for row in rows:
        if str(row.get("late_policy", "")) == "not_applicable":
            continue
        day_name = str(row.get("cutoff_day", "")).strip()
        clock = str(row.get("cutoff_time", "")).strip()
        if not day_name or not clock or ":" not in clock:
            continue
        hour, minute = (int(part) for part in clock.split(":", 1))
        weekday = WEEKDAYS.index(day_name[:3])
        ahead = (weekday - now.weekday()) % 7
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(days=ahead)
        if candidate <= now:
            candidate += timedelta(days=7)
        if best is None or candidate < best[0]:
            best = (candidate, row)
    return best


def reminder_text(now: datetime, cutoff: datetime, hours_before: list[int]) -> str | None:
    """The closest reminder that is already due. Hours come from config or the owner."""

    remaining_hours = (cutoff - now).total_seconds() / 3600
    if remaining_hours <= 0:
        return None
    due = [hours for hours in sorted(hours_before) if remaining_hours <= hours]
    if not due:
        return None
    soonest = due[0]
    shown = int(remaining_hours) if abs(remaining_hours - int(remaining_hours)) < 0.05 else round(remaining_hours, 1)
    return f"Order cutoff in {shown} hours. This is the {soonest}-hour reminder."


def unit_name(purchase_unit: str) -> str:
    text = purchase_unit.lower()
    if "keg" in text:
        return "kegs"
    if "bottle" in text:
        return "bottles"
    if "case" in text:
        return "cases"
    return purchase_unit


def schedules_from_rows(rows: list[dict[str, str]], products: list[Product]) -> list[SupplierSchedule]:
    by_supplier: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        if not schedule_ready([row]):
            continue
        if str(row.get("late_policy")) == "not_applicable":
            continue
        by_supplier[str(row["supplier_id"])].append(row)
    schedules: list[SupplierSchedule] = []
    for supplier, group in by_supplier.items():
        ids = tuple(product.item_id for product in products if product.supplier == supplier)
        for row in group:
            schedules.append(
                SupplierSchedule(
                    supplier=supplier,
                    products=ids,
                    delivery_weekday=str(row["delivery_day"])[:3],
                    cutoff_weekday=str(row["cutoff_day"])[:3],
                    cutoff_time=str(row["cutoff_time"]),
                    lead_time="",
                    minimum_order=0,
                    how_ordered="rep",
                    late_order_policy=row["late_policy"],  # type: ignore[arg-type]
                )
            )
    return schedules


def _delivery_inside(cutoff: date, window_end: date, delivery_days: list[str]) -> date:
    indexes = _indexes(delivery_days)
    day = cutoff + timedelta(days=1)
    while day <= window_end + timedelta(days=1):
        if day.weekday() in indexes:
            return day
        day += timedelta(days=1)
    return window_end


def next_window(
    schedules: list[SupplierSchedule],
    product_id: str,
    as_of: date,
) -> tuple[date, date, date] | None:
    """Cutoff, window end, and the delivery date for the next order of this product."""

    windows = exposure_windows(schedules, product_id, as_of, as_of + timedelta(days=21))
    upcoming = [(cutoff, end) for cutoff, end in windows if cutoff >= as_of]
    if not upcoming:
        return None
    cutoff, end = min(upcoming)
    days = [
        schedule.delivery_weekday or ""
        for schedule in schedules
        if product_id in schedule.products and schedule.delivery_weekday
    ]
    return cutoff, end, _delivery_inside(cutoff, end, days)


@dataclass(frozen=True)
class OrderView:
    item_id: str
    name: str
    supplier: str
    unit: str
    never_run_out: bool
    forecast: float
    on_hand: float
    confidence: str
    target: float
    recommended: float
    alternative: float
    why: str
    value: float
    category: str


def _target(product: Product, targets: dict[str, float]) -> float:
    if product.never_run_out:
        return targets.get("never_run_out", 0.98)
    return targets.get(product.category, 0.95)


def _deal_step(product: Product) -> float | None:
    if not product.deal_tiers:
        return None
    return min(tier.quantity for tier in product.deal_tiers)


def build_order(
    products: list[Product],
    rows: list[dict[str, str]],
    *,
    as_of: date,
    targets: dict[str, float],
    on_hand: dict[str, float] | None = None,
    last_count: date | None = None,
    forecasts: dict[str, tuple[float, float | None]] | None = None,
    bottle_service: bool = False,
    cooler_cases: float | None = None,
    event_notes: dict[str, str] | None = None,
) -> list[OrderView]:
    """Distributor lines for the next cutoff. Empty until the schedule is ready."""

    if not schedule_ready(rows):
        return []
    on_hand = on_hand or {}
    forecasts = forecasts or {}
    event_notes = event_notes or {}
    playing = products_in_play(products, bottle_service=bottle_service)
    schedules = schedules_from_rows(rows, playing)
    views: list[OrderView] = []
    for product in playing:
        if product.category in {"liquor", "bottle_service"}:
            continue
        window = next_window(schedules, product.item_id, as_of)
        if window is None:
            continue
        cutoff, end, delivery = window
        forecast, sigma = forecasts.get(product.item_id, (None, None))
        par = par_level(product.par_minimum, delivery.strftime("%A"))
        if forecast is None:
            forecast = par if par is not None else 0.0
        hand = on_hand.get(product.item_id, 0.0)
        recommendation = build_recommendation(
            supplier=product.supplier,
            item_id=product.item_id,
            delivery_weekday=delivery.strftime("%A"),
            delivery_date=delivery,
            cutoff=datetime.combine(cutoff, datetime.min.time()),
            window_start=cutoff,
            window_end=end,
            covers_through=end + timedelta(days=1),
            forecast_units=forecast,
            sigma_units=sigma,
            unit_name=unit_name(product.purchase_unit),
            on_hand=hand,
            target=_target(product, targets),
            unit_price=product.cost_per_unit or 1,
            as_of=as_of,
            par=par,
            deal_step=_deal_step(product),
            last_count=last_count,
            event_note=event_notes.get(product.item_id),
            category=product.category,
            perishable=product.category == "draft",
            shelf_life_days=product.shelf_life_days,
        )
        if recommendation.recommended_quantity is None:
            continue
        if recommendation.recommended_quantity <= 0 and not product.never_run_out:
            continue
        views.append(
            OrderView(
                item_id=product.item_id,
                name=product.names_by_source.get("catalog", product.item_id),
                supplier=product.supplier,
                unit=unit_name(product.purchase_unit),
                never_run_out=product.never_run_out,
                forecast=forecast,
                on_hand=hand,
                confidence=recommendation.confidence or "low",
                target=recommendation.target_level or 0,
                recommended=recommendation.recommended_quantity,
                alternative=recommendation.alternative_deal_quantity or recommendation.recommended_quantity,
                why=recommendation.why_line,
                value=recommendation.recommended_quantity * (product.cost_per_unit or 0),
                category=product.category,
            )
        )
    if cooler_cases is not None:
        ranks = {
            product.item_id: keep_rank(
                never_run_out=product.never_run_out,
                substitutes=product.substitutes,
                target=_target(product, targets),
                category=product.category,
            )
            for product in playing
        }
        trimmed = trim_lowest_priority(
            [
                SizedLine(view.item_id, view.recommended, ranks.get(view.item_id, 0), 1 if view.unit == "cases" else 0)
                for view in views
            ],
            cooler_cases,
        )
        quantities = {line.item_id: line.quantity for line in trimmed}
        views = [
            OrderView(
                **{
                    **view.__dict__,
                    "recommended": quantities.get(view.item_id, view.recommended),
                    "why": view.why
                    + (
                        " Storage cut this item before higher-priority ones."
                        if quantities.get(view.item_id, view.recommended) + 1e-9 < view.recommended
                        else ""
                    ),
                }
            )
            for view in views
        ]
    return sorted(views, key=lambda view: (not view.never_run_out, -view.value, view.name))


def edited_reason_needed(recommended: float, owner_quantity: float) -> bool:
    return abs(owner_quantity - recommended) > 1e-6


def order_text(lines: list[OrderView], quantities: dict[str, float], when: datetime) -> str:
    blocks = [f"Order for the rep. Prepared {when:%Y-%m-%d %H:%M}. The owner approves this. Nothing is sent automatically."]
    for line in lines:
        quantity = quantities.get(line.item_id, line.recommended)
        blocks.append(
            f"{line.name}: {quantity:g} {line.unit} from {line.supplier}. {line.why}"
        )
    return "\n".join(blocks)


def text_pdf(text: str) -> bytes:
    """A one-page PDF of the order text, enough for the rep export."""

    lines = text.splitlines()[:40] or [""]
    commands = ["BT", "/F1 11 Tf", "48 760 Td"]
    for index, line in enumerate(lines):
        if index:
            commands.append("0 -16 Td")
        safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        commands.append(f"({safe[:110]}) Tj")
    commands.append("ET")
    stream = "\n".join(commands).encode("latin-1", errors="replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode())
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    )
    return bytes(output)
