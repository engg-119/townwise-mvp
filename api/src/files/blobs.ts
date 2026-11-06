// Client file storage (docs/portal/spec.md 11A): the FileBlobs port and its Azure Blob Storage implementation. The
// only file that imports @azure/storage-blob (test/isolation.test.ts). Every blob name is built here from the
// caller's OrgScope and ids the stores already checked belong to it, so no request value becomes a path. Names are
// ids only: `{orgId}/{locationId}/{fileId}` in client-raw and `{orgId}/{locationId}/{fileId}.csv` in client-clean.
// Errors leave as BlobMissingError or BlobUnavailableError with a code, never the SDK's message (which names the
// blob URL), and the SDK's own logger stays off (AZURE_LOG_LEVEL is never set).
import type { Readable } from 'node:stream';

import { BlobServiceClient, RestError, type ContainerClient } from '@azure/storage-blob';

import type { OrgScope } from '../access/policy.ts';

export const RAW_CONTAINER = 'client-raw';
export const CLEAN_CONTAINER = 'client-clean';

/** The file a blob belongs to. The caller has loaded it through the files store with the same scope. */
export interface BlobRef {
  readonly locationId: string;
  readonly fileId: string;
}

/** The blob does not exist (deleted, expired, or never committed). */
export class BlobMissingError extends Error {
  constructor() {
    super('blob missing');
    this.name = 'BlobMissingError';
  }
}

/** Storage refused or failed. `errType` is the service's error code or the error's name, for logs. */
export class BlobUnavailableError extends Error {
  readonly errType: string;
  readonly status: number | null;
  constructor(errType: string, status: number | null) {
    super('blob storage unavailable');
    this.name = 'BlobUnavailableError';
    this.errType = errType;
    this.status = status;
  }
}

export interface FileBlobs {
  /** Stages chunk `index` of an upload from `body`, exactly `length` bytes. Never retried: a stream is read once. */
  stageChunk(scope: OrgScope, ref: BlobRef, index: number, body: Readable, length: number, signal: AbortSignal): Promise<void>;
  /** Commits chunks 0 to count - 1 as the original. A blob that already exists counts as committed (a retried complete). */
  commitChunks(scope: OrgScope, ref: BlobRef, chunkCount: number): Promise<void>;
  /** Cancels an unfinished upload: discards its staged chunks at once and deletes the blob. */
  discardUpload(scope: OrgScope, ref: BlobRef): Promise<void>;
  /** The original, or `count` bytes of it from `offset`. `signal` aborts the read (the reader's time limit). */
  openRaw(scope: OrgScope, ref: BlobRef, range?: { offset: number; count: number }, signal?: AbortSignal): Promise<Readable>;
  /** Writes (or rewrites) the cleaned copy. */
  writeClean(scope: OrgScope, ref: BlobRef, csv: string): Promise<void>;
  openClean(scope: OrgScope, ref: BlobRef): Promise<Readable>;
  /** A missing blob counts as deleted. */
  deleteRaw(scope: OrgScope, ref: BlobRef): Promise<void>;
  deleteClean(scope: OrgScope, ref: BlobRef): Promise<void>;
}

export function rawBlobName(scope: OrgScope, ref: BlobRef): string {
  return `${scope.orgId}/${ref.locationId}/${ref.fileId}`;
}

export function cleanBlobName(scope: OrgScope, ref: BlobRef): string {
  return `${rawBlobName(scope, ref)}.csv`;
}

/** Azure requires every block id of a blob to have the same length: base64 of the six-digit index. */
export function blockId(index: number): string {
  return Buffer.from(String(index).padStart(6, '0'), 'utf8').toString('base64');
}

/** A managed identity token source (structurally a TokenCredential). */
export interface BlobTokenSource {
  getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

function mapped(err: unknown): Error {
  if (err instanceof RestError) {
    if (err.statusCode === 404) return new BlobMissingError();
    return new BlobUnavailableError(err.code ?? 'RestError', err.statusCode ?? null);
  }
  if (err instanceof Error && err.name === 'AbortError') return err;
  return new BlobUnavailableError(err instanceof Error ? err.name : 'unknown', null);
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw mapped(err);
  }
}

function isAlreadyCommitted(err: unknown): boolean {
  return err instanceof RestError && (err.statusCode === 409 || err.statusCode === 412);
}

function bodyOf(readable: NodeJS.ReadableStream | undefined): Readable {
  if (readable === undefined) throw new BlobUnavailableError('NoBody', null);
  return readable as Readable;
}

/**
 * `service` for every call but chunks, `chunks` (built with retries off) for Put Block, because a consumed request
 * stream cannot be replayed; the browser retries a chunk instead.
 */
function blobsOver(service: BlobServiceClient, chunks: BlobServiceClient): FileBlobs {
  const raw: ContainerClient = service.getContainerClient(RAW_CONTAINER);
  const clean: ContainerClient = service.getContainerClient(CLEAN_CONTAINER);
  const rawChunks: ContainerClient = chunks.getContainerClient(RAW_CONTAINER);
  return {
    stageChunk(scope, ref, index, body, length, signal) {
      return guarded(async () => {
        await rawChunks.getBlockBlobClient(rawBlobName(scope, ref)).stageBlock(blockId(index), body, length, { abortSignal: signal });
      });
    },
    commitChunks(scope, ref, chunkCount) {
      return guarded(async () => {
        const ids = Array.from({ length: chunkCount }, (_, index) => blockId(index));
        try {
          await raw.getBlockBlobClient(rawBlobName(scope, ref)).commitBlockList(ids, {
            conditions: { ifNoneMatch: '*' },
            blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
          });
        } catch (err) {
          if (!isAlreadyCommitted(err)) throw err;
        }
      });
    },
    discardUpload(scope, ref) {
      return guarded(async () => {
        const blob = raw.getBlockBlobClient(rawBlobName(scope, ref));
        // Committing an empty list discards every uncommitted block at once (they would otherwise wait 7 days).
        await blob.commitBlockList([]);
        await blob.deleteIfExists();
      });
    },
    openRaw(scope, ref, range, signal) {
      return guarded(async () => {
        const response = await raw.getBlobClient(rawBlobName(scope, ref)).download(range?.offset ?? 0, range?.count, signal === undefined ? {} : { abortSignal: signal });
        return bodyOf(response.readableStreamBody);
      });
    },
    writeClean(scope, ref, csv) {
      return guarded(async () => {
        const bytes = Buffer.from(csv, 'utf8');
        await clean.getBlockBlobClient(cleanBlobName(scope, ref)).upload(bytes, bytes.length, {
          blobHTTPHeaders: { blobContentType: 'text/csv; charset=utf-8' },
        });
      });
    },
    openClean(scope, ref) {
      return guarded(async () => {
        const response = await clean.getBlobClient(cleanBlobName(scope, ref)).download();
        return bodyOf(response.readableStreamBody);
      });
    },
    deleteRaw(scope, ref) {
      return guarded(async () => { await raw.getBlobClient(rawBlobName(scope, ref)).deleteIfExists(); });
    },
    deleteClean(scope, ref) {
      return guarded(async () => { await clean.getBlobClient(cleanBlobName(scope, ref)).deleteIfExists(); });
    },
  };
}

/** Production: the account URL (FILES_BLOB_ACCOUNT_URL) and the API's managed identity. */
export function createAzureFileBlobs(accountUrl: string, credential: BlobTokenSource): FileBlobs {
  return blobsOver(
    new BlobServiceClient(accountUrl, credential),
    new BlobServiceClient(accountUrl, credential, { retryOptions: { maxTries: 1 } }),
  );
}

/**
 * Development and tests only (config.ts refuses it in production): Azurite through its connection string. Creates the
 * two containers if they are missing; production never creates containers (Terraform does, and the API's role
 * cannot).
 */
export async function createAzuriteFileBlobs(connectionString: string): Promise<FileBlobs> {
  const service = BlobServiceClient.fromConnectionString(connectionString);
  await guarded(async () => {
    await service.getContainerClient(RAW_CONTAINER).createIfNotExists();
    await service.getContainerClient(CLEAN_CONTAINER).createIfNotExists();
  });
  return blobsOver(service, BlobServiceClient.fromConnectionString(connectionString, { retryOptions: { maxTries: 1 } }));
}
