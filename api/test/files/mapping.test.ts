import { describe, expect, it } from 'vitest';

import type { ColumnProfile } from '../../src/files/parse/columns.ts';
import { decideMapping, decideMappingWithModel, decideRowMode, type FirstPass } from '../../src/files/parse/mapping.ts';

const profile = (kind: ColumnProfile['kind'], extra: Partial<ColumnProfile> = {}): ColumnProfile => ({
  name: '', kind, slashDates: false, order: null, mixedOrder: false, ...extra,
});

function pass(header: string[], kinds: ColumnProfile[], extra: Partial<FirstPass> = {}): FirstPass {
  return { header, headerRow: 1, profiles: kinds, locationColumn: null, locationValues: [], tooManyLocations: false, ...extra };
}

describe('mapping (spec 11A, the reader’s rules)', () => {
  it('maps a clear day-level file by rules', () => {
    const decision = decideMapping(pass(['Date', 'Guests', 'Net Sales'], [profile('dates'), profile('numbers'), profile('numbers')]), {}, 'Main');
    expect(decision).toEqual({
      kind: 'mapping',
      mapping: { date: 0, guests: 1, netSales: 2, location: null, locationValue: null, dateOrder: 'month_first' },
      decidedBy: { date: 'rules', dateOrder: null, guests: 'rules', netSales: 'rules', location: null },
    });
  });

  it('prefers business date over closed date, and asks when two columns share the best date name', () => {
    expect(decideMapping(pass(['Closed Date', 'Business Date', 'Covers'], [profile('dates'), profile('dates'), profile('numbers')]), {}, '')).toMatchObject({
      kind: 'mapping', mapping: { date: 1, guests: 2 },
    });
    expect(decideMapping(pass(['Date', 'date', 'Covers'], [profile('dates'), profile('dates'), profile('numbers')]), {}, '')).toMatchObject({
      kind: 'question', question: { kind: 'date_column', options: [{ id: 'col:0', label: 'Date' }, { id: 'col:1', label: 'date' }, { id: 'not_sure' }], suggested: 'col:0' },
    });
  });

  it('falls back to the one column of dates, asks between several, and keeps a table with none', () => {
    expect(decideMapping(pass(['When', 'Covers'], [profile('dates'), profile('numbers')]), {}, '')).toMatchObject({ kind: 'mapping', mapping: { date: 0 } });
    expect(decideMapping(pass(['Opened', 'Closed', 'Covers'], [profile('dates'), profile('dates'), profile('numbers')]), {}, ''))
      .toMatchObject({ kind: 'question', question: { kind: 'date_column', suggested: null } });
    expect(decideMapping(pass(['Name', 'Covers'], [profile('text'), profile('numbers')]), {}, '')).toEqual({ kind: 'kept', outcome: 'no_dates' });
  });

  it('asks the date order only when no cell proves it, and an answer settles it', () => {
    const slashed = pass(['Date', 'Covers'], [profile('dates', { slashDates: true }), profile('numbers')]);
    expect(decideMapping(slashed, {}, '')).toMatchObject({ kind: 'question', question: { kind: 'date_order' } });
    expect(decideMapping(slashed, { dateOrder: 'day_first' }, '')).toMatchObject({
      kind: 'mapping', mapping: { dateOrder: 'day_first' }, decidedBy: { dateOrder: 'you' },
    });
    const proven = pass(['Date', 'Covers'], [profile('dates', { slashDates: true, order: 'day_first' }), profile('numbers')]);
    expect(decideMapping(proven, {}, '')).toMatchObject({ kind: 'mapping', mapping: { dateOrder: 'day_first' }, decidedBy: { dateOrder: 'rules' } });
  });

  it('asks for guests and net sales among the number columns, and keeps a dated table with no numbers as notes', () => {
    expect(decideMapping(pass(['Date', 'Amount', 'People'], [profile('dates'), profile('numbers'), profile('numbers')]), {}, '')).toMatchObject({
      kind: 'question',
      question: {
        kind: 'columns',
        options: [
          { id: 'guests:1', label: 'Amount' }, { id: 'guests:2', label: 'People' }, { id: 'guests:none' },
          { id: 'netSales:1', label: 'Amount' }, { id: 'netSales:2', label: 'People' }, { id: 'netSales:none' }, { id: 'not_sure' },
        ],
      },
    });
    expect(decideMapping(pass(['Date', 'Amount', 'People'], [profile('dates'), profile('numbers'), profile('numbers')]), { guests: 2, netSales: 1 }, ''))
      .toMatchObject({ kind: 'mapping', mapping: { guests: 2, netSales: 1 }, decidedBy: { guests: 'you', netSales: 'you' } });
    expect(decideMapping(pass(['Date', 'Note'], [profile('dates'), profile('text')]), {}, '')).toEqual({ kind: 'kept', outcome: 'notes_not_read_yet' });
  });

  it('matches the location by name, ignores a single value, asks otherwise, and keeps more than 50', () => {
    const located = (values: string[], tooMany = false) => pass(
      ['Date', 'Location', 'Guests'], [profile('dates'), profile('text'), profile('numbers')],
      { locationColumn: 1, locationValues: values, tooManyLocations: tooMany },
    );
    expect(decideMapping(located(['Elm', 'Main Street']), {}, ' main street ')).toMatchObject({
      kind: 'mapping', mapping: { location: 1, locationValue: 'Main Street' }, decidedBy: { location: 'rules' },
    });
    expect(decideMapping(located(['Only']), {}, 'Main')).toMatchObject({ kind: 'mapping', mapping: { location: null } });
    expect(decideMapping(located(['North', 'South']), {}, 'Main')).toMatchObject({
      kind: 'question', question: { kind: 'location_value', options: [{ id: 'loc:0', label: 'North' }, { id: 'loc:1', label: 'South' }, { id: 'not_sure' }] },
    });
    expect(decideMapping(located(['North', 'South']), { locationValue: 'South' }, 'Main')).toMatchObject({ kind: 'mapping', mapping: { locationValue: 'South' } });
    expect(decideMapping(located([], true), {}, 'Main')).toEqual({ kind: 'kept', outcome: 'too_many_locations' });
  });

  it('tells the row mode from repeated dates and the headers, unless the person said', () => {
    expect(decideRowMode(0, ['Date', 'Guests'], undefined)).toEqual({ kind: 'mode', rowMode: 'day', by: 'rules' });
    expect(decideRowMode(3, ['Date', 'Check #', 'Guests'], undefined)).toEqual({ kind: 'mode', rowMode: 'check', by: 'rules' });
    expect(decideRowMode(3, ['Date', 'Check #', 'Menu Item'], undefined)).toEqual({ kind: 'kept', outcome: 'item_level' });
    expect(decideRowMode(3, ['Date', 'Guests'], undefined)).toMatchObject({ kind: 'question', question: { kind: 'row_mode' } });
    expect(decideRowMode(3, ['Date', 'Guests'], 'check')).toEqual({ kind: 'mode', rowMode: 'check', by: 'you' });
    expect(decideRowMode(3, ['Date', 'Guests'], 'day')).toEqual({ kind: 'kept', outcome: 'repeated_dates' });
    expect(decideRowMode(0, ['Date', 'Guests'], 'item')).toEqual({ kind: 'kept', outcome: 'item_level' });
  });

  describe('the AI column step', () => {
    const unclear = pass(['Business Date', 'Total A', 'Total B', 'Note'], [profile('dates'), profile('numbers'), profile('numbers'), profile('text')]);

    it('applies a confident choice of number columns, marked ai', async () => {
      const decision = await decideMappingWithModel(unclear, {}, 'Main', () => Promise.resolve({ guests: 1, netSales: 2, confidence: 'high' }));
      expect(decision).toMatchObject({ kind: 'mapping', mapping: { guests: 1, netSales: 2 }, decidedBy: { guests: 'ai', netSales: 'ai', date: 'rules' } });
    });

    it('suggests an unsure choice in the question, and ignores a choice of a column that is not numbers', async () => {
      expect(await decideMappingWithModel(unclear, {}, 'Main', () => Promise.resolve({ guests: 1, netSales: null, confidence: 'low' })))
        .toMatchObject({ kind: 'question', question: { kind: 'columns', suggested: 'guests:1,netSales:none' } });
      expect(await decideMappingWithModel(unclear, {}, 'Main', () => Promise.resolve({ guests: 3, netSales: null, confidence: 'high' })))
        .toMatchObject({ kind: 'question', question: { kind: 'columns', suggested: null } });
      expect(await decideMappingWithModel(unclear, {}, 'Main', () => Promise.resolve(null))).toMatchObject({ kind: 'question', question: { kind: 'columns' } });
    });

    it('is never asked when the rules decide, or when the person already answered', async () => {
      let asked = 0;
      const choose = () => { asked += 1; return Promise.resolve(null); };
      await decideMappingWithModel(pass(['Date', 'Guests'], [profile('dates'), profile('numbers')]), {}, 'Main', choose);
      expect(await decideMappingWithModel(unclear, { guests: 2, netSales: null }, 'Main', choose))
        .toMatchObject({ kind: 'mapping', decidedBy: { guests: 'you' } });
      expect(asked).toBe(0);
    });
  });
});
