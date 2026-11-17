import '../../viewer/setup';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DataItem } from '../../../src/portal/data/api';
import type { MeResponse } from '../../../src/portal/schemas';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe } from '../../helpers/portal';
import { locationsFake } from '../locations/fakes';
import { aiOf, dailyTotalsOf, dataFake, itemOf, type DataFake } from './fakes';

// The TownwiseAI section of an item's page on web (P27, D34, spec 11A.9): asking for a read (what is sent and done, the
// privacy link), a kind it can't read, the read polled every 3 seconds until it settles, what a done read found and
// added (each with its link or why not), failed and skipped reads, Undo behind its dialog, view-as, and the line on an
// item TownwiseAI made. Every file, title and figure is synthetic.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const REF = `f_${'b'.repeat(24)}`;
const UPLOAD = `u_${'c'.repeat(24)}`;
const SUMMARY = `f_${'d'.repeat(24)}`;

function stored(extra: Partial<DataItem> = {}): DataItem {
  return itemOf(REF, { name: 'june-events.txt', state: 'kept', outcome: 'reference', ...extra });
}

function setup(items: DataItem[], ref: string, me: MeResponse = meOf(ACCESS.admin)): DataFake {
  const fake = dataFake({ inner: locationsFake(), items });
  for (const item of items) {
    if (item.file !== null) fake.files.downloads[`/files/${item.file.id}/raw`] = () => new Blob(['June events']);
  }
  const api = fakePortalApi({ me, org: orgOf('org_admin'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = `/locations/l1/data/${ref}`;
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return fake;
}

async function section(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'TownwiseAI' });
}

/** How many times the page read one item since spyGets(fake). */
const itemGets = new WeakMap<DataFake, Map<string, number>>();
function gets(fake: DataFake, ref: string): number {
  return itemGets.get(fake)?.get(ref) ?? 0;
}
function spyGets(fake: DataFake): void {
  const counts = new Map<string, number>();
  itemGets.set(fake, counts);
  const json = fake.json.bind(fake);
  fake.json = (path, schema, opts) => {
    const one = /^\/api\/org\/locations\/l1\/data\/([^/]+)$/.exec(path);
    if ((opts?.method ?? 'GET') === 'GET' && one?.[1] !== undefined) counts.set(one[1], (counts.get(one[1]) ?? 0) + 1);
    return json(path, schema, opts);
  };
}

describe('before a read', () => {
  test('says what is sent and what TownwiseAI does, links the privacy page, and asks for a read; the reading line takes focus', async () => {
    const fake = setup([stored({ canAiRead: true })], REF);
    const box = await section();
    expect(within(box).getByRole('heading', { name: 'TownwiseAI' })).toBeTruthy();
    expect(within(box).getByText(/The whole file is sent to Anthropic’s Claude to read \(a picture without its metadata\)\./)).toBeTruthy();
    expect(within(box).getByText(/dated events as notes, daily totals it can check against the file as new sales days \(it never changes a day you already have\), and a summary TownwiseAI can read later\. When an org admin asks, it may also start updating the forecast\. Everything it adds can be undone\./)).toBeTruthy();
    expect(within(box).getByRole('link', { name: 'How Townwise handles your data' }).getAttribute('href')).toBe('/privacy');

    fireEvent.click(within(box).getByRole('button', { name: 'Let TownwiseAI read this file' }));
    const reading = await within(box).findByText('TownwiseAI is reading this file. It’s next in line, and this page updates when it’s done.');
    expect(fake.ai).toEqual([{ method: 'POST', ref: REF, body: {} }]);
    expect(within(box).queryByRole('button', { name: 'Let TownwiseAI read this file' })).toBeNull();
    await waitFor(() => { expect(document.activeElement?.contains(reading)).toBe(true); });
  });

  test.each<[string, Partial<DataItem>, string]>([
    ['old Excel', { kind: 'xls', name: 'old.xls' }, 'TownwiseAI can’t read old Excel files (.xls). Save it as .xlsx and add it again to let TownwiseAI read it.'],
    ['old Word', { kind: 'doc', name: 'old.doc' }, 'TownwiseAI can’t read old Word files (.doc). Save it as .docx and add it again to let TownwiseAI read it.'],
    ['Numbers', { kind: 'other', name: 'sheet.numbers' }, 'TownwiseAI can’t read Numbers files. Export it as CSV or Excel and add it again to let TownwiseAI read it.'],
  ])('a kind TownwiseAI can’t read (%s) says why instead of the button', async (_, extra, why) => {
    setup([stored({ canAiRead: true, ...extra })], REF);
    const box = await section();
    expect(within(box).getByText(why)).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'Let TownwiseAI read this file' })).toBeNull();
  });

  test('a picture named as one keeps the button', async () => {
    setup([stored({ canAiRead: true, kind: 'other', name: 'flyer.png' })], REF);
    expect(within(await section()).getByRole('button', { name: 'Let TownwiseAI read this file' })).toBeTruthy();
  });

  test('no section for someone who may not ask and no read yet, nor for an upload with no stored file', async () => {
    setup([stored({ canAiRead: false })], REF);
    await screen.findByText('Added Nov 5, 2026 by owner@example.com');
    expect(screen.queryByRole('region', { name: 'TownwiseAI' })).toBeNull();
    cleanup();
    setup([dailyTotalsOf(UPLOAD, { canAiRead: false })], UPLOAD);
    await screen.findByText('Daily totals · No file kept · Sent from a browser');
    expect(screen.queryByRole('region', { name: 'TownwiseAI' })).toBeNull();
  });

  test.each<[number, string, string]>([
    [503, 'ai_unavailable', 'TownwiseAI can’t read files right now. Try again later.'],
    [429, 'ai_read_queue_full', 'TownwiseAI is already reading 10 of your organization’s files. Try again when one of them is done.'],
  ])('a refusal (%s %s) says why in plain words and leaves the button', async (status, code, line) => {
    const fake = setup([stored({ canAiRead: true })], REF);
    fake.answers['POST ai'] = () => refusal(status, code);
    const box = await section();
    fireEvent.click(within(box).getByRole('button', { name: 'Let TownwiseAI read this file' }));
    expect(await within(box).findByText(line)).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Let TownwiseAI read this file' })).toBeTruthy();
  });
});

describe('while TownwiseAI reads', () => {
  test('the item is read again every 3 seconds until the read is done, then says so and stops', async () => {
    jest.useFakeTimers();
    const fake = setup([stored({ ai: aiOf({ status: 'queued', kind: null }) })], REF);
    spyGets(fake);
    const box = await section();
    expect(within(box).getByText('TownwiseAI is reading this file. It’s next in line, and this page updates when it’s done.')).toBeTruthy();
    // The page's own first read is counted too.
    const first = gets(fake, REF);
    const item = fake.items[0];
    if (item === undefined) throw new Error('no item');

    item.ai = aiOf({ status: 'reading', kind: null });
    await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
    expect(await within(box).findByText('TownwiseAI is reading this file. This can take a few minutes, and this page updates when it’s done.')).toBeTruthy();
    expect(gets(fake, REF) - first).toBe(1);

    item.ai = aiOf({ status: 'done', kind: 'calendar', summary: 'Events in June.' });
    await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
    expect(await within(box).findByText('TownwiseAI finished reading this file.')).toBeTruthy();
    expect(within(box).getByText('TownwiseAI read this file as a calendar of events.')).toBeTruthy();
    expect(gets(fake, REF) - first).toBe(2);

    await act(async () => { await jest.advanceTimersByTimeAsync(9000); });
    expect(gets(fake, REF) - first).toBe(2);
  });

  test('leaving the page stops reading it again', async () => {
    jest.useFakeTimers();
    const fake = setup([stored({ ai: aiOf({ status: 'reading', kind: null }) })], REF);
    spyGets(fake);
    await section();
    const first = gets(fake, REF);
    cleanup();
    await act(async () => { await jest.advanceTimersByTimeAsync(9000); });
    expect(gets(fake, REF)).toBe(first);
  });
});

describe('a done read', () => {
  const DONE = aiOf({
    kind: 'calendar', summary: 'Two private events and a closure in June.', facts: ['The back room seats 40', 'Closed for a floor repair'],
    notes: [
      { id: 'n1', title: 'Wedding dinner', startDate: '2026-06-14', endDate: '2026-06-14' },
      { id: 'n2', title: 'Closed for the floor', startDate: '2026-07-01', endDate: '2026-07-02' },
    ],
    daysWritten: 3, uploadRef: UPLOAD, itemRef: SUMMARY, calibration: { status: 'started', id: 'c1' }, canUndo: true,
  });

  test('shows what TownwiseAI found and what it added, each with its link', async () => {
    setup([stored({ ai: DONE })], REF);
    const box = await section();
    expect(within(box).getByText('TownwiseAI read this file as a calendar of events.')).toBeTruthy();
    expect(within(box).getByText('Two private events and a closure in June.')).toBeTruthy();
    const facts = within(box).getByRole('list', { name: 'What it found' });
    expect(within(facts).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['The back room seats 40', 'Closed for a floor repair']);
    expect(within(box).getByText('It added 2 notes to Notes:')).toBeTruthy();
    const notes = within(box).getByRole('list', { name: 'Notes TownwiseAI added' });
    expect(within(notes).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Wedding dinner, Jun 14, 2026', 'Closed for the floor, Jul 1, 2026 to Jul 2, 2026',
    ]);
    expect(within(box).getByRole('link', { name: 'Open Notes' }).getAttribute('href')).toBe('/locations/l1/notes');
    expect(within(box).getByText('It added 3 days of sales.')).toBeTruthy();
    expect(within(box).getByRole('link', { name: 'Open the days' }).getAttribute('href')).toBe(`/locations/l1/data/${UPLOAD}`);
    expect(within(box).getByText('It kept a summary on Your data that TownwiseAI can read later.')).toBeTruthy();
    expect(within(box).getByRole('link', { name: 'Open the summary' }).getAttribute('href')).toBe(`/locations/l1/data/${SUMMARY}`);
    expect(within(box).getByText('Started updating the forecast. It goes live once Townwise turns forecasts on for you.')).toBeTruthy();
    expect(within(box).queryByText(/read only the start/)).toBeNull();
    expect(within(box).queryByRole('button', { name: 'Let TownwiseAI read this file' })).toBeNull();
    // A done read is not announced as finished unless the page saw it running.
    expect(within(box).queryByText('TownwiseAI finished reading this file.')).toBeNull();
  });

  test.each<[string, Partial<ReturnType<typeof aiOf>>, string[]]>([
    ['no notes, days not verified, storage full, not an admin, partial', {
      kind: 'sales', daysReason: 'days_not_verified', itemReason: 'storage_full', calibration: { status: 'not_admin', id: null }, partial: true,
    }, [
      'TownwiseAI read this file as sales figures.',
      'It added no notes.',
      'It added no sales days: too few of the dates and figures it read could be found in the file’s own text. To add them yourself, use Upload sales history.',
      'It kept no summary: your organization’s file storage is full.',
      'An org admin can update the forecast from this.',
      'This file was too long to read whole, so TownwiseAI read only the start of it.',
    ]],
    ['a picture, no summary, not enough history', {
      kind: 'menu', daysReason: 'picture', itemReason: 'no_summary', calibration: { status: 'not_enough_history', id: null },
    }, [
      'TownwiseAI read this file as a menu.',
      'It added no sales days: TownwiseAI doesn’t take days from a picture, because it can’t check the figures against the file’s text. To add them yourself, use Upload sales history.',
      'It kept no summary: it found nothing to summarize.',
      'The forecast wasn’t updated: it needs at least 595 days from the first to the last day of sales history.',
    ]],
    ['codes the page doesn’t know read as the general line', {
      kind: 'recipes', daysReason: 'newer_reason', itemReason: 'newer_reason', calibration: { status: 'newer_status', id: null },
    }, [
      'TownwiseAI read this file as something other than sales, events, inventory, a menu or a schedule.',
      'It added no sales days.',
      'It kept no summary.',
      'The forecast wasn’t updated.',
    ]],
    ['days and a summary that were deleted since', { kind: 'sales', daysWritten: 5, uploadRef: null, itemRef: null, itemReason: null }, [
      'It added 5 days of sales. That upload isn’t on Your data anymore.',
      'The summary it kept isn’t on Your data anymore.',
    ]],
    ['every day already there, the file longer than it reads, closed periods left out', {
      kind: 'sales', daysReason: 'already_had_days', daysAlreadyHad: 30, daysCut: true, notesSkipped: { guard: 2 },
    }, [
      'It added no sales days: you already have every day it found, and TownwiseAI never changes a day you already have.',
      'This file has daily totals for more dates than TownwiseAI reads at once, so it read the newest 1,500 of them.',
      'It left out 2 closed periods: TownwiseAI never closes more than 14 days in a row, or 31 days in all, from one file. If they’re right, add them in Notes.',
    ]],
  ])('says why it added nothing, in plain words: %s', async (_, ai, lines) => {
    setup([stored({ ai: aiOf(ai) })], REF);
    const box = await section();
    for (const line of lines) expect(within(box).getByText(line)).toBeTruthy();
    expect(within(box).queryByRole('link', { name: 'Open the days' })).toBeNull();
    expect(within(box).queryByRole('link', { name: 'Open the summary' })).toBeNull();
  });

  test('says the days it left as they were beside the days it added, and one closed period left out', async () => {
    setup([stored({ ai: aiOf({ kind: 'sales', daysWritten: 3, daysAlreadyHad: 1, uploadRef: UPLOAD, notesSkipped: { guard: 1 } }) })], REF);
    const box = await section();
    expect(within(box).getByText('It added 3 days of sales. It left 1 day you already had as it was.')).toBeTruthy();
    expect(within(box).getByText('It left out 1 closed period: TownwiseAI never closes more than 14 days in a row, or 31 days in all, from one file. If it’s right, add it in Notes.')).toBeTruthy();
    expect(within(box).queryByText(/newest 1,500/)).toBeNull();
  });

  test('Undo asks first, saying what goes and that a started forecast update keeps running, then removes it and says so', async () => {
    const fake = setup([stored({ ai: DONE })], REF);
    fake.answers['DELETE ai'] = () => {
      const item = fake.items[0];
      if (item === undefined) throw new Error('no item');
      item.canAiRead = true;
      item.ai = aiOf({ status: 'undone', kind: null });
      return { item: { ...item }, calibrationKept: 'c1' };
    };
    const box = await section();
    fireEvent.click(within(box).getByRole('button', { name: 'Undo what TownwiseAI added' }));
    const dialog = await screen.findByRole('dialog', { name: 'Undo what TownwiseAI added?' });
    expect(within(dialog).getByText('This deletes the 2 notes it added (even if someone edited them since), the sales upload it added, with the days it still holds, and its summary on Your data. The forecast update it started keeps running. The file stays on Your data, and you can let TownwiseAI read it again. This can’t be undone.')).toBeTruthy();
    expect(fake.ai).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(await within(box).findByText('Removed what TownwiseAI added from this file. The forecast update it started keeps running.')).toBeTruthy();
    expect(fake.ai).toEqual([{ method: 'DELETE', ref: REF, body: undefined }]);
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Undo what TownwiseAI added?' })).toBeNull(); });
    // Undone, it may be read again; the undone line gives way to the notice.
    expect(within(box).getByRole('button', { name: 'Let TownwiseAI read this file' })).toBeTruthy();
    expect(within(box).queryByText(/was undone/)).toBeNull();
  });

  test('Cancel leaves everything as it was', async () => {
    const fake = setup([stored({ ai: DONE })], REF);
    const box = await section();
    fireEvent.click(within(box).getByRole('button', { name: 'Undo what TownwiseAI added' }));
    const dialog = await screen.findByRole('dialog', { name: 'Undo what TownwiseAI added?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Undo what TownwiseAI added?' })).toBeNull(); });
    expect(fake.ai).toEqual([]);
  });

  test('an undo refused says why on the page', async () => {
    const fake = setup([stored({ ai: DONE })], REF);
    fake.answers['DELETE ai'] = () => refusal(400, 'nothing_to_undo');
    const box = await section();
    fireEvent.click(within(box).getByRole('button', { name: 'Undo what TownwiseAI added' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Undo what TownwiseAI added?' })).getByRole('button', { name: 'Undo' }));
    expect(await within(box).findByText('There’s nothing TownwiseAI added from this file left to undo.')).toBeTruthy();
  });
});

describe('a read that ended without an answer', () => {
  test.each<[string, string, string]>([
    ['skipped', 'budget_spent', 'TownwiseAI didn’t read this file: your organization’s TownwiseAI budget for reading files is spent for this month.'],
    ['skipped', 'too_large', 'TownwiseAI didn’t read this file: it’s bigger than TownwiseAI reads.'],
    ['skipped', 'encrypted', 'TownwiseAI didn’t read this file: it has a password.'],
    ['skipped', 'newer_reason', 'TownwiseAI didn’t read this file.'],
    ['failed', 'refused', 'TownwiseAI declined to read this file.'],
    ['failed', 'answer_too_long', 'TownwiseAI couldn’t finish reading this file: what it found was too long to write down. A shorter file, such as one year of sales, will work.'],
    ['skipped', 'requester_gone', 'TownwiseAI added nothing from this file: the person who asked is no longer on your team.'],
    ['failed', 'internal', 'TownwiseAI couldn’t read this file because something went wrong on Townwise’s side.'],
    ['undone', '', 'What TownwiseAI added from this file was undone. You can let it read the file again.'],
  ])('%s %s says why, and the button is back for someone who may ask', async (status, reason, line) => {
    setup([stored({ canAiRead: true, ai: aiOf({ status, reason: reason === '' ? null : reason, kind: null }) })], REF);
    const box = await section();
    expect(within(box).getByText(line)).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Let TownwiseAI read this file' })).toBeTruthy();
  });
});

test('a read that stopped part way says it may have added some, and offers Undo to the person who may', async () => {
  const fake = setup([stored({ canAiRead: true, ai: aiOf({ status: 'failed', reason: 'internal', kind: null, canUndo: true }) })], REF);
  fake.answers['DELETE ai'] = () => {
    const item = fake.items[0];
    if (item === undefined) throw new Error('no item');
    item.ai = aiOf({ status: 'undone', kind: null });
    return { item: { ...item }, calibrationKept: null };
  };
  const box = await section();
  expect(within(box).getByText('TownwiseAI couldn’t read this file because something went wrong on Townwise’s side.')).toBeTruthy();
  expect(within(box).getByText('TownwiseAI stopped before it finished, and may have added some notes, days or a summary first. You can undo what it added.')).toBeTruthy();
  fireEvent.click(within(box).getByRole('button', { name: 'Undo what TownwiseAI added' }));
  const dialog = await screen.findByRole('dialog', { name: 'Undo what TownwiseAI added?' });
  expect(within(dialog).getByText('This deletes what TownwiseAI added from this file. The file stays on Your data, and you can let TownwiseAI read it again. This can’t be undone.')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
  expect(await within(box).findByText('Removed what TownwiseAI added from this file.')).toBeTruthy();
  expect(fake.ai).toEqual([{ method: 'DELETE', ref: REF, body: undefined }]);
  cleanup();
  setup([stored({ canAiRead: true, ai: aiOf({ status: 'skipped', reason: 'budget_spent', kind: null, canUndo: false }) })], REF);
  expect(within(await section()).queryByRole('button', { name: 'Undo what TownwiseAI added' })).toBeNull();
});

test('view-as shows the statuses only: no summary, facts, titles or buttons', async () => {
  setup([stored({
    name: null, canAiRead: false, canTurnOff: false, canDelete: false,
    ai: aiOf({
      kind: 'calendar', summary: null, facts: null, notes: [{ id: 'n1', title: null, startDate: '2026-06-14', endDate: '2026-06-14' }],
      daysReason: 'not_sales', itemRef: SUMMARY, calibration: { status: 'not_admin', id: null }, canUndo: false,
    }),
  })], REF, viewAsMe(ACCESS.admin));
  const box = await section();
  expect(within(box).getByText('TownwiseAI read this file as a calendar of events.')).toBeTruthy();
  const notes = within(box).getByRole('list', { name: 'Notes TownwiseAI added' });
  expect(within(notes).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Jun 14, 2026']);
  expect(within(box).queryByRole('list', { name: 'What it found' })).toBeNull();
  expect(within(box).queryAllByRole('button')).toEqual([]);
});

test('an upload TownwiseAI made links to the file it was read from, with no section of its own', async () => {
  setup([dailyTotalsOf(UPLOAD, { via: 'townwise_ai', fromAiRead: REF })], UPLOAD);
  const link = await screen.findByRole('link', { name: 'Made by TownwiseAI from a file' });
  expect(link.getAttribute('href')).toBe(`/locations/l1/data/${REF}`);
  expect(screen.getByText('Daily totals · No file kept · Saved from TownwiseAI')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'TownwiseAI' })).toBeNull();
});
