import type { OrderSetup } from '../../../src/portal/orders/api';
import { checkDraft, draftOf, fieldId, newItem, newSupplier, parseTime, SETUP_COPY, type SetupDraft } from '../../../src/portal/orders/setupDraft';
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
          + 'Servings per unit: enter a number above 0, up to 2,000. Par: enter a whole number from 0 to 999. '
          + 'Deal size: leave it empty, or enter a whole number from 1 to 999. Never run out: use yes or no.',
      },
      { row: 6, item: 'sample ipa', reason: 'This item is already on row 3.' },
    ]);
    const { draft } = result;
    expect(draft.suppliers.map((supplier) => [supplier.name, supplier.id === null, supplier.deliveries.length])).toEqual([
      ['Sample Distributor', false, 1], ['New Brewery', true, 0], ['New Spirits', true, 0],
    ]);
    const lager = draft.items[0];
    expect(lager).toMatchObject({
      id: 'bbbbbbbbbbbbbbbbbbbbbbb1', name: 'Sample Lager', supplierKey: 'aaaaaaaaaaaaaaaaaaaaaaa1', category: 'bottles_cans', unit: 'cases',
      servingsPerUnit: '24', par: '3', dealSize: '', neverRunOut: true,
      posNames: [{ name: 'Lager Can', perSale: '1' }, { name: 'Lager Bucket', perSale: '5' }],
    });
    expect(draft.items.map((each) => [each.name, each.id, draft.suppliers.find((s) => s.key === each.supplierKey)?.name])).toEqual([
      ['Sample Lager', 'bbbbbbbbbbbbbbbbbbbbbbb1', 'Sample Distributor'], ['Sample IPA', null, 'New Brewery'], ['Sample Gin', null, 'New Spirits'],
    ]);
    // New suppliers still need their deliveries before the setup saves.
    const check = checkDraft(draft);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems[fieldId.supplier(draft.suppliers[1]?.key ?? '', 'deliveries')]).toEqual([SETUP_COPY.noDelivery]);
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

  test('order-by times are HH:MM, 24 hour', () => {
    expect(['14:00', '9:05', '00:00', '23:59'].map(parseTime)).toEqual(['14:00', '09:05', '00:00', '23:59']);
    for (const text of ['24:00', '2pm', '14:0', '14.00', '']) expect(parseTime(text)).toBeNull();
  });
});
