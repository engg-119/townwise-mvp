// A ZIP's tables as families (spec 11A): one mapping and one aggregator per header, ranked so two report types never
// add the same days twice, and reports that hold no sales kept without a question.
import { describe, expect, it } from 'vitest';

import { familyKey, familySignature, readFamilies, type TableSource } from '../../src/files/parse/families.ts';

function table(rows: string[][]): TableSource {
  return { delimiter: () => ',', visit: (visit) => { for (const row of rows) visit(row); return Promise.resolve(); } };
}

const input = { answers: {}, locationName: 'Main', latest: '2026-06-02' } as const;
const DAY = ['Business Date', 'Guests', 'Net Sales'];
const CHECKS = ['Business Date', 'Check #', 'Guests', 'Net Sales'];

describe('families', () => {
  it('adds up check rows of one date split across daily files, with one aggregator for the family', async () => {
    const outcome = await readFamilies([
      table([CHECKS, ['2025-01-01', '1', '2', '20.00'], ['2025-01-01', '2', '3', '30.00']]),
      table([CHECKS, ['2025-01-01', '3', '4', '40.00'], ['2025-01-02', '4', '1', '10.00']]),
    ], input);
    expect(outcome).toMatchObject({
      kind: 'done',
      days: [{ date: '2025-01-01', guests: 9, netSalesCents: 9000 }, { date: '2025-01-02', guests: 1, netSalesCents: 1000 }],
      report: { rowMode: 'check', days: 2, rows: 4 },
      families: [{ label: CHECKS, entries: 2, used: true, rowMode: 'check', dayCount: 2, why: 'sales' }],
    });
  });

  it('uses only the higher-ranked of two report types on the same dates: day-level before check-level', async () => {
    const outcome = await readFamilies([
      table([CHECKS, ['2025-01-01', '1', '2', '20.00'], ['2025-01-01', '2', '3', '30.00']]),
      table([DAY, ['2025-01-01', '5', '50.00']]),
    ], input);
    expect(outcome).toMatchObject({ kind: 'done', days: [{ date: '2025-01-01', guests: 5 }] });
    if (outcome.kind !== 'done') return;
    expect(outcome.fates).toEqual([
      { used: false, outcome: 'other_table_used', family: familySignature(CHECKS) },
      { used: true, outcome: null, family: familySignature(DAY) },
    ]);
  });

  it('counts an old and a new export format that cover different years', async () => {
    const outcome = await readFamilies([
      table([['Date', 'Covers', 'Net'], ['2023-05-01', '7', '70']]),
      table([DAY, ['2025-05-01', '8', '80.00']]),
    ], input);
    expect(outcome).toMatchObject({ kind: 'done', days: [{ date: '2023-05-01', guests: 7 }, { date: '2025-05-01', guests: 8 }] });
  });

  it('keeps an item-level family and a family with no sales columns, and asks nothing', async () => {
    const outcome = await readFamilies([
      table([DAY, ['2025-01-01', '5', '50.00']]),
      table([['Business Date', 'Menu Item', 'Qty', 'Guests'], ['2025-01-02', 'Fries', '1', '1'], ['2025-01-02', 'Soup', '1', '1']]),
      table([['Business Date', 'Payment Type', 'Amount'], ['2025-01-01', 'Card', '50.00']]),
    ], input);
    expect(outcome).toMatchObject({ kind: 'done', days: [{ date: '2025-01-01', guests: 5 }] });
    if (outcome.kind !== 'done') return;
    expect(outcome.fates.map((fate) => fate.outcome)).toEqual([null, 'item_level', 'no_sales_columns']);
  });

  it('asks about a family by its label, and reads the answer under the family’s key', async () => {
    const header = ['Business Date', 'Total A', 'Total B'];
    const tables = [table([header, ['2025-01-01', '5', '50.00']])];
    const asked = await readFamilies(tables, input);
    expect(asked).toMatchObject({
      kind: 'question',
      question: { kind: 'columns', family: familySignature(header), familyLabel: 'Business Date, Total A, Total B' },
    });
    const answered = await readFamilies(tables, { ...input, answers: { [familyKey(familySignature(header))]: { guests: 1, netSales: 2 } } });
    expect(answered).toMatchObject({ kind: 'done', days: [{ date: '2025-01-01', guests: 5, netSalesCents: 5000 }] });
  });

  it('proves a slash date order over every table of the family together', async () => {
    const header = ['Date', 'Guests'];
    const outcome = await readFamilies([table([header, ['03/04/2025', '1']]), table([header, ['13/04/2025', '2']])], input);
    expect(outcome).toMatchObject({ kind: 'done', days: [{ date: '2025-04-03' }, { date: '2025-04-13' }] });
  });
});
