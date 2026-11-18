jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
// The app cache as the picker leaves it: each copy's base64 by its uri, and the copies deleted.
const mockCache = new Map<string, string>();
const mockDeleted: string[] = [];
const mockBase64Reads: string[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///document' },
  File: class {
    readonly uri: string;
    constructor(...parts: string[]) { this.uri = parts.join('/'); }
    get exists(): boolean { return mockCache.has(this.uri); }
    get size(): number { return mockCache.get(this.uri)?.length ?? 0; }
    create(): void { mockCache.set(this.uri, ''); }
    base64(): Promise<string> {
      mockBase64Reads.push(this.uri);
      const data = mockCache.get(this.uri);
      return data === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(data);
    }
    delete(): void {
      mockDeleted.push(this.uri);
      mockCache.delete(this.uri);
    }
  },
}));

import { getDocumentAsync as realGetDocumentAsync, type DocumentPickerResult } from 'expo-document-picker';
import { cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import type { OrderSetupAnswer, SetupRead } from '../../../src/portal/orders/api';
import { ACCESS, deferred, fakePortalApi, meOf, orgOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { analyticsFake } from '../analytics/fakes';

const getDocumentAsync = jest.mocked(realGetDocumentAsync);

// Reading the ordering setup with TownwiseAI in the iOS and Android apps (D41, P31): the system picker's copy is
// checked by its name and size before anything is read; a chosen file goes as its kind and base64, never its name or
// where it is, and the copy is deleted; pasted text goes as the text; Cancel adds nothing; a HEIC photo is refused,
// since the converter is web only; view-as disables it in place and never opens the picker. Every supplier, item and
// file here is synthetic.

jest.setTimeout(20_000);

afterEach(async () => {
  await cleanup();
  getDocumentAsync.mockReset();
  mockCache.clear();
  mockDeleted.length = 0;
  mockBase64Reads.length = 0;
});

const ROUTE = '/locations/l1/orders/setup';
const PATH = '/api/org/locations/l1/orders';
const SUPPLIER_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const LAGER_ID = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const FILE_NAME = 'Qzxv private order guide.pdf';
const CACHE = 'file:///cache/DocumentPicker';
const HEADING = 'Read a file with TownwiseAI';
const BYTES = 'JVBERi0xLjQgc3ludGhldGlj';

const ANSWER: OrderSetupAnswer = {
  today: '2026-11-13',
  setup: {
    version: 3,
    updatedAt: '2026-11-10T15:00:00.000Z',
    suppliers: [{ id: SUPPLIER_ID, name: 'Sample Distributor', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 2, cutoffTime: '14:00' }] }],
    items: [{
      id: LAGER_ID, name: 'Sample Lager', supplierId: SUPPLIER_ID, category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 4,
      dealSize: 5, neverRunOut: true, posNames: [{ name: 'Lager Can', perSale: 1 }],
    }],
  },
  coverage: null,
  itemCoverage: {},
  counts: {},
  itemsWithHistory: [],
  canReadWithAi: true,
};

const READ: SetupRead = {
  kind: 'invoice',
  confidence: 'high',
  suppliers: [],
  items: [{
    name: 'Sample IPA', supplier: 'Sample Distributor', category: 'draft', unit: 'kegs', servingsPerUnit: 124, servingsEstimated: false,
    dealSize: null, posNames: [], note: '', inFile: true,
  }],
  itemsCut: false,
  partial: false,
};

function portal(options: { answer?: OrderSetupAnswer; me?: ReturnType<typeof meOf> } = {}): FakePortalApi {
  return fakePortalApi({
    me: options.me ?? meOf(ACCESS.member), org: orgOf('member'), fallback: analyticsFake({ [`${PATH}/setup`]: options.answer ?? ANSWER }),
  });
}

/** The picker answers with one file of `size` bytes, copied into the cache. */
function picks(name: string, size: number, data = BYTES): string {
  const uri = `${CACHE}/${String(mockCache.size + 1)}-${name}`;
  mockCache.set(uri, data);
  const result: DocumentPickerResult = { canceled: false, assets: [{ name, size, uri, mimeType: 'application/octet-stream', lastModified: 0 }] };
  getDocumentAsync.mockResolvedValueOnce(result);
  return uri;
}

function reads(api: FakePortalApi): unknown[] {
  return writes(api).filter((call) => call.path === `${PATH}/setup/read`).map((call) => call.body);
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

test('the section is absent while the setup says TownwiseAI can’t read for it', async () => {
  await renderApp(ROUTE, portal({ answer: { ...ANSWER, canReadWithAi: false } }));
  expect(await screen.findByText('Use a computer to download the template, import a sheet or upload item sales.')).toBeTruthy();
  expect(screen.queryByText(HEADING)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Choose a file' })).toBeNull();
  expect(screen.queryByLabelText('Or paste text')).toBeNull();
});

test('a chosen file goes as its kind and base64, never its name, and the cached copy is deleted; the answer fills the unsaved draft', async () => {
  const api = portal();
  api.answers[`${PATH}/setup/read`] = () => ({ read: READ });
  await renderApp(ROUTE, api);
  expect(await screen.findByText(HEADING)).toBeTruthy();
  expect(screen.getByText('Use a computer to download the template, import a sheet or upload item sales.')).toBeTruthy();
  expect(screen.getByText(/^Choose a file, such as an order guide/)).toBeTruthy();
  expect(screen.getByText('Choose a file: a PDF, an Excel (.xlsx) or Word (.docx) file, a CSV or text file, or a picture.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();

  const uri = picks(FILE_NAME, 18);
  await fireEvent.press(button('Choose a file'));
  expect(await screen.findByText(`Chosen: ${FILE_NAME}, 1 KB.`)).toBeTruthy();
  expect(getDocumentAsync).toHaveBeenCalledWith({ multiple: false, copyToCacheDirectory: true, type: expect.any(Array) as unknown });
  expect(reads(api)).toEqual([]);
  expect(mockBase64Reads).toEqual([]);

  await fireEvent.press(button('Read the file'));
  expect(await screen.findByText(/^TownwiseAI found 1 item/)).toBeTruthy();
  expect(reads(api)).toEqual([{ source: { type: 'file', kind: 'pdf', data: BYTES } }]);
  const sent = JSON.stringify(api.calls);
  expect(sent).not.toContain('Qzxv');
  expect(sent).not.toContain('order guide');
  expect(sent).not.toContain('DocumentPicker');
  expect(mockDeleted).toContain(uri);
  expect(mockCache.has(uri)).toBe(false);
  expect(screen.getByDisplayValue('Sample IPA')).toBeTruthy();
  expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  expect(writes(api).filter((call) => call.method === 'PUT')).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();
});

test('a canceled pick changes nothing', async () => {
  const api = portal();
  await renderApp(ROUTE, api);
  await screen.findByText(HEADING);
  getDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: null });
  await fireEvent.press(button('Choose a file'));
  await waitFor(() => { expect(getDocumentAsync).toHaveBeenCalledTimes(1); });
  expect(screen.queryByText(/^Chosen:/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(reads(api)).toEqual([]);
  expect(mockDeleted).toEqual([]);
});

test('an oversize file, an old Excel file and a HEIC photo are refused before any read, and their copies are deleted', async () => {
  const api = portal();
  await renderApp(ROUTE, api);
  await screen.findByText(HEADING);
  const refusals: [string, number, string][] = [
    ['guide.pdf', 5 * 1024 * 1024 + 1, 'That file is larger than 5 MB, the most TownwiseAI reads at once.'],
    ['guide.xls', 10, 'TownwiseAI can’t read old Excel files (.xls). Save it as .xlsx and choose it again.'],
    ['IMG_0412.HEIC', 10, 'The app can’t read HEIC photos yet. Choose a JPEG or PNG, or read it at townwise.tech on a computer.'],
  ];
  for (const [name, size, words] of refusals) {
    const uri = picks(name, size);
    await fireEvent.press(button('Choose a file'));
    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Read the file' })).toBeNull();
    expect(mockDeleted).toContain(uri);
  }
  expect(mockBase64Reads).toEqual([]);
  expect(reads(api)).toEqual([]);
});

test('pasted text goes as the text; while TownwiseAI reads the page says so with Cancel, and Cancel adds nothing', async () => {
  const api = portal();
  const answer = deferred<unknown>();
  api.answers[`${PATH}/setup/read`] = () => answer.promise;
  await renderApp(ROUTE, api);
  await screen.findByText(HEADING);
  await fireEvent.changeText(screen.getByLabelText('Or paste text'), 'Sample IPA, 1 half-barrel, Tuesdays');
  await fireEvent.press(button('Read the text'));
  expect(await screen.findByText('TownwiseAI is reading the text. This can take up to three minutes.')).toBeTruthy();
  await waitFor(() => { expect(reads(api)).toEqual([{ source: { type: 'text', text: 'Sample IPA, 1 half-barrel, Tuesdays' } }]); });
  expect(button('Read the text').props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(button('Cancel'));
  expect(await screen.findByText('Stopped. Nothing was added to the setup.')).toBeTruthy();
  answer.resolve({ read: READ });
  await waitFor(() => { expect(screen.getByText('No unsaved changes.')).toBeTruthy(); });
  expect(screen.queryByDisplayValue('Sample IPA')).toBeNull();
  expect(screen.getByLabelText('Or paste text').props.value).toBe('Sample IPA, 1 half-barrel, Tuesdays');
});

test('pasted text that is only links is refused before anything is sent', async () => {
  const api = portal();
  await renderApp(ROUTE, api);
  await screen.findByText(HEADING);
  await fireEvent.changeText(screen.getByLabelText('Or paste text'), ' https://docs.google.com/spreadsheets/d/sample/edit ');
  await fireEvent.press(button('Read the text'));
  expect(await screen.findByText('TownwiseAI can’t open links. Download the sheet or page as a file and choose it, or paste what it says.')).toBeTruthy();
  expect(reads(api)).toEqual([]);
});

test('view-as: every control is disabled in place and the picker never opens', async () => {
  const api = portal({ me: viewAsMe(ACCESS.member) });
  await renderApp(ROUTE, api);
  await screen.findByText(HEADING);
  for (const name of ['Choose a file', 'Read the text']) {
    expect(button(name).props.accessibilityState).toMatchObject({ disabled: true });
  }
  expect(screen.getByLabelText('Or paste text').props.editable).toBe(false);
  await fireEvent.press(button('Choose a file'));
  expect(getDocumentAsync).not.toHaveBeenCalled();
  expect(screen.queryByText(/^Chosen:/)).toBeNull();
  expect(writes(api)).toEqual([]);
});
