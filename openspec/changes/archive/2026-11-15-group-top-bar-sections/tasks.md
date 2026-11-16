## 0. Before starting

- [x] 0.1 Branch `feat/top-bar-groups` from develop at 9e5c429 in its own worktree; nothing goes to develop while release PR #74 is open (session 64)

## 1. Nav data

- [x] 1.1 `routing.ts`: `NavItem.more`, the `MORE` set (Notes, Rules, Town, Your data) marked in `clientNav()`; `logic.test.ts` pins the flag and the order

## 2. The bar

- [x] 2.1 Closing More on web (`useDismiss` in `TopBar.tsx`): Escape with focus inside, and a press or focus outside the dropdown
- [x] 2.2 `TopBar.tsx`: the More control in the row, the second row and the phone scroll row; the dropdown on web above 640px; the row under the bar on phones and native; the open state keyed to the path and the nav; the bar's root lifted with `zIndex: 1` only while the dropdown is open
- [x] 2.3 Tests: web (open, Tab into links, Escape returns focus, outside press closes, following a link closes, `aria-expanded`, `aria-controls`, current marking), native (the row under the bar, the phone scroll target with More current), and every existing test that reaches a grouped section through the bar

## 3. Docs

- [x] 3.1 `docs/portal/spec.md`: 15.2 (top bar, wrap rule, diagram), 15.3 (table and paragraph), D38, 22.2 and the changelog, with `[CONFIRM: Notes, Rules, Town and Your data under More]`
- [x] 3.2 `client/MODULE.md` (a Local changes entry); `client/src/portal/README.md` names no bar items, so it is unchanged

## 4. Verify and land

- [x] 4.1 `npm run verify` on the branch; an independent review of the diff
- [x] 4.2 PR to develop; merge only after #74 is merged and deployed (session 64 says when) and every check on the head is green (#77, df3dec3)
- [x] 4.3 A browser look at 1440, 1280, 1024, 768 and 375px once the owner signs in (2026-11-14: as designed at every width, but at 1280px the organization name and email were 19px short)
- [x] 4.4 The client bar's links `space-5` (20px) apart with a location's sections, so they fit at 1280px; `phone-ui.test.web.tsx` pins 20px and 24px without a location
