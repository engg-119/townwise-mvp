// Reading the ordering setup with TownwiseAI (spec D39), without a server: the prompt and the answer's schema (no par,
// no never run out), the answer checked again (setupResult), the request (the content and the saved names only, a cut
// said), what it reserves, the input a posted file or pasted text makes (a picture without its metadata, the caps, a
// file told by its bytes), and the model's client over a fake fetch. Synthetic content only.
import { describe, expect, it } from 'vitest';

import { pastedInput, postedSource, prepareInput, READER_INPUT, SETUP_INPUT, type InputSource, type PreparedInput } from '../src/files/extract/input.ts';
import { createAnthropicSetupReaderModel, SETUP_FORMAT } from '../src/files/extract/model.ts';
import { MARKER, type ReaderInput } from '../src/files/extract/reader.ts';
import { CONTENT_IS_DATA, READER_MODEL } from '../src/files/extract/reader-prompt.ts';
import {
  SETUP_ITEMS_MAX, SETUP_MAX_TOKENS, SETUP_SYSTEM_PROMPT, setupResult,
} from '../src/files/extract/setup-prompt.ts';
import { setupCeilingMicroUsd, setupRequest } from '../src/files/extract/setup-reader.ts';
import { pdfOf } from './helpers/pdf.ts';
import { xlsxOf, zipOf } from './helpers/zip.ts';

const ITEM = {
  name: 'Vorlan Brewing IPA', supplier: 'Quillvane Beverage', category: 'draft', unit: 'kegs', servingsPerUnit: 124,
  servingsEstimated: true, dealSize: null, posNames: [{ name: 'Vorlan IPA pint', perSale: 1 }], note: '',
};
const SUPPLIER = { name: 'Quillvane Beverage', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 0, cutoffTime: '14:00' }] };

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'order_guide', confidence: 'high', suppliers: [SUPPLIER], items: [ITEM], itemsCut: false, ...over };
}

const NAMES = { suppliers: ['Quillvane Beverage'], items: ['Vorlan Brewing IPA', 'House Lemonade'] };

describe('the prompt and the answer’s schema', () => {
  it('ask for suppliers and items and never for a par or never run out', () => {
    const schema = SETUP_FORMAT.schema as { required: string[]; additionalProperties: unknown; $defs: Record<string, { required?: string[] }> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(['confidence', 'items', 'itemsCut', 'kind', 'suppliers']);
    const itemShape = Object.values(schema.$defs).find((shape) => shape.required?.includes('servingsEstimated'));
    expect(itemShape?.required?.sort()).toEqual(['category', 'dealSize', 'name', 'note', 'posNames', 'servingsEstimated', 'servingsPerUnit', 'supplier', 'unit']);
    const sent = JSON.stringify(schema);
    expect(sent).not.toMatch(/"par"|neverRunOut|never_run_out/i);
    // Limits the API does not enforce travel as descriptions.
    expect(sent).toContain('{maxItems: 150}');
    expect(sent).not.toContain('"maxLength"');
  });

  it('tell the model the content is data, to name no person and to leave the par and never run out to the owner', () => {
    expect(SETUP_SYSTEM_PROMPT).toContain(CONTENT_IS_DATA.join('\n'));
    expect(SETUP_SYSTEM_PROMPT).toContain('Never write a person\'s name, email address or phone number');
    expect(SETUP_SYSTEM_PROMPT).toContain('Never say how many of an item to keep on hand or whether it may run out');
    expect(SETUP_SYSTEM_PROMPT).toContain('Leave out food, supplies, fees,');
    expect(SETUP_SYSTEM_PROMPT).toContain('a half-barrel keg is about 124');
  });
});

describe('the answer as Townwise answers it', () => {
  it('drops a par and never run out the answer carries, keeping the item', () => {
    const result = setupResult(answer({ items: [{ ...ITEM, par: 4, neverRunOut: true, never_run_out: true }] }), null);
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toEqual({ ...ITEM, inFile: null });
    expect(Object.keys(result?.items[0] ?? {})).not.toContain('par');
    expect(JSON.stringify(result)).not.toMatch(/par"|neverRunOut|never_run_out/);
  });

  it('keeps a field that passes and makes one that does not null, dropping an item, supplier or delivery without what it needs', () => {
    const result = setupResult(answer({
      suppliers: [
        { name: '  ', deliveries: [] },
        { name: 'Brindlewick', deliveries: [{ deliveryWeekday: 9, cutoffWeekday: 1, cutoffTime: '14:00' }, { deliveryWeekday: 4, cutoffWeekday: 8, cutoffTime: '25:00' }] },
      ],
      items: [
        { ...ITEM, name: '' },
        { ...ITEM, name: 'x'.repeat(81) },
        {
          name: ' Odd Lager ', supplier: 42, category: 'wine', unit: 'barrels', servingsPerUnit: 0, servingsEstimated: 'yes', dealSize: 1.5,
          posNames: [{ name: 'Odd', perSale: 0 }, { name: '' }, 'Odd draft'], note: 7,
        },
        { name: 'Bare Cider' },
      ],
    }), null);
    expect(result?.suppliers).toEqual([{ name: 'Brindlewick', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: null, cutoffTime: null }] }]);
    expect(result?.items).toEqual([
      {
        name: 'Odd Lager', supplier: null, category: null, unit: null, servingsPerUnit: null, servingsEstimated: false, dealSize: null,
        posNames: [{ name: 'Odd', perSale: 1 }], note: '', inFile: null,
      },
      {
        name: 'Bare Cider', supplier: null, category: null, unit: null, servingsPerUnit: null, servingsEstimated: false, dealSize: null,
        posNames: [], note: '', inFile: null,
      },
    ]);
    expect(setupResult(answer({ kind: 'recipe', confidence: 'sure' }), null)).toMatchObject({ kind: 'other', confidence: 'low' });
    expect(setupResult('not an answer', null)).toBeNull();
    expect(setupResult(null, null)).toBeNull();
    // A figure the model did not say it read counts as its estimate.
    expect(setupResult(answer({ items: [{ ...ITEM, servingsEstimated: undefined }] }), null)?.items[0]?.servingsEstimated).toBe(true);
  });

  it('keeps the first of each name as the page matches names, the first delivery of each weekday, and each point-of-sale name once', () => {
    const result = setupResult(answer({
      suppliers: [
        { name: 'Quillvane  Beverage', deliveries: [SUPPLIER.deliveries[0], { deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: null }] },
        { name: 'quillvane beverage', deliveries: [] },
      ],
      items: [
        { ...ITEM, supplier: 'QUILLVANE BEVERAGE', posNames: [{ name: 'IPA pint', perSale: 1 }, { name: 'ipa  PINT', perSale: 2 }] },
        { ...ITEM, name: 'vorlan brewing  ipa', unit: 'cases' },
      ],
    }), null);
    expect(result?.suppliers).toEqual([{ name: 'Quillvane  Beverage', deliveries: [SUPPLIER.deliveries[0]] }]);
    expect(result?.items).toHaveLength(1);
    // An item's supplier takes the suggested supplier's spelling.
    expect(result?.items[0]).toMatchObject({ unit: 'kegs', supplier: 'Quillvane  Beverage', posNames: [{ name: 'IPA pint', perSale: 1 }] });
  });

  it('caps suppliers at 20, deliveries at 7, items at 150 and point-of-sale names at 10, and says when items were cut', () => {
    const many = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));
    const result = setupResult(answer({
      suppliers: many(25, (index) => ({ name: `Supplier ${String(index)}`, deliveries: many(9, (day) => ({ deliveryWeekday: day % 7, cutoffWeekday: null, cutoffTime: null })) })),
      items: many(160, (index) => ({ ...ITEM, name: `Item ${String(index)}`, posNames: many(12, (pos) => ({ name: `Item ${String(index)} sale ${String(pos)}`, perSale: 1 })) })),
    }), null);
    expect(result?.suppliers).toHaveLength(20);
    expect(result?.suppliers[0]?.deliveries.map((delivery) => delivery.deliveryWeekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result?.items).toHaveLength(SETUP_ITEMS_MAX);
    expect(result?.items[0]?.posNames).toHaveLength(10);
    expect(result?.itemsCut).toBe(true);
    expect(setupResult(answer(), null)?.itemsCut).toBe(false);
    expect(setupResult(answer({ itemsCut: true }), null)?.itemsCut).toBe(true);
  });

  it('replaces an email address or a phone number in any name or note', () => {
    const result = setupResult(answer({
      suppliers: [{ name: 'Rep pat@example.test', deliveries: [] }],
      items: [{ ...ITEM, name: 'Call 603-555-0142 IPA', posNames: [{ name: 'Tab (802) 555-0199', perSale: 1 }], note: 'Ask rep@example.test first' }],
    }), null);
    expect(JSON.stringify(result)).not.toMatch(/example\.test|555-01/);
    expect(result?.suppliers[0]?.name).toBe('Rep [email]');
    expect(result?.items[0]).toMatchObject({ name: 'Call [phone] IPA', posNames: [{ name: 'Tab [phone]' }], note: 'Ask [email] first' });
  });

  it('says whether each item’s name is written in the content’s text, and nothing for a picture or a PDF with no text', () => {
    const text = 'Item,Pack\nVORLAN  brewing IPA,1/2 bbl\n';
    const result = setupResult(answer({ items: [ITEM, { ...ITEM, name: 'House Lemonade' }] }), text);
    expect(result?.items.map((item) => item.inFile)).toEqual([true, false]);
    expect(setupResult(answer(), null)?.items[0]?.inFile).toBeNull();
    expect(setupResult(answer(), ' \n ')?.items[0]?.inFile).toBeNull();
  });
});

describe('the request', () => {
  const textOf = (request: ReturnType<typeof setupRequest>): string => {
    const content = request.messages[0]?.content;
    const last = Array.isArray(content) ? content.at(-1) : undefined;
    return last?.type === 'text' ? last.text : '';
  };

  it('holds the content and the saved setup’s names, and nothing else', () => {
    const request = setupRequest({ type: 'text', form: 'text', text: 'Vorlan IPA,1/2 bbl', cut: false }, NAMES);
    expect(Object.keys(request).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    expect(request).toMatchObject({ model: READER_MODEL, max_tokens: SETUP_MAX_TOKENS, system: SETUP_SYSTEM_PROMPT });
    expect(request.max_tokens).toBe(20_000);
    expect(request.messages).toHaveLength(1);
    expect(textOf(request)).toBe([
      'Townwise wrote these lists from the saved setup.',
      'Suppliers already in the setup: ["Quillvane Beverage"]',
      'Items already in the setup: ["Vorlan Brewing IPA","House Lemonade"]',
      'The file is text: a text or CSV file, or text the person pasted.',
      `Everything after the line "${MARKER}", to the end of this message, is the file's content.`,
      MARKER,
      'Vorlan IPA,1/2 bbl',
    ].join('\n'));
    expect(textOf(setupRequest({ type: 'text', form: 'text', text: 'x', cut: false }, { suppliers: [], items: [] })))
      .toMatch(/^The setup has no suppliers or items yet\.\n/);
  });

  it('sends a PDF as a document and a picture as an image, before the words', () => {
    const pdf = setupRequest({ type: 'pdf', base64: 'JVBERi0=' }, NAMES).messages[0]?.content;
    expect(Array.isArray(pdf) ? pdf[0] : null).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } });
    const picture = setupRequest({ type: 'image', mediaType: 'image/png', base64: 'iVBORw==' }, NAMES);
    const content = picture.messages[0]?.content;
    expect(Array.isArray(content) ? content[0] : null).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
    expect(textOf(picture)).toContain('The file is the picture above.');
    expect(textOf(picture)).not.toContain(MARKER);
  });

  it('says when the text was cut, and that it may hold more items', () => {
    const cut = textOf(setupRequest({ type: 'text', form: 'workbook', text: 'Sheet: A', cut: true }, NAMES));
    expect(cut).toContain('It was too long to send whole, so only its start follows (at most 100,000 characters), and it may hold more items than you can see.');
    expect(cut).toContain('an Excel workbook, made into text');
    expect(textOf(setupRequest({ type: 'text', form: 'text', text: 'x', cut: false }, NAMES))).not.toContain('too long');
  });

  it('reserves every output token, its words at a token for three characters, a PDF’s pages (30 when not known) and a picture, at the dearest prices', () => {
    const input: ReaderInput = { type: 'text', form: 'text', text: 'x'.repeat(30_000), cut: false };
    const request = setupRequest(input, NAMES);
    const chars = SETUP_SYSTEM_PROMPT.length + textOf(request).length;
    // $25 a million output tokens and $5 a million input tokens: 25 and 5 micro-dollars a token.
    expect(setupCeilingMicroUsd(request, input, null)).toBe(20_000 * 25 + Math.ceil(chars / 3) * 5);
    const pdf: ReaderInput = { type: 'pdf', base64: '' };
    const pdfChars = SETUP_SYSTEM_PROMPT.length + textOf(setupRequest(pdf, NAMES)).length;
    expect(setupCeilingMicroUsd(setupRequest(pdf, NAMES), pdf, 12)).toBe(20_000 * 25 + (12 * 3000 + Math.ceil(pdfChars / 3)) * 5);
    expect(setupCeilingMicroUsd(setupRequest(pdf, NAMES), pdf, null)).toBe(20_000 * 25 + (30 * 3000 + Math.ceil(pdfChars / 3)) * 5);
    const picture: ReaderInput = { type: 'image', mediaType: 'image/png', base64: '' };
    const pictureChars = SETUP_SYSTEM_PROMPT.length + textOf(setupRequest(picture, NAMES)).length;
    expect(setupCeilingMicroUsd(setupRequest(picture, NAMES), picture, null)).toBe(20_000 * 25 + (5000 + Math.ceil(pictureChars / 3)) * 5);
  });
});

// A PNG: its signature, then chunks (a length, a type, the data, a CRC nothing here checks).
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function pngOf(width: number, height: number, extra: Buffer[] = [], pixels = Buffer.from('Sentinel-pixels')): Buffer {
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', Buffer.concat([size, Buffer.from([8, 2, 0, 0, 0])])), ...extra,
    pngChunk('IDAT', pixels), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function prepared(claimed: Parameters<typeof postedSource>[0], bytes: Buffer): Promise<PreparedInput | string> {
  const source = postedSource(claimed, bytes);
  return typeof source === 'string' ? source : prepareInput(source, SETUP_INPUT);
}

describe('the input', () => {
  it('cuts pasted text at 100,000 characters and says so', () => {
    const long = pastedInput('a'.repeat(150_000), SETUP_INPUT);
    expect(long).toMatchObject({ kind: 'input', partial: true, pages: null });
    if (long.kind !== 'input' || long.input.type !== 'text') throw new Error('no text');
    expect(long.input).toMatchObject({ form: 'text', cut: true });
    expect(long.input.text).toHaveLength(100_000);
    expect(long.sourceText).toBe(long.input.text);
    expect(pastedInput('Vorlan IPA', SETUP_INPUT)).toEqual({
      kind: 'input', input: { type: 'text', form: 'text', text: 'Vorlan IPA', cut: false }, sourceText: 'Vorlan IPA', partial: false, pages: null,
    });
  });

  it('sends a picture without its metadata, and refuses one over 8,000 pixels a side or 3.75 MB, or whose bytes don’t parse', async () => {
    const tagged = pngOf(40, 30, [pngChunk('tEXt', Buffer.from('Author\0Sentinel-metadata')), pngChunk('eXIf', Buffer.from('Sentinel-gps'))]);
    const sent = await prepared('picture', tagged);
    if (typeof sent === 'string' || sent.kind !== 'input' || sent.input.type !== 'image') throw new Error('no picture');
    expect(sent.input.mediaType).toBe('image/png');
    const bytes = Buffer.from(sent.input.base64, 'base64');
    expect(bytes.toString('latin1')).not.toMatch(/Sentinel-metadata|Sentinel-gps/);
    expect(bytes).toEqual(pngOf(40, 30));
    expect(sent).toMatchObject({ sourceText: null, partial: false });
    expect(await prepared('picture', pngOf(8001, 10))).toEqual({ kind: 'skip', reason: 'too_large' });
    expect(await prepared('picture', pngOf(10, 10, [], Buffer.alloc(3_750_001)))).toEqual({ kind: 'skip', reason: 'too_large' });
    expect(await prepared('picture', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('not a picture')]))).toEqual({ kind: 'skip', reason: 'not_readable' });
    // D34's reader still sends a picture byte for byte.
    const asIs: InputSource = { kind: 'other', sizeBytes: tagged.length, name: 'photo.png', read: (count) => Promise.resolve(count === undefined ? tagged : tagged.subarray(0, count)) };
    const d34 = await prepareInput(asIs, READER_INPUT);
    expect(d34.kind === 'input' && d34.input.type === 'image' ? d34.input.base64 : null).toBe(tagged.toString('base64'));
  });

  it('tells a posted file’s kind by its bytes: a ZIP, old Office, a password, a HEIC picture or bytes of another kind are refused', () => {
    const zip = zipOf([{ name: 'notes.txt', data: 'Vorlan IPA' }]);
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
    const pdf = pdfOf([{ texts: [{ text: 'Vorlan IPA', x: 72, y: 700 }] }]);
    expect(postedSource('text', zip)).toBe('kind_not_read');
    expect(postedSource('pdf', zip)).toBe('kind_not_read');
    expect(postedSource('xlsx', ole)).toBe('encrypted');
    expect(postedSource('docx', ole)).toBe('encrypted');
    expect(postedSource('text', ole)).toBe('mismatch');
    expect(postedSource('picture', Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1'))).toBe('kind_not_read');
    expect(postedSource('xlsx', pdf)).toBe('mismatch');
    expect(postedSource('pdf', pngOf(1, 1))).toBe('mismatch');
    expect(postedSource('text', Buffer.from([0x41, 0x00, 0x42]))).toBe('mismatch');
    expect(postedSource('picture', Buffer.from('Vorlan IPA'))).toBe('mismatch');
    for (const [claimed, bytes, kind] of [['pdf', pdf, 'pdf'], ['xlsx', zip, 'xlsx'], ['docx', zip, 'docx'], ['text', Buffer.from('a,b'), 'text'], ['picture', pngOf(1, 1), 'other']] as const) {
      const source = postedSource(claimed, bytes);
      expect(typeof source === 'string' ? source : source.kind).toBe(kind);
    }
  });

  it('reads a workbook as text and a PDF whole, refusing one over 30 pages', async () => {
    const book = await prepared('xlsx', xlsxOf([{ name: 'Guide', rows: [['Item', 'Pack'], ['Vorlan IPA', '1/2 bbl']] }]));
    expect(book).toMatchObject({ kind: 'input', input: { type: 'text', form: 'workbook', cut: false }, partial: false });
    if (typeof book !== 'string' && book.kind === 'input' && book.input.type === 'text') expect(book.input.text).toContain('Vorlan IPA\t1/2 bbl');
    const page = { texts: [{ text: 'Vorlan IPA 1/2 bbl', x: 72, y: 700 }] };
    const thirty = await prepared('pdf', pdfOf(Array.from({ length: 30 }, () => page)));
    expect(thirty).toMatchObject({ kind: 'input', input: { type: 'pdf' }, pages: 30 });
    if (typeof thirty !== 'string' && thirty.kind === 'input') expect(thirty.sourceText).toContain('Vorlan IPA');
    expect(await prepared('pdf', pdfOf(Array.from({ length: 31 }, () => page)))).toEqual({ kind: 'skip', reason: 'too_large' });
    expect(await prepared('xlsx', zipOf([{ name: 'notes.txt', data: 'x' }]))).toMatchObject({ kind: 'skip' });
  });
});

describe('the model’s client', () => {
  const sse = (event: Record<string, unknown>): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  const stream = (text: string): string => [
    sse({
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } }),
    sse({ type: 'message_stop' }),
  ].join('');

  it('streams the request at low effort with the setup’s schema and the refusal fallback, and answers its JSON and cost', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      return Promise.resolve(new Response(stream(JSON.stringify(answer())), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };
    const request = setupRequest({ type: 'text', form: 'text', text: 'Vorlan IPA', cut: false }, NAMES);
    // $4 a million input tokens, $20 a million output tokens: 4,000 + 4,000.
    expect(await createAnthropicSetupReaderModel('test-key', fetch).readFile(request, new AbortController().signal))
      .toEqual({ kind: 'answered', output: answer(), costMicroUsd: 8000 });
    expect(bodies).toEqual([{
      model: 'claude-opus-5-5', max_tokens: 20_000, system: SETUP_SYSTEM_PROMPT, messages: request.messages,
      output_config: { effort: 'low', format: SETUP_FORMAT }, fallbacks: 'default', stream: true,
    }]);
  });

  describe('a call that ends before its answer', () => {
    const start = (model = 'claude-opus-5-5'): string => sse({
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const textDelta = (text: string): string => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    const aborted = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');
    /** A stream that sends `events`, then stays open until the call's signal ends it, as the API's does mid-answer. */
    const hanging = (events: string): typeof globalThis.fetch => (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events));
          init?.signal?.addEventListener('abort', () => { controller.error(aborted()); }, { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };
    const request = setupRequest({ type: 'text', form: 'text', text: 'Vorlan IPA', cut: false }, NAMES);
    async function readUntilAborted(fetch: typeof globalThis.fetch): Promise<unknown> {
      const left = new AbortController();
      const pending = createAnthropicSetupReaderModel('test-key', fetch).readFile(request, left.signal);
      await new Promise((resolve) => setTimeout(resolve, 50));
      left.abort();
      return pending;
    }

    it('says what the stream had reported: the input tokens from message_start and the output streamed, a token for every 3 characters', async () => {
      const fetch = hanging(start() + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + textDelta('x'.repeat(1500)) + textDelta('y'.repeat(1500)));
      // 1,000 input tokens at $4 a million (4,000) and 3,000 characters as 1,000 output tokens at $20 a million (20,000).
      expect(await readUntilAborted(fetch)).toEqual({ kind: 'failed', errType: 'APIUserAbortError', status: null, streamedMicroUsd: 24_000 });
    });

    it('prices it at the answering model’s rates once a refusal fallback takes over', async () => {
      const fallback = sse({
        type: 'content_block_start', index: 0,
        content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } },
      });
      const fetch = hanging(start() + fallback + sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
        + sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'z'.repeat(3000) } }));
      // At $5 and $25 a million: 5,000 + 25,000.
      expect(await readUntilAborted(fetch)).toEqual({ kind: 'failed', errType: 'APIUserAbortError', status: null, streamedMicroUsd: 30_000 });
    });

    it('says nothing when it ends before any stream event, aborted or refused by the API', async () => {
      const waiting: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(aborted()); }, { once: true });
      });
      expect(await readUntilAborted(waiting)).toEqual({ kind: 'failed', errType: 'APIUserAbortError', status: null });
      const refused: typeof globalThis.fetch = () => Promise.resolve(new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Zqxj' } }), { status: 400, headers: { 'content-type': 'application/json' } },
      ));
      expect(await createAnthropicSetupReaderModel('test-key', refused).readFile(request, new AbortController().signal))
        .toEqual({ kind: 'failed', errType: 'BadRequestError', status: 400 });
    });
  });
});
