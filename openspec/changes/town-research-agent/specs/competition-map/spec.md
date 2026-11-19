## ADDED Requirements

### Requirement: Competitors come from Places Nearby Search
`PlacesClient` SHALL gain `nearby` (`places:searchNearby`, ranked by distance, at most 20, types restaurant, bar, cafe, coffee_shop, pub, bakery and fast_food_restaurant, field mask id, display name, primary type and location, plus website only for a research run) and `profile` (id, display name, formatted address), with the existing 5-second timeout and `PlacesUnavailableError`. A run's competitors SHALL be the 8 nearest within 1,500 m other than the location's own place, places of the location's type family first. Google's names, types, websites and coordinates SHALL NOT be stored in Mongo; coordinates SHALL use the existing 29-day Valkey point cache; a competitor SHALL be stored only as a place id on an event. With Places off, the competitors thread SHALL end `empty` with `places_off`. [CONFIRM: competitors are the 8 nearest restaurants, bars and cafes within 1,500 m, the location's own type first]

#### Scenario: Own place left out
- **WHEN** Nearby Search answers the location's own place first
- **THEN** it is not a competitor

#### Scenario: Nothing Google answers is stored
- **WHEN** a competitors thread records events
- **THEN** no stored document holds a competitor's name, type, website or coordinates, and each competitor event holds its place id

### Requirement: What Google answers reaches Anthropic only once allowed
While `TOWNWISE_RESEARCH_PLACES_TO_AI` is true (default true; false in `api/production.env` until the owner answers the Google terms question), the location threads' prompts SHALL hold the restaurant's Google name and address and the competitors' Google names, types and websites. While it is false, the restaurant line SHALL hold the town only and the competitors thread SHALL find nearby competition by web search, with Places used only for map pins. [DECISION NEEDED: whether Google Maps Platform's terms allow sending Places names, types and websites to Anthropic] [CONFIRM: the restaurant's Google name and address, and its competitors' Google names, types and websites, sent to Anthropic for research once the terms question is answered]

#### Scenario: Switch off
- **WHEN** `TOWNWISE_RESEARCH_PLACES_TO_AI=false`
- **THEN** no research request holds a name Google answered

### Requirement: The Competition card
`GET /api/org/locations/:locationId/competition?theme=` (member, `places` limiter, open as admin allowed) SHALL answer the live nearby competitors (place id, name, type, letter), a lettered static map signed for the theme, and each competitor's upcoming researched events for 60 days after the location's revisions. It SHALL log counts only. The Town tab SHALL show it as the Competition card, with "Pick your place in Settings" when the location has no place, and nothing when Places is off.

#### Scenario: Competitor's trivia night
- **WHEN** research found a competitor's weekly trivia night
- **THEN** the card lists it under that competitor's letter, with its sources

#### Scenario: No place
- **WHEN** the location has no place
- **THEN** the route answers `{ competitors: [], map: null, gap: 'no_place' }`
