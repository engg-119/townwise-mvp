import { scanText, type ScanOptions } from '../../../src/portal/upload/scan';

// One read in slices: the browser gets its turn while a large file is parsed, and a read nobody wants stops.

function lines(count: number): string {
  const out = ['Date,Guests'];
  for (let i = 0; i < count; i += 1) out.push(`2025-03-04,${String(i)}`);
  return out.join('\n');
}

function clock(step: number): () => number {
  let time = 0;
  return () => { time += step; return time; };
}

test('the header is row 1 and data rows are numbered from 2, after the BOM and with the detected delimiter', async () => {
  const seen: [string[], number][] = [];
  let header: string[] | null = null;
  const outcome = await scanText('\uFEFFDate;Guests\r\n2025-03-04;3\r\n2025-03-05;4', {
    header: (cells) => { header = cells; return true; },
    row: (cells, row) => { seen.push([cells, row]); return true; },
  }, { pause: () => Promise.resolve(), cancelled: () => false });
  expect(outcome).toEqual({ unterminated: false });
  expect(header).toEqual(['Date', 'Guests']);
  expect(seen).toEqual([[['2025-03-04', '3'], 2], [['2025-03-05', '4'], 3]]);
});

test('an empty text has a null header', async () => {
  const headers: (string[] | null)[] = [];
  await scanText('', { header: (cells) => { headers.push(cells); return false; }, row: () => true }, { pause: () => Promise.resolve(), cancelled: () => false });
  expect(headers).toEqual([null]);
});

test('a long read pauses once a slice has run, and a short one does not', async () => {
  const pause = jest.fn(() => Promise.resolve());
  // Each clock read is 20 ms later, so every check (one per 256 rows) finds the 10 ms slice used up.
  const options: ScanOptions = { pause, cancelled: () => false, sliceMs: 10, now: clock(20) };
  let rows = 0;
  await scanText(lines(5000), { header: () => true, row: () => { rows += 1; return true; } }, options);
  expect(rows).toBe(5000);
  expect(pause).toHaveBeenCalledTimes(Math.floor(5001 / 256));
  const quick = jest.fn(() => Promise.resolve());
  await scanText(lines(100), { header: () => true, row: () => true }, { pause: quick, cancelled: () => false, sliceMs: 10, now: clock(20) });
  expect(quick).not.toHaveBeenCalled();
});

test('a read nobody wants stops at the next pause', async () => {
  let wanted = true;
  let rows = 0;
  const outcome = await scanText(lines(5000), {
    header: () => true,
    row: () => { rows += 1; return true; },
  }, { pause: () => { wanted = false; return Promise.resolve(); }, cancelled: () => !wanted, sliceMs: 0, now: clock(1) });
  expect(outcome).toBe('cancelled');
  expect(rows).toBe(255);
});

test('a visitor can stop the read early', async () => {
  let rows = 0;
  const outcome = await scanText(lines(50), { header: () => true, row: () => { rows += 1; return rows < 3; } }, { pause: () => Promise.resolve(), cancelled: () => false });
  expect(outcome).toEqual({ unterminated: false });
  expect(rows).toBe(3);
});

test('a text that ends inside quotes is reported', async () => {
  const outcome = await scanText('Date,Note\n2025-03-04,"open', { header: () => true, row: () => true }, { pause: () => Promise.resolve(), cancelled: () => false });
  expect(outcome).toEqual({ unterminated: true });
});
