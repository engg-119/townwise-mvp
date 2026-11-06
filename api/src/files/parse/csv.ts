// Ported from client/src/portal/upload/csv.ts at commit d755b5a with unchanged logic; CsvPushReader, at the end,
// is the server's addition. The browser upload (P13)
// keeps its own copy; test/files/csv-stream.test.ts and the client's parity test hold both to the same fixtures.
// The small RFC 4180 reader of spec 11.2 step 1 (no CSV library is added): quoted fields, doubled quotes inside
// them, and CRLF, LF or a lone CR between records. The delimiter is detected from the header line. It reads one
// record at a time, so a caller can pause between batches and keep a 50 MB file from blocking the page.

export type Delimiter = ',' | ';' | '\t';

const QUOTE = 34;
const LF = 10;
const CR = 13;
const BOM = '\uFEFF';

/** The text without a leading byte-order mark. */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * The delimiter of the header line: whichever of comma, semicolon and tab appears most often outside quotes
 * before the first line break. Ties and a line with none of them read as a comma.
 */
export function detectDelimiter(text: string): Delimiter {
  let comma = 0;
  let semicolon = 0;
  let tab = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '\n' || ch === '\r') break;
    else if (ch === ',') comma += 1;
    else if (ch === ';') semicolon += 1;
    else if (ch === '\t') tab += 1;
  }
  if (semicolon > comma && semicolon >= tab) return ';';
  if (tab > comma && tab > semicolon) return '\t';
  return ',';
}

/** Reads `text` one record at a time. Row numbers count records, so the header is row 1, as a spreadsheet shows. */
export class CsvReader {
  private pos = 0;
  private readonly text: string;
  private readonly delimiter: number;
  /** True once the text ended inside a quoted field, which a well-formed CSV file never does. */
  unterminated = false;

  constructor(text: string, delimiter: Delimiter) {
    this.text = text;
    this.delimiter = delimiter.charCodeAt(0);
  }

  /** The next record's fields, or null at the end. An empty line is one empty field. */
  next(): string[] | null {
    const { text } = this;
    const end = text.length;
    if (this.pos >= end) return null;
    const fields: string[] = [];
    let i = this.pos;
    for (;;) {
      let value: string;
      if (text.charCodeAt(i) === QUOTE) {
        value = '';
        let start = i + 1;
        for (;;) {
          const close = text.indexOf('"', start);
          if (close === -1) {
            value += text.slice(start);
            this.unterminated = true;
            i = end;
            break;
          }
          if (text.charCodeAt(close + 1) === QUOTE) {
            value += text.slice(start, close + 1);
            start = close + 2;
            continue;
          }
          value += text.slice(start, close);
          i = close + 1;
          break;
        }
        // Lenient: characters between the closing quote and the delimiter stay part of the field.
        const rest = this.fieldEnd(i);
        if (rest > i) value += text.slice(i, rest);
        i = rest;
      } else {
        const stop = this.fieldEnd(i);
        value = text.slice(i, stop);
        i = stop;
      }
      fields.push(value);
      if (i >= end) {
        this.pos = end;
        return fields;
      }
      const code = text.charCodeAt(i);
      if (code === this.delimiter) {
        i += 1;
        if (i >= end) {
          fields.push('');
          this.pos = end;
          return fields;
        }
        continue;
      }
      this.pos = i + (code === CR && text.charCodeAt(i + 1) === LF ? 2 : 1);
      return fields;
    }
  }

  /** The index of the next delimiter or line break at or after `from`, or the end of the text. */
  private fieldEnd(from: number): number {
    const { text } = this;
    let i = from;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === this.delimiter || code === LF || code === CR) return i;
      i += 1;
    }
    return i;
  }
}

/** Every record of `text` (BOM stripped, delimiter detected), for small inputs and tests. */
export function parseCsv(text: string): string[][] {
  const clean = stripBom(text);
  const reader = new CsvReader(clean, detectDelimiter(clean));
  const records: string[][] = [];
  for (let record = reader.next(); record !== null; record = reader.next()) records.push(record);
  return records;
}

/** True when a record has no non-blank field (an empty line, or only delimiters). */
export function isBlankRecord(fields: readonly string[]): boolean {
  return fields.every((field) => field.trim() === '');
}

const isDelimiterCode = (code: number): boolean => code === 44 || code === 59 || code === 9;

/**
 * The delimiter of the first line (within the first 30) that holds a comma, semicolon or tab outside quotes, read as
 * detectDelimiter reads a header line, so a title block above the table does not decide it. A file whose first line
 * holds one decides exactly as the browser does.
 */
export function detectTableDelimiter(text: string): Delimiter {
  let start = 0;
  for (let line = 0; line < 30 && start < text.length; line += 1) {
    let end = start;
    let quoted = false;
    let found = false;
    for (; end < text.length; end += 1) {
      const code = text.charCodeAt(end);
      if (code === QUOTE) quoted = !quoted;
      else if (!quoted && (code === LF || code === CR)) break;
      else if (!quoted && isDelimiterCode(code)) found = true;
    }
    if (found) return detectDelimiter(text.slice(start));
    start = end + (text.charCodeAt(end) === CR && text.charCodeAt(end + 1) === LF ? 2 : 1);
  }
  return ',';
}

/**
 * CsvReader for text that arrives in pieces (spec 11A, text is streamed): push() each decoded piece and end() after the
 * last; `onRecord` sees exactly the records CsvReader yields for the whole text, however the text was cut. A record
 * is handed over only once its line break has arrived (a CR waits for the next piece in case an LF follows).
 */
export class CsvPushReader {
  private buffer = '';
  private readonly delimiter: number;
  private readonly onRecord: (fields: string[]) => void;
  unterminated = false;

  constructor(delimiter: Delimiter, onRecord: (fields: string[]) => void) {
    this.delimiter = delimiter.charCodeAt(0);
    this.onRecord = onRecord;
  }

  push(text: string): void {
    this.buffer += text;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
    this.buffer = '';
  }

  private drain(final: boolean): void {
    let pos = 0;
    for (;;) {
      const read = this.record(pos, final);
      if (read === null) break;
      this.onRecord(read.fields);
      pos = read.next;
    }
    if (pos > 0) this.buffer = this.buffer.slice(pos);
  }

  /** CsvReader.next() from `pos`; null at the end, or when more text could still change the record. */
  private record(pos: number, final: boolean): { fields: string[]; next: number } | null {
    const text = this.buffer;
    const end = text.length;
    if (pos >= end) return null;
    const fields: string[] = [];
    let i = pos;
    for (;;) {
      let value: string;
      if (text.charCodeAt(i) === QUOTE) {
        value = '';
        let start = i + 1;
        for (;;) {
          const close = text.indexOf('"', start);
          if (close === -1) {
            if (!final) return null;
            value += text.slice(start);
            this.unterminated = true;
            i = end;
            break;
          }
          // A quote at the very end may be the first of a doubled quote.
          if (close + 1 === end && !final) return null;
          if (text.charCodeAt(close + 1) === QUOTE) {
            value += text.slice(start, close + 1);
            start = close + 2;
            continue;
          }
          value += text.slice(start, close);
          i = close + 1;
          break;
        }
        const rest = this.fieldEnd(i);
        if (rest >= end && !final) return null;
        if (rest > i) value += text.slice(i, rest);
        i = rest;
      } else {
        const stop = this.fieldEnd(i);
        if (stop >= end && !final) return null;
        value = text.slice(i, stop);
        i = stop;
      }
      fields.push(value);
      if (i >= end) return { fields, next: end };
      const code = text.charCodeAt(i);
      if (code === this.delimiter) {
        i += 1;
        if (i >= end) {
          if (!final) return null;
          fields.push('');
          return { fields, next: end };
        }
        continue;
      }
      if (code === CR && i + 1 >= end && !final) return null;
      return { fields, next: i + (code === CR && text.charCodeAt(i + 1) === LF ? 2 : 1) };
    }
  }

  private fieldEnd(from: number): number {
    const text = this.buffer;
    let i = from;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === this.delimiter || code === LF || code === CR) return i;
      i += 1;
    }
    return i;
  }
}
