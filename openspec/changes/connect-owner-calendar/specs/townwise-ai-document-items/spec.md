## ADDED Requirements

### Requirement: TownwiseAI reads PDF and Word reference items
`read_data_item` SHALL read a reference item of kind `pdf` or `docx`, as well as `text`, when the item is kept, turned on, its original is still stored, and stored files are on. It SHALL never read a sales (`history`) file.

#### Scenario: PDF event list
- **WHEN** the owner adds a PDF of upcoming private events to Your data and asks TownwiseAI about it
- **THEN** TownwiseAI reads the PDF and can propose a note for each dated event, which the owner saves

#### Scenario: Turned-off item
- **WHEN** the PDF item is turned off on Your data
- **THEN** `read_data_item` answers that the item is unavailable and sends nothing to the model

#### Scenario: Legacy Word file
- **WHEN** the item is a `.doc` file
- **THEN** `read_data_item` answers that TownwiseAI can't read this kind of file

### Requirement: A PDF goes to the model as a document, within limits
A PDF item SHALL be sent to the model as a `document` block in the tool result when it is at most 10 MB and 100 pages. A larger one SHALL answer `{ available: false, reason: 'too_large' }`.

#### Scenario: Large PDF
- **WHEN** the PDF has 140 pages
- **THEN** the tool answers `too_large` and sends no document

### Requirement: Word text is extracted on the server
A `.docx` item's paragraph and table text SHALL be extracted in the parse thread under the existing archive guards and returned as text, cut at the existing 20,000 character limit.

#### Scenario: Long Word file
- **WHEN** a `.docx` item holds 50,000 characters of text
- **THEN** the tool returns the first 20,000 characters and says the text was cut

### Requirement: Saved conversations keep no document content
The saved conversation SHALL keep only the item reference and counts for a PDF or Word read, as it does for a text read.

#### Scenario: Reopening a conversation
- **WHEN** a member reopens a conversation in which TownwiseAI read a PDF
- **THEN** the stored conversation holds the item reference and page count, not the PDF's bytes or text

### Requirement: Your data says which items TownwiseAI can read
Your data and the chat composer's file line SHALL say a PDF or Word reference item can be read by TownwiseAI, as they say for text items today.

#### Scenario: Add a PDF from the composer
- **WHEN** a member adds a PDF with the composer's + button
- **THEN** the line reads "{name} is on Your data. TownwiseAI can read it."
