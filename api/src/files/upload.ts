// The chunk transport (spec 11A): each PUT body streams through a hashing, counting Transform straight into Azure's
// Put Block, so no request holds a whole file or a whole chunk. Node pauses the request whenever storage is slower,
// and TCP pushes back to the browser. A client abort aborts the storage call, and nothing is recorded.
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { HEAD_BYTES, MAX_CHUNK_STREAMS } from './limits.ts';

/** The body ended before, or ran past, its declared length. */
export class ChunkLengthError extends Error {
  constructor() {
    super('chunk length mismatch');
    this.name = 'ChunkLengthError';
  }
}

/** Counts chunk streams on this replica; past the limit a chunk answers 503 uploads_busy. */
export interface StreamGate {
  /** False when the replica is at its limit. */
  enter(): boolean;
  leave(): void;
  readonly active: number;
}

export function createStreamGate(limit = MAX_CHUNK_STREAMS): StreamGate {
  let active = 0;
  return {
    enter() {
      if (active >= limit) return false;
      active += 1;
      return true;
    },
    leave() {
      active = Math.max(0, active - 1);
    },
    get active() {
      return active;
    },
  };
}

export interface ReceivedChunk {
  readonly bytes: number;
  readonly sha256: string;
  /** The first 8 KiB, when asked for (chunk 0). */
  readonly head: Buffer | null;
}

/**
 * Streams `body` (exactly `length` bytes) into `stage`, hashing and counting on the way. `signal` aborts both sides;
 * the caller ties it to the client going away.
 */
export async function receiveChunk(
  body: Readable,
  input: {
    length: number;
    wantHead: boolean;
    signal: AbortSignal;
    stage: (stream: Readable, signal: AbortSignal) => Promise<void>;
  },
): Promise<ReceivedChunk> {
  const hash = createHash('sha256');
  let bytes = 0;
  const headParts: Buffer[] = [];
  let headBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > input.length) {
        callback(new ChunkLengthError());
        return;
      }
      hash.update(chunk);
      if (input.wantHead && headBytes < HEAD_BYTES) {
        const part = chunk.subarray(0, HEAD_BYTES - headBytes);
        headParts.push(part);
        headBytes += part.length;
      }
      callback(null, chunk);
    },
  });
  const staging = input.stage(meter, input.signal).catch((err: unknown) => {
    meter.destroy(err instanceof Error ? err : new Error('stage failed'));
    throw err;
  });
  const piping = pipeline(body, meter, { signal: input.signal, end: true });
  await Promise.all([staging, piping]);
  if (bytes !== input.length) throw new ChunkLengthError();
  return { bytes, sha256: hash.digest('hex'), head: input.wantHead ? Buffer.concat(headParts) : null };
}

/**
 * A file's fingerprint (spec 6.11): SHA-256 over the chunk size and the chunks' own SHA-256s in order, so the same
 * file uploaded with the same chunk size matches without any replica holding a hash across requests. It is not the
 * file's plain SHA-256.
 */
export function fingerprintOf(chunkSize: number, chunkHashes: readonly string[]): string {
  return createHash('sha256').update(`townwise-chunks-v1:${String(chunkSize)}:${chunkHashes.join(',')}`, 'utf8').digest('hex');
}
