# Bar Reorder Agent — Build Spec

Nov 5, 2026 · @Katie

## 1. Purpose

The agent turns our existing demand forecast into a recommended order for every drink before each delivery cutoff. It checks stock on hand when the bar provides it, sizes each order to last until the next delivery, rounds to distributor deals, and flags legal, lower-cost alternatives. If an order goes in late or a delivery slips, it recalculates and offers a recovery plan. The owner approves or edits every order; the agent never places one.

**How to use this spec:** export this doc to Markdown and save it in the repo as `docs/REORDER_SPEC.md`. Section 11 is the prompt to paste into the Cursor agent; it points back to Sections 2–10 as the requirements.

**Pilot customer:** Sawtooth (Hanover, NH). Build it so any bar can use it: every Sawtooth number in this spec is a default in a config file, never hard-coded.

| In scope | Out of scope |
| --- | --- |
| Bottles, cans, seltzers, draft kegs, liquor | Placing orders or paying distributors |
| Cocktail ingredients through recipe mappings | Food inventory |
| Bottle service, as an optional module (off by default; off for Sawtooth) | Staffing and scheduling |
| Sales and inventory data from any source: any POS, spreadsheets, invoices, inventory apps, manual entries | Live POS API connections (use file uploads for the mockup; design so they can be added later) |
| Order recommendations per delivery, including recovery from late or missed orders |  |
| Quick stock counts and estimated stock |  |
| Deal and lower-cost substitute suggestions |  |
| Backtest against the bar's current rules |  |

## 2. System overview

The reorder module sits beside the existing forecast model and never changes it. An adapter reads the model's output, and everything downstream works from that adapter's format, so the forecast model can change without breaking the reorder logic.

&#91;embedded content: system architecture · inputs, reorder module, owner\]

Sales and the schedule feed the forecast; counts feed the inventory estimate; the reorder engine combines both, and the advisor adds legal savings ideas before the owner approves.

**Components**

| Component | Job | Spec section |
| --- | --- | --- |
| Data ingestion | Reads sales, inventory, invoice and price data from any source and maps it to the standard contracts below | 3c |
| Forecast model (existing, GitHub) | Daily demand by item, with locality research | Not changed |
| Forecast adapter | Converts model output to the forecast contract; adds error estimates if the model has none | 5b |
| Inventory estimator | Running stock estimate from counts, received deliveries and sales; confidence level | 6 |
| Reorder engine | Exposure windows, order-up-to levels, deal rounding, constraints, event look-ahead, late-order recovery | 4, 5, 8 |
| Deal & substitute advisor | Legal, lower-cost options with sources | 7 |
| Mockup UI | Owner screens | 9 |
| Backtest | Agent vs. current rules on history | 10 |

**Data contracts** (the Cursor agent should define these first)

| Contract | Key fields |
| --- | --- |
| `data_source` | source id, type (POS export, spreadsheet, invoice, inventory app, manual), vendor if known, file format, confirmed column mapping, business-day cutoff hour, time zone |
| `sales_record` | source id, business date, timestamp if available, item id (after mapping), raw item name, quantity, unit (drink, bottle, case), net price, flags for voids, comps and refunds |
| `supplier_schedule` | supplier, products or categories, delivery weekday, order cutoff weekday + time, lead time, minimum order, how ordered, late-order policy (next delivery, accepted with fee, refused) |
| `product` | item id, name per source, category (incl. bottle service), supplier, purchase unit, servings per unit, cost per unit, deal tiers (quantity, price), shelf life, substitutes, never-run-out flag, par minimum |
| `forecast` | item id, date, expected servings, uncertainty (σ or low/high quantiles), event flags |
| `inventory_event` | item id, timestamp, type (count, delivery received, adjustment), quantity in purchase units, entered by, source id |
| `order` | supplier, items and quantities, placed at, cutoff it was meant for, met cutoff (yes/no), expected arrival, actual arrival, quantities received |
| `recommendation` | supplier, cutoff, delivery date, window end, item, forecast for window, σ for window, estimated on hand, confidence, target level, order-up-to level, recommended quantity, alternative deal quantity, why line, late-order flag, owner's final quantity, override reason |

## 3. Owner onboarding: what the bar must provide

The agent cannot size an order without the delivery and order schedule, so onboarding asks for it first and blocks recommendations until it is filled in. Everything else has a fallback, and the agent labels its confidence lower when data is missing.

**Onboarding flow** — the agent asks in this order, one short screen or chat step each:

1. Where is the bar, and what are its open hours by day? (Location sets the state purchasing rules and the area the agent researches for events.)
2. Who do you buy from? For each distributor: what they carry, delivery days, the order cutoff for each delivery, and what happens if you order after the cutoff.
3. Do you also buy yourself (e.g., the state liquor store)? How often, and can you go the same day?
4. Upload your sales history in whatever form you have it: a POS export from any system, a spreadsheet, invoices, or notes. The agent maps the columns and asks you to confirm.
5. Confirm the product list: pack size, servings per unit, cost, and deal tiers.
6. What are your current par rules? (e.g., “1 tapped keg + 1 backup”, “at least 10 cases of Corona a week”)
7. Storage and budget limits, and whether you offer bottle service (optional module).
8. Optional: today's stock count, and any private events booked.

### 3a. Delivery and order schedule (required)

One row per distributor per delivery day. This is the template the owner fills in; example rows use Sawtooth's known schedule, with unknowns marked TBD.

| Supplier | Products | Delivery day | Order cutoff (day, time) | Lead time | Minimum order | How ordered | If ordered after cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Beer distributor (TBD) | Corona, seltzers, kegs (TBD) | Monday | TBD | TBD | TBD | Rep / phone / portal | TBD: next delivery, fee, or refused |
| Beer distributor (TBD) | TBD | Tuesday | TBD | TBD | TBD | TBD | TBD |
| Beer distributor (TBD) | TBD | Thursday | TBD | TBD | TBD | TBD | TBD |
| NH Liquor & Wine Outlet | Liquor | Owner pickup, as needed | None | Same or next day | None | Owner or staff run | Not applicable |

Also capture per supplier: how often deliveries arrive late or short, and whether emergency or special orders are possible.

### 3b. Product catalog (required)

| Field | Example | Used for |
| --- | --- | --- |
| Item name exactly as in each data source | Corona Extra 12oz btl | Joining sales to products |
| Category | Bottles & cans / Draft / Liquor / Cocktail ingredient / Bottle service | Choosing the reorder policy (Section 4) |
| Supplier | Beer distributor A | Which schedule applies |
| Purchase unit | Case of 24 / half-barrel keg / 1.75L bottle | Order quantities |
| Servings per purchase unit | 24 bottles; \~140 pints per half-barrel after foam and line loss | Converting drinks sold into units used |
| Cost per purchase unit | $ per case | Margin and deal math |
| Deal tiers | Corona: 6-case deal; High Noon, Sun Cruisers: 3 or 9 | Rounding orders (Section 5) |
| Shelf life | Kegs: freshness window by style | Capping how much to hold |
| Substitutes | Bud Light ↔ Coors Light; well tequila → premium tequila | Stockout cost and suggestions |
| Never-run-out flag | Corona, Guinness | Higher service level |

### 3c. Sales and inventory data, from any source (required)

The agent must work with whatever data a bar has, not only Toast. An ingestion step maps each source into the standard contracts in Section 2, and the owner confirms the mapping once per source.

| Source type | Examples | What the agent takes from it |
| --- | --- | --- |
| POS exports | Toast, Square, Clover, Lightspeed or any other system (CSV, Excel) | Sales by item and day (or hour) |
| Spreadsheets | Owner's inventory sheet, manager's par list | Counts, pars, costs |
| Supplier documents | Invoices, delivery receipts, price sheets, rep emails (PDF, photo, email) | Deliveries received, costs, deal prices, order times |
| Inventory or accounting apps | Exports from any inventory or bookkeeping tool | Counts, usage, costs |
| Manual entries | Quick counts, phone notes, 86'd items, event notes | Counts, stockouts, events |

**What the data needs to cover**

- At least 12–18 months of daily sales by item, so it includes last Halloween, Homecoming and other peak weekends.
- Days an item was 86'd (sold out), if known. Sales on those days understate real demand.
- Menu changes: items added or dropped, and when.

**How ingestion handles messy data**

- **Item matching:** names differ across systems (“Corona Extra 12oz” vs. “CORONA BTL”). The agent suggests matches to the product catalog; anything unmatched goes to a review list.
- **Units:** detects whether a source counts drinks, bottles, cases or dollars, and asks when unsure.
- **Business day:** a night that runs past midnight counts toward the day it opened (configurable cutoff hour, default 4 a.m.).
- **Quality checks:** flags duplicates, missing days, and voids, comps and refunds, and shows a summary before using the data.
- **Little or no history:** start from the owner's pars and the forecast model's locality estimates, marked low confidence, and improve as data arrives.

### 3d. Recipes (required for cocktails)

Ounces of each liquor and mixer per cocktail, including Kieran's specials. Without these, liquor use can only be estimated from bottle counts.

### 3e. Constraints and rules (required, with defaults)

| Setting | Sawtooth default |
| --- | --- |
| Current par rules | 1 tapped keg + 1 backup per draft line; at least 10 cases of Corona in the building per week |
| Cooler capacity | TBD (max cases of bottles and cans) |
| Keg cooler slots and tap lines | TBD |
| Order budget | TBD per week |
| Target in-stock level by category | Set in Section 4; owner can override |

### 3f. Current stock (optional)

A quick count before each order cutoff of the items that matter most: Corona cases, seltzer cases, backup kegs, well liquor bottles. A full inventory is welcome but not required (Section 6).

## 4. Product categories and reorder policies

Each category gets its own policy, because the products are bought, stored and run out in different ways. The category comes from the product catalog (3b).

| Category | Sawtooth examples | How it's bought | Cost of running out | Policy | Default in-stock target |
| --- | --- | --- | --- | --- | --- |
| Bottles, cans, seltzers | Corona, Bud Light, High Noon, White Claw, Sun Cruisers, Citizen Cider | Distributor, Mon/Tue/Thu, case deals | High: Corona is the top seller | Order up to a target level sized for each delivery gap, rounded to deals (Section 5) | 98% for never-run-out items, 95% otherwise |
| Draft kegs | Guinness (most popular), Switchback, Lunch IPA | Distributor | Medium: a tap goes dry, often has a substitute | Keep “1 tapped + 1 backup” by default; recommend a second backup when forecast use before the next delivery is more than 1 keg | 95% |
| Liquor | Well tequila, vodka, rum, whiskey | Owner buys at the state liquor store; same- or next-day restock | Margin loss: pricier substitute poured at the same menu price, plus a store run | Generous buffer of well liquor; reorder when estimated stock drops below forecast use until the next planned store run | 90–95% (owner-tunable) |
| Cocktail ingredients | Mixers, specialty liquors for Kieran's drinks | Varies | Low: guests mostly want any drink | Tracked through recipe mappings; low-priority alerts only | 85–90% |
| Bottle service (optional module) | Off for Sawtooth; for other bars, premium bottles plus mixers and garnish sold as table packages | Liquor from the state or wholesaler; mixers from distributors | High per missed table: large ticket, booked in advance | Plan from reservations plus a small walk-in buffer; set stock for booked tables aside as committed (Section 5b) | 98% for booked tables |

**Rules that apply to every category**

- Never recommend less than the bar's current par rule unless the owner turns that off. The pars are a floor for the mockup, not a target.
- Show items flagged never-run-out (e.g., Corona, Guinness) at the top of every order screen.
- Bottle service is an optional module the owner turns on during onboarding. When it's off (Sawtooth's setting), its products and screens are hidden and its stock isn't set aside.
- Let the owner change any target per item; log the change.

## 5. Reorder math

Each order must cover demand from its order cutoff until the *next* delivery arrives, at the item's in-stock target. With deliveries only on Monday, Tuesday and Thursday, the Thursday order matters most: it has to carry the bar through the weekend.

### 5a. Delivery windows (computed from the schedule in 3a)

| Delivery | Lasts until | Days covered | Weekend inside? |
| --- | --- | --- | --- |
| Monday | Tuesday's delivery | 1 | No |
| Tuesday | Thursday's delivery | 2 | No |
| Thursday | Monday's delivery | 4 | Yes (Fri–Sun) |

The exposure window for an order runs from its **cutoff** to the **arrival of the following delivery**. If the Thursday order is due Tuesday at noon, the window is Tuesday noon to Monday's arrival. Compute windows from the owner's schedule; never assume these three days.

### 5b. Order-up-to level and order quantity

```latex
S = \mu_W + z \cdot \sigma_W
```

- μ\_W = forecast demand over the exposure window W, summed from the forecast model's daily output and converted to purchase units.
- σ\_W = forecast error over that window. Measure it from the model's past errors on window totals, not single days (Section 10). If the forecast model outputs quantiles, use the quantile at the target level directly instead.
- z = from the in-stock target (95% → 1.65; 98% → 2.05).

```latex
Q = \max(0,\ S - IP), \quad IP = \text{on hand} + \text{on order} - \text{committed}
```

- On hand comes from Section 6 (latest count or running estimate).
- On order = placed but not yet delivered. Committed = stock set aside for booked private events or bottle-service tables.
- Apply the par floor from 3e: Q is at least enough to reach the par level.

### 5c. Converting drinks sold into units to order

```latex
\text{units} = \frac{\text{servings forecast}}{\text{servings per unit} \times (1 - \text{loss rate})}
```

Loss rate covers foam, line loss, spills, comps and over-pours. Start it at a per-category default the owner can edit, then estimate it from counts vs. sales (Section 6).

### 5d. Rounding to deals

Distributors sell in deals (Corona in 6s; High Noon and Sun Cruisers in 3s or 9s). For each item, compare the deal multiple just below Q and the one just above it, and recommend the lower total of:

- purchase cost at that deal's price,
- holding cost of leftover units (cash tied up, cooler space),
- expected cost of running short.

Show both options and the difference so the owner can choose.

### 5e. Constraints, checked last

- **Cooler and keg space:** cap the order at free capacity; if items compete for space, cut the lowest-margin, most substitutable items first.
- **Freshness:** never hold more draft or cider than sells within its freshness window.
- **Budget:** if the order exceeds the weekly budget, trim in the same priority order and say what was cut.

### 5f. Setting the in-stock target

The target comes from the newsvendor critical ratio: how costly a shortage is compared with a leftover unit.

```latex
\text{target} = \frac{C_u}{C_u + C_o}
```

- C\_u (cost of one unit short): lost margin; less if guests switch to a substitute. For liquor: (premium cost per pour − well cost per pour) × pours substituted, plus the cost of a store run.
- C\_o (cost of one unit left over): holding cost until next order, plus spoilage risk for draft and cider.

### 5g. Worked example (illustrative numbers, not Sawtooth data)

Corona, Thursday delivery, 98% target. Forecast for the window = 14 cases, error σ = 3 cases, so S = 14 + 2.05 × 3 ≈ 20.2 cases. Estimated stock at cutoff = 5 cases, nothing on order, so Q ≈ 15.2 cases. Deal options: 12 cases (ends at 17, below S) or 18 cases (ends at 23). Recommend 18 if cooler space allows; otherwise 12 with a shortage warning.

### 5h. Late or missed orders

When an order misses its cutoff, or a delivery arrives late or short, the agent recalculates from the delivery that will actually arrive instead of keeping the original plan.

**Prevent it first:** remind the owner before each cutoff (default 24 hours and 2 hours before, adjustable), with the recommended order ready to approve.

**When it happens:**

1. **Detect.** Compare the order's placed time with its cutoff. Compare what arrived (from the delivery receipt, invoice or a staff check-in) with what was ordered.
2. **Apply the supplier's late-order policy** from 3a: moved to the next delivery, accepted with a fee, or refused.
3. **Recompute the window.** Current stock now has to last until the delivery that will actually come. Example: if the Thursday order misses its cutoff and moves to Monday, current stock must cover Thursday through Monday, the bar's busiest stretch, with no restock.
4. **Show the expected shortfall:** which items are likely to run out, and on which night.
5. **Offer a recovery plan, cheapest first:**
   - ask the distributor for a late add-on or special delivery, if their policy allows it;
   - for liquor, add the items to the next state-store run;
   - lean on in-stock substitutes (e.g., feature seltzers if Corona will run short);
   - pause specials that use a short item;
   - add the shortfall to the next order, sized for the longer window.
6. **Log it** with the reason. Repeated late orders to the same supplier trigger earlier reminders.

Short deliveries work the same way: only quantities actually received are added to stock (Section 6), and the missing amount is treated as a late order.

## 6. Inventory: quick counts plus a running estimate

The bar should never have to do a full inventory for the agent to work. Kieran's full spreadsheet count takes too long, and the former manager tracked stock from quick checks and phone notes. So the agent keeps a running estimate and asks for a 2-minute count of a few key items before each order cutoff.

**Running estimate per item, updated daily:**

```latex
\text{estimate}_t = \text{last count} + \text{deliveries since} - \frac{\text{servings sold since (sales data)}}{\text{servings per unit} \times (1 - \text{loss rate})}
```

**Quick count (before each cutoff):** a phone form with only the key items, e.g., Corona cases, seltzer cases, backup kegs per line, well liquor bottles. Staff enter whole or half units. Each count resets the estimate. Deliveries are added when received, not when ordered, so a late or short delivery shows up right away.

**Loss rate learning:** each count is compared with the estimate. A steady gap updates that item's loss rate; a sudden large gap is flagged for the owner (possible miscount, theft, or a missed delivery).

**Confidence levels shown on every recommendation:**

| Level | When | What the agent does |
| --- | --- | --- |
| High | Counted within 2 days | Full recommendation |
| Medium | Estimate only, last count 3–7 days ago | Recommendation with a “count these 3 items” prompt |
| Low | No count, or last count over 7 days ago | Falls back to par-level ordering and says so |

**Stockout detection:** if an item's estimate hits zero or the sales data shows no sales on a normally busy day, mark it a likely stockout. Those days are excluded or adjusted when the forecast is trained, so the model doesn't learn to under-order.

## 7. Price and deal recommendations

The agent asks where the bar usually buys, then suggests legal ways to pay less per pour. In New Hampshire that mostly means better deal sizes and cheaper substitutes, not the same brand from a different seller. Suggestions are advisory only; the owner decides.

### 7a. New Hampshire purchasing rules the agent must follow

| Rule | What it means for the agent | Source |
| --- | --- | --- |
| Beer and cider must be bought from licensed wholesale distributors, manufacturers or brew pubs | Never suggest retail stores or warehouse clubs for beer, cider or seltzer | [RSA 179:32, III](https://www.gencourt.state.nh.us/rsa/html/XIII/179/179-32.htm) |
| Each beer brand goes to only one distributor per territory | Price-shopping the same brand across distributors won't work; compare deals and substitutes instead | [RSA 180:9](https://law.justia.com/codes/new-hampshire/2017/title-xiii/chapter-180/section-180-9/) |
| Liquor and wine are bought from the state Liquor Commission (or as law allows) | Liquor prices come from the state; look for licensee case-lot discounts | [RSA 179:32, I](https://www.gencourt.state.nh.us/rsa/html/XIII/179/179-32.htm), [RSA 178:28](https://law.justia.com/codes/new-hampshire/2022/title-xiii/title-178/section-178-28/) |

Store these rules in a per-state config. For a bar outside New Hampshire, the agent must load that state's rules before suggesting any source; if it has none, it suggests only deal sizes from the bar's current suppliers. The team should confirm these rules with the owner; this spec is not legal advice.

### 7b. What the agent looks for

1. **Deal sizes from current suppliers:** e.g., is the 9-case High Noon deal cheaper per can than 3, once leftover stock is counted? Uses deal tiers from 3b.
2. **Lower-cost substitutes:** a comparable product from any licensed distributor serving the bar's area (e.g., a different light lager or cider) with a lower cost per serving.
3. **State liquor pricing:** licensee discounts on case lots, and lower-cost well liquor of similar quality.
4. **Distributor promotions:** time-limited deals from rep emails or price sheets the owner forwards or uploads.

Inputs come from what the owner provides (price sheets, invoices, rep emails) plus public state price listings. Every price shows its source and date; anything older than 30 days is marked stale.

### 7c. What each suggestion shows

| Field | Example |
| --- | --- |
| Current item and cost per serving | High Noon, 3-case deal, $X per can |
| Alternative and cost per serving | High Noon, 9-case deal, $Y per can |
| Estimated savings per week | Based on the forecast, not one order |
| Trade-offs | More cash tied up; uses N more cooler slots |
| Legal channel | Current beer distributor |
| Price source and date | Rep price sheet, 2026-11-01 |
| Owner action | Accept / Dismiss / Remind me later |

Dismissed suggestions are not repeated for 30 days, and each dismissal is logged (Section 10).

## 8. Events and demand spikes

A spike has to be ordered before the last delivery that arrives ahead of it. If Halloween falls on a Saturday, the extra Corona has to be in Thursday's order, and possibly Tuesday's if cooler space runs out.

- **Look-ahead:** at every order cutoff, check the forecast for the full exposure window plus the next 14 days. Flag any event that falls before the next two deliveries can cover it.
- **Event source:** the forecast model's locality research (Dartmouth calendar, Homecoming, Winter Carnival, Green Key, Commencement, holidays, town events), plus private events the owner enters.
- **Event size:** calibrate from past sales on the same events, from whatever data source the bar provided, not a fixed multiplier. The former manager over-ordered for Halloween and it was almost entirely used, which suggests real demand ran close to her higher order.
- **Pre-building stock:** bottles and cans keep, so the agent can spread a big event order across Tuesday and Thursday deliveries. Draft and cider are capped by freshness (5e).
- **After the event:** compare the forecast with actual sales and stockouts, and store the error by event type to improve the next one.

## 9. Mockup screens

The home screen is the next order: what to order, from whom, by when, and why. Everything else supports it. The owner works mostly on a phone, often during service, so each screen should work in under a minute.

| Screen | What it shows | Owner actions |
| --- | --- | --- |
| **Onboarding** | The steps in Section 3; delivery schedule and late-order policy first | Fill in, upload sales data in any format, confirm column mapping, turn bottle service on or off, skip optional steps |
| **Data sources** | Each connected source, its last upload, matched vs. unmatched items, quality warnings | Upload new files, fix item matches, remove a source |
| **Next order** (home) | Countdown to the next cutoff; supplier; one row per item: forecast for the window, estimated stock and confidence, target level, recommended deal quantity, the other deal option, one-line reason | Edit any quantity, approve, mark as placed (with time), export the order as text/PDF for the rep |
| **Late order recovery** | Appears when a cutoff is missed or a delivery is late or short: the new arrival date, items likely to run out and when, the recovery options from 5h | Pick options, call or message the rep, update the next order |
| **Quick count** | The 4–8 key items with +/− buttons in whole or half units | Submit in about 2 minutes; estimate resets |
| **Receive delivery** | What was ordered vs. what arrived | Confirm or correct quantities; flags shorts |
| **Week ahead** | Next 14 days: deliveries, cutoffs, events, expected busy nights | Add a private event; mark an event as cancelled |
| **Liquor run list** | Liquor below its reorder level, with bottles to buy at the state store | Check off as bought; logs a delivery |
| **Bottle service** (only if turned on) | Booked tables, packages, and stock set aside for them | Add or cancel bookings |
| **Savings ideas** | Suggestions from Section 7c | Accept, dismiss, remind later |
| **How it's doing** | Backtest and live results from Section 10 | Read only |

**Every recommended quantity has a “why” line in plain words**, e.g., “Thursday covers through Monday. Forecast 14 cases (Homecoming Saturday). You have about 5. Ordering 18 (three 6-case deals) leaves a 98% chance of not running out.”

**Display rules**

- Never-run-out items first, then by order value.
- Show quantities in the units the bar orders in (cases, kegs, bottles), never servings.
- Mark any line where the owner's edit differs from the recommendation; ask for an optional reason (one tap: “event”, “storage”, “price”, “gut feel”, other).

## 10. Validation

The model counts as better only if it beats the bar's current rules on last year's real sales. Replay 12–18 months of the bar's sales data day by day through two policies and compare.

**Policies compared**

1. **Baseline (current rules):** 1 tapped + 1 backup keg; at least 10 cases of Corona a week; reorder bottles and cans to fixed pars; over-order before known events.
2. **Agent policy:** Sections 4–8, using only forecasts that would have been available at each cutoff (no peeking at future data).

**Metrics**

| Metric | What it tells the owner |
| --- | --- |
| Stockout days per item | How often a drink ran out |
| Fill rate (% of demand served) | How much demand was lost |
| Average days of stock on hand | Cash tied up |
| Units wasted (expired draft or cider) | Freshness losses |
| Liquor store runs per month | Staff and owner time |
| Margin lost to premium substitutes | Kieran's main concern |
| Pour cost % | Overall drink cost vs. sales |
| Forecast error on window totals | Feeds σ\_W in Section 5b |

**Acceptance target for the mockup:** fewer stockout days on never-run-out items than the baseline, with no more average stock on hand. Report results per category, not just overall.

**Live logging (after launch):** store every recommendation, the owner's final quantity, the reason for any change, and what actually sold. Review overrides monthly; a pattern of the same override means a setting or the forecast is wrong.

**Stress tests:** replay history with simulated missed cutoffs and late or short deliveries (e.g., every Thursday order moved to Monday) and report the stockouts the recovery plan in 5h prevents. Track late orders per month and their cost as a metric.

## 11. Prompt for the Cursor agent

Paste this into Cursor from the root of the forecast repo, after saving this spec as `docs/REORDER_SPEC.md`.

```markdown
You are adding a reorder-recommendation module and a clickable mockup to this repository. The full requirements are in docs/REORDER_SPEC.md. Read the whole spec before writing code, and follow it over any assumption of your own.

Context: this repo already contains our demand forecasting model for bars (pilot: Sawtooth, Hanover, NH). The new module turns its forecasts into order recommendations for each delivery. It must work for any bar with any data source, not only Toast. The owner always has the final say; the system never places orders.

Work in phases. Stop after each phase, summarize what you did, and wait for our OK.

Phase 1 — Understand the forecast model (no code changes)
- Find the forecast entry point, its inputs, and its output format: granularity (daily? by item?), units (drinks or purchase units?), and whether it returns a point forecast, intervals, or quantiles.
- Note any place the model assumes Toast-specific columns or formats.
- Find any stored backtest errors or residuals.
- Write docs/FORECAST_INTERFACE.md describing this, and list anything Section 2 of the spec needs that the model does not provide.
- Do not modify the forecast model's code.

Phase 2 — Data ingestion, contracts and config
- Create the data contracts in spec Section 2 (data_source, sales_record, supplier_schedule, product, forecast, inventory_event, order, recommendation).
- Build a data ingestion layer with one adapter per source type (spec 3c): POS CSV/Excel exports from any vendor, spreadsheets, supplier invoices and receipts, inventory or accounting app exports, and manual entries. Each adapter maps into sales_record or inventory_event. Include a column-mapping step the owner confirms, item-name matching with a review list for unmatched items, unit detection, a configurable business-day cutoff hour, and data quality checks. Do not hard-code Toast; Toast is just one adapter.
- Build a forecast adapter that converts the model's output into the forecast contract. If the model has no uncertainty output, estimate sigma from its historical errors on window totals (spec 5b).
- Put every Sawtooth-specific value (schedule, late-order policy, pars, deal tiers, targets, bottle service off) in config/sawtooth.yaml, never in code.
- If real sales data isn't in the repo, generate clearly labeled synthetic sample data in two different POS export formats to prove ingestion is source-agnostic. Mimic the patterns in the spec (Corona top seller, Guinness top draft, weekend and Halloween spikes).

Phase 3 — Reorder engine
- Implement spec Sections 4, 5, 6 and 8: exposure windows from the schedule, order-up-to levels, unit conversion, deal rounding, constraints, running inventory estimate with confidence levels, par floors, event look-ahead.
- Bottle service is an optional category behind a config flag (spec Section 4); when off, it is excluded everywhere.
- Implement late and missed orders (spec 5h): detect a missed cutoff or late/short delivery, apply the supplier's late-order policy, recompute the window to the delivery that will actually arrive, list expected shortfalls by item and night, and rank recovery options.
- Each recommendation includes a plain-language 'why' line (spec Section 9).
- Write unit tests: Thursday window covers Fri-Sun; deal rounding picks the cheaper of the two options; storage cap trims the lowest-priority items first; missing inventory falls back to pars with low confidence; the spec 5g worked example gives 18 cases; a missed Thursday cutoff moved to Monday extends the window and raises the next order; a short delivery only adds received quantities; bottle service off removes its items; two different POS formats produce identical sales_records for the same sales.

Phase 4 — Price and deal suggestions
- Implement spec Section 7 using a per-state rules config (config/rules/nh.yaml). Never suggest an illegal purchase channel. For a state with no rules file, suggest only deal sizes from current suppliers.
- Price inputs come from files the owner uploads; show source and date; mark prices older than 30 days stale. Mock any web lookup behind an interface so it can be added later.

Phase 5 — Mockup UI
- Build the screens in spec Section 9, including Data sources, Late order recovery, Receive delivery, and Bottle service (shown only when turned on). Use the repo's existing stack; if the repo is Python and has no UI yet, use Streamlit.
- Onboarding asks for the delivery and order schedule and each supplier's late-order policy first, and blocks recommendations until they are filled in.
- Cutoff reminders at 24 hours and 2 hours before each cutoff (adjustable).
- Mobile-friendly layout.

Phase 6 — Backtest
- Implement spec Section 10: replay history through the baseline rules and the agent policy with no look-ahead, output the metrics table per category, and run the late-order stress tests.

General rules
- Keep ingestion, the reorder engine and the UI separate so the engine can be called by an agent later and new data sources can be added without touching it.
- Type-annotate functions; add a README section on how to run the mockup and tests.
- Ask us instead of guessing when the spec and the repo disagree.
```

## 12. Open questions for Sawtooth

- [ ] Order cutoff (day and time) for the Monday, Tuesday and Thursday deliveries
- [ ] For each distributor: what happens if an order goes in after the cutoff (next delivery, fee, refused), and are late add-ons or special deliveries possible?
- [ ] How often orders have gone in late, and how often deliveries arrive late or short
- [ ] Which distributors carry Corona, the seltzers, Citizen Cider and each keg; do they all deliver on the same days?
- [ ] Per-case prices at each deal size (Corona 6; High Noon and Sun Cruisers 3 vs. 9)
- [ ] Cooler capacity in cases, keg cooler slots, number of tap lines
- [ ] Sales data: daily item sales for the past 12–18 months from Toast, plus any other sources they keep (Kieran's inventory spreadsheet, invoices) and any record of 86'd items
- [ ] Recipes for cocktails and Kieran's specials
- [ ] Which liquors are well vs. premium, and the cost per bottle of each
- [ ] How often Kieran goes to the liquor store, and whether staff runs should be counted as a cost
- [ ] Who would do the 2-minute count before each cutoff, and on what device
- [ ] Whether the owner wants a weekly order budget cap
- [ ] Confirm bottle service stays off for Sawtooth

**Assumptions in this spec to confirm:** half-barrel yield (\~140 pints after loss) and the default in-stock targets in Section 4 are starting points, not Sawtooth data.
