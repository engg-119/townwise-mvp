// A small ZIP writer for tests (no binary fixtures): stored or deflated entries, with an optional lie about an entry's
// uncompressed size, so the archive guards can be tested without building a real bomb.
import { deflateRawSync } from 'node:zlib';

export interface TestEntry {
  readonly name: string;
  readonly data: Buffer | string;
  /** Written as the entry's uncompressed size instead of the real one. */
  readonly declaredSize?: number;
  readonly store?: boolean;
  /** General-purpose flags as written (bit 0 marks an encrypted entry); 0x800 (UTF-8 names) by default. */
  readonly flags?: number;
  /** The method written in the headers, whatever the data is (for an unsupported method). */
  readonly method?: number;
}

/** CRC-32 (the ZIP polynomial). */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `zip64` writes every size and offset in the ZIP64 extra field and ends with a ZIP64 directory record. */
export function zipOf(entries: readonly TestEntry[], options: { zip64?: boolean } = {}): Buffer {
  const zip64 = options.zip64 === true;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const data = entry.store === true ? raw : deflateRawSync(raw);
    const method = entry.method ?? (entry.store === true ? 0 : 8);
    const flags = entry.flags ?? 0x800;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);
    const size = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    if (zip64) {
      const extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
      central.writeUInt16LE(extra.length, 30);
      centrals.push(central, name, extra);
    } else {
      centrals.push(central, name);
    }
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  if (!zip64) return Buffer.concat([...locals, directory, end]);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(BigInt(entries.length), 24);
  record.writeBigUInt64LE(BigInt(entries.length), 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...locals, directory, record, locator, end]);
}

function cellXml(value: string | number, column: number, row: number, dated: boolean): string {
  const ref = `${String.fromCharCode(65 + column)}${String(row)}`;
  if (typeof value === 'number') return `<c r="${ref}"${dated ? ' s="1"' : ''}><v>${String(value)}</v></c>`;
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<c r="${ref}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
}

/**
 * A minimal workbook: one sheet per entry of `sheets`, cells as given (numbers in `dateColumns` carry the built-in
 * date format, so they read as dates: Excel serial 45658 is 2025-01-01).
 */
export function xlsxOf(sheets: readonly { name: string; rows: (string | number)[][]; dateColumns?: number[] }[]): Buffer {
  const sheetEntries = sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${String(index + 1)}.xml`,
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
      sheet.rows.map((row, r) => `<row r="${String(r + 1)}">${row.map((value, c) => cellXml(value, c, r + 1, sheet.dateColumns?.includes(c) === true)).join('')}</row>`).join('')
    }</sheetData></worksheet>`,
  }));
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${
        sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      }<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
        sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`).join('')
      }</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        sheets.map((_, index) => `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`).join('')
      }<Relationship Id="rId${String(sheets.length + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    },
    ...sheetEntries,
  ]);
}
