import type { QueuedUpload } from '../../../src/portal/files/uploadQueue';
import {
  calendarYears, cardMoves, doneLine, filesReadLine, foundLines, importToStart, mergeRows, needsHistory, overLine, pendingRange,
  phaseOf, rowProgress, sendingCount, statusLine, STEP, storedCount, SUGGESTIONS,
} from '../../../src/portal/onboarding/history';
import { locationOf, orgOf } from '../../helpers/portal';
import { fileViewOf, importViewOf } from '../files/fakes';

// The drop step's pure rules (spec P11, storage2 2.1, 2.2 and 15.3): when it shows, its phases, how this screen's
// uploads merge with the server's list, when reading can start, and its lines. Pillars: every line comes from the
// server's counts and dates, never a guess, and "Estimating" stands where there is no basis (T, E); the suggestions
// promise nothing the reader doesn't do, such as reading notes inside files (honest copy, P).

const HANOVER = { townId: 'hanover-nh', name: 'Hanover', state: 'NH' };
const DAYS = { dayCount: 10, guestsDayCount: 10, netSalesDayCount: 10, firstDate: '2025-01-01', lastDate: '2025-01-10', missingDays: 0 };

function item(key: string, extra?: Partial<QueuedUpload>): QueuedUpload {
  return {
    key, fileId: null, name: `${key}.csv`, sizeBytes: 100, state: 'waiting', sentBytes: 0, bytesPerSecond: null, secondsLeft: null,
    error: null, file: null, ...extra,
  };
}

test('needsHistory: the organization has locations and none has a stored day', () => {
  const empty = locationOf('l1', 'Main Street Bar', HANOVER);
  const withDays = locationOf('l2', 'River Cafe', HANOVER, { coverage: DAYS });
  expect(needsHistory(orgOf('org_admin'), [empty])).toBe(true);
  expect(needsHistory(orgOf('org_admin'), [empty, withDays])).toBe(false);
  expect(needsHistory(orgOf('org_admin'), [])).toBe(false);
});

test('phases: drop until reading starts, reading while files are read, and done only for an import this screen watched', () => {
  expect(phaseOf(null, false)).toBe('drop');
  expect(phaseOf(importViewOf('i1', { status: 'open' }), true)).toBe('drop');
  for (const status of ['queued', 'reading', 'waiting'] as const) expect(phaseOf(importViewOf('i1', { status }), true)).toBe('reading');
  const found = { ...importViewOf('i1').found, dayCount: 3, firstDate: '2025-01-01', lastDate: '2025-01-03' };
  expect(phaseOf(importViewOf('i1', { status: 'done', found }), true)).toBe('done');
  // A finished import someone comes back to opens an empty drop zone (storage2 15.3).
  expect(phaseOf(importViewOf('i1', { status: 'done', found }), false)).toBe('drop');
  // One that found nothing keeps its reasons listed, watched or not.
  expect(phaseOf(importViewOf('i1', { status: 'done' }), false)).toBe('nothing_used');
});

test('rows: the server list in upload order, each still-sending file as its upload, then uploads the server does not list yet', () => {
  const view = importViewOf('i1', {
    files: [
      fileViewOf('f1', { status: 'stored', result: null }),
      fileViewOf('f2', { status: 'uploading', result: null }),
      fileViewOf('f3', { status: 'uploading', result: null }),
      fileViewOf('f4', { status: 'stored', result: null }),
    ],
  });
  const items = [
    item('u1', { fileId: 'f2', state: 'sending', sentBytes: 50 }),
    item('u2', { fileId: 'f3', state: 'done', file: fileViewOf('f3', { status: 'stored', result: null }) }),
    item('u3', { fileId: 'f4', state: 'cancelled' }),
    item('u4'),
  ];
  const rows = mergeRows(view, items);
  expect(rows.map((row) => `${row.kind}:${row.key}`)).toEqual(['file:f1', 'upload:u1', 'file:f3', 'upload:u4']);
  // f3 is shown as its complete answered, not as the server's stale "uploading".
  const f3 = rows[2];
  expect(f3?.kind === 'file' ? f3.file.status : null).toBe('stored');
  expect(storedCount(rows)).toBe(2);
  expect(sendingCount(items)).toBe(2);
});

test('an interrupted upload from an earlier visit stays listed as the server reports it', () => {
  const rows = mergeRows(importViewOf('i1', { files: [fileViewOf('f1', { status: 'uploading', result: null })] }), []);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.kind === 'file' ? rows[0].file.status : null).toBe('uploading');
  expect(storedCount(rows)).toBe(0);
});

test('Read my history starts the open import, else the one the first upload joined', () => {
  expect(importToStart(importViewOf('i1', { status: 'open' }), 'i2')).toBe('i1');
  expect(importToStart(null, 'i2')).toBe('i2');
  expect(importToStart(importViewOf('i1', { status: 'done' }), 'i2')).toBe('i2');
  expect(importToStart(null, null)).toBeNull();
});

test('progress: bytes sent while uploading, units read only when the server knows the total', () => {
  expect(rowProgress({ kind: 'upload', key: 'u1', item: item('u1', { state: 'sending', sentBytes: 25 }) })).toBe(0.25);
  expect(rowProgress({ kind: 'upload', key: 'u1', item: item('u1', { state: 'refused' }) })).toBeNull();
  const reading = (total: number | null) => fileViewOf('f1', { status: 'reading', progress: { phase: 'reading', done: 30, total, unit: 'bytes' } });
  expect(rowProgress({ kind: 'file', key: 'f1', file: reading(120) })).toBe(0.25);
  expect(rowProgress({ kind: 'file', key: 'f1', file: reading(null) })).toBeNull();
  expect(rowProgress({ kind: 'file', key: 'f1', file: fileViewOf('f1') })).toBeNull();
});

test('the calendar draws the years with days, else this year, and marks unread days only while reading', () => {
  expect(calendarYears([], '2026-11-05')).toEqual([2026]);
  expect(calendarYears(['2024-03-01', '2025-01-01', '2025-02-01'], '2026-11-05')).toEqual([2024, 2025]);
  expect(pendingRange([2024, 2025], '2026-11-05', true)).toEqual({ from: '2024-01-01', to: '2026-11-04' });
  expect(pendingRange([2024, 2025], '2026-11-05', false)).toBeUndefined();
  expect(pendingRange([2026], '2026-01-01', true)).toBeUndefined();
});

test('the card moves only once, on a wide screen, with motion allowed, on a fresh drop step', () => {
  const base = { reduced: false, desktop: true, played: false, phase: 'drop' as const, hasImport: false };
  expect(cardMoves(base)).toBe(true);
  expect(cardMoves({ ...base, reduced: true })).toBe(false);
  // Not known yet (native's first frames) counts as reduced.
  expect(cardMoves({ ...base, reduced: null })).toBe(false);
  expect(cardMoves({ ...base, desktop: false })).toBe(false);
  expect(cardMoves({ ...base, played: true })).toBe(false);
  expect(cardMoves({ ...base, hasImport: true })).toBe(false);
  expect(cardMoves({ ...base, phase: 'reading' })).toBe(false);
});

test('found so far, the files line and the done line come from the import’s own counts', () => {
  const found = {
    dayCount: 731, firstDate: '2024-01-01', lastDate: '2025-12-31', guestsDayCount: 731, netSalesDayCount: 700,
    closedDates: ['2024-12-25', '2025-12-25'], missingDays: 0,
  };
  expect(foundLines(found)).toEqual([
    '731 days, Jan 1, 2024 to Dec 31, 2025.',
    '731 days with guests, 700 days with net sales.',
    '2 days closed.',
    'No days missing in between.',
  ]);
  expect(foundLines(importViewOf('i1').found)).toEqual(['No days yet.']);
  expect(filesReadLine({ filesTotal: 3, filesDone: 1, bytesTotal: 0, bytesDone: 0 })).toBe('1 of 3 files read');
  expect(doneLine(found)).toBe('Done. 731 days, Jan 1, 2024 to Dec 31, 2025.');
  expect(doneLine(importViewOf('i1').found)).toBe(STEP.nothingUsed);
});

test('screen readers hear one line per change, with no time left or byte count in it', () => {
  expect(statusLine('drop', null)).toBe('');
  expect(statusLine('reading', importViewOf('i1', { status: 'reading', etaSeconds: 40 }))).toBe('Reading your history');
  const question = { id: 'q1', fileId: 'f1', fileName: null, kind: 'date_column' as const, options: [], suggested: null, family: null };
  expect(statusLine('reading', importViewOf('i1', { status: 'waiting', question }))).toBe(STEP.questionLine);
  expect(statusLine('nothing_used', importViewOf('i1', { status: 'done' }))).toBe(STEP.nothingUsed);
});

test('the drag line counts files when the browser says how many', () => {
  expect(overLine(2)).toBe('Drop to add 2 files');
  expect(overLine(1)).toBe('Drop to add 1 file');
  expect(overLine(0)).toBe('Drop to add these files');
});

test('the suggestions name every kind the owner asked for and promise nothing the reader does not do', () => {
  const text = SUGGESTIONS.map((each) => `${each.title} ${each.body}`).join(' ');
  for (const kind of ['Daily sales summaries', 'Sales reports', 'ZIP', 'PDF', 'Check-level']) expect(text).toContain(kind);
  expect(text).toContain('doesn’t read notes inside files yet');
  expect(text).not.toMatch(/forecast/i);
  // No em dashes in copy.
  expect(JSON.stringify({ SUGGESTIONS, STEP })).not.toContain('—');
});
