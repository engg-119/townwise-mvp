// The file reader (spec 11A): a loop in each API replica that claims a started import (a lease in Mongo, through
// stores/cross-tenant.ts), reads its files one at a time in upload order in the parse thread, and writes each file's
// days through the existing sales-days store. One file per replica at a time; one active import per location, so a
// location's files are never read concurrently. Shaped as createFileWorker(deps) so it can move to a job unchanged.
// Logs carry ids, kinds, counts and codes only: never a file name, header, sheet name, location value or figure.
import { randomBytes } from 'node:crypto';

import type { AuthStores } from '@ckeith26/auth';
import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForClaimedImport, type OrgScope } from '../access/policy.ts';
import { utcDay } from '../dates.ts';
import { DELETED_PERSON } from '../people.ts';
import { claimNextImport, type ClaimedImport } from '../stores/cross-tenant.ts';
import type { FileProgress, FileRecord, FileResult } from '../stores/files.ts';
import type { ImportRecord } from '../stores/imports.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { BlobMissingError, type FileBlobs } from './blobs.ts';
import { cleanCsv } from './clean.ts';
import { APPLY_BATCH_DAYS, HEAD_BYTES, MAX_ATTEMPTS, PROGRESS_WRITE_MS, READ_TIME_MS, XLSX_READ_BYTES } from './limits.ts';
import { runParse, type FileOutcome, type ParseInput } from './parse/run.ts';
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
    // ZIP archives, PDFs and Word tables are read by later stages; until then they are kept, and say so.
    case 'zip': case 'pdf': case 'docx': return 'type_not_read';
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
        at: now(), actorUserId: file.uploadedBy, actorEmail: await emailOf(file.uploadedBy), actorRole: file.uploaderRole,
        viewAsGrantId: null, orgId: scope.orgId, action: 'sales.uploaded', target: { type: 'upload', id: String(details.uploadId) },
        details: {
          locationId: file.locationId, dayCount: details.dayCount ?? 0, inserted: details.inserted ?? 0, replaced: details.replaced ?? 0,
          firstDate: details.firstDate ?? '', lastDate: details.lastDate ?? '', fileId: file.id, via: 'file',
        },
      });
    } catch {
      logger.error({ action: 'sales.uploaded', orgId: scope.orgId, targetId: file.id }, 'townwise.audit_write_failed');
    }
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
        uploadedBy: file.uploadedBy, uploadedAt: now(), dayCount: days.length, firstDate, lastDate,
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
    const settled = await stores.files.settle(scope, file.id, {
      status: 'read', outcome: null, result, report: { ...report, overlap: { days: matched, replaced: replace } },
      cleanBytes: Buffer.byteLength(csv), readMs,
    });
    if (!settled) {
      // The file was deleted while it was read: its days stay, like any deleted file's, but not its cleaned copy.
      await blobs.deleteClean(scope, { locationId: file.locationId, fileId: file.id });
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
    const kept = async (outcome: string, status: 'kept' | 'failed' = 'kept'): Promise<boolean> => {
      await stores.files.settle(scope, file.id, { status, outcome, report: null, readMs: now().getTime() - startedAt.getTime() });
      if (status === 'kept') await stores.imports.addThroughput(scope, record.id, file.sizeBytes, now().getTime() - startedAt.getTime());
      logger.info({ fileId: file.id, kind: file.kind, outcome }, status === 'kept' ? 'townwise.file_kept' : 'townwise.file_failed');
      return false;
    };
    if (file.attempts > MAX_ATTEMPTS) return kept('internal', 'failed');
    if (file.rawDeletedAt !== null) return kept('raw_missing', 'failed');
    try {
      const unread = unreadOutcome(file, await headOf(scope, file));
      if (unread !== null) return await kept(unread);
      let lastWrite = 0;
      const outcome = await parse({
        kind: file.kind === 'xlsx' ? 'xlsx' : 'text',
        sizeBytes: file.sizeBytes,
        answers: file.answers,
        locationName: location.name,
        latest: utcDay(now(), 1),
        replace: file.uploaderRole === 'org_admin',
        open: (signal) => blobs.openRaw(scope, { locationId: file.locationId, fileId: file.id }, undefined, signal),
        signal: abort.signal,
        onProgress: (done, total) => {
          const at = now().getTime();
          if (at - lastWrite < PROGRESS_WRITE_MS) return;
          lastWrite = at;
          const progress: FileProgress = { phase: 'reading', done, total, unit: 'bytes', phaseStartedAt: startedAt, updatedAt: now() };
          void stores.files.setProgress(scope, file.id, progress).catch(() => undefined);
        },
      });
      if (outcome.kind === 'kept') return await kept(outcome.outcome);
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
      if (await readOne(scope, record, file, location)) return;
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
