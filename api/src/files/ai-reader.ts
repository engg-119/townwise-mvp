// Reading with TownwiseAI (spec 11A.9, D34): a loop in each API replica, beside the file reader (worker.ts) and shaped
// like it, so it can move to a job unchanged. It claims the file whose read was asked for first (a lease on the file's
// `ai`, through stores/cross-tenant.ts: 90 seconds, renewed every 30), makes the model's input from the original, sends
// it in one call, checks the answer, saves it, hands it to `onRead` (files/ai-actions.ts in production: the notes, days,
// summary item and calibration it writes) and marks the read done. One file per replica at a time; a read is attempted
// at most three times, then failed `internal`. Only files a person opted in are ever claimed. Logs and audit carry ids,
// kinds, codes and counts only: never a file name, its content, the summary, a title or a figure.
import type { AuthStores } from '@ckeith26/auth';
import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForClaimedAiRead, type OrgScope } from '../access/policy.ts';
import { DELETED_PERSON } from '../people.ts';
import { claimNextAiRead, type ClaimedAiRead } from '../stores/cross-tenant.ts';
import type { AiActionsOutcome, AiReadResult, FileRecord } from '../stores/files.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { BlobMissingError, type FileBlobs } from './blobs.ts';
import { readerRequest, type FileReaderModel, type ImageMediaType, type ReaderInput } from './extract/reader.ts';
import { readerResult } from './extract/reader-prompt.ts';
import {
  AI_IMAGE_BYTES, AI_PDF_BYTES, AI_PDF_PAGES, AI_SOURCE_CHARS, AI_TEXT_CHARS, AI_TEXT_READ_BYTES, AI_ZIP_BYTES, DOCX_READ_BYTES,
  HEAD_BYTES, MAX_ATTEMPTS, READ_TIME_MS, XLSX_READ_BYTES,
} from './limits.ts';
import { extractAiText, textFileText, type AiTextInput, type AiTextOutcome } from './parse/ai-text.ts';
import { sniff } from './sniff.ts';

/** What a finished read hands to `onRead`: the checked answer, whether the input was cut, and what the call cost. */
export interface AiFileRead {
  readonly result: AiReadResult;
  readonly partial: boolean;
  readonly costMicroUsd: number;
}

/**
 * The seam for acting on a read (files/ai-actions.ts: notes, verified days, a summary item, a calibration). Called once
 * per finished read, after the answer is saved on the file (`ai.result`) and before the read is marked done, inside the
 * same claim and lease (the heartbeat keeps running). `file` is the record as the claim found it, `ai` still `reading`.
 * `sourceText` is the file's own text to check figures against, never stored: the text sent (a text file, a workbook,
 * a Word document, a ZIP's entries without their labels), a PDF's text made in the parse thread (at most
 * AI_SOURCE_CHARS), or null for a picture. A throw puts the read back in the queue (the attempt counts; after three it
 * fails `internal`); a retry finds the saved answer and calls `onRead` again with it, without another model call, so
 * whatever `onRead` writes must be written so a second call completes it (no multi-document transactions). The file can
 * be deleted while it runs (a read never blocks a delete), so a write keyed to the file should be checked against it.
 * What it did is recorded on `ai.actions.outcome`; the reader's log line and audit event read the counts from there.
 * Without one (tests), nothing is acted on.
 */
export type OnAiRead = (scope: OrgScope, file: FileRecord, read: AiFileRead, sourceText: string | null) => Promise<void>;

export interface AiReaderDeps {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  readonly authStores: Pick<AuthStores, 'users'>;
  readonly blobs: FileBlobs;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly model: FileReaderModel;
  /** TOWNWISE_FILES_MONTHLY_BUDGET_USD: the organization's monthly limit for the file reader's model calls. */
  readonly filesMonthlyBudgetUsd: number;
  /** How often an idle reader looks for work; a nudge looks at once. */
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  /** Tests pass shorter limits. */
  readonly extractText?: (input: AiTextInput) => Promise<AiTextOutcome>;
  readonly onRead?: OnAiRead;
}

export interface AiReader {
  start(): void;
  /** Look for work now (a read was asked for). */
  nudge(): void;
  /** Resolves when the reader has nothing left it can claim (tests). */
  settled(): Promise<void>;
  close(): Promise<void>;
  readonly name: string;
}

/**
 * Why a read was skipped (`ai.reason` with status `skipped`): the month's budget is spent; the file is over the size
 * or page caps; its kind is not read (old Excel or Word, Numbers, anything else that is not a picture, or a ZIP with no
 * entry read as text); it is encrypted; its original is gone; making its text ran past the thread's limits; or it could
 * not be opened.
 */
export type AiSkipReason = 'budget_spent' | 'too_large' | 'kind_not_read' | 'encrypted' | 'raw_missing' | 'too_complex' | 'not_readable';

const POLL_MS = 5000;
const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;

type Prepared =
  | { readonly kind: 'skip'; readonly reason: AiSkipReason }
  | { readonly kind: 'input'; readonly input: ReaderInput; readonly sourceText: string | null; readonly partial: boolean };

/** A PNG, JPEG, GIF or WebP picture, by its first bytes whatever its name or kind, or null. */
export function pictureType(head: Uint8Array): ImageMediaType | null {
  const starts = (bytes: readonly number[], at = 0): boolean => bytes.every((byte, index) => head[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export function createAiReader(deps: AiReaderDeps): AiReader {
  const { stores, blobs, logger, now } = deps;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const extractText = deps.extractText ?? extractAiText;
  const onRead: OnAiRead = deps.onRead ?? (() => Promise.resolve());
  let stopped = false;
  let busy: Promise<void> | null = null;
  let again = false;
  let poll: NodeJS.Timeout | undefined;
  const abort = new AbortController();

  /** The original, whole or its first `count` bytes. A read that stalls is aborted. */
  async function original(scope: OrgScope, file: FileRecord, count?: number): Promise<Buffer> {
    const range = count === undefined ? undefined : { offset: 0, count };
    const body = await blobs.openRaw(
      scope, { locationId: file.locationId, fileId: file.id }, range, AbortSignal.any([abort.signal, AbortSignal.timeout(READ_TIME_MS)]),
    );
    const parts: Buffer[] = [];
    for await (const part of body) parts.push(Buffer.from(part as Uint8Array));
    return Buffer.concat(parts);
  }

  const skip = (reason: AiSkipReason): Prepared => ({ kind: 'skip', reason });

  /** The model's input from the original, the text to check figures against, and whether the input was cut. */
  async function prepare(scope: OrgScope, file: FileRecord): Promise<Prepared> {
    const head = await original(scope, file, Math.min(HEAD_BYTES, file.sizeBytes));
    const picture = pictureType(head);
    if (picture !== null) {
      if (file.sizeBytes > AI_IMAGE_BYTES) return skip('too_large');
      const bytes = file.sizeBytes <= head.length ? head : await original(scope, file);
      return { kind: 'input', input: { type: 'image', mediaType: picture, base64: bytes.toString('base64') }, sourceText: null, partial: false };
    }
    switch (file.kind) {
      case 'pdf': {
        if (file.sizeBytes > AI_PDF_BYTES) return skip('too_large');
        const bytes = await original(scope, file);
        const text = await extractText({ kind: 'pdf', bytes, maxChars: AI_SOURCE_CHARS });
        if (text.kind === 'kept') return skip(text.outcome);
        if (text.pages !== null && text.pages > AI_PDF_PAGES) return skip('too_large');
        // Sent whole as a document (a scanned PDF too: its text is then empty); its text is only checked against.
        return { kind: 'input', input: { type: 'pdf', base64: bytes.toString('base64') }, sourceText: text.text, partial: false };
      }
      case 'text': {
        const count = Math.min(file.sizeBytes, AI_TEXT_READ_BYTES);
        const { text, cut } = textFileText(await original(scope, file, count), file.sizeBytes > count, AI_TEXT_CHARS);
        return { kind: 'input', input: { type: 'text', form: 'text', text, cut }, sourceText: text, partial: cut };
      }
      case 'xlsx':
      case 'docx': {
        if (file.sizeBytes > (file.kind === 'xlsx' ? XLSX_READ_BYTES : DOCX_READ_BYTES)) return skip('too_large');
        const made = await extractText({ kind: file.kind, bytes: await original(scope, file), maxChars: AI_TEXT_CHARS });
        if (made.kind === 'kept') return skip(made.outcome);
        const input: ReaderInput = { type: 'text', form: file.kind === 'xlsx' ? 'workbook' : 'word', text: made.text, cut: made.cut };
        return { kind: 'input', input, sourceText: made.text, partial: made.cut };
      }
      case 'other':
        // The name is read here only for its extension (a password-protected Office file); it never leaves this function.
        return skip(sniff(file.name, head).outcome === 'encrypted' ? 'encrypted' : 'kind_not_read');
      case 'zip': {
        // Its entries as text, labelled by their place, never their path (parse/archive.ts readArchiveText).
        if (file.sizeBytes > AI_ZIP_BYTES) return skip('too_large');
        const made = await extractText({ kind: 'zip', bytes: await original(scope, file), maxChars: AI_TEXT_CHARS });
        if (made.kind === 'kept') return skip(made.outcome);
        const input: ReaderInput = { type: 'text', form: 'archive', text: made.text, cut: made.cut, skipped: made.skipped ?? 0 };
        return { kind: 'input', input, sourceText: made.source ?? made.text, partial: made.cut };
      }
      case 'xls':
      case 'doc':
        return skip('kind_not_read');
    }
  }

  async function audit(scope: OrgScope, file: FileRecord, result: AiReadResult, done: AiActionsOutcome | null): Promise<void> {
    const ai = file.ai;
    if (ai === null) return;
    try {
      await stores.audit.insert({
        at: now(), actorUserId: ai.requestedBy, actorEmail: (await deps.authStores.users.findById(ai.requestedBy))?.email ?? DELETED_PERSON,
        actorRole: ai.requestedByStaff ? 'superadmin' : ai.requestedByRole, viewAsGrantId: ai.requestedGrantId,
        orgId: scope.orgId, action: 'file.ai_read', target: { type: 'file', id: file.id },
        details: {
          locationId: file.locationId, kind: result.kind, events: result.events.length, days: result.days.length,
          ...(done === null ? {} : {
            notes: done.notes.length, daysWritten: done.daysWritten, item: done.itemId !== null, calibration: done.calibration.status,
          }),
        },
      });
    } catch {
      logger.error({ action: 'file.ai_read', orgId: scope.orgId, targetId: file.id }, 'townwise.audit_write_failed');
    }
  }

  /** A model call that gave no answer (an API error, a timeout, a stop): the read goes back to the queue. */
  class CallFailed extends Error {}

  /** One claimed read. */
  async function readOne(scope: OrgScope, claim: ClaimedAiRead): Promise<void> {
    const file = await stores.files.get(scope, claim.locationId, claim.id);
    const ai = file?.ai ?? null;
    if (file === null || file.status === 'deleting' || ai?.status !== 'reading' || ai.attempts !== claim.attempt) return;
    const finish = async (status: 'done' | 'failed' | 'skipped', reason: string | null, costMicroUsd = 0): Promise<boolean> => {
      const done = await stores.files.finishAiRead(scope, file.id, claim.attempt, { status, reason, at: now(), costMicroUsd });
      if (done && status !== 'done') logger.info({ fileId: file.id, reason }, status === 'skipped' ? 'townwise.ai_read_skipped' : 'townwise.ai_read_failed');
      return done;
    };
    if (ai.attempts > MAX_ATTEMPTS) {
      await finish('failed', 'internal');
      return;
    }
    if (file.rawDeletedAt !== null) {
      await finish('skipped', 'raw_missing');
      return;
    }
    let prepared: Prepared;
    try {
      prepared = await prepare(scope, file);
    } catch (err) {
      if (!(err instanceof BlobMissingError)) throw err;
      prepared = skip('raw_missing');
    }
    if (prepared.kind === 'skip') {
      await finish('skipped', prepared.reason);
      return;
    }
    let result = ai.result;
    let costMicroUsd = ai.costMicroUsd;
    if (result === null) {
      // A first answer: within the budget, checked before the call and charged after it whatever it answered.
      const month = now().toISOString().slice(0, 7);
      const budget = Math.round(deps.filesMonthlyBudgetUsd * 1_000_000);
      if (budget <= 0 || await stores.filesUsage.costMicroUsd(scope, month) >= budget) {
        await finish('skipped', 'budget_spent');
        return;
      }
      const location = await stores.locations.find(scope, file.locationId);
      if (location === null) throw new Error('location gone');
      const { timeZone } = timeZoneOf(location.town);
      const answer = await deps.model.readFile(readerRequest(prepared.input, { today: localDay(now(), timeZone), timeZone }), abort.signal);
      if (answer.kind === 'failed') {
        logger.warn({ fileId: file.id, errType: answer.errType, status: answer.status }, 'townwise.ai_read_model_failed');
        throw new CallFailed();
      }
      await stores.filesUsage.add(scope, month, answer.costMicroUsd, now());
      if (answer.kind === 'refused') {
        // Nothing is written but the outcome and its cost.
        await finish('failed', 'refused', answer.costMicroUsd);
        return;
      }
      result = readerResult(answer.output);
      if (result === null) {
        // No answer to keep (cut at the token limit, say); a retry would cost again, so the read fails.
        await finish('failed', 'internal', answer.costMicroUsd);
        return;
      }
      costMicroUsd += answer.costMicroUsd;
      if (!await stores.files.saveAiResult(scope, file.id, claim.attempt, { result, partial: prepared.partial, costMicroUsd: answer.costMicroUsd })) {
        // Still held, the original was deleted while the model read it (a purge): nothing of the answer is kept.
        await finish('skipped', 'raw_missing', answer.costMicroUsd);
        return;
      }
    }
    await onRead(scope, file, { result, partial: prepared.partial, costMicroUsd }, prepared.sourceText);
    if (!await finish('done', null)) return;
    // What onRead did, as it recorded it: counts and codes only.
    const done = (await stores.files.get(scope, file.locationId, file.id))?.ai?.actions?.outcome ?? null;
    logger.info({
      fileId: file.id, kind: result.kind, confidence: result.confidence, events: result.events.length, days: result.days.length,
      partial: prepared.partial, costMicroUsd,
      ...(done === null ? {} : {
        notes: done.notes.length, notesSkipped: done.notesSkipped, daysWritten: done.daysWritten, daysReason: done.daysReason,
        item: done.itemId !== null, itemReason: done.itemReason, calibration: done.calibration.status,
      }),
    }, 'townwise.ai_read');
    await audit(scope, file, result, done);
  }

  async function tick(): Promise<boolean> {
    const claim = await claimNextAiRead(deps.connection, { now: now(), leaseMs });
    if (claim === null) return false;
    const scope = scopeForClaimedAiRead(claim);
    const heartbeat = setInterval(() => {
      void stores.files.renewAiLease(scope, claim.id, claim.attempt, new Date(now().getTime() + leaseMs)).catch(() => undefined);
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    try {
      await readOne(scope, claim);
    } catch (err) {
      // Back to the queue; the attempt counted, and after three the read is failed with `internal`.
      if (!(err instanceof CallFailed)) logger.warn({ fileId: claim.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.ai_read_attempt_failed');
      await stores.files.releaseAiRead(scope, claim.id, claim.attempt).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async function drain(): Promise<void> {
    try {
      while (!stopped && await tick());
    } catch (err) {
      logger.error({ errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.ai_reader_failed');
    }
  }

  const reader: AiReader = {
    name: 'ai-file-reader',
    start() {
      poll = setInterval(() => { reader.nudge(); }, deps.pollMs ?? POLL_MS);
      reader.nudge();
    },
    nudge() {
      if (stopped) return;
      if (busy !== null) {
        again = true;
        return;
      }
      busy = drain().finally(() => {
        busy = null;
        if (again) {
          again = false;
          reader.nudge();
        }
      });
    },
    async settled() {
      while (busy !== null) await busy;
    },
    async close() {
      stopped = true;
      clearInterval(poll);
      abort.abort();
      await busy;
    },
  };
  return reader;
}
