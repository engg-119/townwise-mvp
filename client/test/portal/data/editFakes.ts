import { act, waitFor } from '@testing-library/react';

import { bytesOf } from '../../../src/portal/data/item/open';
import { fileViewOf } from '../files/fakes';
import type { DataFake } from './fakes';

// Saving an edit on an item's page, for the web tests (item-edit, save): uploads that answer 24-hex file ids, and a
// helper that answers an edit's one chunk and hands back what was sent.

/** A 24-hex id, as refs need (`f_` plus one). */
export function hexId(n: number): string {
  return n.toString(16).padStart(24, '0');
}

const EDIT_CHUNK = 1024 * 1024;

/**
 * Creates answer with 24-hex file ids (0xed1, 0xed2, …), so the item an edit stores has a ref the routing allows,
 * each file in one chunk, for reference.
 */
export function hexUploads(fake: DataFake): void {
  let created = 0;
  fake.files.answers['POST /files'] = (body) => {
    const input = body as { name: string; sizeBytes: number };
    created += 1;
    return {
      file: fileViewOf(hexId(0xed0 + created), {
        name: input.name, sizeBytes: input.sizeBytes, purpose: 'reference', importId: null, status: 'uploading', result: null, hasClean: false,
        upload: { chunkSize: EDIT_CHUNK, chunkCount: 1, receivedBytes: 0, nextChunk: 0, expiresAt: '2026-11-12T15:00:00.000Z' },
      }),
      import: null,
      limits: { maxFileBytes: 209_715_200, chunkSize: EDIT_CHUNK, dailyBytesLeft: 2 ** 31, storedBytesLeft: 5 * 2 ** 30, filesLeftInImport: 49 },
    };
  };
}

/**
 * Waits for an edit's one chunk, answers it, and returns the stored file's id and the bytes sent. The file's
 * original then downloads as those bytes, so the page it lands on can show it.
 */
export async function sent(fake: DataFake): Promise<{ fileId: string; bytes: Uint8Array }> {
  await waitFor(() => { expect(fake.files.puts.length).toBeGreaterThan(0); }, { timeout: 5000 });
  const put = fake.files.puts.shift();
  if (put === undefined) throw new Error('no chunk');
  const bytes = await bytesOf(put.body);
  fake.files.downloads[`/files/${put.fileId}/raw`] = () => put.body;
  await act(async () => { put.ok(); await Promise.resolve(); });
  return { fileId: put.fileId, bytes };
}
