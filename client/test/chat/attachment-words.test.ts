import { KIND_WORD, kindOfFile, readable, unreadLine } from '../../src/chat/attachments';

// Which attached files TownwiseAI reads in their turn (spec P25, D36), on web and native: a text file, a picture, a
// PDF, and a Word (.docx) or Excel (.xlsx) file; an old Word or Excel file says what to save it as, and a ZIP or any
// other file says TownwiseAI can't read it yet. The chip's kind word is the same either way.

test.each([
  ['hours.txt', 'text'],
  ['patio.png', 'picture'],
  ['menu.pdf', 'pdf'],
  ['rota.docx', 'word'],
  ['book.xlsx', 'excel'],
  ['book.xlsm', 'excel'],
  ['MENU.PDF', 'pdf'],
] as const)('%s is read in its turn, as its kind', (name, kind) => {
  expect(kindOfFile(name, null)).toBe(kind);
  expect(readable(kind, name)).toBe(true);
});

test.each([
  ['old.doc', 'word', 'TownwiseAI can’t read .doc files; save it as .docx'],
  ['OLD.DOC', 'word', 'TownwiseAI can’t read .doc files; save it as .docx'],
  ['old.xls', 'excel', 'TownwiseAI can’t read .xls files; save it as .xlsx'],
  ['week.zip', 'zip', 'TownwiseAI can’t read ZIP files yet'],
  ['photo.heic', 'file', 'TownwiseAI can’t read this kind of file yet'],
] as const)('%s still attaches, and its line says TownwiseAI can’t read it', (name, kind, line) => {
  expect(kindOfFile(name, null)).toBe(kind);
  expect(readable(kind, name)).toBe(false);
  expect(unreadLine(kind)).toBe(line);
});

test('a chip names a Word or Excel file by its kind, old or not', () => {
  expect(kindOfFile('old.doc', 'doc')).toBe('word');
  expect(kindOfFile('rota.docx', 'docx')).toBe('word');
  expect(KIND_WORD.word).toBe('Word file');
  expect(KIND_WORD.excel).toBe('Excel file');
  expect(KIND_WORD.pdf).toBe('PDF');
});
