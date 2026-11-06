// files/blobs.ts against Azurite (the pinned image): the Azure implementation of the FileBlobs port, through the SDK.
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { BlobMissingError, createAzuriteFileBlobs, rawBlobName, type FileBlobs } from '../src/files/blobs.ts';
import { AZURITE_IMAGE } from './helpers/images.ts';

// An account of Azurite's own, with an all-zero key built here (no key literal in the repository).
const ACCOUNT = 'townwise';
const KEY = Buffer.alloc(64).toString('base64');
const scope = { orgId: '000000000000000000000001' } as unknown as OrgScope;
const otherOrg = { orgId: '000000000000000000000002' } as unknown as OrgScope;
const ref = { locationId: '000000000000000000000010', fileId: '000000000000000000000100' };

let container: StartedTestContainer;
let blobs: FileBlobs;
let connectionString: string;

beforeAll(async () => {
  container = await new GenericContainer(AZURITE_IMAGE)
    .withEnvironment({ AZURITE_ACCOUNTS: `${ACCOUNT}:${KEY}` })
    .withCommand(['azurite-blob', '--blobHost', '0.0.0.0', '--blobPort', '10000', '--skipApiVersionCheck', '--inMemoryPersistence'])
    .withExposedPorts(10000)
    .start();
  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(10000))}/${ACCOUNT}`;
  connectionString = `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};BlobEndpoint=${endpoint};`;
  blobs = await createAzuriteFileBlobs(connectionString);
}, 120_000);

afterAll(async () => {
  await container.stop();
});

function chunk(fill: number, length: number): Buffer {
  return Buffer.alloc(length, fill);
}

async function bytesOf(readable: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of readable) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

describe('Azure blob storage (Azurite)', () => {
  it('stages chunks from streams, commits them in order, reads ranges, and treats a second commit as done', async () => {
    const signal = new AbortController().signal;
    await blobs.stageChunk(scope, ref, 1, Readable.from([chunk(0x62, 3)]), 3, signal);
    await blobs.stageChunk(scope, ref, 0, Readable.from([chunk(0x61, 2), chunk(0x61, 2)]), 4, signal);
    // A re-sent chunk replaces the staged one.
    await blobs.stageChunk(scope, ref, 1, Readable.from([chunk(0x63, 3)]), 3, signal);
    await blobs.commitChunks(scope, ref, 2);
    expect((await bytesOf(await blobs.openRaw(scope, ref))).toString()).toBe('aaaaccc');
    expect((await bytesOf(await blobs.openRaw(scope, ref, { offset: 3, count: 2 }))).toString()).toBe('ac');
    await blobs.commitChunks(scope, ref, 2);
    expect((await bytesOf(await blobs.openRaw(scope, ref))).toString()).toBe('aaaaccc');
  });

  it('builds every name under the organization, so another organization never reaches the blob', async () => {
    expect(rawBlobName(scope, ref)).toBe('000000000000000000000001/000000000000000000000010/000000000000000000000100');
    await expect(blobs.openRaw(otherOrg, ref)).rejects.toBeInstanceOf(BlobMissingError);
  });

  it('writes, reads and deletes the cleaned copy; deleting a missing blob is fine', async () => {
    await blobs.writeClean(scope, ref, 'date,guests,net_sales\r\n2025-01-01,10,100.00\r\n');
    expect(await text(await blobs.openClean(scope, ref))).toBe('date,guests,net_sales\r\n2025-01-01,10,100.00\r\n');
    await blobs.deleteClean(scope, ref);
    await blobs.deleteClean(scope, ref);
    await expect(blobs.openClean(scope, ref)).rejects.toBeInstanceOf(BlobMissingError);
    await blobs.deleteRaw(scope, ref);
    await blobs.deleteRaw(scope, ref);
    await expect(blobs.openRaw(scope, ref)).rejects.toBeInstanceOf(BlobMissingError);
  });

  it('discards an unfinished upload: its staged chunks are gone and nothing is left behind', async () => {
    const other = { locationId: ref.locationId, fileId: '000000000000000000000200' };
    const signal = new AbortController().signal;
    await blobs.stageChunk(scope, other, 0, Readable.from([chunk(0x61, 5)]), 5, signal);
    await blobs.discardUpload(scope, other);
    await expect(blobs.openRaw(scope, other)).rejects.toBeInstanceOf(BlobMissingError);
    // The staged block is gone too: committing it now fails, and maps to no SDK message.
    await expect(blobs.commitChunks(scope, other, 1)).rejects.toMatchObject({ name: 'BlobUnavailableError' });
  });

  it('stops a chunk whose stream is aborted, without committing anything', async () => {
    const other = { locationId: ref.locationId, fileId: '000000000000000000000300' };
    const controller = new AbortController();
    const slow = new Readable({ read() { /* never ends */ } });
    slow.push(chunk(0x61, 2));
    const staging = blobs.stageChunk(scope, other, 0, slow, 10, controller.signal);
    controller.abort();
    await expect(staging).rejects.toBeDefined();
    await expect(blobs.openRaw(scope, other)).rejects.toBeInstanceOf(BlobMissingError);
  });
});
