"""Phase 4: legal deal and substitute suggestions. Prices come from uploaded files."""

from datetime import date

import pytest

from reorder.catalog import load_products
from reorder.config import load_config, repo_root
from reorder.contracts import DealTier, Product
from reorder.pricing import (
    OwnerAction,
    PriceLookup,
    PriceQuote,
    load_actions,
    load_price_file,
    load_state_rules,
    record_action,
    save_actions,
    suggest_prices,
    visible_suggestions,
)


def _beer(item_id: str, name: str, supplier: str = "SUP_A", substitutes: tuple[str, ...] = ()) -> Product:
    return Product(
        item_id=item_id,
        names_by_source={"catalog": name},
        category="bottles_cans",
        supplier=supplier,
        purchase_unit="case_24",
        servings_per_unit=24,
        cost_per_unit=40,
        deal_tiers=(DealTier(3, 42), DealTier(9, 39)),
        shelf_life_days=180,
        substitutes=substitutes,
        never_run_out=False,
        par_minimum="",
    )


def _quote(
    item_id: str,
    min_qty: float,
    price: float,
    *,
    supplier: str = "SUP_A",
    channel: str = "licensed_distributor",
    source: str = "rep price sheet",
    on: date = date(2026, 11, 1),
    promotion: bool = False,
    expires: date | None = None,
) -> PriceQuote:
    return PriceQuote(
        item_id=item_id,
        supplier=supplier,
        min_qty=min_qty,
        price_per_unit=price,
        source=source,
        effective_date=on,
        channel=channel,
        promotion=promotion,
        expires=expires,
    )


def test_larger_deal_is_suggested_only_when_leftovers_still_save_money() -> None:
    rules = load_state_rules("nh", repo_root())
    product = _beer("P005", "High Noon")
    quotes = [_quote("P005", 3, 42), _quote("P005", 9, 39)]
    worth_it = suggest_prices(
        [product],
        quotes,
        rules=rules,
        on=date(2026, 11, 5),
        weekly_units={"P005": 6},
        supplier_channels={"SUP_A": "licensed_distributor"},
        usual_deals={"P005": 3},
    )
    deals = [row for row in worth_it if row.kind == "deal_size"]
    assert len(deals) == 1
    assert deals[0].current_label == "High Noon, 3-case deal"
    assert deals[0].alternative_label == "High Noon, 9-case deal"
    assert deals[0].alternative_cost_per_serving < deals[0].current_cost_per_serving
    assert deals[0].savings_per_week > 0
    assert deals[0].legal_channel == "Current beer distributor"
    assert deals[0].price_source == "rep price sheet"
    assert deals[0].price_date == date(2026, 11, 1)
    assert deals[0].stale is False
    assert "cooler" in deals[0].tradeoff.lower()

    slow_week = suggest_prices(
        [product],
        quotes,
        rules=rules,
        on=date(2026, 11, 5),
        weekly_units={"P005": 1},
        supplier_channels={"SUP_A": "licensed_distributor"},
        usual_deals={"P005": 3},
    )
    assert [row for row in slow_week if row.kind == "deal_size"] == []


def test_illegal_channels_and_a_second_distributor_are_never_suggested() -> None:
    rules = load_state_rules("nh", repo_root())
    corona = _beer("P001", "Corona Extra", substitutes=("P002",))
    bud = _beer("P002", "Bud Light")
    quotes = [
        _quote("P001", 6, 27.43),
        _quote("P002", 5, 22.77),
        _quote("P001", 1, 10, supplier="SUP_B", channel="licensed_distributor", source="other distributor"),
        _quote("P001", 1, 8, supplier="SUP_A", channel="warehouse_club", source="warehouse club"),
        _quote("P001", 1, 9, supplier="CLUB", channel="retail", source="grocery store"),
    ]

    class ClubLookup(PriceLookup):
        def quotes_for(self, item_id: str, on: date) -> list[PriceQuote]:
            if item_id == "P001":
                return [_quote("P001", 1, 5, supplier="COSTCO", channel="warehouse_club", source="web")]
            return []

    rows = suggest_prices(
        [corona, bud],
        quotes,
        rules=rules,
        on=date(2026, 11, 5),
        weekly_units={"P001": 10, "P002": 4},
        supplier_channels={"SUP_A": "licensed_distributor", "SUP_B": "licensed_distributor"},
        web=ClubLookup(),
    )
    text = " ".join(f"{row.legal_channel} {row.price_source} {row.alternative_label}" for row in rows).lower()
    assert "warehouse" not in text
    assert "grocery" not in text
    assert "other distributor" not in text
    assert "web" not in text
    substitutes = [row for row in rows if row.kind == "substitute" and row.item_id == "P001"]
    assert substitutes
    assert substitutes[0].alternative_label == "Bud Light"
    assert substitutes[0].legal_channel == "Current beer distributor"


def test_a_state_with_no_rules_file_only_suggests_current_deals() -> None:
    missing = load_state_rules("vt", repo_root())
    assert missing.present is False
    product = _beer("P005", "High Noon", substitutes=("P006",))
    other = _beer("P006", "White Claw")
    rows = suggest_prices(
        [product, other],
        [
            _quote("P005", 3, 42),
            _quote("P005", 9, 39),
            _quote("P006", 3, 10),
        ],
        rules=missing,
        on=date(2026, 11, 5),
        weekly_units={"P005": 6, "P006": 4},
        supplier_channels={"SUP_A": "licensed_distributor"},
        usual_deals={"P005": 3},
    )
    assert rows
    assert {row.kind for row in rows} == {"deal_size"}
    assert all(row.legal_channel == "Current supplier" for row in rows)


def test_old_prices_are_marked_stale_and_a_dismissal_hides_for_30_days(tmp_path) -> None:
    rules = load_state_rules("nh", repo_root())
    product = _beer("P005", "High Noon")
    quote = _quote("P005", 9, 39, on=date(2026, 1, 1))
    current = _quote("P005", 3, 42, on=date(2026, 1, 1))
    fresh = suggest_prices(
        [product],
        [current, quote],
        rules=rules,
        on=date(2026, 1, 20),
        weekly_units={"P005": 6},
        supplier_channels={"SUP_A": "licensed_distributor"},
        usual_deals={"P005": 3},
    )
    assert fresh[0].stale is False
    stale = suggest_prices(
        [product],
        [current, quote],
        rules=rules,
        on=date(2026, 3, 1),
        weekly_units={"P005": 6},
        supplier_channels={"SUP_A": "licensed_distributor"},
        usual_deals={"P005": 3},
    )
    assert stale[0].stale is True
    assert stale[0].price_date == date(2026, 1, 1)

    dismissed = record_action(
        [],
        OwnerAction(stale[0].suggestion_id, "dismiss", date(2026, 3, 1), note="not this month"),
    )
    assert visible_suggestions(stale, dismissed, date(2026, 3, 29), hide_days=rules.dismissal_hide_days) == []
    assert visible_suggestions(stale, dismissed, date(2026, 3, 31), hide_days=rules.dismissal_hide_days) == stale
    path = tmp_path / "decisions.json"
    save_actions(path, dismissed)
    assert load_actions(path) == dismissed


def test_liquor_case_discount_stays_at_the_state_store() -> None:
    rules = load_state_rules("nh", repo_root())
    vodka = Product(
        item_id="P201",
        names_by_source={"catalog": "Well vodka"},
        category="liquor",
        supplier="SUP_NHLC",
        purchase_unit="bottle_1.75L",
        servings_per_unit=39.4,
        cost_per_unit=16.99,
        deal_tiers=(),
        shelf_life_days=3650,
        substitutes=(),
        never_run_out=True,
        par_minimum="buy up to 7",
    )
    rows = suggest_prices(
        [vodka],
        [
            _quote("P201", 1, 16.99, supplier="SUP_NHLC", channel="state_liquor_commission"),
            _quote("P201", 6, 14, supplier="SUP_NHLC", channel="state_liquor_commission", source="licensee price list"),
            _quote("P201", 1, 11, supplier="STORE", channel="retail", source="grocery store"),
        ],
        rules=rules,
        on=date(2026, 11, 5),
        weekly_units={"P201": 2},
        supplier_channels={"SUP_NHLC": "state_liquor_commission"},
    )
    assert len(rows) == 1
    assert rows[0].legal_channel == "New Hampshire Liquor Commission"
    assert rows[0].price_source == "licensee price list"
    assert "grocery" not in rows[0].price_source


def test_uploaded_sawtooth_sheet_marks_january_prices_stale_in_november() -> None:
    config = load_config()
    if not config.resolve("synthetic_root").is_dir():
        pytest.skip("synthetic data is not in this checkout")
    rules = load_state_rules(config.state_rules, repo_root())
    quotes = load_price_file(config.resolve("price_list"), supplier_channels=config.supplier_channels)
    products = load_products(config.resolve("synthetic_root") / "reference" / "products.csv")
    high_noon = next(product for product in products if product.item_id == "P005")
    fresh = suggest_prices(
        products,
        quotes,
        rules=rules,
        on=date(2026, 1, 15),
        weekly_units={"P005": 6, "P001": 10},
        supplier_channels=config.supplier_channels,
        usual_deals={"P005": 3, "P001": 6},
        bottle_service=False,
    )
    deal = next(row for row in fresh if row.item_id == "P005" and row.kind == "deal_size")
    assert "3-case" in deal.current_label
    assert "9-case" in deal.alternative_label
    assert deal.price_source == "synthetic price sheet"
    assert deal.price_date == date(2026, 1, 1)
    assert deal.stale is False
    assert deal.legal_channel == "Current beer distributor"
    assert high_noon.item_id == "P005"
    november = suggest_prices(
        products,
        quotes,
        rules=rules,
        on=date(2026, 11, 4),
        weekly_units={"P005": 6},
        supplier_channels=config.supplier_channels,
        usual_deals={"P005": 3},
        bottle_service=False,
    )
    assert next(row for row in november if row.item_id == "P005").stale is True
    assert all("P901" not in row.suggestion_id and "P902" not in row.suggestion_id for row in november)
