Tests first in every group. Run single suites only (`npm run test:unit -w @townwise/api -- test/<file>`; `npm test -w @ckeith26/expo-shell -- test/<file> --maxWorkers=4`), one workspace at a time; the full `npm run verify` is for the session that merges, after asking the release session (the laptop also runs CI). Phase A (groups 1, 3 and 4, and the tool of group 2) was built on 2026-11-18 on `feat/chat-order-setup`. Phase B is everything unchecked: it waits for `resumable-chat-turns` to land and for the owner's word on the privacy page.

## 0. Before building

- [x] 0.1 The coordinator took the owner's decisions on the owner's behalf (design, "Decisions taken for the owner"); each ships as a `[CONFIRM: ...]` marker in the D56 row.
- [x] 0.2 D56 is this change's number (D54 and D55 were taken by other sessions on 2026-11-17).
- [ ] 0.3 Timing spike, skipped on 2026-11-18: one real order guide as a PDF and as an .xlsx through a scripted chat turn, recording seconds from the turn's claim to the attachment's parse, to the tool's run and to `done`, and output tokens. Fix `ORDER_SETUP_ITEMS_MAX` (and the client's `CHAT_SETUP_ITEMS_MAX`) from it.
- [ ] 0.4 Owner: approve or edit the privacy wording (group 7) before the tool is registered.

## 1. Shared suggestions and answer checks

- [x] 1.1 `api/test/order-suggestions.test.ts`: the setup read's schema and check are the ones `orders/suggestions.ts` exports; `reader-prompt.ts` and `setup-prompt.ts` re-export the helpers of `model-answer.ts`; `orders/suggestions.ts` imports nothing under `files/`.
- [x] 1.2 `api/src/model-answer.ts` (`entries`, `isRecord`, `oneOf`, `redacted`, the email and phone patterns) and `api/src/orders/suggestions.ts` (`setupAnswer`, `setupResult`, `nameKey`, the caps, the `Suggested*` and `SetupReadResult` types); the two file modules re-export. `api/test/setup-read.test.ts` and `api/test/isolation.test.ts` stay green unchanged.

## 2. The turn's sent content and the tool

- [x] 2.1 `api/test/chat-order-setup-tool.test.ts` and `api/src/chat/tools/order-setup.ts`: the tool object, its input schema, `parse` (ref pattern, `setupResult`, 60 items with `itemsCut`, every `posNames` emptied), `run` against a locally declared `sent`, its views (a ref and counts only) and `shownOrderSetup` for the card's GET. Not registered.
- [ ] 2.2 Tests in `api/test/chat-attachments.test.ts`: "turnAttachments' sent holds the text and cut flag of each document it sends and a mark for each picture, and nothing for a file listed not read"; "read_data_item adds what it hands back to the turn's sent, and a refusal adds nothing".
- [ ] 2.3 `api/src/chat/attachments.ts`: `TurnAttachments` gains `sent`, filled in `turnAttachments` beside each `content.push`. Move `SentFile` to `api/src/chat/tools/registry.ts` as a required `TurnFiles.sent: Map<string, SentFile>` and delete `SentFiles`, `OrderSetupContext` and the cast in `order-setup.ts`. `api/src/chat/tools/read-data.ts`: `tc.files.sent.set(...)` beside each of its three `readUntrusted = true`. `api/src/handlers/chat.ts`: `sent: new Map(attached?.sent)` on the turn's `files`. The seven test builders gain `sent: new Map()`.
- [ ] 2.4 Append `proposeOrderSetupTool` after `proposeOrderRuleTool` in `TOOL_REGISTRY` (append only), in the same PR as the privacy page (group 7). Update the pinned tool lists: `api/test/chat-tools.test.ts`, `api/test/chat.int.test.ts`, `client/test/chat/tools.test.ts`.
- [ ] 2.5 `api/src/chat/turn.ts`: add `'propose_order_setup'` to `DISPLAY_TOOLS` (the resumable branch's list; develop's `showsOnly` covers it by prefix).
- [ ] 2.6 `api/src/chat/prompt.ts`: replace the last sentence of the ordering setup line. New rule: for a file attached to this conversation, call `read_data_item` first when its content is not in this reply; call `get_order_setup` and write a supplier or item already there exactly as the setup spells it; then `propose_order_setup` with the file's ref, at most 60 items, no people's names, register names, pars or never run out; never say anything was saved; send a longer list, an unreadable file or pasted text to Read a file with TownwiseAI on Ordering setup; files are attached on the web, so never ask for an attachment without saying so. Update the pin in `api/test/chat.test.ts` and add "is named in the system prompt, which no longer says the chat can't fill the setup" and "text written before the card stays the reply" to the tool's tests.

## 3. The card on the server

- [x] 3.1 `api/test/chat-order-setup.int.test.ts` with memory blobs and seeded calls: the GET's shape with each name's `inFile` and never a par, never run out or point-of-sale name; 404 for another member's conversation, another organization's caller, a call that showed nothing, a failed call, another tool's call and an unknown id; 404 once the file is turned off, its original is deleted, or the caller is neither its uploader nor an org admin (a role change included); dismiss once with one `order.card_dismissed` of kind `setup`, a save action 400 and no `order.card_saved`; dismiss under view-as 403 `view_as_read_only`; GET and dismiss leave the ordering setup unchanged.
- [x] 3.2 `api/src/stores/orders.ts` (kind `setup` in the type and the mongoose enum), `api/src/handlers/chat-order-proposals.ts` (the third `loadShown` branch, the GET's `{ kind: 'setup', status, read, readWeb }`, the dismiss-only POST), `api/src/stores/audit-events.ts` (the comment names the third kind).
- [ ] 3.3 Turn-driven tests in the same file, once 2.3 and 2.4 are in: "a turn that attaches an order guide and calls propose_order_setup shows a card whose GET answers the checked suggestions"; "in a later turn nothing is shown until read_data_item read the file again".
- [ ] 3.4 Run `api/test/orders.int.test.ts` once (the change and rule cards share the handler; phase A ran only the new integration file).

## 4. The preview on the client

- [x] 4.1 `client/test/portal/orders/setupCard.test.ts` and `client/src/portal/orders/setupCard.ts` (pure): `setupCardPreview(read, setup)` runs the same merge Ordering setup runs and returns the card's lines, counts, the changes to existing items field by field, what is left out, and whether the suggestions are already in the setup.
- [x] 4.2 `client/src/portal/orders/api.ts`: `fetchSetupProposal` and `dismissSetupProposal`. `client/src/portal/orders/proposal.ts`: `proposalSummary` takes the cut line's cap and wording; the default stays D41's.

## 5. The card in the chat

- [ ] 5.1 `client/test/chat/orderSetupCard.test.web.tsx`: a shown call waits while it streams, then draws the card with the merge preview once the turn is saved, and on reload; Review links to Ordering setup with the card's ids and no name; Not now sets it aside; it says so when the conversation also read web pages; a card whose file was turned off or deleted says it isn't available; no actions under view-as.
- [ ] 5.2 `client/src/chat/ui/OrderSetupCard.tsx` (new); `OrderProposalCard.tsx` (`cardSchema` gains kind `setup` and renders it, so `ReplyView.tsx` is untouched); `client/src/chat/tools.ts` (a hidden row after `propose_order_rule`); `client/src/chat/useTuningChat.ts` (`ORDER_SETUP_TOOL` at the two sites that name the order card tools).

## 6. The handoff on Ordering setup

- [ ] 6.1 `client/test/portal/orders/setupProposal.test.web.tsx` and one native case in `setup.test.native.tsx`: with `?proposal=` it merges the card into the unsaved draft and says what it did, nothing saved; Save names each new item's blank par; after "Load their changes" the suggestions merge into the reloaded draft again; after a save it stops and drops the query; a set-aside or unavailable card says so and leaves the draft alone; under view-as nothing is merged.
- [ ] 6.2 `client/src/portal/orders/SetupProposal.tsx` (new, both platforms) rendered by `SetupEditor.tsx` above Suppliers, using `proposalSummary(result, 'file', CHAT_CUT)`. Sequence this with any other session editing `SetupEditor.tsx`.
- [ ] 6.3 Independent UI review (web and native) by an agent that did not build it: attach, card, review, save, set aside, a file turned off.

## 7. Docs, spec and privacy

- [ ] 7.1 `docs/portal/spec.md`: the D56 row with its `[CONFIRM: ...]` markers, pointing to D41's slice-2 marker; P31 accepts `?proposal=`; 10.17's card rows; the changelog. Native cannot start this; a non-admin member gets a card only from a file they added.
- [ ] 7.2 `docs/portal/tuning-chat.md`: the two order-proposals rows (third kind; POST is dismiss only), the order cards paragraph, the prompt summary, a tools row and a views row for `propose_order_setup`, section 3 (what `sent` is), section 5 (the card kind).
- [ ] 7.3 `api/README.md`: Orders flow 7, the audit row, the two endpoints, `tw_order_cards`.
- [ ] 7.4 `client/MODULE.md`: the order tools paragraph and a `## Local changes` entry naming `test/portal/orders/setupCard.test.ts` (phase A's client files) and the phase B tests.
- [ ] 7.5 `client/app/(marketing)/privacy.tsx`, only after 0.4: the new "Files you attach to a TownwiseAI message" paragraph and the edits to the conversation, "Files you let TownwiseAI read" and Anthropic sentences, with the date; update the pins in `client/test/marketing/pages.test.web.tsx`, `privacy-forecasts.test.web.tsx` and `privacy-suggestions.test.web.tsx`, and add "Privacy says what attaching a file to a TownwiseAI message sends and what an ordering suggestion keeps (D36, D56)". Rebase on whichever of the other branches editing that page landed first.
