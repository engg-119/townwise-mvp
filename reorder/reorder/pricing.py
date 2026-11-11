"""Advisory price suggestions. The owner accepts, dismisses, or postpones each one.

New Hampshire rules live in config/rules/nh.yaml. A state with no rules file only
gets deal-size comparisons from the suppliers the bar already uses. A web price
lookup is a separate interface and returns nothing until one is connected.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import yaml

from reorder.contracts import Product
from reorder.engine import products_in_play
from reorder.ingestion.tabular import iter_rows, parse_date, parse_number
from reorder.paths import reject_ground_truth

_ACTIONS = ("accept", "dismiss", "remind_later")


@dataclass(frozen=True)
class CategoryRule:
    allowed: tuple[str, ...]
    forbidden: tuple[str, ...]
    same_brand_one_distributor: bool


@dataclass(frozen=True)
class StateRules:
    """Loaded purchasing rules. ``present`` is false when the state has no file."""

    state: str
    present: bool
    stale_after_days: int = 30
    dismissal_hide_days: int = 30
    categories: dict[str, CategoryRule] | None = None
    channel_labels: dict[str, str] | None = None
    not_legal_advice: bool = True

    def label(self, channel: str) -> str:
        labels = self.channel_labels or {}
        return labels.get(channel, channel.replace("_", " "))


def load_state_rules(state: str, root: Path) -> StateRules:
    """Load config/rules/{state}.yaml. A missing file allows deal sizes only."""

    path = root / "config" / "rules" / f"{state.strip().lower()}.yaml"
    if not path.is_file():
        return StateRules(state=state.strip().upper(), present=False)
    reject_ground_truth(path)
    with path.open() as handle:
        raw = yaml.safe_load(handle)
    categories: dict[str, CategoryRule] = {}
    for name, row in (raw.get("categories") or {}).items():
        categories[str(name)] = CategoryRule(
            allowed=tuple(str(item) for item in row.get("allowed", [])),
            forbidden=tuple(str(item) for item in row.get("forbidden", [])),
            same_brand_one_distributor=bool(row.get("same_brand_one_distributor", False)),
        )
    labels = {str(k): str(v) for k, v in (raw.get("channel_labels") or {}).items()}
    return StateRules(
        state=str(raw.get("state", state)).upper(),
        present=True,
        stale_after_days=int(raw.get("stale_after_days", 30)),
        dismissal_hide_days=int(raw.get("dismissal_hide_days", 30)),
        categories=categories,
        channel_labels=labels,
        not_legal_advice=bool(raw.get("not_legal_advice", True)),
    )


@dataclass(frozen=True)
class PriceQuote:
    """One price from a file the owner uploaded, or from a future web lookup."""

    item_id: str
    supplier: str
    min_qty: float
    price_per_unit: float
    source: str
    effective_date: date
    channel: str
    promotion: bool = False
    expires: date | None = None


class PriceLookup:
    """Public price listings. The mock returns nothing so a real lookup can be added later."""

    def quotes_for(self, item_id: str, on: date) -> list[PriceQuote]:
        return []


def load_price_file(
    path: Path,
    *,
    supplier_channels: dict[str, str],
) -> list[PriceQuote]:
    """Read a price sheet. Channel comes from the file, or from the supplier map."""

    reject_ground_truth(path)
    quotes: list[PriceQuote] = []
    for raw in iter_rows(path):
        if not isinstance(raw, dict):
            continue
        supplier = (raw.get("supplier_id") or "").strip()
        channel = (raw.get("channel") or "").strip() or supplier_channels.get(supplier, "")
        expires = (raw.get("expires") or "").strip()
        promo = (raw.get("promotion") or "").strip().lower()
        quotes.append(
            PriceQuote(
                item_id=(raw.get("product_id") or "").strip(),
                supplier=supplier,
                min_qty=parse_number(raw.get("min_qty") or "1"),
                price_per_unit=parse_number(raw.get("price_per_purchase_unit") or "0"),
                source=(raw.get("source") or path.name).strip(),
                effective_date=parse_date(raw["effective_date"]),
                channel=channel,
                promotion=promo in {"1", "true", "yes", "y"},
                expires=parse_date(expires) if expires else None,
            )
        )
    return quotes


def quotes_in_effect(quotes: list[PriceQuote], on: date) -> list[PriceQuote]:
    """The latest quote on or before ``on`` for each item, supplier, and deal size."""

    chosen: dict[tuple[str, str, float, bool], PriceQuote] = {}
    for quote in quotes:
        if quote.effective_date > on:
            continue
        if quote.expires is not None and quote.expires < on:
            continue
        key = (quote.item_id, quote.supplier, quote.min_qty, quote.promotion)
        current = chosen.get(key)
        if current is None or quote.effective_date >= current.effective_date:
            chosen[key] = quote
    return list(chosen.values())


def is_stale(quote: PriceQuote, on: date, stale_after_days: int) -> bool:
    return (on - quote.effective_date).days > stale_after_days


def channel_allowed(rules: StateRules, category: str, channel: str) -> bool:
    """False when this channel is illegal for the category, or the state has no rules."""

    if not rules.present or not channel:
        return False
    rule = (rules.categories or {}).get(category)
    if rule is None:
        return False
    if channel in rule.forbidden:
        return False
    return channel in rule.allowed


@dataclass(frozen=True)
class Suggestion:
    """One advisory card. The owner chooses the action."""

    suggestion_id: str
    kind: str
    item_id: str
    current_label: str
    current_cost_per_serving: float
    alternative_label: str
    alternative_cost_per_serving: float
    savings_per_week: float
    tradeoff: str
    legal_channel: str
    price_source: str
    price_date: date
    stale: bool
    actions: tuple[str, ...] = _ACTIONS


@dataclass(frozen=True)
class OwnerAction:
    suggestion_id: str
    action: str
    on: date
    note: str = ""


def record_action(log: list[OwnerAction], action: OwnerAction) -> list[OwnerAction]:
    if action.action not in _ACTIONS:
        raise ValueError(f"unknown owner action {action.action!r}")
    return [*log, action]


def save_actions(path: Path, log: list[OwnerAction]) -> None:
    reject_ground_truth(path)
    payload = [
        {
            "suggestion_id": row.suggestion_id,
            "action": row.action,
            "on": row.on.isoformat(),
            "note": row.note,
        }
        for row in log
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def load_actions(path: Path) -> list[OwnerAction]:
    reject_ground_truth(path)
    if not path.is_file():
        return []
    raw = json.loads(path.read_text())
    return [
        OwnerAction(
            suggestion_id=row["suggestion_id"],
            action=row["action"],
            on=date.fromisoformat(row["on"]),
            note=row.get("note", ""),
        )
        for row in raw
    ]


def visible_suggestions(
    suggestions: list[Suggestion],
    log: list[OwnerAction],
    on: date,
    *,
    hide_days: int = 30,
) -> list[Suggestion]:
    """Hide a suggestion the owner dismissed or postponed, until the hide window ends."""

    hidden: set[str] = set()
    for row in log:
        if row.action not in {"dismiss", "remind_later"}:
            continue
        if (on - row.on).days < hide_days:
            hidden.add(row.suggestion_id)
    return [row for row in suggestions if row.suggestion_id not in hidden]


def _weekly_spend(weekly_units: float, min_qty: float, price: float, holding_rate: float) -> tuple[float, float]:
    """Cash for one week of use, plus holding on cases that will not sell this week."""

    bought = max(min_qty, math.ceil(weekly_units - 1e-9))
    leftover = max(0.0, bought - weekly_units)
    return price * weekly_units + holding_rate * price * leftover, leftover


def _per_serving(price: float, servings_per_unit: float) -> float:
    if servings_per_unit <= 0:
        return price
    return price / servings_per_unit


def _deal_label(name: str, min_qty: float, unit: str) -> str:
    qty = int(min_qty) if abs(min_qty - round(min_qty)) < 1e-6 else min_qty
    if "case" in unit:
        return f"{name}, {qty}-case deal"
    return f"{name}, {qty} {unit}"


def _space_word(unit: str) -> str:
    if "keg" in unit:
        return "keg slots"
    return "cooler slots"


def suggest_prices(
    products: list[Product],
    quotes: list[PriceQuote],
    *,
    rules: StateRules,
    on: date,
    weekly_units: dict[str, float],
    supplier_channels: dict[str, str] | None = None,
    usual_deals: dict[str, float] | None = None,
    bottle_service: bool = False,
    holding_rate: float = 0.05,
    web: PriceLookup | None = None,
) -> list[Suggestion]:
    """Deal sizes, substitutes, and uploaded promotions that cost less per week.

    A missing rules file skips substitutes and promotions from any new channel.
    Quotes on a forbidden channel are dropped either way.
    """

    supplier_channels = supplier_channels or {}
    usual_deals = usual_deals or {}
    lookup = web or PriceLookup()
    catalog = products_in_play(products, bottle_service=bottle_service)
    by_id = {product.item_id: product for product in catalog}
    pooled = list(quotes)
    for product in catalog:
        pooled.extend(lookup.quotes_for(product.item_id, on))
    active = quotes_in_effect(pooled, on)
    suggestions: list[Suggestion] = []
    for product in catalog:
        product_quotes = [
            quote
            for quote in active
            if quote.item_id == product.item_id and quote.price_per_unit > 0
        ]
        suggestions.extend(
            _deal_suggestions(
                product,
                product_quotes,
                rules=rules,
                on=on,
                weekly=weekly_units.get(product.item_id, 0.0),
                usual=usual_deals.get(product.item_id),
                supplier_channels=supplier_channels,
                holding_rate=holding_rate,
            )
        )
        if rules.present:
            suggestions.extend(
                _substitute_suggestions(
                    product,
                    by_id,
                    active,
                    rules=rules,
                    on=on,
                    weekly=weekly_units.get(product.item_id, 0.0),
                    supplier_channels=supplier_channels,
                    holding_rate=holding_rate,
                )
            )
    suggestions.sort(key=lambda row: (-row.savings_per_week, row.suggestion_id))
    return suggestions


def _owned_quotes(
    product: Product,
    quotes: list[PriceQuote],
    *,
    rules: StateRules,
    supplier_channels: dict[str, str],
) -> list[PriceQuote]:
    """Prices from the supplier that already sells this product. Other sellers of the same brand are dropped."""

    kept: list[PriceQuote] = []
    for quote in quotes:
        if quote.item_id != product.item_id or quote.supplier != product.supplier:
            continue
        channel = quote.channel or supplier_channels.get(quote.supplier, "")
        mapped = supplier_channels.get(quote.supplier, "")
        if rules.present:
            if not channel_allowed(rules, product.category, channel):
                continue
        elif quote.channel and quote.channel != mapped:
            # No state file: keep the current supplier's own sheet, not a new channel.
            continue
        kept.append(quote)
    return kept


def _deal_suggestions(
    product: Product,
    quotes: list[PriceQuote],
    *,
    rules: StateRules,
    on: date,
    weekly: float,
    usual: float | None,
    supplier_channels: dict[str, str],
    holding_rate: float,
) -> list[Suggestion]:
    if weekly <= 0:
        return []
    owned = [quote for quote in _owned_quotes(product, quotes, rules=rules, supplier_channels=supplier_channels) if not quote.promotion]
    if not owned:
        return []
    regulars = owned
    if usual is not None:
        matched = [quote for quote in regulars if abs(quote.min_qty - usual) < 1e-6]
        current = matched[0] if matched else min(regulars, key=lambda quote: quote.min_qty)
    else:
        current = min(regulars, key=lambda quote: quote.min_qty)
    current_spend, _current_left = _weekly_spend(weekly, current.min_qty, current.price_per_unit, holding_rate)
    name = product.names_by_source.get("catalog", product.item_id)
    channel = current.channel or supplier_channels.get(current.supplier, "")
    legal = rules.label(channel) if rules.present and channel else "Current supplier"
    found: list[Suggestion] = []
    for quote in regulars:
        if quote.min_qty <= current.min_qty + 1e-9:
            continue
        spend, leftover = _weekly_spend(weekly, quote.min_qty, quote.price_per_unit, holding_rate)
        savings = current_spend - spend
        if savings <= 0:
            continue
        extra = max(0.0, leftover)
        if extra > 0:
            tradeoff = (
                f"More cash tied up. Uses {extra:.0f} more {_space_word(product.purchase_unit)} "
                "until those cases sell."
            )
        else:
            tradeoff = "Same stock on hand. The larger deal is a lower price per case."
        stale = is_stale(current, on, rules.stale_after_days) or is_stale(quote, on, rules.stale_after_days)
        found.append(
            Suggestion(
                suggestion_id=f"deal:{product.item_id}:{int(quote.min_qty)}",
                kind="deal_size",
                item_id=product.item_id,
                current_label=_deal_label(name, current.min_qty, product.purchase_unit),
                current_cost_per_serving=_per_serving(current.price_per_unit, product.servings_per_unit),
                alternative_label=_deal_label(name, quote.min_qty, product.purchase_unit),
                alternative_cost_per_serving=_per_serving(quote.price_per_unit, product.servings_per_unit),
                savings_per_week=savings,
                tradeoff=tradeoff,
                legal_channel=legal,
                price_source=quote.source,
                price_date=quote.effective_date,
                stale=stale,
            )
        )
    promos = [
        quote
        for quote in _owned_quotes(product, quotes, rules=rules, supplier_channels=supplier_channels)
        if quote.promotion and rules.present
    ]
    for quote in promos:
        regular = next((row for row in regulars if abs(row.min_qty - quote.min_qty) < 1e-6), current)
        spend, _leftover = _weekly_spend(weekly, quote.min_qty, quote.price_per_unit, holding_rate)
        base, _base_left = _weekly_spend(weekly, regular.min_qty, regular.price_per_unit, holding_rate)
        savings = base - spend
        if savings <= 0:
            continue
        end = f" Ends {quote.expires.isoformat()}." if quote.expires else ""
        found.append(
            Suggestion(
                suggestion_id=f"promo:{product.item_id}:{int(quote.min_qty)}",
                kind="promotion",
                item_id=product.item_id,
                current_label=_deal_label(name, regular.min_qty, product.purchase_unit),
                current_cost_per_serving=_per_serving(regular.price_per_unit, product.servings_per_unit),
                alternative_label=f"{name}, distributor promotion",
                alternative_cost_per_serving=_per_serving(quote.price_per_unit, product.servings_per_unit),
                savings_per_week=savings,
                tradeoff=f"Time-limited price from the current supplier.{end}",
                legal_channel=legal,
                price_source=quote.source,
                price_date=quote.effective_date,
                stale=is_stale(quote, on, rules.stale_after_days),
            )
        )
    return found


def _substitute_suggestions(
    product: Product,
    by_id: dict[str, Product],
    quotes: list[PriceQuote],
    *,
    rules: StateRules,
    on: date,
    weekly: float,
    supplier_channels: dict[str, str],
    holding_rate: float,
) -> list[Suggestion]:
    if weekly <= 0 or not product.substitutes:
        return []
    rule = (rules.categories or {}).get(product.category)
    if rule is None:
        return []
    current_quotes = [quote for quote in _owned_quotes(product, quotes, rules=rules, supplier_channels=supplier_channels) if not quote.promotion]
    if not current_quotes:
        return []
    current = min(current_quotes, key=lambda quote: quote.min_qty)
    current_spend, _left = _weekly_spend(weekly, current.min_qty, current.price_per_unit, holding_rate)
    weekly_servings = weekly * product.servings_per_unit
    name = product.names_by_source.get("catalog", product.item_id)
    found: list[Suggestion] = []
    for other_id in product.substitutes:
        other = by_id.get(other_id)
        if other is None or other.servings_per_unit <= 0:
            continue
        other_weekly = weekly_servings / other.servings_per_unit
        other_quotes = [
            quote
            for quote in quotes
            if quote.item_id == other.item_id and not quote.promotion and quote.price_per_unit > 0
        ]
        legal_quotes = []
        for quote in other_quotes:
            channel = quote.channel or supplier_channels.get(quote.supplier, "")
            if quote.supplier != other.supplier and rule.same_brand_one_distributor:
                continue
            if quote.supplier != other.supplier:
                continue
            if not channel_allowed(rules, other.category, channel):
                continue
            legal_quotes.append(quote)
        if not legal_quotes:
            continue
        best = min(legal_quotes, key=lambda quote: quote.price_per_unit)
        alt_spend, leftover = _weekly_spend(other_weekly, best.min_qty, best.price_per_unit, holding_rate)
        savings = current_spend - alt_spend
        if savings <= 0:
            continue
        other_name = other.names_by_source.get("catalog", other.item_id)
        channel = best.channel or supplier_channels.get(best.supplier, "")
        found.append(
            Suggestion(
                suggestion_id=f"substitute:{product.item_id}:{other.item_id}",
                kind="substitute",
                item_id=product.item_id,
                current_label=name,
                current_cost_per_serving=_per_serving(current.price_per_unit, product.servings_per_unit),
                alternative_label=other_name,
                alternative_cost_per_serving=_per_serving(best.price_per_unit, other.servings_per_unit),
                savings_per_week=savings,
                tradeoff=(
                    "Different product, so some guests will not switch. "
                    + (
                        f"Uses about {leftover:.0f} extra {_space_word(other.purchase_unit)}."
                        if leftover > 0
                        else "Bought from a supplier the bar already uses."
                    )
                ),
                legal_channel=rules.label(channel),
                price_source=best.source,
                price_date=best.effective_date,
                stale=is_stale(current, on, rules.stale_after_days) or is_stale(best, on, rules.stale_after_days),
            )
        )
    return found
