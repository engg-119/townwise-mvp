import { ViewerError } from './errors';
import { isoToSerial, type Cell } from './xlsx';
import { zipStore } from './zip';

// A values-only .xlsx: one worksheet per sheet, strings inline, dates as serials under a date (numFmtId 14) or
// date-time (numFmtId 22) style, and nothing else (no formulas, formatting, widths or merged cells). Text is escaped
// for XML, characters XML 1.0 forbids are dropped, and a carriage return is written as &#13; so it survives the
// parser's line-end normalization. Every part is stored, not deflated (zipStore).

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
const STYLE_DATE = 1;
const STYLE_DATE_TIME = 2;
/** The error values Excel writes and reads back (t="e"); any other text is written as a string. */
const ERRORS = new Set([
  '#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!', '#FIELD!',
  '#BLOCKED!', '#CONNECT!', '#UNKNOWN!', '#BUSY!', '#PYTHON!',
]);
const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

function xmlText(text: string): string {
  return text.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

function xmlAttribute(text: string): string {
  return xmlText(text).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}

/** Cell text, with a literal `_xHHHH_` escaped (ST_Xstring) so Excel does not read it as a character. */
function cellString(text: string): string {
  return xmlText(text.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_'));
}

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function inlineString(reference: string, text: string): string {
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${cellString(text)}</t></is></c>`;
}

function cellXml(cell: Cell, reference: string): string {
  switch (cell.t) {
    case 'empty':
      return '';
    case 's':
      return inlineString(reference, cell.v);
    case 'n':
      return Number.isFinite(cell.v) ? `<c r="${reference}"><v>${String(cell.v)}</v></c>` : `<c r="${reference}" t="e"><v>#NUM!</v></c>`;
    case 'b':
      return `<c r="${reference}" t="b"><v>${cell.v ? '1' : '0'}</v></c>`;
    case 'e':
      return ERRORS.has(cell.v) ? `<c r="${reference}" t="e"><v>${xmlText(cell.v)}</v></c>` : inlineString(reference, cell.v);
    case 'd': {
      const serial = isoToSerial(cell.v);
      if (serial === null) return inlineString(reference, cell.v);
      const style = cell.v.length > 10 ? STYLE_DATE_TIME : STYLE_DATE;
      return `<c r="${reference}" s="${String(style)}"><v>${String(serial)}</v></c>`;
    }
  }
}

function worksheetXml(rows: readonly (readonly Cell[])[]): string {
  if (rows.length > MAX_ROWS) throw new ViewerError('too_big', 'rows');
  const parts: string[] = [`${DECLARATION}<worksheet xmlns="${MAIN}"><sheetData>`];
  rows.forEach((row, r) => {
    if (row.length > MAX_COLUMNS) throw new ViewerError('too_big', 'columns');
    const cells = row.map((cell, c) => cellXml(cell, `${columnName(c)}${String(r + 1)}`)).join('');
    if (cells !== '') parts.push(`<row r="${String(r + 1)}">${cells}</row>`);
  });
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

/** At most `length` UTF-16 units, without splitting a surrogate pair. */
function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/**
 * Names Excel accepts: none of []:*?/\ (each becomes '_'), no control character, no apostrophe first or last, 31
 * characters at most, not empty (then 'Sheet<n>'), and unique without regard to case (a repeat gets ' (2)').
 */
export function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, index) => {
    const cleaned = Array.from(raw.replace(NOT_XML, ''))
      .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20)
      .join('')
      .replace(/[[\]:*?/\\]/g, '_')
      .replace(/^'+|'+$/g, '');
    let base = clip(cleaned, 31).replace(/'+$/, '');
    if (base === '') base = `Sheet${String(index + 1)}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${String(n)})`;
      name = clip(base, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const STYLES = `${DECLARATION}<styleSheet xmlns="${MAIN}">`
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** A values-only .xlsx of `sheets`, in order. An empty list writes one empty sheet, since a workbook needs one. */
export function writeWorkbook(sheets: readonly { name: string; rows: readonly (readonly Cell[])[] }[]): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
  const names = sheetNames(list.map((sheet) => sheet.name));
  const numbers = list.map((_sheet, index) => index + 1);
  const contentTypes = `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + numbers.map((n) => `<Override PartName="/xl/worksheets/sheet${String(n)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>';
  const packageRels = `${DECLARATION}<Relationships xmlns="${RELS}">`
    + `<Relationship Id="rId1" Type="${DOC_RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `${DECLARATION}<workbook xmlns="${MAIN}" xmlns:r="${DOC_RELS}"><sheets>`
    + names.map((name, index) => `<sheet name="${xmlAttribute(name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`).join('')
    + '</sheets></workbook>';
  const workbookRels = `${DECLARATION}<Relationships xmlns="${RELS}">`
    + numbers.map((n) => `<Relationship Id="rId${String(n)}" Type="${DOC_RELS}/worksheet" Target="worksheets/sheet${String(n)}.xml"/>`).join('')
    + `<Relationship Id="rId${String(list.length + 1)}" Type="${DOC_RELS}/styles" Target="styles.xml"/></Relationships>`;
  const encoder = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(packageRels) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES) },
    ...list.map((sheet, index) => ({ name: `xl/worksheets/sheet${String(index + 1)}.xml`, data: encoder.encode(worksheetXml(sheet.rows)) })),
  ]);
}
