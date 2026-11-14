"""Data contracts from docs/REORDER_SPEC.md section 2.

Sales item ids are menu items after name matching. Inventory, orders, products,
and item forecasts use purchase-product ids. A recipe maps one to the other.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Literal

SourceType = Literal["pos_export", "spreadsheet", "invoice", "inventory_app", "manual"]
SalesUnit = Literal["drink", "bottle", "case", "dollar", "unknown"]
LateOrderPolicy = Literal[
    "moved_to_next_delivery", "accepted_with_fee", "refused", "not_applicable"
]
InventoryEventType = Literal["count", "delivery_received", "adjustment"]
ForecastUnit = Literal["servings", "guests"]


@dataclass(frozen=True)
class SourceCapabilities:
    """What a file can report. False means the value is unknown, not zero."""

    has_void_qty: bool
    has_void_reason: bool
    has_comp_qty: bool
    has_employee: bool


@dataclass(frozen=True)
class DataSource:
    source_id: str
    source_type: SourceType
    vendor: str | None
    file_format: str
    column_mapping: dict[str, str]
    mapping_confirmed: bool
    business_day_cutoff_hour: int
    time_zone: str
    capabilities: SourceCapabilities = field(
        default_factory=lambda: SourceCapabilities(False, False, False, False)
    )


@dataclass(frozen=True)
class SalesRecord:
    source_id: str
    business_date: date
    timestamp: datetime | None
    item_id: str | None
    raw_item_name: str
    quantity: float
    unit: SalesUnit
    net_price: float | None
    void_qty: float | None
    comp_qty: float | None
    refund: bool


@dataclass(frozen=True)
class VoidEvent:
    """One void, shaped like sales/void_log.csv."""

    event_id: str
    business_date: date
    timestamp: datetime | None
    check_id: str | None
    employee_id: str | None
    item_id: str | None
    raw_item_name: str
    quantity: float
    void_amount: float | None
    reason: str | None
    marked_as_waste: bool | None
    manager_approved_by: str | None
    source_id: str


@dataclass(frozen=True)
class CompEvent:
    """One comp, shaped like sales/comp_log.csv."""

    event_id: str
    business_date: date
    timestamp: datetime | None
    check_id: str | None
    employee_id: str | None
    item_id: str | None
    raw_item_name: str
    quantity: float
    comp_amount: float | None
    reason: str | None
    manager_approved_by: str | None
    product_cost: float | None
    source_id: str


@dataclass(frozen=True)
class SupplierSchedule:
    supplier: str
    products: tuple[str, ...]
    delivery_weekday: str | None
    cutoff_weekday: str | None
    cutoff_time: str | None
    lead_time: str
    minimum_order: float
    how_ordered: str
    late_order_policy: LateOrderPolicy
    late_fee: float = 0.0


@dataclass(frozen=True)
class DealTier:
    quantity: float
    price: float


@dataclass(frozen=True)
class Product:
    item_id: str
    names_by_source: dict[str, str]
    category: str
    supplier: str
    purchase_unit: str
    servings_per_unit: float
    cost_per_unit: float
    deal_tiers: tuple[DealTier, ...]
    shelf_life_days: int | None
    substitutes: tuple[str, ...]
    never_run_out: bool
    par_minimum: str
    servings_per_unit_expected: float | None = None
    serving_size_oz: float | None = None
    active: bool = True


@dataclass(frozen=True)
class RecipeLine:
    menu_item_id: str
    product_id: str
    amount: float
    unit: str


@dataclass(frozen=True)
class Forecast:
    """One day's demand.

    ``unit`` is ``guests`` for the existing bar-level forecast and ``servings``
    for a purchase product. ``sigma`` is the error of delivery-window totals
    (spec section 5b). It is left empty on a single day. The guest model's
    10th/90th band is not stored here.
    """

    item_id: str
    date: date
    expected_servings: float
    unit: ForecastUnit
    sigma: float | None
    event_flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class InventoryEvent:
    item_id: str | None
    timestamp: datetime
    event_type: InventoryEventType
    quantity_purchase_units: float
    entered_by: str | None
    source_id: str
    raw_item_name: str | None = None


@dataclass(frozen=True)
class OrderLine:
    item_id: str
    quantity: float
    quantity_received: float | None


@dataclass(frozen=True)
class Order:
    supplier: str
    lines: tuple[OrderLine, ...]
    placed_at: datetime
    cutoff_at: datetime | None
    met_cutoff: bool
    expected_arrival: date | None
    actual_arrival: date | None
    order_id: str = ""


@dataclass(frozen=True)
class Recommendation:
    """One recommended line. ``reorder.engine`` fills it. The owner still sets the final quantity."""

    supplier: str
    cutoff: datetime | None
    delivery_date: date | None
    window_end: date | None
    item: str
    forecast_for_window: float | None
    sigma_for_window: float | None
    estimated_on_hand: float | None
    confidence: str | None
    target_level: float | None
    order_up_to_level: float | None
    recommended_quantity: float | None
    alternative_deal_quantity: float | None
    why_line: str
    late_order_flag: bool
    owner_final_quantity: float | None = None
    override_reason: str | None = None


@dataclass(frozen=True)
class UnmatchedItem:
    raw_name: str
    source_id: str
    suggested_item_id: str | None
    reason: str


@dataclass(frozen=True)
class StockoutNote:
    """A stockout a person wrote down. This is not the evaluation stockout list."""

    business_date: date
    raw_item_name: str
    item_id: str | None
    source_id: str
    note: str


@dataclass
class QualityReport:
    duplicate_rows: int = 0
    missing_business_days: list[date] = field(default_factory=list)
    void_rows: int = 0
    unknown_void_rows: int = 0
    comp_rows: int = 0
    unknown_comp_rows: int = 0
    refund_rows: int = 0
    unmatched_names: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.duplicate_rows} duplicate rows, "
            f"{len(self.missing_business_days)} missing business days, "
            f"{self.void_rows} rows with voids, {self.unknown_void_rows} rows with unknown voids, "
            f"{self.comp_rows} rows with comps, {self.unknown_comp_rows} rows with unknown comps, "
            f"{self.refund_rows} refunds, "
            f"{len(self.unmatched_names)} unmatched names"
        )


@dataclass
class IngestResult:
    source: DataSource
    sales: list[SalesRecord] = field(default_factory=list)
    inventory_events: list[InventoryEvent] = field(default_factory=list)
    review: list[UnmatchedItem] = field(default_factory=list)
    stockout_notes: list[StockoutNote] = field(default_factory=list)
    void_events: list[VoidEvent] = field(default_factory=list)
    comp_events: list[CompEvent] = field(default_factory=list)
    quality: QualityReport = field(default_factory=QualityReport)
