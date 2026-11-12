import '../../viewer/setup';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { DataItem } from '../../../src/portal/data/api';
import { readWorkbook } from '../../../src/portal/viewer/xlsx';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, offline, orgOf, refusal, type FakePortalApi } from '../../helpers/portal';
import { workbookBytes } from '../../viewer/fixtures';
import { locationsFake } from '../locations/fakes';
import { hexId, hexUploads, sent } from './editFakes';
import { dataFake, itemOf, type DataFake } from './fakes';

// Renaming and editing an item kept for reference on its page (P27, D28, web): Rename, text and CSV edits saved in
// place (an upload, then replace), an Excel edit saved as a values-only copy, what can't be edited saying why, and
// each failure saying what happened with a way forward. All files are synthetic.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:https://townwise.tech/0' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

// Each test boots the app, downloads and reads a file, and some type 200,000 characters or read 5,000 rows, which
// under a full `npm run verify` (the API's suites running alongside) can take several seconds.
jest.setTimeout(20_000);
/** For a wait that spans the app opening an item or landing on another. */
const SLOW = { timeout: 5000 };

const encoder = new TextEncoder();

function refOf(n: number): string {
  return `f_${hexId(n)}`;
}

function rawPath(ref: string): string {
  return `/files/${ref.replace(/^f_/, 'file-')}/raw`;
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}

/** An item kept for reference that the person may edit. */
function editable(ref: string, extra: Partial<DataItem>): DataItem {
  return itemOf(ref, { state: 'kept', outcome: 'reference', canEdit: true, ...extra });
}

function setup(item: DataItem, content: Blob | Uint8Array | string): { fake: DataFake; api: FakePortalApi } {
  const fake = dataFake({ inner: locationsFake(), items: [item] });
  hexUploads(fake);
  const blob = content instanceof Blob ? content : typeof content === 'string' ? new Blob([content]) : blobOf(content);
  fake.files.downloads[rawPath(item.ref)] = () => blob;
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  const path = `/locations/l1/data/${item.ref}`;
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
  return { fake, api };
}

function disabled(element: HTMLElement): boolean {
  return element.getAttribute('aria-disabled') === 'true';
}

/** A grid cell, a textarea so a line break inside it survives. */
function cell(label: string): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: label });
}

function type(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
}

/** The focused element holds `text` (a notice or an error line takes focus as the page's outcome). */
function focusedText(): string {
  return document.activeElement?.textContent ?? '';
}

describe('rename', () => {
  test('a new name keeps the extension, the page reads the item again and says so, and the file isn’t fetched again', async () => {
    const ref = refOf(1);
    const { fake } = setup(editable(ref, { name: 'notes.txt', sizeBytes: 5 }), 'hello');
    expect(await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Rename: notes.txt' }, SLOW));
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    expect(field.value).toBe('notes');
    expect(screen.getByText('The name keeps its .txt ending.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename: notes.txt' })).toBeNull();
    type(field, '  Winter hours ');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Winter hours.txt' }, SLOW)).toBeTruthy();
    expect(fake.patches).toEqual([{ ref, body: { title: 'Winter hours' } }]);
    expect(screen.getByText('Renamed to Winter hours.txt.')).toBeTruthy();
    await waitFor(() => { expect(focusedText()).toContain('Renamed to Winter hours.txt.'); });
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(fake.files.calls.filter((call) => call.path.endsWith('/raw'))).toHaveLength(1);
  });

  test('the same name just closes; an empty one says so in place', async () => {
    const ref = refOf(2);
    const { fake } = setup(editable(ref, { name: 'notes.txt', sizeBytes: 5 }), 'hello');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename: notes.txt' }, SLOW));
    type(screen.getByRole('textbox', { name: 'Name' }), ' ');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Add a name.')).toBeTruthy();
    type(screen.getByRole('textbox', { name: 'Name' }), 'notes');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename: notes.txt' })).toBeTruthy();
    expect(fake.patches).toEqual([]);
  });

  test('a refusal shows under the field, which stays open', async () => {
    const ref = refOf(3);
    const { fake } = setup(editable(ref, { name: 'notes.txt', sizeBytes: 5 }), 'hello');
    fake.answers[`PATCH ${ref}`] = () => refusal(409, 'item_busy');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename: notes.txt' }, SLOW));
    type(screen.getByRole('textbox', { name: 'Name' }), 'menu');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const line = 'This item is changing right now, maybe because someone is saving an edit of it. Try again in a moment.';
    expect(await screen.findByText(line, {}, SLOW)).toBeTruthy();
    await waitFor(() => { expect(focusedText()).toContain(line); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('menu');
    expect(screen.getByRole('heading', { level: 2, name: 'notes.txt' })).toBeTruthy();
  });

  test('a rename refused with 400 (a title that makes no name, or an original deleted meanwhile) says what to do for either', async () => {
    const ref = refOf(4);
    const { fake } = setup(editable(ref, { name: 'notes.txt', sizeBytes: 5 }), 'hello');
    fake.answers[`PATCH ${ref}`] = () => refusal(400, 'invalid_request');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename: notes.txt' }, SLOW));
    type(screen.getByRole('textbox', { name: 'Name' }), '///');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const line = 'Townwise couldn’t rename this item. Try another name, or go back to Your data in case its file was deleted.';
    expect(await screen.findByText(line, {}, SLOW)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('///');
  });
});

describe('editing text', () => {
  test('saves as a new upload under the same name, replaces the item, and lands on its new ref saying Saved.', async () => {
    const ref = refOf(10);
    const { fake, api } = setup(editable(ref, { name: 'notes.txt', sizeBytes: 26 }), 'Closed Mondays in January.');
    expect(await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: notes.txt' }, SLOW));
    const area = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text of notes.txt' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area.value).toBe('Closed Mondays in January.');
    expect(document.activeElement).toBe(area);
    type(area, 'Closed Mondays in January and February.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // Saving: the button says so, Cancel and the page's other actions wait.
    expect(await screen.findByRole('button', { name: 'Saving…' }, SLOW)).toBeTruthy();
    expect(disabled(screen.getByRole('button', { name: 'Cancel' }))).toBe(true);
    expect(disabled(screen.getByRole('button', { name: 'Download original: notes.txt' }))).toBe(true);

    const { fileId, bytes } = await sent(fake);
    expect(new TextDecoder().decode(bytes)).toBe('Closed Mondays in January and February.');
    expect(bytes[0]).toBe(0x43);
    expect(fake.files.calls.find((call) => call.method === 'POST' && call.path === '/files')?.body)
      .toEqual({ name: 'notes.txt', sizeBytes: bytes.length, purpose: 'reference' });
    await waitFor(() => { expect(fake.replaces).toEqual([{ ref, body: { fileId } }]); }, SLOW);

    const text = await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW);
    expect(text.textContent).toBe('Closed Mondays in January and February.');
    expect(screen.getByText('Saved.')).toBeTruthy();
    await waitFor(() => { expect(focusedText()).toContain('Saved.'); });
    expect(screen.getByText('Edited Nov 11, 2026 by owner@example.com')).toBeTruthy();
    expect(api.calls.some((call) => call.path === `/api/org/locations/l1/data/f_${fileId}`)).toBe(true);
    await waitFor(() => { expect(window.location.pathname).toBe(`/locations/l1/data/f_${fileId}`); });
    await waitFor(() => { expect(window.location.search).toBe(''); });
    // The edited item can be edited again.
    expect(screen.getByRole('button', { name: 'Edit: notes.txt' })).toBeTruthy();
  });

  test('Save stays disabled until the text differs from the file', async () => {
    const ref = refOf(11);
    setup(editable(ref, { name: 'notes.txt', sizeBytes: 5 }), 'hello');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: notes.txt' }, SLOW));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(disabled(save)).toBe(true);
    const area = screen.getByRole('textbox', { name: 'Text of notes.txt' });
    type(area, 'hello!');
    expect(disabled(save)).toBe(false);
    type(area, 'hello');
    expect(disabled(save)).toBe(true);
  });

  test('a CRLF file: a character typed and deleted leaves Save disabled, and a save keeps CRLF', async () => {
    const ref = refOf(14);
    const { fake } = setup(editable(ref, { name: 'notes.txt', sizeBytes: 24 }), 'Closed Mondays\r\nOpen at 9\r\n');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: notes.txt' }, SLOW));
    const area = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text of notes.txt' });
    const save = screen.getByRole('button', { name: 'Save' });
    // A browser reports a textarea's value with its line breaks as LF, as these change events do.
    type(area, 'Closed Mondays\nOpen at 9\n!');
    expect(disabled(save)).toBe(false);
    type(area, 'Closed Mondays\nOpen at 9\n');
    expect(disabled(save)).toBe(true);
    type(area, 'Closed Mondays\nOpen at 10\n');
    fireEvent.click(save);
    const { bytes } = await sent(fake);
    expect(new TextDecoder().decode(bytes)).toBe('Closed Mondays\r\nOpen at 10\r\n');
    expect(await screen.findByText('Saved.', {}, SLOW)).toBeTruthy();
  });

  test('Cancel with changes asks to discard them; without changes it just closes', async () => {
    const ref = refOf(12);
    setup(editable(ref, { name: 'notes.txt', sizeBytes: 5 }), 'hello');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: notes.txt' }, SLOW));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW)).textContent).toBe('hello');

    fireEvent.click(await screen.findByRole('button', { name: 'Edit: notes.txt' }, SLOW));
    type(screen.getByRole('textbox', { name: 'Text of notes.txt' }), 'goodbye');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard your changes?' }, SLOW);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text of notes.txt' }).value).toBe('goodbye');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' }, SLOW)).getByRole('button', { name: 'Discard changes' }));
    expect((await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW)).textContent).toBe('hello');
    expect(screen.queryByRole('textbox', { name: 'Text of notes.txt' })).toBeNull();
  });

  test('near the limit it says how many characters are left', async () => {
    const ref = refOf(13);
    const long = 'a'.repeat(195_000);
    setup(editable(ref, { name: 'long.txt', sizeBytes: long.length }), long);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: long.txt' }, SLOW));
    const area = screen.getByRole('textbox', { name: 'Text of long.txt' });
    const left = screen.getByText('5,000 characters left.');
    expect(area.getAttribute('aria-describedby')).toBe(left.id);
    type(area, `${long}b`);
    expect(screen.getByText('4,999 characters left.')).toBeTruthy();
  });
});

describe('editing a CSV', () => {
  const CSV = '﻿name,note\r\n"Smith, J","said ""hi"""\r\nOak,plain\r\n';

  test('cells, rows and columns save as the exact CSV: quotes, CRLF and the byte-order mark kept', async () => {
    const ref = refOf(20);
    const { fake } = setup(editable(ref, { name: 'list.csv', sizeBytes: 60 }), encoder.encode(CSV));
    expect(await screen.findByRole('region', { name: 'Rows of list.csv' }, SLOW)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: list.csv' }, SLOW));
    expect(cell('Row 2, column 1').value).toBe('Smith, J');
    expect(cell('Row 2, column 2').value).toBe('said "hi"');
    expect(document.activeElement).toBe(cell('Row 1, column 1'));
    type(cell('Row 3, column 2'), 'plain, too');
    fireEvent.click(screen.getByRole('button', { name: 'Add a column' }));
    type(cell('Row 1, column 3'), 'tag');
    fireEvent.click(screen.getByRole('button', { name: 'Add a row' }));
    type(cell('Row 4, column 1'), 'Elm');
    fireEvent.click(screen.getByRole('button', { name: 'Add a row' }));
    expect(cell('Row 5, column 3').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Delete row 5' }));
    expect(screen.queryByRole('textbox', { name: 'Row 5, column 1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const { bytes } = await sent(fake);
    expect(Array.from(bytes)).toEqual(Array.from(encoder.encode(
      '﻿name,note,tag\r\n"Smith, J","said ""hi""",\r\nOak,"plain, too",\r\nElm,,\r\n',
    )));
    expect(await screen.findByText('Saved.', {}, SLOW)).toBeTruthy();
  });

  test('a ragged row stays ragged unless the person types past its end', async () => {
    const ref = refOf(21);
    const { fake } = setup(editable(ref, { name: 'ragged.csv', sizeBytes: 9 }), 'a,b,c\nd\n');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: ragged.csv' }, SLOW));
    type(cell('Row 1, column 1'), 'A');
    type(cell('Row 2, column 3'), 'x');
    type(cell('Row 2, column 3'), '');
    type(cell('Row 2, column 2'), 'e');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const { bytes } = await sent(fake);
    expect(new TextDecoder().decode(bytes)).toBe('A,b,c\nd,e\n');
  });

  test('a line break inside a cell survives, and can be typed', async () => {
    const ref = refOf(23);
    const { fake } = setup(editable(ref, { name: 'notes.csv', sizeBytes: 22 }), 'day,note\nMon,"two\nlines"\n');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: notes.csv' }, SLOW));
    expect(cell('Row 2, column 2').value).toBe('two\nlines');
    type(cell('Row 1, column 2'), 'notes\nfor the week');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const { bytes } = await sent(fake);
    expect(new TextDecoder().decode(bytes)).toBe('day,"notes\nfor the week"\nMon,"two\nlines"\n');
  });

  test('a CRLF CSV: a cell typed back as it was leaves Save disabled, and a save keeps CRLF, inside cells too', async () => {
    const ref = refOf(24);
    const csv = 'day,note\r\nMon,"two\r\nlines"\r\n';
    const { fake } = setup(editable(ref, { name: 'week.csv', sizeBytes: csv.length }), csv);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: week.csv' }, SLOW));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(cell('Row 2, column 2').value).toBe('two\nlines');
    type(cell('Row 2, column 2'), 'two\nlines!');
    expect(disabled(save)).toBe(false);
    type(cell('Row 2, column 2'), 'two\nlines');
    expect(disabled(save)).toBe(true);
    type(cell('Row 1, column 2'), 'notes\nfor the week');
    fireEvent.click(save);
    const { bytes } = await sent(fake);
    expect(new TextDecoder().decode(bytes)).toBe('day,"notes\r\nfor the week"\r\nMon,"two\r\nlines"\r\n');
  });

  test('a windows-1252 CSV saves as UTF-8 with a byte-order mark, so Excel reads it right', async () => {
    const ref = refOf(22);
    const latin = new Uint8Array([...encoder.encode('caf'), 0xe9, ...encoder.encode(',1\r\n')]);
    const { fake } = setup(editable(ref, { name: 'menu.csv', sizeBytes: latin.length }), latin);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: menu.csv' }, SLOW));
    expect(cell('Row 1, column 1').value).toBe('café');
    type(cell('Row 1, column 2'), '2');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const { bytes } = await sent(fake);
    expect(Array.from(bytes)).toEqual([0xef, 0xbb, 0xbf, ...encoder.encode('café,2\r\n')]);
  });
});

describe('editing a workbook', () => {
  test('Save as a copy uploads a values-only workbook beside the original, with no replace, and lands on the copy', async () => {
    const ref = refOf(30);
    const bytes = workbookBytes({
      sheets: [
        ['Sales', '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2"><v>7</v></c></row>'],
        ['Notes', '<row r="1"><c r="A1" t="inlineStr"><is><t>Closed on the 4th</t></is></c></row>'],
      ],
      sharedStrings: ['Guests', 'Tables'],
    });
    const { fake } = setup(editable(ref, { name: 'hours.xlsx', kind: 'xlsx', sizeBytes: bytes.length }), bytes);
    await screen.findByRole('tablist', { name: 'Sheets' }, SLOW);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: hours.xlsx' }, SLOW));
    expect(screen.getByText(
      'Saving makes a new Excel file beside this one. The copy keeps each cell’s value; formatting, formulas and charts stay only in the original.',
    )).toBeTruthy();
    expect(cell('Row 2, column A').value).toBe('42');
    type(cell('Row 2, column B'), '9');
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Sheets' })).getByRole('tab', { name: 'Notes' }));
    type(cell('Row 1, column A'), 'Closed on the 5th');
    fireEvent.click(screen.getByRole('button', { name: 'Save as a copy' }));

    await waitFor(() => { expect(fake.files.puts.length).toBe(1); }, SLOW);
    const created = fake.files.calls.find((call) => call.method === 'POST' && call.path === '/files');
    expect((created?.body as { name: string }).name).toBe('hours (edited).xlsx');
    const copyId = hexId(0xed1);
    fake.items = [...fake.items, editable(`f_${copyId}`, {
      name: 'hours (edited).xlsx', kind: 'xlsx',
      file: {
        id: copyId, hasClean: false, rawAvailable: true, rawExpiresAt: null, entries: null, canDownloadRaw: true, canDownloadClean: false,
        canDeleteRaw: true,
      },
    })];
    const upload = await sent(fake);
    expect(upload.fileId).toBe(copyId);
    const copy = await readWorkbook(upload.bytes);
    expect(copy.sheets.map((sheet) => sheet.name)).toEqual(['Sales', 'Notes']);
    expect(copy.sheets[0]?.rows).toEqual([
      [{ t: 's', v: 'Guests' }, { t: 's', v: 'Tables' }],
      [{ t: 'n', v: 42 }, { t: 'n', v: 9 }],
    ]);
    expect(copy.sheets[1]?.rows).toEqual([[{ t: 's', v: 'Closed on the 5th' }]]);

    expect(await screen.findByText('Saved a copy. The original is still on Your data.', {}, SLOW)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'hours (edited).xlsx' })).toBeTruthy();
    expect(fake.replaces).toEqual([]);
    expect(fake.items.some((item) => item.ref === ref)).toBe(true);
  });
});

describe('what can’t be edited', () => {
  test('a CSV longer than the editor takes, or one read only in part, has no Edit and says why', async () => {
    const line = 'This file is too big to edit here: Townwise edits tables up to 1,000 rows and 50 columns. Download it, edit it on your computer, and add it again.';
    const long = ['a,b', ...Array.from({ length: 1000 }, (_, index) => `${String(index)},x`)].join('\n');
    setup(editable(refOf(40), { name: 'long.csv', sizeBytes: long.length }), long);
    expect(await screen.findByText(line, {}, SLOW)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename: long.csv' })).toBeTruthy();
    cleanup();

    const cut = Array.from({ length: 5001 }, (_, index) => String(index)).join('\n');
    setup(editable(refOf(41), { name: 'cut.csv', sizeBytes: cut.length }), cut);
    expect(await screen.findByText(line, {}, SLOW)).toBeTruthy();
    expect(screen.getByText('Townwise reads the first 5,000 rows and 200 columns of a file, so the rest of this one is left out.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });

  test('text over 200,000 characters has no Edit and says why', async () => {
    const long = 'a'.repeat(200_001);
    setup(editable(refOf(42), { name: 'long.txt', sizeBytes: long.length }), long);
    expect(await screen.findByText(
      'This file is too long to edit here: Townwise edits text up to 200,000 characters. Download it, edit it on your computer, and add it again.',
      {},
      SLOW,
    )).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });

  test('a PDF can be renamed but not edited, and says nothing about editing', async () => {
    setup(editable(refOf(43), { name: 'menu.pdf', kind: 'pdf', sizeBytes: 20 }), '%PDF-1.4\n%synthetic\n');
    expect(await screen.findByRole('button', { name: 'Open PDF: menu.pdf' }, SLOW)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename: menu.pdf' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.queryByText(/to edit here/)).toBeNull();
  });

  test('an item the person can’t edit has neither Rename nor Edit', async () => {
    setup(editable(refOf(44), { name: 'notes.txt', sizeBytes: 5, canEdit: false }), 'hello');
    expect(await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });
});

describe('failures', () => {
  async function editText(ref: string): Promise<DataFake> {
    const { fake } = setup(editable(ref, { name: 'notes.txt', sizeBytes: 5 }), 'hello');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: notes.txt' }, SLOW));
    type(screen.getByRole('textbox', { name: 'Text of notes.txt' }), 'hello there');
    return fake;
  }

  test('a refused upload changes nothing: the edit stays open with the reason, to save again', async () => {
    const ref = refOf(50);
    const fake = await editText(ref);
    fake.files.answers['POST /files'] = () => refusal(409, 'storage_full');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const line = 'Your organization’s file storage is full, and saving an edit needs room for both copies until the old one is removed. Delete some files on Your data, then save again. Your changes are still here.';
    expect(await screen.findByText(line, {}, SLOW)).toBeTruthy();
    await waitFor(() => { expect(focusedText()).toContain(line); });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text of notes.txt' }).value).toBe('hello there');
    expect(disabled(screen.getByRole('button', { name: 'Save' }))).toBe(false);
    expect(disabled(screen.getByRole('button', { name: 'Download original: notes.txt' }))).toBe(false);
    expect(fake.replaces).toEqual([]);
  });

  test('another edit saved first: the edit is kept as a new item, with a link to it', async () => {
    const ref = refOf(51);
    const fake = await editText(ref);
    fake.answers['POST replace'] = () => refusal(409, 'item_changed');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const { fileId } = await sent(fake);
    const line = 'Someone else saved an edit of this item first. Yours is kept on Your data as a new item.';
    expect(await screen.findByText(line, { exact: false }, SLOW)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open it' }).getAttribute('href')).toBe(`/locations/l1/data/f_${fileId}`);
    await waitFor(() => { expect(focusedText()).toContain(line); });
    expect(screen.queryByRole('textbox', { name: 'Text of notes.txt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect((await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW)).textContent).toBe('hello');
  });

  test('a replace that fails on the way offers Try again, which replaces with the same file and lands on it', async () => {
    const ref = refOf(52);
    const fake = await editText(ref);
    let tries = 0;
    fake.answers['POST replace'] = () => {
      tries += 1;
      return tries === 1 ? offline() : undefined;
    };
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const { fileId } = await sent(fake);
    const line = 'Townwise saved your edit, but couldn’t put it in this item’s place. Try again. If you leave, your edit stays on Your data as a new item.';
    expect(await screen.findByText(line, {}, SLOW)).toBeTruthy();
    await waitFor(() => { expect(focusedText()).toContain(line); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await Promise.resolve(); });
    expect(await screen.findByText('Saved.', {}, SLOW)).toBeTruthy();
    expect(fake.replaces).toEqual([{ ref, body: { fileId } }, { ref, body: { fileId } }]);
    expect(fake.files.calls.filter((call) => call.method === 'POST' && call.path === '/files')).toHaveLength(1);
    expect((await screen.findByRole('region', { name: 'Text of notes.txt' }, SLOW)).textContent).toBe('hello there');
  });
});
