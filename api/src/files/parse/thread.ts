// The parse thread (spec 11A): a node:worker_threads Worker per file, with memory and time limits (run.ts), so a file
// that would exhaust them ends the thread, not the API. The main thread feeds the file in pieces, one at a time, and
// waits for each ack. Raw rows never leave this thread: it answers with daily totals, a report of header names, row
// numbers, dates and counts, or a question whose options are header names or the location column's values.
import { parentPort } from 'node:worker_threads';

import { CsvPushReader, detectTableDelimiter, stripBom, type Delimiter } from './csv.ts';
import type { SalesDay } from './days.ts';
import type { KeptOutcome } from './mapping.ts';
import type { FileOutcome, FileReport, ThreadIn, ThreadOut } from './run.ts';
import { readTable, type TableReport } from './table.ts';
import { decoderFor, detectEncoding, encodingLabel, ENCODING_PROBE_BYTES, type TextEncoding } from './text.ts';
import { readWorkbook } from './xlsx.ts';

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

port.on('message', (message: ThreadIn) => {
  if (message.type === 'begin') {
    progressTotal = message.kind === 'text' ? message.sizeBytes * 2 : null;
    void run(message).then((outcome) => { post({ type: 'result', outcome }); });
    return;
  }
  if (message.type === 'chunk') {
    const bytes = new Uint8Array(message.data);
    received += bytes.length;
    onChunk(bytes);
    post({ type: 'progress', done: received, total: progressTotal });
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
      answers: begin.answers['0'] ?? {}, locationName: begin.locationName, latest: begin.latest, delimiter: () => found.delimiter,
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

function totals(days: readonly SalesDay[]): Pick<TableReport, 'firstDate' | 'lastDate' | 'guestsDayCount' | 'netSalesDayCount' | 'closedDates' | 'missingDays' | 'days'> {
  const first = days[0]?.date ?? '';
  const last = days.at(-1)?.date ?? '';
  const span = first === '' ? 0 : (Date.parse(last) - Date.parse(first)) / 86_400_000 + 1;
  return {
    days: days.length,
    firstDate: first,
    lastDate: last,
    guestsDayCount: days.filter((day) => day.guests !== null).length,
    netSalesDayCount: days.filter((day) => day.netSalesCents !== null).length,
    closedDates: days.filter((day) => day.guests === 0 && (day.netSalesCents ?? 0) === 0).map((day) => day.date).slice(0, 60),
    missingDays: Math.max(0, span - days.length),
  };
}

/** A workbook: every sheet is a table of its own; the ones that map to sales are used, in sheet order. */
async function readXlsx(begin: Extract<ThreadIn, { type: 'begin' }>): Promise<FileOutcome> {
  const parts: Uint8Array[] = [];
  const whole = await new Promise<Buffer>((resolve) => {
    onChunk = (bytes) => { parts.push(bytes); };
    onEnd = () => { resolve(Buffer.concat(parts)); };
  });
  const workbook = await readWorkbook(whole);
  if (workbook.kind === 'kept') return { kind: 'kept', outcome: workbook.outcome, report: null };
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
      { answers: begin.answers[String(index)] ?? {}, locationName: begin.locationName, latest: begin.latest, delimiter: () => ',' },
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
  return { kind: 'days', days: merged, report: { ...primary, ...totals(merged), rows, sheets, encoding: null } };
}

function run(begin: Extract<ThreadIn, { type: 'begin' }>): Promise<FileOutcome> {
  return begin.kind === 'text' ? readText(begin) : readXlsx(begin);
}
