import './setup';

import { ViewerError } from '../../src/portal/viewer/errors';
import { VIEW_LIMITS } from '../../src/portal/viewer/limits';
import { openPackage, readXml, readXmlCut } from '../../src/portal/viewer/ooxml';
import {
  cellFromText, cellText, isDateFormat, isoToSerial, readWorkbook, serialToIso, type Cell, type Sheet,
} from '../../src/portal/viewer/xlsx';
import { sheetNames, writeWorkbook } from '../../src/portal/viewer/xlsxWrite';
import { listZip } from '../../src/portal/viewer/zip';
import { buildPackage, workbookBytes } from './fixtures';

// Excel workbooks read in the browser, and the values-only writer. Every workbook here is synthetic.

const MIB = 1024 * 1024;
const EMPTY: Cell = { t: 'empty' };
const s = (v: string): Cell => ({ t: 's', v });
const n = (v: number): Cell => ({ t: 'n', v });
const b = (v: boolean): Cell => ({ t: 'b', v });
const d = (v: string): Cell => ({ t: 'd', v });
const e = (v: string): Cell => ({ t: 'e', v });

async function reason(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ViewerError) return error.reason;
    throw error;
  }
  return 'no error';
}

async function onlySheet(bytes: Uint8Array): Promise<Sheet> {
  const workbook = await readWorkbook(bytes);
  const [sheet] = workbook.sheets;
  if (sheet === undefined) throw new Error('no sheet');
  return sheet;
}

const DATE_STYLES = '<numFmts count="4">'
  + '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>'
  + '<numFmt numFmtId="165" formatCode="[$-409]h:mm AM/PM"/>'
  + '<numFmt numFmtId="166" formatCode="&quot;Day&quot; 0.00"/>'
  + '<numFmt numFmtId="167" formatCode="[Red]#,##0"/>'
  + '</numFmts><cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="164"/>'
  + '<xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="167"/></cellXfs>';

describe('reading cells', () => {
  test('shared strings (plain, rich text, phonetic runs skipped, _xHHHH_ escapes), inline strings, booleans, errors and cached formula values', async () => {
    const sheet = await onlySheet(workbookBytes({
      sheets: [['Sheet1',
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
        + '<row r="2"><c r="A2" t="inlineStr"><is><t>Inline</t></is></c><c r="B2" t="inlineStr"><is><r><t>Rich </t></r><r><rPr><b/></rPr><t>inline</t></r></is></c>'
        + '<c r="C2" t="b"><v>1</v></c><c r="D2" t="b"><v>0</v></c></row>'
        + '<row r="3"><c r="A3" t="e"><v>#DIV/0!</v></c><c r="B3"><f>1+2</f><v>3</v></c><c r="C3" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>'
        + '<c r="D3"><f>NOW()</f></c></row>'],
      ],
      sharedStrings: '<si><t>Plain</t></si>'
        + '<si><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> and plain</t></r></si>'
        + '<si><t>Kanji</t><rPh sb="0" eb="1"><t>phonetic</t></rPh><phoneticPr fontId="1"/></si>'
        + '<si><t>Line_x000D__x000A_break _x005F_x0041_</t></si>',
    }));
    expect(sheet.rows).toEqual([
      [s('Plain'), s('Bold and plain'), s('Kanji'), s('Line\r\nbreak _x0041_')],
      [s('Inline'), s('Rich inline'), b(true), b(false)],
      [e('#DIV/0!'), n(3), s('ab'), EMPTY],
    ]);
    expect([sheet.rowCount, sheet.columnCount, sheet.truncated]).toEqual([3, 4, false]);
  });

  test('sparse cells land at their references; rows and cells without one follow the last; styled empty cells add nothing', async () => {
    const sheet = await onlySheet(workbookBytes({
      stored: true,
      sheets: [['Sparse',
        '<row r="2"><c r="C2"><v>1</v></c></row>'
        + '<row r="4"><c r="A4"><v>2</v></c><c><v>3</v></c><c r="E4" s="0"/></row>'
        + '<row><c r="B5"><v>4</v></c></row>'
        + '<row r="9" spans="1:20"><c r="H9" s="1"/></row>'],
      ],
    }));
    expect(sheet.rows).toEqual([
      [EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, n(1)],
      [EMPTY, EMPTY, EMPTY],
      [n(2), n(3), EMPTY],
      [EMPTY, n(4), EMPTY],
    ]);
    expect([sheet.rowCount, sheet.columnCount]).toEqual([5, 3]);
  });

  test('a sheet with no cells, and sheets in the workbook’s order', async () => {
    const workbook = await readWorkbook(workbookBytes({ sheets: [['First', ''], ['Second', '<row r="1"><c r="A1"><v>1</v></c></row>']] }));
    expect(workbook.sheets.map((sheet) => [sheet.name, sheet.rowCount, sheet.columnCount])).toEqual([['First', 0, 0], ['Second', 1, 1]]);
    expect(workbook.truncated).toBe(false);
  });

  test('prefixed elements and Strict namespaces read the same', async () => {
    const strict = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
    const rel = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
    const sheet = await onlySheet(buildPackage({
      '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="${rel}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<x:workbook xmlns:x="${strict}" xmlns:r="${rel}"><x:sheets><x:sheet name="S" sheetId="1" r:id="rId7"/></x:sheets></x:workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="${rel}/worksheet" Target="sub/../worksheets/one.xml"/></Relationships>`,
      'xl/worksheets/one.xml': `<x:worksheet xmlns:x="${strict}"><x:sheetData><x:row r="1"><x:c r="B1" t="inlineStr"><x:is><x:t>ok</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
    }));
    expect(sheet.rows).toEqual([[EMPTY, s('ok')]]);
  });
});

describe('dates', () => {
  test('built-in and custom date formats make dates; quoted and bracketed letters do not', async () => {
    const sheet = await onlySheet(workbookBytes({
      styles: DATE_STYLES,
      sheets: [['Dates',
        '<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45000.5</v></c><c r="C1" s="3"><v>45366</v></c>'
        + '<c r="D1" s="4"><v>0.75</v></c><c r="E1" s="5"><v>12.5</v></c><c r="F1" s="6"><v>1000</v></c><c r="G1" s="0"><v>45000</v></c></row>'
        + '<row r="2"><c r="A2" t="d"><v>2024-03-15T00:00:00</v></c><c r="B2" t="d"><v>2024-03-15T08:30:00.000Z</v></c>'
        + '<c r="C2" s="1"><v>-1</v></c><c r="D2" s="2"><v>45000.999999</v></c></row>'],
      ],
    }));
    expect(sheet.rows).toEqual([
      [d('2023-03-15'), d('2023-03-15T12:00:00'), d('2024-03-15'), d('1899-12-31T18:00:00'), n(12.5), n(1000), n(45000)],
      [d('2024-03-15'), d('2024-03-15T08:30:00'), n(-1), d('2023-03-16'), EMPTY, EMPTY, EMPTY],
    ]);
  });

  test('the 1900 leap-year bug: serial 60 is 1900-02-29, and serials before it are a day later', async () => {
    const sheet = await onlySheet(workbookBytes({
      styles: DATE_STYLES,
      sheets: [['Leap', '<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>59</v></c><c r="C1" s="1"><v>60</v></c><c r="D1" s="1"><v>61</v></c></row>']],
    }));
    expect(sheet.rows).toEqual([[d('1900-01-01'), d('1900-02-28'), d('1900-02-29'), d('1900-03-01')]]);
  });

  test('the 1904 date system', async () => {
    const sheet = await onlySheet(workbookBytes({
      date1904: true,
      styles: DATE_STYLES,
      sheets: [['1904', '<row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><v>43538</v></c><c r="C1" s="2"><v>1.25</v></c></row>']],
    }));
    expect(sheet.rows).toEqual([[d('1904-01-01'), d('2023-03-15'), d('1904-01-02T06:00:00')]]);
  });

  test('serials and ISO text convert both ways', () => {
    for (const serial of [0, 0.25, 1, 59, 60, 61, 366, 45000, 45000.5, 2958465]) {
      const iso = serialToIso(serial, false);
      if (iso === null) throw new Error(`no date for ${String(serial)}`);
      expect(isoToSerial(iso)).toBeCloseTo(serial, 6);
    }
    expect(serialToIso(2958466, false)).toBeNull();
    expect(isoToSerial('1899-12-30')).toBeNull();
    expect(isoToSerial('2024-02-30')).toBeNull();
  });

  test('which format codes are dates', () => {
    for (const code of ['yyyy-mm-dd', 'h:mm', '[h]:mm:ss', '[mm]', '[$-409]mmmm d, yyyy', 'dd/mm/yyyy;@', 'm/d/yy h:mm AM/PM']) {
      expect([code, isDateFormat(code)]).toEqual([code, true]);
    }
    for (const code of ['General', '0.00', '"Day" 0', '[Red]0', '#,##0 "days"', '_(* #,##0_)', '0.00E+00', '\\d0', '@']) {
      expect([code, isDateFormat(code)]).toEqual([code, false]);
    }
  });

  test('a format code past Excel’s 255 characters is no date, and an unclosed [ runs to the end, in linear time', () => {
    const started = performance.now();
    expect(isDateFormat('['.repeat(1_000_000))).toBe(false);
    expect(isDateFormat('y'.repeat(256))).toBe(false);
    expect(isDateFormat('['.repeat(255))).toBe(false);
    expect(isDateFormat(`${'['.repeat(200)}yyyy`)).toBe(false);
    expect(isDateFormat(`yyyy ${'['.repeat(250)}`)).toBe(true);
    expect(isDateFormat('[h'.repeat(127))).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('caps', () => {
  test('a sheet with more rows than are read is truncated at 5,000', async () => {
    const rows = Array.from({ length: VIEW_LIMITS.sheetRows + 2 }, (_row, i) => `<row r="${String(i + 1)}"><c r="A${String(i + 1)}"><v>${String(i)}</v></c></row>`).join('');
    const workbook = await readWorkbook(workbookBytes({ sheets: [['Long', rows]] }));
    const [sheet] = workbook.sheets;
    expect(sheet?.rowCount).toBe(VIEW_LIMITS.sheetRows);
    expect(sheet?.rows).toHaveLength(VIEW_LIMITS.sheetRows);
    expect(sheet?.rows[VIEW_LIMITS.sheetRows - 1]).toEqual([n(VIEW_LIMITS.sheetRows - 1)]);
    expect(sheet?.truncated).toBe(true);
    expect(workbook.truncated).toBe(true);
  });

  test('a cell past the 200th column is dropped and the sheet truncated', async () => {
    const sheet = await onlySheet(workbookBytes({ sheets: [['Wide', '<row r="1"><c r="A1"><v>1</v></c><c r="GR1"><v>200</v></c><c r="GS1"><v>201</v></c></row>']] }));
    expect(sheet.columnCount).toBe(VIEW_LIMITS.sheetColumns);
    expect(sheet.rows[0]?.[VIEW_LIMITS.sheetColumns - 1]).toEqual(n(200));
    expect(sheet.truncated).toBe(true);
  });

  test('sheets naming one worksheet part show the same cells under their own names; the part is read and parsed once', async () => {
    const names = Array.from({ length: VIEW_LIMITS.sheets }, (_sheet, i) => `S${String(i + 1)}`);
    const bytes = workbookBytes({
      sheets: names.map((name, i): [string, string] => [name, i === 0 ? '<row r="1"><c r="A1"><v>7</v></c></row>' : '']),
      targets: names.map(() => 'worksheets/sheet1.xml'),
    });
    const parse = jest.spyOn(DOMParser.prototype, 'parseFromString');
    try {
      const workbook = await readWorkbook(bytes);
      expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(names);
      expect(workbook.sheets.every((sheet) => sheet.rows === workbook.sheets[0]?.rows)).toBe(true);
      expect(workbook.sheets[49]?.rows).toEqual([[n(7)]]);
      expect(workbook.truncated).toBe(false);
      // _rels/.rels, the workbook, its relationships and the one worksheet.
      expect(parse).toHaveBeenCalledTimes(4);
    } finally {
      parse.mockRestore();
    }
  });

  test('every read of a part is charged to one budget per package, so reading one part over and over stops at 128 MiB', async () => {
    // A stored 1 MiB part that parseXml refuses at once (a DOCTYPE), so each read costs its bytes and nothing more.
    const pkg = openPackage(buildPackage({ 'xl/big.xml': `<!DOCTYPE x>${' '.repeat(MIB - 12)}` }, true));
    for (let read = 0; read < VIEW_LIMITS.zipTotalBytes / MIB; read += 1) {
      expect(await reason(() => readXml(pkg, 'xl/big.xml'))).toBe('damaged');
    }
    expect(await reason(() => readXml(pkg, 'xl/big.xml'))).toBe('too_big');
    expect(await reason(() => readXmlCut(pkg, 'xl/big.xml', 'row', ['sheetData']))).toBe('too_big');
    // Another package of the same bytes has its own budget.
    expect(await reason(() => readXml(openPackage(pkg.bytes), 'xl/big.xml'))).toBe('damaged');
  });

  test('a workbook with more sheets than are read is truncated at 50', async () => {
    const sheets = Array.from({ length: VIEW_LIMITS.sheets + 1 }, (_sheet, i): [string, string] => [`S${String(i + 1)}`, '']);
    const workbook = await readWorkbook(workbookBytes({ sheets }));
    expect(workbook.sheets).toHaveLength(VIEW_LIMITS.sheets);
    expect(workbook.truncated).toBe(true);
  });
});

describe('refusals', () => {
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

  test('a password-protected workbook (an OLE container with an encrypted package) is encrypted', async () => {
    const bytes = new Uint8Array(4096);
    bytes.set(ole);
    bytes.set(Array.from('EncryptedPackage').flatMap((char) => [char.charCodeAt(0), 0]), 1200);
    expect(await reason(() => readWorkbook(bytes))).toBe('encrypted');
  });

  test('an old binary workbook (an OLE container without one) is unsupported', async () => {
    const bytes = new Uint8Array(4096);
    bytes.set(ole);
    bytes.set(Array.from('Workbook').flatMap((char) => [char.charCodeAt(0), 0]), 1200);
    expect(await reason(() => readWorkbook(bytes))).toBe('unsupported');
  });

  test('a broken package is damaged', async () => {
    const valid = workbookBytes({ sheets: [['S', '<row r="1"><c r="A1"><v>1</v></c></row>']] });
    expect(await reason(() => readWorkbook(valid.subarray(0, valid.length - 40)))).toBe('damaged');
    expect(await reason(() => readWorkbook(buildPackage({ 'word/document.xml': '<document/>' })))).toBe('damaged');
    expect(await reason(() => readWorkbook(buildPackage({ 'xl/workbook.xml': '<workbook><sheets><sheet name="S"' })))).toBe('damaged');
    expect(await reason(() => readWorkbook(workbookBytes({ sheets: [['S', '<row r="1"><c r="A1" t="s"><v>5</v></c></row>']], sharedStrings: ['only one'] })))).toBe('damaged');
    expect(await reason(() => readWorkbook(workbookBytes({ sheets: [['S', '<row r="1"><c r="1A"><v>1</v></c></row>']] })))).toBe('damaged');
  });

  test('a DOCTYPE (an entity-expansion attempt) is refused before parsing', async () => {
    const bytes = buildPackage({
      'xl/workbook.xml': '<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><workbook>&b;</workbook>',
    });
    expect(await reason(() => readWorkbook(bytes))).toBe('damaged');
  });

  test('parts whose names differ only in case are damaged', async () => {
    expect(await reason(() => readWorkbook(buildPackage({ 'xl/workbook.xml': '<workbook/>', 'XL/Workbook.xml': '<workbook/>' })))).toBe('damaged');
  });
});

describe('the writer', () => {
  test('readWorkbook(writeWorkbook(x)) gives back every cell type', async () => {
    const sheets = [
      {
        name: 'Sales',
        rows: [
          [s('Day'), s('Guests'), s('Open'), s('Note')],
          [d('2024-03-15'), n(42), b(true), s('  leading & trailing  ')],
          [d('2024-03-15T12:30:45'), n(-0.5), b(false), s('line\nbreak\r\nand cr\r <tag> "q" \'a\' _x000D_ \t é 😀')],
          [e('#DIV/0!'), n(1e21), e('#N/A'), s('')],
          [EMPTY, n(0.1 + 0.2), d('1900-02-29'), d('1899-12-31T06:00:00')],
        ],
      },
      { name: 'Second', rows: [[EMPTY, EMPTY, n(3)], [s('x'), EMPTY, EMPTY]] },
    ];
    const read = await readWorkbook(writeWorkbook(sheets));
    expect(read).toEqual({
      sheets: sheets.map((sheet) => ({
        name: sheet.name, rows: sheet.rows, rowCount: sheet.rows.length, columnCount: sheet.rows[0]?.length ?? 0, truncated: false,
      })),
      truncated: false,
    });
  });

  test('every part is stored; dates carry the date and date-time styles', () => {
    const bytes = writeWorkbook([{ name: 'S', rows: [[d('2024-03-15'), d('2024-03-15T01:02:03')]] }]);
    const entries = listZip(bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    ]);
    expect(entries.every((entry) => entry.method === 0)).toBe(true);
    const sheetXml = new TextDecoder().decode(bytes);
    expect(sheetXml).toContain('<c r="A1" s="1"><v>45366</v></c>');
    expect(sheetXml).toContain(`<c r="B1" s="2"><v>${String(45366 + 3723 / 86_400)}</v></c>`);
  });

  test('a time with no date is written as its fraction of a day under a time style, and reads back as one', async () => {
    const bytes = writeWorkbook([{ name: 'S', rows: [[d('1899-12-31T12:00:00'), d('1904-01-01T06:30:00'), d('2024-03-15T12:00:00')]] }]);
    const xml = new TextDecoder().decode(bytes);
    expect(xml).toContain('<xf numFmtId="21" ');
    expect(xml).toContain('<c r="A1" s="3"><v>0.5</v></c>');
    expect(xml).toContain(`<c r="B1" s="3"><v>${String(23_400 / 86_400)}</v></c>`);
    expect(xml).toContain(`<c r="C1" s="2"><v>${String(45366.5)}</v></c>`);
    const read = await readWorkbook(bytes);
    // The writer uses the 1900 system, where a time with no date reads on 1899-12-31.
    expect(read.sheets[0]?.rows).toEqual([[d('1899-12-31T12:00:00'), d('1899-12-31T06:30:00'), d('2024-03-15T12:00:00')]]);
  });

  test('characters XML forbids are dropped; text that is no date or known error is written as text', async () => {
    const read = await readWorkbook(writeWorkbook([{ name: 'S', rows: [[s('a\u0001b￾c\uD800d'), d('1800-01-01'), e('#WHAT?')]] }]));
    expect(read.sheets[0]?.rows).toEqual([[s('abcd'), s('1800-01-01'), s('#WHAT?')]]);
  });

  test('an empty workbook still gets one sheet', async () => {
    const read = await readWorkbook(writeWorkbook([]));
    expect(read.sheets.map((sheet) => sheet.name)).toEqual(['Sheet1']);
  });

  test('sheet names are made valid and unique', () => {
    expect(sheetNames(['a/b', '', 'x'.repeat(40), 'SALES', 'sales', "'quoted'", 'Q1:Q2*?[]\\', 'tab\there', 'Sales'])).toEqual([
      'a_b', 'Sheet2', 'x'.repeat(31), 'SALES', 'sales (2)', 'quoted', 'Q1_Q2_____', 'tabhere', 'Sales (3)',
    ]);
    expect(sheetNames(['y'.repeat(31), 'Y'.repeat(31)])).toEqual(['y'.repeat(31), `${'Y'.repeat(27)} (2)`]);
  });
});

describe('cells as text', () => {
  test('display text', () => {
    expect(cellText(EMPTY)).toBe('');
    expect(cellText(n(0.1 + 0.2))).toBe('0.3');
    expect(cellText(n(1 / 3))).toBe('0.333333333333333');
    expect(cellText(n(-0))).toBe('0');
    expect(cellText(n(123456789012))).toBe('123456789012');
    expect(cellText(b(true))).toBe('TRUE');
    expect(cellText(b(false))).toBe('FALSE');
    expect(cellText(d('2024-03-15T12:30:00'))).toBe('2024-03-15T12:30:00');
    expect(cellText(e('#N/A'))).toBe('#N/A');
    expect(cellText(s(' kept as is '))).toBe(' kept as is ');
  });

  test('an edit keeps the cell’s type while the text still reads as it', () => {
    const noisy = n(0.1 + 0.2);
    expect(cellFromText('0.3', noisy)).toBe(noisy);
    expect(cellFromText('', n(5))).toEqual(EMPTY);
    expect(cellFromText('7.25', n(5))).toEqual(n(7.25));
    expect(cellFromText(' 1e3 ', n(5))).toEqual(n(1000));
    expect(cellFromText('007', n(5))).toEqual(n(7));
    expect(cellFromText('seven', n(5))).toEqual(s('seven'));
    expect(cellFromText('false', b(true))).toEqual(b(false));
    expect(cellFromText('maybe', b(true))).toEqual(s('maybe'));
    expect(cellFromText('2024-04-01', d('2024-03-15'))).toEqual(d('2024-04-01'));
    expect(cellFromText('2024-04-01 08:30', d('2024-03-15'))).toEqual(d('2024-04-01T08:30:00'));
    expect(cellFromText('2024-02-30', d('2024-03-15'))).toEqual(s('2024-02-30'));
    expect(cellFromText('1800-01-01', d('2024-03-15'))).toEqual(s('1800-01-01'));
    expect(cellFromText('#N/A', e('#N/A'))).toEqual(e('#N/A'));
  });

  test('otherwise a plain number becomes a number and anything else text', () => {
    expect(cellFromText('42', s('x'))).toEqual(n(42));
    expect(cellFromText('-3.5', s('x'))).toEqual(n(-3.5));
    expect(cellFromText('12', EMPTY)).toEqual(n(12));
    expect(cellFromText('5', e('#N/A'))).toEqual(n(5));
    for (const text of ['00123', '1e5', '12345678901234567', 'TRUE', '2024-03-15', ' 42', '1,000', '$5']) {
      expect(cellFromText(text, s('x'))).toEqual(s(text));
    }
  });
});
