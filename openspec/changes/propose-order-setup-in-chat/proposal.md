## Why

On 2026-11-17 the owner asked for this about Orders: "Townwise can also suggest what to order from each distributor. To set that up, feel free to upload any unstructured or structured data and Townwise AI should be able to process that data and extract insights from that data", and to make sure "the townwise ai page can interact with it". Reading a file into the ordering setup exists on Ordering setup (D41, "Read a file with TownwiseAI"), but the TownwiseAI chat cannot use it: its prompt sends the owner to that page, and a file attached to a conversation (D36) can be discussed but never turned into suppliers and items. D41 left this open as `[CONFIRM: the chat tool propose_order_setup is slice 2]`. This change is that slice, as spec decision D56.

## What Changes

- **A new chat tool, `propose_order_setup`.** The chat model turns one file attached to the conversation into suppliers, delivery days and items, written as the tool's input. The tool reads no file: the turn hands it the content it already sent the model (`TurnFiles.sent`), so it never depends on a second parse inside the turn's document window.
- **One server check.** The tool's `parse` is the only check of that input: an `f_` ref, D41's `setupResult` (caps, malformed entries dropped, an email address or phone number replaced, never a par or never run out), at most 60 items, and every point-of-sale name emptied. The tool's run and the card's GET both use it.
- **A card that only shows.** The tool saves nothing. Its card previews the merge against the live setup, lists every change to an item already there field by field (a name's spelling included), and opens Ordering setup (P31) with the suggestions in the unsaved draft. The owner types each par and saves through the existing `org.orders.setup.save`. No new route and no second writer of setups.
- **Two stored states.** `tw_order_cards` gains kind `setup`, whose card is open or set aside. There is no saved mark: the card says its suggestions are in the setup when the live setup shows it.
- **The card stops with its file.** The card's GET checks the file again as the caller and answers 404 once it is turned off, deleted or no longer theirs to read.
- **Shared code moves out of `files/`.** The suggestions' schema and check move to `api/src/orders/suggestions.ts` and their helpers to `api/src/model-answer.ts`, re-exported from the file code, so chat code never reaches file code through one hop.
- **Cost.** Only the chat turn's tokens, charged to the TownwiseAI month. It never touches the files AI budget or the `ai_reads` limiter.
- **Spec decision D56** records the owner's request and these choices, pointing to D41's slice-2 marker and saying where it departs: the chat model writes the proposal, not "the same reader".

## Capabilities

### New Capabilities
- `chat-order-setup`: how TownwiseAI's chat turns an attached file into ordering setup suggestions, what the server checks, what the card shows and stores, when it stops being served, and how the suggestions reach Ordering setup.

### Modified Capabilities
None. `order-setup-read` (D41) is unchanged in behavior: its schema and check only move.

## Impact

- API: new `api/src/model-answer.ts`, `api/src/orders/suggestions.ts`, `api/src/chat/tools/order-setup.ts`; `api/src/files/extract/reader-prompt.ts` and `setup-prompt.ts` (re-exports); `api/src/stores/orders.ts` (kind `setup`); `api/src/handlers/chat-order-proposals.ts` (third card kind, dismiss only); `api/src/stores/audit-events.ts` (comment). Phase B: `api/src/chat/attachments.ts`, `tools/registry.ts`, `tools/read-data.ts`, `handlers/chat.ts`, `chat/turn.ts`, `chat/prompt.ts`.
- Client: new `client/src/portal/orders/setupCard.ts`; `client/src/portal/orders/api.ts` and `proposal.ts`. Phase B: `client/src/chat/ui/OrderSetupCard.tsx`, `OrderProposalCard.tsx`, `client/src/chat/tools.ts`, `useTuningChat.ts`, `client/src/portal/orders/SetupProposal.tsx`, `SetupEditor.tsx`.
- Docs (phase B): `docs/portal/spec.md` (D56, P31, 10.17), `docs/portal/tuning-chat.md`, `api/README.md`, `client/MODULE.md`, `client/app/(marketing)/privacy.tsx` and its pinned tests.
- Infra: none. No new collection, route, limiter or paid service.

## Owner sign-offs

The owner was asleep when this was built, so the coordinator took each decision below on the owner's behalf. Each ships as a `[CONFIRM: ...]` marker in the D56 row and stays open until the owner signs off.

1. The suggestion stays in the conversation as TownwiseAI wrote it, also after the file is turned off or deleted; the card is then no longer served.
2. Chat suggestions never carry register (point-of-sale) names.
3. The card hands off to Ordering setup unsaved; nothing saves from chat, and the card keeps no saved mark.
4. Any member may use it, as any member saves the setup today.
5. 60 items a card; longer lists go to "Read a file with TownwiseAI" on Ordering setup.
6. Charged to the TownwiseAI (chat) month, not the files AI budget.
7. The privacy page's new wording (drafted in the plan) needs the owner's approval before the tool is registered.
