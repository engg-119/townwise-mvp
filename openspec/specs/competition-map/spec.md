# competition-map Specification

## Purpose
TBD - created by archiving change town-research-agent. Update Purpose after archive.
## Requirements
### Requirement: Competitors come from Places Nearby Search
`PlacesClient` SHALL gain `nearby` (`places:searchNearby`, ranked by distance, at most 20, types restaurant, bar, cafe, coffee_shop, pub, bakery and fast_food_restaurant, field mask id, display name, primary type and location, plus website only for a research run) and `profile` (id, display name, formatted address), with the existing 5-second timeout and `PlacesUnavailableError`. A location's competitors SHALL be the 8 nearest within 1,500 m other than the location's own place, places of the location's type family first. Google's names, types, websites and coordinates SHALL NOT be stored in Mongo; coordinates SHALL use the existing 29-day Valkey point cache.

#### Scenario: Own place left out
- **WHEN** Nearby Search answers the location's own place first
- **THEN** it is not a competitor

#### Scenario: Nothing Google answers is stored
- **WHEN** a competitors thread records events
- **THEN** no stored document holds a name, type, website or coordinates that Google answered

### Requirement: Competing events are found with or without Google names
While `TOWNWISE_RESEARCH_PLACES_TO_AI` is true, the location threads' prompts SHALL hold the restaurant's Google name and address and the competitors' Google names, types and websites, and an event naming a competitor index SHALL store its place id. While it is false (the code default when unset; `api/production.env` sets it true since the owner's decision of 2026-11-19), no research request SHALL hold anything Google answered, the location threads SHALL name the restaurant by the location's own owner-typed name and town, and the `competitors` thread SHALL find the town's restaurants, bars and cafes and their public events by web search, storing each competing business as a web-found `business` entity linked from its events. [Decided 2026-11-19 by the owner: allowed (“yes that is allowed”), to whether Google Maps Platform's terms allow sending Places names, types and websites to Anthropic.]

#### Scenario: Switch off
- **WHEN** `TOWNWISE_RESEARCH_PLACES_TO_AI=false`
- **THEN** no research request holds a name Google answered, and the competitors thread still records a competitor's trivia night linked to that business's entity

### Requirement: The Competition card
`GET /api/org/locations/:locationId/competition?theme=` (member, `places` limiter, open as admin allowed) SHALL answer the live nearby competitors (place id, name, type, letter), a lettered static map signed for the theme, each competitor's upcoming researched events for 60 days after the location's revisions, and the competitor events it could not place on the map. An event SHALL be shown under a letter when its stored place id is that competitor's, or when its business entity's name key equals the name key of that competitor's live display name, compared on the server with nothing stored or sent; other competitor events SHALL be listed under "Competing events found on the web", grouped by business. It SHALL log counts only. The Town tab SHALL show it as the Competition card, with "Pick your place in Settings" when the location has no place, and the web list with no map when Places is off.

#### Scenario: Competitor's trivia night
- **WHEN** research, with Google names not allowed, found "Trivia night" hosted by a business whose name matches a nearby place's display name
- **THEN** the card lists it under that competitor's letter, with its sources

#### Scenario: No match on the map
- **WHEN** a competitor event's business matches no nearby place
- **THEN** the card lists it under "Competing events found on the web"

#### Scenario: No place
- **WHEN** the location has no place
- **THEN** the route answers `{ competitors: [], map: null, web: [], gap: 'no_place' }`

