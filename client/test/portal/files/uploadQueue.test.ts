import { ApiError } from '../../../src/api/client';
import {
  createUploadQueue, ESTIMATE_AFTER_BYTES, type QueueEngine, type QueueSnapshot,
} from '../../../src/portal/files/uploadQueue';
import { refusal } from '../../helpers/portal';
import { filesFake, LOCATION, sourceOf, type FilesFake } from './fakes';

// The upload queue (storage2 9.2 and 15.2) on a fake clock: three files at a time in drop order, chunks in
// order one at a time, retries with backoff, Retry-After pauses, refusals, the queue stopping on a 403 or
// sign-out, and the speed and time left, each file's and the whole queue's.

const KIB = 1024;

let fake: FilesFake;
let queue: QueueEngine;
let last: QueueSnapshot;

function start(chunkSize = 4): void {
  fake = filesFake({ chunkSize });
  queue = createUploadQueue({ api: fake, locationId: LOCATION, random: () => 0, onChange: (snapshot) => { last = snapshot; } });
  last = queue.snapshot();
}

const flush = (): Promise<void> => jest.advanceTimersByTimeAsync(0);
const states = (): string[] => last.items.map((item) => item.state);
const creates = (): number => fake.calls.filter((call) => call.method === 'POST' && call.path === '/files').length;

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-11-05T15:00:00.000Z') });
});

afterEach(() => {
  queue.dispose();
  jest.useRealTimers();
});

test('three files upload at a time; the rest wait in drop order', async () => {
  start();
  queue.add(['a', 'b', 'c', 'd', 'e'].map((name) => sourceOf(`${name}.csv`, 4)));
  await flush();
  expect(creates()).toBe(3);
  expect(states()).toEqual(['sending', 'sending', 'sending', 'waiting', 'waiting']);
  expect(fake.puts.map((put) => put.fileId)).toEqual(['f1', 'f2', 'f3']);
  fake.puts[1]?.ok();
  await flush();
  // b finished its only chunk and completed; d, the next in drop order, starts.
  expect(states()).toEqual(['sending', 'done', 'sending', 'sending', 'waiting']);
  expect(fake.calls.find((call) => call.path === '/files/f2/complete')).toBeTruthy();
  expect((fake.calls.filter((call) => call.path === '/files')[3]?.body as { name: string }).name).toBe('d.csv');
  expect(last.importId).toBe('i1');
});

test('chunks go in index order, one in flight per file, each exactly the chunk size but the last', async () => {
  start(4);
  queue.add([sourceOf('a.csv', 10)]);
  await flush();
  expect(fake.puts.map((put) => [put.index, put.size])).toEqual([[0, 4]]);
  fake.puts[0]?.ok();
  await flush();
  expect(fake.puts.map((put) => [put.index, put.size])).toEqual([[0, 4], [1, 4]]);
  fake.puts[1]?.ok();
  await flush();
  fake.puts[2]?.ok();
  await flush();
  expect(fake.puts.map((put) => [put.index, put.size])).toEqual([[0, 4], [1, 4], [2, 2]]);
  expect(states()).toEqual(['done']);
  expect(last.items[0]?.sentBytes).toBe(10);
  expect(last.items[0]?.file?.status).toBe('stored');
});

test('a failed chunk retries after 1, 2, 4, 8 and 16 seconds, then the file fails', async () => {
  start();
  queue.add([sourceOf('a.csv', 4)]);
  await flush();
  const waits = [1000, 2000, 4000, 8000, 16000];
  for (const [attempt, wait] of waits.entries()) {
    fake.puts[attempt]?.fail(new ApiError('network', 'The network request failed.'));
    await flush();
    expect(states()).toEqual(['retrying']);
    await jest.advanceTimersByTimeAsync(wait - 1);
    expect(fake.puts).toHaveLength(attempt + 1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fake.puts).toHaveLength(attempt + 2);
    expect(fake.puts[attempt + 1]?.index).toBe(0);
  }
  fake.puts[5]?.fail(refusal(500, 'internal'));
  await flush();
  expect(states()).toEqual(['failed']);
  expect(last.items[0]?.error).toEqual({ code: 'internal' });
});

test('uploads_busy and 429 wait Retry-After and never count as attempts', async () => {
  start();
  queue.add([sourceOf('a.csv', 4)]);
  await flush();
  for (let pause = 0; pause < 8; pause += 1) {
    fake.puts[pause]?.fail(pause % 2 === 0 ? refusal(503, 'uploads_busy', 2) : refusal(429, 'rate_limited', 3));
    await flush();
    expect(states()).toEqual(['retrying']);
    await jest.advanceTimersByTimeAsync(pause % 2 === 0 ? 2000 : 3000);
  }
  fake.puts[8]?.ok();
  await flush();
  expect(states()).toEqual(['done']);
});

test('storage_unavailable is retried with backoff, waiting at least its Retry-After', async () => {
  start();
  queue.add([sourceOf('a.csv', 4)]);
  await flush();
  fake.puts[0]?.fail(refusal(503, 'storage_unavailable', 5));
  await flush();
  await jest.advanceTimersByTimeAsync(4999);
  expect(fake.puts).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(fake.puts).toHaveLength(2);
});

test('a refusal ends the file without a retry; the daily limit also refuses every file still waiting', async () => {
  start();
  fake.answers['POST /files'] = (body) => ((body as { name: string }).name === 'a.csv' ? refusal(409, 'daily_upload_limit') : undefined);
  queue.add(['a', 'b', 'c', 'd', 'e'].map((name) => sourceOf(`${name}.csv`, 4)));
  await flush();
  expect(states()).toEqual(['refused', 'sending', 'sending', 'refused', 'refused']);
  for (const item of [last.items[0], last.items[3], last.items[4]]) expect(item?.error?.code).toBe('daily_upload_limit');
  expect(creates()).toBe(3);
  expect(last.overall.files).toBe(2);
});

const limits = { maxFileBytes: 209_715_200, chunkSize: 4, dailyBytesLeft: 100, storedBytesLeft: 100, filesLeftInImport: 49 };

function fileOf(name: string): Record<string, unknown> {
  const id = name.replace('.csv', '');
  return {
    id, importId: 'i1', purpose: 'history', name, kind: 'text', sizeBytes: 4, uploadedAt: '2026-11-05T15:00:00.000Z', uploadedByEmail: 'x',
    status: 'uploading', outcome: null, upload: { chunkSize: 4, chunkCount: 1, receivedBytes: 0, nextChunk: 0, expiresAt: '2026-11-06T15:00:00.000Z' },
    progress: null, etaSeconds: null, queuePosition: null, entries: null, result: null, hasClean: false, rawAvailable: true, rawExpiresAt: null,
    canDownloadRaw: true, canDownloadClean: true, canDelete: true, canDeleteRaw: true,
  };
}

test('a file the location already has is refused at complete, naming the earlier file', async () => {
  start();
  fake.answers['POST /files/f1/complete'] = () => new ApiError('http', 'The request was refused.', { status: 409, code: 'file_duplicate', detail: { fileId: 'f0' } });
  queue.add([sourceOf('a.csv', 4)]);
  await flush();
  fake.puts[0]?.ok();
  await flush();
  expect(states()).toEqual(['refused']);
  expect(last.items[0]?.error).toEqual({ code: 'file_duplicate', detail: { fileId: 'f0' } });
});

test('files_unavailable sets the flag the screen reads to show the browser upload, and stops the queue', async () => {
  start();
  fake.answers['POST /files'] = () => refusal(503, 'files_unavailable');
  queue.add(['a', 'b', 'c', 'd'].map((name) => sourceOf(`${name}.csv`, 4)));
  await flush();
  expect(last.filesUnavailable).toBe(true);
  expect(states()).toEqual(['failed', 'failed', 'failed', 'failed']);
  expect(creates()).toBe(3);
});

test('a 403 stops every file still going, and sign-out does too', async () => {
  start();
  queue.add(['a', 'b', 'c', 'd'].map((name) => sourceOf(`${name}.csv`, 8)));
  await flush();
  fake.puts[0]?.fail(refusal(403, 'no_access'));
  await flush();
  expect(states()).toEqual(['failed', 'failed', 'failed', 'failed']);
  expect(last.items.map((item) => item.error?.code)).toEqual(['no_access', 'no_access', 'no_access', 'no_access']);
  expect(fake.puts[1]?.signal?.aborted).toBe(true);
  // No further request: the waiting file never started.
  expect(creates()).toBe(3);

  queue.add([sourceOf('e.csv', 8)]);
  await flush();
  fake.puts.at(-1)?.fail(new ApiError('signed_out', 'Your session ended.'));
  await flush();
  expect(last.items.at(-1)?.error?.code).toBe('signed_out');
});

test('speed is an average of each second, with alpha 0.3; time left waits for 2 seconds and 256 KiB', async () => {
  start(1024 * KIB);
  queue.add([sourceOf('a.csv', 1024 * KIB)]);
  await flush();
  const put = fake.puts[0];
  // Second 1: 100 KiB sent. A speed, but no time left yet (under 2 seconds and 256 KiB).
  put?.progress(100 * KIB);
  await jest.advanceTimersByTimeAsync(1000);
  expect(last.items[0]?.bytesPerSecond).toBe(100 * KIB);
  expect(last.items[0]?.secondsLeft).toBeNull();
  expect(last.overall.secondsLeft).toBeNull();
  // Second 2: 200 KiB more (300 KiB sent). 0.3 * 200 + 0.7 * 100 = 130 KiB/s; 724 KiB left is 5.6 s, so 10 s.
  put?.progress(300 * KIB);
  await jest.advanceTimersByTimeAsync(1000);
  expect(last.items[0]?.bytesPerSecond).toBeCloseTo(130 * KIB, 6);
  expect(last.items[0]?.sentBytes).toBe(300 * KIB);
  expect(last.items[0]?.secondsLeft).toBe(10);
  expect(last.overall).toEqual({ files: 1, bytes: 1024 * KIB, sentBytes: 300 * KIB, secondsLeft: 10 });
});

test('a browser that reports no upload progress still gets a speed from the chunks acknowledged', async () => {
  start(256 * KIB);
  queue.add([sourceOf('a.csv', 2048 * KIB)]);
  await flush();
  for (let second = 1; second <= 3; second += 1) {
    fake.puts.at(-1)?.ok({ silent: true });
    await flush();
    fake.puts.at(-1)?.ok({ silent: true });
    await jest.advanceTimersByTimeAsync(1000);
  }
  // Two 256 KiB chunks a second, with no progress event: 512 KiB/s, 512 KiB left, so 1 s, shown as 5.
  expect(last.items[0]?.bytesPerSecond).toBeCloseTo(512 * KIB, 6);
  expect(last.items[0]?.secondsLeft).toBe(5);
});

test('a slow start says Estimating until 256 KiB are sent, however long it takes', async () => {
  start(1024 * KIB);
  queue.add([sourceOf('a.csv', 1024 * KIB)]);
  await flush();
  for (let second = 1; second <= 5; second += 1) {
    fake.puts[0]?.progress(second * 50 * KIB);
    await jest.advanceTimersByTimeAsync(1000);
  }
  expect(last.items[0]?.sentBytes).toBeLessThan(ESTIMATE_AFTER_BYTES);
  expect(last.items[0]?.bytesPerSecond).toBeCloseTo(50 * KIB, 6);
  expect(last.items[0]?.secondsLeft).toBeNull();
  fake.puts[0]?.progress(300 * KIB);
  await jest.advanceTimersByTimeAsync(1000);
  expect(last.items[0]?.secondsLeft).not.toBeNull();
});

test('the queue’s time left is every byte still to send, waiting files too, over the files’ summed speeds', async () => {
  start(1024 * KIB);
  queue.add(['a', 'b', 'c', 'd'].map((name) => sourceOf(`${name}.csv`, 1024 * KIB)));
  await flush();
  for (let second = 1; second <= 2; second += 1) {
    for (const put of fake.puts) put.progress(second * 200 * KIB);
    await jest.advanceTimersByTimeAsync(1000);
  }
  // Three files at 200 KiB/s each: 600 KiB/s for 4 MiB less 1.2 MiB sent, 4.8 s rounded up to 5.
  expect(last.overall.bytes).toBe(4096 * KIB);
  expect(last.overall.sentBytes).toBe(1200 * KIB);
  expect(last.overall.secondsLeft).toBe(5);
  expect(states()).toEqual(['sending', 'sending', 'sending', 'waiting']);
});

test('a retry pause keeps the average, and resent bytes count from the start of the chunk again', async () => {
  start(1024 * KIB);
  queue.add([sourceOf('a.csv', 2048 * KIB)]);
  await flush();
  fake.puts[0]?.progress(300 * KIB);
  await jest.advanceTimersByTimeAsync(1000);
  expect(last.items[0]?.bytesPerSecond).toBe(300 * KIB);
  fake.puts[0]?.fail(new ApiError('network', 'The network request failed.'));
  await flush();
  expect(last.items[0]?.state).toBe('retrying');
  expect(last.items[0]?.sentBytes).toBe(0);
  await jest.advanceTimersByTimeAsync(1000);
  // The second of waiting is not counted as zero speed.
  expect(last.items[0]?.bytesPerSecond).toBe(300 * KIB);
  expect(fake.puts).toHaveLength(2);
});

test('cancel stops a file and deletes what the server has; a waiting file leaves without a request', async () => {
  start();
  queue.add(['a', 'b', 'c', 'd'].map((name) => sourceOf(`${name}.csv`, 8)));
  await flush();
  const first = last.items[0]?.key ?? '';
  const waiting = last.items[3]?.key ?? '';
  queue.cancel(waiting);
  queue.cancel(first);
  await flush();
  expect(fake.puts[0]?.signal?.aborted).toBe(true);
  expect(states()).toEqual(['cancelled', 'sending', 'sending', 'cancelled']);
  expect(fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/f1']);
  expect(creates()).toBe(3);
  expect(last.overall.files).toBe(2);
});

test('a file cancelled while it is being created is deleted once the server answers', async () => {
  start();
  let answer: (value: unknown) => void = () => undefined;
  fake.answers['POST /files'] = () => new Promise((resolve) => { answer = resolve; });
  queue.add([sourceOf('a.csv', 4)]);
  await flush();
  queue.cancel(last.items[0]?.key ?? '');
  answer({ file: fileOf('a.csv'), import: { id: 'i1', status: 'open' }, limits });
  await flush();
  expect(states()).toEqual(['cancelled']);
  expect(fake.puts).toHaveLength(0);
  expect(fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/files/a']);
});

test('an empty file is refused without a request', async () => {
  start();
  queue.add([sourceOf('empty.csv', 0)]);
  await flush();
  expect(states()).toEqual(['refused']);
  expect(last.items[0]?.error).toEqual({ code: 'file_empty' });
  expect(fake.calls).toHaveLength(0);
});

test('after dispose (the screen closed), unfinished uploads stop and nothing more is sent', async () => {
  start();
  queue.add(['a', 'b'].map((name) => sourceOf(`${name}.csv`, 8)));
  await flush();
  queue.dispose();
  await flush();
  expect(fake.puts.every((put) => put.signal?.aborted === true)).toBe(true);
  expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
});
