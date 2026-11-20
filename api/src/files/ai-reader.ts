// Reading with TownwiseAI (spec 11A.9, D34): a loop in each API replica, beside the file reader (worker.ts) and shaped
// like it, so it can move to a job unchanged. It claims the file whose read was asked for first (a lease on the file's
// `ai`, through stores/cross-tenant.ts: 90 seconds, renewed every 30; never a second read of an organization that has
// one under a live lease), checks the month's budget, makes the model's input from the original, reserves the most the
// call can cost, sends it in one streamed call, corrects the charge to what it cost, checks the answer (and which of its
// days the file's own text bears out), saves it, hands it to `onRead` (files/ai-actions.ts in production: the notes,
// days, summary item and calibration it writes) and marks the read done. One file per replica at a time; an attempt
// that stops waits 1, 2, then 4 minutes before the next, a read is attempted at most three times, then failed
// `internal`, and an API refusal of the request itself (a 4xx other than 408, 409 or 429) fails it at once. A retry
// after the answer was saved goes straight to the actions, without the original. Only files a person opted in are
// ever claimed, and (D59) files TownwiseAI reads on its own (files/ai-auto.ts), queued `auto`: those are bounded here
// before anything is read or reserved. One whose organization or deploy switch is off by then is skipped
// `agent_auto_off`; one whose fingerprint matches a file of the location TownwiseAI already read, `duplicate`; past 20
// a day per organization, `daily_auto_limit`; and one that would leave $1 or less of the files month after its ceiling,
// `budget_spent`, so a press still runs. Its audit event's actor is TownwiseAI. D59 slice 2: when no read is
// waiting, the same loop claims a file calendar's automatic sort (stores/cross-tenant.ts claimNextCalendarSort, one job
// per organization across both) under the same lease, heartbeat and waits, and hands it to calendar/auto-sort.ts. Logs
// and audit carry ids, kinds, codes and counts only: never a file name, its content, the summary, a title or a figure.
import type { AuthStores } from '@ckeith26/auth';
import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForClaimedAiRead, scopeForClaimedCalendarSort, type OrgScope } from '../access/policy.ts';
import type { CalendarSorts } from '../calendar/auto-sort.ts';
import { isCalendarCsvText } from '../calendar/csv-events.ts';
import { TOWNWISE_AI_ACTOR } from '../audit.ts';
import { DELETED_PERSON } from '../people.ts';
import { EARLIEST_DATE, utcDay } from '../dates.ts';
import { claimNextAiRead, claimNextCalendarSort, type ClaimedAiRead } from '../stores/cross-tenant.ts';
import type { AiActionsOutcome, AiReadResult, FileRecord } from '../stores/files.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { verifiedIndexes } from './ai-verify.ts';
import { BlobMissingError, type FileBlobs } from './blobs.ts';
import { prepareInput, READER_INPUT, type PreparedInput } from './extract/input.ts';
import { readerCeilingMicroUsd, readerRequest, type FileReaderModel } from './extract/reader.ts';
import { readerResult } from './extract/reader-prompt.ts';
import { AI_RETRY_BASE_MS, MAX_ATTEMPTS, READ_TIME_MS } from './limits.ts';
import type { AiTextInput, AiTextOutcome } from './parse/ai-text.ts';

/** What a finished read hands to `onRead`: the checked answer, whether the input was cut, and what the call cost. */
export interface AiFileRead {
  readonly result: AiReadResult;
  readonly partial: boolean;
  readonly costMicroUsd: number;
}

/**
 * The seam for acting on a read (files/ai-actions.ts: notes, verified days, a summary item, a calibration). Called once
 * per finished read, after the answer is saved on the file (`ai.result`, with `daysBorneOut`: which of its days the
 * file's own text bears out, checked against the text sent, a PDF's text made in the parse thread, or none for a
 * picture) and before the read is marked done, inside the same claim and lease (the heartbeat keeps running). `file`
 * is the record as the claim found it, `ai` still `reading`. A throw puts the read back in the queue (the attempt
 * counts and backs off; after three it fails `internal`); a retry finds the saved answer and calls `onRead` again with
 * it, without another model call or a read of the original, so whatever `onRead` writes must be written so a second
 * call completes it (no multi-document transactions). The file can be deleted while it runs (a read never blocks a
 * delete), so a write keyed to the file should be checked against it. What it did is recorded on `ai.actions.outcome`;
 * the reader's log line and audit event read the counts from there. It answers `requester_gone` when it wrote nothing
 * because the person who asked no longer may (the read is then skipped with that reason), else null. Without one
 * (tests), nothing is acted on.
 */
export type OnAiRead = (scope: OrgScope, file: FileRecord, read: AiFileRead) => Promise<'requester_gone' | null>;

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
  /** D59: TOWNWISE_AGENT_AUTO. Off (left out), a queued automatic read is skipped `agent_auto_off`. */
  readonly agentAuto?: boolean;
  /** D59 slice 2: file calendars' automatic sorts (calendar/auto-sort.ts); left out, none is claimed. */
  readonly sorts?: CalendarSorts;
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
 * Why a read was skipped (`ai.reason` with status `skipped`): the month's budget is spent (or cannot cover the most the
 * call may cost); the file is over the size or page caps; its kind is not read (old Excel or Word, Numbers, anything
 * else that is not a picture, or a ZIP with no entry read as text); it is encrypted; its original is gone; making its
 * text ran past the thread's limits; it could not be opened; or the person who asked no longer belongs to the
 * organization (or, for Townwise staff, their open-as-admin grant ended) by the time it was acted on; or (D58) it is a
 * calendar export (the file reader kept it `calendar_export`, or a text file's header is a calendar CSV's), which is
 * skipped before the budget is read or anything is reserved or sent, so it writes no notes: Your calendars imports it.
 */
export type AiSkipReason =
  | 'budget_spent' | 'too_large' | 'kind_not_read' | 'encrypted' | 'raw_missing' | 'too_complex' | 'not_readable' | 'requester_gone'
  | 'calendar_export' | 'duplicate' | 'daily_auto_limit' | 'agent_auto_off' | 'turned_off';

/** D59: automatic reads an organization may start in a UTC day. */
export const AUTO_READS_PER_DAY = 20;
/** D59: what an automatic read leaves of the files month for presses, in micro-dollars: more than $1. */
export const AUTO_RESERVE_MICRO_USD = 1_000_000;

const POLL_MS = 5000;
const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;

/** The model's input (extract/input.ts), or why the read is skipped; `pages` for a PDF (what its reservation is estimated on). */
type Prepared = PreparedInput | { readonly kind: 'skip'; readonly reason: AiSkipReason };

/** HTTP statuses of a failed call that a later attempt may get past; any other 4xx is the request itself refused. */
const RETRIED_4XX: ReadonlySet<number> = new Set([408, 409, 429]);

/** How long a read put back after attempt `attempt` (1, 2, 3) waits before it may be claimed again. */
export function retryDelayMs(attempt: number): number {
  return AI_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

export function createAiReader(deps: AiReaderDeps): AiReader {
  const { stores, blobs, logger, now } = deps;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const onRead: OnAiRead = deps.onRead ?? (() => Promise.resolve(null));
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

  /** The model's input from the original (extract/input.ts, within the reader's caps), read from storage as far as it needs. */
  function prepare(scope: OrgScope, file: FileRecord): Promise<PreparedInput> {
    const source = { kind: file.kind, sizeBytes: file.sizeBytes, name: file.name, read: (count?: number) => original(scope, file, count) };
    return prepareInput(source, READER_INPUT, deps.extractText);
  }

  async function audit(scope: OrgScope, file: FileRecord, result: AiReadResult, done: AiActionsOutcome | null): Promise<void> {
    const ai = file.ai;
    if (ai === null) return;
    try {
      const actor = ai.auto ? TOWNWISE_AI_ACTOR : {
        actorUserId: ai.requestedBy, actorEmail: (await deps.authStores.users.findById(ai.requestedBy))?.email ?? DELETED_PERSON,
        actorRole: ai.requestedByStaff ? 'superadmin' as const : ai.requestedByRole, viewAsGrantId: ai.requestedGrantId,
      };
      await stores.audit.insert({
        at: now(), ...actor,
        orgId: scope.orgId, action: 'file.ai_read', target: { type: 'file', id: file.id },
        details: {
          locationId: file.locationId, kind: result.kind, events: result.eventCount, days: result.dayCount,
          ...(done === null ? {} : {
            notes: done.notes.length, daysWritten: done.daysWritten, item: done.itemId !== null, calibration: done.calibration.status,
            rulesSuggested: done.rulesSuggested?.length ?? 0,
          }),
        },
      });
    } catch {
      logger.error({ action: 'file.ai_read', orgId: scope.orgId, targetId: file.id }, 'townwise.audit_write_failed');
    }
  }

  /** A model call that gave no answer (an API error, a timeout, a stop): the read goes back to the queue. */
  class CallFailed extends Error {}

  /**
   * The model's answer for a first attempt, checked and saved: within the budget (checked before the original is read,
   * then the most the call can cost reserved, and corrected to its cost after), and with the days the file's text bears
   * out. Null when the read ended here (finished as skipped or failed, or no longer held).
   */
  async function answer(
    scope: OrgScope, file: FileRecord, attempt: number, finish: (status: 'failed' | 'skipped', reason: string, costMicroUsd?: number) => Promise<boolean>,
  ): Promise<{ result: AiReadResult; partial: boolean; costMicroUsd: number } | null> {
    if (file.outcome === 'calendar_export') {
      await finish('skipped', 'calendar_export');
      return null;
    }
    const auto = file.ai?.auto === true;
    if (auto) {
      // D59: an automatic read, bounded before the budget is read or anything is reserved or sent.
      if (deps.agentAuto !== true || (await stores.orgs.findById(scope.orgId))?.agentAuto.on !== true) {
        await finish('skipped', 'agent_auto_off');
        return null;
      }
      // Turned off (D28) while it waited: it stays out of TownwiseAI until someone turns it back on and presses.
      if (file.disabledAt !== null) {
        await finish('skipped', 'turned_off');
        return null;
      }
      if (file.fingerprint !== null && await stores.files.hasReadTwin(scope, file.locationId, file.fingerprint, file.id)) {
        await finish('skipped', 'duplicate');
        return null;
      }
      const dayStart = new Date(`${now().toISOString().slice(0, 10)}T00:00:00.000Z`);
      // A retry of this read (its call gave no answer) is not counted against itself.
      if (await stores.files.countAutoReadsSince(scope, dayStart, file.id) >= AUTO_READS_PER_DAY) {
        await finish('skipped', 'daily_auto_limit');
        return null;
      }
    }
    const month = now().toISOString().slice(0, 7);
    const budget = Math.round(deps.filesMonthlyBudgetUsd * 1_000_000);
    // An automatic read may spend only while more than $1 would be left after its ceiling.
    const limit = auto ? budget - AUTO_RESERVE_MICRO_USD - 1 : budget;
    if (limit <= 0 || await stores.filesUsage.costMicroUsd(scope, month) >= limit) {
      await finish('skipped', 'budget_spent');
      return null;
    }
    const location = await stores.locations.find(scope, file.locationId);
    if (location === null) throw new Error('location gone');
    const { timeZone } = timeZoneOf(location.town);
    const today = localDay(now(), timeZone);
    let prepared: Prepared;
    try {
      prepared = await prepare(scope, file);
    } catch (err) {
      if (!(err instanceof BlobMissingError)) throw err;
      prepared = skip('raw_missing');
    }
    if (prepared.kind === 'skip') {
      await finish('skipped', prepared.reason);
      return null;
    }
    if (prepared.input.type === 'text' && prepared.input.form === 'text' && isCalendarCsvText(prepared.input.text)) {
      await finish('skipped', 'calendar_export');
      return null;
    }
    const reserved = readerCeilingMicroUsd(prepared.input, prepared.pages);
    if (!await stores.filesUsage.reserve(scope, month, reserved, limit, now())) {
      await finish('skipped', 'budget_spent');
      return null;
    }
    // D59: the day's count of automatic reads counts this one from here.
    if (auto) await stores.files.markAiCharged(scope, file.id, attempt, now());
    let reply;
    try {
      reply = await deps.model.readFile(readerRequest(prepared.input, { today, timeZone }), abort.signal);
    } finally {
      // The reservation becomes what the call cost (nothing for a call that gave no answer).
      const cost = reply === undefined || reply.kind === 'failed' ? 0 : reply.costMicroUsd;
      await stores.filesUsage.add(scope, month, cost - reserved, now());
    }
    if (reply.kind === 'failed') {
      logger.warn({ fileId: file.id, errType: reply.errType, status: reply.status }, 'townwise.ai_read_model_failed');
      if (reply.status !== null && reply.status >= 400 && reply.status < 500 && !RETRIED_4XX.has(reply.status)) {
        // The API refused the request itself: another attempt would send the same request.
        await finish('failed', 'internal');
        return null;
      }
      throw new CallFailed();
    }
    if (reply.kind === 'refused' || reply.kind === 'too_long') {
      // Nothing is written but the outcome and its cost; a retry would cost again.
      await finish('failed', reply.kind === 'refused' ? 'refused' : 'answer_too_long', reply.costMicroUsd);
      return null;
    }
    const answered = readerResult(reply.output, today);
    if (answered === null) {
      // No answer to keep; a retry would cost again, so the read fails.
      await finish('failed', 'internal', reply.costMicroUsd);
      return null;
    }
    const latest = utcDay(new Date(`${today}T00:00:00.000Z`), 1);
    const result: AiReadResult = {
      ...answered,
      daysBorneOut: prepared.sourceText === null ? null : verifiedIndexes(answered.days, prepared.sourceText, { earliest: EARLIEST_DATE, latest }),
    };
    if (!await stores.files.saveAiResult(scope, file.id, attempt, { result, partial: prepared.partial, costMicroUsd: reply.costMicroUsd })) {
      // Still held, the original was deleted while the model read it (a purge): nothing of the answer is kept.
      await finish('skipped', 'raw_missing', reply.costMicroUsd);
      return null;
    }
    return { result, partial: prepared.partial, costMicroUsd: reply.costMicroUsd };
  }

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
    // A retry of a read whose answer was saved acts on it again, without the original or another call.
    const read = ai.result === null
      ? await answer(scope, file, claim.attempt, finish)
      : { result: ai.result, partial: ai.partial, costMicroUsd: ai.costMicroUsd };
    if (read === null) return;
    const { result } = read;
    if (await onRead(scope, file, read) === 'requester_gone') {
      await finish('skipped', 'requester_gone');
      return;
    }
    // What onRead did, as it recorded it: counts and codes only. Stopped short because the original was deleted
    // meanwhile (a purge), the read is skipped; what it wrote before can still be undone.
    const after = await stores.files.get(scope, file.locationId, file.id);
    const done = after?.ai?.actions?.outcome ?? null;
    if (done === null && after !== null && after.rawDeletedAt !== null) {
      await finish('skipped', 'raw_missing');
      return;
    }
    if (!await finish('done', null)) return;
    logger.info({
      fileId: file.id, kind: result.kind, confidence: result.confidence, events: result.eventCount, days: result.dayCount,
      daysCut: result.daysCut, partial: read.partial, costMicroUsd: read.costMicroUsd,
      ...(done === null ? {} : {
        notes: done.notes.length, notesSkipped: done.notesSkipped, notesSuggested: done.notesSuggested?.length ?? 0,
        daysWritten: done.daysWritten, daysAlreadyHad: done.daysAlreadyHad,
        daysReason: done.daysReason, item: done.itemId !== null, itemReason: done.itemReason, calibration: done.calibration.status,
        rulesSuggested: done.rulesSuggested?.length ?? 0, rulesSkipped: done.rulesSkipped ?? { duplicate: 0, cap: 0, invalid: 0 },
      }),
    }, 'townwise.ai_read');
    await audit(scope, file, result, done);
  }

  /** D59 slice 2: a calendar's automatic sort, claimed when no read is waiting; false when there is none. */
  async function sortTick(sorts: CalendarSorts): Promise<boolean> {
    const claim = await claimNextCalendarSort(deps.connection, { now: now(), leaseMs });
    if (claim === null) return false;
    const scope = scopeForClaimedCalendarSort(claim);
    const heartbeat = setInterval(() => {
      void sorts.renew(scope, claim, new Date(now().getTime() + leaseMs)).catch(() => undefined);
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    try {
      await sorts.run(scope, claim);
    } catch (err) {
      logger.warn({ calendarId: claim.calendarId, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.calendar_auto_sort_attempt_failed');
      await sorts.release(scope, claim, new Date(now().getTime() + retryDelayMs(claim.attempt))).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async function tick(): Promise<boolean> {
    const claim = await claimNextAiRead(deps.connection, { now: now(), leaseMs });
    if (claim === null) return deps.sorts === undefined ? false : sortTick(deps.sorts);
    const scope = scopeForClaimedAiRead(claim);
    const heartbeat = setInterval(() => {
      void stores.files.renewAiLease(scope, claim.id, claim.attempt, new Date(now().getTime() + leaseMs)).catch(() => undefined);
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    try {
      await readOne(scope, claim);
    } catch (err) {
      // Back to the queue after a wait; the attempt counted, and after three the read is failed with `internal`.
      if (!(err instanceof CallFailed)) logger.warn({ fileId: claim.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.ai_read_attempt_failed');
      await stores.files.releaseAiRead(scope, claim.id, claim.attempt, new Date(now().getTime() + retryDelayMs(claim.attempt))).catch(() => undefined);
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
