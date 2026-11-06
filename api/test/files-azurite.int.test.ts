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

  it('lists Townwise’s blobs by their ids, and deletes every blob under a location’s or an organization’s prefix only', async () => {
    const signal = new AbortController().signal;
    const at = (orgId: string, locationId: string, fileId: string) => ({ scope: { orgId } as unknown as OrgScope, ref: { locationId, fileId } });
    const kept = at('000000000000000000000009', '000000000000000000000010', '000000000000000000000900');
    const first = at(scope.orgId, '000000000000000000000020', '000000000000000000000400');
    const second = at(scope.orgId, '000000000000000000000030', '000000000000000000000500');
    for (const { scope: s, ref: r } of [kept, first, second]) {
      await blobs.stageChunk(s, r, 0, Readable.from([chunk(0x61, 2)]), 2, signal);
      await blobs.commitChunks(s, r, 1);
      await blobs.writeClean(s, r, 'date\r\n');
    }
    const listed: string[] = [];
    for await (const blob of blobs.listAll()) listed.push(`${blob.container}:${blob.fileId}`);
    expect(listed).toEqual(expect.arrayContaining(['raw:000000000000000000000400', 'clean:000000000000000000000400', 'raw:000000000000000000000900']));
    expect(await blobs.removePrefix(first.scope, first.ref.locationId)).toBe(2);
    await expect(blobs.openRaw(first.scope, first.ref)).rejects.toBeInstanceOf(BlobMissingError);
    expect((await bytesOf(await blobs.openRaw(second.scope, second.ref))).toString()).toBe('aa');
    expect(await blobs.removePrefix(scope, null)).toBeGreaterThanOrEqual(2);
    await expect(blobs.openRaw(second.scope, second.ref)).rejects.toBeInstanceOf(BlobMissingError);
    expect((await bytesOf(await blobs.openRaw(kept.scope, kept.ref))).toString()).toBe('aa');
  });
});
