import { CsvReader, detectDelimiter, stripBom } from './csv';

// One read of a file's text, in slices: it reads records until about `sliceMs` has passed, then awaits `pause`
// so the browser can paint and take input, and stops when the read is no longer wanted. A 50 MB file never holds
// the page for more than a slice.

export interface Visitor {
  /** The first record (row 1), or null for an empty file. False stops the read. */
  header: (cells: string[] | null) => boolean;
  /** A record after the header, with its row number. False stops the read. */
  row: (cells: string[], row: number) => boolean;
}

export interface ScanOptions {
  /** Resolves when the page may continue. */
  pause: () => Promise<void>;
  /** True once the read is no longer wanted: another file, Back, or leaving the page. */
  cancelled: () => boolean;
  sliceMs?: number;
  now?: () => number;
}

export type ScanOutcome = 'cancelled' | { unterminated: boolean };

/** Hands the browser its turn. */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

export async function scanText(text: string, visit: Visitor, options: ScanOptions): Promise<ScanOutcome> {
  if (options.cancelled()) return 'cancelled';
  const clean = stripBom(text);
  const reader = new CsvReader(clean, detectDelimiter(clean));
  if (!visit.header(reader.next())) return { unterminated: reader.unterminated };
  const now = options.now ?? (() => Date.now());
  const slice = options.sliceMs ?? 12;
  let deadline = now() + slice;
  let row = 1;
  for (let cells = reader.next(); cells !== null; cells = reader.next()) {
    row += 1;
    if (!visit.row(cells, row)) break;
    if (row % 256 === 0 && now() >= deadline) {
      await options.pause();
      if (options.cancelled()) return 'cancelled';
      deadline = now() + slice;
    }
  }
  return options.cancelled() ? 'cancelled' : { unterminated: reader.unterminated };
}
