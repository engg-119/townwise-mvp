"""Phone mockup for the reorder module. Run: python3 -m streamlit run mockup_app.py

The owner approves every order. This screen does not send one.
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st

from reorder.catalog import load_products
from reorder.config import load_config, repo_root
from reorder.engine import expected_shortfalls, extended_window, par_level, products_in_play, recovery_options
from reorder.ingestion.mapping import propose_mapping
from reorder.ingestion.tabular import read_headers
from reorder.mockup_logic import (
    OVERRIDE_REASONS,
    POLICIES,
    build_order,
    edited_reason_needed,
    nav_pages,
    next_cutoff,
    order_text,
    reminder_text,
    rows_from_suppliers,
    schedule_ready,
    text_pdf,
)
from reorder.pricing import (
    OwnerAction,
    load_price_file,
    load_state_rules,
    record_action,
    suggest_prices,
    visible_suggestions,
)

st.set_page_config(page_title="Next order", page_icon="🍺", layout="centered")
st.markdown(
    """
    <style>
      .block-container { max-width: 680px; padding-top: 1rem; }
      div.stButton > button { min-height: 44px; }
      .why { font-size: 1.02rem; line-height: 1.45; margin: 0.2rem 0 0.8rem; }
    </style>
    """,
    unsafe_allow_html=True,
)


def _init() -> None:
    defaults = {
        "rows": [],
        "editor_version": 0,
        "schedule_saved": False,
        "catalog_on": False,
        "bottle": False,
        "cooler": 70,
        "reminder_hours": [24, 2],
        "counts": {},
        "last_count": None,
        "quantities": {},
        "reasons": {},
        "approved": False,
        "placed_at": None,
        "received": {},
        "sources": [
            {
                "name": "Clean daily sales",
                "uploaded": "2026-11-04",
                "matched": "Menu names matched the catalog",
                "warning": "",
            },
            {
                "name": "Square item sales, October 2025",
                "uploaded": "2025-10-31",
                "matched": "Same items as the Toast file after the comps report is joined",
                "warning": "Voids stay unknown until the comps and voids report is uploaded",
            },
        ],
        "events": [{"day": "2026-11-07", "name": "Homecoming", "cancelled": False}],
        "bookings": [],
        "price_actions": [],
        "missed": False,
        "bought": [],
        "clock": datetime.now().replace(second=0, microsecond=0),
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


def _config():
    return load_config()


def _products():
    if not st.session_state.catalog_on:
        return []
    config = _config()
    return load_products(config.resolve("synthetic_root") / "reference" / "products.csv")


def _saved_rows() -> list[dict[str, str]]:
    if not st.session_state.schedule_saved:
        return []
    return st.session_state.rows


def _order():
    products = _products()
    if not products:
        return []
    notes = {}
    for event in st.session_state.events:
        if not event["cancelled"] and event["day"] == "2026-11-07":
            notes["P001"] = f"{event['name']} Saturday"
    return build_order(
        products,
        _saved_rows(),
        as_of=st.session_state.clock.date(),
        targets=_config().targets,
        on_hand=st.session_state.counts,
        last_count=st.session_state.last_count,
        bottle_service=st.session_state.bottle,
        cooler_cases=float(st.session_state.cooler) if st.session_state.cooler else None,
        event_notes=notes,
    )


def _screen_next() -> None:
    st.header("Next order")
    st.caption("You approve this. Nothing is sent to a distributor.")
    if not st.session_state.schedule_saved or not schedule_ready(st.session_state.rows):
        st.warning(
            "Add each supplier's delivery day, cutoff, and what happens if the order is late. "
            "Recommendations stay off until that schedule is saved."
        )
        if st.button("Go to onboarding"):
            st.session_state.page = "Onboarding"
            st.rerun()
        return
    found = next_cutoff(st.session_state.rows, st.session_state.clock)
    if found:
        cutoff, row = found
        hours = (cutoff - st.session_state.clock).total_seconds() / 3600
        st.subheader(f"{row['supplier_id']} cutoff {cutoff:%a %b %d, %I:%M %p}")
        st.write(f"About {hours:.1f} hours from the preview clock.")
        note = reminder_text(st.session_state.clock, cutoff, st.session_state.reminder_hours)
        if note:
            st.info(note)
    if not st.session_state.catalog_on:
        st.info("Load the product catalog on the onboarding screen to see lines.")
        return
    lines = _order()
    if not lines:
        st.write("No distributor lines for this cutoff. Liquor is on the liquor run screen.")
        return
    quantities = dict(st.session_state.quantities)
    for line in lines:
        quantities.setdefault(line.item_id, line.recommended)
        st.markdown(f"**{line.name}**  ·  {line.supplier}")
        if line.never_run_out:
            st.caption("Never run out")
        owner_qty = st.number_input(
            f"Order ({line.unit})",
            min_value=0.0,
            step=0.5,
            value=float(quantities[line.item_id]),
            key=f"qty-{line.item_id}",
        )
        quantities[line.item_id] = owner_qty
        st.write(
            f"Forecast {line.forecast:g} {line.unit} · on hand {line.on_hand:g} · "
            f"{line.confidence} confidence · target {line.target:.0%} · "
            f"other deal {line.alternative:g} {line.unit}"
        )
        st.markdown(f"<p class='why'>{line.why}</p>", unsafe_allow_html=True)
        if edited_reason_needed(line.recommended, owner_qty):
            st.session_state.reasons[line.item_id] = st.selectbox(
                "Why is this different from the recommendation?",
                OVERRIDE_REASONS,
                key=f"why-{line.item_id}",
            )
    st.session_state.quantities = quantities
    when = st.session_state.clock
    text = order_text(lines, quantities, when)
    left, right = st.columns(2)
    left.download_button("Export text", text, file_name="order.txt")
    right.download_button("Export PDF", text_pdf(text), file_name="order.pdf", mime="application/pdf")
    if st.button("Approve"):
        st.session_state.approved = True
    if st.session_state.approved:
        st.success("Approved. You can mark it placed when it goes to the rep.")
    if st.session_state.approved and st.button("Mark as placed"):
        st.session_state.placed_at = when
    if st.session_state.placed_at:
        st.write(f"Placed {st.session_state.placed_at:%Y-%m-%d %H:%M}.")


def _screen_onboarding() -> None:
    st.header("Onboarding")
    st.write("The delivery schedule and each supplier's late-order policy come first.")
    if st.button("Fill Sawtooth's synthetic schedule"):
        st.session_state.rows = rows_from_suppliers(_config().raw["suppliers"])
        st.session_state.editor_version += 1
        st.rerun()
    frame = pd.DataFrame(
        st.session_state.rows
        or [{"supplier_id": "", "delivery_day": "", "cutoff_day": "", "cutoff_time": "", "late_policy": ""}]
    )
    edited = st.data_editor(
        frame,
        num_rows="dynamic",
        key=f"schedule-{st.session_state.editor_version}",
        column_config={
            "supplier_id": "Supplier",
            "delivery_day": st.column_config.SelectboxColumn(
                "Delivery", options=["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "pickup"]
            ),
            "cutoff_day": st.column_config.SelectboxColumn(
                "Cutoff day", options=["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            ),
            "cutoff_time": "Cutoff time",
            "late_policy": st.column_config.SelectboxColumn("If the order is late", options=["", *POLICIES]),
        },
    )
    records = edited.fillna("").astype(str).to_dict("records")
    if st.button("Save schedule"):
        st.session_state.rows = records
        st.session_state.schedule_saved = schedule_ready(records)
        if st.session_state.schedule_saved:
            st.success("Schedule saved. Recommendations can turn on.")
        else:
            st.error("Each delivering supplier needs a day, a cutoff, and a late-order policy.")
    st.subheader("Reminders")
    first, second = st.columns(2)
    hours_a = first.number_input("First reminder, hours before cutoff", min_value=1, value=int(st.session_state.reminder_hours[0]))
    hours_b = second.number_input("Second reminder, hours before cutoff", min_value=1, value=int(st.session_state.reminder_hours[-1]))
    st.session_state.reminder_hours = [int(hours_a), int(hours_b)]
    st.subheader("Catalog, storage, bottle service")
    st.caption("Recipes can be skipped for this mockup. Cocktail liquor stays a rough bottle estimate until they are added.")
    if st.button("Load the synthetic catalog"):
        st.session_state.catalog_on = True
        st.success(f"Loaded {len(_products())} products from the synthetic catalog.")
    st.session_state.cooler = st.number_input("Cooler capacity, cases", min_value=0, value=int(st.session_state.cooler))
    st.session_state.bottle = st.toggle("Bottle service", value=st.session_state.bottle)
    st.caption("Optional: enter today's count on the Quick count screen.")


def _screen_sources() -> None:
    st.header("Data sources")
    kept = []
    removed = False
    for index, source in enumerate(st.session_state.sources):
        st.markdown(f"**{source['name']}**")
        st.write(f"Last upload {source['uploaded']}. {source['matched']}")
        if source["warning"]:
            st.warning(source["warning"])
        if st.button("Remove", key=f"remove-source-{index}"):
            removed = True
            continue
        kept.append(source)
    if removed:
        st.session_state.sources = kept
        st.rerun()
    upload = st.file_uploader("Upload a sales file", type=["csv", "xlsx"])
    if upload is None:
        return
    folder = Path(st.session_state.get("upload_dir", "/tmp/sawtooth-uploads"))
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / upload.name
    path.write_bytes(upload.getvalue())
    try:
        headers = read_headers(path)
        vendor, mapping = propose_mapping(headers)
    except ValueError as exc:
        st.error(str(exc))
        return
    st.write(f"Suggested mapping{f' ({vendor})' if vendor else ''}. Confirm it before this file is used.")
    st.write(
        f"Date: {mapping.business_date}. Item: {mapping.item_name}. Quantity: {mapping.quantity}."
    )
    if st.button("Confirm mapping"):
        mapping.confirm()
        st.session_state.sources.append(
            {
                "name": upload.name,
                "uploaded": st.session_state.clock.date().isoformat(),
                "matched": "Mapping confirmed. Unmatched item names wait on the review list.",
                "warning": "" if mapping.voids else "This file has no void column. Voids stay unknown.",
            }
        )
        st.success("Confirmed. The file is a connected source.")


def _screen_late() -> None:
    st.header("Late order recovery")
    st.session_state.missed = st.toggle(
        "The Thursday cutoff was missed and the order moves to Monday",
        value=st.session_state.missed,
    )
    shorts = [
        item
        for item, received in st.session_state.received.items()
        if received < st.session_state.quantities.get(item, received)
    ]
    if not st.session_state.missed and not shorts:
        st.write("No missed cutoff and no short delivery.")
        return
    if st.session_state.missed:
        start, end = extended_window(date(2026, 11, 5), ["Mon", "Thu"])
        st.write(f"Stock has to last from {start:%A %b %d} through {end:%A %b %d}. The next order is larger because the window is longer.")
        corona = st.session_state.counts.get("P001", 0)
        for note in expected_shortfalls("Corona", corona, 2, start, end):
            st.warning(note)
        policy = "moved_to_next_delivery"
        for row in st.session_state.rows:
            if row.get("supplier_id") == "SUP_A" and row.get("delivery_day") == "Thu":
                policy = row.get("late_policy") or policy
        st.subheader("Recovery, cheapest first")
        for option in recovery_options(policy, category="bottles_cans", substitutes=("P006",)):
            st.write("• " + option)
        st.caption("Call or message the rep from your phone. This screen does not place the order.")
    if shorts:
        st.subheader("Short delivery")
        st.write("Only what arrived is in stock. The missing amount is treated like a late order.")
        for item in shorts:
            ordered = st.session_state.quantities.get(item, 0)
            st.write(f"{item}: ordered {ordered:g}, received {st.session_state.received[item]:g}.")


def _screen_count() -> None:
    st.header("Quick count")
    st.write("A few key items. Whole or half units. Submitting resets the estimate.")
    products = products_in_play(_products(), bottle_service=st.session_state.bottle)
    key_items = [product for product in products if product.never_run_out][:8]
    if not key_items:
        st.info("Load the catalog on the onboarding screen first.")
        return
    if st.button("Use a practice count"):
        practice = {}
        for product in key_items:
            par = par_level(product.par_minimum, "Thu") or par_level(product.par_minimum) or 2
            practice[product.item_id] = max(0.5, round(par / 2 * 2) / 2)
        st.session_state.counts.update(practice)
        st.rerun()
    for product in key_items:
        name = product.names_by_source.get("catalog", product.item_id)
        current = float(st.session_state.counts.get(product.item_id, 0))
        label, minus, value, plus = st.columns([4, 1, 2, 1])
        label.write(name)
        if minus.button("−", key=f"minus-{product.item_id}"):
            st.session_state.counts[product.item_id] = max(0, current - 0.5)
            st.rerun()
        value.write(f"{current:g}")
        if plus.button("+", key=f"plus-{product.item_id}"):
            st.session_state.counts[product.item_id] = current + 0.5
            st.rerun()
    if st.button("Submit count"):
        st.session_state.last_count = st.session_state.clock.date()
        st.success("Count saved. The next order uses this stock and high confidence.")


def _screen_receive() -> None:
    st.header("Receive delivery")
    lines = _order()
    if not lines:
        st.write("Approve a schedule and load the catalog to compare an order with what arrived.")
        return
    for line in lines:
        ordered = st.session_state.quantities.get(line.item_id, line.recommended)
        received = st.number_input(
            f"{line.name} arrived ({line.unit}), ordered {ordered:g}",
            min_value=0.0,
            value=float(st.session_state.received.get(line.item_id, ordered)),
            step=0.5,
            key=f"recv-{line.item_id}",
        )
        st.session_state.received[line.item_id] = received
        if received + 1e-9 < ordered:
            st.warning(f"Short by {ordered - received:g} {line.unit}.")
    if st.button("Confirm delivery"):
        st.success("Received quantities are the ones added to stock.")


def _screen_week() -> None:
    st.header("Week ahead")
    start = st.session_state.clock.date()
    deliveries = {
        str(row.get("delivery_day", ""))[:3]
        for row in st.session_state.rows
        if row.get("delivery_day") and row.get("delivery_day") != "pickup"
    }
    cutoffs = {str(row.get("cutoff_day", ""))[:3] for row in st.session_state.rows if row.get("cutoff_day")}
    for offset in range(14):
        day = start + timedelta(days=offset)
        bits = [day.strftime("%A %b %d")]
        if day.strftime("%a") in deliveries:
            bits.append("delivery")
        if day.strftime("%a") in cutoffs:
            bits.append("cutoff")
        if day.strftime("%a") in {"Fri", "Sat"}:
            bits.append("late night")
        names = [
            event["name"] + (" (cancelled)" if event["cancelled"] else "")
            for event in st.session_state.events
            if event["day"] == day.isoformat()
        ]
        st.write(" · ".join(bits + names))
    with st.form("event"):
        name = st.text_input("Private event")
        when = st.date_input("Date", value=start)
        if st.form_submit_button("Add event"):
            st.session_state.events.append({"day": when.isoformat(), "name": name or "Private event", "cancelled": False})
            st.rerun()
    for index, event in enumerate(st.session_state.events):
        if event["cancelled"]:
            continue
        if st.button(f"Cancel {event['name']} on {event['day']}", key=f"cancel-event-{index}"):
            event["cancelled"] = True
            st.rerun()


def _screen_liquor() -> None:
    st.header("Liquor run")
    st.caption("Buy these at the state store. Checking one off logs a delivery.")
    products = [product for product in _products() if product.category == "liquor"]
    if not products:
        st.info("Load the catalog to see the state-store list.")
        return
    for product in products:
        if product.item_id in st.session_state.bought:
            continue
        par = par_level(product.par_minimum) or 0
        hand = st.session_state.counts.get(product.item_id, 0)
        if hand >= par and par:
            continue
        name = product.names_by_source.get("catalog", product.item_id)
        buy = max(par - hand, 1)
        if st.checkbox(f"{name}: buy {buy:g} bottles (on hand {hand:g})", key=f"buy-{product.item_id}"):
            st.session_state.bought.append(product.item_id)
            st.session_state.counts[product.item_id] = hand + buy
            st.success("Logged as a state-store delivery.")
            st.rerun()


def _screen_bottle() -> None:
    st.header("Bottle service")
    if not st.session_state.bottle:
        st.write("Bottle service is off, so this screen is hidden from the menu.")
        return
    st.write("Booked tables and the stock set aside for them.")
    with st.form("booking"):
        table = st.text_input("Table")
        package = st.text_input("Package", value="Premium vodka")
        bottles = st.number_input("Bottles set aside", min_value=1, value=1)
        if st.form_submit_button("Add booking"):
            st.session_state.bookings.append(
                {"table": table or "Table", "package": package, "bottles": int(bottles), "cancelled": False}
            )
            st.rerun()
    for index, booking in enumerate(st.session_state.bookings):
        if booking["cancelled"]:
            continue
        st.write(f"{booking['table']}: {booking['package']}, {booking['bottles']} set aside")
        if st.button("Cancel booking", key=f"cancel-booking-{index}"):
            booking["cancelled"] = True
            st.rerun()


def _screen_savings() -> None:
    st.header("Savings ideas")
    st.caption("Advisory only. You accept, dismiss, or ask to be reminded later.")
    products = _products()
    if not products:
        st.info("Load the catalog to compare deal prices.")
        return
    config = _config()
    rules = load_state_rules(config.state_rules, repo_root())
    quotes = load_price_file(config.resolve("price_list"), supplier_channels=config.supplier_channels)
    weekly = {}
    usual = {}
    for product in products:
        par = par_level(product.par_minimum, "Thu") or par_level(product.par_minimum) or 0
        if par:
            weekly[product.item_id] = par
        sizes = config.raw.get("current_par_rules", {}).get("deal_sizes", {}).get(product.item_id)
        if sizes:
            usual[product.item_id] = float(sizes[0])
    ideas = visible_suggestions(
        suggest_prices(
            products,
            quotes,
            rules=rules,
            on=st.session_state.clock.date(),
            weekly_units=weekly,
            supplier_channels=config.supplier_channels,
            usual_deals=usual,
            bottle_service=st.session_state.bottle,
        ),
        st.session_state.price_actions,
        st.session_state.clock.date(),
        hide_days=rules.dismissal_hide_days,
    )
    if not ideas:
        st.write("No idea to show. Dismissed ones stay hidden for 30 days.")
        return
    for idea in ideas[:8]:
        st.markdown(f"**{idea.current_label}**")
        st.write(f"Now ${idea.current_cost_per_serving:.2f} per serving.")
        st.write(f"Alternative: {idea.alternative_label}, ${idea.alternative_cost_per_serving:.2f} per serving.")
        st.write(f"About ${idea.savings_per_week:.0f} a week. {idea.tradeoff}")
        st.write(f"{idea.legal_channel}. {idea.price_source}, {idea.price_date.isoformat()}.")
        if idea.stale:
            st.warning("This price is older than 30 days.")
        accept, dismiss, later = st.columns(3)
        if accept.button("Accept", key=f"acc-{idea.suggestion_id}"):
            st.session_state.price_actions = record_action(
                st.session_state.price_actions,
                OwnerAction(idea.suggestion_id, "accept", st.session_state.clock.date()),
            )
        if dismiss.button("Dismiss", key=f"dis-{idea.suggestion_id}"):
            st.session_state.price_actions = record_action(
                st.session_state.price_actions,
                OwnerAction(idea.suggestion_id, "dismiss", st.session_state.clock.date()),
            )
            st.rerun()
        if later.button("Remind me later", key=f"lat-{idea.suggestion_id}"):
            st.session_state.price_actions = record_action(
                st.session_state.price_actions,
                OwnerAction(idea.suggestion_id, "remind_later", st.session_state.clock.date()),
            )
            st.rerun()


def _screen_progress() -> None:
    st.header("How it's doing")
    st.caption("For the owner only. Do not send this to staff.")
    report = ROOT / "reports" / "backtest.md"
    if report.is_file():
        st.markdown(report.read_text())
    else:
        st.write("The replay has not been written to reports/backtest.md yet.")
    st.write(
        "The count review already separates known waste (comps and voids marked as waste) "
        "from unexplained loss. A late Friday and Saturday void pattern, when one shows up, "
        "is worded as a pattern to review, not a conclusion."
    )


def main() -> None:
    _init()
    pages = nav_pages(st.session_state.bottle)
    if st.session_state.get("page") not in pages:
        st.session_state.page = pages[0]
    choice = st.sidebar.radio("Screens", pages, index=pages.index(st.session_state.page))
    st.session_state.page = choice
    with st.sidebar.expander("Preview clock"):
        day = st.date_input("Date", value=st.session_state.clock.date(), key="clock-day")
        clock_time = st.time_input("Time", value=st.session_state.clock.time(), key="clock-time")
        st.session_state.clock = datetime.combine(day, clock_time)
    screens = {
        "Next order": _screen_next,
        "Onboarding": _screen_onboarding,
        "Data sources": _screen_sources,
        "Late order recovery": _screen_late,
        "Quick count": _screen_count,
        "Receive delivery": _screen_receive,
        "Week ahead": _screen_week,
        "Liquor run": _screen_liquor,
        "Bottle service": _screen_bottle,
        "Savings ideas": _screen_savings,
        "How it's doing": _screen_progress,
    }
    screens[choice]()


main()
