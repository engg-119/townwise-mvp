## ADDED Requirements

### Requirement: Who may read, and when it is on
A member of the location's organization, or staff opened as its admin, SHALL be able to ask TownwiseAI to read one file or one pasted text on Ordering setup. A read SHALL be refused under view-as, and SHALL be off without an `ANTHROPIC_API_KEY` or with `TOWNWISE_FILES_MONTHLY_BUDGET_USD` at 0. It SHALL work whether stored files are on or off. [CONFIRM: every member, and staff opened as admin; never under view-as]

#### Scenario: A member reads an order guide
- **WHEN** a member posts a PDF order guide to `org.orders.setup.read`
- **THEN** the API answers 200 with the checked suggestions and records `order.setup_read` with counts only

#### Scenario: Under view-as
- **WHEN** staff view as an organization and post a read
- **THEN** the route chain refuses it with 403 `view_as_read_only` and no model call is made

#### Scenario: Reading is off
- **WHEN** there is no `ANTHROPIC_API_KEY` or the budget setting is 0
- **THEN** the API answers 503 `ai_unavailable` and the setup read answers `canReadWithAi: false`, so the page shows no section

#### Scenario: Another organization's location
- **WHEN** a member posts a read for a location of another organization
- **THEN** the API answers 404 exactly as for an unknown location

### Requirement: The content is sent once and never kept
The content SHALL be sent in the request and reach Anthropic once, with the saved setup's supplier and item names and nothing else: never the file name, a point-of-sale name, the organization or location name, or an email address. The file's name SHALL never leave the browser, but a PDF SHALL be sent byte for byte, so its own document properties, which can hold a title or an author's name, are sent with it. A picture SHALL lose its metadata before it is sent. Townwise SHALL NOT store the content, add it to Your data, or put any of it, or any name from the answer, in a log line or an audit event. [CONFIRM: a file or text given on Ordering setup is sent once to Anthropic and never stored, separate from D34] [CONFIRM: pressing Read with TownwiseAI is consent to send it, with the setup's supplier and item names]

#### Scenario: Nothing is stored
- **WHEN** a read answers 200
- **THEN** no `tw_files` row, blob or Your data item exists for it, and the setup's version is unchanged

#### Scenario: Logs carry counts only
- **WHEN** a read of a file holding an item name, a supplier name and a person's name finishes or fails
- **THEN** its log lines and audit event carry only their allowlisted ids, kinds, codes and counts, and none of those names

### Requirement: Accepted input and caps
A read SHALL take one PDF, Excel `.xlsx`, Word `.docx`, CSV or text file, or one PNG, JPEG, GIF or WebP picture, or pasted text. It SHALL refuse a ZIP, `.xls` or `.doc` file, a file whose bytes don't match its kind, and an encrypted or unreadable file with a 400 code. A ZIP SHALL answer `extract_kind_not_read`. The browser refuses `.xls` and `.doc` by their extension; an old Excel or Word file under another name SHALL answer `extract_encrypted` when posted as `xlsx` or `docx` (it has the container a password-protected workbook or Word document has) and `extract_kind_mismatch` when posted as any other kind. Input over the caps SHALL be refused, except text, which SHALL be cut and said to be cut. [CONFIRM: 5 MB a file in an 8 MB body, 30 PDF pages, 3.75 MB and 8,000 px a picture, 100,000 characters of text]

#### Scenario: A ZIP
- **WHEN** a member posts a ZIP file
- **THEN** the API answers 400 `extract_kind_not_read` and makes no call

#### Scenario: An old Excel file renamed
- **WHEN** a member posts an old Excel `.xls` file renamed `.xlsx`
- **THEN** the API answers 400 `extract_encrypted`, as for a workbook with a password, and makes no call

#### Scenario: Long pasted text
- **WHEN** a member pastes 150,000 characters
- **THEN** the first 100,000 are read and the answer says the text was cut

### Requirement: What is proposed
The answer SHALL propose suppliers with delivery and order-by days when the content gives them, and items with name, supplier, category, unit, servings per unit, deal size and point-of-sale names where the content gives them. It SHALL NOT propose a par or never run out. A servings estimate SHALL be marked as an estimate, and an item whose name is not in the content's text SHALL be marked. Email addresses and formatted ten-digit phone numbers SHALL be replaced in the answer (`[email]`, `[phone]`); a seven-digit local number or digits run together are not caught, so the prompt is the main guard. An item's supplier SHALL be one of the proposed suppliers, or none. [CONFIRM: TownwiseAI never proposes a par or never run out] [CONFIRM: names not found written in the file are marked] [CONFIRM: 150 items a read, 20,000 output tokens, low effort, 150 seconds, set by the spike of 2026-11-15]

#### Scenario: A keg on an invoice
- **WHEN** an invoice lists a half-barrel of an IPA
- **THEN** the item is proposed in kegs with about 124 servings per unit, marked as TownwiseAI's estimate, and with no par

#### Scenario: An answer that tries to set a par
- **WHEN** the model's answer carries a par or never run out for an item
- **THEN** the server drops it and the suggestion carries neither

### Requirement: Suggestions merge into the unsaved draft
The page SHALL merge the suggestions into the setup draft through the same merge as the sheet import, by item name, and SHALL save nothing until the member saves the setup. A new item SHALL keep a blank par, category, unit, servings or supplier blank, so the setup's checks name it at Save. A replaced item SHALL keep its own values where the suggestion is blank, and SHALL always keep its par and never run out. Proposed deliveries SHALL fill a supplier only when it has none. [CONFIRM: proposed deliveries fill only a supplier with none]

#### Scenario: A new item without a par
- **WHEN** a read proposes a new item and the member presses Save without setting its par
- **THEN** the setup is not saved and the item's par field says what is missing

#### Scenario: An item already in the setup
- **WHEN** a read proposes an item with the same name as a saved item with par 4 and never run out
- **THEN** the draft's item keeps par 4 and never run out, and takes the suggestion's filled fields

#### Scenario: The summary
- **WHEN** a read proposes 14 items, 3 of them already in the setup
- **THEN** the page says "TownwiseAI found 14 items: 11 new, 3 replaced by name. Nothing is saved yet: check them below, then save the setup." and asks for the par of the 11 new items

### Requirement: Budget and failures
Each read SHALL be charged to the organization's files AI budget (`tw_files_usage`), shared with D34 reads and the AI column step, by reserving the call's ceiling before it and correcting to its cost after. A spent budget SHALL answer 409 `files_ai_budget_exhausted` with no call. A refusal or a cut answer SHALL be charged and answer 422. A call that fails SHALL be charged what its stream had reported (its input tokens and its output so far, at three characters a token, at the answering model's list prices); one ended by the time limit or by the person leaving before its stream reported anything SHALL keep its whole reservation; an API error before the stream began SHALL be charged nothing. An API error SHALL answer 503 `extract_failed` and the time limit 503 `extract_timed_out`. A person who leaves before the call SHALL cause no call. Reads SHALL share the `ai_reads` limiter. [CONFIRM: shares TOWNWISE_FILES_MONTHLY_BUDGET_USD; a read costs about $0.06 to $0.44, so $5 covers about 12 reads of a 150-item list or about 80 invoice photos] [CONFIRM: shares the townwise:ai-reads limiter]

#### Scenario: The budget is spent
- **WHEN** the month's files AI spend has reached the budget
- **THEN** the API answers 409 `files_ai_budget_exhausted` and makes no call

#### Scenario: The model refuses
- **WHEN** the model refuses the content
- **THEN** the API answers 422 `extract_refused` and the call's cost is charged

### Requirement: Web only in this change
The section SHALL appear on the web only, while `canReadWithAi` is true. Native SHALL show no control, only that reading with TownwiseAI is on the web. Under view-as the section's controls SHALL be disabled in place and described by the read-only line. [CONFIRM: web only in slice 1] [CONFIRM: the chat tool propose_order_setup is slice 2]

#### Scenario: Native
- **WHEN** a member opens Ordering setup in the native app
- **THEN** the page has no Read control and says reading a file with TownwiseAI is on the web
