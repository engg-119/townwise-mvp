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
/** A Toast Sales Summary has 22 sheets, its daily one the 20th. */
export const MAX_SHEETS = 30;
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
 * TownwiseAI attachments (spec D36): the largest picture sent to the model, 3.75 MB, so its base64 (4 characters for
 * every 3 bytes) stays within the API's 5 MB an image. [CONFIRM: at most 5 a message, 20,000 characters, 3.75 MB a
 * picture, about 150k tokens in all]
 */
export const MODEL_PICTURE_BYTES = 3_750_000;
/** The most pixels on a side of a picture sent to the model: the API refuses a larger one, and the turn would fail. */
export const MODEL_PICTURE_MAX_SIDE = 8_000;

/** The AI column step (spec 11A): calls per file, per ZIP (at most one a family of its tables) and per import. */
export const MODEL_CALLS_PER_FILE = 2;
export const MODEL_CALLS_PER_ZIP = 5;
export const MODEL_CALLS_PER_IMPORT = 20;

/**
 * Reading with TownwiseAI (spec 11A.9, D34), a file the person opted in: a PDF is sent whole as a document up to 10 MiB
 * and 600 pages (the API's limit), a PNG, JPEG, GIF or WebP picture up to 3,750,000 bytes (so its base64 stays within
 * the API's 5 MB), and any other file the reader reads as text, cut at 300,000 characters (marked partial, and the
 * prompt says so). A text file is read from storage only as far as that many characters can take (4 bytes a character
 * at most). A PDF's own text, kept in memory to check figures against and never stored, stops at 400,000 characters.
 * Making text takes a thread of its own with a smaller heap than the sales parse thread's (it stops once it has the
 * characters it needs), at most 2 minutes, and a Word document whose word/document.xml is over 8 MiB is skipped
 * `too_large`; past the heap or the time the read is skipped `too_complex`.
 */
export const AI_PDF_BYTES = 10 * MIB;
export const AI_PDF_PAGES = 600;
export const AI_IMAGE_BYTES = 3_750_000;
export const AI_TEXT_CHARS = 300_000;
export const AI_TEXT_READ_BYTES = AI_TEXT_CHARS * 4;
export const AI_SOURCE_CHARS = 400_000;
export const AI_TEXT_TIME_MS = 2 * 60 * 1000;
export const AI_DOCX_DOCUMENT_BYTES = 8 * MIB;
/** The AI text thread's memory (MiB): smaller than THREAD_LIMITS, since it keeps at most AI_SOURCE_CHARS of text. */
export const AI_THREAD_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } as const;
/**
 * A read whose attempt stopped (a failed call, an error) waits before it is claimed again: 1 minute after the first
 * attempt, then 2, then 4 (doubling).
 */
export const AI_RETRY_BASE_MS = 60 * 1000;
/** Reads one organization may have queued or reading at once; one more is refused 429 `ai_read_queue_full`. */
export const AI_READS_IN_FLIGHT = 10;
/**
 * A ZIP is read whole into the AI text thread up to 25 MiB, behind the archive guards; at most its first 20 entries
 * that are text, CSV or TSV, workbooks, Word documents or PDFs become text (within 300,000 characters together), each
 * within the reader's caps for its kind. Pictures and other kinds inside are counted and skipped.
 */
export const AI_ZIP_BYTES = 25 * MIB;
export const AI_ZIP_ENTRIES = 20;

/**
 * Originals are deleted this long after upload by the daily sweep (FileView.rawExpiresAt); the storage lifecycle rule is
 * the backstop at 400 days. [CONFIRM: retention periods]
 */
export const RAW_RETENTION_DAYS = 365;
