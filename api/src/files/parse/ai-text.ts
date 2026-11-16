// Text for reading with TownwiseAI (spec 11A.9), only for a file the person let it read. A PDF, a workbook, a Word
// document or a ZIP's entries become plain text in a worker thread of its own (ai-text-thread.ts) with a smaller heap
// than the sales parse thread's (AI_THREAD_LIMITS: it keeps at most the characters it was asked for, and stops making
// text once it has them) and a two-minute limit, so a file that would exhaust either ends the thread, not the API; past
// either it is `too_complex`. The thread runs only while it holds the process's one parse-thread slot (thread-slot.ts),
// shared with the sales reader, so the two threads never hold their heaps at once. This is apart from the sales parse
// thread (thread.ts), whose raw rows never leave it: only this thread hands a file's content back, and only
// files/extract/input.ts (the TownwiseAI reader's input, and the ordering setup's read, D39) and files/items.ts (a file
// attached to a TownwiseAI message, D36) ask it (test/isolation.test.ts).
// A text file is decoded here, in the main thread, as the sales reader decodes one.
import { Worker, type ResourceLimits } from 'node:worker_threads';

import { AI_TEXT_TIME_MS, AI_THREAD_LIMITS } from '../limits.ts';
import { stripBom } from './csv.ts';
import { decoderFor, detectEncoding, ENCODING_PROBE_BYTES } from './text.ts';
import { inThreadSlot } from './thread-slot.ts';

export type AiTextKind = 'pdf' | 'xlsx' | 'docx' | 'zip';

/** What the thread is sent: the file's bytes (a transferred copy) and where to stop. */
export interface AiTextIn { readonly kind: AiTextKind; readonly data: ArrayBuffer; readonly maxChars: number }

/**
 * `cut` when the text stops short of the file's (at `maxChars`, past a workbook's tenth sheet, or past a ZIP's 20th entry
 * read); `pages` for a PDF. For a ZIP, `source` is its entries' text without their labels (what figures are checked
 * against) and `skipped` how many entries were not read (pictures, other kinds, or past the 20th); a ZIP refused by the
 * archive guards is `too_large` or `not_readable`, and one with no entry read `kind_not_read` (or `encrypted`).
 */
export type AiTextOutcome =
  | {
    readonly kind: 'text'; readonly text: string; readonly cut: boolean; readonly pages: number | null;
    readonly source?: string; readonly skipped?: number;
  }
  | { readonly kind: 'kept'; readonly outcome: 'encrypted' | 'not_readable' | 'too_complex' | 'too_large' | 'kind_not_read' };

export interface AiTextInput {
  readonly kind: AiTextKind;
  readonly bytes: Uint8Array;
  readonly maxChars: number;
  /** Tests shorten these; a chat turn (D36) shortens `timeMs` too. */
  readonly timeMs?: number;
  readonly resourceLimits?: ResourceLimits;
  /**
   * How long to wait for the parse-thread slot (a chat turn, D36): past it the read rejects with SlotBusy and its
   * thread never starts. Without it (the TownwiseAI reader), it waits as long as it takes.
   */
  readonly waitMs?: number;
}

const THREAD_URL = new URL('./ai-text-thread.ts', import.meta.url);

class TimeLimit extends Error {}

function isTooComplex(err: unknown): boolean {
  if (err instanceof TimeLimit) return true;
  return err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY';
}

/**
 * One file's text through the thread, once the parse-thread slot is free. Any other thread failure rejects (the reader
 * counts it as an attempt), and so does a wait past `waitMs` (SlotBusy).
 */
export function extractAiText(input: AiTextInput): Promise<AiTextOutcome> {
  return inThreadSlot(() => textThread(input), input.waitMs);
}

async function textThread(input: AiTextInput): Promise<AiTextOutcome> {
  const worker = new Worker(THREAD_URL, { resourceLimits: input.resourceLimits ?? AI_THREAD_LIMITS });
  let timer: NodeJS.Timeout | undefined;
  try {
    const answered = new Promise<AiTextOutcome>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { reject(new Error(`ai text thread exited (${String(code)})`)); });
      timer = setTimeout(() => { reject(new TimeLimit()); }, input.timeMs ?? AI_TEXT_TIME_MS);
    });
    // A copy, so the caller keeps its bytes (a PDF is also sent whole).
    const data = new Uint8Array(input.bytes).buffer;
    worker.postMessage({ kind: input.kind, data, maxChars: input.maxChars } satisfies AiTextIn, [data]);
    return await answered;
  } catch (err) {
    if (isTooComplex(err)) return { kind: 'kept', outcome: 'too_complex' };
    throw err;
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

/** `text` stopped at `maxChars` characters, never between the two halves of a surrogate pair. */
export function capText(text: string, maxChars: number): { text: string; cut: boolean } {
  if (text.length <= maxChars) return { text, cut: false };
  const code = text.charCodeAt(maxChars - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars;
  return { text: text.slice(0, end), cut: true };
}

/**
 * A text file's first bytes as text: the encoding decided on its first 64 KiB (detectEncoding), a byte-order mark
 * dropped, and bytes that turn out not to be UTF-8 later on decoded as windows-1252 instead. `more` says the file goes
 * on past `bytes`: a character cut at their end is left out, and the text counts as cut.
 */
export function textFileText(bytes: Uint8Array, more: boolean, maxChars: number): { text: string; cut: boolean } {
  const encoding = detectEncoding(bytes.subarray(0, ENCODING_PROBE_BYTES));
  let decoded: string;
  try {
    decoded = decoderFor(encoding).decode(bytes, { stream: more });
  } catch {
    decoded = new TextDecoder('windows-1252').decode(bytes);
  }
  const capped = capText(stripBom(decoded), maxChars);
  return { text: capped.text, cut: capped.cut || more };
}
