// POST .../orders/setup/read (spec D39; openspec change read-setup-with-townwise-ai): TownwiseAI reads one file or
// pasted text a member gave Ordering setup (P31) and suggests suppliers and items for the page's unsaved draft. The
// content comes in the request and goes to Anthropic once, in one call, with the saved setup's supplier and item names
// and nothing else; nothing of it is stored (no stored file, no Your data item, no change to the setup), and the call
// is charged to the organization's files AI budget (tw_files_usage, TOWNWISE_FILES_MONTHLY_BUDGET_USD, shared with
// D34 reads and the AI column step): the most it can cost reserved before it, corrected to what it cost after. Logs
// and the audit event carry ids, kinds, codes and counts only: never a name, a point-of-sale name, a note or the text.
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAfter } from '../audit.ts';
import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import { createByteGate } from '../chat/attachments.ts';
import {
  pastedInput, POSTED_KINDS, postedSource, prepareInput, SETUP_INPUT, type InputRefusal, type PostedKind, type PreparedInput,
} from '../files/extract/input.ts';
import type { ReaderAnswer } from '../files/extract/reader.ts';
import { setupResult } from '../files/extract/setup-prompt.ts';
import { setupCeilingMicroUsd, setupRequest } from '../files/extract/setup-reader.ts';
import { SETUP_FILE_BYTES, SETUP_READ_BODY_BYTES, SETUP_READ_BYTES_IN_FLIGHT } from '../files/limits.ts';
import { SlotBusy } from '../files/parse/thread-slot.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

/** The bodies of the reads this replica holds now, by their Content-Length (SETUP_READ_BYTES_IN_FLIGHT). */
export const setupReadBytes = createByteGate(SETUP_READ_BYTES_IN_FLIGHT);

const BUSY = { code: 'extract_busy', message: 'TownwiseAI is reading a lot right now. Try again in a moment.', retryAfterSeconds: 5 } as const;

/**
 * The route's step right before its body is parsed (TownwiseRoute.beforeBody): holds this replica's byte gate for the
 * body's Content-Length until the response is done (finished or closed, given back once), so a body past the gate is
 * refused before it is buffered. A body without a length, or longer than the route's '8mb', is refused as the parser
 * refuses one too long (413 payload_too_large); a compressed body holds the whole 8 MiB, as it may inflate to it. A
 * full gate answers 503 extract_busy, logged with its code only (the location is not checked yet).
 */
export function holdSetupReadBytes(ctx: TownwiseContext, req: Request, res: Response): void {
  const header = req.headers['content-length'];
  const length = header !== undefined && /^\d+$/.test(header) ? Number(header) : null;
  if (length === null || length > SETUP_READ_BODY_BYTES) throw new AppError(413, 'payload_too_large', 'Payload Too Large');
  const encoding = req.headers['content-encoding']?.trim().toLowerCase();
  const held = encoding === undefined || encoding === '' || encoding === 'identity' ? length : SETUP_READ_BODY_BYTES;
  if (!setupReadBytes.reserve(held)) {
    ctx.logger.info({ locationId: null, inputKind: null, fileKind: null, code: BUSY.code, errType: null, status: null }, 'townwise.setup_read_failed');
    throw new AppError(503, BUSY.code, BUSY.message, { retryAfterSeconds: BUSY.retryAfterSeconds });
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    setupReadBytes.release(held);
  };
  res.on('finish', release);
  res.on('close', release);
}

/** Base64 as the browser writes it (FileReader, btoa): no line breaks, padded. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A file (its bytes as base64, its kind from its extension; never its name) or pasted text. */
const readBody = z.strictObject({
  source: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('file'),
      kind: z.enum(POSTED_KINDS),
      data: z.string().min(4).refine((data) => data.length % 4 === 0 && BASE64.test(data)),
    }),
    z.strictObject({ type: z.literal('text'), text: z.string().min(1) }),
  ]),
});

/** What was posted: pasted text, or a file's kind and its bytes. */
type Posted = { readonly type: 'text'; readonly text: string } | { readonly type: 'file'; readonly kind: PostedKind; readonly bytes: Buffer };

/**
 * The body (400 invalid_request), with the request's copy let go of and a file's base64 decoded here, so the base64
 * is not held past this.
 */
function takePosted(req: Request): Posted {
  const { source } = parseInput(readBody, req.body);
  req.body = undefined;
  return source.type === 'text' ? source : { type: 'file', kind: source.kind, bytes: Buffer.from(source.data, 'base64') };
}

/** Whether this location's members may read with TownwiseAI now: a model, and a budget above 0. */
export function canReadWithAi(ctx: TownwiseContext): boolean {
  return ctx.setupReader !== null && ctx.config.filesMonthlyBudgetUsd > 0;
}

/**
 * What a call is charged against the files AI budget: what it cost when it answered, refused or was cut. A failed call
 * whose stream had begun is charged what the stream had reported (its input tokens, and its output estimated from the
 * characters streamed), as Anthropic may bill what it generated before the end; one with no stream event is charged
 * the whole reservation when it was `ended` (the time limit, or the person leaving), as it may have run without a word
 * back, and nothing for an API error.
 */
function charged(reply: ReaderAnswer | undefined, ended: boolean, reserved: number): number {
  if (reply === undefined) return 0;
  if (reply.kind !== 'failed') return reply.costMicroUsd;
  return reply.streamedMicroUsd ?? (ended ? reserved : 0);
}

/** What each refusal of the content answers (400). */
const REFUSED: Readonly<Record<InputRefusal | 'mismatch' | 'empty', { code: string; message: string }>> = {
  too_large: { code: 'extract_too_large', message: 'That file is too large for TownwiseAI to read: at most 5 MB, 30 pages, or a picture of 3.75 MB and 8,000 pixels a side.' },
  kind_not_read: { code: 'extract_kind_not_read', message: 'TownwiseAI can’t read that kind of file. Use a PDF, an Excel (.xlsx) or Word (.docx) file, a CSV or text file, or a picture.' },
  mismatch: { code: 'extract_kind_mismatch', message: 'That file isn’t the kind of file its name says.' },
  encrypted: { code: 'extract_encrypted', message: 'That file has a password, so TownwiseAI can’t open it.' },
  not_readable: { code: 'extract_not_readable', message: 'TownwiseAI couldn’t open that file.' },
  too_complex: { code: 'extract_not_readable', message: 'That file is too complex for TownwiseAI to turn into text.' },
  empty: { code: 'extract_empty', message: 'There’s nothing to read in it.' },
};

/**
 * POST .../orders/setup/read { source }: one read (spec D39). `source` is { type: 'file', kind, data } (kind from the
 * file's extension: pdf, xlsx, docx, text or picture; data its bytes as base64) or { type: 'text', text }. Every member,
 * and staff opened as admin (audited as Townwise staff); never under view-as (the chain refuses it, 403
 * view_as_read_only), and before the body is parsed 413 payload_too_large or 503 extract_busy while this replica holds
 * too much content (holdSetupReadBytes). Then in order: 404 for another organization's or an unknown location; 503
 * ai_unavailable while reading is off (no ANTHROPIC_API_KEY, or the budget at 0); 400 invalid_request for the body; 409
 * files_ai_budget_exhausted once the month's files AI spend has reached the budget; 503 extract_busy while the parse
 * thread stays busy; 400 for content not read (extract_too_large, extract_kind_not_read, extract_kind_mismatch,
 * extract_encrypted, extract_not_readable, extract_empty); 409 files_ai_budget_exhausted when the rest of the budget
 * cannot cover the most the call may cost; then one call. A refusal (422 extract_refused), an answer cut at max_tokens
 * (422 extract_answer_too_long) or an answer that is not JSON (422 extract_invalid_answer) is charged. A call that
 * fails is charged what its stream had reported, else nothing for an API error and the whole reservation for a call
 * that was ended (charged()): 503 extract_failed for an API error, 503 extract_timed_out past SETUP_READ_TIME_MS from
 * the request's start, and extract_left (logged; nobody is left to answer) when the person left. A read already past
 * its time, or whose person has left, makes no call and is charged nothing. Text past 100,000 characters is cut and the
 * answer says so (`partial`). 200 { read }: the checked suggestions (setup-prompt.ts setupResult) and `partial`. Every
 * call is audited (order.setup_read) with its outcome.
 */
export async function readOrderSetup(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const started = Date.now();
  // The person leaving (the response closing before it was sent) is heard from here on: one who leaves while the
  // content is checked or parsed gets no call, and one who leaves during the call ends it.
  const left = new AbortController();
  res.on('close', () => { if (!res.writableFinished) left.abort(); });
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const model = ctx.setupReader;
  if (model === null || !canReadWithAi(ctx)) throw new AppError(503, 'ai_unavailable', 'TownwiseAI can’t read files right now');
  // The request's copy of the body goes once it is parsed, and a file's base64 once decoded; `posted` (the text or the
  // file's bytes) goes once the input is made (V8 keeps a local alive across an await, so it is cleared by hand).
  let posted: Posted | null = takePosted(req);
  const inputKind = posted.type;
  const fileKind = posted.type === 'file' ? posted.kind : null;
  /** A refusal, logged with its code (and a failed call's error class and status). */
  const fail = (status: number, code: string, message: string, extra: { errType?: string; status?: number | null; retryAfterSeconds?: number } = {}): AppError => {
    ctx.logger.info({
      locationId: location.id, inputKind, fileKind, code, errType: extra.errType ?? null, status: extra.status ?? null,
    }, 'townwise.setup_read_failed');
    return new AppError(status, code, message, extra.retryAfterSeconds === undefined ? undefined : { retryAfterSeconds: extra.retryAfterSeconds });
  };
  const refused = (reason: keyof typeof REFUSED): AppError => fail(400, REFUSED[reason].code, REFUSED[reason].message);
  const spent = (): AppError => fail(409, 'files_ai_budget_exhausted', 'Your organization’s TownwiseAI budget for reading files is used up this month');
  /** The parse thread stayed busy (the byte gate is held before the body is parsed: holdSetupReadBytes). */
  const busy = (): AppError => fail(503, BUSY.code, BUSY.message, { retryAfterSeconds: BUSY.retryAfterSeconds });
  /** Past the read's time limit; and the person gone (logged only: nobody is there to answer). */
  const late = (why: { errType?: string; status?: number | null } = {}): AppError => fail(503, 'extract_timed_out', 'TownwiseAI took too long to read it. Try a shorter file, or part of it.', why);
  const gone = (why: { errType?: string; status?: number | null } = {}): AppError => fail(503, 'extract_left', 'The read stopped: the page was closed.', why);
  /** A posted file's input. Its own frame holds the source over the bytes, so that goes when it returns. */
  const fileInput = async (kind: PostedKind, bytes: Buffer): Promise<PreparedInput> => {
    if (bytes.length > SETUP_FILE_BYTES) throw refused('too_large');
    const file = postedSource(kind, bytes);
    if (typeof file === 'string') throw refused(file);
    try {
      return await prepareInput(file, SETUP_INPUT, ctx.setupReadText ?? undefined);
    } catch (err) {
      if (err instanceof SlotBusy) throw busy();
      // A parser's message could quote the file, so only its class is logged.
      throw fail(400, 'extract_not_readable', REFUSED.not_readable.message, { errType: err instanceof Error ? err.name : 'unknown' });
    }
  };

  const month = ctx.now().toISOString().slice(0, 7);
  const budget = Math.round(ctx.config.filesMonthlyBudgetUsd * 1_000_000);
  if (await ctx.stores.filesUsage.costMicroUsd(scope, month) >= budget) throw spent();
  const prepared = posted.type === 'text' ? pastedInput(posted.text, SETUP_INPUT) : await fileInput(posted.kind, posted.bytes);
  // eslint-disable-next-line no-useless-assignment -- lets go of the bytes, which the rest of the read (its call) never needs
  posted = null;
  if (prepared.kind === 'skip') throw refused(prepared.reason);
  const { input } = prepared;
  if (input.type === 'text' && input.text.trim() === '') throw refused('empty');

  const setup = await ctx.stores.orderSetups.get(scope, location.id);
  // Names only: never a point-of-sale name (chat/tools/orders.ts leaves them out too).
  const request = setupRequest(input, {
    suppliers: setup?.suppliers.map((supplier) => supplier.name) ?? [], items: setup?.items.map((item) => item.name) ?? [],
  });
  const reserved = setupCeilingMicroUsd(request, input, prepared.pages);
  if (!await ctx.stores.filesUsage.reserve(scope, month, reserved, budget, ctx.now())) throw spent();
  // The call ends at the read's time limit from the request's start, or when the person leaves. Checked right before
  // it: when either came first, no call is made and the reservation is given back. A response destroyed before this
  // handler ran never emits 'close' to it (Node does not replay it), hence `res.destroyed`.
  const remaining = started + ctx.setupReadTimeMs - Date.now();
  const timeLimit = AbortSignal.timeout(Math.max(0, remaining));
  const signal = AbortSignal.any([left.signal, timeLimit]);
  const ended = left.signal.aborted || res.destroyed ? 'left' : remaining <= 0 ? 'timed_out' : null;
  let reply: ReaderAnswer | undefined;
  try {
    if (ended === null) reply = await model.readFile(request, signal);
  } finally {
    // The reservation becomes what the call is charged (nothing when no call was made).
    await ctx.stores.filesUsage.add(scope, month, charged(reply, signal.aborted, reserved) - reserved, ctx.now());
  }
  if (reply === undefined) throw ended === 'left' ? gone() : late();
  const result = reply.kind === 'answered' ? setupResult(reply.output, prepared.sourceText) : null;
  const outcome = reply.kind === 'failed' ? 'failed' : reply.kind === 'answered' ? (result === null ? 'invalid_answer' : 'read') : reply.kind;
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'order.setup_read', target: { type: 'location', id: location.id },
    details: { locationId: location.id, inputKind, outcome, suppliers: result?.suppliers.length ?? 0, items: result?.items.length ?? 0 },
  });
  if (reply.kind === 'failed') {
    const why = { errType: reply.errType, status: reply.status };
    if (left.signal.aborted) throw gone(why);
    if (timeLimit.aborted) throw late(why);
    throw fail(503, 'extract_failed', 'TownwiseAI couldn’t read it just now. Try again.', why);
  }
  if (reply.kind === 'refused') throw fail(422, 'extract_refused', 'TownwiseAI declined to read that.');
  if (reply.kind === 'too_long') throw fail(422, 'extract_answer_too_long', 'TownwiseAI’s answer ran too long. Try a shorter file, or part of it.');
  if (result === null) throw fail(422, 'extract_invalid_answer', 'TownwiseAI’s answer couldn’t be read. Try again.');
  ctx.logger.info({
    locationId: location.id, inputKind, fileKind, confidence: result.confidence, suppliers: result.suppliers.length,
    items: result.items.length, estimated: result.items.filter((item) => item.servingsEstimated).length,
    notInFile: result.items.filter((item) => item.inFile === false).length, itemsCut: result.itemsCut, partial: prepared.partial,
    costMicroUsd: reply.costMicroUsd, durationMs: Date.now() - started,
  }, 'townwise.setup_read');
  res.status(200).json({ read: { ...result, partial: prepared.partial } });
}
