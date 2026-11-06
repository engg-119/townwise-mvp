import { describe, expect, it } from 'vitest';

import { findHeader, guessesFor } from '../../src/files/parse/header.ts';

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

  it('guesses with the longer lists, earlier names first, normalized like the browser', () => {
    expect(guessesFor('guests', ['Net Sales', '#_of_guests', 'Covers'])).toEqual([2]);
    expect(guessesFor('netSales', ['NET   AMOUNT'])).toEqual([0]);
    expect(guessesFor('date', ['Order Date', 'Closed Date'])).toEqual([0]);
  });
});
