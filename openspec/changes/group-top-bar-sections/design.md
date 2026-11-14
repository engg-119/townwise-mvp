## Context

The client app's top bar is `TopBar.tsx`, fed by `clientNav()` in `routing.ts`. `NavItem.end` marks where the right-hand group (Team, Settings) starts. Three layouts exist:
- one row from 1280px;
- a second row under a rule from 641px to 1279px;
- a sideways-scrolling row in a focusable region on phones.

`Select.web.tsx` notes that every react-native-web View is its own stacking context with z-index 0.

## Goals / Non-Goals

**Goals:**
- Fit the client bar in one row from 1280px with room for the organization name and email.
- Keep the second row on one line through tablet widths.
- Every section stays one press away from the bar.

**Non-Goals:**
- No change to the gate or console bars or the breakpoints.
- No change to Team and Settings, the theme switch or Sign out.
- No account menu, and no priority-plus nav that measures what fits.

## Decisions

### 1. One fixed group, chosen in `routing.ts`

`clientNav()` still returns every item in order; the grouped ones carry `more: true`. The bar replaces them with one More control where the first of them was.
- **Why fixed:** a fixed set is predictable and testable. A measured overflow would move links between the bar and the menu as the window changes.
- **What it groups:** Notes, Rules, Town and Your data are what the forecast reads and are set up once or now and then. The daily pages stay in the bar.
- **Changing it:** the set is `[CONFIRM]` in D38, and a change is one line in `MORE`.

### 2. Dropdown on wide web, row elsewhere

| | Web above 640px | Phones and native |
|---|---|---|
| Where the links open | A `panel` box under More, over the page | A row under the bar |
| Inside a landmark | The Main nav, right after More, so Tab order runs into them | Its own navigation landmark, labeled "More" |

The two differ for these reasons:
- **The bar is lifted above the page.** The bar's root takes `zIndex: 1`, so the dropdown, which overflows the bar's box, paints over `main`, a later sibling with z-index 0.
- **Why no portal:** a portal (as `Select.web.tsx` uses) would take the links out of the nav and out of Tab order after More.
- **Why the row elsewhere:**
  - On phones, More sits in a horizontal ScrollView, which clips anything that overflows it.
  - On native, a view outside its parent's bounds gets no touches.

### 3. Open state that closes itself

The open state is the "where" key it was opened at: the joined hrefs and current markers of the nav. When the page or location changes, the key changes and the menu reads as closed. There is no effect that sets state.

On web, `useDismiss` in `TopBar.tsx` adds document listeners while the menu is open, following `chat/ui/HistoryMenu.tsx`:
- `keydown` Escape, with focus on More or one of its links, closes it and focuses More. An Escape meant for anything else on the page is left alone.
- `pointerdown` or `focusin` outside More and its links closes the dropdown only. The row under the bar covers nothing, so it stays open; otherwise, at phone widths (which includes a desktop zoomed to 400%), Tab would reach Team before the row and close it.
- More and its links are found by their `nativeID`, which react-native-web renders as `id`. React's lint refuses ref objects read during render, and the More state is passed down as props.

On native nothing listens; More closes when pressed again or when the page changes.

### 4. Current marking

More is white when open, hovered or holding the current section. The link inside keeps `aria-current`.

On phones the scroll row keeps More in view when a grouped section is current, as it does for the current link.

## Risks / Trade-offs

- **Four sections need a second press:** Notes, Rules, Town and Your data. This is mitigated by the choice being `[CONFIRM]` and one line to change.
- **Spec 15.2 said links never hide:** the change says why they now sit one press away (D38).
- **Native tablets show the row under the bar,** not a floating box. This is acceptable for the apps, which are mostly used on phones.
