// A stored ZIP, read in place inside the parse thread (spec 11A): the central directory by ranged reads, the archive
// guards before anything is inflated, then each entry as a file of its own (its kind from its name and first bytes),
// its tables read as families (families.ts). A ZIP inside the ZIP is opened from memory; one inside that is not opened.
// For a ZIP someone let TownwiseAI read (spec 11A.9), readArchiveText makes its entries text behind the same guards.
// Entry paths are the organization's data: they go back to the main thread only to be listed for the organization,
// never to a log or a model.
import type { FileAnswers, FileKind } from '../../stores/files.ts';
import {
  DOCX_READ_BYTES, ENTRY_PATH_CHARS, HEAD_BYTES, NESTED_ZIP_BYTES, PDF_READ_BYTES, NESTED_ZIP_TOTAL_BYTES, XLSX_READ_BYTES, ZIP_MAX_DECLARED_BYTES,
  ZIP_MAX_DIRECTORY_BYTES, ZIP_MAX_ENTRIES, ZIP_MAX_RATIO, ZIP_PIECE_BYTES, ZIP_RATIO_FLOOR_BYTES, ZIP_WINDOW_BYTES,
} from '../limits.ts';
import { sniff } from '../sniff.ts';
import {
  bufferRead, dataLimits, entryBuffer, entryBytes, guardZip, readZip, ZipDamagedError, ZipFormatError,
  type RangeRead, type ZipEntry, type ZipListing,
} from '../zip.ts';
import { CsvPushReader, detectTableDelimiter, stripBom, type Delimiter } from './csv.ts';
import { readFamilies, TableKept, type FamilyQuestion, type FamilyReport, type TableSource } from './families.ts';
import type { SalesDay } from './days.ts';
import type { ChooseColumns, KeptOutcome } from './mapping.ts';
import type { TableReport } from './table.ts';
import { decoderFor, detectEncoding, ENCODING_PROBE_BYTES, type TextEncoding } from './text.ts';
import { readWord } from './docx.ts';
import { readPdf } from './pdf.ts';
import { readWorkbook, type Sheet } from './xlsx.ts';

/** Why one entry was not used: the kept codes, and four of its own. */
export type EntryOutcome = KeptOutcome | 'system_file' | 'nested_zip' | 'zip_method' | 'other_table_used' | 'internal';

/** One row of tw_file_entries (spec 6.18), as the thread reports it. */
export interface EntryRow {
  index: number;
  path: string;
  depth: 1 | 2;
  kind: FileKind;
  sizeBytes: number;
  status: 'used' | 'kept' | 'failed';
  outcome: EntryOutcome | null;
  family: string | null;
}

export type ArchiveOutcome =
  | { kind: 'kept'; outcome: KeptOutcome; entries: EntryRow[] }
  | { kind: 'question'; question: FamilyQuestion }
  | { kind: 'days'; days: SalesDay[]; report: TableReport & { families: FamilyReport[] }; entries: EntryRow[] };

/** The archive as a whole is distrusted: nothing from it is used. */
class ArchiveRefused extends Error {
  readonly outcome: KeptOutcome;
  constructor(outcome: KeptOutcome) {
    super(outcome);
    this.name = 'ArchiveRefused';
    this.outcome = outcome;
  }
}

/** A ZIP entry's path as stored: control characters removed, NFC, at most 300 characters. */
export function sanitizeEntryPath(raw: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').normalize('NFC').slice(0, ENTRY_PATH_CHARS);
}

function isSystemFile(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.includes('/__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store');
}

/**
 * Small reads (local headers, small entries) served from one window, so a ZIP of thousands of tiny files is not
 * thousands of storage requests per pass. Reads at least as large as the window go straight through.
 */
export function windowed(read: RangeRead, size: number, window = ZIP_WINDOW_BYTES): RangeRead {
  let start = -1;
  let bytes: Buffer = Buffer.alloc(0);
  return async (offset, count) => {
    if (count >= window) return read(offset, count);
    if (start < 0 || offset < start || offset + count > start + bytes.length) {
      start = offset;
      bytes = await read(offset, Math.min(window, size - offset));
    }
    return bytes.subarray(offset - start, offset - start + count);
  };
}

/** Where an entry's bytes come from: the stored archive, or a ZIP inside it held in memory. */
interface Source { readonly read: RangeRead; readonly limits: Map<ZipEntry, number> }

function bytesOf(source: Source, entry: ZipEntry): AsyncGenerator<Buffer> {
  return entryBytes(source.read, entry, source.limits.get(entry) ?? 0, ZIP_PIECE_BYTES);
}

/** An entry's whole bytes; an overrun distrusts the archive, other damage keeps the entry. */
async function wholeOf(source: Source, entry: ZipEntry): Promise<Buffer> {
  try {
    return await entryBuffer(source.read, entry, source.limits.get(entry) ?? 0, ZIP_PIECE_BYTES);
  } catch (err) {
    if (err instanceof ZipDamagedError) {
      if (err.overrun) throw new ArchiveRefused('zip_damaged');
      throw new TableKept('zip_damaged');
    }
    throw err;
  }
}

/** An entry's first `max` bytes (its head, by default); damage as wholeOf. */
async function headOf(source: Source, entry: ZipEntry, max = HEAD_BYTES): Promise<Buffer> {
  const parts: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const part of bytesOf(source, entry)) {
      parts.push(part);
      bytes += part.length;
      if (bytes >= max) break;
    }
  } catch (err) {
    if (err instanceof ZipDamagedError) {
      if (err.overrun) throw new ArchiveRefused('zip_damaged');
      throw new TableKept('zip_damaged');
    }
    throw err;
  }
  return Buffer.concat(parts).subarray(0, max);
}

/** A text entry's records, decoded as a text file is (UTF-16 by mark, else strict UTF-8, else windows-1252). */
function textTable(source: Source, entry: ZipEntry): TableSource {
  const found: { encoding: TextEncoding | null; delimiter: Delimiter | null } = { encoding: null, delimiter: null };
  return {
    delimiter: () => found.delimiter ?? ',',
    async visit(visit) {
      const state: { decoder: TextDecoder | null; reader: CsvPushReader | null; probe: Buffer[]; probed: number } = {
        decoder: null, reader: null, probe: [], probed: 0,
      };
      const begin = (bytes: Buffer): void => {
        found.encoding ??= detectEncoding(bytes);
        const decoder = decoderFor(found.encoding);
        const text = stripBom(decoder.decode(bytes, { stream: true }));
        found.delimiter ??= detectTableDelimiter(text);
        const reader = new CsvPushReader(found.delimiter, (fields) => { visit(fields); });
        reader.push(text);
        state.decoder = decoder;
        state.reader = reader;
      };
      try {
        for await (const part of bytesOf(source, entry)) {
          if (state.decoder !== null && state.reader !== null) {
            state.reader.push(state.decoder.decode(part, { stream: true }));
            continue;
          }
          state.probe.push(part);
          state.probed += part.length;
          if (state.probed >= ENCODING_PROBE_BYTES) {
            begin(Buffer.concat(state.probe));
            state.probe = [];
          }
        }
        if (state.decoder === null) begin(Buffer.concat(state.probe));
        state.reader?.push(state.decoder?.decode() ?? '');
        state.reader?.end();
      } catch (err) {
        if (err instanceof ZipDamagedError) {
          if (err.overrun) throw new ArchiveRefused('zip_damaged');
          throw new TableKept('zip_damaged');
        }
        if (err instanceof TypeError) throw new TableKept('bad_encoding');
        throw err;
      }
    },
  };
}

type Tables = { kind: 'tables'; tables: Sheet[] } | { kind: 'kept'; outcome: KeptOutcome };

/** A buffered entry's tables: a workbook's sheets, a PDF's tables or a Word document's. */
async function tablesOfEntry(kind: 'xlsx' | 'pdf' | 'docx', bytes: Buffer): Promise<Tables> {
  if (kind === 'pdf') return readPdf(bytes);
  if (kind === 'docx') return readWord(bytes);
  const book = await readWorkbook(bytes);
  return book.kind === 'kept' ? book : { kind: 'tables', tables: book.sheets };
}

/** Each table of a buffered entry, read again from the entry for each pass (one entry's tables are held at a time). */
function bufferedTables(
  source: Source, entry: ZipEntry, kind: 'xlsx' | 'pdf' | 'docx', count: number, cache: { entry: ZipEntry | null; tables: Sheet[] },
): TableSource[] {
  const tables = async (): Promise<Sheet[]> => {
    if (cache.entry !== entry) {
      const found = await tablesOfEntry(kind, await wholeOf(source, entry));
      if (found.kind === 'kept') throw new TableKept(found.outcome);
      cache.entry = entry;
      cache.tables = found.tables;
    }
    return cache.tables;
  };
  return Array.from({ length: count }, (_, index): TableSource => ({
    delimiter: () => ',',
    async visit(visit) {
      for (const row of (await tables())[index]?.rows ?? []) visit(row);
    },
  }));
}

const READ_CAPS = { xlsx: XLSX_READ_BYTES, pdf: PDF_READ_BYTES, docx: DOCX_READ_BYTES } as const;

interface Planned {
  readonly row: EntryRow;
  /** Indexes into the tables list. */
  readonly tables: number[];
}

const GUARD_LIMITS = { maxDeclaredBytes: ZIP_MAX_DECLARED_BYTES, maxRatio: ZIP_MAX_RATIO, ratioFloorBytes: ZIP_RATIO_FLOOR_BYTES };

async function listingOf(read: RangeRead, size: number, maxEntries: number): Promise<ZipListing> {
  try {
    return await readZip(read, size, { maxEntries, maxDirectoryBytes: ZIP_MAX_DIRECTORY_BYTES });
  } catch (err) {
    if (err instanceof ZipFormatError) {
      throw new ArchiveRefused(err.message.includes('too many entries') || err.message.includes('directory too big') ? 'zip_too_big' : 'zip_damaged');
    }
    throw err;
  }
}

/** Reads the stored ZIP of `size` bytes through `read`. */
export async function readArchive(
  read: RangeRead, size: number, input: { answers: FileAnswers; locationName: string; latest: string; choose?: ChooseColumns },
): Promise<ArchiveOutcome> {
  const planned: Planned[] = [];
  const tables: TableSource[] = [];
  const cache = { entry: null as ZipEntry | null, tables: [] as Sheet[] };
  let declared = 0;
  let entryCount = 0;
  let nestedBytes = 0;

  const plan = async (source: Source, entry: ZipEntry, path: string, depth: 1 | 2): Promise<void> => {
    const row: EntryRow = {
      index: planned.length, path: sanitizeEntryPath(path), depth, kind: 'other', sizeBytes: entry.uncompressedSize,
      status: 'kept', outcome: null, family: null,
    };
    const item: Planned = { row, tables: [] };
    planned.push(item);
    const keep = (outcome: EntryOutcome, kind?: FileKind): void => {
      row.outcome = outcome;
      if (kind !== undefined) row.kind = kind;
    };
    if (isSystemFile(path)) { keep('system_file'); return; }
    if ((entry.flags & 1) !== 0) { keep('encrypted'); return; }
    if (entry.method !== 0 && entry.method !== 8) { keep('zip_method'); return; }
    let head: Buffer;
    try {
      head = await headOf(source, entry);
    } catch (err) {
      if (err instanceof TableKept) { keep(err.outcome); return; }
      throw err;
    }
    const sniffed = sniff(path, head);
    row.kind = sniffed.kind;
    if (sniffed.outcome !== null) { keep(sniffed.outcome); return; }
    switch (sniffed.kind) {
      case 'text':
        item.tables.push(tables.length);
        tables.push(textTable(source, entry));
        return;
      case 'xlsx': case 'pdf': case 'docx': {
        const kind = sniffed.kind;
        if (entry.uncompressedSize > READ_CAPS[kind]) { keep('too_large_to_read'); return; }
        let found: Tables;
        try {
          found = await tablesOfEntry(kind, await wholeOf(source, entry));
        } catch (err) {
          if (err instanceof TableKept) { keep(err.outcome); return; }
          throw err;
        }
        if (found.kind === 'kept') { keep(found.outcome); return; }
        cache.entry = entry;
        cache.tables = found.tables;
        for (const table of bufferedTables(source, entry, kind, found.tables.length, cache)) {
          item.tables.push(tables.length);
          tables.push(table);
        }
        return;
      }
      case 'zip': {
        if (depth === 2) { keep('nested_zip'); return; }
        if (entry.uncompressedSize > NESTED_ZIP_BYTES || nestedBytes + entry.uncompressedSize > NESTED_ZIP_TOTAL_BYTES) {
          keep('too_large_to_read'); return;
        }
        let inner: Buffer;
        try {
          inner = await wholeOf(source, entry);
        } catch (err) {
          if (err instanceof TableKept) { keep(err.outcome); return; }
          throw err;
        }
        nestedBytes += inner.length;
        const innerRead = bufferRead(inner);
        const listing = await listingOf(innerRead, inner.length, ZIP_MAX_ENTRIES - entryCount);
        const guard = guardZip(listing, inner.length, GUARD_LIMITS, declared);
        if (guard !== null) throw new ArchiveRefused(guard);
        declared += listing.entries.reduce((sum, child) => sum + child.uncompressedSize, 0);
        entryCount += listing.entries.length;
        if (entryCount > ZIP_MAX_ENTRIES) throw new ArchiveRefused('zip_too_big');
        row.outcome = 'nothing_usable';
        const nested: Source = { read: innerRead, limits: dataLimits(listing) };
        for (const child of listing.entries) {
          if (child.name.endsWith('/')) continue;
          await plan(nested, child, `${path}/${child.name}`, 2);
        }
        return;
      }
      default:
        { keep('type_not_read'); return; }
    }
  };

  try {
    const cached = windowed(read, size);
    const listing = await listingOf(cached, size, ZIP_MAX_ENTRIES);
    const guard = guardZip(listing, size, GUARD_LIMITS);
    if (guard !== null) return { kind: 'kept', outcome: guard, entries: [] };
    declared = listing.entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    entryCount = listing.entries.length;
    const outer: Source = { read: cached, limits: dataLimits(listing) };
    for (const entry of listing.entries) {
      if (entry.name.endsWith('/')) continue;
      await plan(outer, entry, entry.name, 1);
    }
    if (planned.length === 0) return { kind: 'kept', outcome: 'zip_empty', entries: [] };

    const result = await readFamilies(tables, input);
    if (result.kind === 'question') return result;
    const entries = planned.map(({ row, tables: own }) => {
      if (own.length === 0) return row;
      const fates = own.map((table) => result.fates[table]);
      const used = fates.find((fate) => fate?.used === true);
      const first = fates[0];
      return {
        ...row,
        status: used === undefined ? 'kept' : 'used',
        outcome: used === undefined ? first?.outcome ?? 'not_a_table' : null,
        family: (used ?? first)?.family ?? null,
      } satisfies EntryRow;
    });
    // A nested ZIP is used when any entry inside it is.
    for (const [index, row] of entries.entries()) {
      if (row.kind !== 'zip' || row.outcome !== 'nothing_usable') continue;
      const inside = entries.filter((child) => child.depth === 2 && child.path.startsWith(`${row.path}/`));
      if (inside.some((child) => child.status === 'used')) entries[index] = { ...row, status: 'used', outcome: null };
    }
    if (result.report === null || result.days.length === 0) {
      return { kind: 'kept', outcome: result.kept ?? 'nothing_usable', entries };
    }
    return { kind: 'days', days: result.days, report: { ...result.report, families: result.families }, entries };
  } catch (err) {
    if (err instanceof ArchiveRefused) return { kind: 'kept', outcome: err.outcome, entries: [] };
    throw err;
  }
}

/** The kinds of entry readArchiveText makes text of, and the words its label gives each. */
export type ArchiveTextKind = 'text' | 'xlsx' | 'docx' | 'pdf';

const ENTRY_WORDS: Readonly<Record<ArchiveTextKind, string>> = {
  text: 'a text file', xlsx: 'an Excel workbook', docx: 'a Word document', pdf: 'a PDF document, as its text',
};

/** One entry handed to readArchiveText's `textOf`: its bytes, and `more` when a text entry was read only in part. */
export interface ArchiveTextEntry { readonly kind: ArchiveTextKind; readonly bytes: Buffer; readonly more: boolean }

export type ArchiveText =
  | { readonly kind: 'text'; readonly text: string; readonly source: string; readonly cut: boolean; readonly read: number; readonly skipped: number }
  | { readonly kind: 'kept'; readonly outcome: 'too_large' | 'not_readable' | 'encrypted' | 'kind_not_read' };

function isTextKind(kind: FileKind): kind is ArchiveTextKind {
  return kind === 'text' || kind === 'xlsx' || kind === 'docx' || kind === 'pdf';
}

/**
 * Reading with TownwiseAI (spec 11A.9): a ZIP's top-level entries as one text, behind readArchive's listing and guards.
 * Each text, CSV or TSV file, workbook, Word document or PDF (a workbook, document or PDF within READ_CAPS) becomes text
 * through `textOf` under an "Entry n (what it is):" line, never its path. At most `maxEntries` are read, and the text
 * stops at `maxChars` (`cut`); a text entry is read only as far as the characters left could need. System files are
 * passed over. Pictures, other kinds, a ZIP inside, encrypted, damaged or empty entries are counted as `skipped`, and so
 * is every entry after the text is full or the last entry is read, which also makes it `cut`. `source` is the entries'
 * texts without their labels. An archive the guards refuse is `too_large` (too big) or `not_readable`; one with no entry
 * read is `encrypted` when every entry was, else `kind_not_read`.
 */
export async function readArchiveText(read: RangeRead, size: number, input: {
  maxChars: number; maxEntries: number;
  textOf: (entry: ArchiveTextEntry, maxChars: number) => Promise<{ text: string; cut: boolean } | null>;
}): Promise<ArchiveText> {
  const parts: string[] = [];
  const sources: string[] = [];
  let length = 0;
  let skipped = 0;
  let encrypted = 0;
  let considered = 0;
  let cut = false;
  const refused = (outcome: KeptOutcome): ArchiveText => ({ kind: 'kept', outcome: outcome === 'zip_too_big' ? 'too_large' : 'not_readable' });
  try {
    const listing = await listingOf(read, size, ZIP_MAX_ENTRIES);
    const guard = guardZip(listing, size, GUARD_LIMITS);
    if (guard !== null) return refused(guard);
    const source: Source = { read, limits: dataLimits(listing) };
    for (const entry of listing.entries) {
      if (entry.name.endsWith('/') || isSystemFile(entry.name)) continue;
      considered += 1;
      if (parts.length >= input.maxEntries || length >= input.maxChars) {
        skipped += 1;
        cut = true;
        continue;
      }
      if ((entry.flags & 1) !== 0 || (entry.method !== 0 && entry.method !== 8)) {
        if ((entry.flags & 1) !== 0) encrypted += 1;
        skipped += 1;
        continue;
      }
      const made = await entryText(source, entry, parts.length, input.maxChars - length, input.textOf);
      if (made === 'encrypted') encrypted += 1;
      if (typeof made === 'string') {
        if (made === 'full') cut = true;
        skipped += 1;
        continue;
      }
      parts.push(made.label + made.text);
      sources.push(made.text);
      length += made.label.length + made.text.length;
      if (made.cut) cut = true;
    }
  } catch (err) {
    if (err instanceof ArchiveRefused) return refused(err.outcome);
    throw err;
  }
  if (parts.length === 0) return { kind: 'kept', outcome: considered > 0 && encrypted === considered ? 'encrypted' : 'kind_not_read' };
  return { kind: 'text', text: parts.join(''), source: sources.join('\n'), cut, read: parts.length, skipped };
}

/** One entry's label and text, or why it was skipped: `full` when no room is left for any of its text. */
async function entryText(
  source: Source, entry: ZipEntry, index: number, room: number,
  textOf: (entry: ArchiveTextEntry, maxChars: number) => Promise<{ text: string; cut: boolean } | null>,
): Promise<{ label: string; text: string; cut: boolean } | 'skip' | 'encrypted' | 'full'> {
  try {
    const sniffed = sniff(entry.name, await headOf(source, entry));
    if (sniffed.outcome === 'encrypted') return 'encrypted';
    const kind = sniffed.kind;
    if (sniffed.outcome !== null || !isTextKind(kind)) return 'skip';
    if (kind !== 'text' && entry.uncompressedSize > READ_CAPS[kind]) return 'skip';
    const label = `${index === 0 ? '' : '\n\n'}Entry ${String(index + 1)} (${ENTRY_WORDS[kind]}):\n`;
    const left = room - label.length;
    if (left <= 0) return 'full';
    // A text entry is read as far as the characters left could need: four bytes a character at most, and a mark.
    const want = kind === 'text' ? Math.min(entry.uncompressedSize, left * 4 + 4) : entry.uncompressedSize;
    const bytes = want < entry.uncompressedSize ? await headOf(source, entry, want) : await wholeOf(source, entry);
    const made = await textOf({ kind, bytes, more: bytes.length < entry.uncompressedSize }, left);
    if (made === null || made.text.trim() === '') return 'skip';
    return { label, text: made.text, cut: made.cut };
  } catch (err) {
    if (err instanceof TableKept) return 'skip';
    throw err;
  }
}
