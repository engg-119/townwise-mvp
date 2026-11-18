## ADDED Requirements

### Requirement: TownwiseAI proposes ordering setup suggestions only from a file the turn sent
The chat tool `propose_order_setup` SHALL show a card only when its `ref` names a file attached to a message on the conversation's path and this turn's requests carry that file's content, sent with the person's message or handed back by `read_data_item` in this turn. The tool SHALL NOT read any file, reserve any bytes for one, or add to the turn's picture bytes. For a ref that is not attached it SHALL answer `{ shown: false }` with a reason. For an attached file whose content this turn has not sent it SHALL answer `{ shown: false }` with a reason telling the model to call `read_data_item` with the ref first. With no supplier and no item it SHALL answer `{ shown: false }`. The tool SHALL save nothing.

#### Scenario: A file attached to this message
- **WHEN** a person attaches an order guide to their message and the model calls `propose_order_setup` with that file's ref
- **THEN** the tool answers `shown: true` with the counts of suppliers and items, and nothing is written to the ordering setup

#### Scenario: A file attached in an earlier turn
- **WHEN** the model calls `propose_order_setup` for a file attached two messages ago without reading it again
- **THEN** the tool answers `shown: false` and says to call `read_data_item` with the ref first

#### Scenario: A file that was never attached
- **WHEN** the model calls `propose_order_setup` with the ref of a file of Your data that no message in the conversation attached
- **THEN** the tool answers `shown: false` and no card is shown

### Requirement: One server check decides what a card carries
The tool's `parse` SHALL be the only check of the model's input, used by the tool's run and by the card's GET. It SHALL answer null unless the input is an object whose `ref` is `f_` followed by 24 lowercase hex characters. It SHALL then apply the ordering setup read's check (`setupResult`): caps on suppliers and deliveries, a malformed entry dropped and a malformed field null, items deduplicated by name, and an email address or formatted phone number in any name or note replaced. It SHALL keep at most 60 items and set `itemsCut` when there were more. It SHALL empty every item's point-of-sale names. A par or never run out in the input SHALL never reach the result. Unknown keys SHALL be dropped, not refused. The tool's input schema SHALL NOT name point-of-sale names, a par or never run out.

#### Scenario: The model writes a par and a register name
- **WHEN** the input's item carries `par: 4`, `neverRunOut: true` and a point-of-sale name
- **THEN** the checked item has no par, no never run out and an empty list of point-of-sale names

#### Scenario: More than 60 items
- **WHEN** the input lists 61 items
- **THEN** the first 60 are kept and `itemsCut` is true

#### Scenario: A sales upload's ref
- **WHEN** the input's ref starts with `u_`
- **THEN** the input is invalid and nothing is shown

### Requirement: The tool says which names it could not find in the text sent
When the content sent was text, the tool's result SHALL list the items whose name is not written in that text, matched as the setup page matches names, and SHALL say when that text was cut. When the content sent was a picture, the result SHALL say the names were not checked. The result SHALL say whether the turn's requests carried web pages. The tool's views SHALL carry the ref and counts only, never a name.

#### Scenario: A name the file does not hold
- **WHEN** one suggested item's name is not written in the file's text
- **THEN** the result names that item among those not in the file, and the card's GET answers that item with `inFile: false`

#### Scenario: A picture
- **WHEN** the attached file is a picture
- **THEN** the result says names were not checked, and the card's GET answers every item with `inFile: null`

### Requirement: The card is served only while the caller may still read its file
`GET .../chat/:conversationId/order-proposals/:proposalId` SHALL answer `{ proposal: { kind: "setup", status, read, readWeb } }` for a stored `propose_order_setup` call that showed a card, where `status` is `open` or `dismissed` and `read` is the checked suggestions in the shape of an ordering setup read, each item's `inFile` taken from the stored result. It SHALL answer 404 for a conversation that is not the caller's, a call that showed nothing or failed, an input that does not pass the check, and an unknown id. It SHALL check the file again as the caller and answer 404 unless the file is kept, turned on, its original still there, and the caller is its uploader or an org admin. The GET SHALL store nothing. Under view-as the GET SHALL answer `counts: { suppliers, items }` in place of `read`, so no supplier, item or note derived from the file reaches staff there.

#### Scenario: The file is turned off after the card was shown
- **WHEN** someone turns the file off and the author opens the conversation again
- **THEN** the card's GET answers 404 and the client says the card isn't available

#### Scenario: Staff in view-as
- **WHEN** staff viewing as the author open a conversation with a setup card
- **THEN** the card's GET answers how many suppliers and items were suggested and no name, and the card shows no action

#### Scenario: Another member's conversation
- **WHEN** a teammate requests the card of a conversation they did not write
- **THEN** the API answers 404

#### Scenario: A member loses the org admin role
- **WHEN** an org admin got a card from a teammate's file and is then made a member
- **THEN** the card's GET answers 404 for them

### Requirement: A setup card can only be set aside
`POST .../chat/:conversationId/order-proposals/:proposalId` SHALL accept only `{ action: "dismiss" }` for a setup card and answer `{ proposal: { kind: "setup", status: "dismissed" } }`. Any other body, a save included, SHALL be 400 `invalid_request`. The first dismiss SHALL write one `order.card_dismissed` with the location, the conversation and `kind: "setup"`, and nothing else; a repeat SHALL write none. Nothing SHALL write `order.card_saved` for a setup card. Under view-as the POST SHALL be 403 `view_as_read_only`. Neither the GET nor the POST SHALL change the ordering setup or its version.

#### Scenario: Not now
- **WHEN** the author presses Not now on an open setup card
- **THEN** the card is set aside, one `order.card_dismissed` of kind `setup` is recorded with ids only, and the ordering setup is unchanged

#### Scenario: A save from the chat
- **WHEN** a client posts `{ action: "save" }` to a setup card
- **THEN** the API answers 400 and nothing is written

### Requirement: The card previews the merge and hands off to Ordering setup unsaved
The client SHALL preview a setup card against the live ordering setup with the same merge Ordering setup uses: items matched by name keep their id, par, never run out and point-of-sale names; new items have a blank par; a new supplier comes with its days; an existing supplier's days change only when it has none; nothing is removed. The preview SHALL list each item already in the setup that would change, with the field, its value now and the suggested value, a name's spelling included. It SHALL say how many servings are TownwiseAI's estimates, how many names were not in the file or that names could not be checked, when the file was cut or lists more than the 60 items a chat suggests, and what is left out and why. When nothing would be added, changed or left out it SHALL say the suggestions are in the setup. The card SHALL open Ordering setup with the suggestions merged into the unsaved draft, where the page SHALL list the same changes to existing items and say when the reply also read web pages; the owner sets each new item's par and saves there. Nothing SHALL be saved from the chat.

#### Scenario: A suggestion would change an existing item's unit
- **WHEN** the setup holds an item in cases and the suggestion gives the same name in kegs
- **THEN** the card lists that item with "unit cases to kegs" before the owner opens Ordering setup

#### Scenario: The suggestions were already saved
- **WHEN** the owner saved the suggestions on Ordering setup and opens the conversation again
- **THEN** the card says the suggestions are in the ordering setup
