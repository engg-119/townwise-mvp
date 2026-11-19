// propose_order_setup (spec D56), without Docker: its one check of the model's input (an attached file's ref, the setup
// read's answer, 60 items, no point-of-sale names), what it shows and refuses from the content the turn sent, that it
// reads no file, that its views carry a ref and counts only, and its place in the registry, the prompt and a reply.
// Synthetic content only.
import { describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import type { OrgScope } from '../src/access/policy.ts';
import { SYSTEM_PROMPT } from '../src/chat/prompt.ts';
import { ORDER_SETUP_ITEMS_MAX, proposeOrderSetupTool, shownOrderSetup } from '../src/chat/tools/order-setup.ts';
import { inputViewOf, TOOL_REGISTRY, toolNamed, type SentFile, type ToolContext } from '../src/chat/tools/registry.ts';
import { DISPLAY_TOOLS, isAside } from '../src/chat/turn.ts';

const TODAY = '2026-11-10';
const REF = 'f_0000000000000000000000a1';
const OTHER_REF = 'f_0000000000000000000000a2';
const TEXT = 'Quillvane Beverage order guide\nVorlan Brewing IPA 1/2 BBL\nHouse   Lemonade 12/32oz\nDelivers Tuesday, order by Sunday 2pm';

const ITEM = {
  name: 'Vorlan Brewing IPA', supplier: 'Quillvane Beverage', category: 'draft', unit: 'kegs', servingsPerUnit: 124,
  servingsEstimated: true, dealSize: null, note: '',
};
const SUPPLIER = { name: 'Quillvane Beverage', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 0, cutoffTime: '14:00' }] };

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ref: REF, kind: 'order_guide', confidence: 'high', suppliers: [SUPPLIER], items: [ITEM], itemsCut: false, ...over };
}

interface Fakes {
  attached?: readonly string[];
  sent?: Map<string, SentFile>;
  readWeb?: boolean;
  /** Every reach for the context's stores, ports or item reader, and every byte reservation. */
  touched?: string[];
}

function context(fakes: Fakes = {}): ToolContext {
  const touched = fakes.touched ?? [];
  const guarded = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); return undefined; } });
  const files = {
    attached: new Set(fakes.attached ?? [REF]), by: 0,
    bytes: { reserve: () => { touched.push('reserve'); return false; }, release: () => { touched.push('release'); } },
  };
  return {
    ctx: guarded as unknown as TownwiseContext,
    scope: { orgId: '000000000000000000000003' } as unknown as OrgScope,
    conversationId: '0000000000000000000000c1',
    location: {
      id: '000000000000000000000001', name: 'Test Taproom', placeId: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
      town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
    },
    today: TODAY,
    timeZone: 'America/New_York',
    role: 'member',
    actor: { actorUserId: 'user-1', actorEmail: 'member@example.test', actorRole: 'member', viewAsGrantId: null },
    turn: { readUntrusted: true, readWeb: fakes.readWeb ?? false, readNotTyped: false, pictureBytes: 0 },
    files: { ...files, sent: fakes.sent ?? new Map<string, SentFile>([[REF, { text: TEXT, truncated: false }]]) },
  };
}

async function run(input: unknown, tc: ToolContext): Promise<Record<string, unknown>> {
  const parsed = proposeOrderSetupTool.parse(input, TODAY);
  if (parsed === null) throw new Error('invalid input');
  return JSON.parse((await proposeOrderSetupTool.run(tc, parsed)).content) as Record<string, unknown>;
}

describe('propose_order_setup’s input', () => {
  it('takes the attached file’s ref and the setup read’s answer without point-of-sale names', () => {
    expect(proposeOrderSetupTool.parse(answer(), TODAY)).toEqual({
      ref: REF, kind: 'order_guide', confidence: 'high', suppliers: [SUPPLIER],
      items: [{ ...ITEM, posNames: [], inFile: null }], itemsCut: false,
    });
    const schema = proposeOrderSetupTool.definition.input_schema as unknown as {
      additionalProperties: boolean; required: string[];
      properties: { items: { maxItems: number; items: { additionalProperties: boolean; properties: Record<string, unknown> } } };
    };
    expect(proposeOrderSetupTool.definition.name).toBe('propose_order_setup');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['ref', 'kind', 'confidence', 'suppliers', 'items', 'itemsCut']);
    expect(schema.properties.items.items.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.items.items.properties)).toEqual([
      'name', 'supplier', 'category', 'unit', 'servingsPerUnit', 'servingsEstimated', 'dealSize', 'note',
    ]);
    expect(schema.properties.items.maxItems).toBe(60);
    expect(JSON.stringify(proposeOrderSetupTool.definition.input_schema)).not.toMatch(/posNames|"par"|neverRunOut/);
  });

  it('is invalid for a non-object, a missing ref or a u_ ref', () => {
    for (const bad of [
      null, 'f_0000000000000000000000a1', [answer()], answer({ ref: undefined }), answer({ ref: 'u_0000000000000000000000a1' }),
      answer({ ref: 'f_00a1' }), answer({ ref: `${REF} ` }), answer({ ref: 7 }),
    ]) expect(proposeOrderSetupTool.parse(bad, TODAY)).toBeNull();
    expect(proposeOrderSetupTool.invalidInput).toMatch(/nothing was shown/i);
  });

  it('keeps the first 60 items and says the rest were cut', () => {
    expect(ORDER_SETUP_ITEMS_MAX).toBe(60);
    const items = Array.from({ length: 61 }, (_unused, index) => ({ ...ITEM, name: `Sentinel Item ${String(index + 1)}` }));
    const cut = proposeOrderSetupTool.parse(answer({ items }), TODAY);
    expect(cut?.items).toHaveLength(60);
    expect(cut?.items.at(-1)?.name).toBe('Sentinel Item 60');
    expect(cut?.itemsCut).toBe(true);
    const whole = proposeOrderSetupTool.parse(answer({ items: items.slice(0, 60) }), TODAY);
    expect(whole?.items).toHaveLength(60);
    expect(whole?.itemsCut).toBe(false);
    // The model's own word that the file held more is kept.
    expect(proposeOrderSetupTool.parse(answer({ itemsCut: true }), TODAY)?.itemsCut).toBe(true);
  });

  it('a par, a never run out or a point-of-sale name the model wrote never reaches the proposal, and an email or phone number in a name or note is replaced', () => {
    const parsed = proposeOrderSetupTool.parse(answer({
      par: 4,
      suppliers: [{ ...SUPPLIER, name: 'Quillvane rep@quillvane.example', rep: 'Sentinel Person' }],
      items: [{
        ...ITEM, supplier: null, name: 'Vorlan IPA (603) 555-0123', note: 'Ask sales@quillvane.example', par: 3, neverRunOut: true,
        posNames: [{ name: 'Sentinel-register-name', perSale: 1 }], extra: 'Sentinel-extra',
      }],
    }), TODAY);
    expect(parsed?.suppliers).toEqual([{ name: 'Quillvane [email]', deliveries: SUPPLIER.deliveries }]);
    expect(parsed?.items).toEqual([{
      ...ITEM, supplier: null, name: 'Vorlan IPA [phone]', note: 'Ask [email]', posNames: [], inFile: null,
    }]);
    expect(JSON.stringify(parsed)).not.toMatch(/Sentinel|"par"|neverRunOut|quillvane\.example|555/);
  });
});

describe('propose_order_setup', () => {
  it('shows nothing for a ref not attached on the path', async () => {
    const shown = await run(answer({ ref: OTHER_REF }), context({ sent: new Map<string, SentFile>([[OTHER_REF, { text: TEXT, truncated: false }]]) }));
    expect(shown).toEqual({ shown: false, reason: expect.stringMatching(/not a file attached to this conversation/) as unknown });
  });

  it('shows nothing, and says to call read_data_item first, for an attached file this turn’s requests don’t carry', async () => {
    for (const sent of [new Map<string, SentFile>(), new Map<string, SentFile>([[OTHER_REF, { text: TEXT, truncated: false }]])]) {
      const shown = await run(answer(), context({ attached: [REF, OTHER_REF], sent }));
      expect(shown).toEqual({ shown: false, reason: expect.stringMatching(/read_data_item with the ref first/) as unknown });
    }
  });

  it('shows nothing with no supplier and no item', async () => {
    expect(await run(answer({ suppliers: [], items: [] }), context())).toEqual({ shown: false, reason: expect.stringMatching(/no supplier and no item/) as unknown });
    // An entry that fails its check is dropped, so a list of only those is empty too.
    expect((await run(answer({ suppliers: [{ name: '' }], items: [{ name: 7 }] }), context())).shown).toBe(false);
    expect((await run(answer({ items: [] }), context())).shown).toBe(true);
  });

  it('marks each name not written in the text sent and says when that text was cut', async () => {
    const items = [ITEM, { ...ITEM, name: 'house lemonade' }, { ...ITEM, name: 'Sentinel Stout' }];
    expect(await run(answer({ items }), context())).toEqual({
      shown: true, supplierCount: 1, itemCount: 3, namesChecked: true, notInFile: ['sentinel stout'], partial: false, itemsCut: false, readWeb: false,
    });
    const cut = await run(answer({ items }), context({ sent: new Map<string, SentFile>([[REF, { text: TEXT, truncated: true }]]) }));
    expect(cut).toMatchObject({ shown: true, partial: true, namesChecked: true });
  });

  it('leaves names unchecked for a picture', async () => {
    expect(await run(answer({ items: [{ ...ITEM, name: 'Sentinel Stout' }] }), context({ sent: new Map<string, SentFile>([[REF, { picture: true }]]) }))).toEqual({
      shown: true, supplierCount: 1, itemCount: 1, namesChecked: false, notInFile: [], partial: false, itemsCut: false, readWeb: false,
    });
  });

  it('reads no file and holds no bytes', async () => {
    const touched: string[] = [];
    const tc = context({ touched });
    expect((await run(answer(), tc)).shown).toBe(true);
    expect((await run(answer({ ref: OTHER_REF }), tc)).shown).toBe(false);
    expect((await run(answer(), context({ touched, sent: new Map<string, SentFile>([[REF, { picture: true }]]) }))).shown).toBe(true);
    expect(touched).toEqual([]);
    expect(tc.turn.pictureBytes).toBe(0);
  });

  it('says when the turn read web pages', async () => {
    expect((await run(answer(), context({ readWeb: true }))).readWeb).toBe(true);
    expect((await run(answer(), context())).readWeb).toBe(false);
  });

  it('its views carry the ref and counts, never a name', async () => {
    const items = [ITEM, { ...ITEM, name: 'Sentinel Stout' }];
    const parsed = proposeOrderSetupTool.parse(answer({ items }), TODAY);
    if (parsed === null) throw new Error('invalid input');
    const content = (await proposeOrderSetupTool.run(context(), parsed)).content;
    const views = [proposeOrderSetupTool.inputView(parsed), proposeOrderSetupTool.resultView(content)];
    expect(views).toEqual([
      { ref: REF, supplierCount: 1, itemCount: 2 },
      { shown: true, supplierCount: 1, itemCount: 2, notInFileCount: 1, partial: false },
    ]);
    expect(JSON.stringify(views)).not.toMatch(/Sentinel|Vorlan|Quillvane/i);
    const refusal = (await proposeOrderSetupTool.run(context({ attached: [] }), parsed)).content;
    expect(proposeOrderSetupTool.resultView(refusal)).toEqual({ shown: false });
    expect(proposeOrderSetupTool.resultView('not json')).toBeNull();
    expect(proposeOrderSetupTool.resultView(JSON.stringify({ shown: true }))).toBeNull();
  });
});

describe('propose_order_setup in a turn', () => {
  it('follows propose_order_rule in the registry, with only D66\'s correct_calendar_event after it', () => {
    expect(TOOL_REGISTRY.at(-2)).toBe(proposeOrderSetupTool);
    expect(TOOL_REGISTRY.at(-3)?.definition.name).toBe('propose_order_rule');
    expect(TOOL_REGISTRY.at(-1)?.definition.name).toBe('correct_calendar_event');
    expect(toolNamed('propose_order_setup')).toBe(proposeOrderSetupTool);
    expect(inputViewOf('propose_order_setup', answer(), TODAY)).toEqual({ ref: REF, supplierCount: 1, itemCount: 1 });
  });

  it('is named in the system prompt, which no longer says the chat can’t fill the setup', () => {
    expect(SYSTEM_PROMPT).toContain('then call propose_order_setup with the file\'s ref and at most sixty items');
    expect(SYSTEM_PROMPT).toContain('call read_data_item with the file\'s ref first when its content is not in this reply');
    expect(SYSTEM_PROMPT).toContain('never say anything was saved');
    expect(SYSTEM_PROMPT).not.toMatch(/cannot fill the ordering setup/i);
    expect(SYSTEM_PROMPT).not.toMatch(/\d/);
  });

  it('text written before the card stays the reply', () => {
    const card = { type: 'tool_use', id: 't1', name: 'propose_order_setup' };
    expect(isAside([{ type: 'text' }, card], () => true)).toBe(false);
    // With a read in the same message the text came ahead of work, as for any tool.
    expect(isAside([{ type: 'text' }, { type: 'tool_use', id: 't0', name: 'read_data_item' }, card], () => true)).toBe(true);
    expect(DISPLAY_TOOLS.has('propose_order_setup')).toBe(true);
  });
});

describe('a shown propose_order_setup call read back for its card', () => {
  it('is the checked input with each name’s inFile from the stored result, the cut flags and whether web pages were read', async () => {
    const input = answer({ items: [{ ...ITEM, posNames: [{ name: 'Sentinel-register-name', perSale: 1 }], par: 2 }, { ...ITEM, name: 'Sentinel  STOUT' }] });
    const parsed = proposeOrderSetupTool.parse(input, TODAY);
    if (parsed === null) throw new Error('invalid input');
    const content = (await proposeOrderSetupTool.run(context({ readWeb: true, sent: new Map<string, SentFile>([[REF, { text: TEXT, truncated: true }]]) }), parsed)).content;
    expect(shownOrderSetup(input, content)).toEqual({
      ref: REF, readWeb: true,
      read: {
        kind: 'order_guide', confidence: 'high', suppliers: [SUPPLIER], itemsCut: false, partial: true,
        items: [{ ...ITEM, posNames: [], inFile: true }, { ...ITEM, name: 'Sentinel  STOUT', posNames: [], inFile: false }],
      },
    });
    const picture = (await proposeOrderSetupTool.run(context({ sent: new Map<string, SentFile>([[REF, { picture: true }]]) }), parsed)).content;
    expect(shownOrderSetup(input, picture)?.read.items.map((item) => item.inFile)).toEqual([null, null]);
  });

  it('is null for a call that showed nothing, an input that fails the check, and a result that is not this tool’s', async () => {
    const parsed = proposeOrderSetupTool.parse(answer(), TODAY);
    if (parsed === null) throw new Error('invalid input');
    const shown = (await proposeOrderSetupTool.run(context(), parsed)).content;
    const refusal = (await proposeOrderSetupTool.run(context({ attached: [] }), parsed)).content;
    expect(shownOrderSetup(answer(), refusal)).toBeNull();
    expect(shownOrderSetup(answer({ ref: 'u_0000000000000000000000a1' }), shown)).toBeNull();
    expect(shownOrderSetup(answer(), 'Shown to the owner as a proposal. They decide the quantity and why.')).toBeNull();
    expect(shownOrderSetup(answer(), [{ type: 'text', text: shown }])).toBeNull();
    expect(shownOrderSetup(answer(), undefined)).toBeNull();
    expect(shownOrderSetup(answer(), shown)).not.toBeNull();
  });
});
