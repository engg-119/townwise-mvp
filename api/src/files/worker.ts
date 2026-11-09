// The file reader (spec 11A): a loop in each API replica that claims a started import (a lease in Mongo, through
// stores/cross-tenant.ts), reads its files one at a time in upload order in the parse thread, and writes each file's
// days through the existing sales-days store. One file per replica at a time; one active import per location, so a
// location's files are never read concurrently. Shaped as createFileWorker(deps) so it can move to a job unchanged.
// Logs carry ids, kinds, counts and codes only: never a file name, header, sheet name, location value or figure.
import { createHash, randomBytes } from 'node:crypto';

import type { AuthStores } from '@ckeith26/auth';
import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForClaimedImport, type OrgScope } from '../access/policy.ts';
import { utcDay } from '../dates.ts';
import { DELETED_PERSON } from '../people.ts';
import { claimNextImport, type ClaimedImport } from '../stores/cross-tenant.ts';
import type { EntryCounts, FileProgress, FileRecord, FileResult } from '../stores/files.ts';
import type { ImportRecord } from '../stores/imports.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { BlobMissingError, type FileBlobs } from './blobs.ts';
import { cleanCsv } from './clean.ts';
import { purgeOriginal, RAW_DELETED } from './remove.ts';
import type { ExtractModel } from './extract/model.ts';
import type { RedactedProfile } from './extract/profile.ts';
import type { ColumnChoice } from './extract/prompt.ts';
import {
  APPLY_BATCH_DAYS, DOCX_READ_BYTES, ENTRY_BATCH, HEAD_BYTES, MODEL_CALLS_PER_FILE, MODEL_CALLS_PER_IMPORT, MODEL_CALLS_PER_ZIP,
  PDF_READ_BYTES, MAX_ATTEMPTS, PROGRESS_WRITE_MS, READ_TIME_MS, XLSX_READ_BYTES,
} from './limits.ts';
import type { EntryRow } from './parse/archive.ts';
import { runParse, type FileOutcome, type ParseInput, type ParseKind } from './parse/run.ts';
import { sniff } from './sniff.ts';

export interface FileWorkerDeps {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  readonly authStores: Pick<AuthStores, 'users'>;
  readonly blobs: FileBlobs;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly replicaId?: string;
  /** How often an idle reader looks for work; a nudge looks at once. */
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  /** Tests pass shorter parse limits. */
  readonly parse?: (input: ParseInput) => Promise<FileOutcome>;
  /** The AI column step (spec 11A); absent (no ANTHROPIC_API_KEY), the reader asks the person instead. */
  readonly extract?: ExtractModel | undefined;
  /** Its monthly spend limit per organization, in US dollars; 0 turns it off. */
  readonly filesMonthlyBudgetUsd?: number;
}

export interface FileWorker {
  start(): void;
  /** Look for work now (an import started, a file queued, a question answered). */
  nudge(): void;
  /** Resolves when the reader has nothing left it can claim (tests). */
  settled(): Promise<void>;
  close(): Promise<void>;
  readonly name: string;
}

const POLL_MS = 5000;
const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
/** A suspended organization's import waits this long before the reader looks again. */
const DEFER_MS = 60 * 60 * 1000;

/** Why a file of this kind is kept unread in this build, or null when the reader opens it. */
function unreadOutcome(file: FileRecord, head: Uint8Array | null): string | null {
  switch (file.kind) {
    case 'text': return null;
    case 'xlsx': return file.sizeBytes > XLSX_READ_BYTES ? 'too_large_to_read' : null;
    case 'xls': return 'old_excel';
    case 'doc': return 'old_word';
    case 'zip': return null;
    case 'pdf': return file.sizeBytes > PDF_READ_BYTES ? 'too_large_to_read' : null;
    case 'docx': return file.sizeBytes > DOCX_READ_BYTES ? 'too_large_to_read' : null;
    case 'other': return (head === null ? null : sniff(file.name, head).outcome) ?? 'type_not_read';
  }
}

export function createFileWorker(deps: FileWorkerDeps): FileWorker {
  const { stores, blobs, logger, now } = deps;
  const owner = deps.replicaId ?? `reader-${randomBytes(6).toString('hex')}`;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const parse = deps.parse ?? runParse;
  let stopped = false;
  let busy: Promise<void> | null = null;
  let again = false;
  let poll: NodeJS.Timeout | undefined;
  const abort = new AbortController();

  const emailOf = async (userId: string): Promise<string> => (await deps.authStores.users.findById(userId))?.email ?? DELETED_PERSON;

  async function audit(scope: OrgScope, file: FileRecord, details: Record<string, string | number>): Promise<void> {
    try {
      await stores.audit.insert({
        at: now(), actorUserId: file.uploadedBy, actorEmail: await emailOf(file.uploadedBy),
        actorRole: file.byStaff ? 'superadmin' : file.uploaderRole, viewAsGrantId: null, orgId: scope.orgId, action: 'sales.uploaded', target: { type: 'upload', id: String(details.uploadId) },
        details: {
          locationId: file.locationId, dayCount: details.dayCount ?? 0, inserted: details.inserted ?? 0, replaced: details.replaced ?? 0,
          firstDate: details.firstDate ?? '', lastDate: details.lastDate ?? '', fileId: file.id, via: 'file',
        },
      });
    } catch {
      logger.error({ action: 'sales.uploaded', orgId: scope.orgId, targetId: file.id }, 'townwise.audit_write_failed');
    }
  }

  /**
   * The AI column step for one file, within its bounds: 2 calls a file (5 a ZIP, at most one a family), 20 an import,
   * and the organization's monthly budget, checked before each call and charged after it whatever its outcome. Off,
   * spent or failed, it answers null and the person is asked instead. Never retried beyond the SDK. An answer is saved
   * on the file by a hash of the profile, so a re-read of the same table (after a later question, or a retry) reuses it
   * without a call: the mapping the person answered against stays the one used, and stays the AI's.
   */
  function columnStep(scope: OrgScope, record: ImportRecord, file: FileRecord): ((profile: RedactedProfile) => Promise<ColumnChoice | null>) | undefined {
    const extract = deps.extract;
    const budget = Math.round((deps.filesMonthlyBudgetUsd ?? 0) * 1_000_000);
    if (extract === undefined || budget <= 0) return undefined;
    const perFile = file.kind === 'zip' ? MODEL_CALLS_PER_ZIP : MODEL_CALLS_PER_FILE;
    let calls = file.modelCalls;
    const saved = new Map(Object.entries(file.aiChoices));
    return async (profile) => {
      const key = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
      const known = saved.get(key);
      if (known !== undefined) return known;
      if (calls >= perFile) return null;
      const others = (await stores.files.inImport(scope, record.id)).reduce((sum, other) => sum + (other.id === file.id ? 0 : other.modelCalls), 0);
      if (others + calls >= MODEL_CALLS_PER_IMPORT) return null;
      const month = now().toISOString().slice(0, 7);
      if (await stores.filesUsage.costMicroUsd(scope, month) >= budget) return null;
      calls += 1;
      const result = await extract.chooseColumns(profile, abort.signal);
      if (result.kind === 'failed') {
        logger.warn({ fileId: file.id, errType: result.errType, status: result.status }, 'townwise.extract_model_failed');
        await stores.files.addModelCall(scope, file.id, 0);
        return null;
      }
      const choice = result.choice === null ? null : { guests: result.choice.guests, netSales: result.choice.netSales, confidence: result.choice.confidence };
      saved.set(key, choice);
      await stores.filesUsage.add(scope, month, result.costMicroUsd, now());
      await stores.files.addModelCall(scope, file.id, result.costMicroUsd, { key, choice });
      logger.info({ fileId: file.id, costMicroUsd: result.costMicroUsd, answered: result.choice !== null }, 'townwise.extract_model_call');
      return result.choice;
    };
  }

  /** A ZIP's entry rows, written before the file settles; the counts go on the file. Null for any other file. */
  async function listEntries(scope: OrgScope, file: FileRecord, rows: readonly EntryRow[] | undefined): Promise<EntryCounts | null> {
    if (rows === undefined) return null;
    await stores.fileEntries.replace(scope, file.locationId, file.id, rows, ENTRY_BATCH);
    const counts = { total: rows.length, used: rows.filter((row) => row.status === 'used').length, kept: rows.filter((row) => row.status === 'kept').length };
    logger.info({ fileId: file.id, ...counts }, 'townwise.file_entries');
    return counts;
  }

  /** The file's days into tw_sales_days, its cleaned copy, and its result. */
  async function write(scope: OrgScope, record: ImportRecord, file: FileRecord, outcome: Extract<FileOutcome, { kind: 'days' }>, startedAt: Date): Promise<void> {
    const { days, report } = outcome;
    const replace = file.uploaderRole === 'org_admin';
    const firstDate = days[0]?.date ?? '';
    const lastDate = days.at(-1)?.date ?? '';
    let uploadId = file.uploadId;
    if (uploadId === null) {
      // SEAM (U6 step 2): tw_uploads gains fileId when stores/uploads.ts takes it; until then the file holds the link.
      const started = await stores.uploads.start(scope, file.locationId, {
        uploadedBy: file.uploadedBy, ...(file.byStaff ? { byStaff: true } : {}), uploadedAt: now(), dayCount: days.length, firstDate, lastDate,
        hasGuests: days.some((day) => day.guests !== null), hasNetSales: days.some((day) => day.netSalesCents !== null),
      });
      uploadId = started.id;
      await stores.files.setUploadId(scope, file.id, uploadId);
    }
    let inserted = 0;
    let matched = 0;
    const phaseStartedAt = now();
    for (let at = 0; at < days.length; at += APPLY_BATCH_DAYS) {
      const applied = await stores.salesDays.apply(scope, file.locationId, { uploadId, days: days.slice(at, at + APPLY_BATCH_DAYS), replace, now: now() });
      inserted += applied.inserted;
      matched += applied.matched;
      await stores.files.setProgress(scope, file.id, {
        phase: 'writing', done: Math.min(days.length, at + APPLY_BATCH_DAYS), total: days.length, unit: 'days', phaseStartedAt, updatedAt: now(),
      });
    }
    const counts = { inserted, replaced: replace ? matched : 0, kept: replace ? 0 : matched };
    await stores.uploads.finish(scope, uploadId, counts);
    const csv = cleanCsv(days);
    await blobs.writeClean(scope, { locationId: file.locationId, fileId: file.id }, csv);
    const result: FileResult = {
      dayCount: days.length, firstDate, lastDate, guestsDayCount: report.guestsDayCount, netSalesDayCount: report.netSalesDayCount,
      ...counts, closedDates: report.closedDates, missingDays: report.missingDays, uploadId,
    };
    const readMs = now().getTime() - startedAt.getTime();
    const entries = await listEntries(scope, file, outcome.entries);
    const settled = await stores.files.settle(scope, file.id, {
      status: 'read', outcome: null, result, report: { ...report, overlap: { days: matched, replaced: replace } },
      cleanBytes: Buffer.byteLength(csv), readMs, ...(entries === null ? {} : { entries }),
    });
    if (!settled) {
      // The file was deleted while it was read: its days stay, like any deleted file's, but not its cleaned copy or
      // its entry list.
      await blobs.deleteClean(scope, { locationId: file.locationId, fileId: file.id });
      await stores.fileEntries.removeForFile(scope, file.id);
      return;
    }
    await stores.imports.applied(scope, record.id);
    await stores.imports.addThroughput(scope, record.id, file.sizeBytes, readMs);
    await audit(scope, file, { uploadId, dayCount: days.length, ...counts, firstDate, lastDate });
    logger.info({
      orgId: scope.orgId, locationId: file.locationId, fileId: file.id, importId: record.id, dayCount: days.length, durationMs: readMs,
    }, 'townwise.file_read');
  }

  async function headOf(scope: OrgScope, file: FileRecord): Promise<Uint8Array | null> {
    if (file.kind !== 'other') return null;
    const body = await blobs.openRaw(
      scope, { locationId: file.locationId, fileId: file.id }, { offset: 0, count: Math.min(HEAD_BYTES, file.sizeBytes) }, AbortSignal.timeout(READ_TIME_MS),
    );
    const parts: Buffer[] = [];
    for await (const part of body) parts.push(Buffer.from(part as Uint8Array));
    return Buffer.concat(parts);
  }

  /** One file. Resolves true when it asked a question (the import now waits for the person). */
  async function readOne(scope: OrgScope, record: ImportRecord, queued: FileRecord, location: LocationRecord): Promise<boolean> {
    const file = await stores.files.startReading(scope, queued.id, now());
    if (file === null) return false;
    const startedAt = now();
    const kept = async (outcome: string, status: 'kept' | 'failed' = 'kept', rows?: readonly EntryRow[]): Promise<boolean> => {
      const entries = await listEntries(scope, file, rows);
      const settled = await stores.files.settle(scope, file.id, {
        status, outcome, report: null, readMs: now().getTime() - startedAt.getTime(), ...(entries === null ? {} : { entries }),
      });
      if (!settled && entries !== null) await stores.fileEntries.removeForFile(scope, file.id);
      if (status === 'kept') await stores.imports.addThroughput(scope, record.id, file.sizeBytes, now().getTime() - startedAt.getTime());
      logger.info({ fileId: file.id, kind: file.kind, outcome }, status === 'kept' ? 'townwise.file_kept' : 'townwise.file_failed');
      return false;
    };
    if (file.purgeRaw) {
      // A staff purge flagged it: never read, kept unread; purgeIfFlagged then deletes the original.
      await stores.files.settle(scope, file.id, { status: 'kept', outcome: RAW_DELETED, report: null, readMs: null });
      logger.info({ fileId: file.id, kind: file.kind, outcome: RAW_DELETED }, 'townwise.file_kept');
      return false;
    }
    if (file.attempts > MAX_ATTEMPTS) return kept('internal', 'failed');
    if (file.rawDeletedAt !== null) return kept('raw_missing', 'failed');
    try {
      const unread = unreadOutcome(file, await headOf(scope, file));
      if (unread !== null) return await kept(unread);
      let lastWrite = 0;
      const kind: ParseKind = file.kind === 'xlsx' || file.kind === 'zip' || file.kind === 'pdf' || file.kind === 'docx' ? file.kind : 'text';
      const ref = { locationId: file.locationId, fileId: file.id };
      const step = columnStep(scope, record, file);
      const outcome = await parse({
        kind,
        sizeBytes: file.sizeBytes,
        answers: file.answers,
        locationName: location.name,
        latest: utcDay(now(), 1),
        replace: file.uploaderRole === 'org_admin',
        ...(step === undefined ? {} : { chooseColumns: step }),
        open: (signal) => blobs.openRaw(scope, ref, undefined, signal),
        openAt: (offset, signal) => blobs.openRaw(scope, ref, { offset, count: file.sizeBytes - offset }, signal),
        signal: abort.signal,
        onProgress: (done, total) => {
          const at = now().getTime();
          if (at - lastWrite < PROGRESS_WRITE_MS) return;
          lastWrite = at;
          const progress: FileProgress = {
            phase: kind === 'zip' ? 'unpacking' : 'reading', done, total, unit: kind === 'pdf' ? 'pages' : 'bytes',
            phaseStartedAt: startedAt, updatedAt: now(),
          };
          void stores.files.setProgress(scope, file.id, progress).catch(() => undefined);
        },
      });
      if (outcome.kind === 'kept') return await kept(outcome.outcome, 'kept', outcome.entries);
      if (outcome.kind === 'question') {
        const question = { ...outcome.question, id: randomBytes(8).toString('hex'), fileId: file.id };
        await stores.files.settle(scope, file.id, { status: 'waiting', outcome: null });
        await stores.imports.ask(scope, record.id, question);
        logger.info({ fileId: file.id, kind: question.kind }, 'townwise.file_question');
        return true;
      }
      if (outcome.days.length === 0) return await kept('no_dates');
      await write(scope, record, file, outcome, startedAt);
      return false;
    } catch (err) {
      if (err instanceof BlobMissingError) return kept('raw_missing', 'failed');
      // Back to the queue; the attempt counted, and after three the file is failed with `internal`.
      logger.warn({ fileId: file.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.file_read_failed');
      await stores.files.settle(scope, file.id, { status: 'queued', outcome: null });
      return false;
    }
  }

  /**
   * A staff purge flagged this file while it was read: now that the reader is done with it (read, kept, failed, back in
   * the queue, or waiting on a question), its original goes (spec 11A).
   */
  async function purgeIfFlagged(scope: OrgScope, locationId: string, fileId: string): Promise<void> {
    const file = await stores.files.get(scope, locationId, fileId);
    if (file?.purgeRaw !== true || file.status === 'reading') return;
    if (await purgeOriginal(stores, blobs, scope, file, now()) !== 'deleted') return;
    logger.info({ orgId: scope.orgId, locationId, count: 1, by: 'staff' }, 'townwise.originals_deleted');
  }

  async function work(scope: OrgScope, claim: ClaimedImport): Promise<void> {
    const org = await stores.orgs.findById(scope.orgId);
    if (org?.status !== 'active') {
      await stores.imports.deferLease(scope, claim.id, owner, new Date(now().getTime() + DEFER_MS));
      return;
    }
    const location = await stores.locations.find(scope, claim.locationId);
    for (;;) {
      if (stopped) return;
      const record = await stores.imports.get(scope, claim.locationId, claim.id);
      if (record?.lease?.owner !== owner || record.status !== 'reading') return;
      const file = await stores.files.nextToRead(scope, claim.id);
      if (file === null || location === null) {
        const files = (await stores.files.inImport(scope, claim.id)).length;
        if (await stores.imports.finish(scope, claim.id, { owner, drops: record.drops, now: now() })) {
          logger.info({ importId: claim.id, files, durationMs: now().getTime() - (record.startedAt ?? now()).getTime() }, 'townwise.import_done');
          return;
        }
        continue;
      }
      const asked = await readOne(scope, record, file, location);
      await purgeIfFlagged(scope, file.locationId, file.id);
      if (asked) return;
    }
  }

  async function tick(): Promise<boolean> {
    const claim = await claimNextImport(deps.connection, { owner, now: now(), leaseMs });
    if (claim === null) return false;
    const scope = scopeForClaimedImport(claim);
    const heartbeat = setInterval(() => {
      void stores.imports.extendLease(scope, claim.id, owner, new Date(now().getTime() + leaseMs)).catch(() => undefined);
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    try {
      await work(scope, claim);
    } catch (err) {
      logger.error({ importId: claim.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.file_worker_failed');
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async function drain(): Promise<void> {
    try {
      while (!stopped && await tick());
    } catch (err) {
      logger.error({ errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.file_worker_failed');
    }
  }

  const worker: FileWorker = {
    name: 'file-reader',
    start() {
      poll = setInterval(() => { worker.nudge(); }, deps.pollMs ?? POLL_MS);
      worker.nudge();
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
          worker.nudge();
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
  return worker;
}
