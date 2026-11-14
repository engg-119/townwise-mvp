// The parse thread's limits (spec 11A): a file that runs out of time or memory is kept as too_complex, and the test
// process (the API, in production) carries on.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { inbox, isThreadOut, runParse } from '../../src/files/parse/run.ts';
import { xlsxOf } from '../helpers/zip.ts';

function* repeated(piece: Buffer, times: number): Generator<Buffer> {
  for (let index = 0; index < times; index += 1) yield piece;
}

const base = { answers: {}, locationName: 'Main', latest: '2026-06-02', replace: true, onProgress: () => undefined } as const;

describe('parse thread limits', () => {
  it('ends a read that runs past its time limit as too_complex', async () => {
    const piece = Buffer.from('2025-01-01,1,1\n'.repeat(10_000));
    const outcome = await runParse({
      ...base, kind: 'text', sizeBytes: piece.length * 2000, timeMs: 50,
      open: () => Promise.resolve(Readable.from([Buffer.from('Date,Guests,Net Sales\n'), ...repeated(piece, 2000)])),
    });
    expect(outcome).toEqual({ kind: 'kept', outcome: 'too_complex', report: null });
  });

  it('ends a read whose storage stalls at its time limit as too_complex, aborting the read', async () => {
    let opened: AbortSignal | undefined;
    const outcome = await runParse({
      ...base, kind: 'text', sizeBytes: 100, timeMs: 50,
      open: (signal) => {
        opened = signal;
        // A download that never sends another byte.
        return Promise.resolve(new Readable({ read: () => undefined }));
      },
    });
    expect(outcome).toEqual({ kind: 'kept', outcome: 'too_complex', report: null });
    expect(opened?.aborted).toBe(true);
  });

  it('ends a read that runs out of memory as too_complex', async () => {
    // An unterminated quote keeps every following byte in one field.
    const piece = Buffer.alloc(1024 * 1024, 0x61);
    const outcome = await runParse({
      ...base, kind: 'text', sizeBytes: piece.length * 200, resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      open: () => Promise.resolve(Readable.from([Buffer.from('Date,Guests\n2025-01-01,"'), ...repeated(piece, 200)])),
    });
    expect(outcome).toEqual({ kind: 'kept', outcome: 'too_complex', report: null });
  }, 30_000);

  it('reports progress over both passes of a text file', async () => {
    const text = Buffer.from('Date,Guests\n2025-01-01,1\n');
    const seen: [number, number | null][] = [];
    await runParse({
      ...base, kind: 'text', sizeBytes: text.length, onProgress: (done, total) => { seen.push([done, total]); },
      open: () => Promise.resolve(Readable.from([text])),
    });
    expect(seen).toEqual([[text.length, text.length * 2], [text.length * 2, text.length * 2]]);
  });

  it('reads a workbook’s sheets in order, a later sheet replacing an earlier one’s day only for an org admin', async () => {
    const book = xlsxOf([
      { name: 'Old', rows: [['Date', 'Guests'], ['2025-01-01', 1], ['2025-01-02', 2]] },
      { name: 'Empty', rows: [] },
      { name: 'New', rows: [['Date', 'Guests'], ['2025-01-02', 20], ['2025-01-03', 30]] },
      { name: 'Notes', rows: [['Date', 'Note'], ['2025-01-01', 'Closed']] },
    ]);
    const read = (replace: boolean) => runParse({
      ...base, kind: 'xlsx', sizeBytes: book.length, replace, open: () => Promise.resolve(Readable.from([book])),
    });
    const admin = await read(true);
    expect(admin).toMatchObject({
      kind: 'days',
      days: [{ date: '2025-01-01', guests: 1 }, { date: '2025-01-02', guests: 20 }, { date: '2025-01-03', guests: 30 }],
      report: {
        days: 3, rows: 4, encoding: null,
        sheets: [
          { name: 'Old', used: true, why: 'sales' }, { name: 'Empty', used: false, why: 'empty' },
          { name: 'New', used: true, why: 'sales' }, { name: 'Notes', used: false, why: 'notes_not_read_yet' },
        ],
      },
    });
    expect(await read(false)).toMatchObject({ kind: 'days', days: [{ guests: 1 }, { guests: 2 }, { guests: 30 }] });
  });
});

describe('parse thread inbox', () => {
  it('drops messages Node posts on the port, such as node --watch’s module reports, and keeps the thread’s in order', async () => {
    const port = new EventEmitter();
    const messages = inbox(port);
    port.emit('message', { 'watch:import': ['file:///api/src/files/parse/thread.ts'] });
    port.emit('message', { type: 'ack' });
    port.emit('message', { 'watch:import': ['file:///api/src/files/parse/pdf.ts'] });
    port.emit('message', { type: 'progress', done: 1, total: 2 });
    expect(await messages.next()).toEqual({ type: 'ack' });
    expect(await messages.next()).toEqual({ type: 'progress', done: 1, total: 2 });
    const later = messages.next();
    port.emit('message', { 'watch:require': ['node:fs'] });
    port.emit('message', { type: 'again' });
    expect(await later).toEqual({ type: 'again' });
  });

  it('still rejects on a thread error or exit', async () => {
    const port = new EventEmitter();
    const messages = inbox(port);
    port.emit('exit', 1);
    await expect(messages.next()).rejects.toThrow('parse thread exited (1)');
  });

  it('knows the thread’s message types only', () => {
    for (const type of ['ack', 'again', 'progress', 'read', 'model', 'result']) expect(isThreadOut({ type })).toBe(true);
    for (const other of [{ 'watch:import': [] }, { type: 'begin' }, { type: 1 }, 'ack', null, undefined]) expect(isThreadOut(other)).toBe(false);
  });
});
