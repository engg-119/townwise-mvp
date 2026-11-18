import type { z } from 'zod';

import type { ApiClient, RequestOptions } from '../../../src/api/client';
import {
  dismissSetupProposal, fetchSetupProposal, type OrderSetup, type SetupRead, type SetupReadItem,
} from '../../../src/portal/orders/api';
import { importProposal, proposalSummary } from '../../../src/portal/orders/proposal';
import { CARD_CHANGES_MAX, changeLine, CHAT_CUT, CHAT_SETUP_ITEMS_MAX, moreChangesLine, pageChangesLead, setupCardPreview } from '../../../src/portal/orders/setupCard';
import { draftOf } from '../../../src/portal/orders/setupDraft';

// The ordering setup card of a TownwiseAI chat (spec D56): the preview of what its suggestions would add to and change
// in the live setup, before anything is merged or saved, and the card's two calls. Every supplier and item here is
// synthetic.

const SAVED: OrderSetup = {
  version: 3,
  updatedAt: '2026-11-10T15:00:00.000Z',
  suppliers: [
    { id: 'aaaaaaaaaaaaaaaaaaaaaaa1', name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] },
    { id: 'aaaaaaaaaaaaaaaaaaaaaaa2', name: 'Sample Spirits', deliveries: [] },
  ],
  items: [
    {
      id: 'bbbbbbbbbbbbbbbbbbbbbbb1', name: 'Sample Lager', supplierId: 'aaaaaaaaaaaaaaaaaaaaaaa1', category: 'bottles_cans', unit: 'cases',
      servingsPerUnit: 24, par: 2, dealSize: null, neverRunOut: true, posNames: [{ name: 'Lager Can', perSale: 1 }],
    },
    {
      id: 'bbbbbbbbbbbbbbbbbbbbbbb2', name: 'Sample Gin', supplierId: 'aaaaaaaaaaaaaaaaaaaaaaa2', category: 'liquor', unit: 'bottles',
      servingsPerUnit: 17, par: 3, dealSize: 6, neverRunOut: false, posNames: [],
    },
  ],
};

function suggestion(name: string, fields: Partial<SetupReadItem> = {}): SetupReadItem {
  return {
    name, supplier: null, category: null, unit: null, servingsPerUnit: null, servingsEstimated: false, dealSize: null, posNames: [],
    note: '', inFile: true, ...fields,
  };
}

function readOf(items: SetupReadItem[], suppliers: SetupRead['suppliers'] = [], flags: Partial<Pick<SetupRead, 'itemsCut' | 'partial'>> = {}): SetupRead {
  return { kind: 'order_guide', confidence: 'high', suppliers, items, itemsCut: false, partial: false, ...flags };
}

/** The same values the setup already holds for an item, so matching it changes nothing. */
const LAGER_AS_SAVED = suggestion('Sample Lager', { supplier: 'Sample Distributor', category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24 });

describe('the setup card’s preview', () => {
  test('counts new items and items matched by name', () => {
    const preview = setupCardPreview(readOf([LAGER_AS_SAVED, suggestion('  sample   GIN '), suggestion('Sample Stout'), suggestion('Sample Porter')]), SAVED);
    expect(preview).toMatchObject({ found: 4, added: 2, matched: 2, inSetup: false });
    expect(preview.lines[0]).toBe('TownwiseAI suggests 4 items: 2 new and 2 already in your setup by name.');
    expect(setupCardPreview(readOf([suggestion('Sample Stout')]), null)).toMatchObject({ found: 1, added: 1, matched: 0 });
    expect(setupCardPreview(readOf([suggestion('Sample Stout')]), null).lines[0]).toBe('TownwiseAI suggests 1 item: 1 new and 0 already in your setup by name.');
  });

  test('lists each existing item that would change with the field, its value now and the suggested one, a name’s spelling included', () => {
    const preview = setupCardPreview(readOf([
      suggestion('SAMPLE Lager', { supplier: 'New Brewery', category: 'draft', unit: 'kegs', servingsPerUnit: 124, dealSize: 2 }),
      suggestion('Sample Gin', { supplier: 'sample spirits', category: 'liquor', unit: 'bottles', servingsPerUnit: 17, dealSize: 6 }),
    ]), SAVED);
    expect(preview.changes).toEqual([{
      item: 'Sample Lager',
      fields: [
        { field: 'name', from: 'Sample Lager', to: 'SAMPLE Lager' },
        { field: 'supplier', from: 'Sample Distributor', to: 'New Brewery' },
        { field: 'category', from: 'Bottles and cans', to: 'Draft' },
        { field: 'unit', from: 'cases', to: 'kegs' },
        { field: 'servings per unit', from: '24', to: '124' },
        { field: 'deal size', from: 'none', to: '2' },
      ],
    }]);
    // Both values are quoted, so one that holds "to" cannot run into the other.
    expect(changeLine(preview.changes[0] ?? { item: '', fields: [] })).toBe(
      'Sample Lager: name: “Sample Lager” becomes “SAMPLE Lager”; supplier: “Sample Distributor” becomes “New Brewery”; '
        + 'category: “Bottles and cans” becomes “Draft”; unit: “cases” becomes “kegs”; servings per unit: “24” becomes “124”; deal size: “none” becomes “2”',
    );
    expect(changeLine({ item: 'Gin to go', fields: [{ field: 'name', from: 'Gin to go', to: 'Gin to Go' }] })).toBe('Gin to go: name: “Gin to go” becomes “Gin to Go”');
    expect(preview.changesLead).toBe('1 item already in your setup by name would change:');
    // The card lists ten and says how many more Ordering setup lists; the page's lead says they change at Save.
    expect(CARD_CHANGES_MAX).toBe(10);
    expect([moreChangesLine(10), moreChangesLine(11), moreChangesLine(13)]).toEqual([null, 'and 1 more. Ordering setup lists every one.', 'and 3 more. Ordering setup lists every one.']);
    expect([pageChangesLead(1), pageChangesLead(3)]).toEqual([
      '1 item already in your setup by name changes when you save:', '3 items already in your setup by name change when you save:',
    ]);
    expect(setupCardPreview(readOf([suggestion('Sample Stout')]), SAVED)).toMatchObject({ changes: [], changesLead: null, problemsLead: null });
    // A field the suggestion leaves blank keeps the setup's value, so it is no change.
    expect(setupCardPreview(readOf([suggestion('Sample Gin')]), SAVED).changes).toEqual([]);
  });

  test('says a matched item keeps its par, never run out and register names', () => {
    const preview = setupCardPreview(readOf([suggestion('Sample Lager', { unit: 'kegs' })]), SAVED);
    expect(preview.lines).toContain('An item already in your setup by name keeps its par, never run out and point-of-sale names.');
    const two = setupCardPreview(readOf([suggestion('Sample Lager', { unit: 'kegs' }), suggestion('Sample Gin', { unit: 'cases' })]), SAVED);
    expect(two.lines).toContain('Items already in your setup by name keep their par, never run out and point-of-sale names.');
    expect(preview.result.draft.items[0]).toMatchObject({ id: 'bbbbbbbbbbbbbbbbbbbbbbb1', par: '2', neverRunOut: true, posNames: [{ name: 'Lager Can', perSale: '1' }], unit: 'kegs' });
    expect(setupCardPreview(readOf([suggestion('Sample Stout')]), SAVED).lines.join(' ')).not.toMatch(/keeps its par/);
  });

  test('names new suppliers with their days and says an existing supplier’s days stay', () => {
    const preview = setupCardPreview(readOf([], [
      { name: 'New Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '09:00' }, { deliveryWeekday: 5, cutoffWeekday: null, cutoffTime: null }] },
      { name: 'New Cidery', deliveries: [] },
      { name: 'sample distributor', deliveries: [{ deliveryWeekday: 1, cutoffWeekday: 0, cutoffTime: '10:00' }] },
      { name: 'Sample Spirits', deliveries: [{ deliveryWeekday: 3, cutoffWeekday: 2, cutoffTime: '12:00' }] },
    ]), SAVED);
    expect(preview.lines).toEqual([
      'TownwiseAI suggests no items, only suppliers.',
      'New suppliers: New Brewery (Tuesday and Friday) and New Cidery (no delivery days found).',
      'Sample Spirits has no delivery days in your setup, so it would take the ones TownwiseAI found (Wednesday).',
      'Sample Distributor keeps the delivery days in your setup.',
    ]);
    // The last line sits apart, so the card can put it directly above its actions.
    expect(preview.closing).toBe('Nothing is saved yet. Review these in Ordering setup and save there.');
    expect(preview).toMatchObject({ inSetup: false, actionable: true });
  });

  test('says how many servings are estimates and how many names weren’t in the file, or that names couldn’t be checked', () => {
    const checked = setupCardPreview(readOf([
      suggestion('Sample Stout', { servingsPerUnit: 124, servingsEstimated: true, inFile: false }),
      suggestion('Sample Porter', { servingsPerUnit: 41, servingsEstimated: true }),
      suggestion('Sample Rum', { inFile: false }),
    ]), SAVED);
    expect(checked.lines).toContain('TownwiseAI estimated the servings per unit of 2 items.');
    expect(checked.lines).toContain('TownwiseAI didn’t find 2 of these names in the file.');
    expect(checked.namesUnchecked).toBe(false);
    const picture = setupCardPreview(readOf([suggestion('Sample Stout', { inFile: null }), suggestion('Sample Rum', { inFile: null })]), SAVED);
    expect(picture.namesUnchecked).toBe(true);
    expect(picture.lines).toContain('Townwise couldn’t check these names against the file’s text, because it was read as a picture.');
    expect(picture.lines.join(' ')).not.toMatch(/didn’t find/);
  });

  test('says when the file was cut and when it lists more than the 60 a chat suggests, never 150', () => {
    expect(CHAT_SETUP_ITEMS_MAX).toBe(60);
    const read = readOf([suggestion('Sample Stout')], [], { itemsCut: true, partial: true });
    const preview = setupCardPreview(read, SAVED);
    const cut = 'The file lists more items than TownwiseAI suggests in a chat (60), so some were left out. For the rest, use Read a file with TownwiseAI on Ordering setup.';
    expect(preview.lines).toContain(cut);
    expect(preview.lines).toContain('The file was too long to read whole, so TownwiseAI read only the start of it.');
    expect(preview.lines.join(' ')).not.toContain('150');
    // Ordering setup's own summary takes the same wording for a card's suggestions, and keeps D41's by default.
    const merged = importProposal(read, draftOf(SAVED));
    expect(proposalSummary(merged, 'file', CHAT_CUT)).toContain(cut);
    expect(proposalSummary(merged, 'file', CHAT_CUT).join(' ')).not.toContain('150');
    expect(proposalSummary(merged)).toContain('The file lists more items than TownwiseAI reads at once (150), so some were left out. Read the rest separately.');
  });

  test('lists what is left out: a second item of one name, items past 300, suppliers past 20', () => {
    const twice = setupCardPreview(readOf([suggestion('Sample Stout'), suggestion('sample stout')]), SAVED);
    expect(twice.problems).toEqual([{ row: 2, item: 'sample stout', reason: 'It’s the same item as item 1.' }]);
    expect(twice.problemsLead).toBe('Left out 1 item:');
    // The first line's counts add up to the items suggested.
    expect(twice.lines[0]).toBe('TownwiseAI suggests 2 items: 1 new, 0 already in your setup by name and 1 left out.');

    const full: OrderSetup = {
      ...SAVED,
      items: Array.from({ length: 300 }, (_, i) => ({ ...SAVED.items[1], id: `b${String(i).padStart(23, '0')}`, name: `Item ${String(i)}` } as OrderSetup['items'][number])),
    };
    const past = setupCardPreview(readOf([suggestion('Sample Stout')]), full);
    expect(past.problems).toEqual([{ row: 1, item: 'Sample Stout', reason: 'The setup holds up to 300 items.' }]);
    expect(past).toMatchObject({ added: 0, inSetup: false, actionable: false, closing: null });
    expect(past.lines).toEqual(['TownwiseAI suggests 1 item: 0 new, 0 already in your setup by name and 1 left out.']);
    expect(past.problemsLead).toBe('Left out 1 item:');

    const many: OrderSetup = {
      ...SAVED, items: [],
      suppliers: Array.from({ length: 20 }, (_, i) => ({ id: `a${String(i).padStart(23, '0')}`, name: `Supplier ${String(i)}`, deliveries: [] })),
    };
    const suppliers = setupCardPreview(readOf([], [{ name: 'One More', deliveries: [] }]), many);
    expect(suppliers.lines).toEqual(['TownwiseAI suggests no items, only suppliers.', 'Left out One More: the setup holds up to 20 suppliers.']);
    expect(suppliers).toMatchObject({ inSetup: false, actionable: false });
  });

  test('every new item’s par is blank in the merged draft', () => {
    const preview = setupCardPreview(readOf([suggestion('Sample Stout'), suggestion('Sample Porter', { servingsPerUnit: 41 }), suggestion('Sample Lager')]), SAVED);
    const added = preview.result.draft.items.filter((item) => item.id === null);
    expect(added.map((item) => ({ name: item.name, par: item.par, neverRunOut: item.neverRunOut }))).toEqual([
      { name: 'Sample Stout', par: '', neverRunOut: false }, { name: 'Sample Porter', par: '', neverRunOut: false },
    ]);
    expect(preview.closing).toBe('Nothing is saved yet. Review these in Ordering setup, set the par of the 2 new items, and save there.');
    expect(preview.lines.join(' ')).not.toMatch(/Nothing is saved yet/);
    expect(setupCardPreview(readOf([suggestion('Sample Stout')]), SAVED).closing)
      .toBe('Nothing is saved yet. Review these in Ordering setup, set the par of the new item, and save there.');
  });

  test('says the suggestions are in the setup when nothing would be added or changed', () => {
    const preview = setupCardPreview(readOf(
      [LAGER_AS_SAVED, suggestion('Sample Gin', { servingsPerUnit: 17, dealSize: 6 })],
      [{ name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 1, cutoffWeekday: 0, cutoffTime: '10:00' }] }],
      { itemsCut: true },
    ), SAVED);
    expect(preview).toMatchObject({ inSetup: true, actionable: false, closing: null, added: 0, matched: 2, changes: [], problems: [] });
    expect(preview.lines).toEqual(['These suggestions are in your ordering setup.']);
    // Nothing suggested at all is not "in the setup".
    expect(setupCardPreview(readOf([]), SAVED)).toMatchObject({ inSetup: false, actionable: false, closing: null, lines: ['TownwiseAI found nothing to suggest.'] });
  });
});

function clientAnswering(answer: unknown): { api: ApiClient; calls: { path: string; opts: RequestOptions | undefined }[] } {
  const calls: { path: string; opts: RequestOptions | undefined }[] = [];
  const api: ApiClient = {
    json<T>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> {
      calls.push({ path, opts });
      return Promise.resolve(schema.parse(answer));
    },
    request: () => Promise.reject(new Error('unused')),
    stream: () => Promise.reject(new Error('unused')),
    logout: () => Promise.resolve(),
  };
  return { api, calls };
}

describe('the setup card’s calls', () => {
  const read = readOf([suggestion('Sample Stout', { inFile: null })]);

  test('fetchSetupProposal reads the card by its ids and answers its state, the checked suggestions and whether web pages were read', async () => {
    const { api, calls } = clientAnswering({ proposal: { kind: 'setup', status: 'open', read: { ...read, items: [{ ...read.items[0], par: 4 }] }, readWeb: true } });
    const proposal = await fetchSetupProposal(api, 'l 1', 'c1', 'toolu_1');
    expect(proposal).toEqual({ kind: 'setup', status: 'open', read, readWeb: true });
    expect(calls).toEqual([{ path: '/api/org/locations/l%201/chat/c1/order-proposals/toolu_1', opts: undefined }]);
    const dismissed = clientAnswering({ proposal: { kind: 'setup', status: 'dismissed', read, readWeb: false } });
    expect((await fetchSetupProposal(dismissed.api, 'l1', 'c1', 'toolu_1')).status).toBe('dismissed');
  });

  test('another kind of card, or a saved state, is not a setup card', async () => {
    for (const proposal of [{ kind: 'change', status: 'open', itemId: 'i1', delivery: '2026-06-04' }, { kind: 'setup', status: 'saved', read, readWeb: false }]) {
      await expect(fetchSetupProposal(clientAnswering({ proposal }).api, 'l1', 'c1', 'toolu_1')).rejects.toThrow();
    }
  });

  test('dismissSetupProposal posts dismiss alone', async () => {
    const { api, calls } = clientAnswering({ proposal: { kind: 'setup', status: 'dismissed' } });
    await dismissSetupProposal(api, 'l1', 'c1', 'toolu_1');
    expect(calls).toEqual([{ path: '/api/org/locations/l1/chat/c1/order-proposals/toolu_1', opts: { method: 'POST', body: { action: 'dismiss' } } }]);
  });
});
