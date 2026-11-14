"""Column mappings the owner confirms. A preset is only a suggestion."""

from __future__ import annotations

from dataclasses import dataclass, replace

from reorder.contracts import SalesUnit


@dataclass(frozen=True)
class ColumnMapping:
    business_date: str
    item_name: str
    quantity: str
    net_price: str | None = None
    voids: str | None = None
    comps: str | None = None
    refunds: str | None = None
    timestamp: str | None = None
    confirmed: bool = False

    def as_dict(self) -> dict[str, str]:
        raw = {
            "business_date": self.business_date,
            "item_name": self.item_name,
            "quantity": self.quantity,
            "net_price": self.net_price,
            "voids": self.voids,
            "comps": self.comps,
            "refunds": self.refunds,
            "timestamp": self.timestamp,
        }
        return {key: value for key, value in raw.items() if value}

    def confirm(self) -> ColumnMapping:
        return replace(self, confirmed=True)


def toast_product_mix_mapping() -> ColumnMapping:
    return ColumnMapping(
        business_date="Business Date",
        item_name="Menu Item",
        quantity="Item Qty",
        net_price="Net Amount",
        voids="Void Qty",
    )


def square_item_sales_mapping() -> ColumnMapping:
    return ColumnMapping(
        business_date="Date",
        item_name="Item",
        quantity="Qty",
        net_price="Net Sales",
    )


def clean_daily_mapping() -> ColumnMapping:
    return ColumnMapping(
        business_date="business_date",
        item_name="menu_item",
        quantity="qty_sold",
        net_price="net_sales",
        voids="void_qty",
        comps="comp_qty",
    )


_PRESETS: tuple[tuple[str, ColumnMapping], ...] = (
    ("toast", toast_product_mix_mapping()),
    ("square", square_item_sales_mapping()),
    ("clean_daily", clean_daily_mapping()),
)


def propose_mapping(headers: list[str]) -> tuple[str | None, ColumnMapping]:
    """Suggest a preset when every required header is present. The owner still confirms it."""

    present = set(headers)
    for vendor, mapping in _PRESETS:
        required = {mapping.business_date, mapping.item_name, mapping.quantity}
        if required <= present:
            return vendor, mapping
    if len(headers) < 3:
        raise ValueError("a POS export needs date, item, and quantity columns to propose a mapping")
    return None, ColumnMapping(
        business_date=headers[0],
        item_name=headers[1],
        quantity=headers[2],
        confirmed=False,
    )


def detect_sales_unit(headers: list[str], unit_values: list[str]) -> SalesUnit:
    """Drink counts are the POS default. Dollars are called out so someone can confirm them."""

    for value in unit_values:
        text = value.lower()
        if "case" in text:
            return "case"
        if "bottle" in text:
            return "bottle"
    joined = " ".join(headers).lower()
    quantity_headers = ("qty", "quantity", "item qty", "qty_sold")
    if any(header in joined for header in quantity_headers):
        return "drink"
    money_headers = ("net sales", "gross", "amount", "net_sales")
    if any(header in joined for header in money_headers):
        return "dollar"
    return "unknown"
