## ADDED Requirements

### Requirement: A move to another page opens it at its top
In every portal frame that scrolls (the client app, the gate pages, account settings and the staff console), a change of the path (`usePathname()`) SHALL scroll the frame to its top, without animation, on web and native, whether it came from a link, a button, the top bar, a redirect, or back or forward, in a browser or on native. Home's This month grid opening a day in the Calendar (`?day=`) SHALL open the Calendar at its top too; then, on web below 1024px, the Calendar SHALL bring its day panel into view, as a press on a grid day does, after the frame's scroll to the top, while wider screens and native leave the panel where it is (owner decision, 2026-11-19). TownwiseAI's full-screen frame, which does not scroll, SHALL be unchanged, and focus handling SHALL be unchanged.

#### Scenario: A button to another page
- **WHEN** a member has scrolled Home down 1,200px and presses "Open the calendar"
- **THEN** the Calendar shows with its title at the top of the window

#### Scenario: The top bar
- **WHEN** a member scrolled down on Analytics presses Calendar in the top bar
- **THEN** the Calendar opens at its top

#### Scenario: Browser back
- **WHEN** a member presses the browser's back button from the Calendar to Home
- **THEN** Home shows at its top

#### Scenario: Native
- **WHEN** on native a member scrolled down on Home opens Notes
- **THEN** Notes shows at its top

#### Scenario: A day from Home's This month
- **WHEN** at 800px a member scrolled down Home chooses Nov 21 in This month's grid
- **THEN** the Calendar opens at its top with Nov 21 selected in its grid, and then scrolls its day panel into view

### Requirement: A query change on the same page keeps the scroll
A navigation that changes only the query of the same path (the Calendar's `?day=` and `?view=`, Orders' `?day=`) SHALL NOT scroll the frame, and a page's own scroll into view (the Calendar bringing its day panel into view below 1024px) SHALL be unchanged.

#### Scenario: Choosing a day
- **WHEN** at 800px a member scrolled down the Calendar clicks a day in the grid
- **THEN** the page is not sent to its top, and the day panel is brought into view as before

#### Scenario: Switching views
- **WHEN** a member scrolled down the Calendar presses Week
- **THEN** the scroll stays where it was
