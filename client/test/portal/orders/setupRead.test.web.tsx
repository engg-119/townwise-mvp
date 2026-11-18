import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { ApiError } from '../../../src/api/client';
import type { OrderSetup, OrderSetupAnswer, SetupRead } from '../../../src/portal/orders/api';
import { onlyLinks, readKindOf } from '../../../src/portal/orders/setupReadWords';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, deferred, EMAIL, fakePortalApi, meOf, orgOf, refusal, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { analyticsFake } from '../analytics/fakes';

// Reading the ordering setup with TownwiseAI on the web (D41, P31), through the whole app: shown only while the setup's
// canReadWithAi holds; a chosen file goes as its kind and bytes, never its name, and pasted text as the text; the answer
// merges into the unsaved draft and the summary says what to set and check; Cancel adds nothing; every refusal is said
// in plain words; files over the caps are refused before anything is sent; view-as disables it in place. Every supplier
// and item here is synthetic.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

jest.setTimeout(20_000);

afterEach(() => { cleanup(); });

const ROUTE = '/locations/l1/orders/setup';
const PATH = '/api/org/locations/l1/orders';
const SUPPLIER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const LAGER_ID = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const FILE_NAME = 'Qzxv private order guide.pdf';
const HEADING = 'Read a file with TownwiseAI';

const SETUP: OrderSetup = {
  version: 3,
  updatedAt: '2026-11-10T15:00:00.000Z',
  suppliers: [{ id: SUPPLIER_ID, name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
  items: [{
    id: LAGER_ID, name: 'Sample Lager', supplierId: SUPPLIER_ID, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 4,
    dealSize: 5, neverRunOut: true, posNames: [{ name: 'Lager Can', perSale: 1 }],
  }],
};

const ANSWER: OrderSetupAnswer = {
  today: '2026-11-13', setup: SETUP, coverage: null, itemCoverage: {}, counts: {}, itemsWithHistory: [], canReadWithAi: true,
};

const READ: SetupRead = {
  kind: 'invoice',
  confidence: 'high',
  suppliers: [{ name: 'Sample Brewery', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '09:00' }] }],
  items: [
    {
      name: 'Sample Lager', supplier: null, category: null, unit: null, servingsPerUnit: 30, servingsEstimated: false, dealSize: null,
      posNames: [], note: '', inFile: true,
    },
    {
      name: 'Sample IPA', supplier: 'Sample Brewery', category: 'draft', unit: 'kegs', servingsPerUnit: 124, servingsEstimated: true,
      dealSize: null, posNames: [], note: 'A half-barrel holds about 124 pints.', inFile: false,
    },
    {
      name: 'Sample Gin', supplier: 'Sample Brewery', category: 'liquor', unit: 'bottles', servingsPerUnit: 17, servingsEstimated: false,
      dealSize: 0, posNames: [], note: '', inFile: true,
    },
  ],
  itemsCut: false,
  partial: false,
};

function portal(options: { answer?: OrderSetupAnswer; me?: ReturnType<typeof meOf> } = {}): FakePortalApi {
  return fakePortalApi({
    me: options.me ?? meOf(ACCESS.member), org: orgOf('member'), fallback: analyticsFake({ [`${PATH}/setup`]: options.answer ?? ANSWER }),
  });
}

function renderAt(api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', ROUTE);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={ROUTE} />
    </Head.Provider>,
  );
}

async function settle(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

function click(name: string): Promise<void> {
  return settle(() => { fireEvent.click(screen.getByRole('button', { name })); });
}

async function pick(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[data-testid="setup-read-file"]');
  if (input === null) throw new Error('no setup-read-file input');
  await settle(() => { fireEvent.change(input, { target: { files: [file] } }); });
}

/** A file of `size` bytes as the page sees it, without holding them. */
function sized(name: string, size: number): File {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function reads(api: FakePortalApi): unknown[] {
  return writes(api).filter((call) => call.path === `${PATH}/setup/read`).map((call) => call.body);
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

test('the section shows only while the setup says TownwiseAI can read for it', async () => {
  renderAt(portal({ answer: { ...ANSWER, canReadWithAi: false } }));
  await screen.findByRole('region', { name: 'Item 1' });
  expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Choose a file' })).toBeNull();
  expect(document.querySelector('input[data-testid="setup-read-file"]')).toBeNull();
  cleanup();

  renderAt(portal());
  expect(await screen.findByRole('heading', { name: HEADING })).toBeTruthy();
  const main = screen.getByRole('main').textContent;
  expect(main).toContain('Pressing Read sends it once to Anthropic’s Claude, with the names of the suppliers and items already here; Townwise doesn’t keep it. TownwiseAI never sets a par or never run out, and nothing saves until you save the setup.');
  expect(main).toContain('A register export read this way sends its item names and quantities to Anthropic. The item sales upload below reads an export in your browser and never sends them.');
  expect(screen.getByRole('link', { name: 'How Townwise handles your data' }).getAttribute('href')).toBe('/privacy');
  expect(screen.getByRole('button', { name: 'Read the text' }).getAttribute('aria-disabled')).toBe('true');
});

test('a chosen file goes as its kind and bytes, never its name; the answer fills the unsaved draft and the summary says what to do', async () => {
  const api = portal();
  api.answers[`${PATH}/setup/read`] = () => ({ read: READ });
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();
  await pick(new File(['%PDF-1.4 synthetic'], FILE_NAME, { type: 'application/pdf' }));
  expect(screen.getByText(`Chosen: ${FILE_NAME}, 1 KB.`)).toBeTruthy();
  await click('Read the file');
  await screen.findByText(/^TownwiseAI found 3 items/);

  expect(reads(api)).toEqual([{ source: { type: 'file', kind: 'pdf', data: btoa('%PDF-1.4 synthetic') } }]);
  const sent = JSON.stringify(api.calls);
  expect(sent).not.toContain('Qzxv');
  expect(sent).not.toContain('order guide');
  const summary = screen.getAllByRole('status').map((line) => line.textContent);
  expect(summary).toEqual(expect.arrayContaining([
    'TownwiseAI found 3 items: 1 new, 1 replaced by name. Nothing is saved yet: check them below, then save the setup.',
    'Set the par of the new item.',
    'The replaced item keeps its par and never run out, and its own values where TownwiseAI left a field blank.',
    'Check the servings per unit of 1 item: TownwiseAI estimated it.',
    'TownwiseAI didn’t find 1 of these names in the file: check it.',
    'Added 1 supplier with the delivery days TownwiseAI found: Sample Brewery (Tuesday). Check each delivery’s order-by day and time.',
    'Left out 1 item that failed a check:',
  ]));
  expect(screen.getByText('Item 3, Sample Gin: Its deal size isn’t a whole number from 1 to 999.')).toBeTruthy();

  // The replaced item kept its par and never run out, and took the suggested servings.
  const lager = region('Item 1');
  expect(within(lager).getByRole('textbox', { name: 'Par' })).toHaveProperty('value', '4');
  expect(within(lager).getByRole('checkbox', { name: 'Never run out' })).toHaveProperty('checked', true);
  expect(within(lager).getByRole('textbox', { name: 'Servings per unit' })).toHaveProperty('value', '30');
  const ipa = region('Item 2');
  expect(within(ipa).getByRole('textbox', { name: 'Item name' })).toHaveProperty('value', 'Sample IPA');
  expect(within(ipa).getByRole('textbox', { name: 'Par' })).toHaveProperty('value', '');
  expect(within(region('Supplier 2')).getByRole('textbox', { name: 'Supplier name' })).toHaveProperty('value', 'Sample Brewery');
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  expect(writes(api).filter((call) => call.method === 'PUT')).toEqual([]);
  // The file is no longer chosen, so a second press can't send it again by accident.
  expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();

  // Save names the new item's empty par.
  await click('Save the setup');
  expect(within(region('Item 2')).getByText('Enter a whole number from 0 to 999.')).toBeTruthy();
  expect(writes(api).filter((call) => call.method === 'PUT')).toEqual([]);
});

test('pasted text goes as the text; while TownwiseAI reads the page says so with Cancel, and Cancel adds nothing', async () => {
  const api = portal();
  const answer = deferred<unknown>();
  api.answers[`${PATH}/setup/read`] = () => answer.promise;
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  fireEvent.change(screen.getByRole('textbox', { name: 'Or paste text' }), { target: { value: 'Sample IPA, 1 half-barrel, Tuesdays' } });
  await click('Read the text');
  expect(screen.getByText('TownwiseAI is reading the text. This can take up to three minutes.')).toBeTruthy();
  expect(reads(api)).toEqual([{ source: { type: 'text', text: 'Sample IPA, 1 half-barrel, Tuesdays' } }]);
  expect(screen.getByRole('button', { name: 'Read the text' }).getAttribute('aria-disabled')).toBe('true');
  await click('Cancel');
  expect(screen.getByText('Stopped. Nothing was added to the setup.')).toBeTruthy();
  await settle(() => { answer.resolve({ read: READ }); });
  expect(screen.queryByRole('region', { name: 'Item 2' })).toBeNull();
  expect(screen.getByText('No unsaved changes.')).toBeTruthy();
  // The text stays for another try.
  expect(screen.getByRole('textbox', { name: 'Or paste text' })).toHaveProperty('value', 'Sample IPA, 1 half-barrel, Tuesdays');
});

test('a saved email, a web page, JSON, Markdown or rich text goes as text', () => {
  for (const name of ['rep.eml', 'prices.html', 'export.json', 'notes.md', 'guide.rtf']) {
    expect(readKindOf({ name, size: 10 })).toEqual({ kind: 'text' });
  }
});

test('pasted text that is only links is refused before anything is sent: TownwiseAI opens no links', async () => {
  const api = portal();
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  fireEvent.change(screen.getByRole('textbox', { name: 'Or paste text' }), { target: { value: ' https://docs.google.com/spreadsheets/d/sample/edit ' } });
  await click('Read the text');
  expect(screen.getByRole('alert').textContent).toBe('TownwiseAI can’t open links. Download the sheet or page as a file and choose it, or paste what it says.');
  expect(reads(api)).toEqual([]);
  // Text with a link in it is still read.
  expect(onlyLinks('Order guide at https://example.com: Sample IPA, Tuesdays')).toBe(false);
});

test('each refusal from the API is said in plain words, as an alert', async () => {
  const api = portal();
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  fireEvent.change(screen.getByRole('textbox', { name: 'Or paste text' }), { target: { value: 'Sample IPA' } });
  const cases: [ApiError, string][] = [
    [refusal(409, 'files_ai_budget_exhausted'), 'Your organization’s TownwiseAI budget for reading files is spent for this month.'],
    [refusal(503, 'ai_unavailable'), 'TownwiseAI can’t read files right now. Try again later.'],
    [refusal(503, 'extract_busy', 5), 'TownwiseAI is reading other files right now. Try again in a moment.'],
    [refusal(400, 'extract_too_large'), 'That’s more than TownwiseAI reads: a file of up to 5 MB, a PDF of up to 30 pages, and a picture of up to 3.75 MB and 8,000 pixels a side.'],
    [refusal(400, 'extract_kind_mismatch'), 'That file isn’t the kind its name says. Save it again in its own format and choose it again.'],
    [refusal(400, 'extract_encrypted'), 'That file has a password, or it’s an old Excel (.xls) or Word (.doc) file. Save a copy without a password, or as .xlsx or .docx, and choose it again.'],
    [refusal(422, 'extract_refused'), 'TownwiseAI declined to read this.'],
    [refusal(422, 'extract_answer_too_long'), 'TownwiseAI couldn’t finish: what it found was too long to write down. Try a shorter file, such as one supplier’s order guide.'],
    [refusal(503, 'extract_failed'), 'TownwiseAI couldn’t finish reading this. Try again in a minute.'],
    [refusal(503, 'extract_timed_out'), 'TownwiseAI took too long to read this. Try a shorter file, or paste part of it.'],
    [refusal(413, 'payload_too_large'), 'That’s more than TownwiseAI reads at once. Choose a smaller file or paste less text.'],
    [new ApiError('timeout', 'The request timed out.'), 'TownwiseAI took too long to answer. Try again, or try a shorter file or less text.'],
    [refusal(429, 'rate_limited', 1200), 'TownwiseAI has read as much as it can for now. Try again in 20 minutes.'],
  ];
  for (const [error, words] of cases) {
    api.answers[`${PATH}/setup/read`] = () => error;
    await click('Read the text');
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(words); });
  }
  expect(screen.queryByRole('region', { name: 'Item 2' })).toBeNull();
});

test('a file over the caps, an old Excel file or two files at once are refused in the browser with the cap in words', async () => {
  const api = portal();
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  const refusals: [File, string][] = [
    [sized('photo.jpg', 3_750_001), 'That picture is larger than 3.75 MB, the most TownwiseAI reads. Save a smaller copy and choose it again.'],
    [sized('guide.pdf', 5 * 1024 * 1024 + 1), 'That file is larger than 5 MB, the most TownwiseAI reads at once.'],
    [sized('guide.xls', 10), 'TownwiseAI can’t read old Excel files (.xls). Save it as .xlsx and choose it again.'],
    [sized('guides.zip', 10), 'TownwiseAI reads one file at a time, not a ZIP. Choose a file from inside it.'],
    [sized('empty.csv', 0), 'That file is empty.'],
    [sized('IMG_0412.HEIC', 10), 'TownwiseAI can’t read HEIC photos, the kind an iPhone saves. Take a screenshot of the photo, or save it as a JPEG, and choose that.'],
    [sized('scan.tiff', 10), 'TownwiseAI can’t read TIFF pictures. Save it as a PNG or JPEG and choose it again.'],
    [sized('guide.pages', 10), 'TownwiseAI can’t read Pages files. Export it as PDF or Word and choose it again.'],
    [sized('clip.mov', 10), 'TownwiseAI can’t read this kind of file. It reads PDFs, Excel (.xlsx) and Word (.docx) files, CSV, text, web page and saved email files, and PNG, JPEG, GIF or WebP pictures. You can also paste the text.'],
  ];
  for (const [file, words] of refusals) {
    await pick(file);
    expect(screen.getByRole('alert').textContent).toBe(words);
    expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();
  }
  const zone = screen.getByText(/^Drop a file here, or choose one/);
  await settle(() => { fireEvent.drop(zone, { dataTransfer: { types: ['Files'], items: [{}, {}], files: [sized('a.pdf', 10), sized('b.pdf', 10)] } }); });
  expect(screen.getByRole('alert').textContent).toBe('TownwiseAI reads one file at a time. Choose just one.');
  // One dropped file is chosen; nothing is sent until Read.
  await settle(() => { fireEvent.drop(zone, { dataTransfer: { types: ['Files'], items: [{}], files: [sized('guide.xlsx', 10)] } }); });
  expect(screen.getByText('Chosen: guide.xlsx, 1 KB.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Read the file' })).toBeTruthy();
  expect(reads(api)).toEqual([]);
});

test('view-as: the section is disabled in place, described by the read-only line, with no file input and no drop', async () => {
  const api = portal({ me: viewAsMe(ACCESS.member) });
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  const line = screen.getByText(/^Read-only while viewing as /);
  const lineId = line.getAttribute('id');
  expect(lineId).toBeTruthy();
  for (const name of ['Choose a file', 'Read the text']) {
    const control = screen.getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toContain(lineId);
  }
  const paste = screen.getByRole('textbox', { name: 'Or paste text' });
  expect(paste.getAttribute('aria-readonly')).toBe('true');
  expect(paste.getAttribute('aria-describedby')).toContain(lineId);
  expect(document.querySelector('input[data-testid="setup-read-file"]')).toBeNull();
  await settle(() => {
    fireEvent.drop(screen.getByText(/^Drop a file here, or choose one/), { dataTransfer: { types: ['Files'], items: [{}], files: [sized('guide.pdf', 10)] } });
  });
  expect(screen.queryByText(/^Chosen:/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();
  expect(writes(api)).toEqual([]);
});

/** The text of everything a field's aria-describedby names. */
function description(field: HTMLElement): string {
  return (field.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

/** The saved setup as the server answers a PUT: the sent rows, new ones with minted ids. */
function stored(body: unknown): { setup: OrderSetup } {
  const { setup } = body as { setup: { suppliers: ({ id?: string; key?: string } & Record<string, unknown>)[]; items: ({ id?: string; supplierId: string } & Record<string, unknown>)[] } };
  const ids = new Map<string, string>();
  const suppliers = setup.suppliers.map(({ key, id, ...rest }, index) => {
    const minted = id ?? `ccccccccccccccccccccccc${String(index)}`;
    ids.set(key ?? minted, minted);
    return { ...rest, id: minted };
  });
  const items = setup.items.map(({ id, ...rest }, index) => ({ ...rest, id: id ?? `ddddddddddddddddddddddd${String(index)}`, supplierId: ids.get(rest.supplierId) ?? rest.supplierId }));
  return { setup: { version: 4, updatedAt: '2026-11-13T17:00:00.000Z', suppliers, items } as OrderSetup };
}

test('an estimated servings value and a name not in the file take their field’s helper, tied by aria-describedby, until an edit or a save', async () => {
  const api = portal();
  // The replaced item's name is marked too: it keeps its id, so only the save clears its mark.
  api.answers[`${PATH}/setup/read`] = () => ({ read: { ...READ, items: READ.items.map((item, i) => (i === 0 ? { ...item, inFile: false } : item)) } });
  api.answers[`${PATH}/setup`] = stored;
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  await pick(new File(['%PDF-1.4 synthetic'], FILE_NAME, { type: 'application/pdf' }));
  await click('Read the file');
  await screen.findByText(/^TownwiseAI found 3 items/);

  const ipa = region('Item 2');
  const servings = within(ipa).getByRole('textbox', { name: 'Servings per unit' });
  const name = within(ipa).getByRole('textbox', { name: 'Item name' });
  expect(description(servings)).toBe('TownwiseAI estimated this: A half-barrel holds about 124 pints. Check it.');
  expect(description(name)).toBe('TownwiseAI didn’t find this name in the file. Check it.');
  expect(within(ipa).queryByText(/^How many servings one unit holds/)).toBeNull();
  // The replaced item's servings weren't estimated, so its field keeps its usual helper.
  expect(description(within(region('Item 1')).getByRole('textbox', { name: 'Servings per unit' }))).toMatch(/^How many servings one unit holds/);
  expect(description(within(region('Item 1')).getByRole('textbox', { name: 'Item name' }))).toBe('TownwiseAI didn’t find this name in the file. Check it.');

  // An edit clears that field's mark only.
  fireEvent.change(servings, { target: { value: '120' } });
  expect(description(within(region('Item 2')).getByRole('textbox', { name: 'Servings per unit' }))).toMatch(/^How many servings one unit holds/);
  expect(description(within(region('Item 2')).getByRole('textbox', { name: 'Item name' }))).toBe('TownwiseAI didn’t find this name in the file. Check it.');

  // A save the checks stop keeps the marks; a save that goes through clears them.
  await click('Save the setup');
  expect(within(region('Item 2')).getByText('Enter a whole number from 0 to 999.')).toBeTruthy();
  expect(description(within(region('Item 2')).getByRole('textbox', { name: 'Item name' }))).toContain('TownwiseAI didn’t find this name in the file. Check it.');
  fireEvent.change(within(region('Item 2')).getByRole('textbox', { name: 'Par' }), { target: { value: '1' } });
  await click('Save the setup');
  await screen.findByText('Saved the ordering setup.');
  expect(description(within(region('Item 1')).getByRole('textbox', { name: 'Item name' }))).toBe('');
  expect(description(within(region('Item 2')).getByRole('textbox', { name: 'Item name' }))).toBe('');
  expect(within(region('Item 2')).getByRole('textbox', { name: 'Item name' })).toHaveProperty('value', 'Sample IPA');
});

test('an answer that comes while a save runs merges into the saved setup once it is saved, instead of being lost', async () => {
  const api = portal();
  const answer = deferred<unknown>();
  const put = deferred<unknown>();
  api.answers[`${PATH}/setup/read`] = () => answer.promise;
  api.answers[`${PATH}/setup`] = (body) => put.promise.then(() => stored(body));
  renderAt(api);
  await screen.findByRole('heading', { name: HEADING });
  fireEvent.change(screen.getByRole('textbox', { name: 'Or paste text' }), { target: { value: 'Sample IPA, 1 half-barrel' } });
  await click('Read the text');
  fireEvent.change(within(region('Item 1')).getByRole('textbox', { name: 'Par' }), { target: { value: '6' } });
  await click('Save the setup');
  await settle(() => { answer.resolve({ read: READ }); });
  expect(screen.queryByRole('region', { name: 'Item 2' })).toBeNull();
  await settle(() => { put.resolve(null); });
  await screen.findByText(/^TownwiseAI found 3 items/);
  expect(writes(api).filter((call) => call.method === 'PUT')).toHaveLength(1);
  expect(within(region('Item 1')).getByRole('textbox', { name: 'Par' })).toHaveProperty('value', '6');
  expect(within(region('Item 2')).getByRole('textbox', { name: 'Item name' })).toHaveProperty('value', 'Sample IPA');
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
});
