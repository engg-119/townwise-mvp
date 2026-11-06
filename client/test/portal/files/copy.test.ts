import { ApiError } from '../../../src/api/client';
import {
  ENTRY_OUTCOMES, FAILED_CODES, FILE_KINDS, FILE_STATUSES, KEPT_CODES, QUESTION_KINDS, type FileStatus,
} from '../../../src/portal/files/api';
import * as copy from '../../../src/portal/files/copy';
import type { QueuedUpload, UploadState } from '../../../src/portal/files/uploadQueue';
import { entryOf, fileViewOf } from './fakes';

// Every status, outcome and error code has words (the transparency pillar), enumerated from the api.ts lists;
// every question says what an answer does (explainability); the drop step offers the browser-only path (privacy).

const ERROR_CODES = [
  'invalid_request', 'purpose_unavailable', 'not_found', 'file_too_large', 'import_full', 'too_many_uploading', 'storage_full',
  'daily_upload_limit', 'file_duplicate', 'file_not_uploading', 'upload_expired', 'uploads_busy', 'storage_unavailable',
  'chunks_missing', 'files_unavailable', 'forbidden', 'view_as_read_only', 'view_as_no_download', 'no_access', 'rate_limited',
  'raw_expired', 'file_busy', 'no_clean_file', 'no_entries', 'import_empty', 'import_not_open', 'import_running', 'question_stale',
];

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

test('every kept code of a file or a ZIP entry has its own reason', () => {
  for (const code of [...KEPT_CODES, ...ENTRY_OUTCOMES.filter((code) => code !== 'internal')]) {
    expect(Object.hasOwn(copy.KEPT_REASON, code)).toBe(true);
  }
  for (const code of KEPT_CODES) {
    const line = copy.fileLine(fileViewOf('f1', { status: 'kept', outcome: code }));
    expect(line).toBe(`Kept, not used: ${copy.KEPT_REASON[code]}`);
  }
});

test('a kept code the client doesn’t know yet still says the file was kept, never nothing', () => {
  expect(copy.fileLine(fileViewOf('f1', { status: 'kept', outcome: 'a_code_from_later' }))).toBe('Kept, not used.');
  expect(copy.entryLine(entryOf(0, { status: 'kept', outcome: null }))).toBe('Kept, not used.');
});

test('every status has its line; failed says the file is stored and we look into it', () => {
  const lines = new Map<FileStatus, string>();
  for (const status of FILE_STATUSES) lines.set(status, copy.fileLine(fileViewOf('f1', { status, outcome: status === 'failed' ? FAILED_CODES[0] : null })));
  for (const line of lines.values()) expect(line.length).toBeGreaterThan(0);
  expect(lines.get('read')).toBe('Used: 731 days, Jan 1, 2024 to Dec 31, 2025');
  expect(lines.get('failed')).toBe('Something went wrong reading this file. It’s stored, and we’ll look into it.');
  expect(lines.get('uploading')).toBe('Upload interrupted. Drop it again.');
  expect(copy.fileLine(fileViewOf('f1', { status: 'queued', queuePosition: 2 }))).toBe('Waiting to be read, 2 in line');
});

test('every error code the file routes answer has its own words', () => {
  for (const code of ERROR_CODES) {
    expect(Object.hasOwn(copy.UPLOAD_ERROR, code)).toBe(true);
    expect(copy.uploadError(code)).toBe(copy.UPLOAD_ERROR[code as copy.UploadErrorCode]);
  }
  expect(copy.uploadError('file_too_large', { maxBytes: 209_715_200 })).toBe('This file is over 200 MB. Split it or zip it.');
  expect(copy.uploadError('network')).toBe('Can’t reach Townwise. Check your connection and try again.');
  expect(copy.uploadError('something_new')).toBe('Something went wrong on our side. Try again in a minute.');
  expect(copy.actionError(new ApiError('http', 'x', { status: 409, code: 'file_busy' }))).toBe(copy.UPLOAD_ERROR.file_busy);
});

test('every kind has a label, used for the name under view-as', () => {
  for (const kind of FILE_KINDS) expect(copy.KIND_LABEL[kind].length).toBeGreaterThan(0);
  expect(copy.fileName(fileViewOf('f1', { name: null, kind: 'zip' }))).toBe('ZIP archive, uploaded Nov 5, 2026');
  expect(copy.fileName(fileViewOf('f1', { name: 'March.xlsx' }))).toBe('March.xlsx');
  expect(copy.cleanName({ name: 'March export.csv' })).toBe('March export-townwise.csv');
  expect(copy.cleanName({ name: null })).toBe('file-townwise.csv');
});

test('time left says Estimating without a basis, and rounds up to 5 seconds', () => {
  expect(copy.timeLeft(null)).toBe('Estimating');
  expect(copy.timeLeft(1)).toBe('About 5 seconds left');
  expect(copy.timeLeft(37)).toBe('About 40 seconds left');
  expect(copy.timeLeft(58)).toBe('About 1 minute left');
  expect(copy.timeLeft(150, 'upload')).toBe('About 3 minutes left to upload');
  expect(copy.timeLeft(61, 'read')).toBe('About 1 minute left to read');
  expect(copy.timeLeft(7200)).toBe('About 2 hours left');
  expect(copy.speedLine(2.1 * 1024 * 1024)).toBe('2.1 MB/s');
  expect(copy.formatSize(2 * 1024 ** 3)).toBe('2 GB');
  expect(copy.formatSize(820 * 1024)).toBe('820 KB');
  expect(copy.overallLine({ files: 3, bytes: 3 * 1024 * 1024, secondsLeft: null })).toBe('3 files, 3 MB · Estimating');
  expect(copy.overallLine({ files: 1, bytes: 1024, secondsLeft: 0 })).toBe('1 file, 1 KB · Uploaded');
  expect(copy.readingLine({ status: 'queued', etaSeconds: null, waitingForTurn: true })).toBe('Waiting for a turn');
  expect(copy.readingLine({ status: 'reading', etaSeconds: 60, waitingForTurn: false })).toBe('About 1 minute left to read');
});

test('every queue state has a line; sending shows speed and time left, retrying says Reconnecting', () => {
  const states: UploadState[] = ['waiting', 'creating', 'sending', 'retrying', 'completing', 'done', 'refused', 'failed', 'cancelled'];
  const item: QueuedUpload = {
    key: 'u1', fileId: null, name: 'a.csv', sizeBytes: 10, state: 'waiting', sentBytes: 0, bytesPerSecond: null, secondsLeft: null,
    error: { code: 'daily_upload_limit' }, file: null,
  };
  for (const state of states) expect(copy.queueLine({ ...item, state }).length).toBeGreaterThan(0);
  expect(copy.queueLine({ ...item, state: 'sending' })).toBe('Estimating');
  expect(copy.queueLine({ ...item, state: 'sending', bytesPerSecond: 640 * 1024, secondsLeft: 40 })).toBe('640 KB/s · About 40 seconds left');
  expect(copy.queueLine({ ...item, state: 'retrying' })).toBe('Reconnecting…');
  expect(copy.queueLine({ ...item, state: 'refused' })).toBe('Your organization reached today’s upload limit. Upload the rest tomorrow.');
});

test('every question says what Townwise asks, and what the answer does', () => {
  for (const kind of QUESTION_KINDS) {
    const text = copy.questionText(kind, 'Main Street Bar');
    expect(text.prompt.endsWith('?')).toBe(true);
    expect(text.help).toMatch(/Townwise/);
  }
  expect(copy.questionText('location_value', 'Main Street Bar').prompt).toBe('Which of these is Main Street Bar?');
  expect(copy.optionLabel('row_mode', { id: 'check', label: 'check' })).toBe('One check or order');
  expect(copy.optionLabel('columns', { id: 'guests:none', label: 'none' })).toBe('Not in this file');
  expect(copy.optionLabel('date_column', { id: '2', label: 'Business Date' })).toBe('Business Date');
  expect(copy.COPY.notSureHelp).toMatch(/stored but not used/);
});

test('the drop step offers sending only daily totals, and says what deleting keeps', () => {
  expect(copy.COPY.dailyTotalsOnly).toBe('Prefer to send only daily totals? Read the file in your browser instead.');
  expect(copy.acceptHint(209_715_200)).toBe('Any file: CSV, Excel, PDF, Word, ZIP or text, up to 200 MB each.');
  expect(copy.deleteFileBody(fileViewOf('f1', { name: 'a.csv' }))).toBe(
    'This deletes the original, the cleaned copy and what Townwise found in a.csv. The 731 days it added stay in your sales data. This can’t be undone.',
  );
  expect(copy.deleteRawBody(fileViewOf('f1', { name: 'a.csv' }))).toMatch(/The cleaned copy and the days it added stay/);
  expect(copy.deletedOriginalsLine({ deletedOriginals: 3, skippedBusy: 1 })).toBe('Deleted 3 originals. 1 file was busy and kept.');
});

test('no line uses an em dash', () => {
  const all = [
    ...strings(copy.COPY), ...strings(copy.KEPT_REASON), ...strings(copy.UPLOAD_ERROR), ...strings(copy.KIND_LABEL),
    ...QUESTION_KINDS.flatMap((kind) => strings(copy.questionText(kind, 'X'))),
  ];
  for (const line of all) expect(line).not.toContain(String.fromCharCode(0x2014));
});
