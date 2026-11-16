// Reading with TownwiseAI (spec 11A.9): the request for one file a person opted in, and the model as a port. main.ts
// builds the real one (model.ts, the only file here that constructs a client) when ANTHROPIC_API_KEY is set; tests pass
// a scripted fake. The request holds the file's content (a PDF as a document, a picture as an image, anything else as
// text), today's date and the location's time zone, and nothing else: never the file's name, the organization's or
// the location's name, or who uploaded it. Nothing here logs.
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { ceilingCostMicroUsd } from '../../chat/pricing.ts';
import { AI_PDF_PAGES, AI_TEXT_CHARS, AI_ZIP_ENTRIES, MAX_SHEETS } from '../limits.ts';
import { READER_MAX_TOKENS, READER_MODEL, READER_SYSTEM_PROMPT } from './reader-prompt.ts';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * What is sent of the file. `form` says what a text was made from; `cut` that it stops at AI_TEXT_CHARS (or, for an
 * archive, past its 20th entry read); `skipped`, for an archive, how many of its entries were not read.
 */
export type ReaderInput =
  | { readonly type: 'pdf'; readonly base64: string }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly base64: string }
  | {
    readonly type: 'text'; readonly form: 'text' | 'workbook' | 'word' | 'archive'; readonly text: string; readonly cut: boolean;
    readonly skipped?: number;
  };

/** Today's date in the location's time zone (YYYY-MM-DD), and that zone. */
export interface ReaderContext { readonly today: string; readonly timeZone: string }

export interface ReaderRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: BetaMessageParam[];
}

export type ReaderAnswer =
  /** `output` is the answer's JSON, or null when its text was not JSON. */
  | { readonly kind: 'answered'; readonly output: unknown; readonly costMicroUsd: number }
  /** Refused through the whole fallback chain; the call still cost what it cost. */
  | { readonly kind: 'refused'; readonly costMicroUsd: number }
  /** Stopped at max_tokens: the answer is cut, so none is kept; the call still cost what it cost. */
  | { readonly kind: 'too_long'; readonly costMicroUsd: number }
  /**
   * No answer: the error's class and HTTP status, never its message or the request. `streamedMicroUsd`, once the
   * call's stream had begun (it was aborted, or failed mid-stream), is what the stream had reported at list prices: its
   * input tokens and its output so far (model.ts streamTally); absent when no stream event had arrived.
   */
  | { readonly kind: 'failed'; readonly errType: string; readonly status: number | null; readonly streamedMicroUsd?: number };

export interface FileReaderModel {
  readFile(request: ReaderRequest, signal: AbortSignal): Promise<ReaderAnswer>;
}

export const TEXT_FORMS: Readonly<Record<Extract<ReaderInput, { type: 'text' }>['form'], string>> = {
  text: 'a text file (it may be a CSV or TSV export)',
  workbook: 'an Excel workbook, made into text: each sheet starts with a "Sheet:" line, then its rows, cells apart by tabs',
  word: 'a Word document, made into text: its paragraphs on lines of their own, and its tables\' rows with cells apart by tabs',
  archive: 'a ZIP archive, made into text: each file in it that was read starts with a line "Entry n (what it is):", then its text (a workbook\'s sheets under "Sheet:" lines, rows with cells apart by tabs)',
};

/** The line after which a request's text, to its end, is the file's content. */
export const MARKER = '--- FILE CONTENT ---';

/** The words that go with the file: the date, the zone, what the file is, and whether it was cut. */
function contextText(input: ReaderInput, context: ReaderContext): string {
  const lines = [`Today is ${context.today} in the restaurant's time zone, ${context.timeZone}.`];
  if (input.type === 'pdf') lines.push('The file is the PDF document above.');
  else if (input.type === 'image') lines.push('The file is the picture above.');
  else {
    lines.push(`The file is ${TEXT_FORMS[input.form]}.`);
    if (input.form === 'archive' && input.skipped !== undefined && input.skipped > 0) {
      lines.push(`${String(input.skipped)} other ${input.skipped === 1 ? 'entry' : 'entries'} in it ${input.skipped === 1 ? 'was' : 'were'} not read (pictures, kinds Townwise does not read, or past the first ${String(AI_ZIP_ENTRIES)}).`);
    }
    if (input.cut) {
      const within = input.form === 'workbook' ? `, from at most its first ${String(MAX_SHEETS)} sheets`
        : input.form === 'archive' ? `, from at most its first ${String(AI_ZIP_ENTRIES)} entries read` : '';
      const limits = `at most ${AI_TEXT_CHARS.toLocaleString('en-US')} characters${within}`;
      lines.push(`It was too long to send whole, so only its start follows (${limits}). Say in the summary that only the start of the file was read.`);
    }
    lines.push(`Everything after the line "${MARKER}", to the end of this message, is the file's content.`, MARKER, input.text);
  }
  return lines.join('\n');
}

/** A picture's input tokens at most (Claude Opus 5.5 reads one at up to 4,784), and a PDF page's (its text and image). */
const IMAGE_TOKENS = 5000;
const PDF_PAGE_TOKENS = 3000;

/** The words that go with any file besides its own text (the date, the zone, what the file is), at most. */
const CONTEXT_CHARS = 2000;

/**
 * The most a request with `input` can cost, reserved against a budget before the call: `chars` (its system prompt and
 * every word it sends) at a token for every three characters, a PDF at 3,000 tokens a page, a picture at 5,000, and
 * `maxTokens` of output, all at the most expensive model's prices (pricing.ts ceilingCostMicroUsd). Both TownwiseAI
 * readers reserve this one (this file's, and the ordering setup's, setup-reader.ts).
 */
export function inputCeilingMicroUsd(input: ReaderInput, limits: { chars: number; pages: number; maxTokens: number }): number {
  const tokens = input.type === 'pdf' ? limits.pages * PDF_PAGE_TOKENS : input.type === 'image' ? IMAGE_TOKENS : 0;
  return ceilingCostMicroUsd({ input: tokens + Math.ceil(limits.chars / 3), output: limits.maxTokens, cacheRead: 0, cacheWrite: 0 });
}

/**
 * The most a request for `input` can cost: the system prompt, the words that go with any file and its own text, a PDF
 * at its `pages` (600 when not known), and every output token the request may write (inputCeilingMicroUsd).
 */
export function readerCeilingMicroUsd(input: ReaderInput, pages: number | null): number {
  const chars = READER_SYSTEM_PROMPT.length + CONTEXT_CHARS + (input.type === 'text' ? input.text.length : 0);
  return inputCeilingMicroUsd(input, { chars, pages: pages ?? AI_PDF_PAGES, maxTokens: READER_MAX_TOKENS });
}

/** The request for one file, exactly. */
export function readerRequest(input: ReaderInput, context: ReaderContext): ReaderRequest {
  const content: BetaContentBlockParam[] = [];
  if (input.type === 'pdf') {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.base64 } });
  } else if (input.type === 'image') {
    content.push({ type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.base64 } });
  }
  content.push({ type: 'text', text: contextText(input, context) });
  return {
    model: READER_MODEL,
    max_tokens: READER_MAX_TOKENS,
    system: READER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };
}
