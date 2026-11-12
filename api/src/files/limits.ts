// Every cap on stored files (docs/portal/spec.md 11A and 18). [CONFIRM: file caps and limits]

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** One file's upload. */
export const MAX_FILE_BYTES = 200 * MIB;
/** Each PUT of an upload session carries one chunk (the last one the remainder). */
export const CHUNK_BYTES = 8 * MIB;
/** The highest chunk count a file can have. */
export const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES);
/** An original over this downloads in parts of this size (`?part=k`), so no response nears the ingress timeout. */
export const RAW_PART_BYTES = 32 * MIB;
/** Uploaded per organization per UTC day. */
export const DAILY_UPLOAD_BYTES = 2 * GIB;
/** Stored per organization (originals not yet deleted). */
export const STORED_BYTES_PER_ORG = 5 * GIB;
export const FILES_PER_IMPORT = 50;
export const FILES_PER_LOCATION = 500;
export const UPLOADING_PER_LOCATION = 10;
/** An upload session's lifetime; after it the file is "Upload interrupted". */
export const UPLOAD_SESSION_MS = 24 * 60 * 60 * 1000;
/** The first bytes kept on the row while uploading, to tell the file's kind at complete. */
export const HEAD_BYTES = 8 * KIB;
/** Chunk streams one replica takes at once; the next answers 503 uploads_busy. */
export const MAX_CHUNK_STREAMS = 12;
export const FILE_NAME_CHARS = 255;

/** An import still `done` this long after it finished is what GET imports/current answers. */
export const RECENT_IMPORT_MS = 24 * 60 * 60 * 1000;

/** Reading (storage2.md 7.6). */
export const XLSX_READ_BYTES = 10 * MIB;
export const XLSX_MAX_ENTRIES = 2000;
export const XLSX_MAX_ENTRY_BYTES = 64 * MIB;
export const XLSX_MAX_DECLARED_BYTES = 200 * MIB;
/** An entry over 1 MiB may not claim more than this many times its compressed size. */
export const XLSX_MAX_RATIO = 100;
export const MAX_ROWS = 2_000_000;
export const MAX_COLUMNS = 200;
export const MAX_SHEETS = 10;
/** Rows searched for the header row. */
export const HEADER_SEARCH_ROWS = 30;
/** A file that takes longer is kept as too_complex. */
export const READ_TIME_MS = 20 * 60 * 1000;
/** Worker attempts at one file before it is failed with `internal`. */
export const MAX_ATTEMPTS = 3;
/** Bytes handed to the parse thread at a time. */
export const THREAD_CHUNK_BYTES = MIB;
/** The parse thread's memory (MiB). */
export const THREAD_LIMITS = { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } as const;
/** A reading file's progress is written at most this often. */
export const PROGRESS_WRITE_MS = 2000;
/** Days written to tw_sales_days per call. */
export const APPLY_BATCH_DAYS = 1000;
/** Closed dates kept on a file's result and an import's totals. */
export const MAX_CLOSED_DATES = 60;

/** ZIP archives (spec 11A): checked on the central directory before anything is inflated. */
export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_DIRECTORY_BYTES = 16 * MIB;
/** Declared uncompressed bytes, every depth together. */
export const ZIP_MAX_DECLARED_BYTES = 2 * GIB;
/** Declared uncompressed bytes to the archive's size, and to an entry's compressed size for entries over 1 MiB. */
export const ZIP_MAX_RATIO = 100;
export const ZIP_RATIO_FLOOR_BYTES = MIB;
/** A ZIP inside a ZIP is opened from memory up to this size; one inside that is never opened. */
export const NESTED_ZIP_BYTES = 50 * MIB;
/**
 * Nested ZIPs held in memory at once, together, for the whole read. Buffers live outside V8's heap, so the thread's
 * resource limits do not bound them: this cap does, within the replica's memory.
 */
export const NESTED_ZIP_TOTAL_BYTES = 50 * MIB;
/** Compressed bytes asked of storage at a time while an entry streams. */
export const ZIP_PIECE_BYTES = MIB;
/** Small reads (headers, small entries) are served from a window of this size. */
export const ZIP_WINDOW_BYTES = 256 * KIB;
/** A ZIP entry's path, as stored and shown to the organization. */
export const ENTRY_PATH_CHARS = 300;
/** Families listed on a ZIP's report. */
export const MAX_REPORTED_FAMILIES = 50;
/** tw_file_entries rows written per insert. */
export const ENTRY_BATCH = 500;

/** PDF and Word (spec 11A): buffered in the parse thread. */
export const PDF_READ_BYTES = 25 * MIB;
export const PDF_MAX_PAGES = 1000;
export const PDF_MAX_ITEMS_PER_PAGE = 20_000;
export const DOCX_READ_BYTES = 10 * MIB;
/** word/document.xml, uncompressed. */
export const DOCX_MAX_DOCUMENT_BYTES = 50 * MIB;

/**
 * TownwiseAI's read of a PDF reference item (openspec change connect-owner-calendar, design decision 9): sent to the
 * model whole, so at most this size and page count. A Word item is read up to DOCX_READ_BYTES. [CONFIRM: PDFs up to
 * 10 MB and 100 pages for TownwiseAI]
 */
export const ITEM_PDF_BYTES = 10 * MIB;
export const ITEM_PDF_PAGES = 100;
/** An item's count or text in the parse thread ends at this time limit: it runs inside a chat turn of 150 seconds. */
export const ITEM_READ_TIME_MS = 20_000;

/** The AI column step (spec 11A): calls per file, per ZIP (at most one a family of its tables) and per import. */
export const MODEL_CALLS_PER_FILE = 2;
export const MODEL_CALLS_PER_ZIP = 5;
export const MODEL_CALLS_PER_IMPORT = 20;

/**
 * Originals are deleted this long after upload by the daily sweep (FileView.rawExpiresAt); the storage lifecycle rule is
 * the backstop at 400 days. [CONFIRM: retention periods]
 */
export const RAW_RETENTION_DAYS = 365;
