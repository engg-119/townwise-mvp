import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../../src/portal/viewer/zip';

// A ZIP builder for tests that can also lie: any method, flag or declared size can be set, an entry's central record
// can point at another entry's data, and the end record can be bent. Every file here is synthetic.

export interface FixtureEntry {
  name: string;
  /** The entry's content, before compression. */
  data: Uint8Array | string;
  /** Deflate with node:zlib (method 8); otherwise stored. */
  deflate?: boolean;
  /** The method field as written, whatever the data is. */
  method?: number;
  flags?: number;
  /** The inflated size the central directory declares. */
  size?: number;
  /** The compressed size the central directory declares. */
  compressedSize?: number;
  /** Write no local header; point the central record at entry `sameDataAs`'s. */
  sameDataAs?: number;
}

export interface FixtureOptions {
  /** The entry count the end record declares. */
  count?: number;
  /** Put a ZIP64 end-of-central-directory locator before the end record. */
  zip64Locator?: boolean;
}

const encoder = new TextEncoder();

export function bytesOf(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function buildZip(entries: readonly FixtureEntry[], options: FixtureOptions = {}): Uint8Array {
  const out: number[] = [];
  const push = (bytes: Iterable<number>): void => {
    for (const byte of bytes) out.push(byte);
  };
  const records = entries.map((entry) => {
    const content = bytesOf(entry.data);
    const payload = entry.deflate === true ? new Uint8Array(deflateRawSync(content)) : content;
    return {
      entry,
      name: encoder.encode(entry.name),
      payload,
      method: entry.method ?? (entry.deflate === true ? 8 : 0),
      flags: 0x0800 | (entry.flags ?? 0),
      crc: crc32(content),
      size: entry.size ?? content.length,
      compressedSize: entry.compressedSize ?? payload.length,
      offset: 0,
    };
  });
  for (const record of records) {
    if (record.entry.sameDataAs !== undefined) continue;
    record.offset = out.length;
    push([...u32(0x04034b50), ...u16(20), ...u16(record.flags), ...u16(record.method), ...u16(0), ...u16(0x21)]);
    push([...u32(record.crc), ...u32(record.compressedSize), ...u32(record.size), ...u16(record.name.length), ...u16(0)]);
    push(record.name);
    push(record.payload);
  }
  for (const record of records) {
    if (record.entry.sameDataAs !== undefined) record.offset = records[record.entry.sameDataAs]?.offset ?? 0;
  }
  const directoryOffset = out.length;
  for (const record of records) {
    push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(record.flags), ...u16(record.method), ...u16(0), ...u16(0x21)]);
    push([...u32(record.crc), ...u32(record.compressedSize), ...u32(record.size), ...u16(record.name.length)]);
    push([...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(record.offset)]);
    push(record.name);
  }
  const directorySize = out.length - directoryOffset;
  if (options.zip64Locator === true) push([...u32(0x07064b50), ...u32(0), ...u32(0), ...u32(0), ...u32(1)]);
  const count = options.count ?? records.length;
  push([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(directorySize), ...u32(directoryOffset), ...u16(0)]);
  return new Uint8Array(out);
}

/** A package of XML parts, every part deflated unless `stored`. */
export function buildPackage(parts: Record<string, string>, stored = false): Uint8Array {
  return buildZip(Object.entries(parts).map(([name, data]) => ({ name, data, deflate: !stored })));
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface WorkbookFixture {
  /** Sheet name to sheetData inner XML. */
  sheets: [string, string][];
  sharedStrings?: string[] | string;
  /** The styles part's inner XML (numFmts, cellXfs). */
  styles?: string;
  date1904?: boolean;
  stored?: boolean;
}

/** An .xlsx built the way Excel lays one out. */
export function workbookBytes(fixture: WorkbookFixture): Uint8Array {
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  };
  const sheetList = fixture.sheets.map(([name], i) => `<sheet name="${name}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`).join('');
  parts['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${REL}">`
    + `${fixture.date1904 === true ? '<workbookPr date1904="1"/>' : '<workbookPr/>'}<sheets>${sheetList}</sheets></workbook>`;
  let rels = fixture.sheets.map((_sheet, i) => `<Relationship Id="rId${String(i + 1)}" Type="${REL}/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`).join('');
  if (fixture.sharedStrings !== undefined) {
    rels += `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`;
    const inner = typeof fixture.sharedStrings === 'string'
      ? fixture.sharedStrings
      : fixture.sharedStrings.map((text) => `<si><t xml:space="preserve">${text}</t></si>`).join('');
    parts['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="${MAIN}">${inner}</sst>`;
  }
  if (fixture.styles !== undefined) {
    rels += `<Relationship Id="rIdY" Type="${REL}/styles" Target="styles.xml"/>`;
    parts['xl/styles.xml'] = `<?xml version="1.0"?><styleSheet xmlns="${MAIN}">${fixture.styles}</styleSheet>`;
  }
  parts['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}">${rels}</Relationships>`;
  fixture.sheets.forEach(([, data], i) => {
    parts[`xl/worksheets/sheet${String(i + 1)}.xml`] = `<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData>${data}</sheetData></worksheet>`;
  });
  return buildPackage(parts, fixture.stored === true);
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** A .docx whose body is `body` (inner XML of w:body), with optional styles part inner XML. */
export function documentBytes(body: string, styles?: string): Uint8Array {
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  if (styles !== undefined) {
    parts['word/_rels/document.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
    parts['word/styles.xml'] = `<?xml version="1.0"?><w:styles xmlns:w="${W}">${styles}</w:styles>`;
  }
  return buildPackage(parts);
}

/** A paragraph of one run of text, optionally styled. */
export function para(text: string, style?: string): string {
  const props = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${props}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}
