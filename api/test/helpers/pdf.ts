// A minimal PDF writer for tests (no binary fixtures): pages of text drawn at known positions in Helvetica (one of the
// standard fonts, so no font file is embedded), with a correct cross-reference table. `encrypted` adds a standard
// security handler whose password the reader does not have; `drawing` puts a line on a page with no text.

export interface PdfText { readonly text: string; readonly x: number; readonly y: number }

export interface PdfPage { readonly texts?: readonly PdfText[]; readonly drawing?: boolean }

function escaped(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function pdfOf(pages: readonly PdfPage[], options: { encrypted?: boolean } = {}): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObject = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const page of pages) {
    const ops = [
      ...(page.texts ?? []).map((t) => `BT /F1 10 Tf 1 0 0 1 ${String(t.x)} ${String(t.y)} Tm (${escaped(t.text)}) Tj ET`),
      ...(page.drawing === true ? ['0 0 m 100 100 l S'] : []),
    ].join('\n');
    const content = add(`<< /Length ${String(Buffer.byteLength(ops, 'latin1'))} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${String(pagesObject)} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(content)} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pagesObject)} 0 R >>`;
  objects[pagesObject - 1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${String(kid)} 0 R`).join(' ')}] /Count ${String(kids.length)} >>`;
  const encrypt = options.encrypted === true
    ? add(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'11'.repeat(32)}> /P -4 >>`)
    : null;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const id = `<${'01'.repeat(16)}>`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R${encrypt === null ? '' : ` /Encrypt ${String(encrypt)} 0 R /ID [${id} ${id}]`} >>\n`;
  out += `startxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A row of a table: each cell at its column's x, on one baseline. */
export function row(y: number, cells: readonly (readonly [number, string])[]): PdfText[] {
  return cells.map(([x, text]) => ({ text, x, y }));
}
