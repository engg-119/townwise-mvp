import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../../api/client';
import { usePortal, useReadOnly } from '../PortalProvider';
import { completeUpload, createUpload, getFile, putChunk, removeFile, type FilePurpose, type FileView } from './api';

// The upload queue (storage2 9.2 and 15.2): every dropped file is its own chunked upload, three at a time with
// the rest waiting in drop order, one chunk in flight per file. Each file reports its bytes sent, a smoothed
// speed and its time left; the queue reports the same across every file. The engine is plain TypeScript with an
// injectable clock, so the tests drive it with fake timers; useUploadQueue wraps it for a screen.

export type UploadState =
  | 'waiting' | 'creating' | 'sending' | 'retrying' | 'completing' | 'done' | 'refused' | 'failed' | 'cancelled';

export interface QueuedUpload {
  /** A client id, stable for the row. */
  key: string;
  fileId: string | null;
  name: string;
  sizeBytes: number;
  state: UploadState;
  sentBytes: number;
  /** Smoothed bytes per second; null until the first second of sending is measured. */
  bytesPerSecond: number | null;
  /** Null ("Estimating") until 2 seconds and 256 KiB of this file are sent. */
  secondsLeft: number | null;
  /** Worded by copy.uploadError(code, detail). */
  error: { code: string; detail?: Readonly<Record<string, unknown>> } | null;
  /** The stored file, from complete. */
  file: FileView | null;
}

export interface QueueOverall {
  /** Files not refused, failed or cancelled. */
  files: number;
  bytes: number;
  sentBytes: number;
  /** Across every file still to send; null until a file has a time left, 0 when nothing is left. */
  secondsLeft: number | null;
}

export interface QueueSnapshot {
  items: QueuedUpload[];
  overall: QueueOverall;
  /** The import the first file joined. */
  importId: string | null;
  /** 503 files_unavailable: stored files are off, so the screen shows P13's browser upload instead. */
  filesUnavailable: boolean;
}

export interface UploadQueue extends QueueSnapshot {
  /** Drag and drop or the picker; any number of files. */
  add: (files: readonly UploadSource[]) => void;
  /** Stops a file and deletes what the server has of it; a waiting file just leaves the queue. */
  cancel: (key: string) => void;
}

/** What the queue reads of a File. */
export interface UploadSource {
  readonly name: string;
  readonly size: number;
  slice(start: number, end: number): Blob;
}

export const CONCURRENCY = 3;
/** Seconds before each retry of a failed chunk; up to 500 ms of jitter is added. */
export const BACKOFF_SECONDS = [1, 2, 4, 8, 16] as const;
export const EWMA_ALPHA = 0.3;
export const SAMPLE_MS = 1000;
/** A file shows its time left only after this long and this much sent. */
export const ESTIMATE_AFTER_MS = 2000;
export const ESTIMATE_AFTER_BYTES = 256 * 1024;

/** Refusals end the file without a retry. The first two also refuse every file still waiting. */
const REFUSALS = new Set(['file_too_large', 'import_full', 'storage_full', 'daily_upload_limit', 'too_many_uploading', 'file_duplicate']);
const REFUSE_WAITING = new Set(['storage_full', 'daily_upload_limit']);
const ACTIVE: ReadonlySet<UploadState> = new Set(['creating', 'sending', 'retrying', 'completing']);
const COUNTED_OUT: ReadonlySet<UploadState> = new Set(['refused', 'failed', 'cancelled']);
const FINISHED: ReadonlySet<UploadState> = new Set(['done', 'refused', 'failed', 'cancelled']);

export const EMPTY_SNAPSHOT: QueueSnapshot = {
  items: [], overall: { files: 0, bytes: 0, sentBytes: 0, secondsLeft: null }, importId: null, filesUnavailable: false,
};

interface Entry {
  key: string;
  source: UploadSource;
  state: UploadState;
  fileId: string | null;
  file: FileView | null;
  error: QueuedUpload['error'];
  controller: AbortController | null;
  /** Bytes of acknowledged chunks. */
  acked: number;
  /** The in-flight chunk's bytes sent. */
  loaded: number;
  /** Every byte sent, resends included: what the link delivered, for the speed. */
  transferred: number;
  speed: number | null;
  sampleAt: number;
  sampleTransferred: number;
  sendingSince: number | null;
}

// A function, not an inline check: TypeScript would keep `signal.aborted` narrowed to false across awaits.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** An error the queue raises itself when a file is stopped. */
class Stopped extends Error {}

function ceil5(seconds: number): number {
  return Math.max(5, Math.ceil(seconds / 5) * 5);
}

function pauseOf(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.kind !== 'http') return null;
  if (error.status === 429 || (error.status === 503 && error.code === 'uploads_busy')) return error.retryAfterSeconds ?? 2;
  return null;
}

function transient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  return error.kind === 'http' && error.status >= 500 && error.code !== 'files_unavailable';
}

function codeOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'signed_out') return 'signed_out';
    if (error.kind === 'network' || error.kind === 'timeout') return 'network';
    if (error.code !== null) return error.code;
  }
  return 'internal';
}

function errorOf(error: unknown): NonNullable<QueuedUpload['error']> {
  const code = codeOf(error);
  return error instanceof ApiError && error.detail !== null ? { code, detail: error.detail } : { code };
}

/** Sign-out and any 403 stop the whole queue (storage2 15.2). */
function stopsQueue(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'signed_out' || (error.kind === 'http' && error.status === 403));
}

export interface QueueEngine {
  add: (files: readonly UploadSource[]) => void;
  cancel: (key: string) => void;
  snapshot: () => QueueSnapshot;
  /** Leaving the screen: unfinished uploads stop, and the server shows them as interrupted. */
  dispose: () => void;
}

export function createUploadQueue(deps: {
  api: ApiClient;
  locationId: string;
  purpose?: FilePurpose;
  onChange: (snapshot: QueueSnapshot) => void;
  now?: () => number;
  random?: () => number;
}): QueueEngine {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const purpose = deps.purpose ?? 'history';
  const entries: Entry[] = [];
  let importId: string | null = null;
  let filesUnavailable = false;
  let counter = 0;
  let sampler: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function secondsLeftOf(entry: Entry): number | null {
    if (entry.speed === null || entry.speed <= 0 || entry.sendingSince === null) return null;
    const sent = entry.acked + entry.loaded;
    if (now() - entry.sendingSince < ESTIMATE_AFTER_MS || sent < ESTIMATE_AFTER_BYTES) return null;
    return ceil5((entry.source.size - sent) / entry.speed);
  }

  function viewOf(entry: Entry): QueuedUpload {
    return {
      key: entry.key,
      fileId: entry.fileId,
      name: entry.source.name,
      sizeBytes: entry.source.size,
      state: entry.state,
      sentBytes: entry.state === 'done' ? entry.source.size : entry.acked + entry.loaded,
      bytesPerSecond: entry.speed,
      secondsLeft: entry.state === 'sending' || entry.state === 'retrying' ? secondsLeftOf(entry) : null,
      error: entry.error,
      file: entry.file,
    };
  }

  function snapshot(): QueueSnapshot {
    const items = entries.map(viewOf);
    const counted = items.filter((item) => !COUNTED_OUT.has(item.state));
    const bytes = counted.reduce((sum, item) => sum + item.sizeBytes, 0);
    const sentBytes = counted.reduce((sum, item) => sum + item.sentBytes, 0);
    const sending = items.filter((item) => item.state === 'sending' || item.state === 'retrying');
    const speed = sending.reduce((sum, item) => sum + (item.bytesPerSecond ?? 0), 0);
    let secondsLeft: number | null = null;
    if (bytes - sentBytes <= 0) secondsLeft = counted.length === 0 ? null : 0;
    else if (speed > 0 && sending.some((item) => item.secondsLeft !== null)) secondsLeft = ceil5((bytes - sentBytes) / speed);
    return { items, overall: { files: counted.length, bytes, sentBytes, secondsLeft }, importId, filesUnavailable };
  }

  function emit(): void {
    if (!disposed) deps.onChange(snapshot());
  }

  function sample(): void {
    const at = now();
    for (const entry of entries) {
      if (entry.state === 'sending') {
        const seconds = (at - entry.sampleAt) / 1000;
        if (seconds > 0) {
          const rate = (entry.transferred - entry.sampleTransferred) / seconds;
          entry.speed = entry.speed === null ? rate : EWMA_ALPHA * rate + (1 - EWMA_ALPHA) * entry.speed;
        }
      }
      // A pause for a retry or Retry-After keeps the average: its seconds are not counted as zero speed.
      entry.sampleAt = at;
      entry.sampleTransferred = entry.transferred;
    }
    emit();
    syncSampler();
  }

  function syncSampler(): void {
    const needed = !disposed && entries.some((entry) => entry.state === 'sending' || entry.state === 'retrying');
    if (needed && sampler === null) sampler = setInterval(sample, SAMPLE_MS);
    if (!needed && sampler !== null) {
      clearInterval(sampler);
      sampler = null;
    }
  }

  function set(entry: Entry, state: UploadState): void {
    entry.state = state;
    emit();
    syncSampler();
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Stopped());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Stopped());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Runs one request of a file, waiting out `uploads_busy` and 429 (not counted as attempts) and, when
   * `retries` is set, retrying network errors and 5xx up to 5 times with backoff.
   */
  async function attempt<T>(entry: Entry, state: UploadState, retries: boolean, run: () => Promise<T>): Promise<T> {
    const signal = entry.controller?.signal ?? AbortSignal.abort();
    let failures = 0;
    for (;;) {
      if (signal.aborted) throw new Stopped();
      try {
        const result = await run();
        if (entry.state === 'retrying') set(entry, state);
        return result;
      } catch (error) {
        if (isAborted(signal)) throw new Stopped();
        const pause = pauseOf(error);
        if (pause !== null) {
          set(entry, 'retrying');
          await sleep(pause * 1000, signal);
          continue;
        }
        if (!retries || !transient(error) || failures >= BACKOFF_SECONDS.length) throw error;
        const backoff = (BACKOFF_SECONDS[failures] ?? 16) * 1000 + random() * 500;
        const asked = error instanceof ApiError && error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : 0;
        failures += 1;
        entry.loaded = 0;
        set(entry, 'retrying');
        await sleep(Math.max(backoff, asked), signal);
      }
    }
  }

  function end(entry: Entry, state: 'refused' | 'failed', error: NonNullable<QueuedUpload['error']>): void {
    entry.error = error;
    entry.loaded = 0;
    set(entry, state);
  }

  function stopAll(error: NonNullable<QueuedUpload['error']>): void {
    for (const entry of entries) {
      if (FINISHED.has(entry.state)) continue;
      entry.controller?.abort();
      end(entry, 'failed', error);
    }
  }

  async function sendFile(entry: Entry): Promise<void> {
    const { source } = entry;
    const created = await attempt(entry, 'creating', false, () => createUpload(deps.api, deps.locationId, {
      name: source.name, sizeBytes: source.size, purpose,
    }));
    entry.fileId = created.file.id;
    importId ??= created.import.id;
    // Create is never aborted, so a file cancelled meanwhile is deleted once the server has it.
    if (FINISHED.has(entry.state)) {
      if (entry.state === 'cancelled') void removeFile(deps.api, deps.locationId, created.file.id).catch(() => undefined);
      throw new Stopped();
    }
    const chunkSize = created.file.upload?.chunkSize ?? created.limits.chunkSize;
    const chunkCount = created.file.upload?.chunkCount ?? Math.ceil(source.size / chunkSize);
    const fileId = created.file.id;
    entry.sendingSince = now();
    entry.sampleAt = entry.sendingSince;
    set(entry, 'sending');
    for (let index = created.file.upload?.nextChunk ?? 0; index < chunkCount; index += 1) {
      const blob = source.slice(index * chunkSize, Math.min(source.size, (index + 1) * chunkSize));
      const signal = entry.controller?.signal;
      await attempt(entry, 'sending', true, () => {
        entry.loaded = 0;
        return putChunk(deps.api, deps.locationId, fileId, index, blob, {
          ...(signal === undefined ? {} : { signal }),
          onProgress: (loaded) => {
            if (FINISHED.has(entry.state)) return;
            if (loaded > entry.loaded) entry.transferred += loaded - entry.loaded;
            entry.loaded = Math.min(loaded, blob.size);
            emit();
          },
        });
      });
      // Bytes the browser sent without a progress event (some report none, or only part) count when acknowledged.
      if (blob.size > entry.loaded) entry.transferred += blob.size - entry.loaded;
      entry.acked += blob.size;
      entry.loaded = 0;
      emit();
    }
    set(entry, 'completing');
    let tried = false;
    const file = await attempt(entry, 'completing', true, async () => {
      try {
        return (await completeUpload(deps.api, deps.locationId, fileId)).file;
      } catch (error) {
        // A complete that landed but whose answer was lost: the file is no longer uploading.
        if (tried && error instanceof ApiError && error.status === 409 && error.code === 'file_not_uploading') {
          const current = await getFile(deps.api, deps.locationId, fileId);
          if (current.file.status !== 'uploading') return current.file;
        }
        throw error;
      } finally {
        tried = true;
      }
    });
    if (FINISHED.has(entry.state)) throw new Stopped();
    entry.file = file;
    entry.acked = source.size;
    set(entry, 'done');
  }

  async function run(entry: Entry): Promise<void> {
    entry.controller = new AbortController();
    try {
      await sendFile(entry);
    } catch (error) {
      if (FINISHED.has(entry.state) || error instanceof Stopped) return;
      const code = codeOf(error);
      if (code === 'files_unavailable') {
        filesUnavailable = true;
        stopAll({ code });
      } else if (stopsQueue(error)) {
        stopAll(errorOf(error));
      } else if (REFUSALS.has(code)) {
        end(entry, 'refused', errorOf(error));
        if (REFUSE_WAITING.has(code)) {
          for (const other of entries) if (other.state === 'waiting') end(other, 'refused', errorOf(error));
        }
      } else {
        end(entry, 'failed', errorOf(error));
      }
    } finally {
      entry.controller = null;
      pump();
    }
  }

  function pump(): void {
    if (disposed) return;
    let active = entries.filter((entry) => ACTIVE.has(entry.state)).length;
    for (const entry of entries) {
      if (active >= CONCURRENCY) break;
      if (entry.state !== 'waiting') continue;
      entry.state = 'creating';
      active += 1;
      void run(entry);
    }
    emit();
    syncSampler();
  }

  function add(files: readonly UploadSource[]): void {
    if (disposed) return;
    for (const source of files) {
      counter += 1;
      const entry: Entry = {
        key: `u${String(counter)}`, source, state: 'waiting', fileId: null, file: null, error: null, controller: null,
        acked: 0, loaded: 0, transferred: 0, speed: null, sampleAt: now(), sampleTransferred: 0, sendingSince: null,
      };
      // The API refuses an empty file as an invalid request; say what it is instead, without a request.
      if (source.size === 0) {
        entry.state = 'refused';
        entry.error = { code: 'file_empty' };
      }
      entries.push(entry);
    }
    pump();
  }

  function cancel(key: string): void {
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry === undefined || entry.state === 'cancelled') return;
    const hadFile = entry.fileId !== null && entry.state !== 'refused';
    entry.controller?.abort();
    entry.loaded = 0;
    set(entry, 'cancelled');
    if (hadFile && entry.fileId !== null) void removeFile(deps.api, deps.locationId, entry.fileId).catch(() => undefined);
    pump();
  }

  function dispose(): void {
    disposed = true;
    for (const entry of entries) entry.controller?.abort();
    if (sampler !== null) clearInterval(sampler);
    sampler = null;
  }

  return { add, cancel, snapshot, dispose };
}

/**
 * The queue for a screen (54's HistoryStep): one per location, stopped when the screen closes. Under view-as no
 * queue is created and `add` does nothing.
 */
export function useUploadQueue(locationId: string, opts: { purpose?: FilePurpose } = {}): UploadQueue {
  const { api } = usePortal();
  const { readOnly } = useReadOnly();
  const purpose = opts.purpose ?? 'history';
  const engine = useRef<QueueEngine | null>(null);
  const owner = `${locationId}:${purpose}`;
  const [state, setState] = useState<{ owner: string; snapshot: QueueSnapshot }>({ owner: '', snapshot: EMPTY_SNAPSHOT });

  useEffect(() => {
    if (readOnly) return undefined;
    const queue = createUploadQueue({ api, locationId, purpose, onChange: (snapshot) => { setState({ owner, snapshot }); } });
    engine.current = queue;
    return () => {
      queue.dispose();
      if (engine.current === queue) engine.current = null;
    };
  }, [api, locationId, purpose, readOnly, owner]);

  const add = useCallback((files: readonly UploadSource[]) => { engine.current?.add(files); }, []);
  const cancel = useCallback((key: string) => { engine.current?.cancel(key); }, []);
  // A snapshot of a queue this screen no longer uses (another location, or view-as) is not shown.
  const snapshot = !readOnly && state.owner === owner ? state.snapshot : EMPTY_SNAPSHOT;
  return { ...snapshot, add, cancel };
}
