import { ApiError } from '../../../src/api/client';
import { KEPT_CODES } from '../../../src/portal/files/api';
import { DATA_STATES, DATA_VIAS } from '../../../src/portal/data/api';
import { rowAiLine, settledLine } from '../../../src/portal/data/aiCopy';
import * as copy from '../../../src/portal/data/copy';
import { bookingsStateLine, emptyFilterLine, sortedLines } from '../../../src/portal/data/item/bookingWords';
import { dailyTotalsOf, itemOf } from './fakes';

// Every state and way an item arrived has words, and each refusal an action can get says what to do.

function refused(status: number, code: string | null): ApiError {
  return new ApiError('http', 'refused', { status, code, retryAfterSeconds: null });
}

test('every state has a status line, and a kept item says why', () => {
  for (const state of DATA_STATES) expect(copy.stateLine({ state, outcome: null }).length).toBeGreaterThan(0);
  expect(copy.stateLine({ state: 'kept', outcome: 'reference' })).toBe('Kept for reference');
  expect(copy.stateLine({ state: 'kept', outcome: 'old_excel' })).toMatch(/^Kept, not used: Townwise can’t read old Excel files yet/);
  expect(copy.stateLine({ state: 'kept', outcome: 'a_code_from_later' })).toBe('Kept, not used');
  for (const code of KEPT_CODES) expect(copy.stateLine({ state: 'kept', outcome: code }).length).toBeGreaterThan(0);
  expect(copy.stateLine({ state: 'failed', outcome: null })).toBe('Couldn’t read it');
  expect(copy.stateLine({ state: 'not_finished', outcome: null })).toBe('Didn’t finish');
  expect(copy.stateLine({ state: 'waiting', outcome: null })).toBe('Waiting for an answer');
});

test('a calendar export says it was kept for Your calendars, and TownwiseAI skipping it says the same (D58)', () => {
  expect(KEPT_CODES).toContain('calendar_export');
  expect(copy.stateLine({ state: 'kept', outcome: 'calendar_export' }))
    .toBe('Kept, not used: it’s a calendar export. Import it in Your calendars to see its events and let TownwiseAI read them all.');
  expect(settledLine({ status: 'skipped', reason: 'calendar_export' }))
    .toBe('TownwiseAI didn’t read this file: it’s a calendar export. Import it in Your calendars instead.');
});

test('a file calendar’s bookings state, a sort with nothing to send, and an empty filter have words (D58)', () => {
  expect(bookingsStateLine({ state: 'unsorted', confirmedAt: null })).toBe('Not sorted yet, and not used for forecasts.');
  expect(bookingsStateLine({ state: 'a_state_from_later', confirmedAt: null })).toBe('Not sorted yet, and not used for forecasts.');
  expect(bookingsStateLine({ state: 'confirmed', confirmedAt: null })).toBe('Used for forecasts.');
  expect(sortedLines({ sent: 0, labeled: 0, batchesFailed: 0 })).toEqual(['Every event already has a label.']);
  expect(sortedLines({ sent: 250, labeled: 240, batchesFailed: 0 })).toEqual(['TownwiseAI labeled 240 of 250 events.']);
  expect(emptyFilterLine('none', '2026-11')).toBe('No events without a label in November 2026.');
  expect(emptyFilterLine('party', '2026-11')).toBe('No events labeled Party in November 2026.');
});

test('a row’s Status names what TownwiseAI did with its file, and nothing without a read, once undone or for a later status (D34)', () => {
  expect(rowAiLine(null)).toBeNull();
  expect(rowAiLine({ status: 'queued' })).toBe('TownwiseAI is reading it');
  expect(rowAiLine({ status: 'reading' })).toBe('TownwiseAI is reading it');
  expect(rowAiLine({ status: 'done' })).toBe('Read by TownwiseAI');
  expect(rowAiLine({ status: 'failed' })).toBe('TownwiseAI couldn’t read it');
  expect(rowAiLine({ status: 'skipped' })).toBe('TownwiseAI didn’t read it');
  expect(rowAiLine({ status: 'undone' })).toBeNull();
  expect(rowAiLine({ status: 'a_status_from_later' })).toBeNull();
  expect(rowAiLine({ status: 'constructor' })).toBeNull();
});

test('every way an item arrived has its line', () => {
  expect(DATA_VIAS.map((via) => copy.VIA_LINE[via])).toEqual([
    'Sent from a browser', 'Read by Townwise', 'Added by Townwise staff', 'Saved from TownwiseAI',
  ]);
});

test('the item reads as its name, else its kind with its days or when it was added; the row prints the kind', () => {
  expect(copy.itemName(itemOf('f_1', { name: 'menu.pdf', kind: 'pdf' }))).toBe('menu.pdf');
  // No name (a browser upload, or any item under view-as): the kind with its days, else with when it was added.
  expect(copy.itemName(dailyTotalsOf('u_1'))).toBe('Daily totals, May 1, 2026 to May 10, 2026');
  expect(copy.itemName(itemOf('f_1', { name: null, kind: 'pdf' }))).toBe('PDF, added Nov 5, 2026');
  // The row itself still prints the kind.
  expect(copy.shownName(dailyTotalsOf('u_1'))).toBe('Daily totals');
  expect(copy.shownName(itemOf('f_1', { name: null, kind: 'pdf' }))).toBe('PDF');
  expect(copy.daysLine(null)).toBe('None');
});

test('each refusal an action can get has this page’s words', () => {
  expect(copy.dataError(refused(403, 'forbidden'))).toBe('Only the person who added it or an org admin can do that.');
  expect(copy.dataError(refused(409, 'item_busy'))).toBe('Townwise is still reading this file. Try again when it’s done.');
  expect(copy.dataError(refused(409, 'file_busy'))).toBe('Townwise is still reading this file. Try again when it’s done.');
  expect(copy.dataError(refused(503, 'files_unavailable'))).toBe('File storage is off right now, so this can’t be done.');
  expect(copy.dataError(refused(404, 'not_found'))).toBe('This item isn’t available anymore.');
  expect(copy.dataError(refused(500, null))).toBe('Something went wrong on our side. Try again in a minute.');
});

test('no line carries an em dash or an exclamation mark', () => {
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
    return [];
  };
  for (const line of [...strings(copy.DATA), ...strings(copy.VIA_LINE), ...strings(copy.COLUMNS)]) {
    expect(line).not.toMatch(/[—!]/);
  }
});
