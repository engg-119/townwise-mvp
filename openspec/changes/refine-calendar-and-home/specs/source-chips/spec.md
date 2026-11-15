## ADDED Requirements

### Requirement: Every source is a round chip with the site's logo and name
Every link to a source in the portal, in TownwiseAI and on the public marketing pages SHALL be a source chip, on web and native: a pill at least 24px tall, fully round, with a `raised` fill and a 1px `border` outline, 8px side padding, the site's logo in a 16px circle on the `logoGround` token, 6px, then the site's name in 12px sans `text2`, never cut or ellipsized. A chip SHALL move to the next line whole; only a chip wider than its whole row SHALL wrap its name inside the pill, which then grows taller. A chip's pressable SHALL be 44px tall on web and native with the pill centered in it, so no two chips' targets overlap: chips in one place SHALL sit in a row whose pills are 8px apart across, and a wrapped row's pills SHALL sit 20px below the row above. The places: Why on the Calendar's day panel and Home's day detail (the chips under the row's words, in place of "Source" and "Source 1"), On the calendar on both, Home's next 7 days, This month list and Who’s in town, Analytics' day panel, the Town profile's driver and key-date sources and its BLS list, the estimates' provenance line ("From" then the chips), and TownwiseAI's tool cards. A source's link target SHALL be unchanged (TownwiseAI's open in a new tab with `noopener`). The Town profile's plain-text "Source: U.S. Bureau of Labor Statistics, QCEW, …" sentence is not a link and SHALL stay text, and TownwiseAI's row words ("2 events · dartmouth.edu", "Based on … Hanover’s town profile (bls.gov, dartmouth.edu).") are words, not links, and SHALL keep their hosts [CONFIRM: TownwiseAI's row words keep their hosts beside chips that name the site]. The public marketing pages (the map's town panel and How it works) keep their own source links in this change [CONFIRM: the public marketing pages keep their own source links, not the chips].

#### Scenario: A Why reason with a source
- **WHEN** the Calendar's day panel shows the reason "Dartmouth home football" with a source on dartmouthsports.com
- **THEN** under its words is one chip showing the Dartmouth Athletics logo and "Dartmouth Athletics", which opens the source

#### Scenario: A marketing page
- **WHEN** a visitor opens a town on the homepage map and its panel lists a source
- **THEN** the source shows as the same chip, with the site's logo and name, and no image loads from another site

#### Scenario: On the calendar
- **WHEN** Home's day detail lists Veterans Day with its OPM source
- **THEN** it shows a chip with OPM's logo and "U.S. Office of Personnel Management" in place of "Source: U.S. Office of Personnel Management"

#### Scenario: TownwiseAI's tool card
- **WHEN** a done tool card opens to its sources
- **THEN** each is a chip with its site's logo and name, opening in a new tab

#### Scenario: A long row of chips
- **WHEN** a reason has three sources at 375px
- **THEN** the chips wrap onto a second line whole, none is cut, and the second line's pills sit 20px below the first's

#### Scenario: A chip wider than its row
- **WHEN** a chip's name is wider than the whole row it sits in
- **THEN** its name wraps inside the pill and nothing of it is cut

#### Scenario: The target
- **WHEN** a chip renders on web or native
- **THEN** its pressable is 44px tall with the pill centered in it, and it has no `hitSlop`

### Requirement: A chip is named by what it shows
A chip's logo SHALL be hidden from screen readers. Its accessible name SHALL start with the chip's visible text, its number included: "{shown}. Source: {label}" when the source's own label differs from the site's name, and "{shown}. Source" otherwise. When two chips in one row show the same name, the second and later SHALL be numbered ("Dartmouth Registrar 2"). On web the chip's DOM element SHALL carry a `title` attribute with the source's label (set on the element itself, since react-native-web passes no `title` prop through).

#### Scenario: A labeled source
- **WHEN** a chip for "Dartmouth Registrar, 2025-26 key dates" on registrar.dartmouth.edu is reached by a screen reader
- **THEN** its name is "Dartmouth Registrar. Source: Dartmouth Registrar, 2025-26 key dates"

#### Scenario: Two sources from one site
- **WHEN** a key date cites two registrar.dartmouth.edu pages
- **THEN** the chips read "Dartmouth Registrar" and "Dartmouth Registrar 2", and the second is named "Dartmouth Registrar 2. Source: {its label}"

#### Scenario: The label on hover
- **WHEN** on web the chip for "Dartmouth Registrar, 2025-26 key dates" renders
- **THEN** its DOM element has `title="Dartmouth Registrar, 2025-26 key dates"`

### Requirement: Logos are committed assets, with a globe for any site without one
The chip SHALL take its site's name and logo from the committed manifest `client/src/portal/sources/logos.ts`, looked up by the URL's host without `www.`, then by its parent domains down to two labels; a host found nowhere SHALL show its host as the name and a plain globe (a `react-native-svg` drawing in `text3`) as the logo, as SHALL a site with no logo in the manifest. Logos SHALL be same-origin bundled PNG assets under `client/assets/sources/`, each imported by `logos.ts` with a static `import` (no `require`), typed by a committed `*.png` module declaration (`client/src/assets.d.ts`); no chip SHALL load an image from another site, so the web Content-Security-Policy SHALL be unchanged.

#### Scenario: A subdomain without its own logo
- **WHEN** a source is on home.dartmouth.edu and the manifest has dartmouth.edu only
- **THEN** the chip shows dartmouth.edu's name and logo

#### Scenario: A host the manifest lacks
- **WHEN** a source is on a host no manifest entry has (a unit fixture, since every host the shipped data cites is in `sites.json`)
- **THEN** its chip shows the globe and the host, and no request goes to that host to draw it

#### Scenario: No remote image
- **WHEN** the web export is served with its CSP and a page shows source chips
- **THEN** the browser reports no `img-src` violation and every logo is served from the site's own origin

### Requirement: A script fetches the logos once
`client/scripts/source-logos/fetch.mts` (Node 24, no dependency, run by hand, never in CI or at build) SHALL scan the shipped source data for https URLs (`api/src/town-calendar-data.ts`, `api/src/town-profiles.ts`, `api/src/town-calendar.ts`, and the client files the portal's town sources come from), fail with the missing hosts when one has no entry in the hand-written `client/scripts/source-logos/sites.json` (`{ host, name }`), and for each host fetch its home page once (a generic `User-Agent: Townwise logo fetcher`, a 10 second timeout, a 64 KB cap per response) and keep the first PNG among its `apple-touch-icon`, its PNG `<link rel="icon">` and the largest PNG entry of its `/favicon.ico`, refusing SVG, BMP and every other type, so that host gets the globe. It SHALL write `client/assets/sources/{host}.png` and generate `logos.ts` with a header saying not to edit it by hand. Its pure helpers (icon links, PNG signatures, an ICO's entries) SHALL live in `client/scripts/source-logos/icons.ts`, which the script loads at runtime by its file URL and a unit test imports directly. Its README SHALL say how to run it and that its output is committed and reviewed.

#### Scenario: A host with no name
- **WHEN** the shipped data cites a host that `sites.json` lacks
- **THEN** the script exits non-zero naming that host and writes nothing

#### Scenario: A site whose only icon is an SVG
- **WHEN** a host offers only an SVG icon
- **THEN** no file is written for it and its manifest entry has no logo

### Requirement: Every cited host has a name
A client unit test SHALL read the same shipped source files as text and fail when a host they cite has no entry in `sites.json`, and SHALL fail when the manifest names a logo file that does not exist.

#### Scenario: A new source in the town data
- **WHEN** a teammate adds a key date citing a new host without adding it to `sites.json`
- **THEN** the test names the host and fails
