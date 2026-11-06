// The daily file sweep (spec 11A, retention): one replica a day, under a lease in tw_file_sweeps. It discards upload
// sessions past their 24 hours, deletes originals a year after upload (read or not), deletes files dropped but never sent for
// reading after 30 days, finishes staff purges of files that were busy, drops daily upload counters after 3 days, and
// deletes blobs whose file row is gone (and that are a day old, so a file being written is never taken). The lookups
// span organizations, so they live in stores/cross-tenant.ts; every effect runs through the tenant stores with the
// organization's scope. Logs carry counts only. [CONFIRM: retention periods]
import { randomBytes } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForSweep } from '../access/policy.ts';
import { utcDay } from '../dates.ts';
import {
  claimFileSweep, existingFileIds, finishFileSweep, removeOldUploadDays, sweepCandidates,
} from '../stores/cross-tenant.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { BlobMissingError, type FileBlobs, type ListedBlob } from './blobs.ts';
import { RAW_RETENTION_DAYS } from './limits.ts';
import { purgeOriginal } from './remove.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Files dropped but never sent for reading. */
export const NEVER_READ_DAYS = 30;
/** Daily upload counters. */
export const UPLOAD_DAY_KEEP_DAYS = 3;
/** A blob without a row is an orphan only once it is this old. */
export const ORPHAN_AGE_MS = DAY_MS;
/** Rows of each kind one sweep takes; the next sweep takes the rest. */
const SWEEP_LIMIT = 500;
const LEASE_MS = 30 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const ORPHAN_BATCH = 200;

export interface SweepCounts {
  expiredUploads: number;
  expiredOriginals: number;
  abandonedFiles: number;
  purged: number;
  uploadDays: number;
  orphans: number;
}

export interface FileSweeper {
  start(): void;
  /** One sweep, when this replica can take the lease and a day has passed since the last; null when it did not run. */
  runOnce(): Promise<SweepCounts | null>;
  close(): Promise<void>;
  readonly name: string;
}

export function createFileSweeper(deps: {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  readonly blobs: FileBlobs;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly replicaId?: string;
  readonly checkMs?: number;
}): FileSweeper {
  const { connection, stores, blobs, logger, now } = deps;
  const owner = deps.replicaId ?? `sweeper-${randomBytes(6).toString('hex')}`;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<SweepCounts | null> | null = null;

  const ignoreMissing = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof BlobMissingError)) throw err;
    }
  };

  async function orphans(at: Date): Promise<number> {
    let deleted = 0;
    let batch: ListedBlob[] = [];
    const flush = async (): Promise<void> => {
      const alive = await existingFileIds(connection, [...new Set(batch.map((blob) => blob.fileId))]);
      for (const blob of batch) {
        if (alive.has(blob.fileId) || at.getTime() - blob.lastModified.getTime() < ORPHAN_AGE_MS) continue;
        const scope = scopeForSweep(blob);
        const ref = { locationId: blob.locationId, fileId: blob.fileId };
        await ignoreMissing(() => (blob.container === 'raw' ? blobs.deleteRaw(scope, ref) : blobs.deleteClean(scope, ref)));
        deleted += 1;
      }
      batch = [];
    };
    for await (const blob of blobs.listAll()) {
      batch.push(blob);
      if (batch.length >= ORPHAN_BATCH) await flush();
    }
    await flush();
    return deleted;
  }

  async function sweep(at: Date): Promise<SweepCounts> {
    const counts: SweepCounts = { expiredUploads: 0, expiredOriginals: 0, abandonedFiles: 0, purged: 0, uploadDays: 0, orphans: 0 };
    const found = await sweepCandidates(connection, {
      now: at, originalsBefore: new Date(at.getTime() - RAW_RETENTION_DAYS * DAY_MS),
      dropsBefore: new Date(at.getTime() - NEVER_READ_DAYS * DAY_MS), limit: SWEEP_LIMIT,
    });
    for (const item of found.expiredUploads) {
      const scope = scopeForSweep(item);
      const file = await stores.files.get(scope, item.locationId, item.id);
      if (file?.status !== 'uploading') continue;
      await ignoreMissing(() => blobs.discardUpload(scope, { locationId: item.locationId, fileId: item.id }));
      if (await stores.files.remove(scope, item.id)) counts.expiredUploads += 1;
      if (file.importId !== null) {
        await stores.imports.removeIfEmptyOpen(scope, file.importId, (await stores.files.inImport(scope, file.importId)).length);
      }
    }
    for (const [list, key] of [[found.expiredOriginals, 'expiredOriginals'], [found.purges, 'purged']] as const) {
      for (const item of list) {
        const scope = scopeForSweep(item);
        const file = await stores.files.get(scope, item.locationId, item.id);
        // Not read yet (a question nobody answered, an import nobody started) still goes: kept unread, then deleted.
        if (file === null) continue;
        if (await purgeOriginal(stores, blobs, scope, file, at) === 'deleted') counts[key] += 1;
      }
    }
    for (const item of found.abandonedImports) {
      const scope = scopeForSweep(item);
      const record = await stores.imports.get(scope, item.locationId, item.id);
      if (record?.status !== 'open') continue;
      for (const file of await stores.files.inImport(scope, item.id)) {
        const ref = { locationId: file.locationId, fileId: file.id };
        await ignoreMissing(() => (file.status === 'uploading' ? blobs.discardUpload(scope, ref) : blobs.deleteRaw(scope, ref)));
        await ignoreMissing(() => blobs.deleteClean(scope, ref));
        await stores.fileEntries.removeForFile(scope, file.id);
        if (await stores.files.remove(scope, file.id)) counts.abandonedFiles += 1;
      }
      await stores.imports.remove(scope, item.id);
    }
    counts.uploadDays = await removeOldUploadDays(connection, utcDay(at, -UPLOAD_DAY_KEEP_DAYS));
    counts.orphans = await orphans(at);
    return counts;
  }

  const sweeper: FileSweeper = {
    name: 'file-sweeper',
    start() {
      timer = setInterval(() => { void sweeper.runOnce(); }, deps.checkMs ?? CHECK_MS);
      void sweeper.runOnce();
    },
    runOnce() {
      running ??= (async () => {
        try {
          const at = now();
          if (!(await claimFileSweep(connection, { owner, now: at, leaseMs: LEASE_MS, everyMs: DAY_MS }))) return null;
          const counts = await sweep(at);
          await finishFileSweep(connection, { owner, now: at });
          logger.info({ ...counts, durationMs: now().getTime() - at.getTime() }, 'townwise.files_swept');
          if (counts.expiredOriginals > 0) logger.info({ count: counts.expiredOriginals, by: 'retention' }, 'townwise.originals_deleted');
          if (counts.purged > 0) logger.info({ count: counts.purged, by: 'staff' }, 'townwise.originals_deleted');
          return counts;
        } catch (err) {
          logger.error({ errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.files_sweep_failed');
          return null;
        } finally {
          running = null;
        }
      })();
      return running;
    },
    async close() {
      clearInterval(timer);
      await running;
    },
  };
  return sweeper;
}
