// An in-memory FileBlobs for tests and for local runs without Azurite. Same names and the same semantics as
// blobs.ts: staged chunks stay apart from the committed blob until commitChunks, and a missing blob is
// BlobMissingError.
import { addAbortSignal, Readable } from 'node:stream';

import type { OrgScope } from '../access/policy.ts';
import { BlobMissingError, cleanBlobName, rawBlobName, type BlobRef, type FileBlobs } from './blobs.ts';

export interface MemoryFileBlobs extends FileBlobs {
  /** Committed blobs by container and name, for assertions. */
  readonly raw: Map<string, Buffer>;
  readonly clean: Map<string, Buffer>;
  /** Staged, uncommitted chunks per raw blob name. */
  readonly staged: Map<string, Map<number, Buffer>>;
}

async function readAll(body: Readable, signal: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of body) {
    signal.throwIfAborted();
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
  }
  return Buffer.concat(parts);
}

export function createMemoryFileBlobs(): MemoryFileBlobs {
  const raw = new Map<string, Buffer>();
  const clean = new Map<string, Buffer>();
  const staged = new Map<string, Map<number, Buffer>>();
  const found = (map: Map<string, Buffer>, name: string): Buffer => {
    const blob = map.get(name);
    if (blob === undefined) throw new BlobMissingError();
    return blob;
  };
  return {
    raw,
    clean,
    staged,
    async stageChunk(scope: OrgScope, ref: BlobRef, index, body, length, signal) {
      const bytes = await readAll(body, signal);
      if (bytes.length !== length) throw new Error('chunk length mismatch');
      const name = rawBlobName(scope, ref);
      const chunks = staged.get(name) ?? new Map<number, Buffer>();
      chunks.set(index, bytes);
      staged.set(name, chunks);
    },
    commitChunks(scope, ref, chunkCount) {
      const name = rawBlobName(scope, ref);
      if (raw.has(name)) return Promise.resolve();
      const chunks = staged.get(name);
      const parts: Buffer[] = [];
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = chunks?.get(index);
        if (chunk === undefined) return Promise.reject(new Error('block missing'));
        parts.push(chunk);
      }
      raw.set(name, Buffer.concat(parts));
      staged.delete(name);
      return Promise.resolve();
    },
    discardUpload(scope, ref) {
      const name = rawBlobName(scope, ref);
      staged.delete(name);
      raw.delete(name);
      return Promise.resolve();
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- async so a missing blob rejects, as the port does
    async openRaw(scope, ref, range, signal) {
      const blob = found(raw, rawBlobName(scope, ref));
      const body = Readable.from([range === undefined ? blob : blob.subarray(range.offset, range.offset + range.count)]);
      return signal === undefined ? body : addAbortSignal(signal, body);
    },
    writeClean(scope, ref, csv) {
      clean.set(cleanBlobName(scope, ref), Buffer.from(csv, 'utf8'));
      return Promise.resolve();
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- async so a missing blob rejects, as the port does
    async openClean(scope, ref) {
      return Readable.from([found(clean, cleanBlobName(scope, ref))]);
    },
    deleteRaw(scope, ref) {
      raw.delete(rawBlobName(scope, ref));
      return Promise.resolve();
    },
    deleteClean(scope, ref) {
      clean.delete(cleanBlobName(scope, ref));
      return Promise.resolve();
    },
  };
}
