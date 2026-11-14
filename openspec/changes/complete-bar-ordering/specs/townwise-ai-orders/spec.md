## ADDED Requirements

### Requirement: TownwiseAI reads the live board
`get_order_board` SHALL take no input and return the location's board as the Orders page computes it (the live board, or `{ available: false, reason, missing }`); it SHALL never return the labeled sample, which only the Orders page shows. `get_order_line` SHALL take `{ itemId }` and return that item's line on its supplier's next order with mu, sigma, S, the target, the count and its age, the deal size, the covered days used, and its servings on the last 28 covered days. A line in either tool SHALL give `par` as the par it used and, only when it differs, `setupPar` as the owner's par from the setup. `propose_order_rule` SHALL treat a rule in another unit than the latest edit's as absent, unless the owner turned it off.

#### Scenario: Unknown item
- **WHEN** `get_order_line` is called with an item id not in the setup
- **THEN** it returns `{ available: false, reason }`

### Requirement: TownwiseAI reads the setup
`get_order_setup` SHALL take no input and return the suppliers with their delivery and order-by days and times, the items with supplier, category, unit, servings per unit, par, deal size, never-run-out, latest count and its date, and item-sales coverage; it SHALL NOT return point-of-sale names.

#### Scenario: Nothing set up
- **WHEN** a location has no setup
- **THEN** the tool returns `{ available: false, reason }` naming what to set up and where

### Requirement: Order cards act on the live board
`propose_order_change { itemId, delivery }` SHALL show a card for the item's line when `delivery` is its supplier's next delivery, which the owner saves with a quantity and reason or dismisses; the card SHALL save through the same checks as the Orders page. `propose_order_rule { itemId }` SHALL show a card only after a saved edit that differs from the recommendation and has no rule yet.

#### Scenario: Save from the card
- **WHEN** the owner saves a change card with quantity 10 and a reason
- **THEN** the decision is stored for that delivery and the Orders page shows the edit

### Requirement: Tool order and views
The five tools SHALL be appended at the end of the registry in the order `get_order_board`, `get_order_line`, `get_order_setup`, `propose_order_change`, `propose_order_rule`, pinned by `api/test/chat-tools.test.ts`. Their input and result views SHALL carry ids, dates, booleans and counts only.

#### Scenario: Result view
- **WHEN** a turn calls `get_order_line`
- **THEN** the saved view holds the item id and delivery date, not quantities or names

### Requirement: Prompt rules for orders
The system prompt SHALL tell TownwiseAI to call `get_order_board` before discussing an order, `get_order_setup` for what is set up or missing, never to state a quantity no tool returned, that a remembered change applies to every later order of the item, and never to say an order was placed. The prompt SHALL stay static.

#### Scenario: Static prompt
- **WHEN** `api/test/chat.test.ts` runs
- **THEN** the prompt holds no digits and no per-location text
