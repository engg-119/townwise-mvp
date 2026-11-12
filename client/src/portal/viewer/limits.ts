// Every bound on what the Your data viewer reads, shows and edits, in one place. A team member may upload a crafted
// file, so each reader stops at these rather than at the file's own word: sizes the file declares are checked before
// anything is inflated, and inflating stops the moment an entry passes them.

const MIB = 1024 * 1024;

export const VIEW_LIMITS = {
  /** The most of a stored original the page fetches to show. */
  originalBytes: 25 * MIB,
  /** Entries in one ZIP package (.xlsx, .docx). */
  zipEntries: 10_000,
  /** One entry, inflated. */
  zipEntryBytes: 64 * MIB,
  /** Every entry together, inflated. */
  zipTotalBytes: 128 * MIB,
  /** Inflated over compressed, for an entry larger than zipRatioFromBytes. */
  zipRatio: 100,
  zipRatioFromBytes: MIB,
  /** One XML part handed to DOMParser. A worksheet or shared-strings part past this is cut at its last whole row. */
  xmlBytes: 16 * MIB,
  /** Sheets read from a workbook. */
  sheets: 50,
  /** Rows read per sheet (and per CSV or TSV file). */
  sheetRows: 5_000,
  /** Columns read per sheet (and per CSV or TSV file). */
  sheetColumns: 200,
  /** Paragraphs plus table rows read from a Word document. */
  documentBlocks: 5_000,
  /** Rows rendered per sheet. */
  shownRows: 1_000,
  /** The largest table the page lets a person edit. */
  editRows: 1_000,
  editColumns: 50,
  /** The longest text the page lets a person edit. */
  editTextChars: 200_000,
} as const;
