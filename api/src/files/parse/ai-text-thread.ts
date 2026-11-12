// The thread that makes a file's text for reading with TownwiseAI (spec 11A.9), run by ai-text.ts with memory and time
// limits, one file per thread. It is sent one file whole and answers once: a PDF's lines (pdf.ts, readPdfText), a
// workbook's sheets as tab-separated rows under a "Sheet: <name>" line (xlsx.ts, readWorkbook, within its limits), a
// Word document's paragraphs and tables (docx.ts, readWordText), or a ZIP's entries, each of those or a text file,
// under an "Entry n" line (archive.ts, readArchiveText, behind the archive guards). Only files the person opted in
// reach it.
import { parentPort } from 'node:worker_threads';

import { AI_ZIP_ENTRIES } from '../limits.ts';
import { bufferRead } from '../zip.ts';
import type { AiTextIn, AiTextOutcome } from './ai-text.ts';
import { capText, textFileText } from './ai-text.ts';
import { readArchiveText, type ArchiveTextEntry } from './archive.ts';
import { readWordText } from './docx.ts';
import { readPdfText } from './pdf.ts';
import { readWorkbook } from './xlsx.ts';

const port = parentPort;
if (port === null) throw new Error('ai-text-thread.ts runs only as a worker thread');

/** A workbook's sheets as text, stopping once `maxChars` is reached. */
function workbookText(sheets: readonly { name: string; rows: string[][] }[], omitted: number, maxChars: number): AiTextOutcome {
  const parts: string[] = [];
  let length = 0;
  for (const sheet of sheets) {
    const lines = [`Sheet: ${sheet.name}`, ...sheet.rows.map((row) => row.join('\t').replace(/\t+$/, ''))];
    for (const line of lines) {
      const piece = length === 0 ? line : `\n${line}`;
      if (length + piece.length > maxChars) {
        const capped = capText(parts.join('') + piece, maxChars);
        return { kind: 'text', text: capped.text, cut: true, pages: null };
      }
      parts.push(piece);
      length += piece.length;
    }
    if (length > 0) {
      parts.push('\n');
      length += 1;
    }
  }
  return { kind: 'text', text: parts.join('').trimEnd(), cut: omitted > 0, pages: null };
}

/** One ZIP entry's text, at most `maxChars`; null when it has none to give (unreadable, encrypted, too complex). */
async function entryText(entry: ArchiveTextEntry, maxChars: number): Promise<{ text: string; cut: boolean } | null> {
  switch (entry.kind) {
    case 'text':
      return textFileText(entry.bytes, entry.more, maxChars);
    case 'pdf': {
      const made = await readPdfText(entry.bytes, maxChars);
      return made.kind === 'kept' ? null : { text: made.text, cut: made.cut };
    }
    case 'docx': {
      const word = await readWordText(entry.bytes);
      return word.kind === 'kept' ? null : capText(word.text, maxChars);
    }
    case 'xlsx': {
      const book = await readWorkbook(entry.bytes);
      if (book.kind === 'kept') return null;
      const made = workbookText(book.sheets, book.omitted, maxChars);
      return made.kind === 'kept' ? null : { text: made.text, cut: made.cut };
    }
  }
}

async function textOf(input: AiTextIn): Promise<AiTextOutcome> {
  const buffer = Buffer.from(input.data);
  if (input.kind === 'zip') {
    const archive = await readArchiveText(bufferRead(buffer), buffer.length, { maxChars: input.maxChars, maxEntries: AI_ZIP_ENTRIES, textOf: entryText });
    if (archive.kind === 'kept') return archive;
    return { kind: 'text', text: archive.text, cut: archive.cut, pages: null, source: archive.source, skipped: archive.skipped };
  }
  if (input.kind === 'pdf') return readPdfText(buffer, input.maxChars);
  if (input.kind === 'docx') {
    const word = await readWordText(buffer);
    if (word.kind === 'kept') {
      return { kind: 'kept', outcome: word.outcome === 'too_complex' || word.outcome === 'too_large_to_read' ? 'too_complex' : 'not_readable' };
    }
    const capped = capText(word.text, input.maxChars);
    return { kind: 'text', text: capped.text, cut: capped.cut, pages: null };
  }
  const book = await readWorkbook(buffer);
  if (book.kind === 'kept') return { kind: 'kept', outcome: book.outcome === 'too_complex' ? 'too_complex' : 'not_readable' };
  return workbookText(book.sheets, book.omitted, input.maxChars);
}

port.once('message', (message: AiTextIn) => {
  void textOf(message).then((outcome) => { port.postMessage(outcome); });
});
