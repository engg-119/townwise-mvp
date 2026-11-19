import type { z } from 'zod';

import { ApiError, type ApiClient, type RequestOptions } from '../../../src/api/client';
import type { EntryView, FileView, ImportView } from '../../../src/portal/files/api';
import { ADMIN_EMAIL, refusal } from '../../helpers/portal';

// Stored files in the API's shapes (the storage2 design, 6.2) and a fake ApiClient for their routes. Every file
// route of location l1 is answered here; anything else goes to `inner` (the location pages' fake) or answers 404.
// Chunk PUTs stay pending until the test settles them, so a test can drive the queue one chunk at a time.

export const LOCATION = 'l1';
const BASE = `/api/org/locations/${LOCATION}`;

export function fileViewOf(id: string, extra?: Partial<FileView>): FileView {
  return {
    id, importId: 'i1', purpose: 'history', name: `${id}.csv`, kind: 'text', sizeBytes: 2048, uploadedAt: '2026-11-05T15:00:00.000Z',
    uploadedByEmail: ADMIN_EMAIL, status: 'read', outcome: null, upload: null, progress: null, etaSeconds: null, queuePosition: null,
    entries: null,
    result: {
      dayCount: 731, firstDate: '2024-01-01', lastDate: '2025-12-31', guestsDayCount: 731, netSalesDayCount: 731, inserted: 731,
      replaced: 0, kept: 0, closedDates: [], missingDays: 0, uploadId: 'u1',
    },
    hasClean: true, rawAvailable: true, rawExpiresAt: '2027-11-05T15:00:00.000Z',
    canDownloadRaw: true, canDownloadClean: true, canDelete: true, canDeleteRaw: true,
    ...extra,
  };
}

export function importViewOf(id: string, extra?: Partial<ImportView>): ImportView {
  return {
    id, locationId: LOCATION, status: 'open', createdAt: '2026-11-05T15:00:00.000Z', startedAt: null, finishedAt: null, files: [],
    found: { dayCount: 0, firstDate: null, lastDate: null, guestsDayCount: 0, netSalesDayCount: 0, closedDates: [], missingDays: 0 },
    progress: { filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0 },
    etaSeconds: null, waitingForTurn: false, question: null, appliedVersion: 0, ...extra,
  };
}

export function entryOf(index: number, extra?: Partial<EntryView>): EntryView {
  return { index, path: `export/day-${String(index)}.csv`, depth: 1, kind: 'text', sizeBytes: 512, status: 'used', outcome: null, dayCount: 1, ...extra };
}

export interface PendingPut {
  fileId: string;
  index: number;
  size: number;
  /** The chunk's bytes as sent. */
  body: Blob;
  signal: AbortSignal | undefined;
  progress: (loaded: number) => void;
  /** Answers 200; `silent` skips the final progress event, as a browser that reports none. */
  ok: (opts?: { silent?: boolean }) => void;
  fail: (error: unknown) => void;
}

export interface Call { method: string; path: string; body: unknown }

export interface FilesFake extends ApiClient {
  chunkSize: number;
  /** D59: the create answer's `autoRead`; left out while undefined, as an API before it does. */
  autoRead?: boolean;
  calls: Call[];
  puts: PendingPut[];
  /**
   * Answers by "METHOD path" (path without the location prefix): a body, an ApiError, a promise of either, or
   * undefined for the default.
   */
  answers: Record<string, (body: unknown) => unknown>;
  /** GET /files pages, by `before` ('' for the first). */
  lists: Record<string, unknown>;
  /** GET /files/:id/entries pages, by "fileId:after". */
  entries: Record<string, unknown>;
  /** GET /files/:id/raw (and ?part=k) and /clean: the bytes, or an ApiError. */
  downloads: Record<string, () => Blob | ApiError>;
  current: unknown;
  imports: Record<string, unknown>;
}

async function settle<T>(value: unknown, schema: z.ZodType<T>): Promise<T> {
  const resolved: unknown = await value;
  if (resolved instanceof ApiError) throw resolved;
  if (resolved === undefined) throw refusal(404, 'not_found');
  return schema.parse(resolved);
}

/** The default create answer: file `f{n}`, uploading, in `chunkSize` chunks. */
function createdOf(fake: FilesFake, n: number, body: unknown): unknown {
  const input = body as { name: string; sizeBytes: number };
  const id = `f${String(n)}`;
  const chunkCount = Math.ceil(input.sizeBytes / fake.chunkSize);
  return {
    file: fileViewOf(id, {
      name: input.name, sizeBytes: input.sizeBytes, status: 'uploading', result: null, hasClean: false,
      upload: { chunkSize: fake.chunkSize, chunkCount, receivedBytes: 0, nextChunk: 0, expiresAt: '2026-11-06T15:00:00.000Z' },
    }),
    import: { id: 'i1', status: 'open' },
    limits: { maxFileBytes: 209_715_200, chunkSize: fake.chunkSize, dailyBytesLeft: 2 ** 31, storedBytesLeft: 5 * 2 ** 30, filesLeftInImport: 49 },
    ...(fake.autoRead === undefined ? {} : { autoRead: fake.autoRead }),
  };
}

export function filesFake(init?: { inner?: ApiClient; chunkSize?: number }): FilesFake {
  const inner = init?.inner ?? null;
  let created = 0;
  const fake: FilesFake = {
    chunkSize: init?.chunkSize ?? 4,
    calls: [],
    puts: [],
    answers: {},
    lists: {},
    entries: {},
    downloads: {},
    current: { import: null },
    imports: {},
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      if (!path.startsWith(`${BASE}/files`) && !path.startsWith(`${BASE}/imports`) && path !== `${BASE}/originals`) {
        return inner === null ? Promise.reject(refusal(404, 'not_found')) : inner.json(path, schema, opts);
      }
      const method = opts?.method ?? 'GET';
      const rest = path.slice(BASE.length);
      fake.calls.push({ method, path: rest, body: opts?.body });
      const answer = fake.answers[`${method} ${rest}`];
      // An answer that returns undefined falls through to the default.
      const answered = answer?.(opts?.body);
      if (answered !== undefined) return settle(answered, schema);
      if (method === 'POST' && rest === '/files') {
        created += 1;
        return settle(createdOf(fake, created, opts?.body), schema);
      }
      const complete = /^\/files\/([^/]+)\/complete$/.exec(rest);
      if (method === 'POST' && complete?.[1] !== undefined) {
        return settle({ file: fileViewOf(complete[1], { status: 'stored', result: null, hasClean: false }), import: { id: 'i1', status: 'open' } }, schema);
      }
      if (method === 'DELETE' && /^\/files\/[^/]+$/.test(rest)) return settle({ deleted: true, daysKept: 0 }, schema);
      if (method === 'DELETE' && /^\/files\/[^/]+\/raw$/.test(rest)) return settle({ deleted: true }, schema);
      if (method === 'DELETE' && rest === '/originals') return settle({ deletedOriginals: 0, skippedBusy: 0 }, schema);
      if (method === 'GET') {
        const list = /^\/files(?:\?before=(.+))?$/.exec(rest);
        if (list !== null) return settle(Promise.resolve(fake.lists[list[1] ?? '']).then((files) => (files instanceof ApiError || files === undefined ? files : { files })), schema);
        const entries = /^\/files\/([^/]+)\/entries(?:\?after=(\d+))?$/.exec(rest);
        if (entries?.[1] !== undefined) return settle(fake.entries[`${entries[1]}:${entries[2] ?? ''}`], schema);
        if (rest === '/imports/current') return settle(fake.current, schema);
        const one = /^\/imports\/([^/]+)$/.exec(rest);
        if (one?.[1] !== undefined) return settle(fake.imports[one[1]], schema);
      }
      return Promise.reject(refusal(404, 'not_found'));
    },
    request(path: `/${string}`, opts?: RequestOptions): Promise<Response> {
      const rest = path.slice(BASE.length);
      const chunk = /^\/files\/([^/]+)\/chunks\/(\d+)$/.exec(rest);
      if (path.startsWith(BASE) && opts?.method === 'PUT' && chunk?.[1] !== undefined && chunk[2] !== undefined && opts.upload !== undefined) {
        const fileId = chunk[1];
        const index = Number(chunk[2]);
        const { upload } = opts;
        fake.calls.push({ method: 'PUT', path: rest, body: undefined });
        return new Promise<Response>((resolve, reject) => {
          const { signal } = opts;
          if (signal?.aborted === true) {
            reject(new ApiError('aborted', 'The request was stopped.'));
            return;
          }
          signal?.addEventListener('abort', () => { reject(new ApiError('aborted', 'The request was stopped.')); }, { once: true });
          fake.puts.push({
            fileId, index, size: upload.body.size, body: upload.body, signal,
            progress: (loaded) => { upload.onProgress?.(loaded); },
            ok: (answer) => {
              if (answer?.silent !== true) upload.onProgress?.(upload.body.size);
              const body = { index, receivedBytes: upload.body.size, chunksReceived: index + 1 };
              resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
            },
            fail: reject,
          });
        });
      }
      if (path.startsWith(`${BASE}/files`) && (opts?.method ?? 'GET') === 'GET') {
        fake.calls.push({ method: 'GET', path: rest, body: undefined });
        const answer = fake.downloads[rest]?.();
        if (answer === undefined) return Promise.reject(refusal(404, 'not_found'));
        if (answer instanceof ApiError) return Promise.reject(answer);
        return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(answer) } as unknown as Response);
      }
      return inner === null ? Promise.reject(refusal(404, 'not_found')) : inner.request(path, opts);
    },
    stream: (path, opts) => (inner === null ? Promise.reject(refusal(404, 'not_found')) : inner.stream(path, opts)),
    logout: () => Promise.resolve(),
  };
  return fake;
}

/** A file to drop: `size` bytes of zeros. */
export function sourceOf(name: string, size: number): { name: string; size: number; slice: (start: number, end: number) => Blob } {
  return {
    name,
    size,
    slice: (start, end) => ({ size: Math.max(0, Math.min(end, size) - start) }) as Blob,
  };
}
