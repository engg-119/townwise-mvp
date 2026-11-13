import { CsvReader, detectDelimiter, stripBom, type Delimiter } from '../upload/csv';
import { ViewerError } from './errors';
import { VIEW_LIMITS } from './limits';

// A text file's bytes as text and back, and a CSV or TSV file as rows and back. Decoding makes the server's choice
// (api/src/files/parse/text.ts): UTF-16 by its byte-order mark, else strict UTF-8, else windows-1252. Saving is
// always UTF-8. Rows are read by the upload page's RFC 4180 reader and written with the file's own delimiter and line
// ending, so a file that was already quoted the canonical way comes back byte for byte.

export type { Delimiter };

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface Delimited {
  /** The records as the file has them, ragged rows included. */
  rows: string[][];
  delimiter: Delimiter;
  eol: '\r\n' | '\n';
  /** True when the file ends with a line ending. */
  trailingEol: boolean;
  /**
   * True when the file had more than VIEW_LIMITS.sheetRows records or a record with more than sheetColumns fields,
   * so `rows` holds part of it. toDelimited refuses a truncated table: saving it would drop the rest of the file.
   */
  truncated: boolean;
}

/** The text of a file, its encoding, and whether it began with a byte-order mark (which `text` does not keep). */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding; bom: boolean } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le', bom: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be', bom: true };
  try {
    // The decoder drops a leading UTF-8 byte-order mark.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8', bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', bom: false };
  }
}

/** `text` as UTF-8, after a UTF-8 byte-order mark when `bom` is true. */
export function encodeText(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/** The first line ending outside quotes; CRLF (RFC 4180's) when the text has none. */
function lineEnding(text: string): '\r\n' | '\n' {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) return ch === '\r' && text[i + 1] === '\n' ? '\r\n' : '\n';
  }
  return '\r\n';
}

/** The records of a CSV or TSV text, by `delimiter` or the one its first line uses most. */
export function parseDelimited(text: string, delimiter?: Delimiter): Delimited {
  const clean = stripBom(text);
  const used = delimiter ?? detectDelimiter(clean);
  const reader = new CsvReader(clean, used);
  const rows: string[][] = [];
  let truncated = false;
  for (let record = reader.next(); record !== null; record = reader.next()) {
    if (rows.length === VIEW_LIMITS.sheetRows) {
      truncated = true;
      break;
    }
    if (record.length > VIEW_LIMITS.sheetColumns) {
      truncated = true;
      rows.push(record.slice(0, VIEW_LIMITS.sheetColumns));
    } else rows.push(record);
  }
  const trailingEol = !reader.unterminated && (clean.endsWith('\n') || clean.endsWith('\r'));
  return { rows, delimiter: used, eol: lineEnding(clean), trailingEol, truncated };
}

function field(value: string, delimiter: Delimiter): string {
  const quote = value.includes(delimiter) || /["\r\n]/.test(value) || /^[ \t]|[ \t]$/.test(value);
  return quote ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The rows as CSV or TSV text: a field is quoted when it holds the delimiter, a quote, CR or LF, or starts or ends
 * with a space or tab; the table's delimiter and line ending; a final line ending only when `trailingEol`.
 */
export function toDelimited(table: Delimited): string {
  if (table.truncated) throw new ViewerError('too_big', 'truncated table');
  const lines = table.rows.map((row) => row.map((value) => field(value, table.delimiter)).join(table.delimiter));
  return lines.join(table.eol) + (table.trailingEol && lines.length > 0 ? table.eol : '');
}
