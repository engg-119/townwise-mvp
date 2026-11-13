import { delimiterFor, sniffImage, viewerFor } from '../../src/portal/viewer/kinds';

// Which viewer shows a file, and whether an image's bytes are what its name says.

test('the viewer for each API file kind and name', () => {
  expect(viewerFor('text', 'sales.csv')).toBe('delimited');
  expect(viewerFor('text', 'SALES.TSV')).toBe('delimited');
  expect(viewerFor('text', 'export.Tab')).toBe('delimited');
  expect(viewerFor('text', 'notes.txt')).toBe('text');
  expect(viewerFor('text', 'csv')).toBe('text');
  expect(viewerFor('text', null)).toBe('text');
  expect(viewerFor('xlsx', 'book.xlsx')).toBe('workbook');
  expect(viewerFor('pdf', 'menu.pdf')).toBe('pdf');
  expect(viewerFor('docx', 'plan.docx')).toBe('document');
  for (const name of ['photo.png', 'photo.JPG', 'photo.jpeg', 'anim.gif', 'pic.webp']) expect(viewerFor('other', name)).toBe('image');
  expect(viewerFor('other', 'vector.svg')).toBe('none');
  expect(viewerFor('other', null)).toBe('none');
  for (const kind of ['xls', 'doc', 'zip', 'unknown']) expect(viewerFor(kind, 'file.png')).toBe('none');
});

test('the delimiter a name implies', () => {
  expect(delimiterFor('a.tsv')).toBe('\t');
  expect(delimiterFor('a.TAB')).toBe('\t');
  expect(delimiterFor('a.csv')).toBeUndefined();
  expect(delimiterFor(null)).toBeUndefined();
});

test('images by their signatures', () => {
  const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));
  expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(sniffImage(new Uint8Array(ascii('GIF89a...')))).toBe('image/gif');
  expect(sniffImage(new Uint8Array(ascii('GIF87a')))).toBe('image/gif');
  expect(sniffImage(new Uint8Array([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 ')]))).toBe('image/webp');
  expect(sniffImage(new Uint8Array([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVE')]))).toBeNull();
  expect(sniffImage(new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBeNull();
  expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
  expect(sniffImage(new Uint8Array(0))).toBeNull();
});
