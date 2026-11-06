import { describe, expect, it } from 'vitest';

import type { OrgScope } from '../../src/access/policy.ts';
import { blockId, cleanBlobName, rawBlobName } from '../../src/files/blobs.ts';
import { createMemoryFileBlobs } from '../../src/files/memory-blobs.ts';

const scope = { orgId: '000000000000000000000001' } as unknown as OrgScope;
const ref = { locationId: '000000000000000000000010', fileId: '000000000000000000000100' };

describe('blob names', () => {
  it('are ids only, under the organization, with the cleaned copy beside the original', () => {
    expect(rawBlobName(scope, ref)).toBe('000000000000000000000001/000000000000000000000010/000000000000000000000100');
    expect(cleanBlobName(scope, ref)).toBe('000000000000000000000001/000000000000000000000010/000000000000000000000100.csv');
  });

  it('gives every block id of a blob the same length', () => {
    const ids = [0, 7, 24, 49_999].map(blockId);
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
    expect(Buffer.from(blockId(24), 'base64').toString()).toBe('000024');
  });

  it('keeps the memory store’s blobs under the scope that wrote them', async () => {
    const blobs = createMemoryFileBlobs();
    await blobs.writeClean(scope, ref, 'date,guests,net_sales\r\n');
    expect([...blobs.clean.keys()]).toEqual([cleanBlobName(scope, ref)]);
    const other = { orgId: '000000000000000000000002' } as unknown as OrgScope;
    await expect(blobs.openClean(other, ref)).rejects.toMatchObject({ name: 'BlobMissingError' });
  });
});
