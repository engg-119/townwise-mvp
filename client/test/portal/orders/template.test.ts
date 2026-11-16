import type { OrderSetup, SetupRead, SetupReadItem } from '../../../src/portal/orders/api';
import { importProposal, problemLine, proposalSummary, pruneMarks, withMarks } from '../../../src/portal/orders/proposal';
import {
  checkDraft, draftOf, fieldId, newItem, newSupplier, parseServings, parseTime, SETUP_COPY, type SetupDraft,
} from '../../../src/portal/orders/setupDraft';
import { importSheet, parsePosNames, TEMPLATE_COLUMNS, templateCsv } from '../../../src/portal/orders/template';
import { parseCsv } from '../../../src/portal/upload/csv';

// The ordering template, the sheet import and the setup draft's checks (the order-setup spec; the server's limits in
// api/src/orders/setup.ts). Every supplier and item here is synthetic.

const SAVED: OrderSetup = {
  version: 3,
  updatedAt: '2026-11-10T15:00:00.000Z',
  suppliers: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaa1', name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
  items: [{
    id: 'bbbbbbbbbbbbbbbbbbbbbbb1', name: 'Sample Lager', supplierId: 'aaaaaaaaaaaaaaaaaaaaaaa1', category: 'bottles_cans', unit: 'cases',
    servingsPerUnit: 24, par: 2, dealSize: 5, neverRunOut: false, posNames: [{ name: 'Lager Can', perSale: 1 }],
  }],
};

function rowsOf(csv: string): { header: string[]; rows: { row: number; cells: string[] }[] } {
  const [header = [], ...rest] = parseCsv(csv);
  return { header, rows: rest.map((cells, index) => ({ row: index + 2, cells })) };
}

describe('the template', () => {
  test('the header, then two rows that read as examples, with point-of-sale names split by semicolons and an x suffix', () => {
    const [header, ...examples] = parseCsv(templateCsv());
    expect(header).toEqual([...TEMPLATE_COLUMNS]);
    expect(examples.filter((row) => row.some((cell) => cell !== ''))).toHaveLength(2);
    for (const row of examples.filter((cells) => cells.length > 1)) expect(row[0]).toMatch(/^Example .*\(delete this row\)$/);
    expect(templateCsv()).toContain('Example IPA Pint;Example IPA Pitcher x4');
  });

  test('importing the template unchanged adds nothing and says the examples were skipped', () => {
    const { header, rows } = rowsOf(templateCsv());
    const outcome = importSheet(header, rows, draftOf(null));
    expect(outcome).toMatchObject({ ok: true, result: { added: 0, replaced: 0, examplesSkipped: 2, problems: [] } });
  });
});

describe('point-of-sale names', () => {
  test('semicolons between names; an xN suffix is servings per sale, else 1', () => {
    expect(parsePosNames('Lager Pint; Lager Pitcher x4 ;;IPA Pint X 2;Flight x0.5')).toEqual({
      names: [{ name: 'Lager Pint', perSale: '1' }, { name: 'Lager Pitcher', perSale: '4' }, { name: 'IPA Pint', perSale: '2' }, { name: 'Flight', perSale: '0.5' }],
    });
    expect(parsePosNames('Vodka Soda X Large')).toEqual({ names: [{ name: 'Vodka Soda X Large', perSale: '1' }] });
    expect(parsePosNames('')).toEqual({ names: [] });
    expect(parsePosNames('Lager x60')).toHaveProperty('problem');
    expect(parsePosNames('Lager Pint;lager  pint')).toHaveProperty('problem');
    expect(parsePosNames(Array.from({ length: 11 }, (_, i) => `Name ${String(i)}`).join(';'))).toHaveProperty('problem');
  });
});

describe('importing a sheet', () => {
  const SHEET = [
    'ITEM,supplier,Category,unit,Servings_per_unit,PAR,Deal Size,Never-run-out,Point of sale names',
    'Sample Lager,sample distributor,Bottles and cans,case,24,3,,yes,Lager Can;Lager Bucket x5',
    'Sample IPA,New Brewery,draft,kegs,124,1,,no,IPA Pint;IPA Pitcher x4',
    'Sample Gin,New Spirits,Liquor,bottles,17,2,6,,Gin Pour',
    'Bad Row,New Spirits,Wine,crates,0,1000,0,maybe,',
    'sample ipa,New Brewery,Draft,kegs,124,1,,no,',
    ',,,,,,,,',
  ].join('\n');

  test('merges by item name: replaces a matching item (keeping its id), adds the rest, creates named suppliers, lists failing rows', () => {
    const { header, rows } = rowsOf(SHEET);
    const outcome = importSheet(header, rows, draftOf(SAVED));
    if (!outcome.ok) throw new Error('import refused');
    const { result } = outcome;
    expect(result).toMatchObject({ added: 2, replaced: 1, newSuppliers: ['New Brewery', 'New Spirits'], examplesSkipped: 0 });
    expect(result.problems).toEqual([
      {
        row: 5, item: 'Bad Row',
        reason: 'Category: use Bottles and cans, Draft, Liquor or Cocktail ingredient. Unit: use cases, kegs, bottles or units. '
          + 'Servings per unit: enter a number from 0.1 to 2,000. Par: enter a whole number from 0 to 999. '
          + 'Deal size: leave it empty, or enter a whole number from 1 to 999. Never run out: use yes or no.',
      },
      { row: 6, item: 'sample ipa', reason: 'This item is already on row 3.' },
    ]);
    const { draft } = result;
    expect(draft.suppliers.map((supplier) => [supplier.name, supplier.id === null, supplier.deliveries.length])).toEqual([
      ['Sample Distributor', false, 1], ['New Brewery', true, 0], ['New Spirits', true, 0],
    ]);
    const lager = draft.items[0];
    // Its Deal size cell is blank, so it keeps the 5 it had (#68 review C1).
    expect(lager).toMatchObject({
      id: 'bbbbbbbbbbbbbbbbbbbbbbb1', name: 'Sample Lager', supplierKey: 'aaaaaaaaaaaaaaaaaaaaaaa1', category: 'bottles_cans', unit: 'cases',
      servingsPerUnit: '24', par: '3', dealSize: '5', neverRunOut: true,
      posNames: [{ name: 'Lager Can', perSale: '1' }, { name: 'Lager Bucket', perSale: '5' }],
    });
    expect(result.kept).toEqual([{ item: 'Sample Lager', fields: ['deal size'] }]);
    expect(draft.items.map((each) => [each.name, each.id, draft.suppliers.find((s) => s.key === each.supplierKey)?.name])).toEqual([
      ['Sample Lager', 'bbbbbbbbbbbbbbbbbbbbbbb1', 'Sample Distributor'], ['Sample IPA', null, 'New Brewery'], ['Sample Gin', null, 'New Spirits'],
    ]);
    // New suppliers still need their deliveries before the setup saves.
    const check = checkDraft(draft);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems[fieldId.supplier(draft.suppliers[1]?.key ?? '', 'deliveries')]).toEqual([SETUP_COPY.noDelivery]);
  });

  // #68 review C1: a blank optional cell, or a sheet without that column, would otherwise wipe a replaced item's
  // point-of-sale names (so item sales stop matching it), its deal size and its never run out.
  test('a replaced item keeps the point-of-sale names, deal size and never run out the sheet leaves blank or leaves out', () => {
    const kept = {
      ...SAVED,
      items: [{ ...SAVED.items[0], dealSize: 5, neverRunOut: true, posNames: [{ name: 'Lager Can', perSale: 1 }, { name: 'Lager Bucket', perSale: 5 }] }],
    } as OrderSetup;
    const blank = rowsOf([
      [...TEMPLATE_COLUMNS].join(','),
      'Sample Lager,Sample Distributor,Bottles and cans,cases,24,4,, ,',
      'Sample Stout,Sample Distributor,Draft,kegs,124,1,,,',
    ].join('\n'));
    const outcome = importSheet(blank.header, blank.rows, draftOf(kept));
    if (!outcome.ok) throw new Error('import refused');
    expect(outcome.result.draft.items[0]).toMatchObject({
      par: '4', dealSize: '5', neverRunOut: true, posNames: [{ name: 'Lager Can', perSale: '1' }, { name: 'Lager Bucket', perSale: '5' }],
    });
    // A new item has nothing to keep: no deal size, no point-of-sale names, not never run out.
    expect(outcome.result.draft.items[1]).toMatchObject({ name: 'Sample Stout', dealSize: '', neverRunOut: false, posNames: [] });
    expect(outcome.result.kept).toEqual([{ item: 'Sample Lager', fields: ['point-of-sale names', 'deal size', 'never run out'] }]);

    // Without the optional columns at all, the same.
    const required = rowsOf('Item,Supplier,Category,Unit,Servings per unit,Par\nSample Lager,Sample Distributor,Bottles and cans,cases,24,6');
    const short = importSheet(required.header, required.rows, draftOf(kept));
    if (!short.ok) throw new Error('import refused');
    expect(short.result.draft.items[0]).toMatchObject({ par: '6', dealSize: '5', neverRunOut: true });
    expect(short.result.draft.items[0]?.posNames).toHaveLength(2);
    expect(short.result.kept).toEqual([{ item: 'Sample Lager', fields: ['point-of-sale names', 'deal size', 'never run out'] }]);

    // A cell that says something replaces it: "no" turns never run out off, new names replace the old ones.
    const filled = rowsOf([
      [...TEMPLATE_COLUMNS].join(','),
      'Sample Lager,Sample Distributor,Bottles and cans,cases,24,4,2,no,Lager Draft Can',
    ].join('\n'));
    const replaced = importSheet(filled.header, filled.rows, draftOf(kept));
    if (!replaced.ok) throw new Error('import refused');
    expect(replaced.result.draft.items[0]).toMatchObject({ dealSize: '2', neverRunOut: false, posNames: [{ name: 'Lager Draft Can', perSale: '1' }] });
    expect(replaced.result.kept).toEqual([]);
  });

  test('a sheet without the required columns, or with no rows, is refused whole', () => {
    expect(importSheet(['Item', 'Supplier', 'Par'], [], draftOf(null))).toEqual({ ok: false, missing: ['Category', 'Unit', 'Servings per unit'] });
    expect(importSheet([...TEMPLATE_COLUMNS], [{ row: 2, cells: ['', ''] }], draftOf(null))).toEqual({ ok: false, empty: true });
  });

  test('the setup’s limits: 300 items, 20 suppliers', () => {
    const header = ['Item', 'Supplier', 'Category', 'Unit', 'Servings per unit', 'Par'];
    const row = (i: number, supplier: string): { row: number; cells: string[] } => ({ row: i + 2, cells: [`Item ${String(i)}`, supplier, 'Draft', 'kegs', '124', '1'] });
    const items = importSheet(header, Array.from({ length: 301 }, (_, i) => row(i, 'One supplier')), draftOf(null));
    if (!items.ok) throw new Error('import refused');
    expect(items.result.draft.items).toHaveLength(300);
    expect(items.result.problems).toEqual([{ row: 302, item: 'Item 300', reason: 'The setup holds up to 300 items.' }]);
    const suppliers = importSheet(header, Array.from({ length: 21 }, (_, i) => row(i, `Supplier ${String(i)}`)), draftOf(null));
    if (!suppliers.ok) throw new Error('import refused');
    expect(suppliers.result.draft.suppliers).toHaveLength(20);
    expect(suppliers.result.problems).toEqual([{ row: 22, item: 'Item 20', reason: 'The setup holds up to 20 suppliers.' }]);
  });
});

describe('the draft', () => {
  test('a stored setup round-trips: the stored ids, the same values', () => {
    const check = checkDraft(draftOf(SAVED));
    expect(check).toEqual({
      ok: true,
      input: {
        suppliers: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaa1', name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
        items: [{
          id: 'bbbbbbbbbbbbbbbbbbbbbbb1', name: 'Sample Lager', supplierId: 'aaaaaaaaaaaaaaaaaaaaaaa1', category: 'bottles_cans', unit: 'cases',
          servingsPerUnit: 24, par: 2, dealSize: 5, neverRunOut: false, posNames: [{ name: 'Lager Can', perSale: 1 }],
        }],
      },
    });
  });

  test('a new supplier is sent with its key, and its new items name it by that key', () => {
    const supplier = { ...newSupplier('  New Brewery '), deliveries: [{ deliveryWeekday: '2', cutoffWeekday: '1', cutoffTime: '9:30' }] };
    const item = {
      ...newItem(supplier.key), name: 'IPA', category: 'draft' as const, unit: 'kegs' as const, servingsPerUnit: '124', par: '1',
      posNames: [{ name: ' IPA Pint ', perSale: '' }],
    };
    const check = checkDraft({ suppliers: [supplier], items: [item] });
    expect(check).toEqual({
      ok: true,
      input: {
        suppliers: [{ key: supplier.key, name: 'New Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '09:30' }] }],
        items: [{
          name: 'IPA', supplierId: supplier.key, category: 'draft', unit: 'kegs', servingsPerUnit: 124, par: 1, dealSize: null,
          neverRunOut: false, posNames: [{ name: 'IPA Pint', perSale: 1 }],
        }],
      },
    });
    expect(supplier.key).not.toMatch(/^[0-9a-f]{24}$/);
    expect(supplier.key.length).toBeLessThanOrEqual(40);
  });

  test('every field the server would refuse is marked', () => {
    const supplier = { ...newSupplier(''), deliveries: [{ deliveryWeekday: '1', cutoffWeekday: '', cutoffTime: '25:00' }, { deliveryWeekday: '1', cutoffWeekday: '0', cutoffTime: '12:00' }] };
    const item = {
      ...newItem('gone'), name: 'x'.repeat(81), servingsPerUnit: '0', par: '1.5', dealSize: '0',
      posNames: [{ name: 'Pint', perSale: '51' }, { name: ' pint ', perSale: '1' }, { name: '', perSale: '1' }],
    };
    const draft: SetupDraft = { suppliers: [supplier], items: [item] };
    const check = checkDraft(draft);
    if (check.ok) throw new Error('accepted');
    expect(check.problems).toEqual({
      [fieldId.supplier(supplier.key, 'name')]: [SETUP_COPY.supplierName],
      [fieldId.delivery(supplier.key, 0, 'cutoff')]: [SETUP_COPY.cutoffDay],
      [fieldId.delivery(supplier.key, 0, 'time')]: [SETUP_COPY.cutoffTime],
      [fieldId.supplier(supplier.key, 'deliveries')]: [SETUP_COPY.sameDay],
      [fieldId.item(item.key, 'name')]: [SETUP_COPY.itemName],
      [fieldId.item(item.key, 'supplier')]: [SETUP_COPY.supplier],
      [fieldId.item(item.key, 'category')]: [SETUP_COPY.category],
      [fieldId.item(item.key, 'unit')]: [SETUP_COPY.unit],
      [fieldId.item(item.key, 'servings')]: [SETUP_COPY.servings],
      [fieldId.item(item.key, 'par')]: [SETUP_COPY.par],
      [fieldId.item(item.key, 'deal')]: [SETUP_COPY.dealSize],
      [fieldId.pos(item.key, 0, 'perSale')]: [SETUP_COPY.perSale],
      [fieldId.pos(item.key, 1, 'name')]: [SETUP_COPY.posTwice],
      [fieldId.pos(item.key, 2, 'name')]: [SETUP_COPY.posName],
    });
    expect(check.count).toBe(14);
  });

  test('servings per unit run from 0.1 to 2,000, as the server takes them (#68 review A11)', () => {
    expect(['0.1', '2000', '24', '.5'].map(parseServings)).toEqual([0.1, 2000, 24, 0.5]);
    for (const text of ['0', '0.05', '0.09', '2000.5', '', 'lots']) expect(parseServings(text)).toBeNull();
    expect(SETUP_COPY.servings).toBe('Enter a number from 0.1 to 2,000.');
  });

  test('order-by times are HH:MM, 24 hour', () => {
    expect(['14:00', '9:05', '00:00', '23:59'].map(parseTime)).toEqual(['14:00', '09:05', '00:00', '23:59']);
    for (const text of ['24:00', '2pm', '14:0', '14.00', '']) expect(parseTime(text)).toBeNull();
  });
});

// Reading the ordering setup with TownwiseAI (D41): its suggestions go through the sheet import's merge (merge.ts) with
// the same parsers. Every supplier and item here is synthetic.

function suggestion(name: string, fields: Partial<SetupReadItem> = {}): SetupReadItem {
  return {
    name, supplier: null, category: null, unit: null, servingsPerUnit: null, servingsEstimated: false, dealSize: null, posNames: [],
    note: '', inFile: true, ...fields,
  };
}

function readOf(items: SetupReadItem[], suppliers: SetupRead['suppliers'] = [], flags: Partial<Pick<SetupRead, 'itemsCut' | 'partial'>> = {}): SetupRead {
  return { kind: 'order_guide', confidence: 'high', suppliers, items, itemsCut: false, partial: false, ...flags };
}

describe('reading with TownwiseAI (D41)', () => {
  test('a new item keeps a blank par, category, unit, servings and supplier blank, so the checks name each at Save', () => {
    const result = importProposal(readOf([suggestion('Sample Stout')]), draftOf(null));
    expect(result).toMatchObject({ found: 1, added: 1, replaced: 0, problems: [] });
    const [stout] = result.draft.items;
    if (stout === undefined) throw new Error('no item');
    expect(stout).toMatchObject({ id: null, name: 'Sample Stout', supplierKey: '', category: '', unit: '', servingsPerUnit: '', par: '', neverRunOut: false, dealSize: '', posNames: [] });
    const check = checkDraft(result.draft);
    if (check.ok) throw new Error('accepted');
    for (const field of ['supplier', 'category', 'unit', 'servings', 'par'] as const) {
      expect(check.problems[fieldId.item(stout.key, field)]).toBeDefined();
    }
    expect(check.problems[fieldId.item(stout.key, 'par')]).toEqual([SETUP_COPY.par]);
  });

  test('a new item takes what TownwiseAI filled, but never a par or never run out', () => {
    const read = readOf([suggestion('Sample IPA', {
      supplier: 'New Brewery', category: 'draft', unit: 'kegs', servingsPerUnit: 124, servingsEstimated: true, dealSize: 2,
      posNames: [{ name: 'IPA Pint', perSale: 1 }, { name: 'IPA Pitcher', perSale: 4 }],
    })]);
    const result = importProposal(read, draftOf(null));
    expect(result.newSuppliers).toEqual(['New Brewery']);
    expect(result.draft.items[0]).toMatchObject({
      category: 'draft', unit: 'kegs', servingsPerUnit: '124', dealSize: '2', par: '', neverRunOut: false,
      supplierKey: result.draft.suppliers[0]?.key, posNames: [{ name: 'IPA Pint', perSale: '1' }, { name: 'IPA Pitcher', perSale: '4' }],
    });
  });

  test('a replaced item always keeps its par and never run out, and its own values where the suggestion is blank', () => {
    const saved: OrderSetup = { ...SAVED, items: [{ ...SAVED.items[0], par: 4, neverRunOut: true } as OrderSetup['items'][number]] };
    const read = readOf([suggestion('sample  LAGER', { supplier: 'New Distributor', unit: 'cases', servingsPerUnit: 30 })]);
    const result = importProposal(read, draftOf(saved));
    expect(result).toMatchObject({ added: 0, replaced: 1, newSuppliers: ['New Distributor'] });
    expect(result.draft.items).toHaveLength(1);
    expect(result.draft.items[0]).toMatchObject({
      id: 'bbbbbbbbbbbbbbbbbbbbbbb1', par: '4', neverRunOut: true, category: 'bottles_cans', unit: 'cases', servingsPerUnit: '30',
      dealSize: '5', posNames: [{ name: 'Lager Can', perSale: '1' }], supplierKey: result.draft.suppliers[1]?.key,
    });
    expect(result.kept).toEqual([{ item: 'sample  LAGER', fields: ['category', 'point-of-sale names', 'deal size'] }]);

    // A blank supplier keeps the item's own, and TownwiseAI's servings, unit and category replace its.
    const own = importProposal(readOf([suggestion('Sample Lager', { category: 'draft', unit: 'kegs', servingsPerUnit: 124 })]), draftOf(saved));
    expect(own.draft.items[0]).toMatchObject({ supplierKey: 'aaaaaaaaaaaaaaaaaaaaaaa1', category: 'draft', unit: 'kegs', servingsPerUnit: '124', par: '4', neverRunOut: true });
    expect(own.kept).toEqual([{ item: 'Sample Lager', fields: ['supplier', 'point-of-sale names', 'deal size'] }]);
    expect(checkDraft(own.draft).ok).toBe(true);
  });

  test('proposed deliveries fill only a supplier that has none', () => {
    const draft: SetupDraft = {
      suppliers: [
        ...draftOf(SAVED).suppliers,
        { key: 'new-supplier-blank', id: null, name: 'Sample Brewery', deliveries: [{ deliveryWeekday: '', cutoffWeekday: '', cutoffTime: '' }] },
      ],
      items: [],
    };
    const read = readOf([], [
      { name: 'sample distributor', deliveries: [{ deliveryWeekday: 1, cutoffWeekday: 0, cutoffTime: '10:00' }] },
      { name: 'Sample Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '09:00' }] },
      { name: 'New Spirits', deliveries: [{ deliveryWeekday: 5, cutoffWeekday: null, cutoffTime: null }] },
      { name: 'New Wines', deliveries: [] },
    ]);
    const result = importProposal(read, draft);
    expect(result.draft.suppliers.map((supplier) => [supplier.name, supplier.deliveries])).toEqual([
      ['Sample Distributor', [{ deliveryWeekday: '4', cutoffWeekday: '2', cutoffTime: '14:00' }]],
      ['Sample Brewery', [{ deliveryWeekday: '2', cutoffWeekday: '1', cutoffTime: '09:00' }]],
      ['New Spirits', [{ deliveryWeekday: '5', cutoffWeekday: '', cutoffTime: '' }]],
      ['New Wines', []],
    ]);
    expect(result).toMatchObject({ deliveriesFilled: ['Sample Brewery'], newSuppliers: ['New Spirits', 'New Wines'], suppliersLeftOut: [] });
    // An order-by day or time TownwiseAI left blank is the person's to fill in at Save.
    const check = checkDraft(result.draft);
    if (check.ok) throw new Error('accepted');
    expect(check.problems[fieldId.delivery(result.draft.suppliers[2]?.key ?? '', 0, 'cutoff')]).toEqual([SETUP_COPY.cutoffDay]);
  });

  test('marks an estimated servings value with its note and a name not found in the file; a picture marks no name', () => {
    const read = readOf([
      suggestion('Sample IPA', { servingsPerUnit: 124, servingsEstimated: true, note: 'A half-barrel holds about 124 pints.', inFile: false }),
      suggestion('Sample Gin', { servingsPerUnit: 17, servingsEstimated: true }),
      suggestion('Sample Cider', { servingsPerUnit: 24, inFile: null }),
    ]);
    const result = importProposal(read, draftOf(null));
    const [ipa, gin, cider] = result.draft.items;
    expect(result.marks[ipa?.key ?? '']).toEqual({
      servings: { value: '124', text: 'TownwiseAI estimated this: A half-barrel holds about 124 pints. Check it.' },
      name: { value: 'Sample IPA', text: 'TownwiseAI didn’t find this name in the file. Check it.' },
    });
    expect(result.marks[gin?.key ?? '']).toEqual({ servings: { value: '17', text: 'TownwiseAI estimated this. Check it.' } });
    expect(result.marks[cider?.key ?? '']).toBeUndefined();
    expect(result).toMatchObject({ estimated: 2, notInFile: 1 });
    // From pasted text, the name is not in the text.
    const pasted = importProposal(readOf([suggestion('Sample IPA', { inFile: false })]), draftOf(null), 'text');
    expect(Object.values(pasted.marks)[0]?.name?.text).toBe('TownwiseAI didn’t find this name in the text. Check it.');
  });

  test('a replaced item that keeps its own servings carries no estimate mark', () => {
    const read = readOf([suggestion('Sample Lager', { servingsPerUnit: null, servingsEstimated: false })]);
    expect(importProposal(read, draftOf(SAVED)).marks).toEqual({});
  });

  test('a mark clears once its field changes or its item goes, and a new read adds to the marks', () => {
    const read = readOf([suggestion('Sample IPA', { servingsPerUnit: 124, servingsEstimated: true, inFile: false })]);
    const result = importProposal(read, draftOf(null));
    const [ipa] = result.draft.items;
    if (ipa === undefined) throw new Error('no item');
    expect(pruneMarks(result.marks, result.draft)).toBe(result.marks);
    const edited = pruneMarks(result.marks, { ...result.draft, items: [{ ...ipa, servingsPerUnit: '120' }] });
    expect(edited).toEqual({ [ipa.key]: { name: result.marks[ipa.key]?.name } });
    expect(pruneMarks(edited, { ...result.draft, items: [{ ...ipa, servingsPerUnit: '120', name: 'IPA' }] })).toEqual({});
    expect(pruneMarks(result.marks, { ...result.draft, items: [] })).toEqual({});
    const more = withMarks(edited, { [ipa.key]: { servings: { value: '120', text: 'x' } }, other: { name: { value: 'Other', text: 'y' } } });
    expect(more).toEqual({ [ipa.key]: { name: result.marks[ipa.key]?.name, servings: { value: '120', text: 'x' } }, other: { name: { value: 'Other', text: 'y' } } });
  });

  test('a suggestion that fails a check is left out with why, by its number, and so is a second of one name', () => {
    const read = readOf([
      suggestion('Sample IPA'),
      suggestion('', { servingsPerUnit: 5000 }),
      suggestion('Sample Gin', { dealSize: 0, posNames: [{ name: 'Gin', perSale: 60 }, { name: ' gin ', perSale: 1 }] }),
      suggestion('sample ipa'),
    ]);
    const result = importProposal(read, draftOf(null));
    expect(result).toMatchObject({ found: 4, added: 1 });
    expect(result.problems).toEqual([
      { row: 2, item: '', reason: 'Its name is empty or longer than 80 characters. Its servings per unit isn’t a number from 0.1 to 2,000.' },
      {
        row: 3, item: 'Sample Gin',
        reason: 'Its deal size isn’t a whole number from 1 to 999. A point-of-sale name is listed twice. A point-of-sale name’s servings per sale isn’t above 0, up to 50.',
      },
      { row: 4, item: 'sample ipa', reason: 'It’s the same item as item 1.' },
    ]);
  });

  test('the setup’s limits hold: 300 items, 20 suppliers', () => {
    const full: SetupDraft = { suppliers: [], items: Array.from({ length: 299 }, (_, i) => ({ ...newItem(''), name: `Item ${String(i)}` })) };
    const items = importProposal(readOf([suggestion('Sample IPA'), suggestion('Sample Gin'), suggestion('Item 3', { servingsPerUnit: 24 })]), full);
    expect(items.draft.items).toHaveLength(300);
    expect(items.problems).toEqual([{ row: 2, item: 'Sample Gin', reason: 'The setup holds up to 300 items.' }]);
    expect(items.replaced).toBe(1);
    const many: SetupDraft = { suppliers: Array.from({ length: 19 }, (_, i) => newSupplier(`Supplier ${String(i)}`)), items: [] };
    const suppliers = importProposal(readOf([suggestion('Sample IPA', { supplier: 'Second New' })], [{ name: 'First New', deliveries: [] }, { name: 'Third New', deliveries: [] }]), many);
    expect(suppliers.draft.suppliers).toHaveLength(20);
    expect(suppliers).toMatchObject({ newSuppliers: ['First New'], suppliersLeftOut: ['Third New'] });
    expect(suppliers.problems).toEqual([{ row: 1, item: 'Sample IPA', reason: 'The setup holds up to 20 suppliers.' }]);
  });

  test('the summary: what it found, what to set and check, new suppliers’ deliveries, a cut or partial read', () => {
    const saved: OrderSetup = {
      ...SAVED,
      items: ['Sample Lager', 'Sample Porter', 'Sample Rum'].map((name, i) => ({ ...SAVED.items[0], id: `bbbbbbbbbbbbbbbbbbbbbbc${String(i)}`, name } as OrderSetup['items'][number])),
    };
    const items = [
      ...['Sample Lager', 'Sample Porter', 'Sample Rum'].map((name) => suggestion(name, { category: 'liquor' })),
      ...Array.from({ length: 11 }, (_, i) => suggestion(`New Item ${String(i)}`, i < 4 ? { servingsPerUnit: 124, servingsEstimated: true } : {})),
    ];
    items[5] = { ...items[5], inFile: false } as SetupReadItem;
    items[6] = { ...items[6], inFile: false } as SetupReadItem;
    const read = readOf(items, [{ name: 'New Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '09:00' }, { deliveryWeekday: 5, cutoffWeekday: null, cutoffTime: null }] }, { name: 'New Spirits', deliveries: [] }], { itemsCut: true });
    const result = importProposal(read, draftOf(saved));
    expect(proposalSummary(result)).toEqual([
      'TownwiseAI found 14 items: 11 new, 3 replaced by name. Nothing is saved yet: check them below, then save the setup.',
      'Set the par of the 11 new items.',
      'Replaced items keep their par and never run out, and their own values where TownwiseAI left a field blank.',
      'Check the servings per unit of 4 items: TownwiseAI estimated them.',
      'TownwiseAI didn’t find 2 of these names in the file: check them.',
      'Added 1 supplier with the delivery days TownwiseAI found: New Brewery (Tuesday and Friday). Check each delivery’s order-by day and time.',
      'Add the delivery days of the new suppliers: New Spirits.',
      'The file lists more items than TownwiseAI reads at once (150), so some were left out. Read the rest separately.',
    ]);

    const one = importProposal(readOf([suggestion('Sample Stout', { servingsPerUnit: 124, servingsEstimated: true, inFile: false }), suggestion('')], [], { partial: true }), draftOf(null), 'text');
    expect(proposalSummary(one, 'text')).toEqual([
      'TownwiseAI found 2 items: 1 new, 0 replaced by name. Nothing is saved yet: check them below, then save the setup.',
      'Set the par of the new item.',
      'Check the servings per unit of 1 item: TownwiseAI estimated it.',
      'TownwiseAI didn’t find 1 of these names in the text: check it.',
      'The text was too long to read whole, so TownwiseAI read only the start of it.',
      'Left out 1 item that failed a check:',
    ]);
    expect(problemLine(one.problems[0] ?? { row: 0, item: '', reason: '' })).toBe('Item 2: Its name is empty or longer than 80 characters.');

    const filled = importProposal(readOf([], [{ name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 1, cutoffWeekday: 0, cutoffTime: '10:00' }] }]), { ...draftOf(SAVED), suppliers: [{ ...newSupplier('Sample Distributor'), deliveries: [] }] });
    expect(proposalSummary(filled)).toEqual([
      'TownwiseAI found no items. Nothing is saved yet: check the suppliers below, then save the setup.',
      'Filled in the delivery days TownwiseAI found for Sample Distributor, which had none. Check each delivery’s order-by day and time.',
    ]);
    expect(proposalSummary(importProposal(readOf([]), draftOf(null)))).toEqual(['TownwiseAI found nothing to add from the file.']);
  });
});
