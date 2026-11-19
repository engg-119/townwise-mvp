// A PDF, Word (.docx) or Excel (.xlsx) file attached to a TownwiseAI message (spec D36), as ctx.items.readForModel
// checks and reads it, without Docker: readable from its record alone within the reader's byte caps, read as its text in
// the AI text thread (at most 20,000 characters, cut flagged), why one isn't, old Word and Excel files and ZIPs not
// readable, nothing read without the time for it, a read that waited past the chat's wait for the parse thread listed
// busy and never run, and a thread that failed listed as damaged and logged by its error's type only. Files are built
// in the test.
import { describe, expect, it } from 'vitest';

import type { OrgScope } from '../../src/access/policy.ts';
import { createItemReader, type ItemContent, type ItemForModel, type ItemReaderDeps } from '../../src/files/items.ts';
import { AI_PDF_BYTES, CHAT_SLOT_WAIT_MS, CHAT_TEXT_TIME_MS } from '../../src/files/limits.ts';
import { createMemoryFileBlobs } from '../../src/files/memory-blobs.ts';
import type { AiTextInput, AiTextOutcome } from '../../src/files/parse/ai-text.ts';
import { inThreadSlot } from '../../src/files/parse/thread-slot.ts';
import type { FileKind, FileRecord } from '../../src/stores/files.ts';
import type { TownwiseStores } from '../../src/stores/index.ts';
import { pdfOf } from '../helpers/pdf.ts';
import { docxOf, xlsxOf, zipOf } from '../helpers/zip.ts';

const ORG = '0000000000000000000000a1';
const LOCATION = '0000000000000000000000b1';
const OWNER = { userId: 'u-owner', role: 'member' } as const;
const scope = { orgId: ORG } as unknown as OrgScope;

const PDF = pdfOf([{ texts: [{ text: 'Sentinel-pdf-text: closed Dec 24', x: 72, y: 700 }] }]);
const LIMITS = { slotWaitMs: CHAT_SLOT_WAIT_MS, textTimeMs: CHAT_TEXT_TIME_MS };

let next = 0;

interface Stored {
  check: ItemForModel;
  blobs: ReturnType<typeof createMemoryFileBlobs>;
  id: string;
  /** How many reads of the original the blobs served. */
  readonly opens: () => number;
  warnings: unknown[][];
}

/** A reader over one stored file of `kind` whose original is `bytes`; `over` changes its record, `deps` the reader's. */
async function fileOf(kind: FileKind, bytes: Buffer, over: Partial<FileRecord> = {}, deps: Partial<ItemReaderDeps> = {}): Promise<Stored> {
  next += 1;
  const id = next.toString(16).padStart(24, '0');
  const file = {
    id, locationId: LOCATION, purpose: 'reference', status: 'kept', kind, sizeBytes: bytes.length, uploadedBy: OWNER.userId,
    rawDeletedAt: null, disabledAt: null, ...over,
  } as unknown as FileRecord;
  const blobs = createMemoryFileBlobs();
  await blobs.writeRaw(scope, { locationId: LOCATION, fileId: id }, bytes, 'application/octet-stream');
  let opens = 0;
  const counted = { ...blobs, openRaw: (...args: Parameters<typeof blobs.openRaw>) => { opens += 1; return blobs.openRaw(...args); } };
  const warnings: unknown[][] = [];
  const stores = { files: { get: () => Promise.resolve(file) } } as unknown as Pick<TownwiseStores, 'files'>;
  const reader = createItemReader(stores, counted, { logger: { warn: (...args: unknown[]) => { warnings.push(args); } }, limits: LIMITS, ...deps });
  return { check: await reader.readForModel(scope, LOCATION, id, OWNER), blobs, id, opens: () => opens, warnings };
}

/** Plenty of time left in the turn. */
const later = (): number => Date.now() + 10 * 60_000;

async function readOf(check: ItemForModel, by = later()): Promise<ItemContent> {
  if (check.status !== 'readable') throw new Error(`not readable: ${check.status}`);
  return check.read(by);
}

describe('a PDF, Word or Excel file attached to a message', () => {
  it('is readable from its record alone, with its kind and every byte, and reads as its text', async () => {
    const pdf = await fileOf('pdf', PDF);
    expect(pdf.check).toMatchObject({ status: 'readable', kind: 'pdf', bytes: PDF.length });
    expect(pdf.opens()).toBe(0);
    expect(await readOf(pdf.check)).toEqual({ status: 'text', kind: 'pdf', text: 'Sentinel-pdf-text: closed Dec 24', truncated: false });
    const word = await fileOf('docx', docxOf(['Spring menu', 'Soup']));
    expect(await readOf(word.check)).toEqual({ status: 'text', kind: 'word', text: 'Spring menu\nSoup', truncated: false });
    const book = await fileOf('xlsx', xlsxOf([{ name: 'Daily', rows: [['Date', 'Guests'], ['2026-05-01', 120]] }]));
    expect(await readOf(book.check)).toEqual({ status: 'text', kind: 'excel', text: 'Sheet: Daily\nDate\tGuests\n2026-05-01\t120', truncated: false });
  });

  it('reads at most its first 20,000 characters and says it was cut', async () => {
    const long = await fileOf('docx', docxOf(Array.from({ length: 1000 }, (_, index) => `Paragraph ${String(index)} of the catering list`)));
    const read = await readOf(long.check);
    expect(read).toMatchObject({ status: 'text', kind: 'word', truncated: true });
    expect(read.status === 'text' ? read.text.length : 0).toBe(20_000);
  });

  it('is too large over the reader\'s cap for its kind, before any byte is read', async () => {
    const pdf = await fileOf('pdf', PDF, { sizeBytes: AI_PDF_BYTES + 1 });
    const word = await fileOf('docx', Buffer.from('x'), { sizeBytes: 10 * 1024 * 1024 + 1 });
    const book = await fileOf('xlsx', Buffer.from('x'), { sizeBytes: 10 * 1024 * 1024 + 1 });
    expect([pdf.check, word.check, book.check]).toEqual([
      { status: 'too_large', kind: 'pdf' }, { status: 'too_large', kind: 'word' }, { status: 'too_large', kind: 'excel' },
    ]);
    expect([pdf.opens(), word.opens(), book.opens()]).toEqual([0, 0, 0]);
  });

  it('keeps old Word and Excel files and ZIPs not readable', async () => {
    expect((await fileOf('doc', Buffer.from('old'))).check).toEqual({ status: 'not_readable', kind: 'word' });
    expect((await fileOf('xls', Buffer.from('old'))).check).toEqual({ status: 'not_readable', kind: 'excel' });
    expect((await fileOf('zip', zipOf([{ name: 'a.csv', data: 'Date,Guests\n' }]))).check).toEqual({ status: 'not_readable', kind: 'zip' });
  });

  it('reads one the thread refuses as why: a password, one that can\'t be opened; a scan reads as no text', async () => {
    expect(await readOf((await fileOf('pdf', pdfOf([{ texts: [{ text: 'x', x: 72, y: 700 }] }], { encrypted: true }))).check))
      .toEqual({ status: 'encrypted', kind: 'pdf' });
    expect(await readOf((await fileOf('pdf', Buffer.from('%PDF-1.4\n'))).check)).toEqual({ status: 'damaged', kind: 'pdf' });
    expect(await readOf((await fileOf('docx', Buffer.from('not a word file'))).check)).toEqual({ status: 'damaged', kind: 'word' });
    expect(await readOf((await fileOf('pdf', pdfOf([{ drawing: true }]))).check)).toEqual({ status: 'text', kind: 'pdf', text: '', truncated: false });
  });

  it('is gone when its original was deleted after the check', async () => {
    const pdf = await fileOf('pdf', PDF);
    await pdf.blobs.deleteRaw(scope, { locationId: LOCATION, fileId: pdf.id });
    expect(await readOf(pdf.check)).toEqual({ status: 'gone', kind: 'pdf' });
  });

  it('reads nothing when the turn hasn\'t the time left for the wait and the thread', async () => {
    let made = 0;
    const extractText = (): Promise<AiTextOutcome> => {
      made += 1;
      return Promise.resolve({ kind: 'text', text: 'x', cut: false, pages: 1 });
    };
    const pdf = await fileOf('pdf', PDF, {}, { extractText });
    // 45 seconds are needed; 44 are left.
    expect(await readOf(pdf.check, Date.now() + CHAT_SLOT_WAIT_MS + CHAT_TEXT_TIME_MS - 1000)).toEqual({ status: 'no_time', kind: 'pdf' });
    expect([pdf.opens(), made]).toEqual([0, 0]);
    // With the time, it reads.
    expect(await readOf(pdf.check, Date.now() + CHAT_SLOT_WAIT_MS + CHAT_TEXT_TIME_MS + 5000)).toMatchObject({ status: 'text' });
    expect([pdf.opens(), made]).toEqual([1, 1]);
  });

  it('is busy when the parse thread stays taken past the chat\'s wait, and its thread never starts', async () => {
    let started = 0;
    // The real slot, with a thread that counts its starts.
    const extractText = (input: AiTextInput): Promise<AiTextOutcome> => inThreadSlot(() => {
      started += 1;
      return Promise.resolve({ kind: 'text', text: 'x', cut: false, pages: 1 });
    }, input.waitMs);
    let release: () => void = () => undefined;
    const held = inThreadSlot(() => new Promise<void>((resolve) => { release = resolve; }));
    try {
      const pdf = await fileOf('pdf', PDF, {}, { limits: { slotWaitMs: 50, textTimeMs: CHAT_TEXT_TIME_MS }, extractText });
      expect(await readOf(pdf.check)).toEqual({ status: 'busy', kind: 'pdf' });
    } finally {
      release();
    }
    await held;
    // Another run through the slot settles after where the abandoned one stood: it never ran.
    await inThreadSlot(() => Promise.resolve());
    expect(started).toBe(0);
    // The slot passed straight on: the next read gets it and reads, in the real thread.
    expect(await readOf((await fileOf('pdf', PDF, {}, { limits: { slotWaitMs: 5_000, textTimeMs: CHAT_TEXT_TIME_MS } })).check))
      .toMatchObject({ status: 'text', kind: 'pdf' });
  });

  it('lists a thread that failed as damaged and logs its error\'s type only, never its message', async () => {
    const extractText = (): Promise<AiTextOutcome> => Promise.reject(new TypeError('Sentinel-file-text quoted by a parser'));
    const pdf = await fileOf('pdf', PDF, {}, { extractText });
    expect(await readOf(pdf.check)).toEqual({ status: 'damaged', kind: 'pdf' });
    expect(pdf.warnings).toEqual([[{ orgId: ORG, fileId: pdf.id, kind: 'pdf', errType: 'TypeError' }, 'townwise.chat_file_read_failed']]);
    expect(JSON.stringify(pdf.warnings)).not.toContain('Sentinel');
  });

  it('still fails the read when the original can\'t be read from storage', async () => {
    const pdf = await fileOf('pdf', PDF);
    const failing = { ...pdf.blobs, openRaw: () => Promise.reject(new Error('storage down')) };
    const stores = { files: { get: () => Promise.resolve({ id: pdf.id, locationId: LOCATION, purpose: 'reference', status: 'kept', kind: 'pdf', sizeBytes: PDF.length, uploadedBy: OWNER.userId, rawDeletedAt: null, disabledAt: null }) } } as unknown as Pick<TownwiseStores, 'files'>;
    const check = await createItemReader(stores, failing, { logger: { warn: () => undefined } }).readForModel(scope, LOCATION, pdf.id, OWNER);
    await expect(readOf(check)).rejects.toThrow('storage down');
  });
});

// D63: an .ics or .ical file, which sniff keeps as `other`, is a calendar file, read as a text file is.
describe('a calendar file attached to a message (D63)', () => {
  const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:sentinel-1@example.test', 'SUMMARY:Sentinel-title tasting', 'DTSTART:20261212T180000', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

  it('reads an .ics or .ical file as its text, kind calendar, from its record alone until the read', async () => {
    const ics = await fileOf('other', Buffer.from(ICS), { name: 'Bookings.ICS' });
    expect(ics.check).toMatchObject({ status: 'readable', kind: 'calendar', bytes: ICS.length });
    expect(ics.opens()).toBe(0);
    expect(await readOf(ics.check)).toEqual({ status: 'text', kind: 'calendar', text: ICS, truncated: false });
    const ical = await fileOf('other', Buffer.from(ICS), { name: 'master.ical' });
    expect(await readOf(ical.check)).toMatchObject({ status: 'text', kind: 'calendar' });
  });

  it('reads at most its first 20,000 characters and says it was cut', async () => {
    const read = await readOf((await fileOf('other', Buffer.from(ICS.repeat(400)), { name: 'master.ics' })).check);
    expect(read).toMatchObject({ status: 'text', kind: 'calendar', truncated: true });
    expect(read.status === 'text' ? read.text.length : 0).toBe(20_000);
  });

  it('names a turned-off or deleted one a calendar file, and leaves any other unknown file not readable', async () => {
    expect((await fileOf('other', Buffer.from(ICS), { name: 'a.ics', disabledAt: new Date() })).check).toEqual({ status: 'turned_off', kind: 'calendar' });
    expect((await fileOf('other', Buffer.from(ICS), { name: 'a.ics', rawDeletedAt: new Date() })).check).toEqual({ status: 'gone', kind: 'calendar' });
    expect((await fileOf('other', Buffer.from(ICS), { name: 'a.vcs' })).check).toEqual({ status: 'not_readable', kind: 'file' });
  });
});
