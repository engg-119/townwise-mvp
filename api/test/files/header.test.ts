import { describe, expect, it } from 'vitest';

import { Readable } from 'node:stream';

import { findHeader, guessesFor } from '../../src/files/parse/header.ts';
import { runParse } from '../../src/files/parse/run.ts';
import { FirstPassReader } from '../../src/files/parse/table.ts';

/** A calendar export's header among other columns, as the owner's tool writes it, and two made-up rows. */
const CALENDAR_EXPORT = [
  ['calendar_id', 'Event_ID', 'title', 'description', 'start_at', 'end_at', 'timezone', 'status'],
  ['made-up@group.example.test', 'e1', 'Spring reunion', 'Call first', '2025-04-12T18:00:00-04:00', '2025-04-12T22:00:00-04:00', 'America/New_York', 'confirmed'],
  ['made-up@group.example.test', 'e2', 'Trivia', '', '2025-04-15T19:00:00-04:00', '2025-04-15T21:00:00-04:00', 'America/New_York', 'confirmed'],
];

function firstPass(records: readonly (readonly string[])[], text: boolean): ReturnType<FirstPassReader['finish']> {
  const reader = new FirstPassReader(undefined, { text });
  for (const record of records) reader.add(record);
  return reader.finish();
}

describe('header row (spec 11A)', () => {
  it('is row 1 of a plain table, below a title block otherwise, and prefers a row that names a date', () => {
    expect(findHeader([['Date', 'Guests'], ['2025-01-01', '1']])).toEqual({ kind: 'found', index: 0 });
    expect(findHeader([['Daily sales'], [''], ['Report', 'January'], ['Business Date', 'Guests'], ['2025-01-01', '1']]))
      .toEqual({ kind: 'found', index: 3 });
    expect(findHeader([['Store', 'Region'], ['Main', 'East']])).toEqual({ kind: 'found', index: 0 });
  });

  it('says when no row could be a header, and when nothing is a table', () => {
    expect(findHeader([['2025-01-01', '10'], ['2025-01-02', '11']])).toEqual({ kind: 'no_header' });
    expect(findHeader([['just one cell'], ['another']])).toEqual({ kind: 'not_a_table' });
  });

  it('keeps a text table with a calendar export’s header calendar_export, never read for sales (D58)', async () => {
    expect(firstPass(CALENDAR_EXPORT, true)).toEqual({ kind: 'kept', outcome: 'calendar_export' });
    // Only a text table (a CSV, or a ZIP's text entry) is a calendar export: Your calendars imports .ics and CSV only.
    expect(firstPass(CALENDAR_EXPORT, false)).toMatchObject({ headerRow: 1 });
    // A sales export with a title column is still a sales table.
    expect(firstPass([['Date', 'Title', 'Guests', 'Net Sales'], ['2025-01-01', 'Friday', '120', '2400.00']], true)).toMatchObject({ headerRow: 1 });
    // Missing end_at: not the profile.
    expect(firstPass(CALENDAR_EXPORT.map((row) => row.slice(0, 5)), true)).not.toEqual({ kind: 'kept', outcome: 'calendar_export' });
    // The stored file's whole read: kept, with no question and no days.
    const text = Buffer.from(CALENDAR_EXPORT.map((row) => row.join(',')).join('\r\n'));
    expect(await runParse({
      answers: {}, locationName: 'Main', latest: '2026-06-02', replace: true, onProgress: () => undefined, kind: 'text', sizeBytes: text.length,
      open: () => Promise.resolve(Readable.from([text])),
    })).toEqual({ kind: 'kept', outcome: 'calendar_export', report: null });
  });

  it('guesses with the longer lists, earlier names first, normalized like the browser', () => {
    expect(guessesFor('guests', ['Net Sales', '#_of_guests', 'Covers'])).toEqual([2]);
    expect(guessesFor('netSales', ['NET   AMOUNT'])).toEqual([0]);
    expect(guessesFor('date', ['Order Date', 'Closed Date'])).toEqual([0]);
  });
});
