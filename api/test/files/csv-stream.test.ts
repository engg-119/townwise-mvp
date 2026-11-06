// The streamed reader against the shared fixtures (spec 11A, parity): every fixture read whole and in 1-byte and
// 7-byte pieces, through the parse thread, gives expected.json; and the push tokenizer yields exactly the browser
// reader's records however the text is cut. client/test/portal/upload/parity.test.ts holds the browser to the same files.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { CsvPushReader, detectDelimiter, parseCsv, stripBom } from '../../src/files/parse/csv.ts';
import { runParse } from '../../src/files/parse/run.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'sales-files');
interface Expected {
  locationName: string; latest: string;
  files: Record<string, { outcome: 'days'; days: unknown[] } | { outcome: 'kept'; code: string } | { outcome: 'question'; kind: string }>;
}
const expected = JSON.parse(readFileSync(join(DIR, 'expected.json'), 'utf8')) as Expected;
const fixtures = readdirSync(DIR).filter((name) => name !== 'expected.json').sort();

function pieces(bytes: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

function pushRecords(text: string, size: number): string[][] {
  const clean = stripBom(text);
  const records: string[][] = [];
  const reader = new CsvPushReader(detectDelimiter(clean), (fields) => records.push(fields));
  for (let at = 0; at < clean.length; at += size) reader.push(clean.slice(at, at + size));
  reader.end();
  return records;
}

async function read(bytes: Buffer, size: number) {
  return runParse({
    kind: 'text', sizeBytes: bytes.length, answers: {}, locationName: expected.locationName, latest: expected.latest, replace: true,
    open: () => Promise.resolve(Readable.from(pieces(bytes, size))), onProgress: () => undefined,
  });
}

describe('streamed text against the fixtures', () => {
  it('covers every fixture in expected.json', () => {
    expect(Object.keys(expected.files).sort()).toEqual(fixtures);
  });

  it.each(fixtures)('%s: the push tokenizer matches the whole-text reader in 1- and 7-character pieces', (name) => {
    const text = readFileSync(join(DIR, name), 'utf8');
    const whole = parseCsv(text);
    expect(pushRecords(text, 1)).toEqual(whole);
    expect(pushRecords(text, 7)).toEqual(whole);
    expect(pushRecords(text, text.length)).toEqual(whole);
  });

  it.each(fixtures)('%s: whole, 1-byte and 7-byte pieces give expected.json', async (name) => {
    const bytes = readFileSync(join(DIR, name));
    const want = expected.files[name];
    for (const size of [bytes.length, 1, 7]) {
      const outcome = await read(bytes, size);
      if (want?.outcome === 'days') {
        expect(outcome.kind).toBe('days');
        if (outcome.kind === 'days') expect(outcome.days).toEqual(want.days);
      } else if (want?.outcome === 'kept') {
        expect(outcome).toMatchObject({ kind: 'kept', outcome: want.code });
      } else {
        expect(outcome).toMatchObject({ kind: 'question', question: { kind: want?.kind } });
      }
    }
  });

  it('decodes UTF-8 split inside a character, UTF-16 by its mark, and windows-1252 when it is not UTF-8', async () => {
    const text = 'Date,Location,Guests\r\n2025-01-01,Café Main,10\r\n2025-01-01,Other,3\r\n2025-01-02,Café Main,12\r\n';
    const named = (bytes: Buffer, locationName: string) => runParse({
      kind: 'text', sizeBytes: bytes.length, answers: {}, locationName, latest: '2026-06-02', replace: true,
      open: () => Promise.resolve(Readable.from(pieces(bytes, 1))), onProgress: () => undefined,
    });
    const want = [{ date: '2025-01-01', guests: 10, netSalesCents: null }, { date: '2025-01-02', guests: 12, netSalesCents: null }];
    for (const [bytes, encoding] of [
      [Buffer.from(text, 'utf8'), 'utf-8'],
      [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), 'utf-16'],
      [Buffer.from(text, 'latin1'), 'windows-1252'],
    ] as const) {
      const outcome = await named(bytes, 'café main');
      expect(outcome).toMatchObject({ kind: 'days', days: want, report: { encoding } });
    }
  });

  it('keeps a file whose bytes stop being UTF-8 after the first 64 KiB as bad_encoding', async () => {
    const head = Buffer.from(`Date,Guests\n${'2025-01-01,1\n'.repeat(6000)}`, 'utf8');
    const bytes = Buffer.concat([head, Buffer.from([0xc3, 0x28, 0x0a])]);
    expect(await read(bytes, 4096)).toEqual({ kind: 'kept', outcome: 'bad_encoding', report: null });
  });
});
