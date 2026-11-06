// The parse thread (spec 11A): a node:worker_threads Worker per file, with memory and time limits (run.ts), so a file
// that would exhaust them ends the thread, not the API. The main thread feeds the file in pieces, one at a time, and
// waits for each ack. Raw rows never leave this thread: it answers with daily totals, a report of header names, row
// numbers, dates and counts, or a question whose options are header names or the location column's values.
import { parentPort } from 'node:worker_threads';

import type { ColumnChoice } from '../extract/prompt.ts';
import { readArchive } from './archive.ts';
import { CsvPushReader, detectTableDelimiter, stripBom, type Delimiter } from './csv.ts';
import type { SalesDay } from './days.ts';
import type { ChooseColumns, KeptOutcome } from './mapping.ts';
import type { FileOutcome, FileReport, ThreadIn, ThreadOut } from './run.ts';
import { dayTotals, readTable, type TableReport } from './table.ts';
import { decoderFor, detectEncoding, encodingLabel, ENCODING_PROBE_BYTES, type TextEncoding } from './text.ts';
import { readWord } from './docx.ts';
import { readPdf } from './pdf.ts';
import { readWorkbook, type Sheet } from './xlsx.ts';

const port = parentPort;
if (port === null) throw new Error('thread.ts runs only as a worker thread');

function post(message: ThreadOut): void {
  port?.postMessage(message);
}

class BadEncoding extends Error {}

let onChunk: (bytes: Uint8Array) => void = () => undefined;
let onEnd: () => void = () => undefined;
let received = 0;
let progressTotal: number | null = null;
let pagesOnly = false;
const pendingReads = new Map<number, (bytes: Buffer) => void>();
let nextReadId = 0;

const pendingChoices = new Map<number, (choice: ColumnChoice | null) => void>();

/** The AI column step, asked through the main thread: only the redacted profile leaves this thread. */
const choose: ChooseColumns = (profile) => {
  const id = nextReadId;
  nextReadId += 1;
  const answered = new Promise<ColumnChoice | null>((resolve) => { pendingChoices.set(id, resolve); });
  post({ type: 'model', id, profile });
  return answered;
};

/** A ZIP's ranged read, answered by the main thread from storage. */
function requestRange(offset: number, count: number): Promise<Buffer> {
  const id = nextReadId;
  nextReadId += 1;
  const answered = new Promise<Buffer>((resolve) => { pendingReads.set(id, resolve); });
  post({ type: 'read', id, offset, count });
  return answered;
}

port.on('message', (message: ThreadIn) => {
  if (message.type === 'choice') {
    pendingChoices.get(message.id)?.(message.choice);
    pendingChoices.delete(message.id);
    return;
  }
  if (message.type === 'bytes') {
    const bytes = Buffer.from(message.data);
    received += bytes.length;
    // A ZIP's entries are each read twice (once to find the tables' headers, once to add their rows up).
    post({ type: 'progress', done: Math.min(received, progressTotal ?? received), total: progressTotal });
    pendingReads.get(message.id)?.(bytes);
    pendingReads.delete(message.id);
    return;
  }
  if (message.type === 'begin') {
    progressTotal = message.kind === 'text' || message.kind === 'zip' ? message.sizeBytes * 2 : null;
    pagesOnly = message.kind === 'pdf';
    void run(message).then((outcome) => { post({ type: 'result', outcome }); });
    return;
  }
  if (message.type === 'chunk') {
    const bytes = new Uint8Array(message.data);
    received += bytes.length;
    onChunk(bytes);
    // A PDF's progress is in pages, once it is read; the bytes it arrives in are not counted.
    if (!pagesOnly) post({ type: 'progress', done: received, total: progressTotal });
    post({ type: 'ack' });
    return;
  }
  onEnd();
});

function concat(parts: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(parts);
}

/** Two passes over a streamed text file, decoding and tokenizing as the pieces arrive. */
async function readText(begin: Extract<ThreadIn, { type: 'begin' }>): Promise<FileOutcome> {
  // Set by the first piece of the first pass; a holder, because the passes set it from inside callbacks.
  const found: { encoding: TextEncoding | null; delimiter: Delimiter } = { encoding: null, delimiter: ',' };
  let passes = 0;
  let failed = false;
  const pass = (visit: (cells: readonly string[]) => void): Promise<void> => new Promise((resolve, reject) => {
    passes += 1;
    if (passes > 1) post({ type: 'again' });
    let decoder: TextDecoder | null = null;
    let reader: CsvPushReader | null = null;
    let probe: Uint8Array[] = [];
    let probeBytes = 0;
    const begin = (bytes: Uint8Array): void => {
      found.encoding ??= detectEncoding(bytes);
      decoder = decoderFor(found.encoding);
      const text = stripBom(decoder.decode(bytes, { stream: true }));
      if (passes === 1) found.delimiter = detectTableDelimiter(text);
      reader = new CsvPushReader(found.delimiter, (fields) => { visit(fields); });
      reader.push(text);
    };
    const guard = (step: () => void): void => {
      if (failed) return;
      try {
        step();
      } catch (err) {
        failed = true;
        reject(err instanceof TypeError ? new BadEncoding() : err instanceof Error ? err : new Error('read failed'));
      }
    };
    onChunk = (bytes) => {
      guard(() => {
        if (decoder !== null && reader !== null) {
          reader.push(decoder.decode(bytes, { stream: true }));
          return;
        }
        probe.push(bytes);
        probeBytes += bytes.length;
        if (probeBytes >= ENCODING_PROBE_BYTES) {
          begin(concat(probe));
          probe = [];
        }
      });
    };
    onEnd = () => {
      guard(() => {
        if (decoder === null) begin(concat(probe));
        const finalDecoder: TextDecoder | null = decoder;
        const finalReader: CsvPushReader | null = reader;
        if (finalDecoder !== null && finalReader !== null) {
          finalReader.push(finalDecoder.decode());
          finalReader.end();
        }
        resolve();
      });
    };
  });
  try {
    const outcome = await readTable(pass, {
      answers: begin.answers['0'] ?? {}, locationName: begin.locationName, latest: begin.latest, delimiter: () => found.delimiter, choose,
    });
    if (outcome.kind === 'kept') return { kind: 'kept', outcome: outcome.outcome, report: null };
    if (outcome.kind === 'question') return { kind: 'question', question: { ...outcome.question, sheet: 0 } };
    return {
      kind: 'days',
      days: outcome.days,
      report: { ...outcome.report, sheets: [], encoding: found.encoding === null ? null : encodingLabel(found.encoding) },
    };
  } catch (err) {
    if (err instanceof BadEncoding) return { kind: 'kept', outcome: 'bad_encoding', report: null };
    throw err;
  }
}

/** Days of several sheets as one file: a later sheet's day replaces an earlier one's only for an org admin's file. */
function merge(target: Map<string, SalesDay>, days: readonly SalesDay[], replace: boolean): void {
  for (const day of days) if (replace || !target.has(day.date)) target.set(day.date, day);
}

/** The whole file, fed in pieces (a workbook, a PDF or a Word document). */
function wholeFile(): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  return new Promise<Buffer>((resolve) => {
    onChunk = (bytes) => { parts.push(bytes); };
    onEnd = () => { resolve(Buffer.concat(parts)); };
  });
}

/** A buffered file's tables: a workbook's sheets, a PDF's tables or a Word document's. */
async function tablesOf(begin: Extract<ThreadIn, { type: 'begin' }>): Promise<{ kind: 'tables'; tables: Sheet[] } | { kind: 'kept'; outcome: KeptOutcome }> {
  const whole = await wholeFile();
  if (begin.kind === 'pdf') {
    return readPdf(whole, (done, total) => { post({ type: 'progress', done, total }); });
  }
  if (begin.kind === 'docx') return readWord(whole);
  const workbook = await readWorkbook(whole);
  return workbook.kind === 'kept' ? workbook : { kind: 'tables', tables: workbook.sheets };
}

/**
 * Every sheet (or table) is a table of its own; the ones that map to sales are used, in order. A question names the
 * sheet by its index.
 */
async function readSheets(begin: Extract<ThreadIn, { type: 'begin' }>): Promise<FileOutcome> {
  const found = await tablesOf(begin);
  if (found.kind === 'kept') return { kind: 'kept', outcome: found.outcome, report: null };
  const workbook = { sheets: found.tables };
  const sheets: FileReport['sheets'] = [];
  const days = new Map<string, SalesDay>();
  let primary: TableReport | null = null;
  let rows = 0;
  let firstOutcome: KeptOutcome | null = null;
  for (const [index, sheet] of workbook.sheets.entries()) {
    if (sheet.rows.every((row) => row.every((cell) => cell.trim() === ''))) {
      sheets.push({ name: sheet.name, used: false, why: 'empty' });
      continue;
    }
    const outcome = await readTable(
      (visit) => { for (const row of sheet.rows) visit(row); return Promise.resolve(); },
      { answers: begin.answers[String(index)] ?? {}, locationName: begin.locationName, latest: begin.latest, delimiter: () => ',', choose },
    );
    if (outcome.kind === 'question') return { kind: 'question', question: { ...outcome.question, sheet: index } };
    if (outcome.kind === 'kept') {
      sheets.push({ name: sheet.name, used: false, why: outcome.outcome });
      firstOutcome ??= outcome.outcome;
      continue;
    }
    sheets.push({ name: sheet.name, used: true, why: 'sales' });
    primary ??= outcome.report;
    rows += outcome.report.rows;
    merge(days, outcome.days, begin.replace);
  }
  if (primary === null) return { kind: 'kept', outcome: firstOutcome ?? 'not_a_table', report: null };
  const merged = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { kind: 'days', days: merged, report: { ...primary, ...dayTotals(merged), rows, sheets, encoding: null } };
}

/** A ZIP, read in place through ranged reads. */
async function readZipFile(begin: Extract<ThreadIn, { type: 'begin' }>): Promise<FileOutcome> {
  const outcome = await readArchive(requestRange, begin.sizeBytes, {
    answers: begin.answers, locationName: begin.locationName, latest: begin.latest, choose,
  });
  if (outcome.kind === 'question') return outcome;
  if (outcome.kind === 'kept') return { kind: 'kept', outcome: outcome.outcome, report: null, entries: outcome.entries };
  return { kind: 'days', days: outcome.days, report: { ...outcome.report, sheets: [], encoding: null }, entries: outcome.entries };
}

function run(begin: Extract<ThreadIn, { type: 'begin' }>): Promise<FileOutcome> {
  if (begin.kind === 'zip') return readZipFile(begin);
  return begin.kind === 'text' ? readText(begin) : readSheets(begin);
}
