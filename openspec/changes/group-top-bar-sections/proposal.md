## Why

With #70 and #68 on develop, the client app's top bar has eleven items: Home, Calendar, Orders, Analytics, TownwiseAI, Notes, Rules, Town, Your data, then Team and Settings. Spec 15.2 says nav links never hide, so:
- from 1280px the one row squeezes the organization name and the email down to ellipses;
- from 641px to 1279px the second row wraps onto two lines;
- on phones the row scrolls sideways past seven more links.

The owner asked for the top menu bar to be "organized so they don't overflow or have them overflow in groups with a dropdown etc".

## What Changes

- **Always in the bar:** Home, Calendar, Orders, Analytics and TownwiseAI. After them comes one More button.
- **Under More:** Notes, Rules, Town and Your data. Team and Settings stay the right-hand group, unchanged.
- **How More opens:**
  - On web above 640px, More opens a dropdown under itself, over the page.
  - On phones and in the native apps it opens a row of its four links under the bar.
- **What closes it:** Escape (which hands focus back to More), a press or focus outside it, or moving to another page.
- **When one of its sections is current:** More is drawn white, and that link inside carries `aria-current`.
- **Spec:** 15.2 and 15.3 describe the group, and D38 records the decision. Which sections sit under More is `[CONFIRM]`.
- **Breakpoints:** the bar's breakpoints and every other bar (gate, console) stay as they are.

## Capabilities

### New Capabilities

- `top-bar-groups`: the client app's top bar groups the location's less used sections under one More control.

### Modified Capabilities

None (`openspec/specs/` holds no capability yet; the shell is specified in `docs/portal/spec.md` 15).

## Impact

- **Client code:**
  - `client/src/portal/routing.ts`: `NavItem.more` and the set of grouped sections.
  - `client/src/portal/shell/TopBar.tsx`: the More control, its dropdown, its row, and closing on Escape and on a press or focus outside.
  - New `client/test/helpers/topBar.ts`, which opens More for page tests.
- **Tests:**
  - The nav-list tests in `logic.test.ts`, `shell.test.native.tsx`, `shell.test.web.tsx`, `location-shell.test.native.tsx` and `phone-ui.test.web.tsx`.
  - Any page test that reaches a grouped section through the bar.
- **Docs:** `docs/portal/spec.md` 15.2, 15.3, D38, 22.2 and the changelog; `client/MODULE.md`.
- **Unchanged:** no API, route or data changes, and `isAllowed` is untouched.
