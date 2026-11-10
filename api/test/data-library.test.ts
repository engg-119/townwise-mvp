// Your data's refs (D28) and which items TownwiseAI may read (design calls 6 and 8). Synthetic records only.
import { AppError } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import { parseRef, readableByTownwiseAi, refString, type DataItemRecord } from '../src/data/library.ts';
import type { FileRecord } from '../src/stores/files.ts';

const ID = 'ab'.repeat(12);

describe('refs', () => {
  it('reads u_ and f_ with a lowercase object id, and writes them back the same', () => {
    expect(parseRef(`u_${ID}`)).toEqual({ type: 'upload', id: ID });
    expect(parseRef(`f_${ID}`)).toEqual({ type: 'file', id: ID });
    for (const ref of [`u_${ID}`, `f_${ID}`]) expect(refString(parseRef(ref))).toBe(ref);
  });

  it('answers 400 invalid_request for anything else', () => {
    for (const raw of [`x_${ID}`, `u_${ID.toUpperCase()}`, `u_${ID}0`, `u_${ID.slice(1)}`, ID, `u-${ID}`, ` u_${ID}`, 42, null, undefined, [`u_${ID}`]]) {
      let thrown: unknown = null;
      try {
        parseRef(raw);
      } catch (err) {
        thrown = err;
      }
      expect({ raw, code: thrown instanceof AppError ? `${String(thrown.status)} ${thrown.code}` : null }).toEqual({ raw, code: '400 invalid_request' });
    }
  });
});

describe('readableByTownwiseAi', () => {
  const file = { purpose: 'reference', kind: 'text', rawDeletedAt: null } as unknown as FileRecord;
  const item = { ref: { type: 'file', id: ID }, kind: 'text', enabled: true, state: 'kept', file } as unknown as DataItemRecord;

  it('reads a turned-on text item kept for reference, with its original, while stored files are on', () => {
    expect(readableByTownwiseAi(item, true)).toBe(true);
  });

  it('never a sales file, another kind, a turned-off or unfinished item, a deleted original, an upload, or with files off', () => {
    const cases: [string, DataItemRecord, boolean][] = [
      ['files off', item, false],
      ['sales file', { ...item, file: { ...file, purpose: 'history' } }, true],
      ['pdf', { ...item, kind: 'pdf', file: { ...file, kind: 'pdf' } }, true],
      ['turned off', { ...item, enabled: false }, true],
      ['uploading', { ...item, state: 'uploading' }, true],
      ['original deleted', { ...item, file: { ...file, rawDeletedAt: new Date(0) } }, true],
      ['an upload', { ...item, ref: { type: 'upload', id: ID } }, true],
    ];
    for (const [name, each, filesOn] of cases) expect({ name, readable: readableByTownwiseAi(each, filesOn) }).toEqual({ name, readable: false });
  });
});
